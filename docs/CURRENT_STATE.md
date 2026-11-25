# CURRENT_STATE · 滚动接力棒（随时可换新窗口）

> 最后更新：`v0.6` `Task A1`~`Task A5` 及红队返工（文档/P0/P2）已全部完成并本地存档｜严格 `<= 60` 行、零隐私。

## 1. 当前阶段与基线
- **当前基线**：`v0.5.0`（`HUB_VERSION='0.5.0'` / `HUB_PHASE='5.5'` / `engines.node >= 22.18.0` / 零依赖）在本地依次完成 `AGENTS.md` 规则优化、P0 防污染加固与 P2 细节修复，**均仅做本地 commit，未 push**。
- **战略校准**：纯文本灵魂档案规范 + 多躯体协议中枢；严格 **先 Phase A（`v0.6`）→ 后 Phase B（`v0.7`）**。

## 2. 环境与健康基线
- **自动化验证**：`node --test tests/*.test.ts` **90/90 全绿**（在 `Node v26.13.0` 实测，**未在最低声明版本 Node 22.18 实测**，本机仅装 `v26.13.0`）。
- **P0 修复前后对照**：
  - LLM 响应漏写 `facts`：修前会回退离线正则误提取；修后只要 `validatedPlan !== null` 仅用 `validatedPlan.facts ?? []`，绝不回退正则。
  - 第三方/电影句与溯源：修前“男主搬去上海/我朋友爱喝可乐”会被正则入库；修后第一人称+叙事词守卫直接拦截，离线正则事实固定标 `inferred`。
  - 否定搬家句与删除顺序：修前“已经不住在上海了/不再住在上海”可能误删同批新建“成都”；修后先 DELETE 后 ADD/UPDATE 且不误删同批新建。
  - **两自然搬家句实测 `active facts`**：`我搬去成都了，已经不住在上海了` → 仅 `同行者住在成都`；`我搬去成都了，不再住在上海` → 仅 `同行者住在成都`（不复活上海）。
- **评测说明与未覆盖边界**：`A5-3`（[v06-eval-benchmark.test.ts](../tests/v06-eval-benchmark.test.ts)）为本地脚本化 HTTP 回归，100% 仅证明管线打通；真实大模型成绩只认 `npm run eval:llm` 输出（主人本机已实测 `deepseek-chat` 30 轮 11/11 全通，见 `.cache/eval-v06-report.md`）。Phase B 联调、Linux/macOS 及 Node 22.18 待实测。

## 3. 关键避坑备忘
1. **白纸灵魂与火种保留**：禁硬塞说教护栏；保留实验模块代码火种但 `v0.6` 默认全关（仅 `=== true` 开启）。
2. **工程门禁**：单文件 `<= 380` 行（本文件 `<= 60` 行）；零依赖禁 `node_modules/`；可擦除 TS（`.ts` 后缀、禁 `enum/namespace`）；PowerShell 用 `;` 串联。
3. **纯文本真相源与安全**：`SEED.md`/`SOUL.md`/`MEMORIES/*.jsonl`（含 `facts.jsonl`）为唯一真相源；`.cache/`（`memory-index.sqlite` 与评测报告）可随时删除；禁触碰 `private-souls/`、`~/SoulArchive/`、`*.local.json`。

## 4. 下一步精确任务（按 [V06_EXECUTION_GUIDE.md](./V06_EXECUTION_GUIDE.md) 推进）
1. **待主人终审放行 👉 `v0.6` Task A3~A5 返工已落盘**：确认无 P0/P1 后可发版 `v0.6.0` 并开启 Phase B (`Task B1` SillyTavern 角色卡 V2 导入与 `/v1` 联调)。

## 5. 按需文档索引
- 当前最高优先级指南：[V06_EXECUTION_GUIDE.md](./V06_EXECUTION_GUIDE.md)｜长期总路线：[ROADMAP.md](./ROADMAP.md)｜外部记忆插座：[MEMORY-RETRIEVER-PROTOCOL.md](./MEMORY-RETRIEVER-PROTOCOL.md)
