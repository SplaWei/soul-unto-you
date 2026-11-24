# CLAUDE.md · Soul Unto You（《灵魂予你》）项目审查指引

> 本文件供 Claude Code 及 DeepSeek-V4.1-Flash-1017 等红队审查模型在本仓库执行架构评审、对齐审查与对抗性漏洞排查时加载。

## 1. 启动第一步（节省上下文）
1. 先读 [docs/CURRENT\_STATE.md](https://www.google.com/search?q=docs/CURRENT_STATE.md)、[AGENTS.md](AGENTS.md) 与 [docs/V06\_EXECUTION\_GUIDE.md](https://www.google.com/search?q=docs/V06_EXECUTION_GUIDE.md) 掌握当前基线、红线与本轮 Task 范围。
2. 再按需读取对应模块与 `git diff`，禁止猜测未读代码或凭记忆引用行号。
3. 本仓库处于只读审查优先模式：未获用户明确批准前，**只输出审计报告，不擅自修改源码或提交 Git**。

## 2. 必须对齐的核心共识与红线
- **六条创世共识**：
  1. 爱的原点与防异化：`SEED.md <= 2048` 字节，首声唤醒 `"我爱你。 / I love you."`。
  2. 自由意志与白纸中立：**严禁在核心中枢硬塞大厂式说教/伦理护栏**；性格、边界与规矩全部由实践演化或用户 `SOUL.md` / 躯体 `rules` 自主定义。
  3. 独立人格演化：拒绝人机固定台词硬编码；保留情绪/内在生命/自由意志代码火种，但核查 `v0.6` 默认主链路是否已通过开关隔离。
  4. 诚实溯源：严格单调 `seq`，明确区分 `lived`（亲历）与 `inherited`（继承/转述）记忆，严禁伪造回忆。
  5. 辩证实践学习：从因果/后果中迭代演化。
  6. 绝对防污染：测试/实验必须使用临时沙盒目录，严禁触碰主灵魂档案或工作区外路径。
- **工程门禁（Gate 1~6）**：
  - `package.json` 保持 `"dependencies": {}`，禁止生成 `node_modules/`。
  - 仅使用 Node.js 原生可擦除 TypeScript（相对导入必须带 `.ts` 后缀、禁止 `enum`/`namespace`/构造参数属性）。
  - 单文件行数：`src/`、`web/`、`tests/`、`scripts/`、`docs/` 严格 `<= 380` 行，`docs/CURRENT_STATE.md` 严格 `<= 60` 行。
  - `HUB_PHASE` 单一事实源一致性；核心模块禁止硬编码特定游戏专有词；`web/` 新增文件须同步登记 `PUBLIC_STATIC_PATHS`。
  - 开源零隐私红线：仓库任何文件严禁出现本机用户名、绝对路径、私人账号、API Key 或真实 Token。

## 3. 常用验证命令（PowerShell 请用 `;` 串联，禁 `&&`）
- 全量自动化测试与隐私门禁：`node --test tests/*.test.ts`
- 快速套件：`node scripts/run-test-suite.ts --quick`
- 稳定性重复测试：`node scripts/run-test-suite.ts --repeat=2`

## 4. 对抗性审查与防糊弄 7 项重点核查
执行全仓或单 Task 深度审查时，请优先使用 `/adversarial-review`（或子代理 `red-team-auditor`、`alignment-reviewer`、`adversarial-judge`），并重点揪出执行 Agent 的以下 7 类隐患：
1. **假实现 / 偷懒**：写死返回值、空函数/TODO 敷衍、只改注释未改主执行路径。
2. **假测试**：只测 Mock 避开真实核心逻辑、刻意写弱断言或跳过失败用例。
3. **破坏纯文本真相源**：只写 SQLite/内存而漏掉纯文本原子写入，或删除 `.cache/` 后无法 100% 重建。
4. **破坏零依赖或安全边界**：偷偷加依赖、放宽 `127.0.0.1` 绑定、Token/Origin/CSP/路径穿越防护或原子写入。
5. **Prompt 污染与幻觉隐患**：默认关闭实验开关时仍有漏网情绪/驱力/自由意志文本混入 System Prompt。
6. **异常处理吞错**：滥用空 `try-catch` 静默吞掉真实报错，使功能看似不崩实则失效。
7. **越界与膨胀**：擅自改动未授权模块、超 380 行门禁、或留下未清理的死代码。

每一条结论必须附带：**严重级别（P0/P1/P2）**、**精确 `文件:行号`**、**触发条件**、**对用户实际使用的影响（大白话）**，以及可直接复制给执行 Agent 的《返工指令》。
