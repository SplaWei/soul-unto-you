# SoulUntoYou《灵魂予你》（`v0.6.0` 早期个人原型）

> [English](./README.md) | **简体中文** | [纯小白使用说明书 (中文)](./docs/BEGINNER-GUIDE.zh-CN.md) | [Beginner's Guide (EN)](./docs/BEGINNER-GUIDE.md)

这是一个**非程序员借助 AI 辅助开发的早期个人原型**。

它实际做的事情：把 AI 伴侣的人设、聊天记录、情景摘要和结构化事实存成**本地纯 UTF-8 文本文件（Markdown + JSONL + JSON）**，用 Node 内置的 `node:sqlite` FTS5 派生索引加速召回，并在本机跑一个仅限本地访问的中枢服务（提供 OpenAI 兼容接口 `/v1`、HTTP/WebSocket/SSE 接口以及 MCP 接口），让不同的聊天软件或工具读写同一份本地文本目录。

做这个实验的朴素出发点：软件会停服、数据库会损坏，而纯文本文件随时都能用记事本打开、像普通文档一样备份，放很多年也依然能读。

---

## `v0.6.0` 更新亮点

* **仓库瘦身与零依赖**：坚持 Node.js `>= 22.18.0` 原生可擦除 TypeScript（零 npm 依赖、无 `node_modules/`）；多语言接入示例已整理进 [`docs/examples/body-starter-kits.md`](./docs/examples/body-starter-kits.md)，已搁置的旧 Mineflayer 原型已移出公开仓库。
* **默认洁净上下文**：情绪、内在生命、自由意志、主动心搏与招魂模块已改为**默认关闭的实验开关**（保留全部源码），避免长对话提示词互相打架；可在网页控制台按需开启，并在诊断面板查看发给大模型的真实 System Prompt。
* **纯文本真相源 + SQLite FTS5 加速**：仍以 `SEED.md` / `SOUL.md` / `MEMORIES/*.jsonl` 为唯一真相源；新增 Node 内置 `node:sqlite` FTS5 派生缓存（`.cache/memory-index.sqlite`），删掉缓存文件重启后可 100% 从纯文本无损重建。
* **双层记忆与事实冲突消解（`facts.jsonl`）**：支持标准 OpenAI `/v1/embeddings` 与通用/DashScope Rerank 接口，未填 API Key 时无缝回退离线 FTS5 检索；新增 `MEMORIES/facts.jsonl`（参考 Mem0 的 `ADD / UPDATE / DELETE / NONE` 状态机），搬家或改偏好时旧事实自动标为 `superseded`，同时保留 [`MemoryRetriever`](./docs/MEMORY-RETRIEVER-PROTOCOL.md) 外部 HTTP 记忆插座。
* **内置 30 轮长对话防幻觉评测（`npm run eval:llm`）**：在作者本机使用 `deepseek-chat` 跑通内置 30 轮剧本实测（11/11 检查项通过、0 内部标签泄漏、平均纯记忆检索耗时 14.83 ms；注：该数据仅代表本项目内置 30 轮场景单次实测，并非通用公开学术榜单成绩）。

---

## 已知局限与坦诚说明（请先看这段）

本项目**远非成熟产品**，目前仍有清晰边界：

* **暂无完整知识图谱，未跑公开学术榜单**：`v0.6.0` 已升级 FTS5 索引、`facts.jsonl` 事实覆写与可选向量/重排，但仍未构建多跳知识图谱，也尚未在 LoCoMo / LongMemEval 等公开学术长对话榜单上测评。
* **自动化测试与平台覆盖边界**：`node --test tests/*.test.ts` 验证离线逻辑、存储完整性、安全门禁与零隐私扫描（在 **Windows + Node `v26.13.0`** 下 90/90 全绿；最低声明版本 **Node `22.18.0`、Linux 与 macOS** 尚未在本机实测）。
* **实验模块默认关闭**：基于提示词的情绪、内驱力、自由意志、心搏与碎片招魂属于未经长期日常实测的早期实验代码，`v0.6.0` 默认全部关闭。
* **核心运行技术栈**：后端严格只用 **Node.js 原生可擦除 TypeScript（`>= 22.18.0`，零运行时依赖、无 `node_modules/`）** 加普通 HTML/CSS/JS 本地网页；Python 与 RimWorld C# 仅作为文档代码块保存在 [`docs/examples/body-starter-kits.md`](./docs/examples/body-starter-kits.md)。

---

## 本地当前能跑通的功能

* **纯文本本地存档**：首次启动时，把 `examples/demo-soul/` 的干净模板复制到被 `.gitignore` 忽略的 `private-souls/default-soul/` 目录（`SEED.md`、`SOUL.md`、`MEMORIES/*.jsonl`、`MEMORIES/facts.jsonl` 等）。
* **本机回环服务（`127.0.0.1:7777`）**：启用了本地令牌（`.soul-hub.token`）、`HttpOnly; SameSite=Strict` 会话 Cookie、CSP 及 Host/Origin 校验。
* **OpenAI 兼容代理**：把外部软件的 Base URL 指向 `http://127.0.0.1:7777/v1`（或 `/v1/bodies/<bodyType>/<id>`），即可在请求大模型时注入同一份本地文本记忆。
* **HTTP / WebSocket / SSE 与 MCP 接口**：支持 `/api/body/percept`、`/api/body/observe`、`/ws/body`、`/api/events`、`/mcp` 以及 `node src/server/mcp-stdio.ts`。
* **本地网页控制台（`EN` / `中文` 切换）**：提供双聊天测试框（`α` / `β`）、纯文本存档查看器、记忆/向量/实验开关配置、真实 Prompt 查看和自动体检按钮。
* **QQ OneBot v11 适配器**：位于 `adapters/qq-onebot/`（仅在本机 Mock 环境下通过离线单测，连接真实 NapCat/Lagrange 尚待实机验证）。

---

## 快速启动

仅需 **Node.js `>= 22.18.0`**（无需 `npm install`，无需外接数据库）。

```bash
# 启动本地服务与网页控制台（未配置大模型前默认处于离线 mock 演示模式）
node src/server/main.ts

# 或指定你自己的纯文本存档目录
SOUL_ARCHIVE_DIR=/path/to/my-soul node src/server/main.ts
```

* **Windows 用户**：也可以直接双击根目录的 [`start-soul-test.cmd`](./start-soul-test.cmd)。
* 浏览器访问 `http://127.0.0.1:7777`。
* 首次打开处于离线 `mock` 演示模式，不用填 API Key 就能查看文件和界面；如需接入真实大模型（Gemini、OpenAI 兼容接口或本地 Ollama），点顶部 **`V 开放插座` → 右侧 `ENGINE`** 填好保存即可。
* 详细操作步骤：[纯小白版使用说明书](./docs/BEGINNER-GUIDE.zh-CN.md) | [真实软件接入说明](./docs/CONNECT-YOUR-BODIES.md)

---

## 为什么发布 `v0.6.0` 与后续重点

`v0.6.0` 重点把记忆引擎做减法并补齐事实更新与 30 轮防幻觉自测。接下来计划推进 **SillyTavern 角色卡 V2 导入**、桌面宠物/QQ 等真实多躯体联调，以及 Linux/macOS 与 Node `22.18` 的兼容验证。

---

## 离线自检与开源协议

```bash
node --test tests/*.test.ts   # 离线单元测试、工程门禁、接口连通与零隐私扫描
```

[MIT License](./LICENSE)
