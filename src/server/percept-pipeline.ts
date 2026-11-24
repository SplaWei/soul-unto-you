import { ingestRealityFeedback } from '../memory/experience.ts';
import { resolveAndRecordSpeaker, toActivePersonTrace } from '../memory/relations.ts';
import { engraveMemoryFromTurn } from '../memory/retention.ts';
import { buildRecallContext } from '../memory/search.ts';
import { applyTurnEmotion, loadEmotionState, toPresenceEmotion } from '../presence/emotion.ts';
import { appendJournal, loadSoulArchive } from '../soul/archive.ts';
import type { BodyType, ModalityPacket, SoulActionIntent } from '../soul/types.ts';
import type { SoulHubContext } from './body-api.ts';
import { detectSystemNoise } from './noise-filter.ts';
import {
  captureLastPrompt, collectAvailableActions, collectImages, dispatchRemoteActions,
  filterAuthorizedActions, prepareRetrievalOutsideLock, recordObserveInArchive, scheduleDebouncedVectorSync,
} from './percept-helpers.ts';

export interface PerceptInput {
  bodyId?: string;
  bodyType?: BodyType;
  displayName?: string;
  speaker?: string;
  text: string;
  externalSystemContext?: string;
  wantVoice?: boolean;
  images?: Array<{ base64: string; mimeType?: string }>;
  modalities?: ModalityPacket[];
  metadata?: Record<string, unknown>;
}

export interface ObserveInput {
  bodyId?: string;
  bodyType?: BodyType;
  displayName?: string;
  summary?: string;
  text?: string;
  allowSpeak?: boolean;
  urgency?: 'low' | 'normal' | 'high';
  modalities?: ModalityPacket[];
  images?: Array<{ base64: string; mimeType?: string }>;
  metadata?: Record<string, unknown>;
}

const STALE_ERR = '灵魂档案已切换或回滚，本轮延迟结果已丢弃';

export async function processPercept(ctx: SoulHubContext, input: PerceptInput) {
  const bodyId = String(input.bodyId || 'body-unknown').trim();
  const bodyType: BodyType = String(input.bodyType || 'api').trim() || 'api';
  const text = String(input.text ?? '').trim();
  const speaker = String(input.speaker ?? '').trim();
  if (!text) throw new Error('感知输入 text 不能为空');

  const startedAt = Date.now();
  const expCfg = ctx.config.experimental;
  ctx.dreamScheduler?.markActivity();
  const prefetchDir = ctx.config.archiveDir;
  const prepared = await prepareRetrievalOutsideLock(ctx, prefetchDir, text, bodyId, bodyType);

  const snap = await ctx.presence.withSoulLock(async () => {
    const activeDir = ctx.config.archiveDir;
    const startEpoch = ctx.presence.getEpoch();
    const archive = loadSoulArchive(activeDir, 10, 5);
    const actualSpeaker = speaker || archive.identity.partnerName || '同行者';
    const bodyReg = ctx.presence.getBody(bodyId);
    const activePerson = resolveAndRecordSpeaker(activeDir, {
      bodyId, bodyType, speaker: actualSpeaker, partnerName: archive.identity.partnerName, metadata: input.metadata,
    });
    const sameDir = activeDir === prefetchDir;
    const recalledCtx = await buildRecallContext({
      archiveDir: activeDir, query: text, bodyId, bodyType, presence: ctx.presence.getState(),
      bodyRegistration: bodyReg, embedding: ctx.config.embedding, retriever: ctx.retriever, activePerson, experimental: expCfg,
      queryVec: sameDir ? prepared.queryVec : null,
      vectorMap: sameDir ? prepared.vectorMap : null,
      ...(sameDir && prepared.precomputedRetrieval ? { precomputedRetrieval: prepared.precomputedRetrieval } : {}),
    });
    appendJournal(activeDir, {
      bodyId, bodyType, speaker: actualSpeaker, role: 'partner', text, provenance: 'verified',
      personId: activePerson.person.personId, metadata: input.metadata,
    });
    const fbExp = expCfg.enableFreeWill && input.metadata?.realityFeedback
      ? ingestRealityFeedback(activeDir, { bodyId, bodyType, summary: text, speaker: actualSpeaker, metadata: input.metadata })
      : null;
    return {
      activeDir, startEpoch, archive, actualSpeaker, activePerson, recalledCtx,
      availableActions: collectAvailableActions(ctx, bodyId), fbExp,
    };
  });
  if (snap.fbExp) ctx.events.emit('experience.recorded', snap.fbExp);

  const chatRes = await ctx.llm.chat({
    systemPrompt: snap.recalledCtx.systemPrompt, externalSystemContext: input.externalSystemContext, userText: text,
    speaker: snap.actualSpeaker, bodyType, soulName: snap.archive.identity.name, catchphrase: snap.archive.identity.catchphrases[0],
    images: collectImages(input.images, input.modalities), availableActions: snap.availableActions, modalities: input.modalities,
    experimental: expCfg,
    recalledExperiences: expCfg.enableFreeWill ? snap.recalledCtx.recalledExperiences : undefined,
    drives: expCfg.enableInnerLife ? snap.recalledCtx.drives : undefined,
  });
  captureLastPrompt(ctx, { source: 'percept', bodyId, bodyType, driver: chatRes.driver, model: chatRes.model, systemPrompt: chatRes.usedSystemPrompt ?? snap.recalledCtx.systemPrompt, userText: text });

  if (chatRes.toolFollowUpFailed) {
    return {
      ok: false, toolFollowUpFailed: true, error: chatRes.toolFollowUpError || '工具二轮补全失败',
      soulName: snap.archive.identity.name, reply: '', decidedToSpeak: false, mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静',
      actions: [] as SoulActionIntent[], ...(expCfg.enableFreeWill && chatRes.freeWill ? { freeWill: chatRes.freeWill } : {}),
      driver: chatRes.driver, model: chatRes.model, presence: ctx.presence.getState(),
    };
  }

  const safeActions = filterAuthorizedActions(chatRes.actions, snap.availableActions);
  const voice = input.wantVoice ? await ctx.voice.speakToBase64(chatRes.reply) : undefined;

  const commit = await ctx.presence.withSoulLock(async () => {
    if (ctx.config.archiveDir !== snap.activeDir || ctx.presence.getEpoch() !== snap.startEpoch) {
      return { stale: true as const };
    }
    if (expCfg.enableFreeWill) snap.recalledCtx.recallTrace.freeWillDecision = chatRes.freeWill;
    appendJournal(snap.activeDir, { bodyId, bodyType, speaker: snap.archive.identity.name, role: 'soul', text: chatRes.reply, provenance: 'verified' });
    const engraved = engraveMemoryFromTurn(snap.activeDir, {
      bodyId, bodyType, speaker: snap.actualSpeaker, soulName: snap.archive.identity.name,
      userText: text, soulReply: chatRes.reply, selfImportant: chatRes.selfImportant,
      selfImportantReason: chatRes.selfImportantReason, queryVec: snap.recalledCtx.queryVec, vectorMap: snap.recalledCtx.vectorMap,
    });
    const emotion = expCfg.enableEmotion
      ? applyTurnEmotion(snap.activeDir, { rawMood: chatRes.mood, stance: chatRes.freeWill?.stance, source: 'turn', note: text.slice(0, 40) })
      : null;
    const nextPresence = ctx.presence.recordActivity({
      bodyId, bodyType, displayName: input.displayName,
      activity: `在 [${bodyType}] 与 ${snap.actualSpeaker} 交流：${text.slice(0, 28)}`,
      mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion: toPresenceEmotion(emotion) } : {}), energyDelta: -1,
    });
    return { stale: false as const, engraved, nextPresence, emotion };
  });

  if (commit.stale) {
    return {
      ok: false, stale: true, error: STALE_ERR, soulName: snap.archive.identity.name,
      reply: '', decidedToSpeak: false, mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静',
      actions: [] as SoulActionIntent[], presence: ctx.presence.getState(),
    };
  }

  if (commit.engraved) {
    snap.recalledCtx.recallTrace.engravedMemories = [commit.engraved];
    ctx.events.emit('memory.engraved', { ...commit.engraved, bodyId });
    if (ctx.config.embedding.enabled) scheduleDebouncedVectorSync(ctx, snap.activeDir, snap.startEpoch);
  }
  dispatchRemoteActions(ctx, bodyId, bodyType, safeActions);
  ctx.dreamScheduler?.markActivity();

  const payload = {
    ok: true, soulName: snap.archive.identity.name, reply: chatRes.reply, decidedToSpeak: chatRes.decidedToSpeak,
    mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静', ...(commit.emotion ? { emotion: commit.emotion } : {}),
    activePerson: toActivePersonTrace(snap.activePerson), actions: safeActions,
    ...(expCfg.enableFreeWill && chatRes.freeWill ? { freeWill: chatRes.freeWill } : {}),
    driver: chatRes.driver, model: chatRes.model,
    ...(chatRes.toolCallMode ? { toolCallMode: chatRes.toolCallMode } : {}),
    ...(chatRes.fallbackFrom ? { fallbackFrom: chatRes.fallbackFrom } : {}),
    usedMemoryCount: snap.recalledCtx.activeCommitments.length + snap.recalledCtx.recentEpisodes.length + snap.recalledCtx.recalled.length + snap.recalledCtx.recalledExperiences.length,
    recalled: snap.recalledCtx.recalled, recalledExperiences: snap.recalledCtx.recalledExperiences,
    recallTrace: snap.recalledCtx.recallTrace, latencyMs: Date.now() - startedAt, presence: commit.nextPresence,
    ...(voice !== undefined ? { voice } : {}),
  };
  ctx.ws?.broadcastJson({ type: 'presence', presence: commit.nextPresence });
  ctx.events.emit('percept', { bodyId, bodyType, mood: payload.mood, actions: safeActions });
  return payload;
}

export async function processObserve(ctx: SoulHubContext, input: ObserveInput) {
  const bodyId = String(input.bodyId || 'observer').trim();
  const bodyType: BodyType = String(input.bodyType || 'api').trim() || 'api';
  const rawSummary = String(input.summary ?? input.text ?? '').trim();
  if (!rawSummary) throw new Error('观察事件 summary/text 不能为空');

  const noise = detectSystemNoise(rawSummary, {
    bodyType, noisePatterns: ctx.presence.getBody(bodyId)?.noisePatterns, metadata: input.metadata,
  });
  if (noise.isNoise) {
    const st = ctx.presence.getState();
    return {
      ok: true, filtered: true, filterReason: noise.reason, decidedToSpeak: false,
      reply: '', mood: st.mood, actions: [] as SoulActionIntent[], recordedExperience: null, presence: st,
    };
  }

  const expCfg = ctx.config.experimental;
  const summary = noise.cleanedText;
  ctx.dreamScheduler?.markActivity();
  if (!input.allowSpeak) {
    const out = await ctx.presence.withSoulLock(async () => {
      const dir = ctx.config.archiveDir;
      const recordedExp = recordObserveInArchive(dir, bodyId, bodyType, summary, input, expCfg.enableFreeWill);
      const emotion = expCfg.enableEmotion ? loadEmotionState(dir) : null;
      const nextPresence = ctx.presence.recordActivity({
        bodyId, bodyType, displayName: input.displayName,
        activity: `静默感知 [${bodyType}]：${summary.slice(0, 28)}`,
        mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion: toPresenceEmotion(emotion) } : {}),
      });
      return { recordedExp, nextPresence, emotion };
    });
    if (out.recordedExp) {
      ctx.events.emit('experience.recorded', out.recordedExp);
      ctx.ws?.broadcastJson({ type: 'experience.recorded', experience: out.recordedExp });
    }
    ctx.dreamScheduler?.markActivity();
    ctx.ws?.broadcastJson({ type: 'presence', presence: out.nextPresence });
    ctx.events.emit('observe', { bodyId, bodyType, summary, decidedToSpeak: false, recordedExperience: out.recordedExp });
    return { ok: true, decidedToSpeak: false, reply: '', mood: out.nextPresence.mood, ...(out.emotion ? { emotion: out.emotion } : {}), actions: [], recordedExperience: out.recordedExp, presence: out.nextPresence };
  }

  const prefetchDir = ctx.config.archiveDir;
  const prepared = await prepareRetrievalOutsideLock(ctx, prefetchDir, summary, bodyId, bodyType);
  const snap = await ctx.presence.withSoulLock(async () => {
    const activeDir = ctx.config.archiveDir;
    const startEpoch = ctx.presence.getEpoch();
    const archive = loadSoulArchive(activeDir, 10, 5);
    const bodyReg = ctx.presence.getBody(bodyId);
    const sameDir = activeDir === prefetchDir;
    // 先召回后落盘当前观察目击，避免同一条观察在同一轮 prompt 里出现三次。
    const recalledCtx = await buildRecallContext({
      archiveDir: activeDir, query: summary, bodyId, bodyType, presence: ctx.presence.getState(),
      bodyRegistration: bodyReg, embedding: ctx.config.embedding, retriever: ctx.retriever, experimental: expCfg,
      queryVec: sameDir ? prepared.queryVec : null,
      vectorMap: sameDir ? prepared.vectorMap : null,
      ...(sameDir && prepared.precomputedRetrieval ? { precomputedRetrieval: prepared.precomputedRetrieval } : {}),
    });
    const recordedExp = recordObserveInArchive(activeDir, bodyId, bodyType, summary, input, expCfg.enableFreeWill);
    const emotion = expCfg.enableEmotion ? loadEmotionState(activeDir) : null;
    ctx.presence.recordActivity({
      bodyId, bodyType, displayName: input.displayName,
      activity: `静默感知 [${bodyType}]：${summary.slice(0, 28)}`,
      mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion: toPresenceEmotion(emotion) } : {}),
    });
    return { activeDir, startEpoch, archive, recordedExp, recalledCtx, availableActions: collectAvailableActions(ctx, bodyId) };
  });
  if (snap.recordedExp) {
    ctx.events.emit('experience.recorded', snap.recordedExp);
    ctx.ws?.broadcastJson({ type: 'experience.recorded', experience: snap.recordedExp });
  }

  const chatRes = await ctx.llm.chat({
    systemPrompt: snap.recalledCtx.systemPrompt, userText: `[环境静默观察 (${input.urgency || 'normal'})] ${summary}`,
    speaker: input.displayName || bodyType, bodyType, soulName: snap.archive.identity.name, catchphrase: snap.archive.identity.catchphrases[0],
    images: collectImages(input.images, input.modalities), availableActions: snap.availableActions, modalities: input.modalities,
    observeMode: true, experimental: expCfg,
    recalledExperiences: expCfg.enableFreeWill ? snap.recalledCtx.recalledExperiences : undefined,
    drives: expCfg.enableInnerLife ? snap.recalledCtx.drives : undefined,
  });
  captureLastPrompt(ctx, { source: 'observe', bodyId, bodyType, driver: chatRes.driver, model: chatRes.model, systemPrompt: chatRes.usedSystemPrompt ?? snap.recalledCtx.systemPrompt, userText: summary });

  if (chatRes.toolFollowUpFailed) {
    const emotion = expCfg.enableEmotion ? loadEmotionState(snap.activeDir) : null;
    return {
      ok: false, toolFollowUpFailed: true, error: chatRes.toolFollowUpError || '工具二轮补全失败',
      decidedToSpeak: false, reply: '', mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion } : {}),
      actions: [] as SoulActionIntent[], ...(expCfg.enableFreeWill && chatRes.freeWill ? { freeWill: chatRes.freeWill } : {}),
      recordedExperience: snap.recordedExp, driver: chatRes.driver, model: chatRes.model, presence: ctx.presence.getState(),
    };
  }

  const safeActions = filterAuthorizedActions(chatRes.actions, snap.availableActions);
  const finalState = await ctx.presence.withSoulLock(async () => {
    if (ctx.config.archiveDir !== snap.activeDir || ctx.presence.getEpoch() !== snap.startEpoch) {
      return { stale: true as const };
    }
    if (chatRes.decidedToSpeak && chatRes.reply) {
      appendJournal(snap.activeDir, { bodyId, bodyType, speaker: snap.archive.identity.name, role: 'soul', text: chatRes.reply, provenance: 'verified' });
      const emotion = expCfg.enableEmotion ? applyTurnEmotion(snap.activeDir, { rawMood: chatRes.mood, stance: chatRes.freeWill?.stance, source: 'observe', note: summary.slice(0, 40) }) : null;
      return {
        stale: false as const,
        presence: ctx.presence.recordActivity({
          bodyId, bodyType, activity: `在 [${bodyType}] 主动开口：${chatRes.reply.slice(0, 24)}`,
          mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion: toPresenceEmotion(emotion) } : {}),
        }),
        emotion,
      };
    }
    return { stale: false as const, presence: ctx.presence.getState(), emotion: expCfg.enableEmotion ? loadEmotionState(snap.activeDir) : null };
  });

  if (finalState.stale) {
    return {
      ok: false, stale: true, error: STALE_ERR, decidedToSpeak: false, reply: '',
      mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静', actions: [] as SoulActionIntent[], recordedExperience: snap.recordedExp,
      presence: ctx.presence.getState(),
    };
  }

  const obsMood = expCfg.enableEmotion ? chatRes.mood : '温柔平静';
  dispatchRemoteActions(ctx, bodyId, bodyType, safeActions);
  if (chatRes.decidedToSpeak && chatRes.reply) {
    ctx.ws?.broadcastJson({ type: 'proactive', bodyId, bodyType, reply: chatRes.reply, mood: obsMood, actions: safeActions });
  }
  ctx.dreamScheduler?.markActivity();
  ctx.ws?.broadcastJson({ type: 'presence', presence: finalState.presence });
  ctx.events.emit('observe', { bodyId, bodyType, summary, decidedToSpeak: chatRes.decidedToSpeak, reply: chatRes.reply, actions: safeActions, recordedExperience: snap.recordedExp });
  return { ok: true, decidedToSpeak: chatRes.decidedToSpeak, reply: chatRes.reply, mood: obsMood, ...(finalState.emotion ? { emotion: finalState.emotion } : {}), actions: safeActions, ...(expCfg.enableFreeWill && chatRes.freeWill ? { freeWill: chatRes.freeWill } : {}), recordedExperience: snap.recordedExp, driver: chatRes.driver, model: chatRes.model, presence: finalState.presence };
}

async function executeProactive(
  ctx: SoulHubContext,
  input: { bodyId?: string; bodyType?: BodyType; hint?: string },
  useLock: boolean,
) {
  const expCfg = ctx.config.experimental;
  const bodyId = String(input.bodyId || 'web-console').trim();
  const bodyType: BodyType = String(input.bodyType || 'web').trim() || 'web';
  const query = input.hint || '未完成约定 近期记忆';
  const runInLock = <T>(fn: () => Promise<T>): Promise<T> => (useLock ? ctx.presence.withSoulLock(fn) : fn());
  const prefetchDir = ctx.config.archiveDir;
  const prepared = useLock
    ? await prepareRetrievalOutsideLock(ctx, prefetchDir, query, bodyId, bodyType)
    : { queryVec: null, vectorMap: null };

  const snap = await runInLock(async () => {
    const activeDir = ctx.config.archiveDir;
    const startEpoch = ctx.presence.getEpoch();
    const archive = loadSoulArchive(activeDir, 10, 5);
    const bodyReg = ctx.presence.getBody(bodyId);
    const sameDir = activeDir === prefetchDir;
    const recalledCtx = await buildRecallContext({
      archiveDir: activeDir, query, bodyId, bodyType, presence: ctx.presence.getState(),
      bodyRegistration: bodyReg, embedding: ctx.config.embedding, retriever: ctx.retriever, experimental: expCfg,
      queryVec: sameDir ? prepared.queryVec : null,
      vectorMap: sameDir ? prepared.vectorMap : null,
      ...(sameDir && prepared.precomputedRetrieval ? { precomputedRetrieval: prepared.precomputedRetrieval } : {}),
    });
    return { activeDir, startEpoch, archive, bodyReg, recalledCtx };
  });

  const chatRes = await ctx.llm.chat({
    systemPrompt: snap.recalledCtx.systemPrompt,
    userText: input.hint || '现在有点安静，你想起了一件记挂的事或未完成约定，请主动对同行者说一句自然温柔的开场白。',
    speaker: snap.archive.identity.partnerName, bodyType, soulName: snap.archive.identity.name,
    catchphrase: snap.archive.identity.catchphrases[0], availableActions: snap.bodyReg?.actions, experimental: expCfg,
  });
  captureLastPrompt(ctx, { source: 'proactive', bodyId, bodyType, driver: chatRes.driver, model: chatRes.model, systemPrompt: chatRes.usedSystemPrompt ?? snap.recalledCtx.systemPrompt, userText: input.hint || '主动搭话' });

  if (chatRes.toolFollowUpFailed) {
    return {
      ok: false, toolFollowUpFailed: true, error: chatRes.toolFollowUpError || '工具二轮补全失败',
      soulName: snap.archive.identity.name, reply: '', mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静',
      actions: [] as SoulActionIntent[], driver: chatRes.driver, model: chatRes.model,
      presence: ctx.presence.getState(),
    };
  }

  const safeActions = filterAuthorizedActions(chatRes.actions, snap.bodyReg?.actions ?? []);
  const commit = await runInLock(async () => {
    if (ctx.config.archiveDir !== snap.activeDir || ctx.presence.getEpoch() !== snap.startEpoch) {
      return { stale: true as const };
    }
    appendJournal(snap.activeDir, { bodyId, bodyType, speaker: snap.archive.identity.name, role: 'soul', text: chatRes.reply, provenance: 'verified', tags: ['proactive'] });
    const emotion = expCfg.enableEmotion ? applyTurnEmotion(snap.activeDir, { rawMood: chatRes.mood, source: 'turn', note: '主动搭话' }) : null;
    const presence = ctx.presence.recordActivity({
      bodyId, bodyType, activity: `主动向 ${snap.archive.identity.partnerName} 搭话`,
      mood: emotion ? emotion.moodLabel : '温柔平静', ...(emotion ? { emotion: toPresenceEmotion(emotion) } : {}),
    });
    return { stale: false as const, presence, emotion };
  });

  if (commit.stale) {
    return {
      ok: false, stale: true, error: STALE_ERR, soulName: snap.archive.identity.name,
      reply: '', mood: expCfg.enableEmotion ? chatRes.mood : '温柔平静', actions: [] as SoulActionIntent[], presence: ctx.presence.getState(),
    };
  }

  const proMood = expCfg.enableEmotion ? chatRes.mood : '温柔平静';
  ctx.ws?.broadcastJson({ type: 'proactive', bodyId, bodyType, reply: chatRes.reply, mood: proMood, actions: safeActions });
  ctx.events.emit('proactive', { bodyId, bodyType, reply: chatRes.reply, actions: safeActions });
  return { ok: true, soulName: snap.archive.identity.name, reply: chatRes.reply, mood: proMood, ...(commit.emotion ? { emotion: commit.emotion } : {}), actions: safeActions, driver: chatRes.driver, model: chatRes.model, recallTrace: snap.recalledCtx.recallTrace, presence: commit.presence };
}

export const runProactiveUnlocked = (ctx: SoulHubContext, input: { bodyId?: string; bodyType?: BodyType; hint?: string }) =>
  executeProactive(ctx, input, false);

export const processProactive = (ctx: SoulHubContext, input: { bodyId?: string; bodyType?: BodyType; hint?: string }) =>
  executeProactive(ctx, input, true);
