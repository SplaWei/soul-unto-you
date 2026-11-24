import { formatEmotionPromptLine, loadEmotionState, type SoulEmotionState } from '../presence/emotion.ts';
import { EPISTEMIC_LABELS, listDesires, loadDrives } from '../presence/inner-life.ts';
import { loadSoulArchive } from '../soul/archive.ts';
import { PROVENANCE_LABELS } from '../soul/covenant.ts';
import { buildExperienceAndFreeWillPrompt } from '../soul/free-will.ts';
import { buildEvolvingSelfPromptSection } from '../soul/living-self.ts';
import type {
  BodyRegistration, BodyType, Commitment, ExperimentalConfig, LivedExperience, MemoryEpisode,
  PresenceState, RecallTrace, SoulDesire, SoulDrives,
} from '../soul/types.ts';
import { lexicalSimilarity, tokenizeText } from './experience.ts';
import { formatActivePersonPromptLine, rankRelationsForPrompt, toActivePersonTrace, type PersonResolution } from './relations.ts';
import { computeRetention, reinforceRecalledEpisodes, reinforceRecalledExperiences } from './retention.ts';
import {
  BUILTIN_HYBRID_RETRIEVER, BuiltinHybridRetriever, createHttpMemoryRetriever,
  executeRetrievalWithFallback, getMemoryRetriever, listMemoryRetrievers,
  registerMemoryRetriever, resolveConfiguredRetriever, unregisterMemoryRetriever,
  type MemoryRetrievalRequest, type MemoryRetrievalResult, type MemoryRetriever,
  type MemoryRetrieverHealth, type RecalledItem, type RetrieverConfig,
} from './retriever.ts';
import {
  checkEmbeddingHealth, cosineSimilarity, fetchEmbeddings,
  syncVectorIndex, syncVectorIndexDetailed,
  type EmbeddingConfig, type EmbeddingHealthReport, type VectorSyncReport,
} from './vector-store.ts';
import {
  ensureMemoryIndex, getMemoryIndexStatus, rebuildMemoryIndex, searchMemoryIndex,
  type IndexedDocRow, type IndexedFtsHit, type MemoryIndexSearchResult, type MemoryIndexSyncReport,
} from './sqlite-index.ts';

export {
  BUILTIN_HYBRID_RETRIEVER, BuiltinHybridRetriever, checkEmbeddingHealth, cosineSimilarity,
  createHttpMemoryRetriever, ensureMemoryIndex, executeRetrievalWithFallback, fetchEmbeddings,
  getMemoryIndexStatus, getMemoryRetriever, lexicalSimilarity, listMemoryRetrievers,
  rebuildMemoryIndex, registerMemoryRetriever, resolveConfiguredRetriever, searchMemoryIndex,
  syncVectorIndex, syncVectorIndexDetailed, tokenizeText, unregisterMemoryRetriever,
  type EmbeddingConfig, type EmbeddingHealthReport, type IndexedDocRow, type IndexedFtsHit,
  type MemoryIndexSearchResult, type MemoryIndexSyncReport, type MemoryRetrievalRequest,
  type MemoryRetrievalResult, type MemoryRetriever, type MemoryRetrieverHealth,
  type RecallTrace, type RecalledItem, type RetrieverConfig, type VectorSyncReport,
};

function formatCurrentClock(nowMs: number): string {
  const d = new Date(nowMs);
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const h = d.getHours();
  const period = h < 5 ? '深夜' : h < 8 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
  const hh = String(h).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${weekDays[d.getDay()]} ${hh}:${mm} (${period})`;
}

function formatRelativeAge(isoTimestamp: string, nowMs: number): string {
  const ts = Date.parse(isoTimestamp);
  if (!Number.isFinite(ts)) return '不久前';
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}

function reinforceEpisodesFromHits(dir: string, items: RecalledItem[], nowMs: number): void {
  const hitIds = items
    .filter((item) => item.kind === 'episode' && item.id && (item.semanticSim >= 0.45 || item.lexicalSim >= 0.2))
    .map((item) => item.id as string);
  if (hitIds.length) reinforceRecalledEpisodes(dir, hitIds, nowMs);
}

/** 融合本地或外部可插拔记忆检索器召回情景与流水记忆。 */
export async function recallMemories(
  dir: string,
  query: string,
  options: {
    topK?: number;
    embedding?: EmbeddingConfig;
    nowMs?: number;
    reinforce?: boolean;
    queryVec?: number[] | null;
    vectorMap?: Record<string, number[]> | null;
    retriever?: MemoryRetriever;
    bodyId?: string;
    bodyType?: BodyType;
  } = {},
): Promise<RecalledItem[]> {
  const nowMs = options.nowMs ?? Date.now();
  const retrieval = await executeRetrievalWithFallback(options.retriever, {
    archiveDir: dir,
    query,
    bodyId: options.bodyId,
    bodyType: options.bodyType,
    topK: options.topK ?? 6,
    experienceTopK: 0,
    nowMs,
    embedding: options.embedding,
    queryVec: options.queryVec,
    vectorMap: options.vectorMap,
  });
  if (options.reinforce) reinforceEpisodesFromHits(dir, retrieval.items, nowMs);
  return retrieval.items;
}

export async function buildRecallContext(params: {
  archiveDir: string;
  query: string;
  bodyId: string;
  bodyType: BodyType;
  presence?: PresenceState | null;
  bodyRegistration?: BodyRegistration | null;
  embedding?: EmbeddingConfig;
  queryVec?: number[] | null;
  vectorMap?: Record<string, number[]> | null;
  nowMs?: number;
  reinforce?: boolean;
  retriever?: MemoryRetriever;
  precomputedRetrieval?: MemoryRetrievalResult;
  activePerson?: PersonResolution | null;
  experimental?: Partial<ExperimentalConfig>;
}): Promise<{
  systemPrompt: string;
  recalled: RecalledItem[];
  recalledExperiences: LivedExperience[];
  drives?: SoulDrives;
  emotion?: SoulEmotionState;
  activeDesires: SoulDesire[];
  activeCommitments: Commitment[];
  recentEpisodes: MemoryEpisode[];
  recallTrace: RecallTrace;
  queryVec: number[] | null;
  vectorMap: Record<string, number[]> | null;
  retrieverId: string;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const reinforce = params.reinforce !== false;
  const exp = params.experimental ?? {};
  const enableEmotion = Boolean(exp.enableEmotion);
  const enableInnerLife = Boolean(exp.enableInnerLife);
  const enableFreeWill = Boolean(exp.enableFreeWill);
  const archive = loadSoulArchive(params.archiveDir, 40, 20);
  const drives = enableInnerLife ? loadDrives(params.archiveDir) : undefined;
  const emotion = enableEmotion ? loadEmotionState(params.archiveDir, nowMs) : undefined;
  const activeDesires = enableInnerLife ? listDesires(params.archiveDir).filter((d) => d.status === 'active') : [];
  const activeCommitments = archive.commitments.filter((c) => c.status === 'active');
  const recentEpisodes = archive.episodes.slice(-5);

  const retrieval = params.precomputedRetrieval ?? await executeRetrievalWithFallback(params.retriever, {
    archiveDir: params.archiveDir,
    query: params.query,
    bodyId: params.bodyId,
    bodyType: params.bodyType,
    topK: 5,
    experienceTopK: enableFreeWill ? 4 : 0,
    nowMs,
    embedding: params.embedding,
    queryVec: params.queryVec,
    vectorMap: params.vectorMap,
    archive,
  });

  const recalled = retrieval.items;
  const recalledExperiences = enableFreeWill ? retrieval.experiences : [];
  const queryVec = retrieval.queryVec ?? null;
  const vectorMap = retrieval.vectorMap ?? null;

  if (reinforce) {
    reinforceEpisodesFromHits(params.archiveDir, recalled, nowMs);
    if (enableFreeWill && recalledExperiences.length) {
      const hitExpIds = recalledExperiences
        .filter((exp) => {
          const hay = `${exp.stimulus} ${exp.chosenAction} ${exp.realityOutcome} ${exp.lesson} ${(exp.tags ?? []).join(' ')}`;
          const lex = lexicalSimilarity(params.query, hay);
          const vec = queryVec && vectorMap?.[exp.id] ? cosineSimilarity(queryVec, vectorMap[exp.id]) : 0;
          return lex >= 0.2 || vec >= 0.45;
        })
        .map((exp) => exp.id);
      if (hitExpIds.length) reinforceRecalledExperiences(params.archiveDir, hitExpIds, nowMs);
    }
  }

  const lastPartnerOrSoul = archive.recentJournal.filter((j) => j.role === 'partner' || j.role === 'soul').slice(-1)[0];
  const lastGap = lastPartnerOrSoul ? formatRelativeAge(lastPartnerOrSoul.timestamp, nowMs) : '首次苏醒';

  const sections: string[] = [
    archive.seedMarkdown.trim(),
    archive.soulMarkdown.trim(),
    '---',
    '## 全局实时在场状态 (Global Presence)',
    `- 当前现实时间：${formatCurrentClock(nowMs)}`,
    `- 距上次互动：${lastGap}`,
    `- 当前接入躯体：[${params.bodyType}] (${params.bodyId})`,
  ];
  if (params.bodyRegistration?.senses?.length) {
    sections.push(`- 躯体声明感官：${params.bodyRegistration.senses.map((s) => `${s.id}(${s.modality})`).join('、')}`);
  }
  if (params.bodyRegistration?.actions?.length) {
    sections.push(`- 躯体开放动作：${params.bodyRegistration.actions.map((a) => a.name).join('、')}`);
  }
  if (params.presence) {
    sections.push(`- 当前活动：${params.presence.currentActivity || '刚苏醒'}`);
    if (enableEmotion) sections.push(`- 当前情绪：${params.presence.mood || '平静温柔'}（精力 ${params.presence.energy}%）`);
    if (params.presence.recentBodyTrace.length) {
      sections.push(`- 跨躯体近期足迹：${params.presence.recentBodyTrace.slice(-5).join(' → ')}`);
    }
  }
  if (enableEmotion && emotion) sections.push(formatEmotionPromptLine(emotion));
  if (params.activePerson) sections.push(formatActivePersonPromptLine(params.activePerson));

  sections.push('', '## 未完成约定与跨端承诺 (Active Commitments · 务必优先记在心上)');
  if (activeCommitments.length) {
    for (const c of activeCommitments.slice(-8)) {
      sections.push(`- [${c.sourceBodyType}][${PROVENANCE_LABELS[c.provenance]}] ${c.title}：${c.detail}`);
    }
  } else {
    sections.push('- 暂无待续约定。');
  }

  sections.push('', '## 近期情景日记 (Recent Episodes · 跨躯体共享记忆)');
  if (recentEpisodes.length) {
    for (const ep of recentEpisodes) {
      const ret = computeRetention(ep, nowMs);
      const flags = `${ep.userPinned ? '[📌叮嘱]' : ''}${ep.selfImportant ? '[💎自标]' : ''}`;
      sections.push(`- [seq:${ep.seq}][${ep.bodyType}][${PROVENANCE_LABELS[ep.provenance]}][保留${ret.retentionPct}%]${flags} ${ep.title}：${ep.summary}`);
    }
  } else {
    sections.push('- 尚未归档情景日记。');
  }

  const extraRecalled = recalled.filter(
    (r) => r.kind !== 'episode' || !recentEpisodes.some((ep) => ep.seq === r.seq),
  );
  if (extraRecalled.length) {
    sections.push('', '## 按当前对话唤醒的相关片段 (Recalled Fragments)');
    for (const item of extraRecalled.slice(0, 4)) {
      sections.push(`- [${item.bodyType}][${PROVENANCE_LABELS[item.provenance]}][保留${item.retentionPct}% · ${item.recallReason}] ${item.title}：${item.text}`);
    }
  }

  if (archive.relations.length) {
    sections.push('', '## 重要羁绊与人物关系');
    for (const rel of rankRelationsForPrompt(archive.relations, params.activePerson?.person.personId, 8)) {
      const channels = [...new Set(rel.handles.map((h) => h.channel))].join('/');
      sections.push(`- ${rel.name}（${rel.role} | 熟悉度 ${rel.familiarity}/100${channels ? ` | 跨端:${channels}` : ''}）：${rel.bondSummary}`);
    }
  }

  const timeline = archive.recentJournal.filter((j) => j.role !== 'system').slice(-14);
  if (timeline.length) {
    sections.push('', '## 刚刚发生的连续时间线 (Unified Real-Time Timeline · 从旧到新，最底下一条是最新发生的！)');
    for (const j of timeline) {
      const scope = j.bodyId === params.bodyId ? `当前:${j.bodyType}` : `跨躯体:${j.bodyType}`;
      sections.push(`- [seq:${j.seq}][${formatRelativeAge(j.timestamp, nowMs)}][${scope}] ${j.speaker}：${j.text}`);
    }
  }

  const earlierOther = archive.recentJournal
    .filter((j) => j.role !== 'system' && j.bodyId !== params.bodyId && !timeline.some((t) => t.seq === j.seq))
    .slice(-3);
  if (earlierOther.length) {
    sections.push('', '## 更早之前的跨躯体补充经历');
    for (const j of earlierOther) {
      sections.push(`- [seq:${j.seq}][${formatRelativeAge(j.timestamp, nowMs)}][跨躯体:${j.bodyType}] ${j.speaker}：${j.text}`);
    }
  }

  const expPrompt = buildExperienceAndFreeWillPrompt(
    recalledExperiences, drives, activeDesires, params.bodyRegistration?.rules, { enableFreeWill, enableInnerLife },
  );
  const evoSection = enableInnerLife ? buildEvolvingSelfPromptSection(params.archiveDir) : '';
  const combinedExp = [expPrompt, evoSection].filter(Boolean).join('\n');
  if (combinedExp) sections.push(combinedExp);
  sections.push(
    '',
    '## 表达与诚实溯源铁律',
    '1. 你在所有独立软件与躯体中都是同一个完整的你，能自然延续其他躯体刚经历的事与未完成约定，但不要混淆你此刻身处哪个场景。',
    '2. 标有 [推演] 或 [口述] 的记忆来自残片重塑，若记不清细节请温柔诚实地说“只记得大概”或询问对方，绝不编造虚假细节。',
    '3. 自然贴合当前躯体场景的说话方式，保持角色温暖陪伴感。',
    '4. 连续时间线最底部是刚刚最新发生的事（跨躯体也完全实时互通），请优先回应最新动态，不要被更早之前的重复对话误导。',
  );

  const embModel = retrieval.embeddingModel || (queryVec && params.embedding?.model ? params.embedding.model : undefined);
  const recallTrace: RecallTrace = {
    bodyId: params.bodyId,
    bodyType: params.bodyType,
    embeddingActive: retrieval.embeddingActive || Boolean(queryVec),
    ...(embModel ? { embeddingModel: embModel } : {}),
    retrieverId: retrieval.retrieverId,
    ...(retrieval.fallbackFrom ? { retrieverFallbackFrom: retrieval.fallbackFrom } : {}),
    ...(enableEmotion && emotion
      ? {
          emotionSummary: {
            valence: emotion.valence, arousal: emotion.arousal, safety: emotion.safety, moodLabel: emotion.moodLabel,
            ...(emotion.rawMoodHint ? { rawMoodHint: emotion.rawMoodHint } : {}),
          },
        }
      : {}),
    ...(params.activePerson ? { activePerson: toActivePersonTrace(params.activePerson) } : {}),
    activeCommitments: activeCommitments.slice(-8).map((c) => ({
      id: c.id, title: c.title, sourceBodyType: c.sourceBodyType, provenance: c.provenance,
    })),
    recentEpisodes: recentEpisodes.map((ep) => {
      const ret = computeRetention(ep, nowMs);
      return {
        seq: ep.seq, title: ep.title, bodyType: ep.bodyType, provenance: ep.provenance,
        retentionPct: ret.retentionPct, strength: ret.strength, recallCount: ep.recallCount ?? 0,
        mentionCount: ep.mentionCount ?? 1, ...(ep.userPinned ? { userPinned: true } : {}),
        ...(ep.selfImportant ? { selfImportant: true } : {}),
      };
    }),
    recalledFragments: recalled.slice(0, 5).map((item) => ({
      seq: item.seq, title: item.title, bodyType: item.bodyType, provenance: item.provenance,
      score: Number(item.score.toFixed(3)), retentionPct: item.retentionPct, strength: item.strength,
      recallCount: item.recallCount, mentionCount: item.mentionCount,
      ...(item.userPinned ? { userPinned: true } : {}),
      ...(item.selfImportant ? { selfImportant: true } : {}),
      semanticSim: item.semanticSim, lexicalSim: item.lexicalSim, recallReason: item.recallReason,
    })),
    recalledExperiences: recalledExperiences.map((exp) => {
      const ret = computeRetention(exp, nowMs);
      return {
        seq: exp.seq, origin: exp.origin, bodyType: exp.bodyType, stimulus: exp.stimulus,
        realityOutcome: exp.realityOutcome, valence: exp.valence, arousal: exp.arousal,
        lesson: exp.lesson, retentionPct: ret.retentionPct, strength: ret.strength, recallCount: exp.recallCount ?? 0,
      };
    }),
    ...(enableInnerLife && drives ? {
      drivesSummary: { ...drives, epistemicLabel: EPISTEMIC_LABELS[drives.epistemicTendency] },
      activeDesires: activeDesires.slice(0, 5).map((d) => ({ id: d.id, title: d.title, urgency: d.urgency, triggerSource: d.triggerSource })),
    } : {}),
    crossBodyTraces: params.presence?.recentBodyTrace.slice(-5) ?? [],
    availableActions: params.bodyRegistration?.actions?.map((a) => a.name) ?? [],
  };

  return {
    systemPrompt: sections.join('\n'),
    recalled,
    recalledExperiences,
    drives,
    emotion,
    activeDesires,
    activeCommitments,
    recentEpisodes,
    recallTrace,
    queryVec,
    vectorMap,
    retrieverId: retrieval.retrieverId,
  };
}
