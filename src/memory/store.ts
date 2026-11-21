import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  allocateSeq,
  appendJsonlLine,
  readJsonArrayStrict,
  readJsonObjectSafe,
  readJsonlSafe,
  refreshDerivedSoulFiles,
  renderEpisodesMarkdown,
  resolveArchivePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from '../soul/archive.ts';
import type {
  BodyType,
  CoBecomingNote,
  Commitment,
  MemoryEpisode,
  Provenance,
  Relation,
} from '../soul/types.ts';
import { upsertPersonRelation } from './relations.ts';
import { computeInitialStrength } from './retention.ts';

export { renderEpisodesMarkdown };

const LARGE_EPISODES_BYTES = 256 * 1024;

export function addEpisode(
  dir: string,
  input: {
    bodyType: BodyType;
    bodyId: string;
    title: string;
    summary: string;
    participants?: string[];
    importance?: number;
    provenance?: Provenance;
    tags?: string[];
    timestamp?: string;
    skipRefresh?: boolean;
    valence?: number;
    arousal?: number;
    strength?: number;
    recallCount?: number;
    mentionCount?: number;
    lastRecalledAt?: string;
    userPinned?: boolean;
    selfImportant?: boolean;
    selfImportantReason?: string;
  },
): MemoryEpisode {
  const p = resolveArchivePaths(dir);
  const provenance: Provenance = input.provenance || 'verified';
  const seq = allocateSeq(dir, provenance);
  const timestamp = input.timestamp || new Date().toISOString();
  const importance = Math.max(1, Math.min(100, Math.round(input.importance ?? 65)));
  const strength = input.strength && input.strength > 0
    ? input.strength
    : computeInitialStrength({
        importance,
        arousal: input.arousal,
        valence: input.valence,
        userPinned: input.userPinned,
        selfImportant: input.selfImportant,
        mentionCount: input.mentionCount,
        recallCount: input.recallCount,
      });
  const ep: MemoryEpisode = {
    id: `ep_${crypto.randomUUID().slice(0, 10)}`,
    seq,
    timestamp,
    bodyType: input.bodyType,
    bodyId: input.bodyId,
    title: input.title.trim(),
    summary: input.summary.trim(),
    participants: input.participants ?? [],
    importance,
    provenance,
    tags: input.tags ?? [],
    ...(input.valence !== undefined ? { valence: input.valence } : {}),
    ...(input.arousal !== undefined ? { arousal: input.arousal } : {}),
    strength,
    recallCount: input.recallCount ?? 0,
    mentionCount: input.mentionCount ?? 1,
    lastRecalledAt: input.lastRecalledAt ?? timestamp,
    ...(input.userPinned ? { userPinned: true } : {}),
    ...(input.selfImportant ? { selfImportant: true } : {}),
    ...(input.selfImportantReason ? { selfImportantReason: input.selfImportantReason.trim() } : {}),
  };
  appendJsonlLine(p.episodesJsonl, ep);
  if (!input.skipRefresh) {
    const fileSize = fs.existsSync(p.episodesJsonl) ? fs.statSync(p.episodesJsonl).size : 0;
    if (fileSize <= LARGE_EPISODES_BYTES) {
      const all = readJsonlSafe<MemoryEpisode>(p.episodesJsonl);
      const meta = readJsonObjectSafe<{ name?: string }>(p.meta, {});
      writeTextAtomic(p.episodesMd, renderEpisodesMarkdown(meta.name || 'Soul', all));
    }
    refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
  }
  return ep;
}

export function upsertCommitment(
  dir: string,
  input: {
    title: string;
    detail: string;
    sourceBodyType: BodyType;
    provenance?: Provenance;
    status?: 'active' | 'done';
    skipRefresh?: boolean;
  },
): Commitment {
  const p = resolveArchivePaths(dir);
  const normTitle = String(input.title ?? '').trim();
  if (!normTitle) throw new Error('约定标题不能为空');
  const list = readJsonArrayStrict<Commitment>(p.commitments, [], 'MEMORIES/commitments.json');
  const now = new Date().toISOString();
  const existing = list.find(
    (c) => c.status === 'active' && (
      c.title === normTitle
      || (normTitle.length >= 2 && c.title.includes(normTitle))
      || (c.title.length >= 2 && normTitle.includes(c.title))
    ),
  );
  if (existing) {
    existing.detail = String(input.detail ?? '').trim() || existing.detail;
    existing.updatedAt = now;
    existing.sourceBodyType = input.sourceBodyType;
    if (input.status) existing.status = input.status;
    writeJsonAtomic(p.commitments, list);
    if (!input.skipRefresh) refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
    return existing;
  }
  const provenance: Provenance = input.provenance || 'verified';
  const item: Commitment = {
    id: `cmt_${crypto.randomUUID().slice(0, 10)}`,
    seq: allocateSeq(dir, provenance),
    createdAt: now,
    updatedAt: now,
    sourceBodyType: input.sourceBodyType,
    title: normTitle,
    detail: String(input.detail ?? '').trim() || normTitle,
    status: input.status || 'active',
    provenance,
  };
  list.push(item);
  writeJsonAtomic(p.commitments, list);
  if (!input.skipRefresh) refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
  return item;
}

export function completeCommitment(dir: string, idOrKeyword: string): Commitment | null {
  const key = String(idOrKeyword ?? '').trim();
  if (!key) return null;
  const p = resolveArchivePaths(dir);
  const list = readJsonArrayStrict<Commitment>(p.commitments, [], 'MEMORIES/commitments.json');
  const target = list.find(
    (c) => c.status === 'active' && (c.id === key || c.title === key || (key.length >= 2 && c.title.includes(key))),
  );
  if (!target) return null;
  target.status = 'done';
  target.updatedAt = new Date().toISOString();
  writeJsonAtomic(p.commitments, list);
  refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
  return target;
}

export function upsertRelation(
  dir: string,
  input: {
    personId?: string;
    entityId: string;
    name: string;
    role: string;
    bondSummary: string;
    familiarity?: number;
    provenance?: Provenance;
  },
): Relation {
  return upsertPersonRelation(dir, input);
}

export function addCoBecoming(
  dir: string,
  input: {
    soulShift: string;
    partnerShift: string;
    reflection: string;
    provenance?: Provenance;
    skipRefresh?: boolean;
  },
): CoBecomingNote {
  const p = resolveArchivePaths(dir);
  const provenance: Provenance = input.provenance || 'verified';
  const note: CoBecomingNote = {
    seq: allocateSeq(dir, provenance),
    timestamp: new Date().toISOString(),
    soulShift: input.soulShift.trim(),
    partnerShift: input.partnerShift.trim(),
    reflection: input.reflection.trim(),
    provenance,
  };
  appendJsonlLine(p.coBecoming, note);
  if (!input.skipRefresh) refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
  return note;
}
