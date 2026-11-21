# `adapters/qq-onebot/` — 零依赖 QQ OneBot v11 躯体适配器

> 遵循《灵魂予你》通用躯体协议 v1.1，**零外部 npm 依赖**，支持任意标准 OneBot v11 协议端（NapCat、SnowLuma、LLOneBot 等），自带严格防风控白名单与并发冲突检查。

---

## 核心特性

1. **零污染独立开源插件**：不依赖任何第三方私有网关或旧版框架，全部运行在 Node.js `>= 22.13` 原生能力之上（原生 `WebSocket` + `fetch` + `net`）。
2. **2026 QQ 防风控多道护栏**：
   - **默认封闭白名单（Fail-Closed）**：仅对 `guard.allowedUsers` 与 `guard.allowedGroups` 中的 QQ 号/群号回复，陌生人消息直接丢弃。
   - **群聊防刷屏**：默认开启 `groupRequireAtOrWakeWord: true`（仅在群内被 `@` 或触发唤醒词时回复）；其余群聊消息可选以 `allowSpeak: false` 静默写入灵魂经验流（只看记心上，不打扰群友）。
   - **速率与冷却控制**：私聊默认冷却 `2500ms`、群聊 `4000ms`、全局每分钟/每小时限流 + 拟人随机打字延迟（`800-1800ms`）+ 超长文本自动分片。
   - **断线重连积压防风暴**：自动丢弃连接建立前超过 `maxMessageAgeSec`（默认 `15s`）的离线堆积旧消息 + `message_id` 去重。
   - **防双开冲突检查**：启动前探测 `guard.conflictCheckPorts`（例如旧版桥接端口 `3100`），若发现旧桥接仍在监听，拒绝上线并提示先暂停旧端，**绝不让同一个 QQ 号同时在线两个 Bot**。
3. **可选声带转发（GPT-SoVITS `:8765`）**：开启 `voice.enabled` 后可转发语音条。

---

## 快速上手

### 1. 初始化本地私有配置（已被 `.gitignore` 忽略）

```powershell
node adapters/qq-onebot/main.ts --init
```

此命令会生成 `adapters/qq-onebot/qq-adapter.local.json`。请填入：
- `onebot.wsUrl`（通常为 `ws://127.0.0.1:3001`）及对应 `wsAccessToken`
- `onebot.httpUrl`（通常为 `http://127.0.0.1:3000`）及对应 `httpAccessToken`
- `guard.allowedUsers`（你的测试主号 QQ）与 `guard.allowedGroups`（测试小群，没有可留空 `[]`）

> [!CAUTION]
> **切勿将真实 QQ 号或 Token 写入 `qq-adapter.example.json` 或提交到 Git！** 仅使用 `.local.json` 存放私人配置。

### 2. 暂停旧版桥接（防止双 Bot 撞号）并自检

若本机此前运行着其他 QQ 桥接程序，请先在对应控制面板暂停它（保持你的 OneBot 协议端和 QQ 测试小号在线即可），然后执行：

```powershell
# 第一步：启动灵魂中枢
node src/server/main.ts

# 第二步（另开终端）：运行 QQ 适配器安全自检
node adapters/qq-onebot/main.ts --check
```

确认输出中 `ok: true`、`conflictPorts: []`、`hub.ok: true`、`onebot.ok: true` 后，启动适配器：

```powershell
node adapters/qq-onebot/main.ts
```

现在给测试小号发一句「早安」，她不仅会记住《灵魂予你》网页端/游戏端刚刚发生的事，也会在灵魂记忆透视镜里实时出现 `[chat:qq]` 的活动足迹。
