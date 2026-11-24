import path from 'node:path';
import type { LlmTokenUsage } from '../llm/router.ts';
import { ingestRealityFeedback } from '../memory/experience.ts';
import { extractAccountId, extractPersonIdHint, resolveAndRecordSpeaker } from '../memory/relations.ts';
import {
  BUILTIN_HYBRID_RETRIEVER,
  executeRetrievalWithFallback,
  syncVectorIndexDetailed,
  type MemoryRetrievalResult,
} from '../memory/search.ts';
import { appendJournal } from '../soul/archive.ts';
import type { BodyActionSpec, BodyType, ExperimentalConfig, ModalityPacket, SoulActionIntent } from '../soul/types.ts';
import type { SoulHubContext } from './body-api.ts';
import type { ObserveInput } from './percept-pipeline.ts';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const vectorSyncTimers = new Map<string, NodeJS.Timeout>();

export function collectImages(
  images?: Array<{ base64: string; mimeType?: string }>,
  modalities?: ModalityPacket[],
): Array<{ base64: string; mimeType?: string }> {
  const merged = [...(images ?? [])];
  for (const m of modalities ?? []) {
    if (m.kind === 'image' && typeof m.data === 'string' && m.data.trim()) {
      merged.push({ base64: m.data.replace(/^data:[^;]+;base64,/, ''), mimeType: m.mimeType || 'image/png' });
    }
  }
  return merged;
}

export function buildRecallRetrievalParams(ctx: SoulHubContext) {
  return {
    embedding: ctx.config.embedding,
    rerank: ctx.config.rerank,
    retriever: ctx.retriever,
    topK: ctx.config.retriever.topK ?? 5,
    minScore: ctx.config.retriever.minScore ?? 0.12,
    experimental: ctx.config.experimental,
  };
}

export async function prepareRetrievalOutsideLock(
  ctx: SoulHubContext,
  dir: string,
  query: string,
  bodyId: string,
  bodyType: BodyType,
): Promise<{ precomputedRetrieval?: MemoryRetrievalResult; queryVec: number[] | null; vectorMap: Record<string, number[]> | null; prepMs: number }> {
  const t0 = performance.now();
  const activeRetriever = ctx.retriever ?? BUILTIN_HYBRID_RETRIEVER;
  if (activeRetriever.isExternal || ctx.config.rerank?.enabled) {
    const precomputedRetrieval = await executeRetrievalWithFallback(activeRetriever, {
      archiveDir: dir, query, bodyId, bodyType,
      topK: ctx.config.retriever.topK ?? 5,
      minScore: ctx.config.retriever.minScore ?? 0.12,
      experienceTopK: ctx.config.experimental.enableFreeWill ? 4 : 0,
      embedding: ctx.config.embedding,
      rerank: ctx.config.rerank,
    });
    return {
      precomputedRetrieval,
      queryVec: precomputedRetrieval.queryVec ?? null,
      vectorMap: precomputedRetrieval.vectorMap ?? null,
      prepMs: Number((performance.now() - t0).toFixed(2)),
    };
  }
  const prefetched = await activeRetriever.prefetch?.({ archiveDir: dir, query, embedding: ctx.config.embedding });
  return {
    queryVec: prefetched?.queryVec ?? null,
    vectorMap: prefetched?.vectorMap ?? null,
    prepMs: Number((performance.now() - t0).toFixed(2)),
  };
}

export function collectAvailableActions(ctx: SoulHubContext, currentBodyId: string): BodyActionSpec[] {
  const local = ctx.presence.getBody(currentBodyId)?.actions ?? [];
  const onlineIds = new Set<string>(ctx.events.getOnlineBodyIds());
  for (const id of ctx.ws?.getOnlineBodyIds?.() ?? []) onlineIds.add(id);

  const remote: BodyActionSpec[] = [];
  for (const remoteId of onlineIds) {
    if (!remoteId || remoteId === currentBodyId) continue;
    for (const act of ctx.presence.getBody(remoteId)?.actions ?? []) {
      remote.push({ ...act, targetBodyId: remoteId });
    }
  }
  return [...local, ...remote];
}

function sanitizeDispatchParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (FORBIDDEN_KEYS.has(k) || typeof v === 'function' || typeof v === 'symbol') continue;
    clean[k] = v;
  }
  return Object.keys(clean).length ? clean : undefined;
}

export function filterAuthorizedActions(
  actions: SoulActionIntent[] | undefined,
  availableActions: BodyActionSpec[],
): SoulActionIntent[] {
  if (!Array.isArray(actions) || !actions.length || !availableActions.length) return [];
  const allowed = new Set<string>(
    availableActions.map((spec) => `${String(spec.name || '').trim()}::${String(spec.targetBodyId || '').trim()}`),
  );
  const out: SoulActionIntent[] = [];
  for (const act of actions) {
    if (!act || typeof act !== 'object') continue;
    const name = String(act.name || '').trim();
    const targetBodyId = String(act.targetBodyId || '').trim();
    if (!name || !allowed.has(`${name}::${targetBodyId}`)) continue;
    const params = sanitizeDispatchParams(act.params);
    const reason = typeof act.reason === 'string' ? act.reason.trim().slice(0, 240) : '';
    out.push({
      name,
      ...(targetBodyId ? { targetBodyId } : {}),
      ...(params ? { params } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

export function dispatchRemoteActions(
  ctx: SoulHubContext,
  fromBodyId: string,
  fromBodyType: BodyType,
  actions: SoulActionIntent[],
): void {
  for (const act of actions) {
    if (!act.targetBodyId || act.targetBodyId === fromBodyId) continue;
    const msg = { fromBodyId, fromBodyType, targetBodyId: act.targetBodyId, action: act };
    ctx.events.emit('body.action', msg);
    ctx.ws?.broadcastJson({ type: 'body.action', ...msg });
  }
}

export function clearDebouncedVectorSync(archiveDir?: string): void {
  if (archiveDir) {
    const key = path.resolve(archiveDir);
    const t = vectorSyncTimers.get(key);
    if (t) {
      clearTimeout(t);
      vectorSyncTimers.delete(key);
    }
    return;
  }
  for (const t of vectorSyncTimers.values()) clearTimeout(t);
  vectorSyncTimers.clear();
}

export function scheduleDebouncedVectorSync(
  ctx: SoulHubContext,
  archiveDir: string,
  expectedEpoch: number,
  delayMs = 1500,
): void {
  if (!ctx.config.embedding.enabled) return;
  const key = path.resolve(archiveDir);
  const prev = vectorSyncTimers.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(() => {
    vectorSyncTimers.delete(key);
    if (ctx.config.archiveDir !== archiveDir || ctx.presence.getEpoch() !== expectedEpoch) return;
    void syncVectorIndexDetailed(archiveDir, ctx.config.embedding, {
      shouldAbort: () => ctx.config.archiveDir !== archiveDir || ctx.presence.getEpoch() !== expectedEpoch,
    }).catch(() => {});
  }, delayMs);
  timer.unref?.();
  vectorSyncTimers.set(key, timer);
}

export function captureLastPrompt(
  ctx: SoulHubContext,
  info: {
    source: 'percept' | 'observe' | 'proactive';
    bodyId: string;
    bodyType: string;
    driver: string;
    model: string;
    systemPrompt?: string;
    userText: string;
    usage?: LlmTokenUsage;
  },
): void {
  const sys = String(info.systemPrompt ?? '');
  const charCount = sys.length;
  ctx.lastPrompt = {
    capturedAt: new Date().toISOString(),
    source: info.source,
    bodyId: info.bodyId,
    bodyType: info.bodyType,
    driver: info.driver,
    model: info.model,
    experimental: { ...ctx.config.experimental },
    systemPrompt: sys,
    userTextPreview: String(info.userText ?? '').slice(0, 160),
    charCount,
    estimatedTokens: Math.ceil(charCount / 2.5),
    ...(info.usage?.promptTokens !== undefined ? { promptTokens: info.usage.promptTokens } : {}),
    ...(info.usage?.completionTokens !== undefined ? { completionTokens: info.usage.completionTokens } : {}),
    ...(info.usage?.totalTokens !== undefined ? { totalTokens: info.usage.totalTokens } : {}),
  };
}

export function recordObserveInArchive(
  dir: string,
  bodyId: string,
  bodyType: BodyType,
  summary: string,
  input: ObserveInput,
  experimental?: Partial<ExperimentalConfig>,
) {
  const accountId = extractAccountId(input.metadata);
  const personHint = extractPersonIdHint(input.metadata);
  const obsSpeaker = String(input.metadata?.speaker || input.metadata?.senderName || input.displayName || accountId || '').trim();
  const obsPerson = (accountId || personHint) && obsSpeaker
    ? resolveAndRecordSpeaker(dir, { bodyId, bodyType, speaker: obsSpeaker, metadata: input.metadata })
    : null;
  appendJournal(dir, {
    bodyId, bodyType, speaker: input.displayName || `${bodyType}观察器`, role: 'witness', text: summary, provenance: 'verified',
    ...(obsPerson ? { personId: obsPerson.person.personId } : {}), importance: input.urgency === 'high' ? 85 : 55, metadata: input.metadata,
  });
  return experimental?.enableFreeWill === true && (input.metadata?.realityFeedback || input.urgency === 'high')
    ? ingestRealityFeedback(dir, { bodyId, bodyType, summary, speaker: input.displayName, metadata: input.metadata, experimental })
    : null;
}
