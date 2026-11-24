import crypto from 'node:crypto';
import { allocateSeq, readJsonlSafe, resolveArchivePaths, writeTextAtomic } from '../soul/archive.ts';
import type { BodyType, FactAction, FactStatus, MemoryFact, Provenance } from '../soul/types.ts';
import { lexicalSimilarityFromTokens, tokenizeText } from './experience.ts';
import { syncMemoryIndexFile } from './sqlite-index.ts';
import { extractContentUnigrams } from './sqlite-tokenizer.ts';
import { cosineSimilarity } from './vector-store.ts';

export type { FactAction, FactStatus, MemoryFact };

export interface FactOperation {
  action: FactAction;
  fact?: string;
  targetId?: string;
  category?: string;
  subject?: string;
  validFrom?: string;
  sourceSeqs?: number[];
  bodyType?: BodyType;
  provenance?: Provenance;
}

export interface FactApplyReport {
  added: number;
  updated: number;
  deleted: number;
  none: number;
  totalActive: number;
  totalRecords: number;
  changedIds: string[];
}

export const SINGLE_VALUE_FACT_CATEGORIES = new Set([
  'residence', 'drink_preference', 'work', 'hometown', 'birthday', 'sleep_schedule',
]);

const CATEGORY_ALIASES: Record<string, string> = {
  residence: 'residence', location: 'residence', address: 'residence', city: 'residence', home: 'residence',
  living: 'residence', 居住地: 'residence', 住址: 'residence', 居住: 'residence', 城市: 'residence',
  drink_preference: 'drink_preference', drink: 'drink_preference', beverage: 'drink_preference',
  coffee: 'drink_preference', tea: 'drink_preference', 饮品: 'drink_preference', 饮品偏好: 'drink_preference', 饮料: 'drink_preference',
  food_preference: 'food_preference', food: 'food_preference', diet: 'food_preference', 饮食: 'food_preference', 饮食偏好: 'food_preference',
  allergy: 'allergy', allergies: 'allergy', 过敏: 'allergy',
  pet: 'pet', pets: 'pet', 宠物: 'pet',
  work: 'work', job: 'work', career: 'work', occupation: 'work', 工作: 'work', 职业: 'work',
  hometown: 'hometown', 家乡: 'hometown', birthday: 'birthday', 生日: 'birthday',
  sleep_schedule: 'sleep_schedule', 作息: 'sleep_schedule', other: 'other',
};

/** 规范化 LLM 输出的事实分类别名，确保单值槽位冲突消解可靠命中。 */
export function normalizeFactCategory(raw?: string): string | undefined {
  const clean = String(raw || '').trim().toLowerCase().slice(0, 48);
  if (!clean) return undefined;
  return CATEGORY_ALIASES[clean] ?? clean;
}

function normalizeFactText(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function factNormKey(raw: string): string {
  return normalizeFactText(raw).toLowerCase().replace(/[\s，,。；;！!？?、"'`]/g, '');
}

function normSlot(category: string | undefined, subject: string | undefined, fallbackSubject: string): string {
  const cat = normalizeFactCategory(category) || '';
  const sub = String(subject || fallbackSubject || '').trim().toLowerCase();
  return cat ? `${cat}::${sub}` : '';
}

function normalizeSeqs(seqs?: number[]): number[] | undefined {
  if (!Array.isArray(seqs)) return undefined;
  const clean = Array.from(new Set(seqs.map((n) => Math.trunc(Number(n))).filter((n) => Number.isInteger(n) && n > 0)));
  return clean.length ? clean : undefined;
}

/** 读取全部事实历史记录（含 active / superseded / deleted）。 */
export function listFacts(dir: string): MemoryFact[] {
  return readJsonlSafe<MemoryFact>(resolveArchivePaths(dir).facts);
}

/** 仅读取当前有效的 active 事实。 */
export function listActiveFacts(dir: string): MemoryFact[] {
  return listFacts(dir).filter((f) => f.status === 'active');
}

/** 收集已被淘汰或删除事实对应的原始流水 seq，用于防止旧流水继续污染召回。 */
export function getSupersededFactSourceSeqs(dir: string): Set<number> {
  const out = new Set<number>();
  for (const f of listFacts(dir)) {
    if (f.status !== 'active' && Array.isArray(f.source_seqs)) {
      for (const s of f.source_seqs) {
        if (Number.isInteger(s) && s > 0) out.add(s);
      }
    }
  }
  return out;
}

function findMatchingActiveTarget(all: MemoryFact[], op: FactOperation, defaultSubject: string): MemoryFact | undefined {
  const targetId = String(op.targetId || '').trim();
  if (targetId) {
    const byId = all.find((f) => f.status === 'active' && f.id === targetId);
    if (byId) return byId;
  }
  const slot = normSlot(op.category, op.subject, defaultSubject);
  if (slot) {
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const f = all[i];
      if (f.status === 'active' && normSlot(f.category, f.subject, defaultSubject) === slot) return f;
    }
  }
  const key = op.fact ? factNormKey(op.fact) : '';
  return key ? all.find((f) => f.status === 'active' && factNormKey(f.fact) === key) : undefined;
}

/** Mem0 风格 ADD / UPDATE / DELETE / NONE 状态机：先原子写 MEMORIES/facts.jsonl，再增量同步 SQLite。 */
export function applyFactOperations(
  dir: string,
  ops: FactOperation[],
  options: { nowMs?: number; defaultSubject?: string; defaultBodyType?: BodyType } = {},
): FactApplyReport {
  const all = listFacts(dir);
  if (!ops.length) {
    const active = all.filter((f) => f.status === 'active').length;
    return { added: 0, updated: 0, deleted: 0, none: 0, totalActive: active, totalRecords: all.length, changedIds: [] };
  }

  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const defaultSubject = String(options.defaultSubject || '同行者').trim();
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let none = 0;
  const changedIds: string[] = [];

  const appendNewFact = (op: FactOperation, factText: string, provenance: Provenance): MemoryFact => {
    const seq = allocateSeq(dir, provenance);
    const seqs = normalizeSeqs(op.sourceSeqs);
    const cat = normalizeFactCategory(op.category);
    const rec: MemoryFact = {
      id: `fact_${crypto.randomUUID().slice(0, 10)}`, seq, fact: factText,
      ...(cat ? { category: cat } : {}),
      ...(op.subject?.trim() || defaultSubject ? { subject: (op.subject?.trim() || defaultSubject).slice(0, 48) } : {}),
      valid_from: op.validFrom?.trim() || nowIso, updated_at: nowIso, status: 'active', superseded_by: null,
      ...(seqs ? { source_seqs: seqs } : {}),
      ...(op.bodyType || options.defaultBodyType ? { bodyType: op.bodyType || options.defaultBodyType } : {}),
      provenance,
    };
    all.push(rec);
    return rec;
  };

  for (const op of ops) {
    const action = String(op.action || 'NONE').toUpperCase() as FactAction;
    if (action === 'NONE') { none += 1; continue; }
    const provenance: Provenance = op.provenance || 'verified';

    if (action === 'DELETE') {
      const target = findMatchingActiveTarget(all, op, defaultSubject);
      if (!target) { none += 1; continue; }
      target.status = 'deleted';
      target.superseded_by = null;
      target.updated_at = nowIso;
      deleted += 1;
      changedIds.push(target.id);
      continue;
    }

    const factText = normalizeFactText(op.fact || '');
    if (!factText) { none += 1; continue; }
    const key = factNormKey(factText);
    const cat = normalizeFactCategory(op.category);
    const isSingleCat = Boolean(cat && SINGLE_VALUE_FACT_CATEGORIES.has(cat));

    if (action === 'ADD') {
      if (all.some((f) => f.status === 'active' && factNormKey(f.fact) === key)) { none += 1; continue; }
      const conflictTarget = isSingleCat ? findMatchingActiveTarget(all, { ...op, category: cat }, defaultSubject) : undefined;
      if (conflictTarget) {
        const next = appendNewFact({ ...op, category: cat || conflictTarget.category }, factText, provenance);
        conflictTarget.status = 'superseded';
        conflictTarget.superseded_by = next.id;
        conflictTarget.updated_at = nowIso;
        updated += 1;
        changedIds.push(conflictTarget.id, next.id);
        continue;
      }
      const created = appendNewFact({ ...op, category: cat }, factText, provenance);
      added += 1;
      changedIds.push(created.id);
      continue;
    }

    if (action === 'UPDATE') {
      const target = findMatchingActiveTarget(all, { ...op, category: cat }, defaultSubject);
      if (!target) {
        if (all.some((f) => f.status === 'active' && factNormKey(f.fact) === key)) { none += 1; continue; }
        const created = appendNewFact({ ...op, category: cat }, factText, provenance);
        added += 1;
        changedIds.push(created.id);
        continue;
      }
      if (factNormKey(target.fact) === key) { none += 1; continue; }
      const next = appendNewFact(
        { ...op, category: cat || target.category, subject: op.subject?.trim() || target.subject, bodyType: op.bodyType || target.bodyType },
        factText, provenance,
      );
      target.status = 'superseded';
      target.superseded_by = next.id;
      target.updated_at = nowIso;
      updated += 1;
      changedIds.push(target.id, next.id);
      continue;
    }
    none += 1;
  }

  if (added > 0 || updated > 0 || deleted > 0) {
    const p = resolveArchivePaths(dir);
    writeTextAtomic(p.facts, all.map((f) => JSON.stringify(f)).join('\n') + (all.length ? '\n' : ''));
    syncMemoryIndexFile(dir, 'facts.jsonl');
  }
  return { added, updated, deleted, none, totalActive: all.filter((f) => f.status === 'active').length, totalRecords: all.length, changedIds: Array.from(new Set(changedIds)) };
}

/** 为做梦整理 LLM 生成现有有效事实清单，强调同批先旧后新变更必须保留完整 ADD -> UPDATE 因果链。 */
export function buildDreamFactsPromptBlock(activeFacts: MemoryFact[]): string {
  const lines = [
    '当前已知有效长期事实 (active facts)：',
    ...(activeFacts.length
      ? activeFacts.slice(-30).map((f) => `- [id:${f.id}]${f.category ? `[${f.category}]` : ''} ${f.fact}`)
      : ['- （当前暂无已归档有效事实）']),
    '请在 JSON 中附带 `"facts"` 数组（无变更可输出 `[]`），每项格式：`{ "action": "ADD|UPDATE|DELETE|NONE", "targetId": "UPDATE/DELETE时填已有fact_xxx", "category": "residence|drink_preference|food_preference|allergy|pet|work|other", "fact": "原子陈述句", "sourceSeqs": [seq] }`',
    '重要规则：1) 同一句话含多个事实（如住址+饮品）必须拆成多条；2) 若同一批经历内先出现旧事实、后出现冲突新事实（例如先说住上海/喝美式，后说搬去成都/改喝拿铁），严禁只留新值或误留旧值！必须按 seq 先输出旧事实 ADD（带旧 seq），再输出新事实 UPDATE（带新 seq）。',
  ];
  return lines.join('\n');
}

const VALID_FACT_ACTIONS = new Set<FactAction>(['ADD', 'UPDATE', 'DELETE', 'NONE']);

/** 校验梦境 LLM 返回的 `facts` 操作数组；字段缺失或格式非法返回 null。 */
export function parseDreamFactOps(raw: unknown): FactOperation[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FactOperation[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    const action = String(obj.action || '').trim().toUpperCase() as FactAction;
    if (!VALID_FACT_ACTIONS.has(action)) continue;
    const fact = typeof obj.fact === 'string' ? obj.fact.trim().slice(0, 240) : '';
    const targetId = typeof obj.targetId === 'string' ? obj.targetId.trim().slice(0, 64) : undefined;
    const category = normalizeFactCategory(typeof obj.category === 'string' ? obj.category : undefined);
    const subject = typeof obj.subject === 'string' ? obj.subject.trim().slice(0, 48) : undefined;
    const sourceSeqs = Array.isArray(obj.sourceSeqs)
      ? obj.sourceSeqs.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : undefined;
    if ((action === 'ADD' || action === 'UPDATE') && !fact) continue;
    if (action === 'DELETE' && !targetId && !fact && !category) continue;
    out.push({
      action,
      ...(fact ? { fact } : {}),
      ...(targetId ? { targetId } : {}),
      ...(category ? { category } : {}),
      ...(subject ? { subject } : {}),
      ...(sourceSeqs?.length ? { sourceSeqs } : {}),
    });
  }
  return out;
}

/** 仅从 active 事实中选出与当前问句最相关及最近有效的事实注入 Prompt（绝不注入 superseded/deleted）。 */
export function selectActiveFactsForPrompt(
  dir: string,
  query: string,
  options: { maxFacts?: number; queryVec?: number[] | null; vectorMap?: Record<string, number[]> | null } = {},
): MemoryFact[] {
  const active = listActiveFacts(dir);
  if (!active.length) return [];
  const maxFacts = Math.max(1, options.maxFacts ?? 8);
  const queryTokens = tokenizeText(query);
  const queryUnigrams = extractContentUnigrams(query);
  const scored = active.map((fact, idx) => {
    const hay = `${fact.category || ''} ${fact.subject || ''} ${fact.fact}`;
    const lex = lexicalSimilarityFromTokens(queryTokens, hay);
    const uni = queryUnigrams.length ? queryUnigrams.filter((ch) => hay.includes(ch)).length / queryUnigrams.length : 0;
    const vec = options.queryVec && options.vectorMap?.[fact.id] ? cosineSimilarity(options.queryVec, options.vectorMap[fact.id]) : 0;
    const recency = (idx + 1) / active.length;
    return { fact, score: Math.max(lex, uni * 0.65, vec) * 2.5 + recency * 0.25 };
  });
  scored.sort((a, b) => b.score - a.score || b.fact.seq - a.fact.seq);
  return scored.slice(0, maxFacts).map((s) => s.fact);
}

/** 渲染当前有效长期事实段落（仅包含 active 记录）。 */
export function formatActiveFactsPromptSection(facts: MemoryFact[]): string {
  const activeOnly = facts.filter((f) => f.status === 'active');
  if (!activeOnly.length) return '';
  const lines = ['', '## 长期个人事实记忆 (Active Facts · 最新有效事实，若与更早日记/流水冲突一律以此为准)'];
  for (const f of activeOnly) {
    lines.push(`- [${f.id}]${f.category ? `[${f.category}]` : ''} ${f.fact} (valid_from: ${f.valid_from.slice(0, 10)})`);
  }
  return lines.join('\n');
}
