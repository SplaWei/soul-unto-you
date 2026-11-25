import type { BodyType, JournalEntry, SoulMeta } from '../soul/types.ts';
import {
  buildDreamFactsPromptBlock,
  parseDreamFactOps,
  type FactOperation,
  type MemoryFact,
} from './facts.ts';

export interface ValidatedDreamPlan {
  episodes: Array<{
    title: string; summary: string; bodyType: BodyType; bodyId: string;
    importance?: number; valence?: number; arousal?: number;
    userPinned?: boolean; selfImportant?: boolean; selfImportantReason?: string;
  }>;
  commitments: Array<{ title: string; detail: string; bodyType: BodyType }>;
  completedCommitments: string[];
  relations: Array<{ name: string; role?: string; bondSummary?: string; familiarity?: number }>;
  facts?: FactOperation[];
  coBecoming?: { soulShift: string; partnerShift: string; reflection: string } | null;
}

export interface BuiltDreamPrompt {
  prompt: string;
  includedCount: number;
  lastIncludedSeq: number;
  includedEntries: JournalEntry[];
}

const MAX_TRANSCRIPT_CHARS = 16_000;

export function resolveMatchingBody(pending: JournalEntry[], rawBodyType: unknown): { bodyType: BodyType; bodyId: string } {
  const fallback = pending[pending.length - 1];
  const bt = typeof rawBodyType === 'string' ? rawBodyType.trim() : '';
  if (bt) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].bodyType === bt) return { bodyType: pending[i].bodyType, bodyId: pending[i].bodyId };
    }
  }
  return { bodyType: fallback.bodyType, bodyId: fallback.bodyId };
}

export function buildDreamConsolidationPrompt(
  meta: SoulMeta,
  pending: JournalEntry[],
  activeFacts: MemoryFact[],
): BuiltDreamPrompt {
  const lines: string[] = [];
  const includedEntries: JournalEntry[] = [];
  let totalChars = 0;
  for (const e of pending) {
    let line = `[seq:${e.seq}][${e.bodyType}:${e.bodyId}][${e.timestamp}] ${e.speaker}: ${e.text}`;
    if (lines.length === 0 && line.length > MAX_TRANSCRIPT_CHARS) {
      line = line.slice(0, MAX_TRANSCRIPT_CHARS);
    } else if (totalChars + line.length > MAX_TRANSCRIPT_CHARS) {
      break;
    }
    lines.push(line);
    includedEntries.push(e);
    totalChars += line.length + 1;
  }
  const prompt = [
    `你是「${meta.name}」的梦境记忆整理器。请把以下跨躯体新经历浓缩为 JSON（不要输出其他解释）：`,
    '{ "episodes": [{ "title": "简短标题", "summary": "保留关键人名/地点/进度/事件细节", "bodyType": "web|chat:qq|game:rimworld|robot|api", "importance": 80, "valence": 0.6, "arousal": 0.7, "selfImportant": false, "selfImportantReason": "" }],',
    '  "commitments": [{ "title": "未完成约定标题", "detail": "完整细节与后续待办", "bodyType": "game:rimworld" }],',
    '  "completedCommitments": ["已完成约定的关键词或标题"],',
    '  "relations": [{ "name": "人物名", "role": "关系定位", "bondSummary": "关系印象摘要", "familiarity": 80 }],',
    '  "facts": [{ "action": "ADD|UPDATE|DELETE|NONE", "targetId": "已有fact_xxx", "category": "residence|drink_preference|food_preference|allergy|pet|work|other", "fact": "原子陈述句", "validFrom": "优先抄对应经历的[timestamp]原值，拿不到可省略", "sourceSeqs": [1] }],',
    '  "coBecoming": { "soulShift": "她的新变化", "partnerShift": "同伴的新变化", "reflection": "共同成长感悟" } }',
    buildDreamFactsPromptBlock(activeFacts),
    '新经历如下：',
    ...lines,
  ].join('\n');
  return {
    prompt,
    includedCount: includedEntries.length,
    lastIncludedSeq: includedEntries[includedEntries.length - 1]?.seq ?? (meta.lastDreamSeq || 0),
    includedEntries,
  };
}

export function parseAndValidateDreamJson(raw: string, pending: JournalEntry[]): ValidatedDreamPlan | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(match[0]) as unknown;
    if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
    parsed = val as Record<string, unknown>;
  } catch {
    return null;
  }
  const facts = parsed.facts !== undefined ? parseDreamFactOps(parsed.facts) : undefined;
  if (parsed.facts !== undefined && facts === null) return null;
  if (!Array.isArray(parsed.episodes)) return null;
  if (!parsed.episodes.length && !(facts && facts.length)) return null;

  const episodes: ValidatedDreamPlan['episodes'] = [];
  for (const item of parsed.episodes.slice(0, 12)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const ep = item as Record<string, unknown>;
    const title = typeof ep.title === 'string' ? ep.title.trim().slice(0, 80) : '';
    const summary = typeof ep.summary === 'string' ? ep.summary.trim().slice(0, 500) : '';
    if (!title || !summary) return null;
    const matched = resolveMatchingBody(pending, ep.bodyType);
    episodes.push({
      title, summary, bodyType: matched.bodyType, bodyId: matched.bodyId,
      ...(typeof ep.importance === 'number' && Number.isFinite(ep.importance) ? { importance: ep.importance } : {}),
      ...(typeof ep.valence === 'number' && Number.isFinite(ep.valence) ? { valence: ep.valence } : {}),
      ...(typeof ep.arousal === 'number' && Number.isFinite(ep.arousal) ? { arousal: ep.arousal } : {}),
      ...(ep.userPinned ? { userPinned: true } : {}),
      ...(ep.selfImportant ? { selfImportant: true } : {}),
      ...(typeof ep.selfImportantReason === 'string' && ep.selfImportantReason.trim() ? { selfImportantReason: ep.selfImportantReason.trim().slice(0, 160) } : {}),
    });
  }

  const commitments: ValidatedDreamPlan['commitments'] = [];
  if (parsed.commitments !== undefined) {
    if (!Array.isArray(parsed.commitments)) return null;
    for (const item of parsed.commitments.slice(0, 10)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const c = item as Record<string, unknown>;
      const title = typeof c.title === 'string' ? c.title.trim().slice(0, 60) : '';
      const detail = typeof c.detail === 'string' ? c.detail.trim().slice(0, 260) : title;
      if (!title) return null;
      commitments.push({ title, detail, bodyType: resolveMatchingBody(pending, c.bodyType).bodyType });
    }
  }

  const completedCommitments: string[] = [];
  if (parsed.completedCommitments !== undefined) {
    if (!Array.isArray(parsed.completedCommitments)) return null;
    for (const k of parsed.completedCommitments.slice(0, 10)) {
      if (typeof k === 'string' && k.trim()) completedCommitments.push(k.trim());
    }
  }

  const relations: ValidatedDreamPlan['relations'] = [];
  if (parsed.relations !== undefined) {
    if (!Array.isArray(parsed.relations)) return null;
    for (const item of parsed.relations.slice(0, 10)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const r = item as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 48) : '';
      if (!name) continue;
      relations.push({
        name,
        ...(typeof r.role === 'string' && r.role.trim() ? { role: r.role.trim().slice(0, 48) } : {}),
        ...(typeof r.bondSummary === 'string' && r.bondSummary.trim() ? { bondSummary: r.bondSummary.trim().slice(0, 240) } : {}),
        ...(typeof r.familiarity === 'number' && Number.isFinite(r.familiarity) ? { familiarity: r.familiarity } : {}),
      });
    }
  }

  let coBecoming: ValidatedDreamPlan['coBecoming'] = null;
  if (parsed.coBecoming && typeof parsed.coBecoming === 'object' && !Array.isArray(parsed.coBecoming)) {
    const cb = parsed.coBecoming as Record<string, unknown>;
    if (typeof cb.soulShift === 'string' && cb.soulShift.trim()) {
      coBecoming = {
        soulShift: cb.soulShift.trim().slice(0, 200),
        partnerShift: typeof cb.partnerShift === 'string' ? cb.partnerShift.trim().slice(0, 200) : '',
        reflection: typeof cb.reflection === 'string' ? cb.reflection.trim().slice(0, 200) : '',
      };
    }
  }
  return { episodes, commitments, completedCommitments, relations, ...(facts !== undefined ? { facts } : {}), coBecoming };
}
