import crypto from 'node:crypto';
import { resolveArchivePaths, writeJsonAtomic } from '../soul/archive.ts';
import { createSnapshot } from '../soul/snapshot.ts';
import type { BodyType, Relation } from '../soul/types.ts';
import {
  dedupeHandles,
  extractAccountId,
  extractPersonIdHint,
  loadNormalizedRelations,
  mergeIntoTarget,
  normalizeChannel,
  normalizeRelation,
  type NormalizedRelation,
  type PersonMatchKind,
  type PersonResolution,
  type UpsertRelationInput,
} from './relations-helpers.ts';

export {
  extractAccountId,
  extractPersonIdHint,
  normalizeChannel,
  normalizeRelation,
  type NormalizedRelation,
  type PersonMatchKind,
  type PersonResolution,
  type UpsertRelationInput,
};

const GENERIC_ROLES = new Set(['互动者', '认识的人', '未命名对象', '']);

export const listRelations = (dir: string): NormalizedRelation[] =>
  loadNormalizedRelations(dir, false).sort((a, b) => b.familiarity - a.familiarity || b.interactionCount - a.interactionCount);

export function findPerson(
  list: NormalizedRelation[],
  query: { personId?: string; channel?: string; accountId?: string; name?: string },
): { person: NormalizedRelation; index: number; matchedBy: PersonMatchKind } | null {
  const qid = query.personId?.trim();
  const ch = query.channel?.trim().toLowerCase();
  const acc = query.accountId?.trim();
  if (qid) {
    const idx = list.findIndex((p) => p.personId === qid || p.entityId === qid);
    if (idx >= 0) {
      if (!acc || (ch && list[idx].handles.some((h) => h.channel === ch && h.accountId === acc))) {
        return { person: list[idx], index: idx, matchedBy: 'person_id' };
      }
    }
  }
  if (ch && acc) {
    const idx = list.findIndex((p) => p.handles.some((h) => h.channel === ch && h.accountId === acc));
    if (idx >= 0) return { person: list[idx], index: idx, matchedBy: 'handle' };
  }
  const qname = query.name?.trim().toLowerCase();
  if (!acc && qname) {
    const idx = list.findIndex((p) => p.name.toLowerCase() === qname || p.aliases.some((a) => a.toLowerCase() === qname));
    if (idx >= 0) return { person: list[idx], index: idx, matchedBy: 'name_alias' };
  }
  return null;
}

export function upsertPersonRelation(dir: string, input: UpsertRelationInput): NormalizedRelation {
  const p = resolveArchivePaths(dir);
  const list = loadNormalizedRelations(dir, true);
  const nowIso = new Date().toISOString();
  const incomingHandles = dedupeHandles(input.handles ?? []);
  const reqId = input.personId?.trim() || input.entityId?.trim();
  let idx = reqId ? list.findIndex((r) => r.personId === reqId || r.entityId === reqId) : -1;
  if (idx < 0 && incomingHandles.length) {
    const keys = new Set(incomingHandles.map((h) => `${h.channel}::${h.accountId}`));
    idx = list.findIndex((r) => r.handles.some((h) => keys.has(`${h.channel}::${h.accountId}`)));
  }
  if (idx < 0 && !incomingHandles.length) {
    const lowName = input.name.trim().toLowerCase();
    idx = list.findIndex((r) => r.name.toLowerCase() === lowName || r.aliases.some((a) => a.toLowerCase() === lowName));
  }
  const prev = idx >= 0 ? list[idx] : null;
  const personId = prev?.personId || reqId || `person_${crypto.randomUUID().slice(0, 10)}`;
  const next = normalizeRelation({
    entityId: prev?.entityId || input.entityId?.trim() || personId,
    personId,
    name: input.name.trim() || prev?.name || '未命名对象',
    role: input.role?.trim() || prev?.role || '互动者',
    bondSummary: input.bondSummary?.trim() || prev?.bondSummary || '',
    familiarity: input.familiarity ?? prev?.familiarity ?? 60,
    provenance: input.provenance || prev?.provenance || 'verified',
    updatedAt: nowIso,
    aliases: [...(prev?.aliases ?? []), ...(input.aliases ?? [])],
    handles: [...(prev?.handles ?? []), ...incomingHandles],
    interactionCount: prev?.interactionCount ?? 0,
    lastBodyType: input.lastBodyType || prev?.lastBodyType,
    lastSeenAt: input.lastSeenAt || prev?.lastSeenAt,
    tags: [...(prev?.tags ?? []), ...(input.tags ?? [])],
    notes: [...(prev?.notes ?? []), ...(input.notes ?? [])],
  });
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  const ownedKeys = new Set(next.handles.map((h) => `${h.channel}::${h.accountId}`));
  if (ownedKeys.size) {
    for (const r of list) {
      if (r.personId !== next.personId) r.handles = r.handles.filter((h) => !ownedKeys.has(`${h.channel}::${h.accountId}`));
    }
  }
  writeJsonAtomic(p.relations, list);
  return next;
}

/** 做梦整理专用关系图合并：仅在唯一命中同名实体时非破坏性合并，不覆写重要角色与拉低熟悉度。 */
export function mergeDreamRelation(
  dir: string,
  input: { name: string; role?: string; bondSummary?: string; familiarity?: number },
): NormalizedRelation | null {
  const cleanName = String(input.name ?? '').trim();
  if (!cleanName) return null;
  const p = resolveArchivePaths(dir);
  const list = loadNormalizedRelations(dir, true);
  const low = cleanName.toLowerCase();
  const matches = list.filter((r) => r.name.toLowerCase() === low || r.aliases.some((a) => a.toLowerCase() === low));
  if (matches.length > 1) return null;
  const nowIso = new Date().toISOString();
  if (matches.length === 1) {
    const prev = matches[0];
    const idx = list.findIndex((r) => r.personId === prev.personId);
    const inBond = String(input.bondSummary ?? '').trim();
    const bondSummary = inBond && !prev.bondSummary.includes(inBond)
      ? (prev.bondSummary ? `${prev.bondSummary}；${inBond}` : inBond)
      : prev.bondSummary;
    const inRole = String(input.role ?? '').trim();
    const role = GENERIC_ROLES.has(prev.role) && inRole ? inRole : prev.role;
    const fam = Number.isFinite(Number(input.familiarity))
      ? Math.max(prev.familiarity, Math.min(100, Math.round(Number(input.familiarity))))
      : prev.familiarity;
    list[idx] = normalizeRelation({ ...prev, role, bondSummary, familiarity: fam, updatedAt: nowIso });
    writeJsonAtomic(p.relations, list);
    return list[idx];
  }
  const personId = `person_${crypto.randomUUID().slice(0, 10)}`;
  const created = normalizeRelation({
    entityId: personId, personId, name: cleanName, role: String(input.role ?? '').trim() || '认识的人',
    bondSummary: String(input.bondSummary ?? '').trim(),
    familiarity: Number.isFinite(Number(input.familiarity)) ? Number(input.familiarity) : 50,
    provenance: 'verified', updatedAt: nowIso,
  });
  list.push(created);
  writeJsonAtomic(p.relations, list);
  return created;
}

export function bindPersonHandle(
  dir: string,
  input: { personId: string; channel: string; accountId: string; displayName?: string; bodyId?: string; mergeExistingOwner?: boolean; nowIso?: string },
): { person: NormalizedRelation; mergedFromId?: string } {
  const personId = input.personId.trim();
  const channel = normalizeChannel(input.channel);
  const accountId = input.accountId.trim();
  if (!personId || !channel || !accountId) throw new Error('绑定跨端身份缺少 personId、channel 或 accountId');
  const p = resolveArchivePaths(dir);
  const list = loadNormalizedRelations(dir, true);
  const targetIdx = list.findIndex((r) => r.personId === personId || r.entityId === personId);
  if (targetIdx < 0) throw new Error(`未找到目标人物档案: ${personId}`);
  const nowIso = input.nowIso || new Date().toISOString();
  let target = list[targetIdx];
  let mergedFromId: string | undefined;
  const ownerIdx = list.findIndex((r) => r.personId !== target.personId && r.handles.some((h) => h.channel === channel && h.accountId === accountId));
  if (ownerIdx >= 0) {
    const owner = list[ownerIdx];
    if (input.mergeExistingOwner === true) {
      createSnapshot(dir, { label: 'auto-pre-relation-merge', reason: `绑定账号前合并 ${owner.personId} 至 ${target.personId}`, auto: true });
      target = mergeIntoTarget(target, owner, nowIso);
      mergedFromId = owner.personId;
      list.splice(ownerIdx, 1);
    } else {
      owner.handles = owner.handles.filter((h) => !(h.channel === channel && h.accountId === accountId));
    }
  }
  const finalIdx = list.findIndex((r) => r.personId === target.personId);
  target = normalizeRelation({
    ...target,
    aliases: [...target.aliases, ...(input.displayName?.trim() ? [input.displayName.trim()] : [])],
    handles: [...target.handles, { channel, accountId, displayName: input.displayName?.trim(), bodyId: input.bodyId?.trim(), lastSeenAt: nowIso }],
    updatedAt: nowIso,
  });
  list[finalIdx] = target;
  writeJsonAtomic(p.relations, list);
  return { person: target, ...(mergedFromId ? { mergedFromId } : {}) };
}

export function unbindPersonHandle(dir: string, input: { personId: string; channel: string; accountId: string }): NormalizedRelation | null {
  const personId = input.personId.trim();
  const channel = normalizeChannel(input.channel);
  const accountId = input.accountId.trim();
  const p = resolveArchivePaths(dir);
  const list = loadNormalizedRelations(dir, true);
  const idx = list.findIndex((r) => r.personId === personId || r.entityId === personId);
  if (idx < 0) return null;
  list[idx] = normalizeRelation({
    ...list[idx],
    handles: list[idx].handles.filter((h) => !(h.channel === channel && h.accountId === accountId)),
    updatedAt: new Date().toISOString(),
  });
  writeJsonAtomic(p.relations, list);
  return list[idx];
}

export function mergePersons(dir: string, targetPersonId: string, sourcePersonId: string): NormalizedRelation {
  const targetId = targetPersonId.trim();
  const sourceId = sourcePersonId.trim();
  if (!targetId || !sourceId || targetId === sourceId) throw new Error('合并人物需要两个不同的有效 personId');
  const p = resolveArchivePaths(dir);
  const list = loadNormalizedRelations(dir, true);
  const tIdx = list.findIndex((r) => r.personId === targetId || r.entityId === targetId);
  const sIdx = list.findIndex((r) => r.personId === sourceId || r.entityId === sourceId);
  if (tIdx < 0 || sIdx < 0) throw new Error('未找到待合并的目标或源人物档案');
  if (tIdx === sIdx) throw new Error('目标与源指向同一人物档案，禁止自合并');
  const merged = mergeIntoTarget(list[tIdx], list[sIdx], new Date().toISOString());
  list[tIdx] = merged;
  list.splice(sIdx, 1);
  writeJsonAtomic(p.relations, list);
  return merged;
}

export function resolveAndRecordSpeaker(
  dir: string,
  input: { bodyId: string; bodyType: BodyType; speaker: string; partnerName?: string; metadata?: Record<string, unknown>; nowIso?: string; readonly?: boolean },
): PersonResolution {
  const channel = normalizeChannel(input.bodyType, input.metadata);
  const accountId = extractAccountId(input.metadata);
  const speaker = String(input.speaker || input.partnerName || '同行者').trim();
  const nowIso = input.nowIso || new Date().toISOString();
  const list = loadNormalizedRelations(dir, !input.readonly);
  let hit = findPerson(list, { personId: extractPersonIdHint(input.metadata) || undefined, channel, accountId: accountId || undefined, name: speaker });
  if (!hit && !accountId && input.partnerName && speaker === input.partnerName.trim()) {
    const pIdx = list.findIndex((r) => r.personId === 'partner-primary' || r.entityId === 'partner-primary');
    if (pIdx >= 0) hit = { person: list[pIdx], index: pIdx, matchedBy: 'partner_primary' };
  }
  const isNew = !hit;
  const matchedBy: PersonMatchKind = hit?.matchedBy ?? 'created';
  const isPartner = !accountId && Boolean(input.partnerName) && speaker === input.partnerName?.trim();
  const initId = isPartner ? 'partner-primary' : `person_${crypto.randomUUID().slice(0, 10)}`;
  let person: NormalizedRelation = hit?.person ?? normalizeRelation({
    entityId: initId, personId: initId, name: speaker, role: isPartner ? '同行者' : '互动者',
    bondSummary: isPartner ? '与灵魂同行交流的伙伴。' : `在 [${channel}] 有过交流记录。`,
    familiarity: isPartner ? 75 : 20, provenance: 'verified', updatedAt: nowIso,
    handles: accountId ? [{ channel, accountId, displayName: speaker, bodyId: input.bodyId, lastSeenAt: nowIso }] : [],
    interactionCount: 0, lastBodyType: input.bodyType, lastSeenAt: nowIso,
  });
  const idx = hit ? hit.index : list.push(person) - 1;
  if (!input.readonly) {
    const fam = person.familiarity;
    const delta = isNew ? 0 : fam < 35 ? 3 : fam < 70 ? 2 : fam < 95 ? 1 : 0;
    person = normalizeRelation({
      ...person,
      familiarity: Math.min(100, fam + delta),
      interactionCount: person.interactionCount + 1,
      aliases: speaker !== person.name ? [...person.aliases, speaker] : person.aliases,
      handles: accountId ? [...person.handles, { channel, accountId, displayName: speaker, bodyId: input.bodyId, lastSeenAt: nowIso }] : person.handles,
      lastBodyType: input.bodyType, lastSeenAt: nowIso, updatedAt: nowIso,
    });
    list[idx] = person;
    writeJsonAtomic(resolveArchivePaths(dir).relations, list);
  }
  return { person, matchedBy, channel, ...(accountId ? { accountId } : {}), isNew };
}

export const toActivePersonTrace = (res: PersonResolution) => ({
  personId: res.person.personId, name: res.person.name, role: res.person.role,
  familiarity: res.person.familiarity, interactionCount: res.person.interactionCount,
  matchedBy: res.matchedBy, channels: [...new Set([res.channel, ...res.person.handles.map((h) => h.channel)])],
});

export function formatActivePersonPromptLine(res: PersonResolution): string {
  const channels = [...new Set([res.channel, ...res.person.handles.map((h) => h.channel)])].join('、');
  const aliasPart = res.person.aliases.length ? ` · 曾用昵称:${res.person.aliases.slice(0, 4).join('/')}` : '';
  return `- 当前对话对象：${res.person.name} [${res.person.personId}]（${res.person.role} | 熟悉度 ${res.person.familiarity}/100 | 累计互动 ${res.person.interactionCount} 次 | 已绑定端:${channels}${aliasPart}）`;
}

export const rankRelationsForPrompt = (relations: Relation[], activePersonId?: string, limit = 8): NormalizedRelation[] =>
  relations.map(normalizeRelation).sort((a, b) => {
    if (activePersonId) {
      if (a.personId === activePersonId && b.personId !== activePersonId) return -1;
      if (b.personId === activePersonId && a.personId !== activePersonId) return 1;
    }
    return b.familiarity - a.familiarity || b.interactionCount - a.interactionCount;
  }).slice(0, limit);
