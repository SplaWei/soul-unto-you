# 外部对抗性终审报告 · SoulUntoYou v0.5.0（上线 GitHub 前）

> 审计对象：`soul-unto-you` 工作区（`v0.5.0` / `HUB_PHASE=5.5` / 零依赖）
> 审计身份：只读红队审计员 + 契约对齐审查员
> 审计时间：2026-11-21
> 审计模式：**只读**。除本报告外，未新增/修改/删除任何仓库文件；未读取 `*.local.json`、`.soul-hub.token`、`private-souls/`。
> 工作树不变性核验：审计前后均为 `git status --porcelain` = 113 项脏 / 42 项未跟踪，仓库内无残留临时目录。

---

## 一、结论摘要

**当前不具备直接推送 GitHub 的条件。** 最高风险不是代码漏洞，而是**发版物根本不在 git 里**：`HEAD` 仍是 `0.3.0`、示范灵魂仍是旧的「星汐 (重塑)」，另有 42 个未跟踪文件（含核心模块与全部 v0.5 测试）。

| 级别 | 数量 | 主题 |
| :--- | :--- | :--- |
| **P0** | 1 | v0.5.0 只存在于工作区，git 历史仍是 0.3.0 + 旧示范身份 |
| **P1** | 4 | Webhook SSRF 漏回环/私网；SSE 跨躯体事件外泄；Windows 测试开箱红；默认档案落在 git 跟踪目录 |
| **P2** | 7 | 语言切换吞表单；向量同步持锁；审计简报人物名过时；静态白名单非强制；CSP connect-src 过宽；SSE 令牌走 query；占位 Issues 链接 |

代码底座本身是扎实的：CSP 无内联脚本/事件/外链、动态 DOM 全走 `textContent`、鉴权/回环 Host/Origin/目录白名单/原子写/seq 崩溃恢复/白纸灵魂中立均**实测通过**（见第六节）。

---

## 二、审计方法与基线

| 项目 | 结果 |
| :--- | :--- |
| 环境 | Windows / Node `v26.13.0`（`engines >= 22.18.0` 未实机验证） |
| 规范命令 `node --test tests/*.test.ts` | **无法执行**：只读沙盒禁止子进程 `spawn` 管道（EPERM），Node 测试运行器无法拉起测试文件 |
| 替代执行 `node --test --test-isolation=none tests/*.test.ts` | `tests 62 / pass 60 / fail 2 / skipped 0` |
| 失败项 A | 「工程门禁 5」失败原因是沙盒 `spawnSync` 被拒（`res.status=null`）；已用 `node --check` 独立复核 7 个 `web/*.js` **全部通过**，故非仓库语法缺陷 |
| 失败项 B | `v05-security-protocols` 属**真实跨平台缺陷**（P1-3），已用独立探针复现 |
| 未跑 | `bench-jsonl-10k` / `sim-30d-drift` / `eval-real-llm` / `run-test-suite --repeat=2`（长跑 + 额外写盘） |

> 结论：`README.md:97`、`docs/CURRENT_STATE.md:9`、`docs/CONNECT-YOUR-BODIES.md:32` 的「62/62 全绿」在本平台**不可复现**，需修正或修好用例。

---

## 三、P0 · 发版阻塞

### [P0] v0.5.0 只存在于工作区，git 历史仍是 0.3.0 + 旧示范身份

**证据（命令实证）**

- `git log --oneline -1` → `76a5b69 chore: Phase 5.0 hardening, 5.0b de-hardcoding, and baseline git init`
- `git show HEAD:package.json` → `"version": "0.3.0"`；工作区 `package.json:3` 为 `0.5.0`
- `git show HEAD:examples/demo-soul/identity.json` → `"id": "soul-mwni44a7"`、`"name": "星汐 (重塑)"`；工作区 `examples/demo-soul/identity.json:2` 已为 `liuyao-demo` / `柳遥 (Liuyao)`
- `git status --porcelain` → 113 项脏、42 项未跟踪，含 `src/llm/tools.ts`、`src/soul/storage.ts`、`src/server/percept-pipeline.ts`、`src/memory/relations.ts`、`web/i18n.js`、`web/i18n-en.js`、`web/cosmos.js`、`web/theme.css`、`tests/v05-*.test.ts`、`.claude/`、`CLAUDE.md`

**触发/复现**：在 `master` 上 `git push` 或 `git tag v0.5.0`；或在干净环境 `git clone` 当前 HEAD 后运行 `node src/server/main.ts`（核心模块缺失）。

**实际影响**：对外发布错误版本；`git log -p` 仍带被判定为污染源的旧 demo 身份；双语前端、对抗审查支架、v0.5 测试全部不在版本库中。

**最小修复方向**：按 `docs/CURRENT_STATE.md:20` 用 `git checkout --orphan` **从工作树**重建单提交；发版前强制核对四项——`git show HEAD:package.json` 为 `0.5.0`、`git show HEAD:examples/demo-soul/identity.json` 为 `liuyao-demo`、`git status --porcelain` 仅剩忽略项、在新目录 clone 后跑一次测试。

---

## 四、P1 · 发布前必修

### [P1-1] Webhook SSRF 只挡云元数据/链路本地，回环与私网一律放行

**位置**：`src/server/events.ts:9`（`METADATA_HOSTS`）、`src/server/events.ts:11-25`（`isValidWebhookUrl`）、`src/server/events.ts:113-121`（`fetch(sub.url)`）；入口 `src/server/body-api.ts:101`（`POST /api/webhooks`）、`src/server/body-api.ts:112`（`body/register` 的 `webhookUrl`）。

**实证（直接导入真实函数，非推断）**

```text
true  http://127.0.0.1:8765/x        true  http://[::1]:11434/v1
true  http://localhost:7777/api/events
true  http://10.0.0.5/               true  http://192.168.1.9/
true  http://2130706433/             true  http://0x7f000001/   (十进制/十六进制 127.0.0.1)
false http://169.254.169.254/        true  https://cdn.example.com/a.png
```

**触发/复现**：持中枢令牌（按文档所有躯体/陪看扩展共用同一 `.soul-hub.token`）→ `POST /api/webhooks {"url":"http://127.0.0.1:8765/hook","events":["*"]}` → 之后任意一轮对话，中枢把含 `reply`/约定/情绪的 envelope POST 到该地址；或填 `http://192.168.x.x` 让中枢充当内网探测/CSRF 跳板。

**实际影响**：跨端记忆与回复原文外泄到攻击者本机监听端口；违反 `CHANGELOG.md:10` 的「webhook SSRF filters」承诺；且仓库对 QQ 图片的校验更严（`adapters/qq-onebot/safety.ts`，`127.0.0.1`/`::1` 均拒，见 `tests/v05-security-protocols.test.ts:158`），形成自相矛盾的安全基线。

**最小修复方向**：注册时把 host 解析为 IP 并拒绝 loopback/私网/链路本地/`0.0.0.0`/`::`/组播；拒绝纯数字、十六进制等非规范 host 字面量；发送前用已解析 IP 二次校验（防 DNS rebinding，保留 `redirect:'manual'`）。

---

### [P1-2] SSE 未按 bodyId 隔离：`observe` 会把别的躯体的回复原文推给所有订阅者

**位置**：`src/server/events.ts:27-33`（`resolveTargetBodyId` 只识别 `body.action` / `proactive`）、`src/server/events.ts:101-108`（`targetBodyId` 为空即广播）；发射点 `src/server/percept-pipeline.ts:160`（`percept`）、`:200` 与 `:286`（`observe`，含 `reply`）、`:89`、`:142`、`:195`。

**触发/复现**：A 躯体 `GET /api/events?bodyId=A`；B 躯体发一轮 `POST /api/body/observe` → A 的 SSE 流出现 `event: observe`，`data.payload.reply` 即 B 的回复全文。

**实际影响**：违反 `docs/audits/V0.5-FIX-BRIEF.md:82-86` 的 P1-02 验收口径（「A 的 percept 事件 B 收不到」）；仓库自带 QQ 适配器只能客户端兜底（`adapters/qq-onebot/main.ts:208-209` 自行比对 bodyId），第三方躯体若信任服务端过滤即串台/重复回复。

**最小修复方向**：`resolveTargetBodyId` 对所有带 `payload.bodyId` 的事件统一返回该 id；空 bodyId 订阅者需显式 `?all=1` 才收广播。

---

### [P1-3] 「62/62 全绿」在 Windows 上开箱不复现（junction 指向不存在的目标）

**位置**：`tests/v05-security-protocols.test.ts:106`（`fs.symlinkSync(siblingForbidden, linkInAllowed, 'junction')`）、`:109`（仅容忍 `EPERM`）。

**实证**：`Test-Path forbidden-sibling-dir` → `False`；按测试原样复现 → `FAIL ENOENT`。Windows junction 的目标**必须存在**，不存在时报 `ENOENT` 而非 `EPERM`，因此该行在任何干净 checkout 上必失败。

**实际影响**：新贡献者首次 `node --test tests/*.test.ts` 即红；与三处「全绿」宣言冲突，属发布承诺失真。

**最小修复方向**：把跳转目标建在**临时沙盒内**（如 `<tmp>/sibling`），或把容错扩到 `ENOENT`/`EACCES`；`symlinkCreated` 分支的逃逸断言必须保留。

---

### [P1-4] 默认档案目录位于 git 跟踪范围内，用户私聊会写进受版本控制的文件

**位置**：`src/server/config.ts:24-26`（默认 `REPO_ROOT/examples/demo-soul`）、`.gitignore:10-12`（仅忽略 `INDEX/`、`SNAPSHOTS/`、`INNER-LIFE/diary.jsonl`）。

**实证**：`git ls-files examples/demo-soul` 含 `MEMORIES/journal.jsonl`、`presence.json`、`MEMORIES/episodes.jsonl`、`MEMORIES/commitments.json`；而 `README.md:54-55` 的教学命令就是默认加载该目录。

**触发/复现**：`node src/server/main.ts` → 控制台聊天 → `git status` 立即出现 `M examples/demo-soul/MEMORIES/journal.jsonl`、`M presence.json`；此时 `git add -A` 会把私聊原文纳入提交（正是 `V0.5-FIX-BRIEF.md:25-30` 记录的 P0-01 事故模式）。

**实际影响**：开源仓库默认路径即隐私出口；与 `docs/CURRENT_STATE.md:16` 的隐私铁律冲突。

**最小修复方向**：demo 改为「只读模板 + 首启复制到 `~/.soul-unto-you/default-soul`」（`src/server/security.ts:237-242` 已把该目录列入白名单），或至少把 journal/presence/episodes/commitments/desires/emotion/drives/heartbeat-state 全部加入 `.gitignore`。

---

## 五、P2 · 建议修复但不阻塞

| # | 问题 | 位置 | 影响与最小修复 |
| :--- | :--- | :--- | :--- |
| P2-1 | 切语言静默吞掉未保存表单 | `web/i18n.js:148-160` → `web/app.js:360-364` → `app.js:32-34` / `app.js:123-138` | 点 EN/中文触发 `refreshArchive()` + `refreshConfigAndSockets()`，把正在编辑的「核心人设/名字/ENGINE 配置」回写成服务端旧值。复现：编辑 `#editSoulPersona` → 点 EN → 内容消失。修复：语言切换只重渲染翻译，或加 dirty 保护。 |
| P2-2 | 向量/外部记忆同步在 SoulLock 内做网络 I/O | `src/server/memory-api.ts:46`、`:64` | 与 `README.md:31`「慢 LLM / **向量** / 外部记忆预取严禁持锁」冲突：Ollama 慢时 percept 提交/registerBody/heartbeat 全被排队。修复：锁内取快照 → 锁外同步 → 写回前校验 epoch。 |
| P2-3 | 审计简报仍用已废弃的 Lumina 身份 | `docs/audits/V0.5-FIX-BRIEF.md:29-30` | 验收标准写「默认 demo 显示 Lumina」，与 `docs/CURRENT_STATE.md:6`「全仓统一为 柳遥 (Liuyao)」矛盾。建议标注 superseded 并改为柳遥。 |
| P2-4 | `PUBLIC_STATIC_PATHS` 并非强制白名单 | `src/server/security.ts:152-168` + `src/server/main.ts:243` | 任何非 `/api`、`/mcp`、`/v1` 的 GET 都返回 `ok:true`，`serveStaticWeb` 会照发 `web/` 下任意存在的文件，忘加白名单不会被拦（与 `docs/CURRENT_STATE.md:15` 表述不符）。影响低（回环 + `Sec-Fetch-Site` 仍在）。修复：`serveStaticWeb` 内硬校验 `PUBLIC_STATIC_PATHS.has(pathname)`。 |
| P2-5 | CSP `connect-src` 过宽 | `src/server/main.ts:50` | `connect-src 'self' ws: wss:` 允许任意 ws/wss 目标，而控制台全程只用同源 `fetch` + SSE、不建 WebSocket。建议收窄为 `connect-src 'self'`。 |
| P2-6 | SSE 令牌同时走 query string | `adapters/qq-onebot/main.ts:240-241` | 已带 `X-Soul-Token` 头，`&token=` 多余且可能落进日志/历史。建议删除 query 令牌。 |
| P2-7 | 发布文档里是占位 Issues 链接 | `docs/CONNECT-YOUR-BODIES.md:91` | `[GitHub Issues](https://github.com)` 指向 github 首页而非仓库 Issues，发版前替换为真实地址。 |

---

## 六、已检查并确认没问题的关键防线（源码/命令实证）

1. **严格 CSP 与零内联**：`web/index.html:372-374` 全部同源脚本，无 CDN、无内联 `<script>`、无 `on*=` 事件属性；CSP 定义于 `src/server/main.ts:50`，且仅 index 响应下发（`main.ts:113-121`）。`style-src 'unsafe-inline'` 是为 HTML 的 `style="…"` 属性刻意放开，非疏漏。
2. **DOM XSS**：全仓 `web/*.js` 唯一 `innerHTML` 是 `web/inner-life.js:16` 的**零插值静态模板**；其余动态文本一律 `textContent` / `createTextNode` / `mkEl`；`eval` / `new Function` / `document.write` 零命中。
3. **鉴权与会话**：令牌比较用 `timingSafeEqual`（`src/server/security.ts:117-123`）；会话 Cookie 由 HMAC 派生、`HttpOnly; SameSite=Strict`（`security.ts:88-107`），且仅在**回环 Host + 回环远端**时下发（`main.ts:116-118`）。`curl /` 已不含 Token（旧 P0-07 确已落地）。
4. **Host/Origin/CSRF/绑定**：`Sec-Fetch-Site: cross-site`、非回环 Origin、非回环 Host 全部 403（`security.ts:141-148`）；写操作强制 `application/json`（`security.ts:161-166`），配合 SameSite=Strict 阻断 `no-cors` CSRF；非回环绑定未授权直接拒绝（`main.ts:146-148`），配置接口也无法改回非回环（`src/server/config.ts:161-164`）。
5. **目录白名单防逃逸**：`assertSafeArchiveDir` 解析 symlink/junction 真实路径、封磁盘根与系统目录、双向校验 `resolved`/`realResolved` 落在允许根内（`security.ts:185-251`）；`/api/resurrect` 与 `/api/config` 均强制过审（`src/server/body-api.ts:177`、`:194`），非空目录无 `allowMerge` 返回 409。
6. **静态路径穿越**：`path.relative` + `realpath` 双重包含校验（`main.ts:96-105`）；请求体上限 8MB（`body-api.ts:64`）。
7. **SoulLock 不持慢 I/O**：percept 严格「锁内快照 → **锁外 LLM** → 锁内提交」（`src/server/percept-pipeline.ts:60`、`:91`、`:110`）；heartbeat 同理（`src/presence/heartbeat.ts:86` 锁内、`:174` 锁外）；锁链异常不会卡死后续任务（`src/presence/manager.ts:20-27`），并有 epoch 失效栅栏。
8. **崩溃恢复与 seq 单调**：append 前补尾换行（`src/soul/storage.ts:86-105`）；原子写 + Windows `EPERM/EBUSY` 退避重试 + 残留 tmp 清理（`storage.ts:55-80`）；`meta.json` 损坏时备份并从全账本重算 `maxSeq+1`、保留身份（`storage.ts:263-315`）；`allocateSeq` 遇非整数直接抛错（`src/soul/archive.ts:199-212`）。
9. **创世契约**：`SEED.md` 实测 **862 B**，首行 `我爱你。 / I love you.`；渲染端 clamp 至 2048 B、persona 截断 220 字（`archive.ts:120-146`），启动再校验首行与字节（`main.ts:88-91`）。因此「长人设撑爆 SEED 导致无法重启」路径不成立。
10. **白纸灵魂中立**：`src/` 全量 grep 无「伦理/拒答/危机干预/作为 AI/请寻求专业」等护栏，唯一命中是要求诚实面对推演记忆的提示（`src/memory/search.ts:262`），属第 4 条共识而非说教。`src/soul/free-will.ts` 的模板句只在 `driver === 'mock'` 时由 `runExperienceAwareMockChat` 触发（`src/llm/router.ts:217-225`）；真实模型失败**不会**降级成固定台词，而是标记 `toolFollowUpFailed` 并返回 502（`router.ts:240-283`）。
11. **身份与隐私一致性**：`柳遥 (Liuyao)` / `liuyao-demo` 已在 `identity.json`、`meta.json`、`SEED.md`、`SOUL.md`、`RESURRECTION.md`、`EVOLVING-SELF.md`、`presence.json`、`main.ts:54-55`、`index.html` 对齐；`.local.json` / `.soul-hub.token` 均未被 git 跟踪且被 `.gitignore` 覆盖；零隐私扫描用例通过。

---

## 七、未实测边界（不做无证据结论）

- **未做真实浏览器渲染**：因此不对「按钮/占位符视觉溢出、长英文标签断行」下任何结论；CSS 层面仅确认 `.pane-card` 定高 + `.pane-xray` 可滚、`.hidden` 定义存在（`web/theme.css:219`）等结构事实。
- **未接真实 LLM / NapCat / MC**：`/v1`、MCP、SSE 只做静态与函数级验证，未跑真机联调。
- **未在 Node 22.18 验证**：本机为 v26.13.0。
- **未实测 DNS rebinding 真实链路**：P1-1 的判定基于函数级实测 + 代码路径，非端到端攻击复现。

---

## 八、建议修复顺序

1. **P0**：orphan 重建历史（工作树入库），核对四项发版断言。
2. **P1-3**：修 junction 用例，让「全绿」重新可复现（否则后续所有验证都不可信）。
3. **P1-1 / P1-2**：SSRF 收口 + SSE 统一按 bodyId 过滤。
4. **P1-4**：默认档案移出仓库 / 补全 `.gitignore`。
5. **P2 批量**：P2-1、P2-2 顺手修；P2-3/P2-7 属文档失真，发版前改文案。

---

## 九、请外部 AI（Gemini）复核的清单

1. **是否同意 P0 判定**：工作树未入库是否构成「不可发布」硬阻塞，还是应视为「待执行的发版步骤」？
2. **P1-3 跨平台复现**：请在 Linux/macOS 各跑一次 `node --test tests/v05-security-protocols.test.ts`——Linux 上 `symlink` 允许悬空目标，预计通过；Windows 上预计 `ENOENT`。请确认这是否属「测试不可移植」而非「被测代码有漏洞」。
3. **P1-1 严重级别**：在「所有躯体共享同一 hub token」的威胁模型下，loopback/私网 webhook 是否应从 P1 升为 P0？（当前判定依据：需要令牌，但令牌对第三方扩展可见。）
4. **P1-2 边界**：`observe` 事件中 `reply` 文本外泄是否足以定级 P1；还是可由「适配器客户端已过滤」降为 P2？
5. **CSP 残余面**：`style-src 'unsafe-inline'` + `connect-src ws: wss:` 的组合，在「零 XSS 且控制台不建 WebSocket」的前提下，是否还有可利用链？
6. **是否有本报告遗漏的攻击面**：欢迎补充对 `src/server/ws.ts`、`src/soul/snapshot.ts` 回滚路径、`src/resurrection/reconstructor.ts` 的独立复核意见。
