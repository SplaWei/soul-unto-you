import type { BodyType, Provenance, RecallChannel } from '../soul/types.ts';
import { lexicalSimilarityFromTokens } from './experience.ts';
import { computeRetention, describeRecallReasons } from './retention.ts';
import type { IndexedDocRow, MemoryIndexSearchResult } from './sqlite-index.ts';
import { computeUnigramSimilarity } from './sqlite-tokenizer.ts';
import { cosineSimilarity } from './vector-store.ts';

export interface RecalledItem {
  id?: string;
  kind: 'episode' | 'journal';
  seq: number;
  score: number;
  bodyType: BodyType;
  provenance: Provenance;
  timestamp: string;
  title: string;
  text: string;
  retentionPct: number;
  strength: number;
  recallCount: number;
  mentionCount: number;
  semanticSim: number;
  lexicalSim: number;
  userPinned?: boolean;
  selfImportant?: boolean;
  recallReason: string;
  recallChannels: RecallChannel[];
}

const VALID_PROVENANCES = new Set<Provenance>(['verified', 'inferred', 'oral']);
export const normalizeProvenance = (raw: unknown): Provenance =>
  (VALID_PROVENANCES.has(String(raw ?? '').trim() as Provenance) ? (String(raw).trim() as Provenance) : 'inferred');
export const numOr = (v: unknown, fb: number): number => (Number.isFinite(Number(v)) ? Number(v) : fb);
const provenanceWeight = (p: Provenance): number => (p === 'verified' ? 1.0 : p === 'oral' ? 0.9 : 0.85);

function parseDocMeta(metaJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function calcLexScore(
  queryTokens: string[],
  queryUnigrams: string[],
  hay: string,
  matchedBy?: 'bigram' | 'unigram',
): number {
  const rawLex = lexicalSimilarityFromTokens(queryTokens, hay);
  if (rawLex > 0 || matchedBy !== 'unigram') return rawLex;
  return Number((computeUnigramSimilarity(queryUnigrams, hay) * 0.55).toFixed(3));
}

/** 融合 FTS5 候选、近期情景兜底与向量相似度，计算艾宾浩斯+溯源综合得分。 */
export function scoreIndexedMemoryCandidates(params: {
  indexRes: MemoryIndexSearchResult;
  queryTokens: string[];
  queryVec: number[] | null;
  vectorMap: Record<string, number[]> | null;
  nowMs: number;
}): RecalledItem[] {
  const { indexRes, queryTokens, queryVec, vectorMap, nowMs } = params;
  const merged = new Map<string, { row: IndexedDocRow; matchedBy?: 'bigram' | 'unigram' }>();
  for (const hit of indexRes.hits) merged.set(hit.docId, { row: hit, matchedBy: hit.matchedBy });
  for (const ep of indexRes.recentEpisodes) {
    if (!merged.has(ep.docId)) merged.set(ep.docId, { row: ep });
  }
  for (const doc of indexRes.extraDocs) {
    if ((doc.kind === 'episode' || doc.kind === 'journal') && doc.status === 'active' && !merged.has(doc.docId)) {
      merged.set(doc.docId, { row: doc });
    }
  }

  const candidates: RecalledItem[] = [];
  for (const { row, matchedBy } of merged.values()) {
    const meta = parseDocMeta(row.metaJson);
    const provenance = normalizeProvenance(row.provenance);
    if (row.kind === 'episode') {
      const epId = typeof meta.id === 'string' && meta.id ? meta.id : row.docId.replace(/^episode:/, '');
      const importance = numOr(meta.importance, 65);
      const arousal = typeof meta.arousal === 'number' ? meta.arousal : undefined;
      const recallCount = numOr(meta.recallCount, 0);
      const mentionCount = numOr(meta.mentionCount, 1);
      const userPinned = Boolean(meta.userPinned);
      const selfImportant = Boolean(meta.selfImportant);
      const ret = computeRetention({
        timestamp: row.timestamp,
        lastRecalledAt: typeof meta.lastRecalledAt === 'string' ? meta.lastRecalledAt : undefined,
        strength: typeof meta.strength === 'number' ? meta.strength : undefined,
        importance,
        arousal,
        valence: typeof meta.valence === 'number' ? meta.valence : undefined,
        userPinned,
        selfImportant,
        mentionCount,
        recallCount,
      }, nowMs);
      const lex = calcLexScore(queryTokens, indexRes.queryUnigrams, `${row.title} ${row.text}`, matchedBy);
      const vec = queryVec && vectorMap?.[epId] ? cosineSimilarity(queryVec, vectorMap[epId]) : 0;
      const imp = Math.min(1, Math.max(0, importance / 100));
      const hasRel = lex > 0 || vec >= 0.3;
      const rawEngrave = (userPinned ? 0.1 : 0) + (selfImportant ? 0.1 : 0) + Math.min(0.1, Math.max(0, mentionCount - 1) * 0.04);
      const relevance = queryVec ? 0.52 * vec + 0.2 * lex : 0.56 * lex;
      const rawTrace = 0.18 * ret.retention + 0.1 * imp + (hasRel ? rawEngrave : 0) * (0.4 + 0.6 * ret.retention);
      const score = (relevance + (hasRel ? rawTrace : rawTrace * 0.25)) * (0.45 + 0.55 * ret.retention) * provenanceWeight(provenance);
      const { recallReason, channels } = describeRecallReasons({
        semanticSim: vec, lexicalSim: lex, userPinned, selfImportant, mentionCount, arousal, recallCount,
      });
      candidates.push({
        id: epId, kind: 'episode', seq: row.seq, score, bodyType: row.bodyType, provenance,
        timestamp: row.timestamp, title: row.title, text: row.text, retentionPct: ret.retentionPct,
        strength: ret.strength, recallCount, mentionCount,
        semanticSim: Number(vec.toFixed(3)), lexicalSim: Number(lex.toFixed(3)),
        ...(userPinned ? { userPinned: true } : {}), ...(selfImportant ? { selfImportant: true } : {}),
        recallReason, recallChannels: channels,
      });
      continue;
    }

    if (row.kind === 'journal' && row.role !== 'system') {
      const lex = calcLexScore(queryTokens, indexRes.queryUnigrams, row.text, matchedBy);
      if (lex <= 0) continue;
      const ret = computeRetention({ timestamp: row.timestamp, strength: Math.max(2, numOr(meta.importance, 45) / 15) }, nowMs);
      const score = (0.55 * lex + 0.15 * ret.retention) * provenanceWeight(provenance);
      const { recallReason, channels } = describeRecallReasons({ lexicalSim: lex });
      candidates.push({
        kind: 'journal', seq: row.seq, score, bodyType: row.bodyType, provenance,
        timestamp: row.timestamp, title: row.title, text: row.text,
        retentionPct: ret.retentionPct, strength: ret.strength, recallCount: 0, mentionCount: 1,
        semanticSim: 0, lexicalSim: Number(lex.toFixed(3)), recallReason, recallChannels: channels,
      });
    }
  }
  return candidates;
}
