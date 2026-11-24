# SoulUntoYou《灵魂予你》（`v0.5.0` 早期个人原型）

> [English](./README.md) | **简体中文** | [纯小白使用说明书 (中文)](./docs/BEGINNER-GUIDE.zh-CN.md) | [Beginner's Guide (EN)](./docs/BEGINNER-GUIDE.md)

这是一个**非程序员借助 AI 辅助开发的早期个人原型**。

它实际做的事情很简单：把 AI 伴侣的人设、聊天记录、摘要和备忘录存成**本地纯 UTF-8 文本文件（Markdown + JSONL + JSON）**，并在本机跑一个仅限本地访问的转发服务（提供 OpenAI 兼容接口 `/v1`、简单 HTTP/WebSocket/SSE 接口以及 MCP 接口），让不同的聊天软件或工具都能读写同一份本地文本目录。

做这个实验的朴素出发点：软件会停服、数据库会损坏，而纯文本文件随时都能用记事本打开、像普通文档一样备份，放很多年也依然能读。

---

## 已知局限与坦诚说明（请先看这段）

本项目**远非成熟产品**，目前存在几个非常明确的短板：

* **记忆检索目前很基础**：内置检索现在的真实实现是“线性扫描 JSONL 文件 + 简单中英文关键词匹配 + 可选单向量余弦相似度 + 简单时间衰减权重”。它**没有知识图谱，没有新旧事实自动冲突消解/更新机制**（新偏好不会自动覆盖旧偏好），也**没有在任何公开长对话记忆评测集上跑过真实评分**。
* **现有测试仅代表离线代码逻辑自检**：`node --test tests/*.test.ts` 验证的是文件读写、接口路由、安全拦截和 Mock 假数据流程，**不能证明在真实大模型数百轮连续对话下的记忆准确度**。
* **部分功能仍是未经验证的早期实验**：基于提示词的情绪状态、内驱力、定时心搏、碎片重建等功能都属于早期试验代码，尚未经过长期日常实测。
* **为什么仓库里看起来编程语言很杂**：
  * 真正负责运行的核心服务端只有 **Node.js 原生 TypeScript（`>= 22.18.0`，零第三方依赖）** 加一个普通 HTML/CSS/JS 本地网页。
  * Python 与 RimWorld C# 接入示例已整理进 [`docs/examples/body-starter-kits.md`](./docs/examples/body-starter-kits.md) 的 Markdown 代码块，已搁置的旧 Mineflayer 原型已归档至 `archive/minecraft-mindcraft/`——**运行本项目并不需要这些文件**。
  * 坦诚反思：对于 AI 与记忆实验，**用 Python 往往会更简单、也更好维护**，比维护 80 个 TS 文件轻便得多。当初选 Node.js 原生 TS 只是为了省掉安装依赖；后续也在考虑先做减法瘦身，或改为更精简的 Python 核心。

---

## 本地当前能跑通的功能

* **纯文本本地存档**：首次启动时，把 `examples/demo-soul/` 的干净模板复制到被 `.gitignore` 忽略的 `private-souls/default-soul/` 目录（`SEED.md`、`SOUL.md`、`MEMORIES/*.jsonl` 等）。
* **本机回环服务（`127.0.0.1:7777`）**：启用了本地令牌（`.soul-hub.token`）、`HttpOnly; SameSite=Strict` 会话 Cookie、CSP 及 Host/Origin 校验。
* **OpenAI 兼容代理**：把外部软件的 Base URL 指向 `http://127.0.0.1:7777/v1`（或 `/v1/bodies/<bodyType>/<id>`），即可在请求大模型时注入同一份本地文本记忆。
* **HTTP / WebSocket / SSE 与 MCP 接口**：支持 `/api/body/percept`、`/api/body/observe`、`/ws/body`、`/api/events`、`/mcp` 以及 `node src/server/mcp-stdio.ts`。
* **本地网页控制台（`EN` / `中文` 切换）**：提供双聊天测试框（`α` / `β`）、纯文本存档查看器、模型配置和基础自检界面。
* **外部记忆接口预留**：通过 `MemoryRetriever` 接口，允许日后把内置基础检索替换成外部 HTTP 记忆服务。
* **QQ OneBot v11 适配器**：位于 `adapters/qq-onebot/`（仅在本机 Mock 环境下通过了离线单测，连接真实 NapCat/Lagrange 尚待实机验证）。

---

## 快速启动

仅需 **Node.js `>= 22.18.0`**（无需 `npm install`，无需数据库）。

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

## 为什么发布 `v0.5.0` 与后续重点

`v0.5.0` 是一个用来验证纯文本存档思路、接受真实反馈的**早期公开快照**，不是成熟软件。

接下来最重要的事是**做减法和真实场景测试**（用真实大模型做长对话实测、改进或替换目前较粗糙的记忆检索），而不是继续堆叠更多花哨概念。

---

## 离线自检与开源协议

```bash
node --test tests/*.test.ts   # 离线单元测试、接口连通与隐私扫描（不代表真实大模型记忆评测成绩）
```

[MIT License](./LICENSE)
