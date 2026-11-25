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
import {
  buildDreamConsolidationPrompt,
  parseAndValidateDreamJson,
  type ValidatedDreamPlan,
} from './dream-parser.ts';
import { lexicalSimilarity } from './experience.ts';
import { extractHeuristicFactOps } from './fact-extractor.ts';
import { applyFactOperations, listActiveFacts } from './facts.ts';
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
  factsAdded: number;
  factsUpdated: number;
  factsDeleted: number;
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

/** 记忆做梦整理：短锁读游标与有效事实 -> 锁外调 LLM -> 短锁校验游标/epoch 提交并消解事实冲突 -> 锁外演化与向量同步。 */
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
    const activeFacts = listActiveFacts(archiveDir);
    return { startEpoch, meta, pending, activeFacts };
  });

  if (!snap.pending.length) {
    return {
      ok: true, processedEntries: 0, lastDreamSeq: snap.meta.lastDreamSeq || 0,
      episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0,
      factsAdded: 0, factsUpdated: 0, factsDeleted: 0,
      vectorsIndexed: 0, summaryNote: '暂无新经历需要做梦整理。',
    };
  }

  let validatedPlan: ValidatedDreamPlan | null = null;
  if (options.llm?.isRealLlm()) {
    const prompt = buildDreamConsolidationPrompt(snap.meta, snap.pending, snap.activeFacts);
    try {
      const reply = await options.llm.dreamSummarize(prompt);
      validatedPlan = parseAndValidateDreamJson(reply, snap.pending);
    } catch (err) {
      console.warn(`[soul-dream] LLM 整理响应解析/调用失败，自动降级离线规则整理: ${err instanceof Error ? err.message : String(err)}`);
      validatedPlan = null;
    }
  }

  const commitOut = await runLocked(() => {
    if (options.lock?.getEpoch && options.lock.getEpoch() !== snap.startEpoch) {
      return {
        stale: true as const, lastDreamSeq: snap.meta.lastDreamSeq || 0,
        episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0,
        factsAdded: 0, factsUpdated: 0, factsDeleted: 0,
      };
    }
    const latestMeta = readMetaOrRecover(archiveDir, { writeRecovered: true });
    if (latestMeta.lastDreamSeq !== snap.meta.lastDreamSeq) {
      return {
        stale: true as const, lastDreamSeq: latestMeta.lastDreamSeq || 0,
        episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0,
        factsAdded: 0, factsUpdated: 0, factsDeleted: 0,
      };
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

    const factOps = validatedPlan !== null
      ? (validatedPlan.facts ?? [])
      : extractHeuristicFactOps(snap.pending, listActiveFacts(archiveDir), latestMeta.partnerName);
    const factRep = applyFactOperations(archiveDir, factOps, {
      nowMs,
      defaultSubject: latestMeta.partnerName,
      defaultBodyType: snap.pending[snap.pending.length - 1]?.bodyType,
    });

    const updatedMeta = readMetaOrRecover(archiveDir, { writeRecovered: true });
    updatedMeta.lastDreamSeq = snap.pending[snap.pending.length - 1].seq;
    writeJsonAtomic(resolveArchivePaths(archiveDir).meta, updatedMeta);
    refreshDerivedSoulFiles(archiveDir);
    return {
      stale: false as const,
      lastDreamSeq: updatedMeta.lastDreamSeq,
      episodesAdded,
      commitmentsAdded,
      coBecomingAdded,
      factsAdded: factRep.added,
      factsUpdated: factRep.updated,
      factsDeleted: factRep.deleted,
    };
  });

  if (commitOut.stale) {
    return {
      ok: true, processedEntries: 0, lastDreamSeq: commitOut.lastDreamSeq,
      episodesAdded: 0, commitmentsAdded: 0, coBecomingAdded: 0,
      factsAdded: 0, factsUpdated: 0, factsDeleted: 0,
      vectorsIndexed: 0, summaryNote: '做梦整理期间档案已切换或已被并发整理，本次结果已安全跳过。',
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

  const factChanged = commitOut.factsAdded + commitOut.factsUpdated + commitOut.factsDeleted;
  const factNote = factChanged > 0
    ? `、事实更新(新增 ${commitOut.factsAdded}/覆写 ${commitOut.factsUpdated}/删除 ${commitOut.factsDeleted})`
    : '';
  return {
    ok: true,
    processedEntries: snap.pending.length,
    lastDreamSeq: commitOut.lastDreamSeq,
    episodesAdded: commitOut.episodesAdded,
    commitmentsAdded: commitOut.commitmentsAdded,
    coBecomingAdded: commitOut.coBecomingAdded,
    factsAdded: commitOut.factsAdded,
    factsUpdated: commitOut.factsUpdated,
    factsDeleted: commitOut.factsDeleted,
    vectorsIndexed: vecRep.indexed,
    summaryNote: `已做梦整理 ${snap.pending.length} 条经历：新增 ${commitOut.episodesAdded} 条情景卡、${commitOut.commitmentsAdded} 条未完约定${factNote}。`,
  };
}
