export const TRACKED_MEMORY_FILES = [
  'episodes.jsonl',
  'journal.jsonl',
  'experiences.jsonl',
  'beliefs.jsonl',
  'facts.jsonl',
  'co-becoming.jsonl',
  'self-evolution.jsonl',
] as const;

export type TrackedMemoryFile = (typeof TRACKED_MEMORY_FILES)[number];

export type IndexedDocKind =
  | 'episode'
  | 'journal'
  | 'experience'
  | 'belief'
  | 'fact'
  | 'co_becoming'
  | 'self_evolution';

export interface IndexedMemoryDoc {
  docId: string;
  sourceFile: TrackedMemoryFile;
  kind: IndexedDocKind;
  seq: number;
  timestamp: string;
  bodyType: string;
  bodyId: string;
  speaker: string;
  role: string;
  provenance: string;
  status: string;
  title: string;
  text: string;
  extraFtsText: string;
  metaJson: string;
}

export const CJK_STOP_CHARS = new Set(
  '的了是在我你他她它们这那有和也就都还很啊呀呢吧吗哦嗯么什怎么哪谁把被让给从到向对着过得地不没无要会能可只又再更最太真才刚等以与及或但而因所为'.split(''),
);

const CJK_CHAR_RE = /[\u4e00-\u9fa5]/;
const ASCII_OR_CJK_RUN_RE = /[a-z0-9]+|[\u4e00-\u9fa5]+/g;

/** 提取中英文词元：中文生成全部 2 字 bigram，英文/数字保留长度 >=2 词元。 */
export function extractBigramsAndWords(text: string): string[] {
  const out = new Set<string>();
  const src = String(text ?? '').toLowerCase();
  for (const seg of src.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!seg) continue;
    for (const run of seg.match(ASCII_OR_CJK_RUN_RE) ?? []) {
      if (CJK_CHAR_RE.test(run)) {
        for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
        if (run.length === 1 && !CJK_STOP_CHARS.has(run)) out.add(run);
      } else if (run.length >= 2) {
        out.add(run);
      }
    }
  }
  return [...out];
}

/** 提取去除高频虚字后的唯一中文单字，用于短问句单字回退召回。 */
export function extractContentUnigrams(text: string): string[] {
  const out = new Set<string>();
  for (const ch of String(text ?? '')) {
    if (CJK_CHAR_RE.test(ch) && !CJK_STOP_CHARS.has(ch)) out.add(ch);
  }
  return [...out];
}

/** 为 FTS5 索引生成双列（bigram/英文词 + 中文实义单字）文本。 */
export function buildFtsColumns(
  title: string,
  text: string,
  speaker = '',
  extra = '',
): { bigrams: string; unigrams: string } {
  const combined = `${title} ${text} ${speaker} ${extra}`.trim();
  return {
    bigrams: extractBigramsAndWords(combined).join(' '),
    unigrams: extractContentUnigrams(combined).join(' '),
  };
}

function quoteFtsToken(tok: string): string {
  const clean = tok.replace(/"/g, '').trim();
  return clean ? `"${clean}"` : '';
}

/** 构造安全的 FTS5 MATCH 表达式（所有词元加双引号，避免关键字或标点语法错误）。 */
export function buildFtsQueryExpressions(query: string): {
  bigramMatch: string;
  unigramMatch: string;
  queryBigrams: string[];
  queryUnigrams: string[];
} {
  const queryBigrams = extractBigramsAndWords(query).slice(0, 24);
  const queryUnigrams = extractContentUnigrams(query).slice(0, 12);
  const biQuoted = queryBigrams.map(quoteFtsToken).filter(Boolean);
  const uniQuoted = queryUnigrams.map(quoteFtsToken).filter(Boolean);
  return {
    bigramMatch: biQuoted.length ? `bigrams:(${biQuoted.join(' OR ')})` : '',
    unigramMatch: uniQuoted.length ? `unigrams:(${uniQuoted.join(' OR ')})` : '',
    queryBigrams,
    queryUnigrams,
  };
}

/** 计算中文实义单字在目标文本中的命中覆盖率 [0, 1]。 */
export function computeUnigramSimilarity(queryUnigrams: string[], target: string): number {
  if (!queryUnigrams.length) return 0;
  let hits = 0;
  for (const ch of queryUnigrams) {
    if (target.includes(ch)) hits += 1;
  }
  return hits / queryUnigrams.length;
}

const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : v == null ? fb : String(v));
const num = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : []);

/** 将 6 类纯文本 MEMORIES/*.jsonl 记录规范化为统一的 SQLite 索引文档。 */
export function normalizeMemoryRow(
  sourceFile: TrackedMemoryFile,
  raw: Record<string, unknown>,
  lineIndex: number,
): IndexedMemoryDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const seq = Math.max(0, Math.trunc(num(raw.seq, 0)));
  const timestamp = str(raw.timestamp || raw.updatedAt);

  if (sourceFile === 'episodes.jsonl') {
    const id = str(raw.id).trim();
    const participants = strArr(raw.participants);
    const tags = strArr(raw.tags);
    return {
      docId: `episode:${id || `seq:${seq || lineIndex}`}`,
      sourceFile,
      kind: 'episode',
      seq,
      timestamp,
      bodyType: str(raw.bodyType, 'web'),
      bodyId: str(raw.bodyId),
      speaker: participants.join('、'),
      role: 'episode',
      provenance: str(raw.provenance, 'verified'),
      status: 'active',
      title: str(raw.title),
      text: str(raw.summary),
      extraFtsText: tags.join(' '),
      metaJson: JSON.stringify({
        id,
        importance: num(raw.importance, 65),
        tags,
        ...(raw.valence !== undefined ? { valence: raw.valence } : {}),
        ...(raw.arousal !== undefined ? { arousal: raw.arousal } : {}),
        ...(raw.strength !== undefined ? { strength: raw.strength } : {}),
        ...(raw.recallCount !== undefined ? { recallCount: raw.recallCount } : {}),
        ...(raw.mentionCount !== undefined ? { mentionCount: raw.mentionCount } : {}),
        ...(raw.lastRecalledAt ? { lastRecalledAt: raw.lastRecalledAt } : {}),
        ...(raw.userPinned ? { userPinned: true } : {}),
        ...(raw.selfImportant ? { selfImportant: true } : {}),
        ...(raw.selfImportantReason ? { selfImportantReason: raw.selfImportantReason } : {}),
        participants,
      }),
    };
  }

  if (sourceFile === 'journal.jsonl') {
    const speaker = str(raw.speaker);
    const bodyType = str(raw.bodyType, 'web');
    const role = str(raw.role, 'partner');
    const tags = strArr(raw.tags);
    return {
      docId: `journal:${seq > 0 ? seq : `line:${lineIndex}`}`,
      sourceFile,
      kind: 'journal',
      seq,
      timestamp,
      bodyType,
      bodyId: str(raw.bodyId),
      speaker,
      role,
      provenance: str(raw.provenance, 'verified'),
      status: role === 'system' ? 'system' : 'active',
      title: `${speaker} (${bodyType})`,
      text: str(raw.text),
      extraFtsText: tags.join(' '),
      metaJson: JSON.stringify({
        ...(raw.importance !== undefined ? { importance: raw.importance } : {}),
        ...(tags.length ? { tags } : {}),
        ...(raw.personId ? { personId: raw.personId } : {}),
      }),
    };
  }

  if (sourceFile === 'experiences.jsonl') {
    const id = str(raw.id).trim();
    const tags = strArr(raw.tags);
    const body = [str(raw.chosenAction), str(raw.realityOutcome), str(raw.lesson)].filter(Boolean).join(' | ');
    return {
      docId: `experience:${id || `seq:${seq || lineIndex}`}`,
      sourceFile,
      kind: 'experience',
      seq,
      timestamp,
      bodyType: str(raw.bodyType, 'web'),
      bodyId: str(raw.bodyId),
      speaker: str(raw.origin, 'lived'),
      role: 'experience',
      provenance: str(raw.provenance, 'verified'),
      status: 'active',
      title: str(raw.stimulus),
      text: body,
      extraFtsText: tags.join(' '),
      metaJson: JSON.stringify({
        id,
        origin: raw.origin,
        valence: raw.valence,
        arousal: raw.arousal,
        confidence: raw.confidence,
        ...(raw.strength !== undefined ? { strength: raw.strength } : {}),
        ...(raw.recallCount !== undefined ? { recallCount: raw.recallCount } : {}),
        ...(tags.length ? { tags } : {}),
      }),
    };
  }

  if (sourceFile === 'beliefs.jsonl') {
    const id = str(raw.id).trim();
    return {
      docId: `belief:${id || `seq:${seq || lineIndex}`}`,
      sourceFile,
      kind: 'belief',
      seq,
      timestamp,
      bodyType: 'soul',
      bodyId: 'soul',
      speaker: 'soul',
      role: 'belief',
      provenance: 'verified',
      status: raw.supersededAtSeq ? 'superseded' : 'active',
      title: str(raw.topic),
      text: str(raw.statement),
      extraFtsText: '',
      metaJson: JSON.stringify({
        id,
        confidence: raw.confidence,
        validFromSeq: raw.validFromSeq,
        ...(raw.supersededAtSeq ? { supersededAtSeq: raw.supersededAtSeq } : {}),
        ...(raw.supersededById ? { supersededById: raw.supersededById } : {}),
        ...(Array.isArray(raw.evidenceSeqs) ? { evidenceSeqs: raw.evidenceSeqs } : {}),
      }),
    };
  }

  if (sourceFile === 'facts.jsonl') {
    const id = str(raw.id).trim();
    const rawStatus = str(raw.status, 'active');
    const status = rawStatus === 'superseded' || rawStatus === 'deleted' ? rawStatus : 'active';
    const category = str(raw.category, 'fact');
    const subject = str(raw.subject);
    return {
      docId: `fact:${id || `seq:${seq || lineIndex}`}`,
      sourceFile,
      kind: 'fact',
      seq,
      timestamp: str(raw.updated_at || raw.valid_from || timestamp),
      bodyType: str(raw.bodyType, 'soul'),
      bodyId: 'soul',
      speaker: subject || 'soul',
      role: 'fact',
      provenance: str(raw.provenance, 'verified'),
      status,
      title: category || 'fact',
      text: str(raw.fact),
      extraFtsText: [category, subject].filter(Boolean).join(' '),
      metaJson: JSON.stringify({
        id,
        category,
        ...(subject ? { subject } : {}),
        valid_from: raw.valid_from,
        ...(raw.superseded_by ? { superseded_by: raw.superseded_by } : {}),
        ...(Array.isArray(raw.source_seqs) ? { source_seqs: raw.source_seqs } : {}),
      }),
    };
  }

  if (sourceFile === 'co-becoming.jsonl') {
    return {
      docId: `co_becoming:${seq > 0 ? seq : `line:${lineIndex}`}`,
      sourceFile,
      kind: 'co_becoming',
      seq,
      timestamp,
      bodyType: 'soul',
      bodyId: 'soul',
      speaker: 'co-becoming',
      role: 'co_becoming',
      provenance: str(raw.provenance, 'verified'),
      status: 'active',
      title: str(raw.soulShift),
      text: [str(raw.partnerShift), str(raw.reflection)].filter(Boolean).join(' | '),
      extraFtsText: '',
      metaJson: '{}',
    };
  }

  const id = str(raw.id).trim();
  const prev = str(raw.previousTrait);
  const next = str(raw.evolvedTrait);
  return {
    docId: `self_evolution:${id || `seq:${seq || lineIndex}`}`,
    sourceFile,
    kind: 'self_evolution',
    seq,
    timestamp,
    bodyType: 'soul',
    bodyId: 'soul',
    speaker: str(raw.trigger, 'practice'),
    role: 'self_evolution',
    provenance: 'verified',
    status: 'active',
    title: prev && next ? `${prev} -> ${next}` : next || prev,
    text: str(raw.reason),
    extraFtsText: '',
    metaJson: JSON.stringify({
      id,
      trigger: raw.trigger,
      previousTrait: prev,
      evolvedTrait: next,
      ...(Array.isArray(raw.evidenceSeqs) ? { evidenceSeqs: raw.evidenceSeqs } : {}),
    }),
  };
}
