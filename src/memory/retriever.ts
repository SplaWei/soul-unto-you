import crypto from 'node:crypto';
import type { BodyType, LivedExperience, RecallChannel, SoulArchiveData } from '../soul/types.ts';
import { recallExperiences, tokenizeText } from './experience.ts';
import { ensureMemoryIndex, getMemoryIndexStatus, searchMemoryIndex } from './sqlite-index.ts';
import { normalizeProvenance, numOr, scoreIndexedMemoryCandidates, type RecalledItem } from './sqlite-scorer.ts';
import {
  checkEmbeddingHealth, cosineSimilarity, fetchEmbeddings, loadVectorIndex,
  syncVectorIndexDetailed, type EmbeddingConfig,
} from './vector-store.ts';

export type { RecalledItem };

export interface MemoryRetrievalRequest {
  archiveDir: string;
  query: string;
  bodyId?: string;
  bodyType?: BodyType;
  topK?: number;
  experienceTopK?: number;
  nowMs?: number;
  embedding?: EmbeddingConfig;
  queryVec?: number[] | null;
  vectorMap?: Record<string, number[]> | null;
  archive?: SoulArchiveData;
}

export interface MemoryRetrievalResult {
  retrieverId: string;
  items: RecalledItem[];
  experiences: LivedExperience[];
  queryVec?: number[] | null;
  vectorMap?: Record<string, number[]> | null;
  embeddingActive: boolean;
  embeddingModel?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  diagnostics?: Record<string, unknown>;
}

export interface MemoryRetrieverHealth {
  ok: boolean;
  retrieverId: string;
  name: string;
  detail?: string;
  latencyMs?: number;
}

export interface MemoryRetriever {
  readonly id: string;
  readonly name: string;
  readonly isExternal?: boolean;
  prefetch?(req: Pick<MemoryRetrievalRequest, 'archiveDir' | 'query' | 'embedding'>): Promise<{
    queryVec?: number[] | null;
    vectorMap?: Record<string, number[]> | null;
  }>;
  retrieve(req: MemoryRetrievalRequest): Promise<MemoryRetrievalResult>;
  sync?(archiveDir: string, options?: { embedding?: EmbeddingConfig }): Promise<Record<string, unknown>>;
  health?(archiveDir: string, options?: { embedding?: EmbeddingConfig }): Promise<MemoryRetrieverHealth>;
}

export interface RetrieverConfig {
  mode: 'builtin' | 'http';
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class BuiltinHybridRetriever implements MemoryRetriever {
  readonly id = 'builtin-hybrid';
  readonly name = '内置混合检索 (FTS5+词法+向量+艾宾浩斯)';
  readonly isExternal = false;

  async prefetch(req: Pick<MemoryRetrievalRequest, 'archiveDir' | 'query' | 'embedding'>) {
    if (!req.embedding?.enabled) return { queryVec: null, vectorMap: null };
    const vecIdx = loadVectorIndex(req.archiveDir, req.embedding);
    if (!vecIdx || !Object.keys(vecIdx.items).length) return { queryVec: null, vectorMap: null };
    try {
      return { queryVec: (await fetchEmbeddings([req.query], req.embedding))?.[0] ?? null, vectorMap: vecIdx.items };
    } catch {
      return { queryVec: null, vectorMap: vecIdx.items };
    }
  }

  async retrieve(req: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    const topK = req.topK ?? 6;
    const nowMs = req.nowMs ?? Date.now();
    let vectorMap = req.vectorMap ?? null;
    let queryVec = req.queryVec !== undefined ? req.queryVec : null;
    if (req.embedding?.enabled && vectorMap === null) vectorMap = loadVectorIndex(req.archiveDir, req.embedding)?.items ?? null;
    if (req.embedding?.enabled && req.queryVec === undefined && vectorMap && Object.keys(vectorMap).length > 0) {
      queryVec = (await fetchEmbeddings([req.query], req.embedding))?.[0] ?? null;
    }

    const extraDocIds: string[] = [];
    if (queryVec && vectorMap) {
      const vecScored: Array<{ id: string; sim: number }> = [];
      for (const [id, vec] of Object.entries(vectorMap)) {
        const sim = cosineSimilarity(queryVec, vec);
        if (sim >= 0.3) vecScored.push({ id, sim });
      }
      vecScored.sort((a, b) => b.sim - a.sim);
      for (const v of vecScored.slice(0, Math.max(topK * 4, 24))) extraDocIds.push(`episode:${v.id}`);
    }

    const indexRes = searchMemoryIndex(req.archiveDir, req.query, {
      candidateLimit: Math.max(topK * 10, 60),
      recentEpisodeLimit: Math.max(topK * 2, 16),
      extraDocIds,
    });
    const candidates = scoreIndexedMemoryCandidates({
      indexRes,
      queryTokens: tokenizeText(req.query),
      queryVec,
      vectorMap,
      nowMs,
    });
    const items = candidates.sort((a, b) => b.score - a.score).slice(0, topK);
    const expLimit = req.experienceTopK ?? 4;
    const experiences = expLimit > 0
      ? recallExperiences(req.archiveDir, req.query, { bodyType: req.bodyType, topK: expLimit, nowMs, queryVec, vectorMap })
      : [];
    return {
      retrieverId: this.id, items, experiences, queryVec, vectorMap, embeddingActive: Boolean(queryVec),
      ...(queryVec && req.embedding?.model ? { embeddingModel: req.embedding.model } : {}),
    };
  }

  async sync(archiveDir: string, options?: { embedding?: EmbeddingConfig }): Promise<Record<string, unknown>> {
    const ftsIndex = ensureMemoryIndex(archiveDir, { verifyHash: true });
    if (!options?.embedding) return { ok: true, skipped: true, reason: '未传入 embedding 配置', ftsIndex };
    const vec = await syncVectorIndexDetailed(archiveDir, options.embedding);
    return { ...vec, ftsIndex };
  }

  async health(archiveDir: string, options?: { embedding?: EmbeddingConfig }): Promise<MemoryRetrieverHealth> {
    const fts = getMemoryIndexStatus(archiveDir);
    const skipNote = fts.skippedCount > 0
      ? `（跳过 ${fts.skippedCount} 行: ${fts.skippedLines.slice(0, 3).map((s) => `${s.sourceFile}:${s.lineNumber}`).join(', ')}）`
      : '';
    const ftsNote = fts.exists ? `SQLite FTS5 就绪(${fts.docCount}条)${skipNote}` : 'SQLite FTS5 待按需重建';
    if (!options?.embedding?.enabled) {
      return { ok: true, retrieverId: this.id, name: this.name, detail: `${ftsNote} · 词法+艾宾浩斯常驻就绪（向量增强未开启）` };
    }
    const rep = await checkEmbeddingHealth(options.embedding);
    return {
      ok: true, retrieverId: this.id, name: this.name,
      detail: rep.ok
        ? `${ftsNote} · 向量模型 ${rep.model} (${rep.dimensions ?? 0}维) 在线`
        : `${ftsNote} · 向量离线自动降级词法检索: ${rep.detail}`,
    };
  }
}

export const BUILTIN_HYBRID_RETRIEVER = new BuiltinHybridRetriever();

function normalizeExternalItem(raw: Record<string, unknown>, idx: number): RecalledItem {
  return {
    ...(raw.id ? { id: String(raw.id) } : {}),
    kind: raw.kind === 'journal' ? 'journal' : 'episode',
    seq: numOr(raw.seq, idx + 1), score: numOr(raw.score, 0.5),
    bodyType: String(raw.bodyType || 'external'), provenance: normalizeProvenance(raw.provenance),
    timestamp: String(raw.timestamp || new Date().toISOString()), title: String(raw.title || '外部记忆片段'),
    text: String(raw.text || ''), retentionPct: numOr(raw.retentionPct, 85), strength: numOr(raw.strength, 6),
    recallCount: numOr(raw.recallCount, 0), mentionCount: numOr(raw.mentionCount, 1),
    semanticSim: numOr(raw.semanticSim, 0), lexicalSim: numOr(raw.lexicalSim, 0),
    ...(raw.userPinned ? { userPinned: true } : {}), ...(raw.selfImportant ? { selfImportant: true } : {}),
    recallReason: String(raw.recallReason || '外部记忆引擎召回'),
    recallChannels: Array.isArray(raw.recallChannels) ? (raw.recallChannels as RecallChannel[]) : ['semantic'],
  };
}

function normalizeExternalExperience(raw: Record<string, unknown>, idx: number): LivedExperience {
  return {
    id: String(raw.id || `ext_exp_${idx}`), seq: numOr(raw.seq, idx + 1),
    timestamp: String(raw.timestamp || new Date().toISOString()),
    bodyId: String(raw.bodyId || 'external'), bodyType: String(raw.bodyType || 'external'),
    origin: raw.origin === 'lived' ? 'lived' : 'inherited',
    stimulus: String(raw.stimulus || ''), chosenAction: String(raw.chosenAction || ''),
    realityOutcome: String(raw.realityOutcome || ''), valence: numOr(raw.valence, 0),
    arousal: numOr(raw.arousal, 0.5), lesson: String(raw.lesson || ''),
    confidence: numOr(raw.confidence, 0.65), provenance: normalizeProvenance(raw.provenance),
  };
}

export function createHttpMemoryRetriever(config: {
  id?: string; name?: string; endpoint: string; apiKey?: string; timeoutMs?: number;
}): MemoryRetriever {
  const id = config.id?.trim() || 'http-external';
  const name = config.name?.trim() || '外部 HTTP 记忆引擎';
  const endpoint = String(config.endpoint || '').trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(500, Math.min(30_000, Number(config.timeoutMs) || 4000));
  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
  });

  return {
    id, name, isExternal: true,
    async retrieve(req: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
      if (!endpoint) throw new Error('外部记忆检索引擎未配置 endpoint');
      const archiveId = crypto.createHash('sha256').update(req.archiveDir).digest('hex').slice(0, 12);
      const res = await fetch(`${endpoint}/retrieve`, {
        method: 'POST', headers: headers(), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          archiveId, query: req.query, bodyId: req.bodyId, bodyType: req.bodyType,
          topK: req.topK ?? 5, experienceTopK: req.experienceTopK ?? 4, nowMs: req.nowMs ?? Date.now(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        items?: Array<Record<string, unknown>>; experiences?: Array<Record<string, unknown>>;
        embeddingActive?: boolean; embeddingModel?: string; diagnostics?: Record<string, unknown>;
      };
      if (!data || !Array.isArray(data.items)) throw new Error('外部记忆引擎返回格式无效（缺少 items 数组）');
      const expTopK = req.experienceTopK ?? 4;
      return {
        retrieverId: id,
        items: data.items.slice(0, req.topK ?? 5).map(normalizeExternalItem),
        experiences: expTopK > 0 && Array.isArray(data.experiences) ? data.experiences.slice(0, expTopK).map(normalizeExternalExperience) : [],
        embeddingActive: Boolean(data.embeddingActive),
        ...(data.embeddingModel ? { embeddingModel: String(data.embeddingModel) } : {}),
        ...(data.diagnostics ? { diagnostics: data.diagnostics } : {}),
      };
    },
    async sync(archiveDir: string): Promise<Record<string, unknown>> {
      if (!endpoint) throw new Error('外部记忆检索引擎未配置 endpoint');
      const archiveId = crypto.createHash('sha256').update(archiveDir).digest('hex').slice(0, 12);
      const res = await fetch(`${endpoint}/sync`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ archiveId }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    async health(): Promise<MemoryRetrieverHealth> {
      const started = Date.now();
      if (!endpoint) return { ok: false, retrieverId: id, name, detail: '未配置 endpoint' };
      try {
        const res = await fetch(`${endpoint}/health`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
        const latencyMs = Date.now() - started;
        if (!res.ok) return { ok: false, retrieverId: id, name, detail: `HTTP ${res.status}`, latencyMs };
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
        return { ok: body.ok !== false, retrieverId: id, name, detail: body.detail || '外部检索服务在线', latencyMs };
      } catch (err) {
        return { ok: false, retrieverId: id, name, detail: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
      }
    },
  };
}

const retrieverRegistry = new Map<string, MemoryRetriever>([[BUILTIN_HYBRID_RETRIEVER.id, BUILTIN_HYBRID_RETRIEVER]]);
export const registerMemoryRetriever = (retriever: MemoryRetriever): void => { retrieverRegistry.set(retriever.id, retriever); };
export const unregisterMemoryRetriever = (id: string): boolean => (id === BUILTIN_HYBRID_RETRIEVER.id ? false : retrieverRegistry.delete(id));
export const getMemoryRetriever = (id: string): MemoryRetriever | undefined => retrieverRegistry.get(id);
export const listMemoryRetrievers = (): MemoryRetriever[] => [...retrieverRegistry.values()];

export function resolveConfiguredRetriever(cfg?: RetrieverConfig): MemoryRetriever {
  if (cfg?.mode === 'http' && cfg.endpoint?.trim()) {
    return createHttpMemoryRetriever({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs });
  }
  return BUILTIN_HYBRID_RETRIEVER;
}

export async function executeRetrievalWithFallback(
  retriever: MemoryRetriever | undefined,
  req: MemoryRetrievalRequest,
  fallback: MemoryRetriever = BUILTIN_HYBRID_RETRIEVER,
): Promise<MemoryRetrievalResult> {
  if (!retriever || retriever.id === fallback.id) return fallback.retrieve(req);
  try {
    const out = await retriever.retrieve(req);
    if (!out || !Array.isArray(out.items)) throw new Error('检索结果缺少 items');
    return out;
  } catch (err) {
    const fb = await fallback.retrieve(req);
    return { ...fb, fallbackFrom: retriever.id, fallbackReason: err instanceof Error ? err.message : String(err) };
  }
}
