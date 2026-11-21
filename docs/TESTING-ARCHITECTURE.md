# 《灵魂予你》全局测试方法论与稳定交叉验证架构

> 核心目标：以**零第三方依赖 + 沙盒完全隔离 + 多方法交叉验证**为原则，保障后续 Phase 5–8 每项新功能都稳健落地，绝不污染主灵魂档案 `~/SoulArchive/`。

---

## 一、五层全局测试金字塔

| 层级 | 模块 / 入口 | 验证焦点 | 确定性 |
| :--- | :--- | :--- | :--- |
| **L1 工程门禁** | `tests/governance.test.ts` | 零依赖、全仓单文件 `<=380` 行、原生可擦除 TS、跨模块 `phase` 同步、前端静态资源与 JS `--check`、零隐私扫描 | 100% 确定性 |
| **L2 单元测试** | `tests/archive.test.ts`、`memory-dream.test.ts`、`resurrection.test.ts`、`phase3-*.test.ts`、`phase4-*.test.ts` | 单模块逻辑、遗忘公式 $R(\Delta t)=e^{-\Delta t/S}$、自由意志、演化年轮、沙盒隔离 | 100% 确定性 |
| **L3 协议端到端** | `tests/server-ports.test.ts`、`qq-onebot.test.ts` | Body HTTP、WebSocket `/ws/body`、OpenAI Proxy（含流式 SSE）、MCP、OneBot 防风控 | 100% 确定性 |
| **L4 四向交叉验证** | `tests/cross-verify.test.ts` | 四协议互通互查、冷重启永生一致性、503 故障注入与热恢复、并发 `SoulLock` 因果序与磁盘原档对账 | 100% 确定性 |
| **L5 实机只读探测** | `node scripts/run-test-suite.ts --live` | 在确认 L1–L4 全绿后，只读探测本机 Ollama `qwen3-embedding:0.6b`、工作台、GPT-SoVITS、OneBot（未启动自动 `SKIP`） | 依赖本机服务 |

---

## 二、每开发一项新功能的「六步交叉验证法」

每当你或协作模型完成一个新特性（如 Phase 5 原生 Function Calling、接入外部 MC/环世界躯体），必须通过以下 6 个正交角度交叉验证：

1. **正向核心闭环（Happy Path）**：验证功能主路径在真实或 Mock LLM 下产出正确动作、记忆与回复。
2. **边界与负面异常输入（Boundary & Negative）**：空输入、超长字节（如 `SEED.md <= 2048B`）、纯视觉噪声、非法参数均能安全拒绝或过滤，绝不崩溃。
3. **故障注入与静默降级热恢复（Fault Injection & Recovery）**：用 `mockAi.setFailMode({ embed: true })` 模拟依赖断开，确认服务自动静默降级；恢复 `false` 后无需重启即可热恢复。
4. **磁盘纯文本原档独立对账（Disk Plain-Text Reconciliation）**：调用 `assertCrossVerifiedArchive(dir)` 绕过内存缓存直接读取磁盘 JSONL/MD，验证严格单调 `seq`、`meta.nextSeq > maxSeq` 与 `episodes.md` 同步一致。
5. **冷重启永生回放（Cold-Restart Persistence）**：通过 `restartHub()` 销毁原中枢实例并在同沙盒目录重启新中枢，验证所有状态、向量索引与配置完整恢复。
6. **跨协议交叉印证 + 重复稳定性压测**：在一端写入记忆，从另一协议（如 HTTP 写入 → WS / OpenAI / MCP 召回）验证同源互通；最后以 `--repeat=3` 连续跑三轮确认零偶发抖动。

---

## 三、标准新特性测试模板（直接复用 `tests/helpers/sandbox.ts`）

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCrossVerifiedArchive, withMockAiServer, withTestHub } from './helpers/sandbox.ts';

test('新特性 X：正向闭环 + 故障降级 + 冷重启 + 磁盘对账', async () => {
  const ai = await withMockAiServer();
  try {
    await withTestHub({ prefix: 'soul-feat-', llmBaseUrl: ai.baseUrl, embeddingBaseUrl: ai.baseUrl }, async ({ hub, dir, restartHub }) => {
      // 1. 通过 HTTP/WS 触发核心功能
      // 2. 注入故障 ai.setFailMode({ embed: true }) 验证静默降级，再恢复
      // 3. const hub2 = await restartHub(); 验证跨进程持久化
      // 4. 独立磁盘原档交叉对账
      assertCrossVerifiedArchive(dir);
    });
  } finally {
    await ai.close();
  }
});
```

---

## 四、一键测试命令速查表

- **Windows 双击一键全局体检**：直接双击根目录 `run-tests.cmd`
- **全量五维测试（L1–L4 全跑）**：`npm run test:all` 或 `node scripts/run-test-suite.ts --all`
- **日常极速冒烟（门禁 + 四向交叉验证）**：`npm run test:quick` 或 `node scripts/run-test-suite.ts --quick`
- **单特性定向 + 自动关联交叉验证**：`node scripts/run-test-suite.ts --feature=phase4`
- **零抖动连续复跑 3 轮**：`npm run test:stable` 或 `node scripts/run-test-suite.ts --repeat=3`
- **附带本机实机服务只读探测**：`npm run test:live` 或 `node scripts/run-test-suite.ts --live`
- **原生态 Node 测试（等同 CI）**：`npm test`（`node --test tests/*.test.ts`）
- **网页端一键体检**：打开工作台「🚀 一键联调台」点击 **「🧪 一键跑全套自动体检」**（已升级自动扫描全量 `tests/*.test.ts`）
