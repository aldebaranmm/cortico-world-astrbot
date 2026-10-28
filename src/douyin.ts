/** 空闲时自动刷视频（M20/M21）：Steam 游戏检测 + 刷视频脚本进程管理。

触发决策（空闲 + 询问同意）在 world.ts 里做，这里只负责：
  - isGameRunning：有没有 Steam 游戏在跑
  - DouyinScroller：拉起 / 杀掉刷视频脚本进程（抖音 / B站）

脚本 `scripts/douyin-scroll.mjs` / `scripts/bilibili-scroll.mjs` 用 playwright-core +
系统 Edge 打开对应网站，ESC 关弹窗、窗口前置、自然滚动，持续 N 秒后自己退出；
被 kill 也立即停。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/** 键鼠空闲多久（秒）才允许刷。 */
const IDLE_SECONDS = 300;
/** 一轮刷多久（秒）。 */
const SCROLL_SECONDS = 300;

/** 支持的视频平台。 */
export type VideoPlatform = 'douyin' | 'bilibili';

const SCRIPT_BY_PLATFORM: Record<VideoPlatform, string> = {
  douyin: 'douyin-scroll.mjs',
  bilibili: 'bilibili-scroll.mjs',
};

const NAME_BY_PLATFORM: Record<VideoPlatform, string> = {
  douyin: '抖音',
  bilibili: 'B站',
};

/** 检测 Steam 游戏：可执行文件路径落在 steamapps\common 下（参考 astrbot 侧 game_watch）。 */
const GAME_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$n = @(Get-Process | Where-Object { $_.Path -and ($_.Path -like '*\steamapps\common\*') }).Count
Write-Output $n
`;

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    );
  });
}

/** 有没有 Steam 游戏在跑；检测失败一律当「没在玩」（宁可打扰，也不误判）。 */
export async function isGameRunning(): Promise<boolean> {
  try {
    const raw = await runPowerShell(GAME_SCRIPT);
    const n = parseInt(raw || '0', 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

/** 刷视频脚本跑完输出的一条结果。 */
export interface DouyinCard {
  text: string;
  author: string;
  like: string;
  cover: string;
}

export interface DouyinResult {
  loggedIn: boolean;
  cards: DouyinCard[];
}

/** 刷的过程中实时抓到的一条视频（标题 + 作者），供桌宠边刷边评论。 */
export interface DouyinVideo {
  text: string;
  author: string;
}

/** 管理刷视频脚本的进程：launch 拉起，stop 杀掉；跑完把抓到的卡片回调出去。 */
export class DouyinScroller {
  private child: ChildProcess | null = null;
  /** 本轮结果是否已交付；汇总行一到就交付，避免退出时重复上报。 */
  private resultDelivered = false;

  constructor(
    private readonly packageDir: string,
    private readonly log?: (message: string) => void,
    private readonly onResult?: (result: DouyinResult) => void,
    private readonly onVideo?: (video: DouyinVideo) => void,
    private readonly onLoginStatus?: (loggedIn: boolean) => void,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /**
   * @param waitSeconds 未登录时等主人扫码登录的秒数（不计入滚动时长）
   * @param holdSeconds 刷完之后把窗口留在屏幕上的秒数；主人要看它刷，刷完就关太突然
   * @param bvid 桌宠按自己口味挑的那条，先点开看它再看 feed
   */
  launch(
    platform: VideoPlatform = 'douyin',
    durationSeconds: number = SCROLL_SECONDS,
    waitSeconds = 0,
    holdSeconds = 0,
    bvid = '',
  ): void {
    if (this.child) return;
    this.resultDelivered = false;
    const script = join(this.packageDir, 'scripts', SCRIPT_BY_PLATFORM[platform]);
    const name = NAME_BY_PLATFORM[platform];
    try {
      const args = [script, '--headful', `--duration=${durationSeconds}`];
      if (waitSeconds > 0) args.push(`--wait=${waitSeconds}`);
      if (holdSeconds > 0) args.push(`--hold=${holdSeconds}`);
      if (bvid) args.push(`--bvid=${bvid}`);
      // Electron 里没有独立的 node，用 ELECTRON_RUN_AS_NODE 让当前进程以 Node 模式跑脚本
      this.child = spawn(
        process.execPath,
        args,
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let lineBuf = '';
      let stderr = '';
      this.child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        lineBuf += text;
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          this.handleVideoLine(line);
        }
      });
      this.child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      this.child.on('exit', (code) => {
        this.child = null;
        if (stderr.trim()) {
          this.log?.(`刷${name}脚本报错（exit=${code ?? '?'}）：${stderr.trim().slice(0, 400)}`);
        }
        this.parseResult(stdout);
      });
      this.child.on('error', (err) => {
        this.log?.(`刷${name}脚本启动失败: ${err.message}`);
        this.child = null;
      });
      this.log?.(`开始刷${name}（持续 ${durationSeconds} 秒）`);
    } catch (err) {
      this.log?.(`刷${name}脚本异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 已退出
      }
      this.child = null;
    }
  }

  /** 解析脚本实时输出的一行：认 {loginStatus: bool} 登录态行、{v: 标题, a: 作者} 视频行，其余忽略。 */
  private handleVideoLine(line: string): void {
    if (!line.startsWith('{')) return;
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (typeof data.loginStatus === 'boolean') {
        this.onLoginStatus?.(data.loginStatus);
        return;
      }
      // 汇总行（带 cards）：立刻交付，不等进程退出。
      // 脚本刷完会为了把窗口留在屏幕上继续挂着，那时 exit 事件还没来，
      // 等到退出再解析的话，主人早就把窗口关掉了。
      // 每来一批汇总就交一次：不限时模式下脚本会边刷边报增量，不能只交第一次
      if (Array.isArray(data.cards)) {
        this.resultDelivered = true; // 只用来让退出时的兜底别重复报
        this.onResult?.(this.cardsOf(data));
        return;
      }
      const text = String(data.v ?? '').trim();
      if (!text) return;
      this.onVideo?.({
        text: text.slice(0, 80),
        author: String(data.a ?? '').slice(0, 60),
      });
    } catch {
      /* 非 JSON 或非视频行，忽略 */
    }
  }

  /** 汇总 JSON → 卡片结果。 */
  private cardsOf(data: Record<string, unknown>): DouyinResult {
    const cardsRaw = Array.isArray(data.cards) ? data.cards : [];
    const cards: DouyinCard[] = [];
    for (const c of cardsRaw) {
      if (!c || typeof c !== 'object') continue;
      const row = c as Record<string, unknown>;
      const text = String(row.text ?? '').trim();
      if (!text) continue;
      cards.push({
        text: text.slice(0, 300),
        author: String(row.author ?? '').slice(0, 60),
        like: String(row.like ?? '').slice(0, 20),
        cover: String(row.cover ?? '').slice(0, 500),
      });
    }
    return { loggedIn: Boolean(data.loggedIn), cards };
  }

  /** 兜底：进程退出时再从 stdout 里挖一次汇总 JSON（正常路径是汇总行一到就交付）。 */
  private parseResult(stdout: string): void {
    if (this.resultDelivered) return;
    try {
      // 不能对整段 stdout 做贪婪匹配（/\{[\s\S]*\}/）：脚本会先输出 loginStatus 行、
      // 再逐条输出视频行，最后才输出带 cards 的汇总行，粘在一起根本不是合法 JSON。
      // 从后往前找到最后一个「带 cards 的合法 JSON 行」。
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      let data: Record<string, unknown> | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (Array.isArray(parsed.cards)) {
            data = parsed;
            break;
          }
        } catch {
          // 这行不是合法 JSON，继续往上找
        }
      }
      if (!data) return;
      const cardsRaw = Array.isArray(data.cards) ? data.cards : [];
      const cards: DouyinCard[] = [];
      for (const c of cardsRaw) {
        if (!c || typeof c !== 'object') continue;
        const row = c as Record<string, unknown>;
        const text = String(row.text ?? '').trim();
        if (!text) continue;
        cards.push({
          text: text.slice(0, 300),
          author: String(row.author ?? '').slice(0, 60),
          like: String(row.like ?? '').slice(0, 20),
          cover: String(row.cover ?? '').slice(0, 500),
        });
      }
      this.onResult?.({ loggedIn: Boolean(data.loggedIn), cards });
    } catch {
      this.log?.('刷视频结果解析失败');
    }
  }
}

export { IDLE_SECONDS, SCROLL_SECONDS };
