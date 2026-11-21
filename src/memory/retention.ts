import fs from 'node:fs';
import {
  readJsonObjectSafe,
  readJsonlSafe,
  refreshDerivedSoulFiles,
  resolveArchivePaths,
  writeTextAtomic,
} from '../soul/archive.ts';
import type {
  BodyType, ExperienceOrigin, JournalEntry, LivedExperience,
  MemoryEngraveEvent, MemoryEpisode, RecallChannel,
} from '../soul/types.ts';
import { lexicalSimilarity } from './experience.ts';
import { addEpisode, renderEpisodesMarkdown } from './store.ts';
import { cosineSimilarity } from './vector-store.ts';

export const USER_PIN_RE = /(?:请?记住|帮我记住|别忘了|千万别忘|一定(?:要)?记住|记在心里|记牢|牢记|不要忘记|务必记住|写进记忆|替我记着)/;
export const TRIVIAL_CHATTER_RE = /^[?？!！。.、,~～嗯哦啊哈嘿额嗯嗯好的在吗hiok\s]{1,8}$/i;
const STRONG_POS_RE = /(爱你|喜欢|温暖|感动|开心|太棒|约定|一辈子|永远|谢谢你|抱抱|并肩|大捷|胜利|成功|秘密|暗号)/;
const STRONG_NEG_RE = /(痛|疼|难过|害怕|受伤|被炸|阵亡|重创|崩溃|生气|讨厌|绝不|千万别|危险|过敏|禁忌)/;
const LARGE_JSONL_BYTES = 256 * 1024;
const DEBOUNCE_REWRITE_MS = 1500;

function clamp(val: number, min: number, max: number): number {
  return Number.isFinite(val) ? Math.max(min, Math.min(max, val)) : min;
}

/** 从文本中估计情绪效价、唤醒度、重要度及主动叮嘱信号。 */
export function estimateEmotionSignals(text: string, fallbackImportance?: number) {
  const clean = String(text || '').trim();
  const userPinned = USER_PIN_RE.test(clean);
  const isTrivial = !userPinned && TRIVIAL_CHATTER_RE.test(clean);
  if (isTrivial) {
    return { valence: 0, arousal: 0.08, importance: Math.min(fallbackImportance ?? 24, 28), isTrivial: true, userPinned: false };
  }
  const hasPos = STRONG_POS_RE.test(clean);
  const hasNeg = STRONG_NEG_RE.test(clean);
  const valence = hasNeg && !hasPos ? -0.78 : hasPos && !hasNeg ? 0.8 : hasPos && hasNeg ? 0.2 : 0;
  let arousal = hasPos || hasNeg ? 0.78 : 0.28;
  if (userPinned) arousal = Math.max(arousal, 0.72);
  let importance = fallbackImportance ?? 55;
  if (hasPos || hasNeg) importance = Math.max(importance, 78);
  if (userPinned) importance = Math.max(importance, 88);
  return {
    valence: Number(valence.toFixed(2)),
    arousal: Number(arousal.toFixed(2)),
    importance: Math.round(clamp(importance, 1, 100)),
    isTrivial: false,
    userPinned,
  };
}

export interface StrengthSeedInput {
  importance?: number; arousal?: number; valence?: number;
  userPinned?: boolean; selfImportant?: boolean; mentionCount?: number; recallCount?: number; origin?: ExperienceOrigin;
}

/** 计算艾宾浩斯初始记忆稳定度 S（单位：天）。 */
export function computeInitialStrength(input: StrengthSeedInput): number {
  const impNorm = clamp((input.importance ?? 55) / 100, 0.1, 1);
  const arousal = clamp(input.arousal ?? 0.25, 0, 1);
  const valenceMag = clamp(Math.abs(input.valence ?? 0), 0, 1);
  let s = (1.2 + Math.pow(impNorm, 2.2) * 14) * (1 + 1.8 * arousal + 0.8 * valenceMag);
  if (input.origin === 'lived') s *= 1.35;
  else if (input.origin === 'inherited') s *= 0.9;
  if (input.userPinned) s = s * 2.2 + 35;
  if (input.selfImportant) s = s * 2.0 + 30;
  const mentions = input.mentionCount ?? 1;
  if (mentions > 1) s = s * (1 + 0.45 * (mentions - 1)) + 12 * (mentions - 1);
  const recalls = input.recallCount ?? 0;
  if (recalls > 0) s = s * (1 + 0.25 * recalls);
  return Number(clamp(s, 1.0, 3650).toFixed(2));
}

export type RetentionTarget = StrengthSeedInput & { timestamp: string; lastRecalledAt?: string; strength?: number };

/** 根据艾宾浩斯遗忘曲线 R(Δt) = e^(-Δt / S) 计算当前记忆保留率。 */
export function computeRetention(item: RetentionTarget, nowMs = Date.now()) {
  const strength = item.strength && item.strength > 0 ? item.strength : computeInitialStrength(item);
  const refMs = Date.parse(item.lastRecalledAt || item.timestamp);
  const deltaDays = Number.isFinite(refMs) ? Math.max(0, (nowMs - refMs) / 86_400_000) : 0;
  const retention = Math.exp(-deltaDays / strength);
  return {
    retention: Number(retention.toFixed(4)),
    retentionPct: Math.round(clamp(retention, 0, 1) * 100),
    strength: Number(strength.toFixed(2)),
    deltaDays: Number(deltaDays.toFixed(2)),
  };
}

/** 成功回忆后的间隔强化：提升稳定度 S 并刷新巩固时间。 */
export function computeNextStrengthOnRecall(currentStrength: number, deltaDays: number, arousal = 0.25): number {
  const spacingBonus = 1 + Math.min(0.6, deltaDays / Math.max(currentStrength, 1)) * 0.5;
  const emotionBonus = 1 + 0.35 * clamp(arousal, 0, 1);
  const next = currentStrength * 1.25 * spacingBonus + 2.5 * emotionBonus;
  return Number(clamp(next, currentStrength + 1.5, 3650).toFixed(2));
}

function saveJsonl<T>(filePath: string, items: T[]): void {
  writeTextAtomic(filePath, items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''));
}

function persistEpisodes(dir: string, episodes: MemoryEpisode[], fallbackName = 'Soul'): void {
  const p = resolveArchivePaths(dir);
  saveJsonl(p.episodesJsonl, episodes);
  const size = fs.existsSync(p.episodesJsonl) ? fs.statSync(p.episodesJsonl).size : 0;
  if (size <= LARGE_JSONL_BYTES) {
    const meta = readJsonObjectSafe<{ name?: string }>(p.meta, {});
    writeTextAtomic(p.episodesMd, renderEpisodesMarkdown(meta.name || fallbackName, episodes));
  }
  refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
}

type Reinforceable = {
  id: string; timestamp: string; lastRecalledAt?: string; strength?: number; recallCount?: number; arousal?: number;
};

interface PendingReinforceState<T extends Reinforceable> {
  hits: Map<string, number>;
  lastWriteAt: number;
  fallbackStrength: (item: T) => number;
}

const pendingReinforce = new Map<string, PendingReinforceState<Reinforceable>>();

function applyReinforcementBatch<T extends Reinforceable>(
  filePath: string,
  hitNowById: Map<string, number>,
  fallbackStrength: (item: T) => number,
): number {
  if (!hitNowById.size) return 0;
  const list = readJsonlSafe<T>(filePath);
  let updated = 0;
  for (const item of list) {
    const hitNowMs = hitNowById.get(item.id);
    if (hitNowMs === undefined) continue;
    const lastMs = item.lastRecalledAt ? Date.parse(item.lastRecalledAt) : NaN;
    if (Number.isFinite(lastMs) && hitNowMs - lastMs < 60_000) continue;
    const prevS = item.strength && item.strength > 0 ? item.strength : fallbackStrength(item);
    const refMs = Date.parse(item.lastRecalledAt || item.timestamp);
    const deltaDays = Number.isFinite(refMs) ? Math.max(0, (hitNowMs - refMs) / 86_400_000) : 0;
    item.strength = computeNextStrengthOnRecall(prevS, deltaDays, item.arousal ?? 0.25);
    item.recallCount = (item.recallCount ?? 0) + 1;
    item.lastRecalledAt = new Date(hitNowMs).toISOString();
    updated += 1;
  }
  if (updated > 0) saveJsonl(filePath, list);
  return updated;
}

export function flushPendingReinforcements(filePath?: string): void {
  const keys = filePath ? [filePath] : [...pendingReinforce.keys()];
  for (const k of keys) {
    const state = pendingReinforce.get(k);
    if (!state || !state.hits.size) continue;
    const batch = new Map(state.hits);
    state.hits.clear();
    state.lastWriteAt = Date.now();
    applyReinforcementBatch(k, batch, state.fallbackStrength);
  }
}

function reinforceJsonlItems<T extends Reinforceable>(
  filePath: string,
  ids: string[],
  nowMs: number,
  fallbackStrength: (item: T) => number,
): number {
  const cleanIds = ids.filter(Boolean);
  if (!cleanIds.length) return 0;
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  let state = pendingReinforce.get(filePath) as PendingReinforceState<T> | undefined;
  if (!state) {
    state = { hits: new Map(), lastWriteAt: 0, fallbackStrength };
    pendingReinforce.set(filePath, state as unknown as PendingReinforceState<Reinforceable>);
  }
  for (const id of cleanIds) state.hits.set(id, nowMs);

  const wallNow = Date.now();
  if (size <= LARGE_JSONL_BYTES || state.hits.size >= 24 || (wallNow - state.lastWriteAt >= DEBOUNCE_REWRITE_MS)) {
    const batch = new Map(state.hits);
    state.hits.clear();
    state.lastWriteAt = wallNow;
    return applyReinforcementBatch(filePath, batch, fallbackStrength);
  }
  return 0;
}

/** 原子刷新被成功召回的情景记忆强度与提取次数（绝不删原档，大文件自动合并节流）。 */
export function reinforceRecalledEpisodes(dir: string, episodeIds: string[], nowMs = Date.now()): number {
  return reinforceJsonlItems<MemoryEpisode>(
    resolveArchivePaths(dir).episodesJsonl, episodeIds, nowMs, (ep) => computeInitialStrength(ep),
  );
}

/** 原子刷新被成功召回的亲历体验强度与提取次数。 */
export function reinforceRecalledExperiences(dir: string, experienceIds: string[], nowMs = Date.now()): number {
  return reinforceJsonlItems<LivedExperience>(
    resolveArchivePaths(dir).experiences, experienceIds, nowMs,
    (exp) => computeInitialStrength({ importance: 70 + Math.round(exp.arousal * 25), arousal: exp.arousal, valence: exp.valence, origin: exp.origin }),
  );
}

/** 生成人类可读的记忆召回命中原因（供 Memory X-Ray 透视镜展示）。 */
export function describeRecallReasons(params: {
  semanticSim?: number; lexicalSim?: number; userPinned?: boolean; selfImportant?: boolean;
  mentionCount?: number; arousal?: number; recallCount?: number;
}): { reasons: string[]; recallReason: string; channels: RecallChannel[] } {
  const rules: Array<[boolean, string, RecallChannel]> = [
    [(params.semanticSim ?? 0) >= 0.45, `千问语义联想(${Math.round((params.semanticSim ?? 0) * 100)}%)`, 'semantic'],
    [(params.lexicalSim ?? 0) >= 0.2, `关键词命中(${Math.round((params.lexicalSim ?? 0) * 100)}%)`, 'lexical'],
    [Boolean(params.userPinned), '📌 叮嘱牢记', 'pinned'],
    [Boolean(params.selfImportant), '💎 灵魂自标重要', 'self_important'],
    [(params.mentionCount ?? 1) >= 2, `🔁 反复提及×${params.mentionCount}`, 'repeated'],
    [(params.arousal ?? 0) >= 0.7, '💓 强烈情绪', 'emotional'],
    [(params.recallCount ?? 0) >= 1, `✨ 召回巩固×${params.recallCount}`, 'recent'],
  ];
  const reasons: string[] = [];
  const channels: RecallChannel[] = [];
  for (const [matched, label, ch] of rules) {
    if (matched) { reasons.push(label); channels.push(ch); }
  }
  if (!reasons.length) reasons.push('近期活跃记忆');
  if (!channels.length) channels.push('recent');
  return { reasons, recallReason: reasons.join(' · '), channels };
}

/** 对话轮次三重主动铭记通道：用户明确叮嘱 / 反复提及 / 灵魂自标 selfImportant。 */
export function engraveMemoryFromTurn(
  dir: string,
  params: {
    bodyId: string; bodyType: BodyType; speaker: string; soulName: string; userText: string;
    soulReply?: string; selfImportant?: boolean; selfImportantReason?: string;
    queryVec?: number[] | null; vectorMap?: Record<string, number[]> | null; nowMs?: number;
  },
): MemoryEngraveEvent | null {
  const cleanText = String(params.userText || '').trim();
  if (!cleanText) return null;
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const sig = estimateEmotionSignals(cleanText);
  const p = resolveArchivePaths(dir);
  const episodes = readJsonlSafe<MemoryEpisode>(p.episodesJsonl);
  const partnerJournal = readJsonlSafe<JournalEntry>(p.journal, 120).filter((j) => j.role === 'partner');
  const priorPartner = partnerJournal.length && partnerJournal[partnerJournal.length - 1].text.trim() === cleanText
    ? partnerJournal.slice(0, -1) : partnerJournal;

  let matchedEpisode: MemoryEpisode | null = null;
  let bestMatchScore = 0;
  let priorMatchCount = 0;
  if (!sig.isTrivial && cleanText.length >= 5) {
    for (const ep of episodes) {
      if (ep.importance <= 30 && (ep.arousal ?? 0) <= 0.15) continue;
      const lex = lexicalSimilarity(cleanText, `${ep.title} ${ep.summary}`);
      const vec = params.queryVec && params.vectorMap?.[ep.id] ? cosineSimilarity(params.queryVec, params.vectorMap[ep.id]) : 0;
      const hitScore = Math.max(lex, vec);
      if ((lex >= 0.42 || vec >= 0.86) && hitScore > bestMatchScore) { bestMatchScore = hitScore; matchedEpisode = ep; }
    }
    for (const j of priorPartner) {
      if (lexicalSimilarity(cleanText, j.text) >= 0.45) priorMatchCount += 1;
    }
  }

  const isRepeated = !sig.isTrivial && cleanText.length >= 5 && (Boolean(matchedEpisode) || priorMatchCount >= 1);
  const isSelfImportant = Boolean(params.selfImportant);
  const channels: Array<'user_pinned' | 'repeated_mention' | 'self_important'> = [];
  if (sig.userPinned) channels.push('user_pinned');
  if (isRepeated) channels.push('repeated_mention');
  if (isSelfImportant) channels.push('self_important');
  if (!channels.length) return null;

  const channelTags = channels.map((c) => c.replace('_', '-'));
  if (matchedEpisode) {
    matchedEpisode.userPinned = Boolean(matchedEpisode.userPinned || sig.userPinned);
    matchedEpisode.selfImportant = Boolean(matchedEpisode.selfImportant || isSelfImportant);
    if (isSelfImportant && params.selfImportantReason) matchedEpisode.selfImportantReason = params.selfImportantReason.trim();
    matchedEpisode.mentionCount = Math.max((matchedEpisode.mentionCount ?? 1) + 1, priorMatchCount + 1);
    matchedEpisode.importance = Math.max(matchedEpisode.importance, sig.userPinned || isSelfImportant ? 90 : 80);
    matchedEpisode.arousal = Math.max(matchedEpisode.arousal ?? 0.35, sig.arousal);
    if (matchedEpisode.valence === undefined || Math.abs(sig.valence) > Math.abs(matchedEpisode.valence)) matchedEpisode.valence = sig.valence;
    const floorS = computeInitialStrength(matchedEpisode);
    const bonus = (sig.userPinned ? 25 : 0) + (isSelfImportant ? 25 : 0) + (isRepeated ? 16 : 0);
    matchedEpisode.strength = Number(Math.min(3650, Math.max(floorS, (matchedEpisode.strength ?? floorS) + bonus)).toFixed(2));
    matchedEpisode.lastRecalledAt = nowIso;
    matchedEpisode.tags = Array.from(new Set([...(matchedEpisode.tags ?? []), ...channelTags]));
    persistEpisodes(dir, episodes, params.soulName);
    const ret = computeRetention(matchedEpisode, nowMs);
    return { episodeId: matchedEpisode.id, seq: matchedEpisode.seq, title: matchedEpisode.title, channels, strength: ret.strength, retentionPct: ret.retentionPct, reason: params.selfImportantReason || channels.join('+') };
  }

  const title = `[${params.bodyType}] ${cleanText.slice(0, 28)}${cleanText.length > 28 ? '…' : ''}`;
  const replyNote = params.soulReply ? `（${params.soulName}回应：${params.soulReply.slice(0, 80)}）` : '';
  const ep = addEpisode(dir, {
    bodyType: params.bodyType, bodyId: params.bodyId, title, summary: `${params.speaker}：「${cleanText.slice(0, 140)}」${replyNote}`,
    participants: [params.speaker, params.soulName], importance: sig.userPinned || isSelfImportant ? Math.max(sig.importance, 90) : Math.max(sig.importance, 80),
    valence: sig.valence, arousal: Math.max(sig.arousal, isSelfImportant ? 0.8 : 0.65),
    userPinned: sig.userPinned || undefined, selfImportant: isSelfImportant || undefined,
    selfImportantReason: params.selfImportantReason || undefined, mentionCount: isRepeated ? Math.max(2, priorMatchCount + 1) : 1,
    tags: [params.bodyType, ...channelTags], timestamp: nowIso,
  });
  const ret = computeRetention(ep, nowMs);
  return { episodeId: ep.id, seq: ep.seq, title: ep.title, channels, strength: ret.strength, retentionPct: ret.retentionPct, reason: params.selfImportantReason || channels.join('+') };
}

/** 显式将指定情景记忆标为重要并加固稳定度。 */
export function pinEpisodeById(
  dir: string, episodeId: string, patch: { userPinned?: boolean; selfImportant?: boolean; reason?: string }, nowMs = Date.now(),
): { episode: MemoryEpisode; retention: ReturnType<typeof computeRetention> } | null {
  const episodes = readJsonlSafe<MemoryEpisode>(resolveArchivePaths(dir).episodesJsonl);
  const target = episodes.find((e) => e.id === episodeId);
  if (!target) return null;
  if (patch.userPinned !== undefined) target.userPinned = patch.userPinned;
  if (patch.selfImportant !== undefined) target.selfImportant = patch.selfImportant;
  if (patch.reason) target.selfImportantReason = patch.reason.trim();
  target.importance = Math.max(target.importance, 90);
  const floorS = computeInitialStrength(target);
  target.strength = Number(Math.min(3650, Math.max(floorS, (target.strength ?? floorS) + 25)).toFixed(2));
  target.lastRecalledAt = new Date(nowMs).toISOString();
  persistEpisodes(dir, episodes);
  return { episode: target, retention: computeRetention(target, nowMs) };
}
