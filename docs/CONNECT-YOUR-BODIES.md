# 连接你的真实躯体：实测填空指南 (`v0.6.0`)

> **一句话原则**：《灵魂予你》的大脑、记忆与人格只管留在 `127.0.0.1:7777` 中枢；任何支持 **OpenAI 接口 / OneBot v11 / MCP / HTTP-WS** 的外部软件，只需把接口地址改指这里，就会立刻共享同一个“柳遥”的记忆、情绪与未完约定。

---

## 一、启动与令牌准备（2 步先决条件）

### 1. 启动灵魂中枢并配好大脑
1. **启动服务**：Windows 双击根目录 [start-soul-test.cmd](../start-soul-test.cmd)，或在仓库根目录执行：
   ```bash
   node src/server/main.ts
   ```
2. **配好对话模型**：浏览器打开 `http://127.0.0.1:7777` → 点击顶部 **`V 开放插座`** → 在右侧 **ENGINE · 大脑模型与记忆检索设置** 选择你的模型驱动（Gemini AI Studio / Vertex / OpenAI 兼容 / 本地 Ollama 等），填好模型名、Base URL 与 API Key → 点 **「保存配置」**。
   > 若暂未配置外部模型，系统默认处于 `mock` 离线演示模式；你也可以在右侧随时配置或开启 `fallbackModels` 自动回退。

### 2. 获取本地访问令牌（`.soul-hub.token`）
所有 `/v1/*`、`/api/*` 与 `/mcp` 写/读接口默认启用回环鉴权：
- 首次启动中枢后，会在仓库根目录（或自定义 `SOUL_CONFIG` 同目录）自动生成隐藏文件 **`.soul-hub.token`**（内含一段随机十六进制令牌）。
- 也可以在启动中枢前通过环境变量 `SOUL_API_TOKEN` 手动指定令牌。
- **安全红线**：`.soul-hub.token` 等同于你的本机门禁钥匙，**严禁暴露到公网、严禁截图或粘贴进公开 Issue**。

---

## 二、`v0.6.0` 能力成熟度矩阵（诚实透明说明）

| 状态分类 | 模块 / 能力 | 当前真实状态与验证说明 |
| :--- | :--- | :--- |
| **已在本机 / 自动化实测** | 纯文本灵魂档案 v1.1 | `SEED.md <= 2048 B`、单调 `seq`、SHA-256 快照回滚、只读脱敏导出均已通过自动化实测 |
| **已在本机 / 自动化实测** | FTS5 + 事实冲突记忆引擎 | `node:sqlite` FTS5 索引（删库 100% 重建）、`facts.jsonl` 冲突覆写、可选向量/Rerank 召回与默认洁净开关已实测 |
| **已在本机 / 自动化实测** | 三大开放插座协议 & 门禁 | Body HTTP/WS/SSE、OpenAI Proxy (`/v1` & `/v1/bodies/...`)、MCP (`/mcp` & stdio)、`fallbackModels` 与 Native Tools 已测试通过 |
| **已在本机 / 自动化实测** | 回归测试与 30 轮评测 | `node --test tests/*.test.ts` **全绿**、万级 JSONL 压测、30 天虚拟时钟模拟及内置 30 轮防幻觉评测脚本已跑通 |
| **开放协议已就绪 · 待社区实测** | QQ OneBot v11 适配端 | 离网全链路单测已通过；接真实 NapCat / Lagrange QQ 需由用户按本机协议端环境实测验证 |
| **开放协议已就绪 · 待社区实测** | 零代码 OpenAI 直连躯体 | 桌宠（Open-LLM-VTuber / AIRI）、MC Mindcraft、刷 B 站陪看、SillyTavern、MCP 客户端通过 `/v1/bodies/...` 与 `/mcp` 直接接入，欢迎社区提交实测反馈 |
| **暂搁置 / 后续路线** | Phase B 及后续扩展 | 旧版手写 Mineflayer 原型已移出公开仓库；SillyTavern V2 导入、桌宠/QQ 实机联调与实体硬件共建留待后续推进 |

---

## 三、4 类真实躯体实测填空步骤（照抄即填）

### 1. QQ 伴侣（OneBot v11 / NapCat / Lagrange）
- **前置条件**：本地已启动 OneBot v11 协议端（默认正向 WS `ws://127.0.0.1:3001`、HTTP `http://127.0.0.1:3000`）。
- **方式 A（网页可视化，推荐小白）**：
  1. 在中枢控制台点顶部 **`VI 系统联调`**；
  2. 填写 **私聊白名单主号 QQ**（默认拒绝陌生人）、可选 **群聊白名单群号** 与 **群聊唤醒词**（如 `柳遥, Liuyao`），再填入你的本地 OneBot WS/HTTP 地址与对应鉴权 Token；
  3. 点 **「保存配置」** → **「启动 QQ 接入」**。
- **方式 B（命令行配置）**：复制 [qq-adapter.example.json](../adapters/qq-onebot/qq-adapter.example.json) 为同目录下的 `qq-adapter.local.json`（已被 `.gitignore` 忽略），修改 `allowedUsers`、`wakeWords` 与 `onebot` Token 后运行：
  ```bash
  node adapters/qq-onebot/main.ts
  ```
- **成功标志**：状态灯变青绿 `运行中`、QQ 小号私聊发消息收到真实回复、在网页 **`III 万年典籍`** 情景日记中可见带 `[chat:qq]` 标签的新记忆。

### 2. 桌面宠物（Open-LLM-VTuber / Project AIRI 等）
在桌宠软件的「自定义 OpenAI LLM」设置页直接填写以下 3 项：
- **Base URL / Endpoint**：`http://127.0.0.1:7777/v1/bodies/desktop-pet/my-pet`
- **API Key**：`<粘贴 .soul-hub.token 中的整串文本>`
- **Model**：`soul-unto-you`
- **跨端验收法**：在桌宠里跟她约定“今晚九点提醒我喝水”，随后打开网页 **`I 双界演练台`** 或 **`III 万年典籍`**，确认能看到同一条未完约定与 `[desktop-pet]` 来源足迹。

### 3. Minecraft 成熟外部 Agent（如 Mindcraft）
> 原手写 Mineflayer 实验原型已搁置并移出公开仓库。**推荐直接对接成熟外部 MC Agent**，把灵魂大脑挂上去：
- **Base URL / Endpoint**：`http://127.0.0.1:7777/v1/bodies/game-mc/mindcraft-1`
- **API Key**：`<粘贴 .soul-hub.token 中的整串文本>`
- **Model**：`soul-unto-you`
- **自定义提醒**：你可以在 Agent 的系统提示词（`system` message）里写明当前血量、背包和世界规则；中枢会自动提取 `externalSystemContext` 并结合跨端记忆生成回复。

### 4. 刷 B 站陪看 · SillyTavern · MCP 客户端
- **刷 B 站陪看（`browser-bilibili`）**：
  - 本地陪看伴侣或浏览器扩展填写：`http://127.0.0.1:7777/v1/bodies/browser-bilibili/bili-watch`，API Key 同 `.soul-hub.token`，Model 填 `soul-unto-you`。
  - **重要安全提醒**：中枢开启了严格的回环 `Host` 与同源/防跨站（`Origin` / `Sec-Fetch-Site: cross-site`）校验。**不要**在 `bilibili.com` 网页控制台里直接注入脚本 `fetch('http://127.0.0.1:7777/...')`（会被浏览器触发跨站拦截返回 `403`）；请通过**浏览器扩展后台（Background / Service Worker）**或独立桌面陪看进程转发请求。
- **SillyTavern / 通用酒馆客户端（`chat-tavern`）**：
  - Chat Completion 接口选 `Custom (OpenAI-compatible)`：Base URL 填 `http://127.0.0.1:7777/v1/bodies/chat-tavern/st-main`，API Key 填 `.soul-hub.token`，Model 填 `soul-unto-you`。
- **MCP 客户端（Claude Desktop / Cursor 等）**：
  - **Stdio 本地直连（免令牌）**：命令填 `node`，参数填 `src/server/mcp-stdio.ts`（工作目录设为本仓库根目录）。
  - **HTTP MCP 端点**：地址填 `http://127.0.0.1:7777/mcp`，请求头附带 `X-Soul-Token: <你的 .soul-hub.token>` 与 `Content-Type: application/json`。
- **自定义躯体代码参考（Node.js / Python / RimWorld C#）**：
  - 零依赖 Node.js 可运行样板见 [node-body-starter.mjs](../examples/body-kits/node-body-starter.mjs)；Python 与 RimWorld C# 蓝图代码块见 [body-starter-kits.md](./examples/body-starter-kits.md)。

---

## 四、常见报错速查

| 状态码 | 常见原因 | 立即排查方式 |
| :--- | :--- | :--- |
| **`401`** | 缺少或填错了本地令牌 | 检查请求头 `Authorization: Bearer <令牌>` 或 `X-Soul-Token` 是否与根目录 `.soul-hub.token` 完全一致（注意末尾不要多空格或换行）。 |
| **`403`** | 非回环 Host 或跨站 `Origin` 被拦截 | 确认接入地址是 `127.0.0.1:7777` 或 `localhost:7777`；如果是网页脚本从外部域名直接 `fetch`，请改走扩展后台或本地代理进程。 |
| **`502`** | 右侧 ENGINE 大脑未连通或上游报错 | 切回 **`V 开放插座`** 右侧检查模型驱动、API Key、Base URL 或开启 `fallbackModels`；点击 **`VI 系统联调`** 状态灯查看实时日志。 |

---

## 五、社区早鸟实测反馈（GitHub Issue 模板）

欢迎在本仓库的 GitHub Issues 页面提交你的真实躯体接通报告或卡点，提交时请附带以下脱敏信息：
1. **接入软件名称与版本**（例如：NapCat x.y / Open-LLM-VTuber / Mindcraft / SillyTavern）；
2. **使用的插座地址格式**（例如：`/v1/bodies/desktop-pet/my-pet` 或 `/mcp`）；
3. **本机 Node.js 版本**（需 `>= 22.18.0`）与操作系统；
4. **复现步骤与完整状态码/报错文字**。

> **隐私保护铁律**：发帖或截图前，**务必删除或打码**任何大模型 API Key、`.soul-hub.token` 令牌、真实 QQ 号/群号以及包含你本机用户名的绝对磁盘路径！
