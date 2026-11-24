# CURRENT_STATE · 滚动接力棒（随时可换新窗口）

> 最后更新：`v0.6` `Task A1`~`Task A5` 已全部开发并本地存档，待主人用真实模型 Key 实测成绩单验收后进入 Phase B（`v0.7`）｜严格 `<= 60` 行、零隐私。

## 1. 当前阶段与基线
- **当前基线**：`v0.5.0`（`HUB_VERSION='0.5.0'` / `HUB_PHASE='5.5'` / `engines.node >= 22.18.0` / 零依赖）已完成干净历史推送至 GitHub（分支 `master`，标签 `v0.5.0`），示范人格 `柳遥 (Liuyao)`，Web 控制台支持 `EN / 中文` 实时切换。
- **战略校准（已由主人拍板）**：确立“纯文本灵魂档案规范 + 多躯体协议中枢”定位；严格按 **先 Phase A（`v0.6` 内核瘦身 + 记忆升级 + 真机评测）→ 后 Phase B（`v0.7` 头部躯体生态联调）** 串行推进。

## 2. 环境与健康基线
- **自动化验证**：`node --test tests/*.test.ts` **85/85 全绿**（含工程门禁 1~6、Task A2 实验开关隔离、Task A3 `node:sqlite` FTS5 索引/万级基线、Task A4 双层记忆与 `facts.jsonl` 冲突消解、Task A5 30~100 轮陪伴评测脚本/打分器/API Token 实测与检索计时校验、零隐私扫描）。
- **Task A5 新增评测能力与缓存**：
  - 升级 [scripts/eval-real-llm.ts](../scripts/eval-real-llm.ts)（拆分 `eval-scenario.ts`/`eval-report.ts`/`eval-legacy.ts`，单文件均 `<= 380` 行）并新增 `npm run eval:llm`，支持 30~100 轮中文日常陪伴剧本、5 维打分与中文 Markdown 成绩单。
  - 默认把最新成绩单落盘至 `.cache/eval-v06-report.md`（本地缓存，已在 `.gitignore` 忽略）；全链路打通真实检索耗时 (`recallTrace.retrievalMs`) 与 API 实测 `promptTokens`。
- **未覆盖边界**：待主人填入真实大模型 Key 执行 `npm run eval:llm` 获取真实成绩单作为 `v0.6.0` 发布依据；SillyTavern/Open-LLM-VTuber/AstrBot/NapCat 真实联调及 Linux/macOS 跨平台实测待 Phase B 逐项验证。

## 3. 关键避坑备忘
1. **白纸灵魂与火种保留**：严禁硬塞大厂说教护栏；保留情绪/内在生命/自由意志/演化代码火种，但 `v0.6` 默认全关且底层 API 均为 fail-closed（仅 `=== true` 开启）。
2. **工程门禁**：单文件 `<= 380` 行（本文件 `<= 60` 行）；零运行时依赖且禁生成 `node_modules/`；仅用可擦除 TS（`.ts` 后缀、禁 `enum/namespace`）；PowerShell 5.1 用 `;` 串联；严格一任务一本地 commit。
3. **纯文本真相源与安全**：`SEED.md`/`SOUL.md`/`MEMORIES/*.jsonl`（含 `facts.jsonl`）为唯一真相源；`.cache/`（含 `memory-index.sqlite` 与 `eval-v06-report.md`）可随时删除重建；`web/` 新增静态文件须登记 `src/server/security.ts` 的 `PUBLIC_STATIC_PATHS`。
4. **档案隔离**：严禁触碰 `private-souls/`、`~/SoulArchive/`、`*.local.json`、`.soul-hub.token`；测试与评测仅用临时沙盒。

## 4. 下一步精确任务（严格按 [V06_EXECUTION_GUIDE.md](./V06_EXECUTION_GUIDE.md) 逐项串行）
1. **已完成待实测验收 👉 `Task A5`**：主人用自己的真实模型 Key 跑一遍 `npm run eval:llm`（可扩展 `--turns=100`），核验 `.cache/eval-v06-report.md` 成绩单并决定 `v0.6.0` 发布。
2. **Phase B（`v0.7` 预留，Phase A 全部验收通过后启动）**：`Task B1` SillyTavern 角色卡 V2 导入与 `/v1` 联调 → `Task B2` Open-LLM-VTuber / AstrBot 多端实测 → `Task B3` 一键启动分发与实机演示。

## 5. 按需文档索引
- 当前最高优先级指南：[V06_EXECUTION_GUIDE.md](./V06_EXECUTION_GUIDE.md)｜长期总路线：[ROADMAP.md](./ROADMAP.md)｜外部记忆插座：[MEMORY-RETRIEVER-PROTOCOL.md](./MEMORY-RETRIEVER-PROTOCOL.md)
