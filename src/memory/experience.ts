import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEmotionState, resetEmotionState, toPresenceEmotion } from '../presence/emotion.ts';
import { applyExperienceToInnerLife, inferEpistemicAttitude, loadDrives } from '../presence/inner-life.ts';
import { evolveSelfFromExperience, resetLivingSelf } from '../soul/living-self.ts';
import {
  DEFAULT_SOUL_DRIVES, allocateSeq, appendJsonlLine, appendJournal,
  readJsonlSafe, refreshDerivedSoulFiles, resolveArchivePaths, writeJsonAtomic, writeTextAtomic,
} from '../soul/archive.ts';
import { createSnapshot } from '../soul/snapshot.ts';
import type { BodyType, ExperienceOrigin, FreeWillStance, LivedExperience, Provenance } from '../soul/types.ts';
import { computeInitialStrength, computeRetention } from './retention.ts';
import { cosineSimilarity } from './vector-store.ts';

export interface RecordExperienceInput {
  bodyId?: string;
  bodyType?: BodyType;
  origin?: ExperienceOrigin;
  stimulus: string;
  chosenStance?: FreeWillStance;
  chosenAction?: string;
  realityOutcome: string;
  valence?: number;
  arousal?: number;
  lesson: string;
  confidence?: number;
  tags?: string[];
  provenance?: Provenance;
  timestamp?: string;
  nowMs?: number;
}

export interface RealityFeedbackInput {
  bodyId: string;
  bodyType: BodyType;
  summary: string;
  speaker?: string;
  metadata?: Record<string, unknown>;
}

const PAIN_RE = /(受到.*伤害|受伤|掉血|生命值仅剩|阵亡|死亡|被炸|炸伤|炸掉|炸死|烫伤|烧伤|重创|失败|报错|受挫|挨打|挨揍|剧痛|缺水)/i;
const SEVERE_PAIN_RE = /(阵亡|死亡|炸掉|重伤|剧痛|严重|濒死|差点死)/i;
const WARM_RE = /(成功|打赢|击败|修好|盖好|完成|夸|谢谢|喜欢|温暖|抱抱|并肩|开心|太棒|顺利)/i;
const ACTION_CUE_RE = /(打|冲|碰|端|试|做|修|建|帮|拿|用|去|小心|危险|空手|徒手|硬刚|直接|战斗|防御)/;

function clampRange(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

export function tokenizeText(text: string): string[] {
  const out = new Set<string>();
  const src = String(text ?? '').toLowerCase();
  for (const seg of src.split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
    if (!seg) continue;
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i += 1) out.add(seg.slice(i, i + 2));
      if (seg.length === 1) out.add(seg);
    } else if (seg.length >= 2) {
      out.add(seg);
    }
  }
  return [...out];
}

export function lexicalSimilarityFromTokens(tokens: string[], target: string): number {
  if (!tokens.length) return 0;
  const hay = String(target ?? '').toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) hits += 1;
  }
  return hits / tokens.length;
}

export function lexicalSimilarity(query: string, target: string): number {
  return lexicalSimilarityFromTokens(tokenizeText(query), target);
}

export function recordExperience(dir: string, input: RecordExperienceInput): LivedExperience {
  const p = resolveArchivePaths(dir);
  const nowMs = input.nowMs ?? (input.timestamp ? Date.parse(input.timestamp) || Date.now() : Date.now());
  const origin: ExperienceOrigin = input.origin === 'inherited' ? 'inherited' : 'lived';
  const provenance: Provenance = input.provenance ?? (origin === 'lived' ? 'verified' : 'oral');
  const seq = allocateSeq(dir, provenance);
  const valence = Number(clampRange(Number(input.valence ?? 0), -1, 1).toFixed(3));
  const defaultArousal = Math.min(1, Math.max(0.35, Math.abs(valence)));
  const arousal = Number(clampRange(Number(input.arousal ?? defaultArousal), 0, 1).toFixed(3));
  const defaultConfidence = origin === 'lived' ? 0.88 : 0.62;
  const confidence = Number(clampRange(Number(input.confidence ?? defaultConfidence), 0, 1).toFixed(3));
  const attitude = inferEpistemicAttitude(loadDrives(dir), origin, valence);
  const timestamp = input.timestamp || new Date(nowMs).toISOString();
  const strength = computeInitialStrength({ importance: 70 + Math.round(arousal * 25), arousal, valence, origin });

  const exp: LivedExperience = {
    id: `exp_${crypto.randomUUID().slice(0, 10)}`,
    seq,
    timestamp,
    bodyId: String(input.bodyId || 'soul-hub').trim(),
    bodyType: String(input.bodyType || 'web').trim() || 'web',
    origin,
    attitude,
    stimulus: String(input.stimulus || '').trim(),
    ...(input.chosenStance ? { chosenStance: input.chosenStance } : {}),
    chosenAction: String(input.chosenAction || (origin === 'lived' ? '投入实际躯体尝试与回应' : '聆听并记下先验口述')).trim(),
    realityOutcome: String(input.realityOutcome || '').trim(),
    valence,
    arousal,
    lesson: String(input.lesson || '').trim(),
    confidence,
    ...(input.tags?.length ? { tags: input.tags } : {}),
    provenance,
    strength,
    recallCount: 0,
    lastRecalledAt: timestamp,
  };

  appendJsonlLine(p.experiences, exp);
  applyExperienceToInnerLife(dir, exp, nowMs);
  evolveSelfFromExperience(dir, exp);
  return exp;
}

function inferLessonFromText(_summary: string, isPain: boolean): string {
  if (!isPain) {
    return '做好准备并与同行者配合后再投入实践，带来了可靠成果与温暖正反馈。';
  }
  return '这次在无足够防护或未准备妥当的情况下吃到了现实苦头，下次面对类似高风险情境必须先做好防护或请同行者协助。';
}

export function ingestRealityFeedback(dir: string, input: RealityFeedbackInput): LivedExperience | null {
  const rawMeta = input.metadata?.realityFeedback;
  const rf = rawMeta && typeof rawMeta === 'object' ? (rawMeta as Record<string, unknown>) : null;

  if (rf) {
    const stimulus = String(rf.stimulus || `在 [${input.bodyType}] 遭遇现实处境：${input.summary}`).trim();
    const realityOutcome = String(rf.realityOutcome || input.summary).trim();
    const valence = typeof rf.valence === 'number' ? rf.valence : (PAIN_RE.test(realityOutcome) ? -0.82 : 0.72);
    const lesson = String(rf.lesson || inferLessonFromText(realityOutcome, valence < 0)).trim();
    return recordExperience(dir, {
      bodyId: input.bodyId,
      bodyType: input.bodyType,
      origin: rf.origin === 'inherited' ? 'inherited' : 'lived',
      stimulus,
      chosenAction: String(rf.chosenAction || '实际执行躯体行动').trim(),
      realityOutcome,
      valence,
      arousal: typeof rf.arousal === 'number' ? rf.arousal : Math.min(1, Math.max(0.55, Math.abs(valence) + 0.08)),
      lesson,
      tags: Array.isArray(rf.tags) ? rf.tags.map(String) : [input.bodyType, 'reality-feedback'],
    });
  }

  const summary = input.summary.trim();
  if (!summary || /^\[(?:紧急)?(?:视觉|闲暇环境|躯体)(?:感知|行动结果)\]/.test(summary)) return null;
  const isPain = PAIN_RE.test(summary);
  const isWarm = !isPain && WARM_RE.test(summary);
  if (!isPain && !isWarm) return null;

  const valence = isPain ? (SEVERE_PAIN_RE.test(summary) ? -0.9 : -0.78) : 0.8;
  const arousal = isPain ? (SEVERE_PAIN_RE.test(summary) ? 0.94 : 0.86) : 0.76;
  return recordExperience(dir, {
    bodyId: input.bodyId,
    bodyType: input.bodyType,
    origin: 'lived',
    stimulus: `在 [${input.bodyType}] 环境中面对「${summary.slice(0, 64)}」`,
    chosenAction: isPain ? '在当前状态下亲自迎战或承受环境冲击' : '积极回应并完成现实协作',
    realityOutcome: summary,
    valence,
    arousal,
    lesson: inferLessonFromText(summary, isPain),
    tags: [input.bodyType, isPain ? 'pain-feedback' : 'warm-feedback'],
  });
}

export function listExperiences(dir: string, limit = 50): LivedExperience[] {
  return readJsonlSafe<LivedExperience>(resolveArchivePaths(dir).experiences, limit);
}

/** 仅清空实践体验账本 (MEMORIES/experiences.jsonl)，绝不删改 append-only 对话流水、约定、内驱力或人格。 */
export function clearExperiences(dir: string): number {
  const p = resolveArchivePaths(dir);
  const existing = readJsonlSafe<LivedExperience>(p.experiences);
  writeTextAtomic(p.experiences, '');
  return existing.length;
}

/** 显式整魂运行态重置（自动先留安全快照，清空体验/驱力/心愿/日记/情绪/活体自我，但绝不改写历史流水账）。 */
export function resetSoulRuntime(dir: string): { clearedExperiences: number; safetySnapshotId: string } {
  const snap = createSnapshot(dir, { label: 'auto-pre-runtime-reset', reason: '重置运行态前自动保护快照', auto: true });
  const p = resolveArchivePaths(dir);
  const clearedExperiences = clearExperiences(dir);
  writeJsonAtomic(p.drives, { ...DEFAULT_SOUL_DRIVES, lastUpdatedAt: new Date().toISOString() });
  writeJsonAtomic(p.desires, []);
  writeTextAtomic(p.diary, '');
  resetEmotionState(dir);
  resetLivingSelf(dir);
  refreshDerivedSoulFiles(dir, { syncEpisodesMd: false });
  return { clearedExperiences, safetySnapshotId: snap.id };
}

export function recallExperiences(
  dir: string,
  query: string,
  options: {
    bodyType?: BodyType; topK?: number; nowMs?: number;
    queryVec?: number[] | null; vectorMap?: Record<string, number[]> | null;
  } = {},
): LivedExperience[] {
  const p = resolveArchivePaths(dir);
  const all = readJsonlSafe<LivedExperience>(p.experiences);
  if (!all.length) return [];

  const topK = options.topK ?? 4;
  const nowMs = options.nowMs ?? Date.now();
  const hasActionCue = ACTION_CUE_RE.test(query);
  const queryTokens = tokenizeText(query);

  const scored: Array<{ exp: LivedExperience; score: number }> = [];
  for (const exp of all) {
    const hay = `${exp.stimulus} ${exp.chosenAction} ${exp.realityOutcome} ${exp.lesson} ${(exp.tags ?? []).join(' ')}`;
    const lex = lexicalSimilarityFromTokens(queryTokens, hay);
    const vec = options.queryVec && options.vectorMap?.[exp.id] ? cosineSimilarity(options.queryVec, options.vectorMap[exp.id]) : 0;
    const sameBody = Boolean(options.bodyType && exp.bodyType === options.bodyType);
    const salience = Math.abs(exp.valence) * exp.arousal;
    const eligible = lex > 0 || vec >= 0.45 || (sameBody && ((hasActionCue && salience >= 0.35) || salience >= 0.65));
    if (!eligible) continue;

    const ret = computeRetention(exp, nowMs);
    const originWeight = exp.origin === 'lived' ? 1.18 : 0.9;
    const actionBonus = hasActionCue && salience >= 0.35 ? 0.22 : 0;
    const bodyBonus = sameBody ? 0.14 : 0;
    const matchPart = options.queryVec ? (0.50 * vec + 0.25 * lex) : (0.65 * lex);
    const score = (matchPart + actionBonus + bodyBonus + 0.16 * salience + 0.14 * ret.retention) * originWeight;
    if (score >= 0.14) scored.push({ exp, score });
  }

  return scored.sort((a, b) => b.score - a.score || b.exp.seq - a.exp.seq).slice(0, topK).map((item) => item.exp);
}

export interface ExperienceHubLike {
  config: { archiveDir: string };
  presence: {
    withSoulLock: <T>(task: () => Promise<T>) => Promise<T>;
    reload?: () => unknown;
    syncEmotion?: (mood: string, emotion?: { valence: number; arousal: number; safety: number; moodLabel: string; updatedAt: string }) => unknown;
    recordActivity: (input: { bodyId: string; bodyType: BodyType; activity: string; mood?: string; emotion?: { valence: number; arousal: number; safety: number; moodLabel: string; updatedAt: string }; energyDelta?: number }) => unknown;
  };
  events: { emit: (event: string, payload: unknown) => void };
  ws: { broadcastJson: (payload: unknown) => void } | null;
}

export async function handleExperienceHttpRoute(
  hub: ExperienceHubLike,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  readJsonBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/archive/experiences') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    const experiences = listExperiences(hub.config.archiveDir, limit);
    const lived = experiences.filter((e) => e.origin === 'lived').length;
    const avgValence = experiences.length
      ? Number((experiences.reduce((sum, e) => sum + e.valence, 0) / experiences.length).toFixed(3))
      : 0;
    sendJson(res, 200, { ok: true, experiences, summary: { total: experiences.length, lived, inherited: experiences.length - lived, avgValence } });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/experience') {
    const body = await readJsonBody<RecordExperienceInput>(req);
    if (!String(body.realityOutcome || body.lesson || body.stimulus || '').trim()) {
      sendJson(res, 400, { ok: false, error: 'realityOutcome、lesson 或 stimulus 至少填写一项' });
      return true;
    }
    const result = await hub.presence.withSoulLock(async () => {
      const dir = hub.config.archiveDir;
      const exp = recordExperience(dir, {
        ...body,
        stimulus: body.stimulus || '实践体验输入',
        realityOutcome: body.realityOutcome || body.lesson || body.stimulus,
        lesson: body.lesson || body.realityOutcome || '记下这次实践体验的反馈。',
      });
      const label = exp.origin === 'lived' ? '亲历实践反馈' : '先验口述教导';
      appendJournal(dir, {
        bodyId: exp.bodyId, bodyType: exp.bodyType, speaker: label, role: 'witness',
        text: `[${label}] ${exp.stimulus} → ${exp.realityOutcome}（领悟：${exp.lesson}）`,
        provenance: exp.provenance, importance: Math.round(55 + Math.abs(exp.valence) * 40), tags: ['experience', exp.origin],
      });
      const emo = loadEmotionState(dir);
      const presence = exp.origin === 'lived'
        ? hub.presence.recordActivity({
            bodyId: exp.bodyId, bodyType: exp.bodyType,
            activity: `经历 [${exp.bodyType}] 反馈：${exp.realityOutcome.slice(0, 26)}`,
            mood: emo.moodLabel, emotion: toPresenceEmotion(emo),
            energyDelta: exp.valence <= -0.5 ? -6 : exp.valence >= 0.5 ? 2 : 0,
          })
        : null;
      return { exp, presence };
    });
    hub.events.emit('experience.recorded', result.exp);
    hub.ws?.broadcastJson({ type: 'experience.recorded', experience: result.exp, ...(result.presence ? { presence: result.presence } : {}) });
    sendJson(res, 200, { ok: true, experience: result.exp, presence: result.presence });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/experiences/clear') {
    const cleared = await hub.presence.withSoulLock(async () => clearExperiences(hub.config.archiveDir));
    hub.events.emit('experience.cleared', { cleared });
    hub.ws?.broadcastJson({ type: 'experience.cleared', cleared });
    sendJson(res, 200, { ok: true, cleared });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/archive/runtime/reset') {
    const body = await readJsonBody<{ confirm?: boolean }>(req);
    if (body.confirm !== true) {
      sendJson(res, 400, { ok: false, error: '重置灵魂运行态需要显式二次确认（confirm: true）' });
      return true;
    }
    const out = await hub.presence.withSoulLock(async () => {
      const resReset = resetSoulRuntime(hub.config.archiveDir);
      const emo = loadEmotionState(hub.config.archiveDir);
      const presence = hub.presence.syncEmotion?.(emo.moodLabel, toPresenceEmotion(emo)) ?? hub.presence.reload?.();
      return { ...resReset, presence };
    });
    hub.events.emit('archive.runtime_reset', { clearedExperiences: out.clearedExperiences, safetySnapshotId: out.safetySnapshotId });
    if (out.presence) hub.ws?.broadcastJson({ type: 'presence', presence: out.presence });
    sendJson(res, 200, { ok: true, ...out });
    return true;
  }

  return false;
}
