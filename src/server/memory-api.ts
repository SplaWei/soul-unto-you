import type { IncomingMessage, ServerResponse } from 'node:http';
import { computeRetention, pinEpisodeById } from '../memory/retention.ts';
import { BUILTIN_HYBRID_RETRIEVER, listMemoryRetrievers, type MemoryRetriever } from '../memory/search.ts';
import { addEpisode } from '../memory/store.ts';
import { checkEmbeddingHealth, syncVectorIndexDetailed, type EmbeddingConfig } from '../memory/vector-store.ts';
import { loadSoulArchive, readJsonSafe, resolveArchivePaths } from '../soul/archive.ts';
import type { BodyType } from '../soul/types.ts';

export interface MemoryHubLike {
  config: { archiveDir: string; embedding: EmbeddingConfig };
  presence: {
    withSoulLock: <T>(task: () => Promise<T>) => Promise<T>;
    getEpoch?: () => number;
  };
  retriever?: MemoryRetriever;
}

const syncQueueByDir = new Map<string, Promise<unknown>>();

function enqueueDirSync<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = resolveArchivePaths(dir).root;
  const prev = syncQueueByDir.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const tracked = next.then(() => undefined, () => undefined);
  syncQueueByDir.set(key, tracked);
  void tracked.finally(() => {
    if (syncQueueByDir.get(key) === tracked) syncQueueByDir.delete(key);
  });
  return next;
}

function mergeEmbeddingOverride(base: EmbeddingConfig, patch: Partial<EmbeddingConfig>): EmbeddingConfig {
  return {
    ...base,
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.endpoint ? { endpoint: String(patch.endpoint).trim() } : {}),
    ...(patch.model ? { model: String(patch.model).trim() } : {}),
    ...(patch.apiKey !== undefined ? { apiKey: String(patch.apiKey).trim() } : {}),
  };
}

/** 处理 Phase 4 向量健康探测、同步、艾宾浩斯保留率与主动铭记接口。 */
export async function handleMemoryHttpRoute(
  hub: MemoryHubLike,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _url: URL,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  readJsonBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>,
): Promise<boolean> {
  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/embedding/health') {
    const patch = req.method === 'POST' ? await readJsonBody<Partial<EmbeddingConfig>>(req).catch(() => ({})) : {};
    const embCfg = mergeEmbeddingOverride(hub.config.embedding, patch);
    const report = await checkEmbeddingHealth(embCfg);
    const idx = readJsonSafe<{ items?: Record<string, unknown> } | null>(resolveArchivePaths(hub.config.archiveDir).vectors, null);
    sendJson(res, 200, { ...report, totalVectors: idx?.items ? Object.keys(idx.items).length : 0 });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/embedding/sync') {
    const patch = await readJsonBody<Partial<EmbeddingConfig>>(req).catch(() => ({}));
    const embCfg = mergeEmbeddingOverride(hub.config.embedding, patch);
    const startEpoch = hub.presence.getEpoch?.() ?? 0;
    const report = await enqueueDirSync(hub.config.archiveDir, () =>
      syncVectorIndexDetailed(hub.config.archiveDir, embCfg, {
        shouldAbort: () => Boolean(hub.presence.getEpoch && hub.presence.getEpoch() !== startEpoch),
      }),
    );
    sendJson(res, 200, report);
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/memory/retriever') {
    const active = hub.retriever ?? BUILTIN_HYBRID_RETRIEVER;
    const health = active.health
      ? await active.health(hub.config.archiveDir, { embedding: hub.config.embedding })
      : { ok: true, retrieverId: active.id, name: active.name, detail: '活跃检索器未声明 health 探针' };
    sendJson(res, 200, {
      ok: true,
      active: { id: active.id, name: active.name, isExternal: Boolean(active.isExternal) },
      health,
      registered: listMemoryRetrievers().map((r) => ({ id: r.id, name: r.name, isExternal: Boolean(r.isExternal) })),
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/memory/retriever/sync') {
    const active = hub.retriever ?? BUILTIN_HYBRID_RETRIEVER;
    const startEpoch = hub.presence.getEpoch?.() ?? 0;
    const report = await enqueueDirSync(hub.config.archiveDir, async () => (
      active.sync
        ? active.sync(hub.config.archiveDir, { embedding: hub.config.embedding })
        : syncVectorIndexDetailed(hub.config.archiveDir, hub.config.embedding, {
            shouldAbort: () => Boolean(hub.presence.getEpoch && hub.presence.getEpoch() !== startEpoch),
          })
    ));
    sendJson(res, 200, { ok: true, retrieverId: active.id, report });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/memory/retention') {
    const nowMs = Date.now();
    const archive = loadSoulArchive(hub.config.archiveDir, 5);
    const episodes = archive.episodes.map((ep) => ({ ...ep, ...computeRetention(ep, nowMs) })).sort((a, b) => b.retention - a.retention || b.seq - a.seq);
    const experiences = archive.experiences.map((exp) => ({ ...exp, ...computeRetention(exp, nowMs) })).sort((a, b) => b.retention - a.retention || b.seq - a.seq);
    const avgRetentionPct = episodes.length ? Math.round(episodes.reduce((s, e) => s + e.retentionPct, 0) / episodes.length) : 100;
    sendJson(res, 200, {
      ok: true, episodes, experiences,
      summary: {
        totalEpisodes: episodes.length, totalExperiences: experiences.length,
        pinnedCount: episodes.filter((e) => e.userPinned).length,
        selfImportantCount: episodes.filter((e) => e.selfImportant).length,
        repeatedCount: episodes.filter((e) => (e.mentionCount ?? 1) >= 2).length,
        avgRetentionPct,
      },
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/memory/pin') {
    const body = await readJsonBody<{ episodeId?: string; title?: string; summary?: string; bodyType?: BodyType; userPinned?: boolean; selfImportant?: boolean; reason?: string }>(req);
    const out = await hub.presence.withSoulLock(async () => {
      const userPinned = body.userPinned !== undefined ? body.userPinned : body.selfImportant ? undefined : true;
      if (body.episodeId) return pinEpisodeById(hub.config.archiveDir, body.episodeId, { userPinned, selfImportant: body.selfImportant, reason: body.reason });
      if (!String(body.title || body.summary || '').trim()) return null;
      const ep = addEpisode(hub.config.archiveDir, {
        bodyType: body.bodyType || 'web', bodyId: 'web-pin',
        title: String(body.title || body.summary).trim().slice(0, 40),
        summary: String(body.summary || body.title).trim(),
        importance: 92, arousal: 0.82, userPinned: userPinned ?? false,
        selfImportant: Boolean(body.selfImportant), selfImportantReason: body.reason,
        tags: [userPinned === false ? 'self-important' : 'user-pinned'],
      });
      return { episode: ep, retention: computeRetention(ep) };
    });
    sendJson(res, out ? 200 : 400, out ? { ok: true, ...out } : { ok: false, error: '未找到指定记忆或缺少 title/summary' });
    return true;
  }
  return false;
}
