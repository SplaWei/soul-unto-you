# CURRENT_STATE · 滚动接力棒（随时可换新窗口）

> 最后更新：`v0.5.0` 双模型（Gemini × DeepSeek）交叉对抗终审与全部修复收口完成｜严格 `<= 60` 行、零隐私。

## 1. 当前阶段与基线
- **当前基线**：`v0.5.0` (`HUB_VERSION='0.5.0'` / `HUB_PHASE='5.5'` / `engines.node >= 22.18.0` / 零依赖) **全仓源码、EN/中文双语前端、纯净模板示范库与安全回归门禁已全部就绪**。
- **交叉对抗加固落地**：① 默认可写档案迁出仓库至 `private-souls/default-soul`（首启只读复制干净 `examples/demo-soul/`，已清零残留运行产物）；② Webhook SSRF 全量封堵私有/回环混淆/`::ffff:` 十六进制映射；③ SSE 按 `bodyId` 隔离 `observe`/`percept`/`experience`/`engraved`；④ `/api/embedding/sync` 移出 `SoulLock`；⑤ 静态白名单硬拦截、收窄 CSP `connect-src 'self'`、移除 QQ SSE query token、修稳切语言保留表单；⑥ 修复 Windows junction 测试跨平台 `ENOENT` 问题。

## 2. 环境与健康基线
- **自动化验证**（Node `v26.13.0`）：`node --test tests/*.test.ts` **全绿**（含工程门禁 1~6、Web i18n/CSP/白名单、SSRF/SSE 隔离回归与全仓零隐私扫描）；`node scripts/run-test-suite.ts --repeat=2` **2/2 轮全绿**；`eval-real-llm.ts --mock` **5/5**。
- **未覆盖边界**：真实联网大模型 API、真实 NapCat QQ 客户端及跨平台 Linux/macOS 实机联调待后续实测。

## 3. 关键避坑备忘
1. **白纸灵魂中立铁律**：严禁在核心引擎硬塞大厂式伦理/拒答说教；边界由用户 `SOUL.md`、躯体 `rules` 与实践演化决定。
2. **工程门禁**：单文件 `<= 380` 行（`CURRENT_STATE.md <= 60`）；零运行时依赖；仅用可擦除 TS（`.ts` 后缀、禁 `enum/namespace`）；PowerShell 5.1 用 `;` 串联。
3. **前端安全边界**：`web/` 新增文件须加入 [security.ts](../src/server/security.ts) `PUBLIC_STATIC_PATHS`（已硬拦截）并守严格 CSP（`connect-src 'self'`、零内联脚本/事件、纯 DOM 渲染）。
4. **隐私与 Git**：`examples/demo-soul/` 保持干净只读模板态；严禁读取或提交 `*.local.json` / `.soul-hub.token` / `private-souls/` / `~/SoulArchive/`。

## 4. 下一步精确任务（仅剩用户侧 Git 发版）
1. **洗白历史并推 GitHub `v0.5.0` 占坑**：用户在本机确认 `examples/demo-soul/` 干净后，使用 `git checkout --orphan` 从当前工作树重建单提交干净历史、核对 `git show HEAD:package.json`（`0.5.0`）与 `identity.json`（`liuyao-demo`）、打 `v0.5.0` 标签并推送 GitHub；`v0.5.0` 后再按 [ROADMAP.md](./ROADMAP.md) 推进 Phase 5.3 / 6 / 7。

## 5. 按需文档索引
- 实测接入：[CONNECT-YOUR-BODIES.md](./CONNECT-YOUR-BODIES.md)｜总路线图：[ROADMAP.md](./ROADMAP.md)｜外部终审归档：[EXTERNAL-AUDIT-v0.5.0.md](./audits/EXTERNAL-AUDIT-v0.5.0.md)
