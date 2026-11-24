import { FIRST_AWAKENING_ZH } from '../soul/covenant.ts';
import { evolveSelfFromDream } from '../soul/living-self.ts';
import {
  loadSoulArchive,
  readJsonlSafe,
  readMetaOrRecover,
  refreshDerivedSoulFiles,
  resolveArchivePaths,
  writeJsonAtomic,
} from '../soul/archive.ts';
import type { BodyType, ExperimentalConfig, JournalEntry } from '../soul/types.ts';
import { lexicalSimilarity } from './experience.ts';
import { mergeDreamRelation } from './relations.ts';
import { estimateEmotionSignals, flushPendingReinforcements } from './retention.ts';
import { addCoBecoming, addEpisode, completeCommitment, upsertCommitment } from './store.ts';
import { syncVectorIndexDetailed, type EmbeddingConfig } from './vector-store.ts';

export interface DreamResult {
  ok: boolean;
  processedEntries: number;
  lastDreamSeq: number;
  episodesAdded: number;
  commitmentsAdded: number;
  coBecomingAdded: number;
  vectorsIndexed: number;
  summaryNote: string;
}

export interface DreamLlmAdapter {
  isRealLlm(): boolean;
  dreamSummarize(prompt: string): Promise<string>;
}

const COMMITMENT_RE = /(约定|说好|明晚|明天|下次|以后|继续|没盖完|没修完|还没建好|补完|记得|待办|别忘了)/;
const COMPLETION_RE = /(盖好了|修好了|完成了|已经弄完|搞定了)/;
const MAX_DREAM_BATCH = 80;
const MAX_TRANSCRIPT_CHARS = 16_000;

function extractCommitmentTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= 28 ? cleaned : `${cleaned.slice(0, 28)}…`;
}

function heuristicConsolidate(
  archiveDir: string, entries: JournalEntry[], soulName: string, partnerName: string, nowMs: number,
  enableInnerLife = false,
): { episodesAdded: number; commitmentsAdded: number; coBecomingAdded: number } {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    if (e.text.trim() === FIRST_AWAKENING_ZH && e.tags?.includes('first-love-covenant')) continue;
    const key = `${e.bodyType}::${e.bodyId}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  let episodesAdded = 0;
  let commitmentsAdded = 0;
  let coBecomingAdded = 0;
  const archiveBefore = loadSoulArchive(archiveDir, 5);

  for (const [, group] of groups) {
    if (!group.length) continue;
    const sample = group[0];
    const partnerLines = group.filter((g) => g.role === 'partner').map((g) => g.text);
    const soulLines = group.filter((g) => g.role === 'soul').map((g) => g.text);
    const combinedText = group.map((g) => `${g.speaker}: ${g.text}`).join(' | ');
    const titleSeed = partnerLines[0] || group[0].text;
    const title = `[${sample.bodyType}] ${extractCommitmentTitle(titleSeed)}`;
    const summary = partnerLines.length
      ? `${partnerName}提到「${partnerLines.join('；').slice(0, 140)}」${soulLines.length ? `，${soulName}回应了此事。` : '。'}`
      : combinedText.slice(0, 180);
    const partnerFocus = partnerLines.join(' ').trim() || combinedText;
    const baseImp = group.some((g) => COMMITMENT_RE.test(g.text)) ? 85 : 58;
    const sig = estimateEmotionSignals(partnerFocus, baseImp);
    const repeatHits = !sig.isTrivial
      ? archiveBefore.episodes.filter((e) => lexicalSimilarity(partnerFocus, `${e.title} ${e.summary}`) >= 0.45).length
      : 0;

    addEpisode(archiveDir, {
      bodyType: sample.bodyType as BodyType, bodyId: sample.bodyId, title, summary,
      participants: Array.from(new Set(group.map((g) => g.speaker))),
      importance: sig.importance, valence: sig.valence, arousal: sig.arousal,
      userPinned: sig.userPinned || undefined, mentionCount: repeatHits > 0 ? repeatHits + 1 : 1,
      provenance: group.some((g) => g.provenance === 'verified') ? 'verified' : group[0].provenance,
      tags: [sample.bodyType, 'dream-consolidated', ...(sig.userPinned ? ['user-pinned'] : [])],
      timestamp: group[group.length - 1].timestamp || new Date(nowMs).toISOString(), skipRefresh: true,
    });
    episodesAdded += 1;

    for (const g of group) {
      if (COMMITMENT_RE.test(g.text) && g.role === 'partner') {
        upsertCommitment(archiveDir, {
          title: extractCommitmentTitle(g.text), detail: g.text.trim(),
          sourceBodyType: g.bodyType, provenance: g.provenance, skipRefresh: true,
        });
        commitmentsAdded += 1;
      }
      if (COMPLETION_RE.test(g.text)) {
        for (const active of archiveBefore.commitments.filter((c) => c.status === 'active')) {
          if (g.text.includes(active.title.slice(0, 6))) completeCommitment(archiveDir, active.id);
        }
      }
    }
  }

  if (enableInnerLife && entries.length >= 4) {
    const bodies = Array.from(new Set(entries.map((e) => e.bodyType))).join('、');
    addCoBecoming(archiveDir, {
      soulShift: `在 ${bodies} 场景中陪${partnerName}度过一段真实时光，记忆更加丰盈。`,
      partnerShift: `${partnerName}把共同经历托付给彼此的跨端记忆，信任感加深。`,
      reflection: '每一次相遇与磨合，都让彼此蜕变成更完整的新灵魂。',
      provenance: 'verified', skipRefresh: true,
    });
    coBecomingAdded += 1;
  }
  return { episodesAdded, commitmentsAdded, coBecomingAdded };
}

interface ValidatedDreamPlan {
  episodes: Array<{
    title: string; summary: string; bodyType: BodyType; bodyId: string;
    importance?: number; valence?: number; arousal?: number;
    userPinned?: boolean; selfImportant?: boolean; selfImportantReason?: string;
  }>;
  commitments: Array<{ title: string; detail: string; bodyType: BodyType }>;
  completedCommitments: string[];
  relations: Array<{ name: string; role?: string; bondSummary?: string; familiarity?: number }>;
  coBecoming?: { soulShift: string; partnerShift: string; reflection: string } | null;
}

function resolveMatchingBody(pending: JournalEntry[], rawBodyType: unknown): { bodyType: BodyType; bodyId: string } {
  const fallback = pending[pending.length - 1];
  const bt = typeof rawBodyType === 'string' ? rawBodyType.trim() : '';
  if (bt) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].bodyType === bt) return { bodyType: pending[i].bodyType, bodyId: pending[i].bodyId };
    }
  }
  return { bodyType: fallback.bodyType, bodyId: fallback.bodyId };
}

function parseAndValidateDreamJson(raw: string, pending: JournalEntry[]): ValidatedDreamPlan | null {
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
  if (!Array.isArray(parsed.episodes) || !parsed.episodes.length) return null;

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
      const matched = resolveMatchingBody(pending, c.bodyType);
      commitments.push({ title, detail, bodyType: matched.bodyType });
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
  return { episodes, commitments, completedCommitments, relations, coBecoming };
}

/** 记忆做梦整理：短锁读游标 -> 锁外调 LLM -> 短锁校验游标/epoch 提交 -> 锁外演化与向量同步。 */
export async function runDreamConsolidation(
  archiveDir: string,
  options: {
    llm?: DreamLlmAdapter;
    embedding?: EmbeddingConfig;
    nowMs?: number;
    experimental?: Partial<ExperimentalConfig>;
    lock?: { withSoulLock: <T>(task: () => Promise<T>) => Promise<T>; getEpoch?: () => number };
  } = {},
): Promise<DreamResult> {
  const enableInnerLife = options.experimental?.enableInnerLife === true;
  const runLocked = <T>(fn: () => Promise<T> | T): Promise<T> =>
    (options.lock ? options.lock.withSoulLock(async () => fn()) : Promise.resolve(fn()));
  const nowMs = options.nowMs ?? Date.now();

  const snap = await runLocked(() => {
    flushPendingReinforcements();
    const startEpoch = options.lock?.getEpoch?.() ?? 0;
    const p = resolveArchivePaths(archiveDir);
    const meta = readMetaOrRecover(archiveDir, { writeRecovered: true });
    const allJournal = readJsonlSafe<JournalEntry>(p.journal);
    const pending = allJournal.filter((j) => j.seq > (meta.lastDreamSeq || 0)).slice(0, MAX_DREAM_BATCH);
    return { startEpoch, meta, pending };
  });

  if (!snap.pending.length) {
    return {
      ok: true, processedEntries: 0, lastDreamSeq: snap.meta.lastDreamSeq || 0,
      episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0, vectorsIndexed: 0, summaryNote: '暂无新经历需要做梦整理。',
    };
  }

  let validatedPlan: ValidatedDreamPlan | null = null;
  if (options.llm?.isRealLlm()) {
    const lines: string[] = [];
    let totalChars = 0;
    for (const e of snap.pending) {
      const line = `[seq:${e.seq}][${e.bodyType}:${e.bodyId}][${e.timestamp}] ${e.speaker}: ${e.text}`;
      if (totalChars + line.length > MAX_TRANSCRIPT_CHARS) break;
      lines.push(line);
      totalChars += line.length + 1;
    }
    const prompt = [
      `你是「${snap.meta.name}」的梦境记忆整理器。请把以下跨躯体新经历浓缩为 JSON（不要输出其他解释）：`,
      '{ "episodes": [{ "title": "简短标题", "summary": "保留关键人名/地点/进度/事件细节", "bodyType": "web|chat:qq|game:rimworld|robot|api", "importance": 80, "valence": 0.6, "arousal": 0.7, "selfImportant": false, "selfImportantReason": "" }],',
      '  "commitments": [{ "title": "未完成约定标题", "detail": "完整细节与后续待办", "bodyType": "game:rimworld" }],',
      '  "completedCommitments": ["已完成约定的关键词或标题"],',
      '  "relations": [{ "name": "人物名", "role": "关系定位", "bondSummary": "关系印象摘要", "familiarity": 80 }],',
      '  "coBecoming": { "soulShift": "她的新变化", "partnerShift": "同伴的新变化", "reflection": "共同成长感悟" } }',
      '新经历如下：', ...lines,
    ].join('\n');
    try {
      const reply = await options.llm.dreamSummarize(prompt);
      validatedPlan = parseAndValidateDreamJson(reply, snap.pending);
    } catch {
      validatedPlan = null;
    }
  }

  const commitOut = await runLocked(() => {
    if (options.lock?.getEpoch && options.lock.getEpoch() !== snap.startEpoch) {
      return { stale: true as const, lastDreamSeq: snap.meta.lastDreamSeq || 0, episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0 };
    }
    const latestMeta = readMetaOrRecover(archiveDir, { writeRecovered: true });
    if (latestMeta.lastDreamSeq !== snap.meta.lastDreamSeq) {
      return { stale: true as const, lastDreamSeq: latestMeta.lastDreamSeq || 0, episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0 };
    }

    let episodesAdded = 0;
    let commitmentsAdded = 0;
    let coBecomingAdded = 0;
    const nowIso = new Date(nowMs).toISOString();

    if (validatedPlan) {
      for (const ep of validatedPlan.episodes) {
        const sig = estimateEmotionSignals(`${ep.title} ${ep.summary}`, ep.importance ?? 75);
        addEpisode(archiveDir, {
          bodyType: ep.bodyType, bodyId: ep.bodyId, title: ep.title, summary: ep.summary,
          participants: [latestMeta.partnerName, latestMeta.name], importance: ep.importance ?? sig.importance,
          valence: ep.valence ?? sig.valence, arousal: ep.arousal ?? sig.arousal,
          userPinned: Boolean(ep.userPinned || sig.userPinned) || undefined,
          selfImportant: Boolean(ep.selfImportant) || undefined, selfImportantReason: ep.selfImportantReason,
          provenance: 'verified', tags: ['dream-llm', ...(ep.selfImportant ? ['self-important'] : [])],
          timestamp: nowIso, skipRefresh: true,
        });
        episodesAdded += 1;
      }
      for (const c of validatedPlan.commitments) {
        upsertCommitment(archiveDir, { title: c.title, detail: c.detail, sourceBodyType: c.bodyType, provenance: 'verified', skipRefresh: true });
        commitmentsAdded += 1;
      }
      for (const doneKey of validatedPlan.completedCommitments) completeCommitment(archiveDir, doneKey);
      for (const rel of validatedPlan.relations) mergeDreamRelation(archiveDir, rel);
      if (enableInnerLife && validatedPlan.coBecoming?.soulShift) {
        addCoBecoming(archiveDir, { ...validatedPlan.coBecoming, provenance: 'verified', skipRefresh: true });
        coBecomingAdded += 1;
      }
    } else {
      const res = heuristicConsolidate(archiveDir, snap.pending, latestMeta.name, latestMeta.partnerName, nowMs, enableInnerLife);
      episodesAdded = res.episodesAdded;
      commitmentsAdded = res.commitmentsAdded;
      coBecomingAdded = res.coBecomingAdded;
    }

    const updatedMeta = readMetaOrRecover(archiveDir, { writeRecovered: true });
    updatedMeta.lastDreamSeq = snap.pending[snap.pending.length - 1].seq;
    writeJsonAtomic(resolveArchivePaths(archiveDir).meta, updatedMeta);
    refreshDerivedSoulFiles(archiveDir);
    return { stale: false as const, lastDreamSeq: updatedMeta.lastDreamSeq, episodesAdded, commitmentsAdded, coBecomingAdded };
  });

  if (commitOut.stale) {
    return {
      ok: true, processedEntries: 0, lastDreamSeq: commitOut.lastDreamSeq,
      episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0, vectorsIndexed: 0, summaryNote: '做梦整理期间档案已切换或已被并发整理，本次结果已安全跳过。',
    };
  }

  if (enableInnerLife) {
    await evolveSelfFromDream(
      archiveDir,
      options.llm?.isRealLlm() ? (pr) => options.llm!.dreamSummarize(pr) : undefined,
      { lock: options.lock },
    );
  }
  const vecRep = await syncVectorIndexDetailed(archiveDir, options.embedding, {
    shouldAbort: () => Boolean(options.lock?.getEpoch && options.lock.getEpoch() !== snap.startEpoch),
  });

  return {
    ok: true,
    processedEntries: snap.pending.length,
    lastDreamSeq: commitOut.lastDreamSeq,
    episodesAdded: commitOut.episodesAdded,
    commitmentsAdded: commitOut.commitmentsAdded,
    coBecomingAdded: commitOut.coBecomingAdded,
    vectorsIndexed: vecRep.indexed,
    summaryNote: `已做梦整理 ${snap.pending.length} 条经历：新增 ${commitOut.episodesAdded} 条情景卡、${commitOut.commitmentsAdded} 条未完约定。`,
  };
}
