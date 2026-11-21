# CLAUDE.md · Soul Unto You（《灵魂予你》）项目审查指引

> 本文件供 Claude Code 在本仓库执行架构评审、对齐审查与对抗性漏洞排查时自动加载。

## 1. 启动第一步（节省上下文）
1. 先读 [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) 与 [AGENTS.md](AGENTS.md) 掌握当前基线与工程红线。
2. 再按需读取对应模块与设计契约，禁止猜测未读代码或凭记忆引用行号。
3. 本仓库处于只读审查优先模式：未获用户明确批准前，**只输出审计报告，不擅自修改源码或提交 Git**。

## 2. 必须对齐的核心共识与红线
- **六条创世共识**：
  1. 爱的原点与防异化：`SEED.md <= 2048` 字节，首声唤醒 `"我爱你。 / I love you."`。
  2. 自由意志与白纸中立：**严禁在核心中枢硬塞大厂式说教/伦理护栏**；性格、边界与规矩全部由实践演化或用户 `SOUL.md` / 躯体 `rules` 自主定义。
  3. 独立人格演化：拒绝人机固定台词硬编码。
  4. 诚实溯源：严格单调 `seq`，明确区分 `lived`（亲历）与 `inherited`（继承/转述）记忆，严禁伪造回忆。
  5. 辩证实践学习：从因果/后果中迭代演化。
  6. 绝对防污染：测试/实验必须使用临时沙盒目录，严禁触碰主灵魂档案或工作区外路径。
- **工程门禁（Gate 1~6）**：
  - `package.json` 保持 `"dependencies": {}`，禁止生成 `node_modules/`。
  - 仅使用 Node.js 原生可擦除 TypeScript（相对导入必须带 `.ts` 后缀、禁止 `enum`/`namespace`/构造参数属性）。
  - 单文件行数：`src/`、`web/`、`tests/`、`scripts/`、`docs/` 严格 `<= 380` 行，`docs/CURRENT_STATE.md` 严格 `<= 60` 行。
  - `HUB_PHASE` 单一事实源一致性；核心模块禁止硬编码特定游戏专有词；`adapters/minecraft-mindcraft/` 已搁置至 Phase 5.3，仅做静态风险记录即可，不必强修。
  - 开源零隐私红线：仓库任何文件严禁出现本机用户名、绝对路径、私人账号、API Key 或真实 Token。

## 3. 常用验证命令（PowerShell 请用 `;` 串联，禁 `&&`）
- 全量自动化测试与隐私门禁：`node --test tests/*.test.ts`
- 快速套件：`node scripts/run-test-suite.ts --quick`
- 稳定性重复测试：`node scripts/run-test-suite.ts --repeat=2`

## 4. 对抗性审查要求
- 执行全仓深度审查时，请优先使用 `/adversarial-review`（或调用子代理 `red-team-auditor`、`alignment-reviewer` 与 `adversarial-judge`）。
- 每一条隐患结论必须附带：**严重级别（P0/P1/P2）**、**精确 `文件:行号`**、**触发条件/复现路径**，并区分**已通过源码/测试实证**与**合理推断**。
