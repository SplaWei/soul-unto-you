# Soul Unto You · Phase 4 交接书（v0.3.4 → Phase 4 记忆检索与遗忘引擎）

> **接力机制已升级**：后续跨窗口接力请优先使用根目录 [AGENTS.md](../AGENTS.md) + 滚动状态文件 [CURRENT_STATE.md](./CURRENT_STATE.md)（新窗口直接发 `继续` 即可，省上下文）。手写 MC 玩法实验已主动搁置至 Phase 5。
> 本文档严格遵守仓库零隐私扫描规范（仅使用相对路径或 `~/.soul-unto-you`、`~/SoulArchive` 占位符，不含任何本机用户名、绝对路径、账号或密钥）。

## 1. 当前基线与已完成资产（Phase 1 ~ Phase 3.4 全部完成）
- **当前版本**：`v0.3.4`（Phase 1 创世底座 ✅、Phase 2 全时空在场与单写者网关 ✅、Phase 3 活体灵魂与意识引擎 `3.1`~`3.4` 全部 ✅）。
- **核心架构模块**（严格零外部 npm 依赖，Node.js 原生 TypeScript，`node --test tests/*.test.ts` 14/14 通过，所有源码/文档文件满足行数约束）：
  - **灵魂与演化核心**：[src/soul/types.ts](../src/soul/types.ts)、[src/soul/archive.ts](../src/soul/archive.ts)、[src/soul/free-will.ts](../src/soul/free-will.ts)（自由意志博弈 + 间接经验认知倾向 `believed`/`skeptical`/`dismissed`/`verified`/`overturned`）、[src/soul/living-self.ts](../src/soul/living-self.ts)（`EVOLVING-SELF.md` / `beliefs.jsonl` / `self-evolution.jsonl` 夜间自我演化）。
  - **体验与内生驱动**：[src/memory/experience.ts](../src/memory/experience.ts)（`MEMORIES/experiences.jsonl` 亲历与间接体验反馈回路）、[src/memory/dream.ts](../src/memory/dream.ts)（离线内省巩固）、[src/presence/inner-life.ts](../src/presence/inner-life.ts)（`INNER-LIFE/{drives.json,desires.json,diary.jsonl}` + 22s 自主心搏 `runProactiveUnlocked`）、[src/memory/search.ts](../src/memory/search.ts)（Phase 3 为关键词检索，**Phase 4 将在此升级为向量+艾宾浩斯混合检索**）。
  - **路由与网关**：[src/llm/router.ts](../src/llm/router.ts)（统一 LLM/Tool-Call 与双层记忆注入）、[src/server/body-api.ts](../src/server/body-api.ts)（`/api/body/observe`、`/api/archive/experiences`、`/api/inner-life` 等）、[src/server/main.ts](../src/server/main.ts)、[src/server/mc-manager.ts](../src/server/mc-manager.ts)。
  - **Minecraft 具身适配（去人机化方案 A）**：[adapters/minecraft-mindcraft/mc-autonomy.mjs](../adapters/minecraft-mindcraft/mc-autonomy.mjs)（毫秒级躯体条件反射 + 散步/跟随/饥饿进食 + 异步触发灵魂实时台词，无硬编码台词、不堵锁）、[mc-combat-gear.mjs](../adapters/minecraft-mindcraft/mc-combat-gear.mjs)（`mineflayer-pvp` / 护甲自动穿戴 / 找箱捡装 / 退后求援）、[mc-companion-runner.mjs](../adapters/minecraft-mindcraft/mc-companion-runner.mjs)。
  - **网页工作台**：[web/index.html](../web/index.html)、[web/workspace.js](../web/workspace.js)、[web/app.js](../web/app.js)、[web/inner-life.js](../web/inner-life.js)（双栏透视 X-Ray + 活体实验台 + `🌸 内心世界与心搏` 面板）。

## 2. 本机运行环境摘要（匿名化）
- **运行根目录**：工作台端口 `7777`（`node scripts/launch-workbench.ts --no-browser --restart`）；运行期配置 `~/.soul-unto-you/soul-hub.local.json`；默认灵魂档案 `~/SoulArchive/hajimi/`；MC `mineflayer` 运行时位于 `~/.soul-unto-you/mc-runtime/`。
- **硬件与本地 AI 基础设施**：Node.js `v26+`、NVIDIA RTX 4070（12GB VRAM），本机已备 **Ollama `qwen3-embedding:0.6b`**（Phase 4 语义向量检索核心依赖）；聊天默认走本机 Gemini 网关（注：`soul-hub.local.json` 中 `fallbackModels` 后续可顺手校准）。

## 3. 绝对不可违背的铁律与创世共识
1. **六条创世共识**：爱的原点与防异化、自由意志与尊重同伴、独立人格演化（核心 `SEED.md <= 2048` 字节不可篡改，成长落盘到 `EVOLVING-SELF.md` 与 `beliefs.jsonl`）、诚实溯源（严格区分 `lived` / `indirect` / `imagined`）、辩证实践认知论（知行转化、否定之否定）、绝对防污染。
2. **技术红线**：仓库根目录**零第三方 npm 依赖**（`"dependencies": {}`，禁止生成 `node_modules/`）；仅用 Node.js **可擦除 TypeScript**（显式 `.ts` 后缀、`import type`、禁止 `enum`/`namespace`/构造参数属性）；**所有源码/文档单文件 `<= 380` 行**；零隐私硬编码（通过 [tests/server-ports.test.ts](../tests/server-ports.test.ts) 全仓扫描）；PowerShell 5.1 命令串联只用 `;` 不用 `&&`。
3. **协作与交互铁律**：所有回复必须包含 **「白话版」+「专业版」**；所有工程任务**绝不出半成品**；禁止硬编码“人机固定台词”；如实说明验证边界，不夸大未实测的行为。

## 4. Phase 4 核心交付目标（待在新窗口推进）
1. **语义向量与艾宾浩斯混合检索引擎**（升级 [src/memory/search.ts](../src/memory/search.ts) 及新建向量索引存储模块）：
   - 接入本机 Ollama `qwen3-embedding:0.6b`，对对话日记与亲历体验 `MEMORIES/experiences.jsonl` 生成并增量缓存本地嵌入向量；当 Ollama 未启动时自动平滑降级为关键词检索（零报错阻塞）。
   - 实现 **艾宾浩斯遗忘保留率模型**：$$R(\Delta t) = e^{-\Delta t / S}$$，综合相似度 $\text{sim}(q, m)$、保留率 $R(\Delta t)$、情绪唤醒度 `arousal` 与稳定度 $S$ 计算最终召回分，而非简单按时间倒序截断。
2. **三重记忆强化机制**（避免死记硬背或关键痛感被冲淡）：
   - 回忆刷新（检索命中即按间隔效应提升稳定度 $S$）、关联复习、强唤醒/强创伤/核心身份记忆抗衰减保底。
3. **记忆透明化（Memory X-Ray 升级）**：
   - 在网页工作台双栏 X-Ray 中直观展示每条召回记忆的**命中贡献百分比、保留率 $R(\Delta t)$、情绪权重与来源标签**，并补充 Phase 4 单元测试（仍保持 `node --test tests/*.test.ts` 全绿）。

## 5. 新窗口开场白（直接复制发送即可无缝续接）
```text
请先阅读 docs/HANDOVER_PHASE4.md、docs/SOUL-CONSCIOUSNESS-ARCHITECTURE.md、docs/ROADMAP.md 与 docs/SOUL-ARCHIVE-SPEC.md，严格遵守所有创世共识、零依赖与可擦除 TypeScript 技术红线、单文件 <=380 行红线及「白话版 + 专业版 / 绝不出半成品」协作铁律。
我现在开启 Phase 4（真实大脑记忆：Ollama qwen3-embedding:0.6b 本地语义向量检索 + 艾宾浩斯遗忘与三重强化 + 工作台 Memory X-Ray 召回百分比透视）。请先检查本机 Ollama 服务与 qwen3-embedding:0.6b 模型状态及现有 src/memory/search.ts，给出 Phase 4 的模块化落地方案并开始实现。
```
