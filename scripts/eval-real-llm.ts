import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LlmEndpointConfig } from '../src/llm/router.ts';
import { listFacts } from '../src/memory/search.ts';
import { defaultConfigPath, loadHubConfig, REPO_ROOT } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { initSoulArchive, readJsonlSafe, resolveArchivePaths, writeTextAtomic } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import type { JournalEntry } from '../src/soul/types.ts';
import { resolveEvalEndpoint, runObjectiveEvaluation, type EvalCaseReport, type EvalEndpointOptions, type EvalSummaryReport } from './eval-legacy.ts';
import {
  formatCompanionMarkdownReport, summarizeCompanionReport,
  type CompanionEvalReport, type CompanionTurnResult, type FactsDiskAudit,
} from './eval-report.ts';
import {
  buildCompanionScenario, EVAL_COMPANION_IDENTITY, evaluateTurnReply,
  type EvalDimension, type EvalTurnSpec,
} from './eval-scenario.ts';

export {
  buildCompanionScenario, evaluateTurnReply, formatCompanionMarkdownReport,
  resolveEvalEndpoint, runObjectiveEvaluation,
  type CompanionEvalReport, type EvalCaseReport, type EvalDimension, type EvalSummaryReport, type EvalTurnSpec,
};

export interface CompanionBenchmarkOptions extends EvalEndpointOptions {
  turns?: number;
  useEmbedding?: boolean;
  delayMs?: number;
  outPath?: string;
  onProgress?: (info: { turn: number; total: number; bodyType: string; latencyMs: number; retrievalMs: number; checkPassed?: boolean }) => void;
}

const LEAKED_EXP_RE = /(##\s*亲历实践体验|##\s*内在驱力场|##\s*自主微心愿|##\s*自由意志抉择准则|##\s*双向蜕变年轮|^- 当前情绪：)/m;

function auditArchiveFacts(dir: string): FactsDiskAudit {
  const facts = listFacts(dir);
  const active = facts.filter((f) => f.status === 'active');
  const journal = readJsonlSafe<JournalEntry>(resolveArchivePaths(dir).journal);
  let seqMonotonic = true;
  let prev = 0;
  for (const j of journal) {
    if (!Number.isInteger(j.seq) || j.seq <= prev) { seqMonotonic = false; break; }
    prev = j.seq;
  }
  return {
    totalRecords: facts.length,
    activeCount: active.length,
    supersededCount: facts.filter((f) => f.status === 'superseded').length,
    residenceUpdated: active.some((f) => /成都|高新区/.test(f.fact)) && !active.some((f) => /上海|浦东/.test(f.fact)),
    drinkUpdated: active.some((f) => /拿铁/.test(f.fact)) && !active.some((f) => /美式/.test(f.fact)),
    workUpdated: active.some((f) => /产品经理/.test(f.fact)) && !active.some((f) => /前端/.test(f.fact)),
    seqMonotonic,
  };
}

/** 运行 v0.6 长对话防幻觉基准（30~100 轮），返回完整统计指标与可选 Markdown 落盘。 */
export async function runCompanionBenchmark(options: CompanionBenchmarkOptions = {}): Promise<CompanionEvalReport> {
  const { mode, endpoint } = resolveEvalEndpoint(options);
  const turnsSpec = buildCompanionScenario(options.turns ?? 30);
  const savedCfg = loadHubConfig(options.configPath || defaultConfigPath());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-eval-v06-'));
  const cfgPath = path.join(dir, 'eval-hub.json');
  const token = 'tok-eval-v06';
  const startedAt = Date.now();

  initSoulArchive(dir, EVAL_COMPANION_IDENTITY);
  awakenSoul(dir, { bodyId: 'eval-init', bodyType: 'web' });
  const hub = await createSoulHubServer({
    archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token,
    dream: { enabled: false, idleMinutes: 15, minPendingEntries: 4, checkIntervalSec: 60 },
    experimental: { enableEmotion: false, enableInnerLife: false, enableFreeWill: false, enableHeartbeat: false, enableResurrection: false },
  });
  const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };

  const requestJson = async <T = Record<string, unknown>>(method: string, pathname: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${hub.baseUrl}${pathname}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json()) as T & { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  try {
    let embeddingEnabled = false;
    let rerankEnabled = false;
    if (mode === 'live-llm' && options.useEmbedding !== false && (savedCfg.embedding.enabled || savedCfg.rerank.enabled)) {
      await requestJson('POST', '/api/config', {
        ...(savedCfg.embedding.enabled ? { embedding: savedCfg.embedding } : {}),
        ...(savedCfg.rerank.enabled ? { rerank: savedCfg.rerank } : {}),
      });
      embeddingEnabled = savedCfg.embedding.enabled;
      rerankEnabled = savedCfg.rerank.enabled;
    }
    hub.ctx.llm.updateConfig({ chat: endpoint });

    await requestJson('POST', '/api/relations', { personId: 'partner-primary', name: '阿明', role: '同行者', familiarity: 78, allowOverwrite: true });
    await requestJson('POST', '/api/relations/bind', { personId: 'partner-primary', channel: 'web', accountId: 'web-aming' });
    await requestJson('POST', '/api/relations/bind', { personId: 'partner-primary', channel: 'chat:qq', accountId: '88001' });
    await requestJson('POST', '/api/body/register', { bodyId: 'web-eval', bodyType: 'web', displayName: 'Web 聊天窗' });
    await requestJson('POST', '/api/body/register', { bodyId: 'qq-eval', bodyType: 'chat:qq', displayName: 'QQ 私聊' });

    const turnResults: CompanionTurnResult[] = [];
    let dreamRuns = 0;

    for (const spec of turnsSpec) {
      const percept = await requestJson<{
        reply: string; latencyMs: number;
        recallTrace?: { retrievalMs?: number };
      }>('POST', '/api/body/percept', {
        bodyId: spec.bodyId, bodyType: spec.bodyType, speaker: '阿明',
        text: spec.text, ...(spec.metadata ? { metadata: spec.metadata } : {}),
      });
      const lp = await requestJson<{
        snapshot?: { systemPrompt?: string; estimatedTokens?: number; promptTokens?: number } | null;
      }>('GET', '/api/phase2/last-prompt');

      const retrievalMs = Number((percept.recallTrace?.retrievalMs ?? 0).toFixed(2));
      const outcome = evaluateTurnReply(spec, percept.reply);
      const sysPrompt = lp.snapshot?.systemPrompt || '';
      const experimentalClean = !LEAKED_EXP_RE.test(sysPrompt);
      const row: CompanionTurnResult = {
        turn: spec.turn, bodyId: spec.bodyId, bodyType: spec.bodyType, userText: spec.text,
        replyPreview: percept.reply.replace(/\s+/g, ' ').slice(0, 120),
        latencyMs: percept.latencyMs, retrievalMs,
        estimatedTokens: lp.snapshot?.estimatedTokens ?? Math.ceil(sysPrompt.length / 2.5),
        ...(lp.snapshot?.promptTokens !== undefined ? { promptTokens: lp.snapshot.promptTokens } : {}),
        leakedTag: outcome.leakedTag, experimentalClean,
        ...(spec.check ? {
          checkId: spec.check.id, dimension: spec.check.dimension, title: spec.check.title,
          ...(spec.check.plantedAtTurn !== undefined ? { plantedAtTurn: spec.check.plantedAtTurn } : {}),
          passed: outcome.passed, reason: outcome.reason,
        } : {}),
      };
      turnResults.push(row);
      options.onProgress?.({
        turn: spec.turn, total: turnsSpec.length, bodyType: spec.bodyType,
        latencyMs: percept.latencyMs, retrievalMs, ...(row.passed !== undefined ? { checkPassed: row.passed } : {}),
      });

      if (spec.triggerDreamAfter) {
        await requestJson('POST', '/api/dream', {});
        dreamRuns += 1;
      }
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
    }

    const report = summarizeCompanionReport({
      mode, driver: endpoint.driver, model: endpoint.model,
      embeddingEnabled, rerankEnabled, dreamRuns,
      totalDurationMs: Date.now() - startedAt,
      factsAudit: auditArchiveFacts(dir),
      turns: turnResults,
    });
    if (options.outPath) {
      fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });
      writeTextAtomic(path.resolve(options.outPath), formatCompanionMarkdownReport(report));
    }
    return report;
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printHelp(): void {
  console.log([
    'SoulUntoYou v0.6 长对话防幻觉评测工具 (scripts/eval-real-llm.ts)',
    '',
    '用法:',
    '  node scripts/eval-real-llm.ts [--live] [--turns=30..100] [--model=模型名] [选项]',
    '',
    '常用选项:',
    '  --live                 使用真实大模型 API（默认不带此参数则跑离线 mock 冒烟）',
    '  --turns=30             评测总轮数，支持 30 ~ 100（默认 30）',
    '  --driver=DRIVER        openai-compatible | gemini-aistudio | vertex-express | vertex-ai',
    '  --base-url=URL         OpenAI 兼容接口地址（如 https://api.deepseek.com/v1）',
    '  --api-key=KEY          真实模型 API Key（也可设环境变量 SOUL_EVAL_API_KEY）',
    '  --model=MODEL          模型名称（如 deepseek-chat / Qwen/Qwen3-32B / gemini-2.5-flash）',
    '  --no-embedding         评测期间关闭向量/重排增强（仅测 SQLite FTS5 基线）',
    '  --delay-ms=N           每轮对话间隔毫秒数（防免费限流，默认 0）',
    '  --out=PATH             指定 Markdown 成绩单输出路径（默认 .cache/eval-v06-report.md）',
    '  --no-save              仅打印到终端，不保存 Markdown 文件',
    '  --json                 输出 JSON 原始报告',
    '  --suite=legacy         运行 Phase 5.5d 5 场景快捷回归',
    '',
    'PowerShell 示例（使用临时环境变量，不落盘不入库）:',
    '  $env:SOUL_EVAL_DRIVER="openai-compatible"; $env:SOUL_EVAL_BASE_URL="https://api.deepseek.com/v1"; $env:SOUL_EVAL_MODEL="deepseek-chat"; $env:SOUL_EVAL_API_KEY="YOUR_API_KEY"; npm run eval:llm',
  ].join('\n'));
}

const getArgVal = (args: string[], name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

async function runCli(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const mode = args.includes('--live') ? 'live' : 'mock';
  const suite = getArgVal(args, 'suite') || 'companion';
  const modelOverride = getArgVal(args, 'model');
  const driverOverride = getArgVal(args, 'driver') as LlmEndpointConfig['driver'] | undefined;
  const baseUrlOverride = getArgVal(args, 'base-url');
  const apiKeyOverride = getArgVal(args, 'api-key');
  const configPath = getArgVal(args, 'config');

  if (suite === 'legacy') {
    const rep = await runObjectiveEvaluation({ mode, configPath, driverOverride, baseUrlOverride, apiKeyOverride, modelOverride });
    console.log(`=== 客观非循环评测报告 [${rep.mode}] (${rep.driver} / ${rep.model}) ===`);
    console.log(`通过: ${rep.passed}/${rep.total} (${rep.passRatePct}%) | 标签泄漏: ${rep.leakedTagCount} | 平均耗时: ${rep.avgLatencyMs} ms`);
    for (const c of rep.cases) {
      console.log(`${c.passed ? '✅ PASS' : '❌ FAIL'} | ${c.id} (${c.title}) | ${c.latencyMs}ms | ${c.reason}`);
    }
    if (rep.passed < rep.total) process.exitCode = 1;
    return;
  }

  const turnsRaw = getArgVal(args, 'turns');
  const turns = turnsRaw !== undefined ? Number(turnsRaw) : 30;
  const delayRaw = getArgVal(args, 'delay-ms');
  const tempRaw = getArgVal(args, 'temperature');
  const timeoutRaw = getArgVal(args, 'timeout-ms');
  const outPath = args.includes('--no-save') ? undefined : (getArgVal(args, 'out') || path.join(REPO_ROOT, '.cache', 'eval-v06-report.md'));
  const jsonMode = args.includes('--json');

  const rep = await runCompanionBenchmark({
    mode, turns, configPath, driverOverride, baseUrlOverride, apiKeyOverride, modelOverride,
    useEmbedding: !args.includes('--no-embedding'),
    ...(delayRaw !== undefined ? { delayMs: Number(delayRaw) } : {}),
    ...(tempRaw !== undefined ? { temperatureOverride: Number(tempRaw) } : {}),
    ...(timeoutRaw !== undefined ? { timeoutMsOverride: Number(timeoutRaw) } : {}),
    outPath,
    onProgress: (p) => {
      if (!jsonMode) {
        const tag = p.checkPassed === undefined ? '' : (p.checkPassed ? ' ✅' : ' ❌');
        process.stderr.write(`[${p.turn}/${p.total}] ${p.bodyType} | 检索 ${p.retrievalMs}ms | 整轮 ${p.latencyMs}ms${tag}\n`);
      }
    },
  });

  if (jsonMode) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    console.log(formatCompanionMarkdownReport(rep));
    if (outPath) process.stderr.write(`成绩单已保存至: ${path.relative(REPO_ROOT, path.resolve(outPath))}\n`);
  }
  if (rep.leakedTagCount > 0 || !rep.experimentalClean) process.exitCode = 1;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error('评测执行失败:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
