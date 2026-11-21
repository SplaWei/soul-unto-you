import { readJsonArraySafe, readJsonArrayStrict, resolveArchivePaths } from '../soul/archive.ts';
import type { BodyType, IdentityHandle, Provenance, Relation } from '../soul/types.ts';

export type PersonMatchKind = 'person_id' | 'handle' | 'name_alias' | 'partner_primary' | 'created';

export interface NormalizedRelation extends Relation {
  personId: string;
  aliases: string[];
  handles: IdentityHandle[];
  interactionCount: number;
  tags: string[];
  notes: string[];
}

export interface PersonResolution {
  person: NormalizedRelation;
  matchedBy: PersonMatchKind;
  channel: string;
  accountId?: string;
  isNew: boolean;
}

export interface UpsertRelationInput {
  personId?: string;
  entityId?: string;
  name: string;
  role?: string;
  bondSummary?: string;
  familiarity?: number;
  aliases?: string[];
  handles?: IdentityHandle[];
  tags?: string[];
  notes?: string[];
  provenance?: Provenance;
  lastBodyType?: BodyType;
  lastSeenAt?: string;
}

const ACCOUNT_KEYS = ['accountId', 'userId', 'senderId', 'qqUserId', 'playerId', 'openId'] as const;

export function normalizeChannel(bodyType?: BodyType, metadata?: Record<string, unknown>): string {
  const metaCh = typeof metadata?.channel === 'string' ? metadata.channel.trim().toLowerCase() : '';
  if (metaCh) return metaCh;
  const bt = String(bodyType || '').trim().toLowerCase();
  if (bt && bt !== 'api') return bt;
  const plat = typeof metadata?.platform === 'string' ? metadata.platform.trim().toLowerCase() : '';
  if (plat) return plat === 'qq' ? 'chat:qq' : plat;
  return 'web';
}

export function extractAccountId(metadata?: Record<string, unknown>): string {
  if (!metadata || typeof metadata !== 'object') return '';
  for (const key of ACCOUNT_KEYS) {
    const raw = metadata[key];
    if (raw === undefined || raw === null) continue;
    const val = String(raw).trim();
    if (val && val !== 'undefined' && val !== 'null') return val;
  }
  return '';
}

export const extractPersonIdHint = (metadata?: Record<string, unknown>): string =>
  typeof metadata?.personId === 'string' ? metadata.personId.trim() : '';

function dedupeStrings(items: unknown[], exclude?: string): string[] {
  const seen = new Set<string>();
  const excl = exclude?.trim().toLowerCase();
  const out: string[] = [];
  for (const item of items) {
    const s = String(item ?? '').trim();
    const low = s.toLowerCase();
    if (!s || low === excl || seen.has(low)) continue;
    seen.add(low);
    out.push(s);
  }
  return out;
}

export function dedupeHandles(items: IdentityHandle[]): IdentityHandle[] {
  const map = new Map<string, IdentityHandle>();
  for (const h of items) {
    const channel = String(h?.channel ?? '').trim().toLowerCase();
    const accountId = String(h?.accountId ?? '').trim();
    if (!channel || !accountId) continue;
    const key = `${channel}::${accountId}`;
    const prev = map.get(key);
    map.set(key, {
      channel,
      accountId,
      ...(h.displayName?.trim() ? { displayName: h.displayName.trim() } : prev?.displayName ? { displayName: prev.displayName } : {}),
      ...(h.bodyId?.trim() ? { bodyId: h.bodyId.trim() } : prev?.bodyId ? { bodyId: prev.bodyId } : {}),
      ...(h.lastSeenAt?.trim() ? { lastSeenAt: h.lastSeenAt.trim() } : prev?.lastSeenAt ? { lastSeenAt: prev.lastSeenAt } : {}),
    });
  }
  return [...map.values()];
}

export function normalizeRelation(raw: Relation): NormalizedRelation {
  const name = String(raw.name || '未命名对象').trim();
  const personId = String(raw.personId || raw.entityId || 'person_unknown').trim();
  const entityId = String(raw.entityId || personId).trim();
  const famRaw = Number(raw.familiarity);
  return {
    ...raw,
    entityId,
    personId,
    name,
    role: String(raw.role || '互动者').trim(),
    bondSummary: String(raw.bondSummary || '').trim(),
    familiarity: Math.max(0, Math.min(100, Math.round(Number.isFinite(famRaw) ? famRaw : 50))),
    provenance: raw.provenance || 'verified',
    updatedAt: raw.updatedAt || new Date().toISOString(),
    aliases: dedupeStrings(raw.aliases ?? [], name),
    handles: dedupeHandles(raw.handles ?? []),
    interactionCount: Math.max(0, Math.round(Number(raw.interactionCount) || 0)),
    tags: dedupeStrings(raw.tags ?? []),
    notes: dedupeStrings(raw.notes ?? []).slice(-12),
  };
}

export function loadNormalizedRelations(dir: string, strict = false): NormalizedRelation[] {
  const fp = resolveArchivePaths(dir).relations;
  const raw = strict
    ? readJsonArrayStrict<Relation>(fp, [], 'MEMORIES/relations.json')
    : readJsonArraySafe<Relation>(fp, []);
  return raw.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map(normalizeRelation);
}

export function mergeIntoTarget(target: NormalizedRelation, source: NormalizedRelation, nowIso: string): NormalizedRelation {
  const bondSummary = source.bondSummary && !target.bondSummary.includes(source.bondSummary)
    ? (target.bondSummary ? `${target.bondSummary}；${source.bondSummary}` : source.bondSummary)
    : target.bondSummary;
  const newerSource = (source.lastSeenAt || '') > (target.lastSeenAt || '');
  return normalizeRelation({
    ...target,
    bondSummary,
    familiarity: Math.max(target.familiarity, source.familiarity),
    interactionCount: target.interactionCount + source.interactionCount,
    aliases: [...target.aliases, source.name, ...source.aliases],
    handles: [...target.handles, ...source.handles],
    tags: [...target.tags, ...source.tags],
    notes: [...target.notes, ...source.notes],
    lastSeenAt: newerSource ? source.lastSeenAt : target.lastSeenAt,
    lastBodyType: newerSource && source.lastBodyType ? source.lastBodyType : target.lastBodyType,
    updatedAt: nowIso,
  });
}
