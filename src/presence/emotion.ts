import { readJsonObjectSafe, resolveArchivePaths, writeJsonAtomic } from '../soul/archive.ts';
import type { FreeWillStance, LivedExperience } from '../soul/types.ts';
import { inferStimulusFromMoodText } from './emotion-lexicon.ts';

export { inferStimulusFromMoodText };

export interface EmotionVector {
  valence: number;
  arousal: number;
  safety: number;
}

export interface EmotionHalfLives {
  valencePositive: number;
  valenceNegative: number;
  arousal: number;
  safetyLow: number;
  safetyHigh: number;
}

export interface EmotionBaseline extends EmotionVector {
  halfLifeMinutes: EmotionHalfLives;
  inertia: number;
}

export type EmotionSource = 'experience' | 'turn' | 'observe' | 'heartbeat' | 'manual';

export interface EmotionTracePoint {
  timestamp: string;
  source: EmotionSource;
  label: string;
  valence: number;
  arousal: number;
  safety: number;
  note?: string;
}

export interface SoulEmotionState extends EmotionVector {
  moodLabel: string;
  rawMoodHint?: string;
  inertia: number;
  baseline: EmotionBaseline;
  updatedAt: string;
  recentTrace: EmotionTracePoint[];
}

export interface EmotionStimulus {
  valence?: number;
  arousal?: number;
  safety?: number;
  intensity?: number;
  source: EmotionSource;
  rawMood?: string;
  note?: string;
  nowMs?: number;
}

export const DEFAULT_EMOTION_BASELINE: EmotionBaseline = {
  valence: 0.15,
  arousal: 0.35,
  safety: 0.7,
  inertia: 0.62,
  halfLifeMinutes: {
    valencePositive: 90,
    valenceNegative: 120,
    arousal: 45,
    safetyLow: 180,
    safetyHigh: 120,
  },
};

const SOURCE_WEIGHTS: Record<EmotionSource, number> = {
  experience: 1.15,
  manual: 1.0,
  turn: 0.72,
  observe: 0.6,
  heartbeat: 0.45,
};

function clampRange(val: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function round3(val: number): number {
  return Number((Number.isFinite(val) ? val : 0).toFixed(3));
}

export function deriveMoodLabel(vec: EmotionVector): string {
  const v = clampRange(vec.valence, -1, 1, 0);
  const a = clampRange(vec.arousal, 0, 1, 0.35);
  const s = clampRange(vec.safety, 0, 1, 0.7);
  if (v <= -0.35 && s < 0.45) return a >= 0.6 ? '紧张警惕' : '心有余悸';
  if (v <= -0.35) return a >= 0.6 ? '委屈难过' : '低落郁闷';
  if (s < 0.42) return a >= 0.55 ? '高度戒备' : '略显警惕';
  if (v >= 0.38) return a >= 0.62 ? '雀跃欣喜' : (s >= 0.6 ? '温柔安心' : '欣慰缓和');
  if (v >= 0.12 && s >= 0.58) return a >= 0.58 ? '明朗积极' : '温柔平和';
  if (a <= 0.28) return '沉静安稳';
  return '平静专注';
}

export function createDefaultEmotionState(nowMs = Date.now()): SoulEmotionState {
  const b: EmotionBaseline = {
    ...DEFAULT_EMOTION_BASELINE,
    halfLifeMinutes: { ...DEFAULT_EMOTION_BASELINE.halfLifeMinutes },
  };
  return {
    valence: b.valence,
    arousal: b.arousal,
    safety: b.safety,
    moodLabel: deriveMoodLabel(b),
    inertia: b.inertia,
    baseline: b,
    updatedAt: new Date(nowMs).toISOString(),
    recentTrace: [],
  };
}

function finiteOr(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEmotionState(raw: Partial<SoulEmotionState> | null | undefined, nowMs: number): SoulEmotionState {
  const def = createDefaultEmotionState(nowMs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
  const rawBase = raw.baseline && typeof raw.baseline === 'object' ? (raw.baseline as Partial<EmotionBaseline>) : undefined;
  const rawHl = rawBase?.halfLifeMinutes && typeof rawBase.halfLifeMinutes === 'object' ? (rawBase.halfLifeMinutes as Partial<EmotionHalfLives>) : undefined;
  const baseline: EmotionBaseline = {
    valence: round3(clampRange(finiteOr(rawBase?.valence, def.baseline.valence), -1, 1, def.baseline.valence)),
    arousal: round3(clampRange(finiteOr(rawBase?.arousal, def.baseline.arousal), 0, 1, def.baseline.arousal)),
    safety: round3(clampRange(finiteOr(rawBase?.safety, def.baseline.safety), 0, 1, def.baseline.safety)),
    inertia: round3(clampRange(finiteOr(rawBase?.inertia, def.baseline.inertia), 0.1, 0.95, def.baseline.inertia)),
    halfLifeMinutes: {
      valencePositive: Math.max(5, finiteOr(rawHl?.valencePositive, def.baseline.halfLifeMinutes.valencePositive)),
      valenceNegative: Math.max(5, finiteOr(rawHl?.valenceNegative, def.baseline.halfLifeMinutes.valenceNegative)),
      arousal: Math.max(5, finiteOr(rawHl?.arousal, def.baseline.halfLifeMinutes.arousal)),
      safetyLow: Math.max(5, finiteOr(rawHl?.safetyLow, def.baseline.halfLifeMinutes.safetyLow)),
      safetyHigh: Math.max(5, finiteOr(rawHl?.safetyHigh, def.baseline.halfLifeMinutes.safetyHigh)),
    },
  };
  const valence = round3(clampRange(finiteOr(raw.valence, baseline.valence), -1, 1, baseline.valence));
  const arousal = round3(clampRange(finiteOr(raw.arousal, baseline.arousal), 0, 1, baseline.arousal));
  const safety = round3(clampRange(finiteOr(raw.safety, baseline.safety), 0, 1, baseline.safety));
  const inertia = round3(clampRange(finiteOr(raw.inertia, baseline.inertia), 0.1, 0.95, baseline.inertia));
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : def.updatedAt;
  const recentTrace = Array.isArray(raw.recentTrace) ? raw.recentTrace.slice(-12) : [];
  return {
    valence,
    arousal,
    safety,
    moodLabel: deriveMoodLabel({ valence, arousal, safety }),
    ...(typeof raw.rawMoodHint === 'string' && raw.rawMoodHint.trim() ? { rawMoodHint: raw.rawMoodHint.trim() } : {}),
    inertia,
    baseline,
    updatedAt,
    recentTrace,
  };
}

function expDecayToward(value: number, target: number, elapsedMin: number, halfLifeMin: number): number {
  if (elapsedMin <= 0 || !Number.isFinite(halfLifeMin) || halfLifeMin <= 0) return value;
  const factor = Math.exp((-Math.LN2 * elapsedMin) / halfLifeMin);
  return target + (value - target) * factor;
}

export function decayEmotionVector(state: SoulEmotionState, nowMs = Date.now()): SoulEmotionState {
  const updatedMs = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const elapsedMin = Number.isFinite(updatedMs) && nowMs > updatedMs ? (nowMs - updatedMs) / 60_000 : 0;
  const b = state.baseline;
  const hl = b.halfLifeMinutes;
  const valence = round3(clampRange(
    expDecayToward(state.valence, b.valence, elapsedMin, state.valence < b.valence ? hl.valenceNegative : hl.valencePositive),
    -1,
    1,
    b.valence,
  ));
  const arousal = round3(clampRange(expDecayToward(state.arousal, b.arousal, elapsedMin, hl.arousal), 0, 1, b.arousal));
  const safety = round3(clampRange(
    expDecayToward(state.safety, b.safety, elapsedMin, state.safety < b.safety ? hl.safetyLow : hl.safetyHigh),
    0,
    1,
    b.safety,
  ));
  const nextUpdatedAt = !Number.isFinite(updatedMs) || nowMs >= updatedMs
    ? new Date(nowMs).toISOString()
    : state.updatedAt;
  return {
    ...state,
    valence,
    arousal,
    safety,
    moodLabel: deriveMoodLabel({ valence, arousal, safety }),
    updatedAt: nextUpdatedAt,
  };
}

export function loadEmotionState(dir: string, nowMs = Date.now()): SoulEmotionState {
  const p = resolveArchivePaths(dir);
  const raw = readJsonObjectSafe<Partial<SoulEmotionState>>(p.emotion, {});
  const normalized = normalizeEmotionState(raw, nowMs);
  return decayEmotionVector(normalized, nowMs);
}

export function resetEmotionState(dir: string, nowMs = Date.now()): SoulEmotionState {
  const fresh = createDefaultEmotionState(nowMs);
  writeJsonAtomic(resolveArchivePaths(dir).emotion, fresh);
  return fresh;
}

export function toPresenceEmotion(state: SoulEmotionState) {
  return {
    valence: state.valence,
    arousal: state.arousal,
    safety: state.safety,
    moodLabel: state.moodLabel,
    updatedAt: state.updatedAt,
  };
}

export function applyEmotionStimulus(dir: string, stimulus: EmotionStimulus): SoulEmotionState {
  const nowMs = stimulus.nowMs ?? Date.now();
  const cur = loadEmotionState(dir, nowMs);
  const inferred = stimulus.rawMood && stimulus.valence === undefined && stimulus.arousal === undefined && stimulus.safety === undefined
    ? inferStimulusFromMoodText(stimulus.rawMood)
    : null;

  const targetValence = clampRange(stimulus.valence ?? inferred?.valence ?? cur.valence, -1, 1, cur.valence);
  const targetArousal = clampRange(stimulus.arousal ?? inferred?.arousal ?? cur.arousal, 0, 1, cur.arousal);
  const targetSafety = clampRange(stimulus.safety ?? inferred?.safety ?? cur.safety, 0, 1, cur.safety);

  const intensity = clampRange(stimulus.intensity ?? inferred?.intensity ?? 0.45, 0.05, 1, 0.45);
  const sourceWeight = SOURCE_WEIGHTS[stimulus.source] ?? 0.72;
  const baseGain = clampRange((1 - cur.inertia) * (0.45 + 0.95 * intensity) * sourceWeight, 0.08, 0.65, 0.25);

  const nonShockSource = stimulus.source !== 'experience' && stimulus.source !== 'manual';
  const valGain = cur.valence <= -0.25 && targetValence > 0.25 && nonShockSource ? baseGain * 0.78 : baseGain;
  const safeGain = cur.safety < 0.45 && targetSafety > 0.65 && nonShockSource ? baseGain * 0.75 : baseGain;

  const valence = round3(clampRange(cur.valence + valGain * (targetValence - cur.valence), -1, 1, cur.valence));
  const arousal = round3(clampRange(cur.arousal + baseGain * (targetArousal - cur.arousal), 0, 1, cur.arousal));
  const safety = round3(clampRange(cur.safety + safeGain * (targetSafety - cur.safety), 0, 1, cur.safety));
  const moodLabel = deriveMoodLabel({ valence, arousal, safety });
  const timestamp = new Date(nowMs).toISOString();

  const tracePoint: EmotionTracePoint = {
    timestamp,
    source: stimulus.source,
    label: moodLabel,
    valence,
    arousal,
    safety,
    ...(stimulus.note ? { note: stimulus.note.slice(0, 80) } : {}),
  };

  const next: SoulEmotionState = {
    valence,
    arousal,
    safety,
    moodLabel,
    ...(stimulus.rawMood?.trim() ? { rawMoodHint: stimulus.rawMood.trim().slice(0, 24) } : cur.rawMoodHint ? { rawMoodHint: cur.rawMoodHint } : {}),
    inertia: cur.inertia,
    baseline: cur.baseline,
    updatedAt: timestamp,
    recentTrace: [...cur.recentTrace, tracePoint].slice(-12),
  };
  writeJsonAtomic(resolveArchivePaths(dir).emotion, next);
  return next;
}

export function applyExperienceEmotion(dir: string, exp: LivedExperience, nowMs = Date.now()): SoulEmotionState {
  if (exp.origin === 'inherited') {
    return applyEmotionStimulus(dir, {
      source: 'experience',
      valence: clampRange(exp.valence * 0.45, -0.5, 0.5, 0),
      arousal: clampRange(0.35 + exp.arousal * 0.25, 0.2, 0.7, 0.45),
      safety: exp.valence < 0 ? clampRange(0.6 + exp.valence * 0.2, 0.38, 0.68, 0.55) : 0.72,
      intensity: 0.16,
      note: `[先验口述] ${exp.realityOutcome}`,
      nowMs,
    });
  }
  const targetSafety = exp.valence < 0
    ? clampRange(0.5 + exp.valence * 0.48, 0.08, 0.6, 0.25)
    : clampRange(0.66 + exp.valence * 0.26, 0.5, 0.96, 0.75);
  return applyEmotionStimulus(dir, {
    source: 'experience',
    valence: exp.valence,
    arousal: exp.arousal,
    safety: targetSafety,
    intensity: clampRange(Math.max(0.55, exp.arousal), 0.55, 1, 0.75),
    note: `[亲历] ${exp.realityOutcome}`,
    nowMs,
  });
}

export function applyTurnEmotion(
  dir: string,
  input: { rawMood?: string; stance?: FreeWillStance; source?: 'turn' | 'observe'; note?: string; nowMs?: number },
): SoulEmotionState {
  const inferred = inferStimulusFromMoodText(input.rawMood, input.stance);
  return applyEmotionStimulus(dir, {
    source: input.source ?? 'turn',
    valence: inferred.valence,
    arousal: inferred.arousal,
    safety: inferred.safety,
    intensity: inferred.intensity,
    rawMood: input.rawMood,
    note: input.note,
    nowMs: input.nowMs,
  });
}

export function applyHeartbeatEmotion(
  dir: string,
  input: { action: string; inQuietHours: boolean; latestExpValence?: number; nowMs?: number },
): SoulEmotionState {
  const nowMs = input.nowMs ?? Date.now();
  const decayed = loadEmotionState(dir, nowMs);
  const b = decayed.baseline;
  const targetArousal = input.inQuietHours ? 0.22 : b.arousal;
  const targetValence = input.latestExpValence !== undefined && input.latestExpValence < -0.4 && input.action === 'write_diary'
    ? Math.min(decayed.valence, -0.05)
    : b.valence;
  return applyEmotionStimulus(dir, {
    source: 'heartbeat',
    valence: targetValence,
    arousal: targetArousal,
    safety: b.safety,
    intensity: input.inQuietHours ? 0.32 : 0.18,
    note: `心搏:${input.action}`,
    nowMs,
  });
}

export function formatEmotionPromptLine(state: SoulEmotionState): string {
  const hint = state.rawMoodHint ? ` · 近期表达:${state.rawMoodHint}` : '';
  return `- 情绪惯性矢量：${state.moodLabel}（效价 ${state.valence >= 0 ? '+' : ''}${state.valence} / 唤醒 ${Math.round(state.arousal * 100)}% / 安全感 ${Math.round(state.safety * 100)}%${hint}）`;
}
