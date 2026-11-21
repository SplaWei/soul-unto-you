import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  bindPersonHandle,
  findPerson,
  listRelations,
  mergePersons,
  normalizeChannel,
  unbindPersonHandle,
  upsertPersonRelation,
  type UpsertRelationInput,
} from '../memory/relations.ts';

export interface RelationsHubLike {
  config: { archiveDir: string };
  presence: { withSoulLock: <T>(task: () => Promise<T>) => Promise<T> };
}

/** 处理 Phase 5.5b 中性跨端实体身份图接口（personId 聚合、绑定、解绑、合并）。 */
export async function handleRelationsHttpRoute(
  hub: RelationsHubLike,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  readJsonBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/relations') {
    const relations = listRelations(hub.config.archiveDir);
    const personId = url.searchParams.get('personId') || '';
    const channel = url.searchParams.get('channel') || '';
    const accountId = url.searchParams.get('accountId') || '';
    const name = url.searchParams.get('name') || '';
    const hasQuery = Boolean(personId || (channel && accountId) || name);
    const matched = hasQuery
      ? findPerson(relations, { personId, channel: channel ? normalizeChannel(channel) : '', accountId, name })?.person ?? null
      : undefined;
    const totalHandles = relations.reduce((s, r) => s + r.handles.length, 0);
    const crossBodyPersons = relations.filter((r) => new Set(r.handles.map((h) => h.channel)).size >= 2).length;
    sendJson(res, 200, {
      ok: true,
      relations,
      ...(matched !== undefined ? { matched } : {}),
      summary: { total: relations.length, totalHandles, crossBodyPersons },
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/relations') {
    const body = await readJsonBody<UpsertRelationInput & { allowOverwrite?: boolean }>(req);
    const cleanName = String(body.name || '').trim();
    if (!cleanName) {
      sendJson(res, 400, { ok: false, error: '人物 name 不能为空' });
      return true;
    }
    const reqId = String(body.personId || body.entityId || '').trim();
    const out = await hub.presence.withSoulLock(async () => {
      const existing = listRelations(hub.config.archiveDir);
      if (!reqId) {
        const low = cleanName.toLowerCase();
        const dup = existing.find((r) => r.name.toLowerCase() === low || r.aliases.some((a) => a.toLowerCase() === low));
        if (dup) return { conflict: true as const, error: `已存在同名人物 (${dup.personId})，禁止未指定 personId 覆盖已有档案` };
      } else if (!body.allowOverwrite && !body.handles?.length) {
        const hit = existing.find((r) => r.personId === reqId || r.entityId === reqId);
        if (hit && hit.personId === 'partner-primary' && hit.name !== cleanName) {
          return { conflict: true as const, error: '核心同行者档案不可直接覆盖改名，请显式传入 allowOverwrite=true' };
        }
      }
      return { conflict: false as const, person: upsertPersonRelation(hub.config.archiveDir, body) };
    });
    if (out.conflict) {
      sendJson(res, 409, { ok: false, error: out.error });
      return true;
    }
    sendJson(res, 200, { ok: true, person: out.person });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/relations/bind') {
    const body = await readJsonBody<{
      personId: string; channel: string; accountId: string;
      displayName?: string; bodyId?: string; mergeExistingOwner?: boolean;
    }>(req);
    const out = await hub.presence.withSoulLock(async () => bindPersonHandle(hub.config.archiveDir, {
      personId: String(body.personId || ''),
      channel: String(body.channel || ''),
      accountId: String(body.accountId || ''),
      displayName: body.displayName,
      bodyId: body.bodyId,
      mergeExistingOwner: body.mergeExistingOwner,
    }));
    sendJson(res, 200, { ok: true, ...out });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/relations/unbind') {
    const body = await readJsonBody<{ personId: string; channel: string; accountId: string }>(req);
    const person = await hub.presence.withSoulLock(async () => unbindPersonHandle(hub.config.archiveDir, {
      personId: String(body.personId || ''),
      channel: String(body.channel || ''),
      accountId: String(body.accountId || ''),
    }));
    sendJson(res, person ? 200 : 404, person ? { ok: true, person } : { ok: false, error: '未找到指定 personId' });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/relations/merge') {
    const body = await readJsonBody<{ targetPersonId: string; sourcePersonId: string }>(req);
    const person = await hub.presence.withSoulLock(async () =>
      mergePersons(hub.config.archiveDir, String(body.targetPersonId || ''), String(body.sourcePersonId || '')),
    );
    sendJson(res, 200, { ok: true, person });
    return true;
  }

  return false;
}
