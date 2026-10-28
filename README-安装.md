# Coopanion × AstrBot 桥接扩展

让桌宠 Coo 和你的 AstrBot 接上：AstrBot 主动说的话会变成 Coo 的气泡，Coo 也能查到 AstrBot 记下的关于你的事；你在 Coo 里聊的天，会同步进 AstrBot 的记忆。

**版本 0.5.0** ｜ 适配 Coopanion 的 Cortico 扩展接口 `api: 6`（实测 0.2.10）

---

## 一、它能做什么

| 功能 | 表现 |
|---|---|
| **气泡** | AstrBot 主动发消息时，Coo 同步冒出气泡说出来（QQ 那边照发，两边都有） |
| **记忆检索** | 你问「我以前说过什么」这类问题，Coo 会去查 AstrBot 记住的内容再回答 |
| **对话回传** | 你在 Coo 里说的话 + Coo 回的话，会记进 AstrBot 的记忆库（拖动、拎起、甩出去不算） |
| **活动感知** | 定时把「你正在用什么程序」上报给 AstrBot，它主动找你时能提一句「又在写代码？」 |
| **看文件夹** | 它想知道你某个目录里有什么时，会**先问你**，你答应了才读——只给文件名、时间、大小，永远不读内容 |
| **全屏不打扰** | 你全屏看片、打游戏、做演示时，它不会冒泡也不会凑过来；退出全屏后再补一句 |

---

## 二、安装

### 1. 找到 Coopanion 的数据目录

右键桌面上的 Coopanion 快捷方式 → **打开文件所在位置**，然后看它旁边的 `data` 文件夹。
例如 `D:\coopanion\data`。

> ⚠️ 是**数据目录**，不是程序目录。如果 `data-location.json` 把数据指到了别处，以那里为准。

### 2. 放进去

把整个 `cortico-world-astrbot` 文件夹复制到：

```
<数据目录>\extensions\node_modules\cortico-world-astrbot
```

放好后应该是这样（**别多套一层**）：

```
extensions\node_modules\cortico-world-astrbot\package.json
extensions\node_modules\cortico-world-astrbot\src\
extensions\node_modules\cortico-world-astrbot\dist\
```

### 3. 登记到清单

用记事本打开 `<数据目录>\extensions\package.json`，把 `dependencies` 改成这样（**必须是 `file:` 写法**）：

```json
{
  "name": "cortico-extensions",
  "private": true,
  "dependencies": {
    "cortico-world-astrbot": "file:./node_modules/cortico-world-astrbot"
  }
}
```

如果文件里已经有别的内容，只加那一行，不要整份覆盖。

> 记事本保存时注意「文件名」必须是 `package.json`，别存成 `package.json.txt`。

### 4. 重启

右下角托盘图标 → 右键 → **退出**（只关窗口不算，进程还在）。再打开。

浏览器访问 `http://127.0.0.1:17788`，左侧应该多出一页 **AstrBot**。没看到就跳到「六、排查」。

---

## 三、绑定这台电脑

绑定是**一机一次**，认的是你的 QQ 号，令牌一机一份、互相看不到对方的数据。

### 1. 先让 AstrBot 认识你（每人一次）

用**你自己的 QQ** 私聊机器人，任发一句话 → 它会问「你是 QQ ××× 吗」→ 回 `确认`。

### 2. 拿配对码

同一个 QQ 发：

```
配对
```

它会回一个 8 位数字码，**10 分钟内有效**。过期了就再发一次。

### 3. 填进控制台

控制台 → 左侧 **AstrBot** → 「配对」卡：

| 字段 | 填什么 |
|---|---|
| 桥接地址 | **和 AstrBot 同一台电脑**：`http://127.0.0.1:6190`<br>**其他电脑**：填那台机器访问得到的地址，如 `http://<你的服务器地址或域名>:8443`（端口按穿透配置来） |
| 本机名称 | 随便起，比如「客厅电脑」 |
| 配对码 | 上一步那 8 位 |

点**绑定**。成功的话状态卡会显示「绑定身份 276*****27」这样的打码号码，并给出设备 ID。

> 令牌只在绑定成功那一刻生成一次，扩展自己存进 `.env`，不需要你手动抄。

### 4. 试一下

同一页最下面「记忆检索」卡，填个词（比如你常聊的话题），点「试一次检索」。能出条数就是通了。

---

## 四、配置项

控制台 → 左侧 **AstrBot** → 顶部「配置」。

| 配置 | 默认 | 说明 |
|---|---|---|
| 桥接地址 | `http://127.0.0.1:6190` | 远程机器要填公网地址 |
| 本机名称 | 空 | 显示在「我的设备」里 |
| 主动消息转气泡 | 开 | 关掉就只拉消息不说话 |
| 拉取间隔 | 20 秒 | 多久问一次有没有新消息 |
| **送达方式** | `flush` | `flush` 立刻冒泡；如果模型服务报 `Duplicate content part`，改成 `piggyback`（搭下一轮对话的车）或关闭模型深度思考 |
| 对话回传 AstrBot | 开 | Coo 里的对话记进 AstrBot 记忆 |
| 上报「主人在干什么」 | 开 | 定时上报前台窗口，只读系统状态，不碰文件 |
| 上报间隔 | 60 秒 | 最小 15 秒 |
| **全屏时不打扰** | 开 | 全屏/无边框全屏时攒着，退出后补 |
| 单次检索条数 | 8 | `astrbot_recall` 一次最多返回几条 |

---

## 五、隐私边界

**会读**
- 前台窗口的**标题和程序名**（如「main.py - Visual Studio Code」）
- 键鼠空闲时长
- 你**明确同意**后，某个文件夹里的**文件名、修改时间、大小**

**不会读**
- 任何文件内容
- 截图、剪贴板、键盘输入
- 浏览器历史、聊天记录

**存在哪**
- 令牌：本机 `.env`（不进配置文件）
- 活动采样：AstrBot 侧 `plugin_data/astrbot_plugin_coop_bridge/activity.json`，每个身份最多 20 条滚动覆盖
- 记忆：AstrBot 的 livingmemory 库，按你的 QQ 号隔离，别人查不到

**怎么关**
- 不想上报活动：关「上报「主人在干什么」」
- 不想进记忆：关「对话回传 AstrBot」
- 不想被气泡打扰：关「主动消息转气泡」，或拉长免打扰时段（在 QQ 里设置）

---

## 六、排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 控制台没有 AstrBot 页 | 包放错层级，或 `package.json` 没登记 | 确认路径是 `extensions\node_modules\cortico-world-astrbot\package.json`；确认清单是 `file:` 写法 |
| 日志报 `连不上桥接服务（fetch failed）` | **开着系统代理**（最常见） | 关掉代理软件，或把 `127.0.0.1` / 服务器 IP 加进代理白名单 |
| 报 `令牌无效或已吊销` | 绑定过期或被解绑 | QQ 里发「配对」重新绑 |
| 配对时报「配对码无效或已过期」 | 超过 10 分钟 | 重新发「配对」 |
| 有 QQ 消息但没气泡 | 免打扰时段 / 全屏中 / 送达方式是 piggyback | 看控制台状态里的「上次拉取」「暂存条数」 |
| 它读到一半报错 | 目录不存在或没权限 | 换一个路径试 |
| 它不肯读文件夹 | 你还没明确答应 | 回一句带「可以 / 行 / 同意 / 看吧」的话，180 秒内有效 |

**看日志**：`<数据目录>\logs\core.log`，搜 `[astrbot]`，扩展会自己写：

```
[astrbot] 已启动（http://…，间隔 20s，气泡开，对话回传开，活动上报开/60s，令牌已就绪(43位)）
[astrbot] 轮询失败（地址）：原因
[astrbot] 轮询恢复正常
[astrbot] 收到 1 条主动消息，已按 flush 推给主会话
[astrbot] 检测到全屏，暂存 2 条主动消息，退出后再出
[astrbot] 已退出全屏
[astrbot] 对话已回传 AstrBot：1 轮
```

---

## 七、卸载

1. 托盘退出 Coopanion
2. 删掉 `<数据目录>\extensions\node_modules\cortico-world-astrbot`
3. 从 `<数据目录>\extensions\package.json` 的 `dependencies` 里删掉那一行
4. 重新打开

QQ 里发 `我的设备` 可以看到当前绑定的机器；发 `取消配对 名字` 可以吊销某台机器的令牌。

---

## 附：目录结构

```
cortico-world-astrbot/
├── package.json           扩展清单（name / version / cortico.api）
├── README-安装.md          本文件
├── src/
│   ├── index.ts            World 入口，声明 id、事件、工具
│   ├── world.ts            主体：绑定状态机、气泡轮询、记忆工具、对话回传、全屏保护
│   ├── bridge.ts           与 AstrBot 桥接服务的 HTTP 客户端
│   ├── activity.ts         前台窗口采集（只读）+ 目录列举（需同意）
│   ├── config.ts           配置项与控制台表单声明
│   └── webui/client.ts     控制台面板源码
├── dist/
│   └── webui.js            已构建的面板，开箱即用
└── scripts/
    └── build-webui.mjs     只有改面板时才需要跑
```

不含 `node_modules`，也不需要联网安装依赖——Coopanion 会用自带的 tsx 直接加载 `src/*.ts`。
