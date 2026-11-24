export type RerankProtocol = 'auto' | 'standard' | 'dashscope';

export interface RerankConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  topN?: number;
  minScore?: number;
  protocol?: RerankProtocol;
}

export interface RerankHit {
  index: number;
  score: number;
}

export type RerankFallbackReason =
  | 'disabled'
  | 'missing_api_key'
  | 'invalid_endpoint'
  | 'http_error'
  | 'unreachable'
  | 'invalid_response';

export interface RerankResponse {
  ok: boolean;
  applied: boolean;
  results: RerankHit[];
  model: string;
  latencyMs: number;
  fallbackReason?: RerankFallbackReason;
  detail?: string;
}

export interface RerankHealthReport {
  ok: boolean;
  enabled: boolean;
  endpoint: string;
  model: string;
  latencyMs: number;
  detail: string;
  fallbackReason?: string;
}

const METADATA_HOSTS = new Set([
  '0.0.0.0',
  '::',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** 判断端点 URL 是否为安全的本机回环地址（拦截云元数据与非 HTTP 协议）。 */
export function isLoopbackEndpointUrl(rawUrl: string): boolean {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || METADATA_HOSTS.has(host) || host.endsWith('.metadata.internal')) return false;
    return host === 'localhost' || host === '::1'
      || /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host);
  } catch {
    return false;
  }
}

/** 构造规范的 HTTP/HTTPS 端点校验；拒绝恶意协议或云元数据地址。 */
export function isValidHttpEndpointUrl(rawUrl: string): boolean {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || METADATA_HOSTS.has(host) || host.endsWith('.metadata.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

/** 自动补全标准 /v1/rerank 或 DashScope 原生文本重排地址。 */
export function buildRerankUrl(endpoint: string): string {
  const clean = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/\/(?:rerank|reranks|text-rerank)$/i.test(clean)) return clean;
  return clean.endsWith('/v1') ? `${clean}/rerank` : `${clean}/v1/rerank`;
}

function resolveRerankProtocol(url: string, protocol?: RerankProtocol): 'standard' | 'dashscope' {
  if (protocol === 'dashscope') return 'dashscope';
  if (protocol === 'standard') return 'standard';
  return /\/services\/rerank\//i.test(url) ? 'dashscope' : 'standard';
}

function parseRerankHits(raw: unknown, docCount: number): RerankHit[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    results?: unknown;
    data?: unknown;
    output?: { results?: unknown };
  };
  const rows = Array.isArray(obj.results)
    ? obj.results
    : Array.isArray(obj.output?.results)
      ? obj.output.results
      : Array.isArray(obj.data)
        ? obj.data
        : null;
  if (!rows) return null;

  const bestByIndex = new Map<number, number>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { index?: unknown; relevance_score?: unknown; score?: unknown };
    const idx = Number(r.index);
    const score = Number(r.relevance_score ?? r.score);
    if (!Number.isInteger(idx) || idx < 0 || idx >= docCount || !Number.isFinite(score)) continue;
    const prev = bestByIndex.get(idx);
    if (prev === undefined || score > prev) bestByIndex.set(idx, score);
  }
  return [...bestByIndex.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/** 调用通用 Rerank HTTP 接口（兼容 SiliconFlow / Cohere / Jina / Ollama / DashScope），不可达时安全降级。 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  cfg?: RerankConfig,
): Promise<RerankResponse> {
  const model = String(cfg?.model || '');
  const startedAt = Date.now();
  if (!cfg?.enabled || !cfg.endpoint?.trim() || !model || !documents.length) {
    return {
      ok: false, applied: false, results: [], model, latencyMs: 0,
      fallbackReason: 'disabled', detail: '未启用 Rerank 重排',
    };
  }
  if (!isValidHttpEndpointUrl(cfg.endpoint)) {
    return {
      ok: false, applied: false, results: [], model, latencyMs: 0,
      fallbackReason: 'invalid_endpoint', detail: 'Rerank 端点 URL 非法，已回退本地排序',
    };
  }
  if (!isLoopbackEndpointUrl(cfg.endpoint) && !cfg.apiKey?.trim()) {
    return {
      ok: false, applied: false, results: [], model, latencyMs: 0,
      fallbackReason: 'missing_api_key', detail: '云端 Rerank 未配置 API Key，已自动回退至本地排序',
    };
  }

  const url = buildRerankUrl(cfg.endpoint);
  const proto = resolveRerankProtocol(url, cfg.protocol);
  const topN = Math.max(1, Math.min(documents.length, Math.round(cfg.topN ?? documents.length)));
  const body = proto === 'dashscope'
    ? { model, input: { query, documents }, parameters: { top_n: topN, return_documents: false } }
    : { model, query, documents, top_n: topN, return_documents: false };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey?.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 8000),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = `Rerank HTTP ${res.status}`;
      console.warn(`[soul-rerank] ${detail} (${model})，已自动降级为本地排序`);
      return { ok: false, applied: false, results: [], model, latencyMs, fallbackReason: 'http_error', detail };
    }
    const parsed = parseRerankHits(await res.json().catch(() => null), documents.length);
    if (!parsed) {
      console.warn(`[soul-rerank] 响应缺少 results 数组 (${model})，已自动降级为本地排序`);
      return {
        ok: false, applied: false, results: [], model, latencyMs,
        fallbackReason: 'invalid_response', detail: 'Rerank 响应格式无效',
      };
    }
    return {
      ok: true, applied: true, results: parsed, model, latencyMs,
      detail: `重排精排完成 (${model}, ${latencyMs}ms)`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[soul-rerank] 请求不可达 (${model}): ${msg}`);
    return {
      ok: false, applied: false, results: [], model, latencyMs,
      fallbackReason: 'unreachable', detail: `Rerank 服务不可达（已自动降级本地排序）: ${msg}`,
    };
  }
}

/** 探测通用 Rerank 服务连通性，绝不抛错阻塞主流程。 */
export async function checkRerankHealth(cfg?: RerankConfig): Promise<RerankHealthReport> {
  const endpoint = String(cfg?.endpoint || '');
  const model = String(cfg?.model || '');
  if (!cfg?.enabled) {
    return {
      ok: false, enabled: false, endpoint, model, latencyMs: 0,
      fallbackReason: 'disabled', detail: '尚未开启 Rerank 精排（当前使用 FTS5 + 向量混合排序）',
    };
  }
  const probe = await rerankDocuments('我喜欢喝拿铁', ['我最近改喝拿铁了', '今天天气不错'], {
    ...cfg,
    timeoutMs: cfg.timeoutMs ?? 12_000,
    topN: 2,
  });
  if (probe.ok && probe.applied) {
    return {
      ok: true, enabled: true, endpoint, model, latencyMs: probe.latencyMs,
      detail: `Rerank 已连通 ${model}（耗时 ${probe.latencyMs}ms）`,
    };
  }
  return {
    ok: false, enabled: true, endpoint, model, latencyMs: probe.latencyMs,
    fallbackReason: probe.fallbackReason,
    detail: probe.detail || 'Rerank 服务未连通（已自动回退本地排序）',
  };
}
