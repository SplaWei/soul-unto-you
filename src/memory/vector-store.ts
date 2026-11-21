import { readJsonSafe, readJsonlSafe, resolveArchivePaths, writeJsonAtomic } from '../soul/archive.ts';
import type { LivedExperience, MemoryEpisode } from '../soul/types.ts';

export interface EmbeddingConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface VectorIndexFile {
  model: string;
  items: Record<string, number[]>;
  updatedAt: string;
}

export interface VectorSyncReport {
  ok: boolean;
  indexed: number;
  episodesIndexed: number;
  experiencesIndexed: number;
  totalVectors: number;
  model: string;
  fallbackReason?: string;
}

export interface EmbeddingHealthReport {
  ok: boolean;
  enabled: boolean;
  endpoint: string;
  model: string;
  dimensions?: number;
  latencyMs: number;
  detail: string;
}

/** 计算两个向量的余弦相似度，结果限制在 [0, 1]。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

function buildEmbeddingsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '').replace(/\/embeddings$/, '');
  return base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

/** 调用 OpenAI 兼容 /v1/embeddings 接口获取向量，不可达时静默返回 null。 */
export async function fetchEmbeddings(
  texts: string[],
  cfg?: EmbeddingConfig,
): Promise<number[][] | null> {
  if (!cfg?.enabled || !cfg.endpoint || !cfg.model || !texts.length) return null;
  const url = buildEmbeddingsUrl(cfg.endpoint);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    if (!Array.isArray(data?.data) || data.data.length !== texts.length) return null;
    const vectors = data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((row) => (Array.isArray(row.embedding) ? row.embedding : []));
    return vectors.some((v) => v.length > 0) ? vectors : null;
  } catch {
    return null;
  }
}

/** 探测本地或远程向量服务连通性，绝不抛错阻塞主流程。 */
export async function checkEmbeddingHealth(cfg?: EmbeddingConfig): Promise<EmbeddingHealthReport> {
  const endpoint = String(cfg?.endpoint || '');
  const model = String(cfg?.model || '');
  if (!cfg?.enabled) {
    return {
      ok: false,
      enabled: false,
      endpoint,
      model,
      latencyMs: 0,
      detail: '尚未开启千问向量检索（当前使用零依赖关键词检索）',
    };
  }
  const startedAt = Date.now();
  const timeoutMs = cfg.timeoutMs ?? 15000;
  const vecs = await fetchEmbeddings(['灵魂记忆语义连通性检测'], { ...cfg, timeoutMs });
  const latencyMs = Date.now() - startedAt;
  const dim = vecs?.[0]?.length ?? 0;
  if (dim > 0) {
    return {
      ok: true,
      enabled: true,
      endpoint,
      model,
      dimensions: dim,
      latencyMs,
      detail: `已连通 ${model}（${dim} 维，耗时 ${latencyMs}ms）`,
    };
  }
  return {
    ok: false,
    enabled: true,
    endpoint,
    model,
    latencyMs,
    detail: '本地向量服务未连通（已自动静默降级为关键词检索）',
  };
}

/** 读取与当前配置模型匹配的向量缓存文件。 */
export function loadVectorIndex(dir: string, cfg?: EmbeddingConfig): VectorIndexFile | null {
  if (!cfg?.enabled || !cfg.model) return null;
  const p = resolveArchivePaths(dir);
  const file = readJsonSafe<VectorIndexFile | null>(p.vectors, null);
  if (!file || file.model !== cfg.model || !file.items) return null;
  return file;
}

const syncInFlightByDir = new Map<string, Promise<VectorSyncReport>>();
const syncPendingByDir = new Map<string, boolean>();

/** 为情景记忆与亲历体验生成增量向量索引，服务不可达时无损降级（自动合并并发排队与支持过期取消）。 */
export function syncVectorIndexDetailed(
  dir: string,
  cfg?: EmbeddingConfig,
  options: { maxItems?: number; shouldAbort?: () => boolean } = {},
): Promise<VectorSyncReport> {
  const key = resolveArchivePaths(dir).root;
  const active = syncInFlightByDir.get(key);
  if (active) {
    syncPendingByDir.set(key, true);
    return active.then(() => {
      if (syncPendingByDir.get(key)) {
        syncPendingByDir.delete(key);
        return syncVectorIndexDetailed(dir, cfg, options);
      }
      return syncInFlightByDir.get(key) ?? runSyncVectorIndex(dir, cfg, options);
    });
  }
  const task = runSyncVectorIndex(dir, cfg, options).finally(() => {
    if (syncInFlightByDir.get(key) === task) syncInFlightByDir.delete(key);
  });
  syncInFlightByDir.set(key, task);
  return task;
}

async function runSyncVectorIndex(
  dir: string,
  cfg?: EmbeddingConfig,
  options: { maxItems?: number; shouldAbort?: () => boolean } = {},
): Promise<VectorSyncReport> {
  const model = String(cfg?.model || '');
  if (!cfg?.enabled || !cfg.endpoint || !model) {
    return { ok: false, indexed: 0, episodesIndexed: 0, experiencesIndexed: 0, totalVectors: 0, model, fallbackReason: 'disabled' };
  }
  if (options.shouldAbort?.()) {
    return { ok: false, indexed: 0, episodesIndexed: 0, experiencesIndexed: 0, totalVectors: 0, model, fallbackReason: 'aborted' };
  }
  const p = resolveArchivePaths(dir);
  const episodes = readJsonlSafe<MemoryEpisode>(p.episodesJsonl);
  const experiences = readJsonlSafe<LivedExperience>(p.experiences);
  const validIds = new Set([...episodes.map((e) => e.id), ...experiences.map((e) => e.id)]);

  const existing = readJsonSafe<VectorIndexFile>(p.vectors, { model, items: {}, updatedAt: '' });
  const sameModel = existing.model === model && Boolean(existing.items);
  const items: Record<string, number[]> = {};
  if (sameModel) {
    for (const [id, vec] of Object.entries(existing.items)) {
      if (validIds.has(id) && Array.isArray(vec) && vec.length) items[id] = vec;
    }
  }
  const pruned = sameModel && Object.keys(items).length !== Object.keys(existing.items).length;

  const missing: Array<{ kind: 'episode' | 'experience'; id: string; text: string }> = [];
  for (const ep of episodes) {
    if (!items[ep.id]) {
      const tags = ep.tags?.length ? `\n${ep.tags.join(' ')}` : '';
      missing.push({ kind: 'episode', id: ep.id, text: `${ep.title}\n${ep.summary}${tags}` });
    }
  }
  for (const exp of experiences) {
    if (!items[exp.id]) {
      const tags = exp.tags?.length ? `\n${exp.tags.join(' ')}` : '';
      missing.push({ kind: 'experience', id: exp.id, text: `${exp.stimulus}\n${exp.realityOutcome}\n${exp.lesson}${tags}` });
    }
  }

  const batch = missing.slice(0, options.maxItems ?? 64);
  if (!batch.length) {
    if (pruned) {
      if (options.shouldAbort?.()) {
    return { ok: false, indexed: 0, episodesIndexed: 0, experiencesIndexed: 0, totalVectors: Object.keys(items).length, model, fallbackReason: 'aborted' };
  }
  writeJsonAtomic(p.vectors, { model, items, updatedAt: new Date().toISOString() });
    }
    return {
      ok: true,
      indexed: 0,
      episodesIndexed: 0,
      experiencesIndexed: 0,
      totalVectors: Object.keys(items).length,
      model,
    };
  }

  let episodesIndexed = 0;
  let experiencesIndexed = 0;
  for (let offset = 0; offset < batch.length; offset += 32) {
    const chunk = batch.slice(offset, offset + 32);
    const vectors = await fetchEmbeddings(chunk.map((c) => c.text), cfg);
    if (!vectors) {
      if (episodesIndexed + experiencesIndexed === 0) {
        return {
          ok: false,
          indexed: 0,
          episodesIndexed: 0,
          experiencesIndexed: 0,
          totalVectors: Object.keys(items).length,
          model,
          fallbackReason: 'unreachable',
        };
      }
      break;
    }
    chunk.forEach((entry, i) => {
      if (vectors[i]?.length) {
        items[entry.id] = vectors[i];
        if (entry.kind === 'episode') episodesIndexed += 1;
        else experiencesIndexed += 1;
      }
    });
  }

  if (options.shouldAbort?.()) {
    return { ok: false, indexed: 0, episodesIndexed: 0, experiencesIndexed: 0, totalVectors: Object.keys(items).length, model, fallbackReason: 'aborted' };
  }
  writeJsonAtomic(p.vectors, { model, items, updatedAt: new Date().toISOString() });
  const indexed = episodesIndexed + experiencesIndexed;
  return {
    ok: true,
    indexed,
    episodesIndexed,
    experiencesIndexed,
    totalVectors: Object.keys(items).length,
    model,
  };
}

/** 增量同步本地向量索引，返回新增向量条数。 */
export async function syncVectorIndex(dir: string, cfg?: EmbeddingConfig): Promise<number> {
  return (await syncVectorIndexDetailed(dir, cfg)).indexed;
}
