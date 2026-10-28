# cortico-world-astrbot

Coopanion 桌宠扩展 —— 把 **AstrBot** 接进桌宠。装好之后：

- 桌宠能查 AstrBot 记住的喜好习惯（`astrbot_recall`）
- AstrBot 的主动消息会变成桌宠气泡说出来
- 能自己开浏览器刷 B站/抖音，看完把内容写进 AstrBot 的记忆
- 读你的 B站收藏，按口味挑片（`astrbot_favorites`）
- 上报「主人在干嘛」给 AstrBot 参考

这是**客户端**组件，需要配合服务端的
[astrbot_plugin_coop_bridge](https://github.com/aldebaranmm/astrbot_plugin_coop_bridge) 使用。

- 总览 + 完整安装步骤：https://github.com/aldebaranmm/coopanion-astrbot-bridge
- 下载：[cortico-world-astrbot-0.9.4.zip](https://github.com/aldebaranmm/cortico-world-astrbot/releases/download/v0.9.4/cortico-world-astrbot-0.9.4.zip)

---

## 安装

1. 解压，把 `cortico-world-astrbot/` 整个目录放到 Coopanion 的扩展目录下
2. **重启 Coopanion**
3. 打开设置 → AstrBot：

| 字段 | 填什么 |
| --- | --- |
| 桥接地址 | 和 AstrBot 同一台电脑填 `http://127.0.0.1:6190`；别的电脑填那台机器访问得到的地址（如穿透后的 `http://<服务器>:8443`） |
| 本机名称 | 随便起，比如「客厅电脑」，在 QQ 发「我的设备」能看到 |
| 配对码 | 在 QQ 私聊机器人发「**配对**」拿 8 位码，填进来 |

详细步骤（含路径、排错）见 → [安装使用说明](https://github.com/aldebaranmm/coopanion-astrbot-bridge/blob/main/docs/%E5%AE%89%E8%A3%85%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md)

---

## 几个重要配置

在 Coopanion 的设置面板（或 `config.json` 的 `worlds.astrbot` 下）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wakeMode` | `flush` | **送达方式**。`flush` = 拉到就唤醒桌宠，几秒内冒泡；`piggyback` = 攒着，等你先跟桌宠说话才捎带出来（老版本默认这个，表现像"收到但不开口"） |
| `pollSeconds` | `20` | 多久去服务端拉一次消息 |
| `updateUrl` | 空 | 扩展自动更新去哪儿拉新版本。**留空 = 这台机器不检查更新**，自己发新包手动装 |
| `bubble` | 开 | 主动消息转成气泡 |
| `douyinEnabled` / `bilibiliEnabled` | 关 | 检测到主人离开时自动刷 |

> **0.9.3 及更早版本升级注意**：老版本 `wakeMode` 默认是 `piggyback`，
> 远程消息要等你先在气泡里说话才冒出来。想要立刻冒泡就在配置里补一行 `"wakeMode": "flush"` 再重启。

---

## 消息是"拉"的，不是"推"的

服务端不会主动连客户端 —— 是**本扩展每 `pollSeconds` 秒去桥接地址问一次**。
所以服务端不需要知道你在哪，你也不需要公网地址。
代价是延迟最多一个轮询周期。

---

## 依赖

运行时需要 `playwright-core`（刷视频用的浏览器驱动），已随 zip 打包在 `node_modules/` 里。
从源码仓库 clone 的话需要自己装：

```bash
npm install playwright-core
```

浏览器用的是系统已有的 Edge。首次刷 B站/抖音需要扫码登录一次，登录态保存在
`.browser-profile-*` 目录里，之后不用重复扫。

---

## 许可与商用限制

作者：**Kaiser**

### ✅ 可以自由使用

- 个人自用、学习研究
- 非营利的修改与二次分发（须保留署名和本声明）

### ❌ 未经书面授权，禁止任何形式的商业使用

包括但不限于：

- 打包进收费产品或服务出售
- 用于经营性业务（付费机器人、商业客服、企业内部系统等）
- 二次分发收费，或去除/篡改署名后转售
- 作为付费部署、代搭建服务的一部分提供

### 商业授权

确有商业使用需求的，请联系作者取得 **书面授权**。

### 法律声明

对未经授权的商业使用，作者 **保留一切追诉权利**，
包括但不限于要求立即停止侵害、消除影响、赔偿损失，以及提起诉讼。

---

代码许可：**AGPL-3.0-or-later**，但该授权 **不包含商业使用**。
商业使用不在上述开源许可的授权范围内，须另行取得书面许可。
