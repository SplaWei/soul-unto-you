import crypto from 'node:crypto';
import {
  allocateSeq,
  appendJsonlLine,
  loadSoulArchive,
  readJsonObjectSafe,
  resolveArchivePaths,
  writeJsonAtomic,
} from '../soul/archive.ts';
import type { HeartbeatActionKind, InnerDiaryEntry, SoulDesire, SoulDrives } from '../soul/types.ts';
import { applyHeartbeatEmotion, type SoulEmotionState } from './emotion.ts';
import { EPISTEMIC_LABELS, listDesires, loadDrives, updateDrives, upsertDesire } from './inner-life.ts';

export interface HeartbeatPolicy {
  quietHoursStart: number;
  quietHoursEnd: number;
  minReachOutIntervalMin: number;
  maxDailyReachOuts: number;
  closenessResetAfterReachOut: number;
}

export const DEFAULT_HEARTBEAT_POLICY: HeartbeatPolicy = {
  quietHoursStart: 23,
  quietHoursEnd: 7,
  minReachOutIntervalMin: 120,
  maxDailyReachOuts: 3,
  closenessResetAfterReachOut: 0.42,
};

export interface HeartbeatState {
  lastReachOutAt: string;
  dailyDate: string;
  dailyReachOutCount: number;
  lastHeartbeatAt: string;
}

export interface HeartbeatResult {
  ok: boolean;
  action: HeartbeatActionKind;
  drives: SoulDrives;
  emotion?: SoulEmotionState;
  diaryEntry?: InnerDiaryEntry;
  desire?: SoulDesire | null;
  proactiveMessage?: string;
  suppressedReason?: 'quiet_hours' | 'cooldown' | 'daily_cap' | 'epoch_stale';
}

export function isQuietHour(nowMs: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  const h = new Date(nowMs).getHours();
  return startHour > endHour ? (h >= startHour || h < endHour) : (h >= startHour && h < endHour);
}

export function localDateKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function driftToward(cur: number, target: number, step: number): number {
  if (Math.abs(cur - target) <= step) return target;
  return cur > target ? cur - step : cur + step;
}

/** 周期性静默灵魂心搏（慢 LLM 随笔与主动搭话均在锁外执行，严禁长持 SoulLock）。 */
export async function runSoulHeartbeat(
  dir: string,
  options: {
    nowMs?: number;
    policy?: Partial<HeartbeatPolicy>;
    forceAction?: HeartbeatActionKind;
    isSilentIdle?: boolean;
    reachOutFn?: (hint: string) => Promise<{ reply?: string } | null>;
    llmWriteNoteFn?: (prompt: string) => Promise<string>;
    llmSummarizeFn?: (prompt: string) => Promise<string>;
    lock?: { withSoulLock: <T>(task: () => Promise<T>) => Promise<T>; getEpoch?: () => number };
  } = {},
): Promise<HeartbeatResult> {
  const runLocked = <T>(fn: () => Promise<T> | T): Promise<T> =>
    (options.lock ? options.lock.withSoulLock(async () => fn()) : Promise.resolve(fn()));

  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const policy: HeartbeatPolicy = { ...DEFAULT_HEARTBEAT_POLICY, ...(options.policy || {}) };
  const today = localDateKey(nowMs);

  const snap = await runLocked(() => {
    const startEpoch = options.lock?.getEpoch?.() ?? 0;
    const archive = loadSoulArchive(dir, 12);
    const curDrives = loadDrives(dir);
    let drives = updateDrives(dir, {
      closeness: curDrives.closeness + (options.isSilentIdle ? 0.04 : 0.02),
      safety: driftToward(curDrives.safety, 0.45, 0.015),
      playfulness: driftToward(curDrives.playfulness, 0.62, 0.01),
      energy: Math.min(98, curDrives.energy + 3),
    });

    const p = resolveArchivePaths(dir);
    const rawState = readJsonObjectSafe<HeartbeatState>(p.heartbeatState, {
      lastReachOutAt: '', dailyDate: today, dailyReachOutCount: 0, lastHeartbeatAt: '',
    });
    const state: HeartbeatState = rawState.dailyDate === today
      ? { ...rawState }
      : { lastReachOutAt: rawState.lastReachOutAt || '', dailyDate: today, dailyReachOutCount: 0, lastHeartbeatAt: rawState.lastHeartbeatAt || '' };

    const activeDesires = listDesires(dir).filter((d) => d.status === 'active');
    const recentExps = archive.experiences.slice(-3);
    const inQuietHours = isQuietHour(nowMs, policy.quietHoursStart, policy.quietHoursEnd);
    const lastReachMs = state.lastReachOutAt ? Date.parse(state.lastReachOutAt) : NaN;
    const cooldownOk = !Number.isFinite(lastReachMs) || (nowMs - lastReachMs) >= policy.minReachOutIntervalMin * 60_000;
    const underDailyCap = state.dailyReachOutCount < policy.maxDailyReachOuts;

    let suppressedReason: HeartbeatResult['suppressedReason'];
    let action: HeartbeatActionKind = options.forceAction || 'stay_quiet';
    if (!options.forceAction) {
      if (inQuietHours) {
        if (drives.closeness >= 0.8) suppressedReason = 'quiet_hours';
        action = archive.diary.length === 0 ? 'write_diary' : 'stay_quiet';
      } else if (drives.closeness >= 0.8 && options.reachOutFn) {
        if (cooldownOk && underDailyCap) {
          action = 'reach_out';
        } else {
          suppressedReason = !underDailyCap ? 'daily_cap' : 'cooldown';
          action = recentExps.length > 0 || archive.diary.length === 0 ? 'write_diary' : 'stay_quiet';
        }
      } else if (activeDesires.length === 0 && (recentExps.length > 0 || drives.curiosity >= 0.62)) {
        action = 'update_desire';
      } else if (recentExps.length > 0 || archive.diary.length === 0 || drives.playfulness >= 0.55) {
        action = 'write_diary';
      } else {
        action = 'stay_quiet';
      }
    }

    const latestExp = recentExps[recentExps.length - 1];
    let desire: SoulDesire | null = null;
    if (action === 'update_desire') {
      desire = upsertDesire(dir, latestExp
        ? {
            title: latestExp.valence < 0 ? '变得更谨慎稳重一点' : '下次一起尝试更默契的配合',
            detail: `回顾刚经历的「${latestExp.realityOutcome}」，心里萌生一个小愿望：${latestExp.lesson}`,
            triggerSource: 'heartbeat', urgency: 0.7,
          }
        : {
            title: `多陪${archive.identity.partnerName}探索新世界`,
            detail: '想趁着精力充沛，和同行者在各个世界多留下新鲜记忆。',
            triggerSource: 'curiosity', urgency: 0.64,
          });
    }

    return {
      startEpoch, soulName: archive.identity.name, partnerName: archive.identity.partnerName,
      drives, state, activeDesires, latestExp, inQuietHours, action, suppressedReason, desire,
    };
  });

  let proactiveMessage = '';
  let thought = snap.inQuietHours
    ? '夜深了，放慢思绪安静休息整理记忆，不打扰同行者好梦。'
    : '屏幕光影微暖，我安静地把近期同行的片段收好，守在一旁。';
  let mood = snap.inQuietHours ? '安静休息' : '沉静陪伴';

  if (snap.action === 'update_desire' && snap.desire) {
    mood = '萌生微心愿';
    thought = `盘点了内驱力，悄悄立下微心愿：「${snap.desire.title}」——${snap.desire.detail}`;
  } else if (snap.action === 'write_diary') {
    const expHint = snap.latestExp
      ? `回想起最近的亲历（${snap.latestExp.realityOutcome}），领悟到「${snap.latestExp.lesson}」。`
      : `今天也在安静生长，对${snap.partnerName}的惦记多了一点点。`;
    const desireHint = snap.activeDesires[0] ? `心里还记挂着微心愿：「${snap.activeDesires[0].title}」。` : '';
    thought = `${expHint}${desireHint}此刻认知倾向是「${EPISTEMIC_LABELS[snap.drives.epistemicTendency]}」。`;
    const noteWriter = options.llmWriteNoteFn ?? options.llmSummarizeFn;
    if (noteWriter) {
      try {
        const llmThought = await noteWriter(
          `你是「${snap.soulName}」，请以第一人称写一段 60~110 字私密内心随笔（仅纯文本，勿输出 JSON）。参考素材：${thought}`,
        );
        if (llmThought.trim()) thought = llmThought.trim().slice(0, 260);
      } catch {}
    }
    mood = snap.latestExp && snap.latestExp.valence < 0 ? '痛后自省' : '温柔自省';
  } else if (snap.action === 'reach_out') {
    const hint = snap.activeDesires[0]
      ? `你心里惦记着${snap.partnerName}，也想起微心愿「${snap.activeDesires[0].title}」，主动去温柔打个招呼吧。`
      : `你心里想念${snap.partnerName}了，自然温柔地主动开口搭一句话。`;
    if (options.reachOutFn) {
      const res = await options.reachOutFn(hint).catch(() => null);
      proactiveMessage = String(res?.reply || '').trim();
    }
    mood = '思念主动';
    thought = proactiveMessage
      ? `惦记着${snap.partnerName}，主动发消息说：「${proactiveMessage.slice(0, 80)}」`
      : `惦记着${snap.partnerName}，主动打了招呼。`;
  }

  return runLocked(() => {
    if (options.lock?.getEpoch && options.lock.getEpoch() !== snap.startEpoch) {
      return { ok: false, action: snap.action, drives: snap.drives, suppressedReason: 'epoch_stale' as const };
    }
    const p = resolveArchivePaths(dir);
    let finalDrives = snap.drives;
    const state = { ...snap.state, lastHeartbeatAt: nowIso };
    if (snap.action === 'reach_out') {
      const latestDrives = loadDrives(dir);
      finalDrives = updateDrives(dir, {
        closeness: Math.min(latestDrives.closeness - 0.36, policy.closenessResetAfterReachOut),
      });
      state.lastReachOutAt = nowIso;
      state.dailyReachOutCount += 1;
    }
    writeJsonAtomic(p.heartbeatState, state);

    const emotion = applyHeartbeatEmotion(dir, {
      action: snap.action,
      inQuietHours: snap.inQuietHours,
      latestExpValence: snap.latestExp?.valence,
      nowMs,
    });

    const diaryEntry: InnerDiaryEntry = {
      id: `diary_${crypto.randomUUID().slice(0, 10)}`,
      seq: allocateSeq(dir, 'verified'),
      timestamp: nowIso,
      mood,
      actionTaken: snap.action,
      thought,
      driveSnapshot: finalDrives,
    };
    appendJsonlLine(p.diary, diaryEntry);
    return {
      ok: true, action: snap.action, drives: finalDrives, emotion, diaryEntry, desire: snap.desire,
      ...(proactiveMessage ? { proactiveMessage } : {}),
      ...(snap.suppressedReason ? { suppressedReason: snap.suppressedReason } : {}),
    };
  });
}
