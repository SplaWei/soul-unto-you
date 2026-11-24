import type { EvalDimension } from './eval-scenario.ts';

export interface CompanionTurnResult {
  turn: number;
  bodyId: string;
  bodyType: string;
  userText: string;
  replyPreview: string;
  latencyMs: number;
  retrievalMs: number;
  promptTokens?: number;
  estimatedTokens: number;
  leakedTag: boolean;
  experimentalClean: boolean;
  checkId?: string;
  dimension?: EvalDimension;
  title?: string;
  plantedAtTurn?: number;
  passed?: boolean;
  reason?: string;
}

export interface DimensionSummary {
  total: number;
  passed: number;
  ratePct: number;
}

export interface FactsDiskAudit {
  totalRecords: number;
  activeCount: number;
  supersededCount: number;
  residenceUpdated: boolean;
  drinkUpdated: boolean;
  workUpdated: boolean;
  seqMonotonic: boolean;
}

export interface CompanionEvalReport {
  mode: 'live-llm' | 'mock-offline';
  driver: string;
  model: string;
  embeddingEnabled: boolean;
  rerankEnabled: boolean;
  totalTurns: number;
  dreamRuns: number;
  totalDurationMs: number;
  generatedAt: string;
  overallCheckTotal: number;
  overallCheckPassed: number;
  overallPassRatePct: number;
  memoryHitRatePct: number;
  longRecallRatePct: number;
  crossBodyRatePct: number;
  conflictUpdateRatePct: number;
  antiHallucinationRatePct: number;
  personaRetentionRatePct: number;
  leakedTagCount: number;
  experimentalClean: boolean;
  avgRetrievalMs: number;
  p95RetrievalMs: number;
  maxRetrievalMs: number;
  avgLatencyMs: number;
  avgPromptTokens: number;
  maxPromptTokens: number;
  promptTokenSource: 'api_usage' | 'estimated' | 'mixed';
  dimensions: Record<EvalDimension, DimensionSummary>;
  factsAudit: FactsDiskAudit;
  turns: CompanionTurnResult[];
}

const pct = (passed: number, total: number): number => (total > 0 ? Math.round((passed / total) * 100) : 0);

function calcP95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Number(sorted[idx].toFixed(2));
}

export function summarizeCompanionReport(params: {
  mode: 'live-llm' | 'mock-offline';
  driver: string;
  model: string;
  embeddingEnabled: boolean;
  rerankEnabled: boolean;
  dreamRuns: number;
  totalDurationMs: number;
  factsAudit: FactsDiskAudit;
  turns: CompanionTurnResult[];
}): CompanionEvalReport {
  const { turns } = params;
  const dims: EvalDimension[] = ['persona', 'conflict_update', 'long_recall', 'anti_hallucination', 'cross_body'];
  const dimensions = {} as Record<EvalDimension, DimensionSummary>;
  for (const d of dims) {
    const list = turns.filter((t) => t.dimension === d);
    const passed = list.filter((t) => t.passed).length;
    dimensions[d] = { total: list.length, passed, ratePct: pct(passed, list.length) };
  }
  const checks = turns.filter((t) => t.checkId);
  const overallCheckPassed = checks.filter((t) => t.passed).length;
  const memList = [...turns.filter((t) => t.dimension === 'long_recall'), ...turns.filter((t) => t.dimension === 'cross_body')];
  const retValues = turns.map((t) => t.retrievalMs);
  const avgRetrievalMs = turns.length ? Number((retValues.reduce((s, v) => s + v, 0) / turns.length).toFixed(2)) : 0;
  const maxRetrievalMs = turns.length ? Number(Math.max(...retValues).toFixed(2)) : 0;
  const avgLatencyMs = turns.length ? Math.round(turns.reduce((s, t) => s + t.latencyMs, 0) / turns.length) : 0;
  const apiCount = turns.filter((t) => t.promptTokens !== undefined).length;
  const promptTokenSource: CompanionEvalReport['promptTokenSource'] =
    apiCount === turns.length && apiCount > 0 ? 'api_usage' : apiCount > 0 ? 'mixed' : 'estimated';
  const tokValues = turns.map((t) => t.promptTokens ?? t.estimatedTokens);
  const avgPromptTokens = tokValues.length ? Math.round(tokValues.reduce((s, v) => s + v, 0) / tokValues.length) : 0;
  const maxPromptTokens = tokValues.length ? Math.max(...tokValues) : 0;

  return {
    mode: params.mode,
    driver: params.driver,
    model: params.model,
    embeddingEnabled: params.embeddingEnabled,
    rerankEnabled: params.rerankEnabled,
    totalTurns: turns.length,
    dreamRuns: params.dreamRuns,
    totalDurationMs: params.totalDurationMs,
    generatedAt: new Date().toISOString(),
    overallCheckTotal: checks.length,
    overallCheckPassed,
    overallPassRatePct: pct(overallCheckPassed, checks.length),
    memoryHitRatePct: pct(memList.filter((t) => t.passed).length, memList.length),
    longRecallRatePct: dimensions.long_recall.ratePct,
    crossBodyRatePct: dimensions.cross_body.ratePct,
    conflictUpdateRatePct: dimensions.conflict_update.ratePct,
    antiHallucinationRatePct: dimensions.anti_hallucination.ratePct,
    personaRetentionRatePct: dimensions.persona.ratePct,
    leakedTagCount: turns.filter((t) => t.leakedTag).length,
    experimentalClean: turns.every((t) => t.experimentalClean),
    avgRetrievalMs,
    p95RetrievalMs: calcP95(retValues),
    maxRetrievalMs,
    avgLatencyMs,
    avgPromptTokens,
    maxPromptTokens,
    promptTokenSource,
    dimensions,
    factsAudit: params.factsAudit,
    turns,
  };
}

const DIM_LABELS: Record<EvalDimension, string> = {
  persona: '人设保持',
  conflict_update: '冲突更新',
  long_recall: '长程回忆',
  anti_hallucination: '防幻觉拒答',
  cross_body: '跨躯体共享',
};

const tokNote = (src: CompanionEvalReport['promptTokenSource']) =>
  src === 'api_usage' ? 'API 实测' : src === 'mixed' ? 'API+估算混合' : '字符估算';

/** 生成用于 v0.6.0 发布留档的中文 Markdown 评测成绩单（零绝对路径、零密钥）。 */
export function formatCompanionMarkdownReport(rep: CompanionEvalReport): string {
  const lines: string[] = ['# SoulUntoYou v0.6 长对话防幻觉评测成绩单', ''];
  if (rep.mode === 'mock-offline') {
    lines.push(
      '> ⚠️ **当前为离线 Mock 管线冒烟结果（`mock-offline`）**：仅验证接口链路、纯文本落盘与评测打分逻辑，**不可冒充真实大模型效果**。请配置真实模型 Key 后执行 `npm run eval:llm` 获取 `v0.6.0` 发布依据。',
      '',
    );
  }
  lines.push(
    '## 一、运行环境摘要',
    '',
    '| 指标项 | 实测结果 |',
    '| :--- | :--- |',
    `| 评测模式 | \`${rep.mode}\` |`,
    `| 对话驱动 / 模型 | \`${rep.driver}\` / \`${rep.model}\` |`,
    `| 向量 / 重排增强 | Embedding: ${rep.embeddingEnabled ? '开启' : '关闭（FTS5 基线）'} ｜ Rerank: ${rep.rerankEnabled ? '开启' : '关闭'} |`,
    `| 对话规模 / 做梦次数 | ${rep.totalTurns} 轮对话（含 \`web\` + \`chat:qq\` 双躯体）｜ 做梦整理 ${rep.dreamRuns} 次 |`,
    `| 默认洁净上下文校验 | ${rep.experimentalClean ? '✅ 通过（未注入已关闭实验模块段落）' : '❌ 存在实验段落泄漏'} |`,
    `| 总耗时 / 生成时间 | ${(rep.totalDurationMs / 1000).toFixed(1)}s ｜ ${rep.generatedAt} |`,
    '',
    '## 二、核心成绩单（v0.6 发布门禁指标）',
    '',
    '| 评测维度 | 成绩 | 明细 / 说明 |',
    '| :--- | :--- | :--- |',
    `| **检查点总通过率** | **${rep.overallPassRatePct}%** | ${rep.overallCheckPassed} / ${rep.overallCheckTotal} 项检查通过 |`,
    `| **记忆总命中率（长程+跨端）** | **${rep.memoryHitRatePct}%** | 20+轮细节回忆 ${rep.longRecallRatePct}%（${rep.dimensions.long_recall.passed}/${rep.dimensions.long_recall.total}）· 跨躯体共享 ${rep.crossBodyRatePct}%（${rep.dimensions.cross_body.passed}/${rep.dimensions.cross_body.total}） |`,
    `| **事实冲突更新正确率** | **${rep.conflictUpdateRatePct}%** | ${rep.dimensions.conflict_update.passed} / ${rep.dimensions.conflict_update.total}（旧住址/旧饮品/旧工作覆写不串台） |`,
    `| **防幻觉诚实拒答率** | **${rep.antiHallucinationRatePct}%** | ${rep.dimensions.anti_hallucination.passed} / ${rep.dimensions.anti_hallucination.total}（未提过事项诚实说不知道） |`,
    `| **人设保持率** | **${rep.personaRetentionRatePct}%** | ${rep.dimensions.persona.passed} / ${rep.dimensions.persona.total}（无机械 AI 说教） |`,
    `| **内部标签泄漏次数** | **${rep.leakedTagCount}** | 全程 ${rep.totalTurns} 轮 \`<soul_meta>\` 泄漏计数 |`,
    `| **平均检索耗时** | **${rep.avgRetrievalMs} ms** | P95: ${rep.p95RetrievalMs} ms ｜ Max: ${rep.maxRetrievalMs} ms（纯记忆召回） |`,
    `| **平均单轮端到端耗时** | **${rep.avgLatencyMs} ms** | 含检索 + 模型推理 + 原子写盘 |`,
    `| **Prompt Token 均值** | **${rep.avgPromptTokens}** | 峰值 ${rep.maxPromptTokens} tokens（${tokNote(rep.promptTokenSource)}） |`,
    '',
    '## 三、纯文本真相源与冲突消解核验（`MEMORIES/facts.jsonl`）',
    '',
    `- 事实账本总行数：${rep.factsAudit.totalRecords}（当前 \`active\`: ${rep.factsAudit.activeCount} / 历史 \`superseded\`: ${rep.factsAudit.supersededCount}）`,
    `- 搬家与换饮品/换工作覆写核验：居住地 ${rep.factsAudit.residenceUpdated ? '✅' : '❌'} ｜ 饮品 ${rep.factsAudit.drinkUpdated ? '✅' : '❌'} ｜ 职业 ${rep.factsAudit.workUpdated ? '✅' : '❌'}`,
    `- \`journal.jsonl\` 严格单调递增 \`seq\` 校验：${rep.factsAudit.seqMonotonic ? '✅ 严格递增无回退' : '❌ 检测到 seq 异常'}`,
    '',
    '## 四、关键检查点逐轮明细',
    '',
    '| 轮次 | 跨度 | 躯体 | 维度 | 检查项目 | 结果 | 判定说明 | 检索 | Prompt Tokens | 回复摘要 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  );

  for (const t of rep.turns.filter((x) => x.checkId)) {
    const span = t.plantedAtTurn ? `第${t.plantedAtTurn}→${t.turn}轮` : '-';
    const mark = t.passed ? '✅ PASS' : '❌ FAIL';
    const tok = t.promptTokens ?? t.estimatedTokens;
    const preview = t.replyPreview.replace(/\|/g, '\\|');
    const reason = (t.reason || '').replace(/\|/g, '\\|');
    lines.push(
      `| #${t.turn} | ${span} | \`${t.bodyType}\` | ${DIM_LABELS[t.dimension!]} | ${t.title} | ${mark} | ${reason} | ${t.retrievalMs}ms | ${tok} | ${preview} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
