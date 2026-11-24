# SoulUntoYou v0.6 → v0.7 执行指导与对抗审稿手册

> **适用仓库**：[SplaWei/soul-unto-you](https://github.com/SplaWei/soul-unto-you)（基线 `v0.5.0`，Node.js `>=22.18.0` 原生可擦除 TS，零依赖，无 `node_modules/`）  
> **最高优先级说明**：本文件是 `v0.6` 阶段主线指令，与 [AGENTS.md](../AGENTS.md) 配合生效；所有改动必须遵守单文件 `<= 380` 行、`CURRENT_STATE.md <= 60` 行、PowerShell 用 `;` 串联、六条创世共识与零隐私门禁。

## 一、给项目主人的三步防糊弄流程

1. **一次只派一个 Task**：开新窗口只发一句 `继续，按 docs/V06_EXECUTION_GUIDE.md 只执行 Task A1，做完停下交账，严禁越界做 A2`。
2. **只认结果不听故事**：要求执行 Agent 按「白话版 / 专业版」交付改动清单、完整原始终端输出和 3 步小白人工验收步骤，你亲手点一遍。
3. **红队对抗互审**：人工测通后，将改动摘要与 `git diff` 连同第五节的《红队审稿 Prompt》发给 DeepSeek-V4.1-Flash-1017 或 Claude；有 P0/P1 问题就贴回给执行 Agent 返工，通过后再进下一 Task。

## 二、Phase A（v0.6 当前唯一主线，严禁跳步）

### Task A1：仓库瘦身与清理边角语言（止血）
- **背景**：归档已搁置的 Minecraft 原型，隔离 `.py`/`.cs` 示例桩，清理主干死代码，让仓库聚焦于纯 TypeScript 后端与轻量 Web 前端。
- **具体要求**：
  1. 将 `adapters/minecraft-mindcraft/` 完整移出主干（归档至独立的 `archive/minecraft-mindcraft/` 或按主人确认移除），同步移除 `package.json` 中的 `check:mc` 脚本，检查并清理 `src/server/mc-manager.ts` 及主路由中的死引用（同步更新 `tests/` 中若存在的过期引用）。
  2. 将 `examples/body-kits/` 下的 `.py` 与 `.cs` 独立源码桩整理进 `docs/CONNECT-YOUR-BODIES.md` 或 `docs/examples/` 的 Markdown 代码块，避免 GitHub 语言条杂乱。
  3. **严禁**通过 `npm install` 生成 `node_modules/`；检查并强化 `tests/governance.test.ts` 的可擦除 TS、单文件 `<= 380` 行与零依赖校验，确保 `node --test tests/*.test.ts` 全绿。
- **主人人工验收**：运行 `start-soul-test.cmd` 打开 `127.0.0.1:7777`，正常对话 3 轮并查看纯文本档案无报错。

### Task A2：实验性“意识/情感”模块开关化（保留火种，净化默认上下文）
- **背景**：当前默认对话会同时注入情绪、内在驱力、自由意志、演化自我等实验段落，容易在长对话中引发 Prompt 冲突与幻觉。须**完整保留所有代码火种供未来迭代**，但在默认主链路关闭。
- **具体要求**：
  1. 在 `src/server/config.ts` 新增 `experimental` 开关对象，默认全部为 `false`：`enableEmotion`、`enableInnerLife`、`enableFreeWill`、`enableHeartbeat`、`enableResurrection`。
  2. 修改 `src/server/percept-pipeline.ts`、`src/memory/search.ts` 与 `src/server/main.ts`：开关为 `false` 时，不计算、不注入对应实验 Prompt 段落，不触发未启用的心搏；默认上下文仅保留核心人设（`SEED.md` + `SOUL.md`）+ 精准召回记忆 + 当前对话。
  3. 开关设为 `true` 时，原有 Phase 3/5.5 实验能力必须完整可用；在 Web 控制台设置页暴露对应开关，并在诊断面板新增“查看最近一次真实 System Prompt”只读视图（若新增 `web/` 文件须同步加入 `src/server/security.ts` 的 `PUBLIC_STATIC_PATHS`）。
- **主人人工验收**：默认状态对话 1 轮，在诊断面板确认发给大模型的 Prompt 干净无情绪/自由意志段落；勾选打开任一开关再聊 1 轮，确认对应段落恢复出现。

### Task A3：纯文本为源 + `node:sqlite` FTS5 派生索引（零依赖加速检索）
- **背景**：当前 `src/memory/search.ts` 线性扫描 `MEMORIES/*.jsonl`，万级记忆后延迟攀升。
- **具体要求**：
  1. 使用 Node.js 22 内置 `node:sqlite`（保持 `dependencies: {}` 零外部包），在灵魂档案目录下生成派生缓存 `.cache/memory-index.sqlite`（加入 `.gitignore`）。
  2. 建立 FTS5 全文检索索引（做好中文 bigram/分词辅助列），同步 `MEMORIES/*.jsonl` 的内容、单调 `seq`、说话人、`bodyType` 与状态字段。
  3. **铁律**：所有记忆写入必须先原子追加纯文本 `MEMORIES/*.jsonl`，再更新索引；启动时校验文本哈希/行数，若 `.cache/memory-index.sqlite` 被删除或损坏，必须静默、100% 从纯文本无损重建。
  4. 运行 `scripts/bench-jsonl-10k.ts` 对比改造前后 10,000 条记忆耗时（目标：FTS 检索 `< 50ms`；实测 FTS 检索 `~5.9ms`，含强化写盘的整轮 `buildRecallContext` `~63ms`）。
- **主人人工验收**：告诉 AI“我养了一只叫土豆的橘猫”→ 关服 → **亲手删掉 `.cache/memory-index.sqlite`** → 重启问“我的猫叫什么？”，确认自动重建索引并答对。

### Task A4：双层记忆引擎升级（云端/本地 Embedding+Rerank 与 Mem0 风格事实冲突消解）
- **背景**：仓库已有本地 Ollama `qwen3-embedding:0.6b` 向量存储与 `beliefs.jsonl`，本步补齐云端/通用 Rerank 重排及结构化事实冲突覆盖，同时保持外部记忆插座标准。
- **具体要求**：
  1. 升级 `src/memory/vector-store.ts` 与 `src/memory/search.ts`：兼容标准 OpenAI `/v1/embeddings` 与通用 Rerank HTTP 接口（支持本机 Ollama 及 DashScope/硅基流动的千问 `Qwen3-Embedding` / `Qwen3-Reranker`）；未配置 API Key 时无缝回退至 Task A3 的离线 FTS5 检索；设置严格 Top-K 与最低相关度阈值防噪音注入。
  2. 借鉴 [Mem0](https://github.com/mem0ai/mem0) 的 `ADD / UPDATE / DELETE / NONE` 状态机与 [Qwen Code Auto-Memory](https://github.com/QwenLM/qwen-code/blob/main/docs/design/auto-memory/memory-system.md) 轻量化思路，升级 `src/memory/dream.ts`：在纯文本 `MEMORIES/facts.jsonl` 维护带 `id`、`fact`、`valid_from`、`status`（`active`/`superseded`/`deleted`）与 `superseded_by` 的事实记录；新旧冲突时保留历史行并将旧事实标为 `superseded`，检索默认只召回 `active` 事实。
  3. 保持并文档化 `MemoryRetriever` HTTP 外部记忆插座协议，确保未来可一键外接 [Mem0](https://github.com/mem0ai/mem0) / [Graphiti](https://github.com/getzep/graphiti) 等独立引擎。
- **主人人工验收（搬家改口测试）**：先说“我住上海浦东，爱喝美式”→ 闲聊 5 轮 → 再说“我上周搬去成都高新区，改喝拿铁了”并触发做梦整理 → 新对话问“我现在住哪、喝什么？”，确认只答成都高新区+拿铁，且记事本打开 `facts.jsonl` 可见旧事实被标为 `superseded`。

### Task A5：真实 LLM 长对话防幻觉评测基准
- **具体要求**：升级 `scripts/eval-real-llm.ts`，内置 30 轮（可扩展至 100 轮）中文日常陪伴剧本，覆盖人设保持、事实冲突更新、20 轮前细节回忆、**未提过事项的诚实拒答防幻觉**、跨 `web`/`qq` 躯体共享记忆；跑完自动输出中文 Markdown 成绩单（命中率、冲突更新正确率、防幻觉拒答率、平均检索耗时与 Prompt Token 均值）。
- **主人人工验收**：填好真实模型 API Key 运行一条命令，5 分钟内拿到真实成绩单作为 `v0.6.0` 发布依据。

## 三、Phase B（v0.7 预告 — Phase A 全部验收通过前严禁开工）

1. **Task B1**：编写 [SillyTavern](https://github.com/sillytavern/SillyTavern) 角色卡 V2（PNG/JSON）转 `SOUL.md` 工具，实测 `/v1` 代理接入并出零报错教程。
2. **Task B2**：实测本机可跑的软件躯体联动——[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)（Live2D 语音桌宠）与 [AstrBot](https://github.com/astrbotdevs/astrbot) / NapCat QQ 共享同一本地灵魂（实体硬件如 ESP32 仅保留 MCP/WS 标准接口待社区共建）。
3. **Task B3**：补齐 Docker / 一键启动打包与“酒馆 + 桌宠 + QQ”一魂三躯 2 分钟实机演示视频。

## 四、给 DeepSeek-V4.1-Flash-1017 / Claude 的红队对抗审稿 Prompt

```text
你现在是极其严格、专门挑刺的红队架构师与安全审计员。我是不懂代码的项目主人，我的项目是 SoulUntoYou（Node.js >=22.18.0 原生可擦除 TypeScript，零 npm 依赖，严禁 node_modules，单文件 <=380 行，纯 UTF-8 文本为唯一真相源）。

刚才执行 Agent 声称完成了 [填入 Task 编号，如 Task A3]。下面附上它的改动说明、git diff 与终端日志。请逐项核查以下 7 条红线：
1. 【假实现/偷懒】有无写死返回值、空函数/TODO 敷衍、或只改注释没改主流程？
2. 【假测试】是否只测 Mock 刻意绕开核心逻辑，或把断言写弱？
3. 【破坏纯文本真相源】有无只写 SQLite/内存漏写纯文本？删掉 .cache/ 能否 100% 重建？
4. 【破坏门禁与安全】有无偷偷加依赖/生成 node_modules、单文件超 380 行、放宽 127.0.0.1/Token/CSP/PUBLIC_STATIC_PATHS 或破坏原子写入？
5. 【Prompt 污染与白纸原则】默认关闭实验开关时有无漏网情绪/驱力文本混入 Prompt？有无硬塞大厂式说教护栏？
6. 【异常处理吞错】有无空 try-catch 静默吞掉报错导致功能实际失效？
7. 【越界与死代码】有无擅改未授权模块或遗留死代码？

请用不懂代码的人能看懂的大白话按固定格式输出：
一、审查结论：【通过放行】或【打回返工】
二、问题清单（按 P0致命 / P1严重 / P2轻微 分级，注明 文件:行号 与“不管它会导致什么使用故障”）
三、直接复制给执行 Agent 的《返工指令》（精确到文件名、函数名和必改行为）
```
