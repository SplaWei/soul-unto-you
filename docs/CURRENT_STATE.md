# CURRENT_STATE · 滚动接力棒（随时可换新窗口）

> 最后更新：`v0.6` `Task A1` + `Task A2` 已完成并本地存档，待主人验收与红队互审后进入 `Task A3`｜严格 `<= 60` 行、零隐私。

## 1. 当前阶段与基线
- **当前基线**：`v0.5.0`（`HUB_VERSION='0.5.0'` / `HUB_PHASE='5.5'` / `engines.node >= 22.18.0` / 零依赖）已完成单提交干净历史推送至 GitHub（分支 `master`，标签 `v0.5.0`），示范人格 `柳遥 (Liuyao)`，Web 控制台支持 `EN / 中文` 实时切换。
- **战略校准（已由主人拍板）**：放弃继续堆砌外围实验，确立“纯文本灵魂档案规范 + 多躯体协议中枢”定位；严格按 **先 Phase A（`v0.6` 内核瘦身 + 记忆升级 + 真机评测）→ 后 Phase B（`v0.7` 头部躯体生态联调）** 串行推进。

## 2. 环境与健康基线
- **自动化验证**：`node --test tests/*.test.ts` **65/65 全绿**（含工程门禁 1~6、Task A2 实验开关与 Prompt 诊断、Web i18n/CSP/白名单、Webhook SSRF/SSE 隔离、零隐私扫描）。
- **未覆盖边界**：真实联网 LLM 长对话防幻觉实测、SillyTavern/Open-LLM-VTuber/AstrBot/NapCat 真实联调及 Linux/macOS 跨平台实测待后续逐项验证。

## 3. 关键避坑备忘
1. **白纸灵魂与火种保留**：严禁硬塞大厂说教护栏；保留情绪/内在生命/自由意志/演化代码火种，但 `v0.6` 须收敛至默认关闭的实验开关后。
2. **工程门禁**：单文件 `<= 380` 行（本文件 `<= 60` 行）；零运行时依赖且禁生成 `node_modules/`；仅用可擦除 TS（`.ts` 后缀、禁 `enum/namespace`）；PowerShell 5.1 用 `;` 串联。
3. **纯文本真相源与安全**：`SEED.md`/`SOUL.md`/`MEMORIES/*.jsonl` 为唯一真相源，任何 SQLite 索引须可删库重建；`web/` 新增静态文件须登记 \[suspicious link removed\] `PUBLIC_STATIC_PATHS`。
4. **档案隔离**：严禁触碰 `private-souls/`、`~/SoulArchive/`、`*.local.json`、`.soul-hub.token`；测试仅用临时沙盒。

## 4. 下一步精确任务（严格按 [V06\_EXECUTION\_GUIDE.md](https://www.google.com/search?q=./V06_EXECUTION_GUIDE.md) 逐项串行）
1. **已完成待验收 👉 `Task A1` & `Task A2`（瘦身清理 + 实验开关化）**：已归档 MC 旧原型与 `.py`/`.cs` 桩；[config.ts](../src/server/config.ts) 新增默认全关 `experimental` 5 开关，默认 Prompt 仅保留人设/记忆/对话；Web 设置页暴露开关，诊断面板支持只读查看最近一次真实 System Prompt。
2. **下一步 👉 完成 `Task A2` 人工验收与红队互审后，启动 `Task A3`**：`Task A3`（`node:sqlite` FTS5 可重建派生索引）→ `Task A4`（云端/本地 Embedding+Rerank 与 Mem0 风格 `facts.jsonl` 冲突消解）→ `Task A5`（30 轮真实 LLM 防幻觉评测基准）。
3. **Phase B（`v0.7` 预留，Phase A 全通过后启动）**：SillyTavern 角色卡 V2 导入与 `/v1` 联调 → Open-LLM-VTuber / AstrBot 多端实测 → 一键启动分发与实机演示。

## 5. 按需文档索引
- 当前最高优先级指南：[V06\_EXECUTION\_GUIDE.md](https://www.google.com/search?q=./V06_EXECUTION_GUIDE.md)｜长期总路线：[ROADMAP.md](https://www.google.com/search?q=./ROADMAP.md)｜实测接入：[CONNECT-YOUR-BODIES.md](https://www.google.com/search?q=./CONNECT-YOUR-BODIES.md)
