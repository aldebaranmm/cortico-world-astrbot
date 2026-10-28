/** 配置段、默认值与控制台表单声明。 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';

export const ASTRBOT_ID = 'astrbot';

/** 机器令牌存进 World 的 secret，不进明文配置。 */
export const ASTRBOT_SECRETS = { token: 'ASTRBOT_BRIDGE_TOKEN' } as const;

/** 从 /bridge/inbox 取到的主动消息，作为外部事件推给主会话。 */
export const EVENT_PROACTIVE = 'astrbot.proactive';

export interface AstrbotSection {
  enabled: boolean;
  /** 桥接服务地址：本机 http://127.0.0.1:6190，别的电脑填穿透后的地址。 */
  baseUrl: string;
  /** 配对时给这台机器起的名字，显示在 QQ 的「我的设备」里。 */
  deviceName: string;
  /** 把 AstrBot 的主动消息转成桌宠气泡。 */
  bubble: boolean;
  /** inbox 拉取间隔（秒）。 */
  pollSeconds: number;
  /** 单次检索返回的最大条数。 */
  recallLimit: number;
  /**
   * 事件送达方式。默认 flush：拉到就立刻唤醒桌宠，几秒内冒泡。
   * piggyback 只入队、等模型下次自然醒来才捎带出来 —— 主人不说话、桌宠也没别的事时
   * 会一直挂着不开口，实测确认过。旧注释里"flush 会吐坏流"是早期模型的观察，
   * 2026-10-27 在 deepseek-v4.1-flash 上实测 flush 稳定，故改回 flush。
   */
  wakeMode: string;
  /** 把桌宠里的对话回传给 AstrBot（只记真对话，拖动/触摸反应不记）。 */
  syncChat: boolean;
  /** 上报「主人在干什么」（前台窗口 / 空闲时长），供 AstrBot 与桌宠参考。 */
  activityEnabled: boolean;
  /** 上报间隔（秒），最小 15。 */
  activitySeconds: number;
  /** 全屏（含无边框全屏）时把主动消息攒着，退出后再出。 */
  skipFullscreen: boolean;
  /** 空闲时自动刷抖音（网页版）分析内容、记记忆。默认关。 */
  douyinEnabled: boolean;
  /** 空闲时自动刷 B站（网页版）分析内容、记记忆。默认关。 */
  bilibiliEnabled: boolean;
  /**
   * 扩展自动更新的服务器地址，**包里不写死任何真实地址**。
   * 留空（默认）= 这台机器不检查更新；填了才会去拉版本号、下载新包。
   */
  updateUrl: string;
  /** 绑定后回填的展示信息（打码身份、设备 id）。 */
  identityLabel: string;
  deviceId: string;
}

export const ASTRBOT_DEFAULTS: AstrbotSection = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:6190',
  deviceName: '',
  bubble: true,
  pollSeconds: 20,
  recallLimit: 8,
  wakeMode: 'flush',
  syncChat: true,
  activityEnabled: true,
  activitySeconds: 60,
  skipFullscreen: true,
  douyinEnabled: false,
  bilibiliEnabled: false,
  updateUrl: '',
  identityLabel: '',
  deviceId: '',
};

/** 控制台表单：键是配置里的点分路径。 */
export function astrbotConfigGroup(): ConfigGroup {
  return {
    id: ASTRBOT_ID,
    owner: `world:${ASTRBOT_ID}`,
    schema: {
      type: 'object',
      title: 'AstrBot 桥接',
      description: '把这台 Coopanion 接到 AstrBot。绑定之后，桌宠能查 AstrBot 记下的喜好习惯，也能把 AstrBot 的主动消息说成气泡。',
      properties: {
        'worlds.astrbot.baseUrl': {
          type: 'string',
          title: '桥接地址',
          description: '和 AstrBot 同一台电脑填 http://127.0.0.1:6190；别的电脑填那台机器访问得到的地址，例如 http://<你的服务器地址或域名>:8443（端口按穿透配置来）。',
        },
        'worlds.astrbot.deviceName': {
          type: 'string',
          title: '本机名称',
          description: '配对时登记的名字，在 QQ 里发「我的设备」能看到。留空用系统给的机器名。',
        },
        'worlds.astrbot.bubble': {
          type: 'boolean',
          title: '主动消息转气泡',
          description: '开：AstrBot 主动说的话由桌宠再说一遍（QQ 那边照发）。关：只保留记忆检索。',
        },
        'worlds.astrbot.pollSeconds': {
          type: 'integer',
          title: '拉取间隔',
          description: '多久去桥接服务取一次待发的主动消息。',
          minimum: 10,
          maximum: 600,
        },
        'worlds.astrbot.recallLimit': {
          type: 'integer',
          title: '单次检索条数',
          description: 'astrbot_recall 一次最多返回几条。',
          minimum: 1,
          maximum: 20,
        },
        'worlds.astrbot.syncChat': {
          type: 'boolean',
          title: '对话回传 AstrBot',
          description: '开：你在桌宠里说的话、桌宠回的话，会记进 AstrBot 里同一个人的会话历史，AstrBot 的记忆插件能查到。拖动、拎起、甩出去这些触摸反应不会记。',
        },
        'worlds.astrbot.activityEnabled': {
          type: 'boolean',
          title: '上报「主人在干什么」',
          description: '开：定时把前台窗口标题、程序名、键鼠空闲时长上报给 AstrBot，它回话时能自然提到你在写代码还是看视频。只读系统状态，不碰任何文件；关掉就完全不上报。',
        },
        'worlds.astrbot.activitySeconds': {
          type: 'integer',
          title: '上报间隔',
          description: '多久采一次，最小 15 秒。',
          minimum: 15,
          maximum: 600,
        },
        'worlds.astrbot.skipFullscreen': {
          type: 'boolean',
          title: '全屏时不打扰',
          description: '开：检测到全屏或游戏的无边框全屏时，AstrBot 的主动消息先攒着，退出全屏再出气泡；"走过来"的催人动作也会一起暂停。关掉就照常出。',
        },
        'worlds.astrbot.douyinEnabled': {
          type: 'boolean',
          title: '空闲自动刷抖音',
          description: '开：检测到主人离开（键鼠空闲 + 没在玩游戏 + 非全屏）时，桌宠自动打开抖音网页版刷视频。关：完全不刷。',
        },
        'worlds.astrbot.bilibiliEnabled': {
          type: 'boolean',
          title: '空闲自动刷B站',
          description: '开：检测到主人离开（键鼠空闲 + 没在玩游戏 + 非全屏）时，桌宠自动打开 B站网页版刷视频。两个都开时轮换着刷。关：不刷 B站。',
        },
        'worlds.astrbot.updateUrl': {
          type: 'string',
          title: '扩展更新地址',
          description:
            '扩展自动更新去哪儿拉新版本。留空（默认）＝这台机器不检查更新，自己发新包手动装就行。想开自动更新就填你自己的更新服务器，例如 http://<你的服务器地址或域名>:8080。安装包里不含任何真实地址。',
        },
        'worlds.astrbot.wakeMode': {
          type: 'string',
          title: '送达方式',
          description:
            'flush（默认）：拉到就立刻唤醒桌宠，几秒内冒出气泡。piggyback：消息先存着，等你跟桌宠说话、或它自己有动静时才捎带出来 —— 主人不说话它就一直不开口。',
          enum: ['piggyback', 'flush', 'debounce', 'preempt'],
        },
      },
    },
  };
}
