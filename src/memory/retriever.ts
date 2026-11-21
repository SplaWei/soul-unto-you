import crypto from 'node:crypto';
import { loadSoulArchive } from '../soul/archive.ts';
import type { BodyType, LivedExperience, Provenance, RecallChannel, SoulArchiveData } from '../soul/types.ts';
import { lexicalSimilarityFromTokens, recallExperiences, tokenizeText } from './experience.ts';
import { computeRetention, describeRecallReasons } from './retention.ts';
import {
  checkEmbeddingHealth, cosineSimilarity, fetchEmbeddings, loadVectorIndex,
  syncVectorIndexDetailed, type EmbeddingConfig,
} from './vector-store.ts';

export interface RecalledItem {
  id?: string;
  kind: 'episode' | 'journal';
  seq: number;
  score: number;
  bodyType: BodyType;
  provenance: Provenance;
  timestamp: string;
  title: string;
  text: string;
  retentionPct: number;
  strength: number;
  recallCount: number;
  mentionCount: number;
  semanticSim: number;
  lexicalSim: number;
  userPinned?: boolean;
  selfImportant?: boolean;
  recallReason: string;
  recallChannels: RecallChannel[];
}

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

const VALID_PROVENANCES = new Set<Provenance>(['verified', 'inferred', 'oral']);
const normalizeProvenance = (raw: unknown): Provenance => (VALID_PROVENANCES.has(String(raw ?? '').trim() as Provenance) ? String(raw).trim() as Provenance : 'inferred');
const provenanceWeight = (p: Provenance): number => (p === 'verified' ? 1.0 : p === 'oral' ? 0.9 : 0.85);
const numOr = (v: unknown, fb: number): number => (Number.isFinite(Number(v)) ? Number(v) : fb);

export class BuiltinHybridRetriever implements MemoryRetriever {
  readonly id = 'builtin-hybrid';
  readonly name = '内置混合检索 (词法+向量+艾宾浩斯)';
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
    const archive = req.archive ?? loadSoulArchive(req.archiveDir, 150);
    const topK = req.topK ?? 6;
    const nowMs = req.nowMs ?? Date.now();
    let vectorMap = req.vectorMap ?? null;
    let queryVec = req.queryVec !== undefined ? req.queryVec : null;
    if (req.embedding?.enabled && vectorMap === null) vectorMap = loadVectorIndex(req.archiveDir, req.embedding)?.items ?? null;
    if (req.embedding?.enabled && req.queryVec === undefined && vectorMap && Object.keys(vectorMap).length > 0) {
      queryVec = (await fetchEmbeddings([req.query], req.embedding))?.[0] ?? null;
    }

    const candidates: RecalledItem[] = [];
    const queryTokens = tokenizeText(req.query);
    for (const ep of archive.episodes) {
      const ret = computeRetention(ep, nowMs);
      const lex = lexicalSimilarityFromTokens(queryTokens, `${ep.title} ${ep.summary}`);
      const vec = queryVec && vectorMap?.[ep.id] ? cosineSimilarity(queryVec, vectorMap[ep.id]) : 0;
      const imp = Math.min(1, Math.max(0, ep.importance / 100));
      const hasRelevance = lex > 0 || vec >= 0.3;
      const rawEngrave = (ep.userPinned ? 0.1 : 0) + (ep.selfImportant ? 0.1 : 0) + Math.min(0.1, Math.max(0, (ep.mentionCount ?? 1) - 1) * 0.04);
      const engraveBoost = hasRelevance ? rawEngrave : 0;
      const relevance = queryVec ? 0.52 * vec + 0.2 * lex : 0.56 * lex;
      const rawTrace = 0.18 * ret.retention + 0.1 * imp + engraveBoost * (0.4 + 0.6 * ret.retention);
      const memoryTrace = hasRelevance ? rawTrace : rawTrace * 0.25;
      const score = (relevance + memoryTrace) * (0.45 + 0.55 * ret.retention) * provenanceWeight(ep.provenance);
      const { recallReason, channels } = describeRecallReasons({
        semanticSim: vec, lexicalSim: lex, userPinned: ep.userPinned, selfImportant: ep.selfImportant,
        mentionCount: ep.mentionCount, arousal: ep.arousal, recallCount: ep.recallCount,
      });
      candidates.push({
        id: ep.id, kind: 'episode', seq: ep.seq, score, bodyType: ep.bodyType, provenance: ep.provenance,
        timestamp: ep.timestamp, title: ep.title, text: ep.summary, retentionPct: ret.retentionPct,
        strength: ret.strength, recallCount: ep.recallCount ?? 0, mentionCount: ep.mentionCount ?? 1,
        semanticSim: Number(vec.toFixed(3)), lexicalSim: Number(lex.toFixed(3)),
        ...(ep.userPinned ? { userPinned: true } : {}), ...(ep.selfImportant ? { selfImportant: true } : {}),
        recallReason, recallChannels: channels,
      });
    }

    for (const j of archive.recentJournal.slice(-40)) {
      if (j.role === 'system') continue;
      const lex = lexicalSimilarityFromTokens(queryTokens, j.text);
      if (lex <= 0) continue;
      const ret = computeRetention({ timestamp: j.timestamp, strength: Math.max(2, (j.importance ?? 45) / 15) }, nowMs);
      const score = (0.55 * lex + 0.15 * ret.retention) * provenanceWeight(j.provenance);
      const { recallReason, channels } = describeRecallReasons({ lexicalSim: lex });
      candidates.push({
        kind: 'journal', seq: j.seq, score, bodyType: j.bodyType, provenance: j.provenance,
        timestamp: j.timestamp, title: `${j.speaker} (${j.bodyType})`, text: j.text,
        retentionPct: ret.retentionPct, strength: ret.strength, recallCount: 0, mentionCount: 1,
        semanticSim: 0, lexicalSim: Number(lex.toFixed(3)), recallReason, recallChannels: channels,
      });
    }

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
    if (!options?.embedding) return { ok: true, skipped: true, reason: '未传入 embedding 配置' };
    return (await syncVectorIndexDetailed(archiveDir, options.embedding)) as unknown as Record<string, unknown>;
  }

  async health(_archiveDir: string, options?: { embedding?: EmbeddingConfig }): Promise<MemoryRetrieverHealth> {
    if (!options?.embedding?.enabled) {
      return { ok: true, retrieverId: this.id, name: this.name, detail: '词法+艾宾浩斯常驻就绪（向量增强未开启）' };
    }
    const rep = await checkEmbeddingHealth(options.embedding);
    return {
      ok: true, retrieverId: this.id, name: this.name,
      detail: rep.ok ? `向量模型 ${rep.model} (${rep.dims}维) 在线` : `向量离线自动降级词法检索: ${rep.error || '不可达'}`,
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
