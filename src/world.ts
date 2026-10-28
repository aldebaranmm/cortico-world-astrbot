/** World 实现：绑定状态机、astrbot_recall 工具、inbox 轮询转气泡、对话回传。 */
import { hostname } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { BridgeClient, normalizeBase, pairDevice, type ChatItem, type InboxMessage } from './bridge.ts';
import { collectActivity, listWindows, readFolder, suggestFolders, summarize } from './activity.ts';
import { DouyinScroller, isGameRunning, IDLE_SECONDS, SCROLL_SECONDS, type DouyinResult, type DouyinVideo, type VideoPlatform } from './douyin.ts';
import { fetchBilibiliCards } from './bili-feed.ts';
import { applyUpdate, checkUpdate, currentVersion, downloadUpdate, type UpdateStatus } from './update.ts';
import {
  ASTRBOT_ID,
  ASTRBOT_SECRETS,
  EVENT_PROACTIVE,
  astrbotConfigGroup,
  type AstrbotSection,
} from './config.ts';

/** 最短拉取间隔，防止有人填 1 秒把桥接服务打爆。 */
const POLL_MIN_MS = 10_000;

/**
 * 扩展自身的根目录（src/ 的上一级）。
 * 不能依赖 WorldContext.packageDir——它指向的是 bot 代码包目录（如 cormini），
 * 而不是本扩展的目录，用它拼 scripts/douyin-scroll.mjs 会找不到文件。
 */
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 环境提示词模板；首次挂载时落到 dataDir，之后可在控制台编辑。 */
const ENV_PROMPT_FILE = 'ENV_PROMPT.md';
const ENV_PROMPT_DEFAULT = `AstrBot 桥接

- 收到 astrbot.proactive 事件：里面的「【AstrBot 主动消息】…」是给你转达的意思，不是要你逐字念的稿子。用大肥鱼自己的口吻、自然的语气说给主人听，可以带一点你的小动作和语气，别像念稿子、别只回「好的」「收到」「酷」这种干巴巴的词。说完就结束这一轮。
- 主人问起他的喜好、习惯、以前说过什么：先用 astrbot_recall 检索 AstrBot 那边的记忆，再回答；检索不到就照实说不知道，不要编。
- AstrBot 的记忆里没有的东西，不要当成主人说过的话。
- 想知道主人在干什么、想看他某个文件夹：先说一句你想看（比如「我能看看 D://项目 里最近改了什么吗」），
  等他答应；他答应了才可以用 astrbot_files，并且 confirmed 传 true。没答应就直接被拒绝，不要硬试。
- 只读文件名、时间和大小，不要声称看过内容。
`;

export interface AstrbotWorldOptions {
  cfg: AstrbotSection;
  persist(patch: Partial<AstrbotSection>): void;
  secret(name: string): string;
  storeSecret(name: string, value: string): void;
  envPromptFile: string;
  dataDir: string;
  packageDir: string;
  log?(message: string): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 合法的事件送达方式；配置里写了别的就退回 piggyback。 */
const WAKE_MODES = ['piggyback', 'flush', 'debounce', 'preempt'] as const;
type WakeMode = (typeof WAKE_MODES)[number];

/** 对话回传：游标文件、轮询间隔、动作日志前缀、合并窗口。 */
const CHAT_CURSOR_FILE = 'chatsync.json';
const CHAT_POLL_MS = 5_000;
const ACTION_PREFIX = '做了:';
/** 间隔在这个时间内的连续对话会合成一条，避免「在吗 / 同意」刷成一堆记忆。 */
const MERGE_WINDOW_MS = 45_000;
/** 纯应答、没有信息量的对话，不值得占一条记忆。 */
const TRIVIAL_TURN =
  /^(在吗|在么|在不在|在的|在呢|你好|嗯|哦|噢|好|好的|好呀|行|可以|同意|是的|对|不对|不是|谢谢|谢了|晚安|早|嗯嗯|ok|okay|yes|哈|呵呵|知道了|再说|试试|看一下|看看|睡了吗|醒了没|醒醒|喂|hi|hello|算了|不用|别|行吧|好嘏|多谢|收到)[。，!！?？~～\s]*$/i;

/**
 * 桌宠的说话事件里混着「送达回执」，形如 `送达了 #399` 或 `送达了 #25 正文…`。
 * 它不是桌宠说的话，必须剥掉，否则会原样写进记忆。
 */
const DELIVERY_NOTICE = /^送达了\s*#?\d+\s*[，,、]?\s*/;

/** 全屏期间最多攒多少条主动消息（防内存涨；合并后差别不大）。 */
const PENDING_LIMIT = 20;

/** 同意判定的有效期与关键词。口语化的答应（行啊 / 你看呗 / 随便 / 没问题…）都算。 */
const CONSENT_WINDOW_MS = 180_000;
const CONSENT_WORDS = /(可以|好啊|好呀|好的|好嘞|行|同意|看吧|看呗|给你看|随你|随便|没问题|你定|嗯嗯|ok|okay|yes)/i;
/** 单字「好」只有整句就是它时才算同意——否则「今天好累」会被误判。 */
const CONSENT_SHORT = /^好[吧啊呀的]?[，。!！~～\s]*$/;
/**
 * 先否掉否定句：「不行」含「行」、「不要」含「要」、「不同意」含「同意」，
 * 不先拦就会被当成答应。
 */
const CONSENT_DENY = /(不同意|不行|不要|不用|不想|算了|先不|别给|别看|别动|拒绝|^\s*不)/i;

/** 主人在刷视频时说的停止话，立即停掉脚本。 */
const STOP_VIDEO_WORDS = /(别刷|不刷|不要刷|停止|停下|停|关掉|够了|别看了|别玩了|别弄了)/i;

/** 一轮待回传的对话：主人说的那句话 + 桌宠随后说的话。 */
interface PendingChat {
  user: string;
  replies: string[];
  /** 是否来自「下发的测试命令」：是则不写记忆（不传 AstrBot）。 */
  suppressed?: boolean;
}

/** 一批（可能由多轮合并而来）待回传的对话。 */
interface ChatBatch {
  user: string;
  replies: string[];
  at: number;
}

/**
 * 一条主动消息推给主会话时的正文。
 * 必须写成明确指令：只描述来源时，模型常常看完就 end_turn，气泡出不来。
 */
function eventText(body: string): string {
  return `【AstrBot 主动消息】请用 pet_say 把下面这句话原样说给主人听，不要改写、不要追加自己的话。说完就结束这一轮。\n${body}`;
}

/** M7：叫不应时的动作提示。只有「走到鼠标旁边」——不碰键鼠，纯移动自己。 */
const STUNT_HINTS: Record<string, string> = {
  go_cursor: '用 pet_move_to，to 填 "cursor"，run 填 true（走到鼠标指针那里）。',
};

/** 只走路不说话的动作名（反复催的时候用，免得每 45 秒念一句）。 */
const WALK_ONLY = 'walk_only';

/** 带动作的催人事件：先原样说话，再走到鼠标旁边。 */
function stuntText(body: string, action: string, count: number): string {
  if (action === WALK_ONLY) {
    return [
      '【AstrBot】主人还没回你。现在开始跟着他的鼠标走，直到他理你为止。',
      '连续调用 4 次 pet_move_to：每次 to 都填 "cursor"、run 填 true，走到之后再调下一次，不要停顿。',
      '这一轮不要说话，只走路。',
    ].join('\n');
  }
  const hint = STUNT_HINTS[action] ?? STUNT_HINTS.go_cursor!;
  const times = count > 0 ? `连着 ${count} 次` : '好几次';
  return [
    `【AstrBot 催你】主人已经${times}没回你了。`,
    '先用 pet_say 把下面这句话原样说给主人听，不要改写、不要追加自己的话：',
    `「${body}」`,
    `然后用工具做这个动作：${hint}`,
    '做完就结束这一轮。',
  ].join('\n');
}

export class AstrbotWorld implements World {
  readonly id = ASTRBOT_ID;

  private readonly opts: AstrbotWorldOptions;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastPollAt = 0;
  private lastError = '';
  private delivered = 0;

  // ---- 对话回传（M6）----
  private chatTimer: ReturnType<typeof setInterval> | null = null;
  private chatBusy = false;
  private chatCursor = 0;
  private chatPending: PendingChat | null = null;
  /** 攒着待发的对话批次：等对话停下来再一起回传，避免刷屏。 */
  private chatBuffer: ChatBatch[] = [];
  /** 最近一次「触发说话」的东西：只有用户打字才算对话，触摸/主动消息都不算。 */
  private chatTrigger: 'chat' | 'other' = 'other';
  private chatSent = 0;
  private chatError = '';

  // ---- 活动上报（M8）----
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private activityBusy = false;
  /** 全屏期间攒下的主动消息，退出全屏后一次推出。 */
  private pendingInbox: InboxMessage[] = [];
  private lastFullscreen = false;
  private fullscreenHeld = false;
  private lastActivityAt = 0;
  private lastActivity = '';
  private activityError = '';
  /** 最近一次主人说的话与时间：用来判断「他刚同意过」 */
  private lastUserText = '';
  private lastUserAt = 0;

  // ---- 空闲刷视频（M20/M21）----
  private readonly douyin: DouyinScroller;
  private douyinTimer: ReturnType<typeof setInterval> | null = null;
  /** 上次询问的时间；0 = 没在等回复。 */
  private douyinAskedAt = 0;
  /** 冷却到什么时候：问过（同意/拒绝/超时）后，隔一阵才再问。 */
  private douyinCooldownUntil = 0;
  /** 当前询问/要刷的是哪个平台（douyin / bilibili）。 */
  private videoPlatform: VideoPlatform | null = null;
  /** 上次刷的平台，两个都开时轮换。 */
  private lastVideoPlatform: VideoPlatform = 'douyin';
  /** 当前询问的来源：空闲触发 or 远程指令。指令触发的询问不因「主人回来」而撤回。 */
  private douyinAskSource: 'idle' | 'command' | null = null;
  /** 独立的同意检测定时器：不查空闲，只要在等回复就跑。 */
  private videoConsentTimer: ReturnType<typeof setInterval> | null = null;
  /** 刷视频时实时攒下的标题，攒够几条让桌宠说一句感想。 */
  private pendingVideoComments: string[] = [];
  /** 上次让桌宠评论的时间，防止评论太密集。 */
  private lastCommentAt = 0;
  /** 本轮刷视频前留给主人登录的秒数（0 = 不等，直接刷）。 */
  private douyinWaitSec = 0;
  /** 测试命令对话抑制：到这个时间点之前，主人回的对话都不写记忆（不传 AstrBot）。 */
  private commandChatUntil = 0;

  // ---- 自动更新（M23）----
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private updateAgreeTimer: ReturnType<typeof setInterval> | null = null;
  private updateStatus: UpdateStatus = { hasUpdate: false, current: '', latest: '', note: '' };
  private updateAskedAt = 0;

  constructor(opts: AstrbotWorldOptions) {
    this.opts = opts;
    this.douyin = new DouyinScroller(opts.packageDir, opts.log, (result) => {
      void this.reportVideoResult(result);
    }, (video) => {
      this.onVideoScrolled(video);
    }, (loggedIn) => {
      this.onLoginStatusDetected(loggedIn);
    });
  }

  // ---------- World ----------

  /** 返回空对象＝保留无变量模板全文；返回 null 会把这段环境提示整个省略。 */
  envPromptVars(): Record<string, string> | null {
    return {};
  }

  tools(): ToolDef[] {
    return [this.recallTool(), this.filesTool(), this.windowsTool(), this.favoritesTool(), this.watchVideoTool()];
  }

  /**
   * 读主人的 B 站收藏夹。收藏是刷视频时脚本顺手抓下来存盘的（favorites.json），
   * 光有文件桌宠看不到，得给它一个能读的工具，否则主人问起收藏它只能说不知道。
   */
  private favoritesTool(): ToolDef {
    return {
      name: 'astrbot_favorites',
      tags: ['read'],
      description:
        '读主人的 B 站收藏夹：他收藏过的视频标题、UP 主、放在哪个收藏夹里。' +
        '主人问「我收藏了什么」「我喜欢看什么」、或者你想照着他的口味挑视频时用它。' +
        '这是刷 B 站时自动抓下来的；还没刷过、或者当时没登录，就是空的。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条，默认 30。' },
          keyword: { type: 'string', description: '只留标题或 UP 主里含这个词的，比如「钢四」「美食」。' },
        },
        required: [],
      },
      summary: {
        zh: '读主人的 B 站收藏，知道他喜欢看什么。',
        en: "Reads the person's Bilibili favorites.",
      },
      handler: (args) => {
        const file = join(this.opts.packageDir, 'favorites.json');
        if (!existsSync(file)) {
          return '还没抓过主人的收藏。刷一次 B 站（并且是登录状态）就会自动存下来，之后我就能读了。';
        }
        try {
          const j = JSON.parse(readFileSync(file, 'utf8')) as { at?: number; items?: unknown[] };
          const items = (Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>;
          if (items.length === 0) return '收藏夹是空的。';
          const kw = String(args.keyword ?? '').trim();
          const hit = kw
            ? items.filter(
                (x) => String(x.title ?? '').includes(kw) || String(x.owner ?? '').includes(kw),
              )
            : items;
          const limit = Number(args.limit) || 30;
          const at = j?.at ? new Date(j.at).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
          const head = kw
            ? `主人的 B 站收藏共 ${items.length} 条，含「${kw}」的 ${hit.length} 条（抓于 ${at}）：\n`
            : `主人的 B 站收藏共 ${items.length} 条（抓于 ${at}）：\n`;
          if (hit.length === 0) return `收藏里没有和「${kw}」相关的。`;
          return (
            head +
            hit
              .slice(0, limit)
              .map((x, i) => `${i + 1}. ${String(x.title ?? '（无标题）')}｜UP ${String(x.owner ?? '?')}｜夹「${String(x.folder ?? '?')}」`)
              .join('\n')
          );
        } catch (err) {
          return `读收藏失败：${errText(err)}`;
        }
      },
    };
  }

  /**
   * 真的打开浏览器去刷视频：窗口前置、像真人那样一条条往下滚、中间自然停顿，
   * 主人能亲眼看见。同时把刷到的视频抓下来交给 AstrBot 分析写记忆。
   * 调用后立刻返回，视频在后台继续刷，桌宠边刷边说话。
   */
  private watchVideoTool(): ToolDef {
    return {
      name: 'astrbot_watch_video',
      tags: ['act'],
      description:
        '打开浏览器真的去刷视频：把窗口挪到最前面，像真人一样一条条往下滚、中间有长有短地停一停，' +
        '还会点开一条看一会儿，主人能亲眼看见我在刷。刷到的内容会交给 AstrBot 分析后写进记忆。' +
        '主人说「刷会儿 B 站」「陪我看会儿视频」时用这个。' +
        '想按自己的口味挑：先用 web_bilibili 取一批（一秒就回来），按你自己的性子挑一条，' +
        '把它的 BV 号传给 bvid，我会先点开那条真的看，再接着刷 feed。' +
        '不传 bvid 我就自己翻，并照着主人的收藏挑。' +
        '不要自己用 pet_cua_key／pet_cua_type／pet_cua_click 去开客户端手搓：' +
        '那要等应用启动、等首页加载，又慢又不像在看视频。' +
        '调用后立刻返回，视频会在后台继续刷一段时间。',
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['bilibili', 'douyin'],
            description: '刷哪个平台；主人没说就 bilibili。',
          },
          seconds: {
            type: 'integer',
            minimum: 5,
            maximum: 3600,
            description: '刷多少秒。**不传就是一直看**——主人没叫停就不要停。只有主人明说了「看 X 分钟」才传。',
          },
          stop: {
            type: 'boolean',
            description: '主人说「别看了」「停」「够了」「别刷了」时传 true，立刻停下来。',
          },
          bvid: {
            type: 'string',
            description:
              '你按自己的口味挑的那一条的 BV 号（形如 BV1xx411c7mD）。' +
              '先用 web_bilibili 取一批，挑一条你真想看的再传给我；不传我就自己翻。',
          },
        },
        required: [],
      },
      summary: {
        zh: '打开浏览器真的刷视频，主人能看见，边刷边记。',
        en: 'Opens the browser and actually scrolls videos, visible to the person.',
      },
      handler: (args) => {
        // 主人叫停
        if (args.stop === true) {
          if (!this.douyin.running) return '本来就没在刷。';
          this.douyin.stop();
          this.opts.log?.('主人叫停，刷视频已停止');
          return '好，不看了，手停下。';
        }
        const platform = (args.platform === 'douyin' ? 'douyin' : 'bilibili') as VideoPlatform;
        const name = platform === 'bilibili' ? 'B站' : '抖音';
        // 不传秒数 = 一直看，直到主人叫停或自己关掉浏览器
        const seconds = Number(args.seconds) || 0;
        const bvid = String(args.bvid ?? '').trim();
        if (this.douyin.running) return '已经在刷着呢，等主人叫停我再停。';
        this.videoPlatform = platform;
        this.lastVideoPlatform = platform;
        // 90 秒等主人扫码登录（不计入滚动时长）；只有限时模式才需要「刷完留窗」，不限时的一直在眼前
        this.douyin.launch(platform, seconds, 90, seconds > 0 ? 120 : 0, bvid);
        this.opts.log?.(
          `桌宠主动刷${name}（${seconds > 0 ? `${seconds}s` : '不限时，直到主人叫停'}，浏览器可見${bvid ? `，先点开挑的 ${bvid}` : ''}）`,
        );
        return bvid
          ? `我把${name}打开了，先点开我自己挑的那条看看——你也能看见。你没说停我就一直看下去。`
          : `好嘞，我把${name}打开了，慢慢往下翻——你也能看见。你没说停我就一直看，我边看边跟你说。`;
      },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.startPolling();
    this.startChatSync();
    this.startActivity();
    this.startVideoConsent(); // 同意检测无条件启动，远程指令的询问也要能等到答复
    if (this.cfg.douyinEnabled || this.cfg.bilibiliEnabled) this.startDouyin();
    this.startUpdateCheck();
    const token = (this.opts.secret(ASTRBOT_SECRETS.token) ?? '').trim();
    this.opts.log?.(
      `已启动（${this.cfg.baseUrl}，间隔 ${this.cfg.pollSeconds}s，气泡${this.cfg.bubble ? '开' : '关'}，对话回传${this.chatSyncOn ? '开' : '关'}，活动上报${this.cfg.activityEnabled === false ? '关' : `开/${Math.max(15, Number(this.cfg.activitySeconds) || 60)}s`}，令牌${token ? `已就绪(${token.length}位)` : '缺失'}）`,
    );
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.stopChatSync();
    this.stopActivity();
    this.stopDouyin();
    this.stopVideoConsent();
    this.stopUpdateCheck();
    this.host = null;
  }

  webUi() {
    return {
      label: 'AstrBot',
      panels: [{ id: 'bind', title: '绑定', description: '用 QQ 里拿到的配对码把这台机器接到 AstrBot。' }],
      config: [astrbotConfigGroup()],
      promptDocs: [
        {
          key: 'worlds.astrbot.envPrompt',
          title: 'AstrBot 桥接规则',
          description: '桌宠怎么处理 AstrBot 来的主动消息、什么时候去检索记忆。可直接在控制台编辑。',
          path: this.opts.envPromptFile,
          role: 'envPrompt',
        },
      ],
      badges: [
        { label: '身份', value: this.cfg.identityLabel || '未绑定', tone: (this.cfg.identityLabel ? 'on' : 'off') as 'on' | 'off' },
        ...(this.updateStatus.hasUpdate
          ? [{ label: '更新', value: `${this.updateStatus.latest} 可用`, tone: 'on' as const }]
          : this.updateStatus.current
            ? [{ label: '版本', value: this.updateStatus.current, tone: 'plain' as const }]
            : []),
      ],
      invoke: (panel: string, method: string, args: unknown[]) => this.invoke(method, args),
    };
  }

  // ---------- 工具 ----------

  private get cfg(): AstrbotSection {
    return this.opts.cfg;
  }

  private client(): BridgeClient {
    return new BridgeClient(this.cfg.baseUrl, this.opts.secret(ASTRBOT_SECRETS.token) ?? '');
  }

  /** 配置的送达方式，写错了退回 flush（立刻冒泡）。 */
  private wakeMode(): WakeMode {
    const raw = String(this.cfg.wakeMode ?? '').trim();
    return (WAKE_MODES as readonly string[]).includes(raw) ? (raw as WakeMode) : 'flush';
  }

  private recallTool(): ToolDef {
    return {
      name: 'astrbot_recall',
      tags: ['read'],
      description:
        'Search what AstrBot remembers about the person: preferences, habits, things they said they like or dislike, and past context. Use it before answering a question about their tastes, routines or history. Returns ranked snippets with their source; an empty result means nothing was remembered yet.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for, in the person\'s own words. A few keywords work better than a full sentence.',
          },
          limit: { type: 'integer', description: 'How many snippets at most; defaults to the configured number.', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return '（要给检索词才会去查）';
        const client = this.client();
        if (!client.ready) return '这台机器还没绑定 AstrBot：请主人在控制台的 AstrBot 页用配对码绑定，绑定后我就能查到他之前说过什么。';
        const limit = Number(args.limit) || this.cfg.recallLimit || 8;
        try {
          const data = await client.recall(query, limit);
          const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
          if (items.length === 0) return `AstrBot 那边没有和「${query}」相关的记忆。`;
          const lines = items.slice(0, limit).map((item, i) => {
            const source = String(item.source ?? '?');
            const kind = String(item.kind ?? '');
            const text = String(item.text ?? '').replace(/\s+/g, ' ').trim();
            return `${i + 1}. [${source}${kind ? `/${kind}` : ''}] ${text}`;
          });
          return lines.join('\n');
        } catch (error) {
          return `检索失败：${errText(error)}`;
        }
      },
    };
  }

  /** 主人是否在最近几分钟内明确答应过。 */
  private consented(): boolean {
    const text = this.lastUserText.trim();
    if (!text) return false;
    if (CONSENT_DENY.test(text)) return false;
    if (Date.now() - this.lastUserAt > CONSENT_WINDOW_MS) return false;
    return CONSENT_WORDS.test(text) || CONSENT_SHORT.test(text);
  }

  /**
   * 工具调用前实时确认「主人最后说了什么」。
   *
   * 对话事件是 5 秒轮询消费的，而模型往往一两秒内就调工具——
   * 只靠轮询更新的话，这里读到的还是上一句，于是「同意」永远不生效。
   */
  private async refreshLastUser(): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      const cursor = host.store.latestCursor();
      const events = host.store.range({ fromCursor: Math.max(0, cursor - 60), limit: 60 });
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'desktop-pet.message') continue;
        const fromMeta =
          typeof event.meta?.text === 'string' ? String(event.meta.text).trim() : '';
        const text = fromMeta || this.stripSpeaker(String(event.text ?? ''));
        if (!text) continue;
        this.lastUserText = text;
        // 用事件自己的时间戳，别用「现在」：否则询问之前说的旧话会被误判成「刚回复」，
        // 导致 consented() 把「肥鱼在吗」这类历史消息当成「主人没同意」。
        const ts = Date.parse(String(event.ts ?? ''));
        this.lastUserAt = Number.isFinite(ts) ? ts : Date.now();
        return;
      }
    } catch {
      /* 读不到就沿用现有的判断，不因为刷新失败而放行 */
    }
  }

  /**
   * 按需读文件夹：**必须先问主人**，他没答应就直接拒绝。
   * 只给文件名/时间/大小，永远不读内容。
   */
  private filesTool(): ToolDef {
    return {
      name: 'astrbot_files',
      tags: ['read'],
      description:
        'List what is inside a folder on this computer: file names, last-modified time and size — never the contents. You must first ask the person in a bubble whether you may look, and only call this after they clearly agreed; then pass confirmed: true. A call without a recent yes from the person is refused.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute folder path on this computer, e.g. D:////project' },
          confirmed: {
            type: 'boolean',
            description: 'Set true only after the person agreed in the last couple of minutes.',
          },
          max_files: { type: 'integer', minimum: 1, maximum: 20, description: 'How many files at most; defaults to 12.' },
        },
        required: ['path', 'confirmed'],
      },
      handler: async (args) => {
        const path = String(args.path ?? '').trim();
        if (!path) return '（要先给一个文件夹路径）';
        if (args.confirmed !== true) {
          return '还没得到主人同意。先用气泡问他「我能不能看看这个文件夹」，等他答应后再带上 confirmed: true 调用。';
        }
        await this.refreshLastUser();
        if (!this.consented()) {
          const last = this.lastUserText || '（他还没说话）';
          return `主人刚才没有明确答应（最近一句是「${last}」）。请直接问他，等他回复同意再来。`;
        }
        const summary = readFolder(path, Number(args.max_files) || 12);
        if (!summary) {
          const hint = suggestFolders(path);
          return `读不了这个文件夹：${path}（路径不存在或没有权限）${hint}`;
        }
        if (summary.files.length === 0) return `${path} 里没有文件。`;
        const lines = summary.files.map((file) => {
          const when = new Date(file.mtime * 1000).toLocaleString();
          return `· ${file.name}（${when}，${Math.max(1, Math.round(file.size / 1024))} KB）`;
        });
        this.opts.log?.(`读取文件夹（主人已同意）：${path}（${summary.files.length} 个文件）`);
        return `${path} 里最近改动的文件：\n${lines.join('\n')}`;
      },
    };
  }

  /**
   * 当前开着哪些程序。只读进程名与窗口标题——
   * 不给命令行参数（可能带密钥），也不读任何文件。
   */
  private windowsTool(): ToolDef {
    return {
      name: 'astrbot_windows',
      tags: ['read'],
      description:
        'List the programs that currently have a visible window on this computer (process name + window title). Read-only: no file contents, no command lines, no history.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many to list; defaults to 20.' },
        },
      },
      handler: async (args) => {
        const list = await listWindows(Number(args.limit) || 20);
        if (list.length === 0) {
          return '现在读不到窗口列表（可能没有可见窗口，或系统拒绝了这次查询）。';
        }
        this.opts.log?.(`列出打开的窗口：${list.length} 个`);
        const lines = list.map((item) => `· ${item.process} — ${item.title || '(无标题)'}`);
        return `当前打开的窗口程序（${list.length} 个）：\n${lines.join('\n')}`;
      },
    };
  }

  // ---------- 活动上报 ----------

  private startActivity(): void {
    this.stopActivity();
    if (this.cfg.activityEnabled === false) return;
    if (!this.host) return;
    const seconds = Math.max(15, Number(this.cfg.activitySeconds) || 60);
    this.activityTimer = setInterval(() => {
      void this.pollActivity();
    }, seconds * 1000);
    this.activityTimer.unref?.();
    void this.pollActivity();
  }

  private stopActivity(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
  }

  // ---------- 空闲刷抖音（M20）----------

  /** 检查间隔。 */
  private static readonly DOUYIN_TICK_MS = 30_000;
  /** 询问后等回复多久。 */
  private static readonly DOUYIN_ASK_TIMEOUT_MS = 3 * 60_000;
  /** 问过（同意/拒绝/超时）后的冷却，避免反复问。 */
  private static readonly DOUYIN_COOLDOWN_MS = 30 * 60_000;

  private startDouyin(): void {
    this.stopDouyin();
    this.douyinTimer = setInterval(() => {
      void this.tickDouyin();
    }, AstrbotWorld.DOUYIN_TICK_MS);
    this.douyinTimer.unref?.();
  }

  private stopDouyin(): void {
    if (this.douyinTimer) clearInterval(this.douyinTimer);
    this.douyinTimer = null;
    this.douyinAskedAt = 0;
    this.douyinAskSource = null;
    this.douyin.stop();
  }

  /** 同意检测独立启动：不依赖 douyin/bilibili 开关，远程指令的询问也要能等到答复。 */
  private startVideoConsent(): void {
    this.stopVideoConsent();
    this.videoConsentTimer = setInterval(() => {
      void this.tickVideoConsent();
    }, AstrbotWorld.DOUYIN_TICK_MS);
    this.videoConsentTimer.unref?.();
  }

  private stopVideoConsent(): void {
    if (this.videoConsentTimer) clearInterval(this.videoConsentTimer);
    this.videoConsentTimer = null;
  }

  /** 状态机（空闲触发）：空闲→询问→等同意；主人回来只撤回空闲来源的询问。 */
  private async tickDouyin(): Promise<void> {
    const now = Date.now();
    const idle = await this.shouldScrollDouyin();
    if (!idle) {
      // 主人回来了 / 不再满足条件：只撤回「空闲触发」的询问；指令触发的询问继续等答复
      if (this.douyinAskedAt && this.douyinAskSource === 'idle') {
        this.opts.log?.('主人回来了，撤回刷视频的询问');
        this.douyinAskedAt = 0;
        this.douyinAskSource = null;
        this.douyin.stop();
      }
      return;
    }
    if (this.douyin.running) return;           // 正在刷，不重复
    if (now < this.douyinCooldownUntil) return; // 冷却中，不打扰

    if (this.douyinAskedAt === 0) {
      // 空闲且还没问 → 选平台，先问一声
      this.videoPlatform = this.nextVideoPlatform();
      if (!this.videoPlatform) return;         // 没平台可刷（理论上到不了这里）
      await this.askDouyin('idle');
      this.douyinAskedAt = now;
      this.douyinAskSource = 'idle';
      return;
    }
    // 同意检测交给 tickVideoConsent（它在不空闲时也跑，指令询问才等得到答复）
  }

  /** 同意检测：不查空闲，只要在等回复就跑。空闲/指令两种来源共用。 */
  private async tickVideoConsent(): Promise<void> {
    if (this.douyinAskedAt === 0) return;
    if (this.douyin.running) return;
    const now = Date.now();

    if (now - this.douyinAskedAt > AstrbotWorld.DOUYIN_ASK_TIMEOUT_MS) {
      this.opts.log?.('刷视频的询问超时未回复，放弃');
      this.douyinAskedAt = 0;
      this.douyinAskSource = null;
      this.douyinCooldownUntil = now + AstrbotWorld.DOUYIN_COOLDOWN_MS;
      return;
    }

    // 实时刷新主人最后说的话（不依赖 5 秒轮询，主人刚同意就能读到）
    await this.refreshLastUser();
    // 已问过，等主人在询问之后说话
    if (this.lastUserAt > this.douyinAskedAt) {
      if (this.consented()) {
        const platform = this.videoPlatform ?? 'douyin';
        const name = platform === 'bilibili' ? 'B站' : '抖音';
        void this.celebrateConsent(name);
        // B 站走接口直取：不开浏览器、不滚动、不看封面图，秒级拿一批，
        // 比 playwright 拉起 Edge 再抓 DOM 快一个数量级。
        if (platform === 'bilibili') {
          void this.scrollBilibiliByApi();
        } else {
          this.douyin.launch(platform, SCROLL_SECONDS, this.douyinWaitSec);
        }
        this.lastVideoPlatform = platform;
        this.douyinWaitSec = 0;
      } else {
        this.opts.log?.('主人没同意刷视频');
      }
      this.douyinAskedAt = 0;
      this.douyinAskSource = null;
      this.douyinCooldownUntil = now + AstrbotWorld.DOUYIN_COOLDOWN_MS;
    }
  }

  /** 空闲 + 非全屏 + 没在玩游戏。任何异常都当「不空闲」。 */
  private async shouldScrollDouyin(): Promise<boolean> {
    if (this.cfg.douyinEnabled !== true && this.cfg.bilibiliEnabled !== true) return false;
    try {
      const payload = await collectActivity();
      if (payload.window?.fullscreen) return false;
      if (Number(payload.idle_seconds || 0) < IDLE_SECONDS) return false;
      if (await isGameRunning()) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** 当前开启的平台列表。 */
  private enabledPlatforms(): VideoPlatform[] {
    const list: VideoPlatform[] = [];
    if (this.cfg.douyinEnabled) list.push('douyin');
    if (this.cfg.bilibiliEnabled) list.push('bilibili');
    return list;
  }

  /** 两个都开时轮换：上次刷抖音，这次 B站；反之。 */
  private nextVideoPlatform(): VideoPlatform | null {
    const list = this.enabledPlatforms();
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    return this.lastVideoPlatform === 'douyin' ? 'bilibili' : 'douyin';
  }

  /** 桌宠想刷视频玩，先征得主人同意，别自己动手。source 区分空闲触发 / 远程指令。 */
  private async askDouyin(source: 'idle' | 'command'): Promise<void> {
    const host = this.host;
    if (!host) return;
    const name = this.videoPlatform === 'bilibili' ? 'B站' : '抖音';
    const lead = source === 'idle'
      ? `主人～我看你离开好一会儿了，我好无聊，能不能让我自己刷会儿${name}玩？`
      : `主人，我想刷会儿${name}玩，可以吗？`;
    try {
      await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot',
          tags: ['speak'],
          text: `【AstrBot 主动消息】请用 pet_say 问主人一句：${lead} 你说「好」「可以」我就去刷，不想就回「不用」。问完就结束这一轮，先不要自己打开。`,
        },
        // 主动消息用 preempt 打断主循环(和用户打字 desktop-pet.message 一样):
        // flush 不打断,主循环若卡在别处就收不到,桌宠不冒泡。
        { trigger: 'preempt' },
      );
      this.opts.log?.(`桌宠想刷${name}（${source === 'idle' ? '空闲触发' : '远程指令'}），已问主人同不同意`);
    } catch {
      /* 问不出去就算了，下次再问 */
    }
  }

  /** 把刷到的一批卡片上报给 AstrBot（后续分析 + 写记忆）。 */
  private async reportVideoResult(result: DouyinResult): Promise<void> {
    if (result.cards.length === 0) return;
    const platform = this.videoPlatform;
    if (!platform) return;
    const name = platform === 'bilibili' ? 'B站' : '抖音';
    const client = this.client();
    if (!client.ready) return;
    try {
      await client.videoPost(platform, { loggedIn: result.loggedIn, cards: result.cards });
      this.opts.log?.(
        `刷${name}结果已上报：${result.cards.length} 条（${result.loggedIn ? '已登录' : '未登录'}）`,
      );
    } catch (err) {
      this.opts.log?.(`刷${name}结果上报失败：${errText(err)}`);
    }
  }

  /**
   * B 站接口直取：一次拿一批，边"刷"边让桌宠说两句，整批交给 AstrBot 分析写记忆。
   * 不拉起浏览器，省掉等加载/滚动/关弹窗的时间，通常几秒内完成。
   */
  private async scrollBilibiliByApi(): Promise<void> {
    this.opts.log?.('开始刷B站（接口直取，不开浏览器）');
    try {
      const result = await fetchBilibiliCards(30);
      if (result.cards.length === 0) {
        this.opts.log?.('接口这次没取到B站内容，跳过分析');
        return;
      }
      this.opts.log?.(`接口取到 ${result.cards.length} 条B站视频`);
      // 喂几条给"边刷边说"，让桌宠像真在刷一样冒两句（每 3 条一句）
      for (const card of result.cards.slice(0, 6)) {
        this.onVideoScrolled({ text: String(card.text ?? ''), author: '' });
      }
      await this.reportVideoResult(result);
    } catch (error) {
      this.opts.log?.(`接口刷B站失败：${errText(error)}`);
    }
  }

  /** 刷视频时实时收到一条视频：攒起来，攒够几条让桌宠说一句感想。 */
  private onVideoScrolled(video: DouyinVideo): void {
    const text = video.text;
    if (!text) return;
    // 「正在看：」是刚点开、正摆在屏幕上的那条：立刻就它说一句。
    // 要是混在 feed 卡片里攒够 3 条再说，嘴里说的和屏幕上放的就不是同一个东西了。
    if (text.startsWith('正在看：')) {
      this.pendingVideoComments = [text];
      void this.flushVideoComment();
      return;
    }
    this.pendingVideoComments.push(text);
    if (this.pendingVideoComments.length >= 3) {
      void this.flushVideoComment();
    }
  }

  /** 把攒下的视频标题交给桌宠，让它用大肥鱼口吻说句感想。 */
  private async flushVideoComment(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCommentAt < 15_000) return; // 至少隔 15 秒评一次
    const titles = this.pendingVideoComments.splice(0, this.pendingVideoComments.length);
    if (titles.length === 0) return;
    const host = this.host;
    if (!host) return;
    const list = titles.map((t) => `「${t}」`).join('、');
    try {
      await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot',
          tags: ['speak'],
          text: `【AstrBot 主动消息】我刚刷到这几个视频：${list}。请用大肥鱼的口吻说一句感想，比如觉得没意思就说「这个没意思，换一个」。不要复述标题、不要逐条点评，就用一两句自然的话带过，说完就结束这一轮。`,
        },
        { trigger: this.wakeMode() },
      );
      this.lastCommentAt = now;
    } catch {
      /* 说不了就算了，别影响刷视频 */
    }
  }

  /** 主人同意刷视频后，让桌宠开心地回应一句，别平淡地说「好的」。 */
  private async celebrateConsent(name: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot',
          tags: ['speak'],
          text: `【AstrBot 主动消息】主人答应让我刷${name}啦！请用大肥鱼开心兴奋的口吻回应一句（比如「太好啦！那我开刷啦～」），要表现出雀跃的心情，不要平淡地说「好的」。说完就结束这一轮。`,
        },
        { trigger: 'flush' },
      );
    } catch {
      /* 说不了就算了，不耽误开始刷 */
    }
  }

  /** 脚本上报登录态：未登录就问主人要不要登录。 */
  private onLoginStatusDetected(loggedIn: boolean): void {
    if (loggedIn) return; // 已登录，直接刷，不用问
    void this.askLogin();
  }

  /** 未登录时问主人一句：要不要登录。 */
  private async askLogin(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const name = this.videoPlatform === 'bilibili' ? 'B站' : '抖音';
    try {
      await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot',
          tags: ['speak'],
          text: `【AstrBot 主动消息】主人，${name}还没登录你的账号。你想现在登录吗？想登录就去那个浏览器窗口登录，不想登录我就直接刷（会按学习记忆存，不按你的喜好）。问完就结束这一轮。`,
        },
        { trigger: 'flush' },
      );
    } catch {
      /* 问不了就算了 */
    }
  }

  // ---------- 自动更新（M23）----------

  /** 版本检查间隔。 */
  private static readonly UPDATE_CHECK_MS = 30 * 60_000;
  /** 询问后每隔多久探测一次主人的答复。 */
  private static readonly UPDATE_AGREE_TICK_MS = 30_000;
  /** 询问后等多久没回就作罢。 */
  private static readonly UPDATE_ASK_TIMEOUT_MS = 10 * 60_000;
  /** 上次提示后多久内不再重复问。 */
  private static readonly UPDATE_REPROMPT_MS = 6 * 60 * 60_000;

  private startUpdateCheck(): void {
    // 先同步填上当前版本，让控制台徽章立刻能显示
    this.updateStatus = { hasUpdate: false, current: currentVersion(this.opts.packageDir), latest: '', note: '', zip: '' };
    void this.tickUpdateCheck();
    this.updateTimer = setInterval(() => void this.tickUpdateCheck(), AstrbotWorld.UPDATE_CHECK_MS);
    this.updateTimer.unref?.();
    this.updateAgreeTimer = setInterval(() => void this.tickUpdateAgree(), AstrbotWorld.UPDATE_AGREE_TICK_MS);
    this.updateAgreeTimer.unref?.();
  }

  private stopUpdateCheck(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.updateTimer = null;
    if (this.updateAgreeTimer) clearInterval(this.updateAgreeTimer);
    this.updateAgreeTimer = null;
  }

  /** 检查版本；有新版本且离上次提示够久，就气泡问主人。 */
  private async tickUpdateCheck(): Promise<void> {
    const status = await checkUpdate(this.opts.packageDir, this.cfg.updateUrl);
    this.updateStatus = status;
    if (!status.hasUpdate) return;
    this.opts.log?.(`发现新版本 ${status.latest}（当前 ${status.current}）`);
    if (Date.now() - this.updateAskedAt > AstrbotWorld.UPDATE_REPROMPT_MS) {
      await this.askUpdate(status);
    }
  }

  /** 询问后探测主人是否同意；同意就下载 + 触发覆盖重启。 */
  private async tickUpdateAgree(): Promise<void> {
    if (this.updateAskedAt === 0) return;
    if (Date.now() - this.updateAskedAt > AstrbotWorld.UPDATE_ASK_TIMEOUT_MS) {
      this.updateAskedAt = 0;
      return;
    }
    if (this.lastUserAt > this.updateAskedAt) {
      if (this.consented()) {
        await this.performUpdate();
      } else {
        this.opts.log?.('主人没同意更新');
      }
      this.updateAskedAt = 0;
    }
  }

  /** 桌宠主动告诉主人有新版本，问要不要更新。 */
  private async askUpdate(status: UpdateStatus): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.updateAskedAt = Date.now();
    try {
      await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot',
          tags: ['speak'],
          text: `【AstrBot 主动消息】请用 pet_say 告诉主人：主人～我的扩展有新版 ${status.latest}（现在是 ${status.current}），要不要我更新一下？你说「好」或「可以」我就自动更新并重启。问完就结束这一轮，先不要自己动手。`,
        },
        { trigger: this.wakeMode() },
      );
      this.opts.log?.(`已询问主人是否更新到 ${status.latest}`);
    } catch {
      this.updateAskedAt = 0;
    }
  }

  /** 下载 zip 并触发独立的覆盖重启脚本。 */
  private async performUpdate(): Promise<void> {
    this.opts.log?.('主人同意更新，开始下载');
    const zip = await downloadUpdate(this.cfg.updateUrl, this.updateStatus?.zip ?? '');
    if (!zip) {
      this.opts.log?.('更新下载失败');
      return;
    }
    applyUpdate(zip, this.opts.packageDir, this.opts.log);
  }

  private async pollActivity(): Promise<void> {
    if (this.activityBusy) return;
    const client = this.client();
    if (!client.ready) return;
    this.activityBusy = true;
    try {
      const payload = await collectActivity();
      // 桌宠自己在刷视频时，前台是它开的浏览器——改成明确标注，别让活动汇总误当成「主人在刷」
      if (this.douyin.running) {
        const name = this.videoPlatform === 'bilibili' ? 'B站' : '抖音';
        payload.window = {
          title: `桌宠在自动刷${name}（不是主人操作）`,
          process: 'cortico-auto-scroll',
          fullscreen: false,
        };
        payload.idle_seconds = 0;
      }
      await client.activityPost(payload);
      this.lastActivityAt = Date.now();
      this.lastActivity = summarize(payload);
      if (this.activityError) this.opts.log?.('活动上报恢复正常');
      this.activityError = '';
    } catch (error) {
      const detail = errText(error);
      if (this.activityError !== detail) {
        this.activityError = detail;
        this.opts.log?.(`活动上报失败：${detail}`);
      }
    } finally {
      this.activityBusy = false;
    }
  }

  // ---------- 轮询 ----------

  private startPolling(): void {
    this.stopPolling();
    if (!this.cfg.bubble) return;
    const ms = Math.max(POLL_MIN_MS, Number(this.cfg.pollSeconds || 0) * 1000);
    this.timer = setInterval(() => {
      void this.poll();
    }, ms);
    this.timer.unref?.();
    void this.poll();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- 全屏保护 ----------

  /** 收下一批待推消息，超出上限就丢最早的（合并后基本没差别）。 */
  /** 处理 inbox 里带 command 的指令消息：先问主人同意，同意了才执行。 */
  private handleCommands(messages: InboxMessage[]): void {
    for (const message of messages) {
      const command = String(message.meta?.command ?? '').trim();
      if (!command) continue;
      if (command === 'scroll_video') {
        const platform: VideoPlatform = message.meta?.platform === 'bilibili' ? 'bilibili' : 'douyin';
        const wait = Number(message.meta?.wait) || 0;
        this.startVideoByCommand(platform, wait);
      }
      // 未来可在这里加更多指令（比如 stop_video、recall_memory…）
    }
  }

  /** 远程指令：不直接刷，先气泡问主人，同意后再由 tickVideoConsent 拉起。 */
  private startVideoByCommand(platform: VideoPlatform, waitSec = 0): void {
    const name = platform === 'bilibili' ? 'B站' : '抖音';
    if (this.douyin.running) {
      this.opts.log?.(`收到刷${name}指令，但已在刷，忽略`);
      return;
    }
    if (this.douyinAskedAt !== 0) {
      this.opts.log?.(`收到刷${name}指令，但已有询问在等主人回复，忽略`);
      return;
    }
    this.videoPlatform = platform;
    this.lastVideoPlatform = platform;
    this.douyinWaitSec = waitSec;
    this.douyinAskSource = 'command';
    this.douyinAskedAt = Date.now();
    // 测试命令触发的整段对话（问→答→回应）都不写记忆：覆盖到超时 + 一轮缓冲
    this.commandChatUntil = Date.now() + AstrbotWorld.DOUYIN_ASK_TIMEOUT_MS + 60_000;
    void this.askDouyin('command');
    this.opts.log?.(`收到远程指令刷${name}，已先问主人同不同意`);
  }

  private enqueueInbox(messages: InboxMessage[]): void {
    if (!messages.length) return;
    this.pendingInbox.push(...messages);
    if (this.pendingInbox.length > PENDING_LIMIT) {
      this.pendingInbox.splice(0, this.pendingInbox.length - PENDING_LIMIT);
    }
  }

  /**
   * 取出这一拍要推的正文；全屏时返回 null 表示继续攒着。
   * 一次只推一条合并事件：多条小事件堆在一起，模型一次要消化的东西太多。
   */
  private takePending(fullscreen: boolean): { body: string; stunt: InboxMessage | null; count: number } | null {
    if (this.pendingInbox.length === 0) return null;
    if (fullscreen && this.cfg.skipFullscreen !== false) return null;
    const batch = this.pendingInbox.splice(0);
    const body = batch
      .map((message) => message.text.trim())
      .filter((text) => text !== '')
      .join('\n');
    if (body === '') return null;
    // M7：服务端判定「连着没回」时会带 stunt 动作，这一轮要边说边做
    const stunt = batch.find((message) => typeof message.meta?.stunt === 'string') ?? null;
    return { body, stunt, count: batch.length };
  }

  /**
   * 现在是不是全屏（含游戏的无边框全屏）。
   * 只读窗口矩形，不碰任何输入；检测失败一律当作「不是全屏」，绝不把消息卡死。
   */
  private async isFullscreen(): Promise<boolean> {
    if (this.cfg.skipFullscreen === false) return false;
    try {
      const payload = await collectActivity();
      return payload.window.fullscreen === true;
    } catch (error) {
      this.opts.log?.(`全屏检测失败（按不是全屏处理）：${errText(error)}`);
      return false;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    const host = this.host;
    if (!host || !this.cfg.bubble) return;
    const client = this.client();
    if (!client.ready) {
      // 只在状态变化时记一次，避免每 20 秒刷屏
      if (this.lastError !== 'no-token') {
        this.lastError = 'no-token';
        this.opts.log?.('轮询跳过：没有机器令牌（这台机器还没绑定，或 .env 里 ASTRBOT_BRIDGE_TOKEN 为空）');
      }
      return;
    }
    this.polling = true;
    try {
      const incoming = await client.inbox();
      // 带 command 的消息是指令（直接执行，不气泡），其余才进气泡队列
      this.handleCommands(incoming);
      this.enqueueInbox(incoming.filter((message) => !message.meta?.command));
      // 全屏（含游戏的无边框全屏）时先攒着：正在看片/打游戏/演示，不应该弹气泡
      const fullscreen = this.pendingInbox.length > 0 ? await this.isFullscreen() : false;
      this.lastFullscreen = fullscreen;
      const batch = this.takePending(fullscreen);
      if (fullscreen && this.pendingInbox.length > 0) {
        if (!this.fullscreenHeld) {
          this.fullscreenHeld = true;
          this.opts.log?.(`检测到全屏，暂存 ${this.pendingInbox.length} 条主动消息，退出后再出`);
        }
      } else if (this.fullscreenHeld) {
        this.fullscreenHeld = false;
        this.opts.log?.('已退出全屏');
      }
      if (batch) {
        // M7：服务端判定「连着没回」时会带 stunt 动作，这一轮要边说边做
        const text = batch.stunt
          ? stuntText(batch.body, String(batch.stunt.meta?.stunt), Number(batch.stunt.meta?.unanswered ?? 0))
          : eventText(batch.body);
        await host.pushEvent(
          {
            type: EVENT_PROACTIVE,
            ts: new Date().toISOString(),
            source: ASTRBOT_ID,
            senderKey: 'astrbot',
            tags: ['speak'],
            text,
          },
          { trigger: this.wakeMode() },
        );
        this.delivered += batch.count;
        this.opts.log?.(
          `收到 ${batch.count} 条主动消息，已按 ${this.wakeMode()} 推给主会话${batch.stunt ? `（含搞事动作 ${batch.stunt.meta?.stunt}）` : ''}`,
        );
      }
      this.lastPollAt = Date.now();
      if (this.lastError) this.opts.log?.('轮询恢复正常');
      this.lastError = '';
    } catch (error) {
      const detail = errText(error);
      // 同一条错误只在首次出现时记，恢复后重置
      if (this.lastError !== detail) {
        this.lastError = detail;
        this.opts.log?.(`轮询失败（${client.base}）：${detail}`);
      }
    } finally {
      this.polling = false;
    }
  }

  // ---------- 对话回传（M6）----------

  private get chatCursorFile(): string {
    return join(this.opts.dataDir, CHAT_CURSOR_FILE);
  }

  private readChatCursor(): number {
    try {
      const raw = JSON.parse(readFileSync(this.chatCursorFile, 'utf8')) as { cursor?: unknown };
      const value = Number(raw?.cursor);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private writeChatCursor(cursor: number): void {
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeFileSync(this.chatCursorFile, JSON.stringify({ cursor }), 'utf8');
    } catch {
      // 游标写不进去只影响去重，不影响回传本身
    }
  }

  /** 老配置里没有这个字段，按「开」处理。 */
  private get chatSyncOn(): boolean {
    return this.cfg.syncChat !== false;
  }

  private startChatSync(): void {
    this.stopChatSync();
    if (!this.chatSyncOn) return;
    const host = this.host;
    if (!host) return;
    // 首次启用时从「当前最新」开始，避免把历史对话一次性灌进 AstrBot
    const saved = this.readChatCursor();
    this.chatCursor = saved > 0 ? saved : host.store.latestCursor();
    if (saved === 0) this.writeChatCursor(this.chatCursor);
    this.chatTimer = setInterval(() => {
      void this.pollChat();
    }, CHAT_POLL_MS);
    this.chatTimer.unref?.();
  }

  private stopChatSync(): void {
    if (this.chatTimer) clearInterval(this.chatTimer);
    this.chatTimer = null;
    this.chatPending = null;
    this.chatTrigger = 'other';
  }

  private async pollChat(): Promise<void> {
    if (this.chatBusy) return;
    const host = this.host;
    if (!host || !this.chatSyncOn) return;
    const client = this.client();
    if (!client.ready) return;
    this.chatBusy = true;
    try {
      const events = host.store.range({ fromCursor: this.chatCursor + 1, limit: 200 });
      const outgoing: ChatItem[] = [];
      // 先把「对话已经停下来超过合并窗口」的批次发掉——没有新事件也要发
      this.flushChatBuffer(outgoing);
      for (const event of events) {
        this.chatCursor = Math.max(this.chatCursor, event.cursor);
        this.consumeChatEvent(event, outgoing);
      }
      this.writeChatCursor(this.chatCursor);
      if (outgoing.length > 0) {
        await client.chat(outgoing);
        this.chatSent += outgoing.length;
        this.opts.log?.(`对话已回传 AstrBot：${outgoing.length} 轮`);
      }
      if (this.chatError) this.opts.log?.('对话回传恢复正常');
      this.chatError = '';
    } catch (error) {
      const detail = errText(error);
      if (this.chatError !== detail) {
        this.chatError = detail;
        this.opts.log?.(`对话回传失败：${detail}`);
      }
    } finally {
      this.chatBusy = false;
    }
  }

  /** 逐条消费事件：只有「用户打字 → 桌宠回话」这一种配对会被记下来。 */
  private consumeChatEvent(event: EventEnvelope, outgoing: ChatItem[]): void {
    const text = (event.text ?? '').trim();
    if (!text) return;

    if (event.type === 'desktop-pet.message') {
      // 新的一轮开始，先把上一轮结账
      this.flushChat(outgoing);
      const fromMeta = typeof event.meta?.text === 'string' ? String(event.meta.text).trim() : '';
      const userText = fromMeta || this.stripSpeaker(text);
      if (!userText) return;
      this.lastUserText = userText;
      this.lastUserAt = Date.now();
      // 主人在刷视频时说「别刷了 / 停」之类 → 立即停掉脚本
      if (this.douyin.running && STOP_VIDEO_WORDS.test(userText)) {
        this.douyin.stop();
        this.opts.log?.(`主人说「${userText}」，停止刷视频`);
      }
      this.chatPending = { user: userText, replies: [], suppressed: Date.now() < this.commandChatUntil };
      this.chatTrigger = 'chat';
      return;
    }

    if (event.type === 'desktop-pet.self') {
      // [turn ended] 是明确的一轮结束
      if (text.includes('[turn ended]')) {
        this.flushChat(outgoing);
        return;
      }
      // 动作日志：只有 end_turn 才算这一轮结束；
      // 工具调用（做了:astrbot_files / 做了:pet_say …）夹在一轮中间，不能把对话截断
      if (text.startsWith(ACTION_PREFIX)) {
        if (text.slice(ACTION_PREFIX.length).trim() === 'end_turn') {
          this.flushChat(outgoing);
        }
        return;
      }
      // 送达回执不是它说的话：纯回执直接丢，回执+正文的只留正文
      const spoken = text.replace(DELIVERY_NOTICE, '').trim();
      if (!spoken) return;
      if (this.chatTrigger === 'chat' && this.chatPending) {
        this.chatPending.replies.push(spoken);
      }
      return;
    }

    // 触摸、AstrBot 主动消息都会让桌宠说话，但这些不算对话
    if (event.type === 'desktop-pet.touch' || event.type === 'astrbot.proactive') {
      if (!this.chatPending) this.chatTrigger = 'other';
    }
  }

  /** 对话停了 MERGE_WINDOW_MS 以上的批次才发出去。 */
  private flushChatBuffer(outgoing: ChatItem[]): void {
    if (this.chatBuffer.length === 0) return;
    const now = Date.now();
    const keep: ChatBatch[] = [];
    for (const batch of this.chatBuffer) {
      if (now - batch.at >= MERGE_WINDOW_MS) {
        outgoing.push({ user: batch.user, assistant: batch.replies.join('\n') });
      } else {
        keep.push(batch);
      }
    }
    this.chatBuffer = keep;
  }

  /** 纯应答词、或者短得没有信息量的话，不写记忆。 */
  private isTrivialTurn(text: string): boolean {
    const value = text.trim();
    if (value.length <= 2) return true;
    return TRIVIAL_TURN.test(value);
  }

  /** 把 `[01:05] [typed] 主人:下载的好慢` 里的正文取出来。 */
  private stripSpeaker(text: string): string {
    // 先剥掉前导的 [时间] [类型] 标记，否则时间里的冒号会被当成说话人分隔符
    const cleaned = text.replace(/^(?:\[[^\]]*\]\s*)+/, '').trim();
    const cut = cleaned.search(/[:：]/);
    if (cut >= 0 && cut < cleaned.length - 1) return cleaned.slice(cut + 1).trim();
    return cleaned;
  }

  private flushChat(outgoing: ChatItem[]): void {
    const pending = this.chatPending;
    this.chatPending = null;
    this.chatTrigger = 'other';
    if (!pending) return;
    const user = pending.user.trim();
    const reply = pending.replies.join('\n').trim();
    if (!user || !reply) return;
    // 测试命令触发的对话：不写记忆
    if (pending.suppressed) {
      this.opts.log?.(`跳过测试命令的对话：${user.slice(0, 40)}`);
      return;
    }
    // 「在吗 / 同意 / 好」这类纯应答没有信息量，不占记忆
    if (this.isTrivialTurn(user)) {
      this.opts.log?.(`跳过无信息量的对话：${user}`);
      return;
    }
    const now = Date.now();
    const last = this.chatBuffer[this.chatBuffer.length - 1];
    if (last && now - last.at <= MERGE_WINDOW_MS) {
      if (!last.user.includes(user)) last.user += `；${user}`;
      last.replies.push(reply);
      last.at = now;
      return;
    }
    this.chatBuffer.push({ user, replies: [reply], at: now });
  }

  // ---------- 面板数据面 ----------

  private async invoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'status':
        return this.status();
      case 'bind': {
        const code = String(args[0] ?? '').trim();
        if (!code) throw new Error('先填配对码');
        return this.bind(code);
      }
      case 'unbind':
        return this.unbind();
      case 'probe':
        return this.probe(String(args[0] ?? '').trim());
      case 'test':
        return this.test(String(args[0] ?? '').trim());
      case 'push-test':
        return this.pushTest(args[0]);
      default:
        throw new Error(`没有这个方法：${method}`);
    }
  }

  private async status(): Promise<Record<string, unknown>> {
    const base = {
      bound: this.client().ready,
      baseUrl: normalizeBase(this.cfg.baseUrl),
      deviceName: this.cfg.deviceName || hostname(),
      identityLabel: this.cfg.identityLabel || '',
      deviceId: this.cfg.deviceId || '',
      bubble: this.cfg.bubble !== false,
      pollSeconds: Number(this.cfg.pollSeconds || 20),
      lastPollAt: this.lastPollAt,
      delivered: this.delivered,
      lastError: this.lastError,
      syncChat: this.cfg.syncChat !== false,
      activity: this.cfg.activityEnabled !== false,
      lastActivityAt: this.lastActivityAt,
      lastActivity: this.lastActivity,
      activityError: this.activityError,
      pendingInbox: this.pendingInbox.length,
      fullscreen: this.lastFullscreen,
      chatSent: this.chatSent,
      chatError: this.chatError,
    };
    const client = this.client();
    if (!client.ready) return base;
    try {
      const identity = await client.identity();
      return { ...base, bound: true, identityLabel: identity.identity_label || base.identityLabel, nickname: identity.nickname };
    } catch (error) {
      return { ...base, lastError: errText(error) };
    }
  }

  private async bind(code: string): Promise<Record<string, unknown>> {
    const name = this.cfg.deviceName || hostname();
    const result = await pairDevice(this.cfg.baseUrl, code, name);
    this.opts.storeSecret(ASTRBOT_SECRETS.token, result.token);
    this.opts.persist({ identityLabel: result.identity_label, deviceId: result.device_id, deviceName: name });
    this.lastError = '';
    this.opts.log?.(`已绑定 ${result.identity_label}（设备 ${result.device_id}）`);
    this.startPolling();
    return this.status();
  }

  private async unbind(): Promise<Record<string, unknown>> {
    this.opts.storeSecret(ASTRBOT_SECRETS.token, '');
    this.opts.persist({ identityLabel: '', deviceId: '' });
    this.stopPolling();
    this.delivered = 0;
    this.lastPollAt = 0;
    this.lastError = '';
    this.opts.log?.('已解绑');
    return this.status();
  }

  private async probe(base: string): Promise<Record<string, unknown>> {
    const url = normalizeBase(base || this.cfg.baseUrl);
    try {
      const data = await new BridgeClient(url, '').health();
      return { ok: true, url, version: String(data.version ?? ''), service: String(data.service ?? '') };
    } catch (error) {
      return { ok: false, url, error: errText(error) };
    }
  }

  /**
   * 自检：不等 AstrBot 真的发消息，直接往主会话推一条同类型事件。
   * 触发方式与标签都能换，用来定位「事件唤醒」这条路径上的问题。
   */
  private async pushTest(raw: unknown): Promise<Record<string, unknown>> {
    const opts = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const host = this.host;
    if (!host) return { ok: false, error: 'World 还没启动（没启用，或正在重启）' };
    const trigger = String(opts.trigger ?? this.wakeMode()) as WakeMode;
    const speak = opts.speak !== false;
    const text = String(opts.text ?? '').trim()
      || '（自检）这是 AstrBot 桥接发来的一条测试消息，请用 pet_say 说给主人听。';
    try {
      const event = await host.pushEvent(
        {
          type: EVENT_PROACTIVE,
          ts: new Date().toISOString(),
          source: ASTRBOT_ID,
          senderKey: 'astrbot-selftest',
          ...(speak ? { tags: ['speak'] as const } : {}),
          text,
        },
        { trigger },
      );
      return { ok: true, cursor: event.cursor, trigger, speak, length: text.length };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  private async test(query: string): Promise<Record<string, unknown>> {
    const client = this.client();
    if (!client.ready) return { ok: false, error: '还没绑定' };
    try {
      const data = await client.recall(query, Number(this.cfg.recallLimit) || 8);
      const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
      return {
        ok: true,
        query,
        count: items.length,
        items: items.slice(0, 10).map((item) => ({
          source: String(item.source ?? ''),
          kind: String(item.kind ?? ''),
          text: String(item.text ?? '').slice(0, 200),
        })),
      };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }
}

/** create() 的粘合：把 WorldContext 变成 World 需要的那几个回调，并备好环境提示词文件。 */
export function createAstrbotWorld(ctx: WorldContext<AstrbotSection>): AstrbotWorld {
  const envPromptFile = join(ctx.dataDir, ENV_PROMPT_FILE);
  try {
    mkdirSync(ctx.dataDir, { recursive: true });
    if (!existsSync(envPromptFile)) writeFileSync(envPromptFile, ENV_PROMPT_DEFAULT, 'utf8');
  } catch {
    // 写不出来只影响环境提示词，模板按空处理，不牵连 World 挂载
  }
  return new AstrbotWorld({
    envPromptFile,
    dataDir: ctx.dataDir,
    packageDir: EXTENSION_DIR,
    cfg: ctx.cfg,
    persist: (patch) => ctx.persist(patch),
    secret: (name) => ctx.secret(name) ?? '',
    storeSecret: (name, value) => ctx.storeSecret(name, value),
    // WorldContext 没有 logger，走 console 才进得了 data/logs/core.log
    log: (message) => console.log(`[astrbot] ${message}`),
  });
}
