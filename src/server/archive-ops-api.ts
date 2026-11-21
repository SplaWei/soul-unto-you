import type { IncomingMessage, ServerResponse } from 'node:http';
import { flushPendingReinforcements } from '../memory/retention.ts';
import { exportSoulArchive, exportSoulArchiveToDir } from '../soul/export.ts';
import { createSnapshot, deleteSnapshot, listSnapshots, rollbackToSnapshot } from '../soul/snapshot.ts';
import type { PresenceState } from '../soul/types.ts';
import { REPO_ROOT } from './config.ts';
import { clearDebouncedVectorSync } from './percept-helpers.ts';
import { assertSafeArchiveDir } from './security.ts';

export interface ArchiveOpsHubLike {
  config: { archiveDir: string };
  presence: {
    withSoulLock: <T>(task: () => Promise<T>) => Promise<T>;
    reload: () => PresenceState;
    bumpEpoch?: () => number;
  };
  events: { emit: (event: string, payload: unknown) => void };
  ws: { broadcastJson: (payload: unknown) => void } | null;
}

/** 处理 Phase 5.5c 只读导出（含可选脱敏）、时间点快照与回滚路由。 */
export async function handleArchiveOpsHttpRoute(
  hub: ArchiveOpsHubLike,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  readJsonBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/archive/export') {
    flushPendingReinforcements();
    const redact = url.searchParams.get('redact') === '1' || url.searchParams.get('redact') === 'true';
    const includeDiary = url.searchParams.get('includeDiary') !== '0' && url.searchParams.get('includeDiary') !== 'false';
    const bundle = exportSoulArchive(hub.config.archiveDir, { redact, includeDiary });
    sendJson(res, 200, { ok: true, bundle });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/export') {
    flushPendingReinforcements();
    const body = await readJsonBody<{
      redact?: boolean; includeDiary?: boolean; extraRedactTerms?: string[]; targetDir?: string;
    }>(req);
    const opts = {
      redact: Boolean(body.redact),
      includeDiary: body.includeDiary !== false,
      extraRedactTerms: Array.isArray(body.extraRedactTerms) ? body.extraRedactTerms.map(String) : undefined,
    };
    if (body.targetDir) {
      const safeDir = assertSafeArchiveDir(body.targetDir, hub.config.archiveDir, REPO_ROOT);
      const exported = exportSoulArchiveToDir(hub.config.archiveDir, safeDir, opts);
      sendJson(res, 200, { ok: true, exported });
      return true;
    }
    sendJson(res, 200, { ok: true, bundle: exportSoulArchive(hub.config.archiveDir, opts) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/archive/snapshots') {
    sendJson(res, 200, { ok: true, snapshots: listSnapshots(hub.config.archiveDir) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/snapshots') {
    const body = await readJsonBody<{ label?: string; reason?: string }>(req);
    const snapshot = await hub.presence.withSoulLock(async () => {
      flushPendingReinforcements();
      return createSnapshot(hub.config.archiveDir, { label: body.label, reason: body.reason });
    });
    sendJson(res, 200, { ok: true, snapshot });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/rollback') {
    const body = await readJsonBody<{ snapshotId?: string; createSafetySnapshot?: boolean }>(req);
    const out = await hub.presence.withSoulLock(async () => {
      flushPendingReinforcements();
      clearDebouncedVectorSync(hub.config.archiveDir);
      hub.presence.bumpEpoch?.();
      const result = rollbackToSnapshot(hub.config.archiveDir, String(body.snapshotId || ''), {
        createSafetySnapshot: body.createSafetySnapshot,
      });
      const presence = hub.presence.reload();
      return { result, presence };
    });
    hub.ws?.broadcastJson({ type: 'presence', presence: out.presence });
    hub.events.emit('archive.rollback', out.result);
    sendJson(res, 200, { ...out.result, presence: out.presence });
    return true;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/archive/snapshots/')) {
    const rawId = pathname.slice('/api/archive/snapshots/'.length);
    const id = decodeURIComponent(rawId);
    const deleted = await hub.presence.withSoulLock(async () => deleteSnapshot(hub.config.archiveDir, id));
    sendJson(res, deleted ? 200 : 404, { ok: deleted, deleted });
    return true;
  }

  return false;
}
