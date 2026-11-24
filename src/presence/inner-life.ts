import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lexicalSimilarity } from '../memory/experience.ts';
import {
  DEFAULT_SOUL_DRIVES,
  allocateSeq,
  readJsonArraySafe,
  readJsonArrayStrict,
  readJsonObjectSafe,
  readJsonObjectStrict,
  readJsonlSafe,
  resolveArchivePaths,
  writeJsonAtomic,
  writeTextAtomic,
} from '../soul/archive.ts';
import { evolveSelfFromDream, listBeliefs, listSelfEvolution, renderEvolvingSelfMarkdown } from '../soul/living-self.ts';
import type {
  EpistemicAttitude,
  ExperimentalConfig,
  ExperienceOrigin,
  HeartbeatActionKind,
  InnerDiaryEntry,
  LivedExperience,
  SoulDesire,
  SoulDrives,
} from '../soul/types.ts';
import { DEFAULT_HEARTBEAT_POLICY, runSoulHeartbeat, type HeartbeatPolicy, type HeartbeatResult } from './heartbeat.ts';
import { applyExperienceEmotion, applyEmotionStimulus, loadEmotionState, toPresenceEmotion } from './emotion.ts';

export { DEFAULT_HEARTBEAT_POLICY, runSoulHeartbeat, type HeartbeatPolicy, type HeartbeatResult };

export const EPISTEMIC_LABELS: Record<EpistemicAttitude, string> = {
  believed: '🛡️ 笃信采纳（谨慎听劝）',
  skeptical: '🤔 半信半疑（想亲手求证）',
  dismissed: '😜 漫不经心（玩心大未在意）',
  verified: '✅ 实践证实（亲身检验）',
  overturned: '🔄 实践扬弃（掌握方法超越旧知）',
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Number(Math.max(0.05, Math.min(0.98, v)).toFixed(3));
}

export function inferEpistemicAttitude(drives: SoulDrives, origin: ExperienceOrigin, _valence = 0): EpistemicAttitude {
  if (origin === 'lived') return 'verified';
  if (drives.safety >= 0.7 || drives.closeness >= 0.84) return 'believed';
  if (drives.playfulness >= 0.68 && drives.safety < 0.55 && drives.curiosity < drives.playfulness) return 'dismissed';
  if (drives.curiosity >= drives.safety) return 'skeptical';
  return 'believed';
}

export function loadDrives(dir: string): SoulDrives {
  const p = resolveArchivePaths(dir);
  const raw = readJsonObjectSafe<SoulDrives & Record<string, unknown>>(p.drives, { ...DEFAULT_SOUL_DRIVES } as SoulDrives & Record<string, unknown>);
  const drives: SoulDrives = {
    curiosity: clamp01(raw.curiosity ?? DEFAULT_SOUL_DRIVES.curiosity),
    closeness: clamp01(raw.closeness ?? DEFAULT_SOUL_DRIVES.closeness),
    safety: clamp01(raw.safety ?? DEFAULT_SOUL_DRIVES.safety),
    playfulness: clamp01(raw.playfulness ?? DEFAULT_SOUL_DRIVES.playfulness),
    energy: Math.max(5, Math.min(100, Math.round(raw.energy ?? DEFAULT_SOUL_DRIVES.energy))),
    epistemicTendency: 'skeptical',
    lastUpdatedAt: raw.lastUpdatedAt || new Date().toISOString(),
  };
  drives.epistemicTendency = inferEpistemicAttitude(drives, 'inherited');
  return drives;
}

export function updateDrives(dir: string, patch: Partial<SoulDrives>): SoulDrives {
  const p = resolveArchivePaths(dir);
  readJsonObjectStrict<Record<string, unknown>>(p.drives, { ...DEFAULT_SOUL_DRIVES }, 'INNER-LIFE/drives.json');
  const cur = loadDrives(dir);
  const next: SoulDrives = {
    curiosity: patch.curiosity !== undefined ? clamp01(patch.curiosity) : cur.curiosity,
    closeness: patch.closeness !== undefined ? clamp01(patch.closeness) : cur.closeness,
    safety: patch.safety !== undefined ? clamp01(patch.safety) : cur.safety,
    playfulness: patch.playfulness !== undefined ? clamp01(patch.playfulness) : cur.playfulness,
    energy: patch.energy !== undefined ? Math.max(5, Math.min(100, Math.round(patch.energy))) : cur.energy,
    epistemicTendency: 'skeptical',
    lastUpdatedAt: new Date().toISOString(),
  };
  next.epistemicTendency = inferEpistemicAttitude(next, 'inherited');
  writeJsonAtomic(p.drives, next);
  return next;
}

export function listDesires(dir: string): SoulDesire[] {
  return readJsonArraySafe<SoulDesire>(resolveArchivePaths(dir).desires, []);
}

export function upsertDesire(
  dir: string,
  input: {
    title: string;
    detail: string;
    triggerSource?: SoulDesire['triggerSource'];
    urgency?: number;
    confidence?: number;
  },
): SoulDesire {
  const p = resolveArchivePaths(dir);
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('微心愿标题不能为空');
  const list = readJsonArrayStrict<SoulDesire>(p.desires, [], 'INNER-LIFE/desires.json');
  const now = new Date().toISOString();
  const existing = list.find(
    (d) => d.status === 'active' && (
      d.title === title
      || (title.length >= 2 && d.title.includes(title))
      || (d.title.length >= 2 && title.includes(d.title))
    ),
  );
  if (existing) {
    existing.detail = String(input.detail ?? '').trim() || existing.detail;
    existing.urgency = clamp01(input.urgency ?? Math.max(existing.urgency, 0.72));
    existing.confidence = clamp01(input.confidence ?? existing.confidence);
    existing.updatedAt = now;
    writeJsonAtomic(p.desires, list);
    return existing;
  }
  const item: SoulDesire = {
    id: `des_${crypto.randomUUID().slice(0, 10)}`,
    seq: allocateSeq(dir, 'verified'),
    createdAt: now,
    updatedAt: now,
    title,
    detail: String(input.detail ?? '').trim() || title,
    triggerSource: input.triggerSource || 'heartbeat',
    urgency: clamp01(input.urgency ?? 0.68),
    confidence: clamp01(input.confidence ?? 0.78),
    status: 'active',
  };
  list.push(item);
  writeJsonAtomic(p.desires, list);
  return item;
}

export function fulfillDesire(dir: string, idOrKeyword: string): SoulDesire | null {
  const key = String(idOrKeyword ?? '').trim();
  if (!key) return null;
  const p = resolveArchivePaths(dir);
  const list = readJsonArrayStrict<SoulDesire>(p.desires, [], 'INNER-LIFE/desires.json');
  const target = list.find(
    (d) => d.status === 'active' && (d.id === key || d.title === key || (key.length >= 2 && d.title.includes(key))),
  );
  if (!target) return null;
  target.status = 'fulfilled';
  target.updatedAt = new Date().toISOString();
  writeJsonAtomic(p.desires, list);
  return target;
}

export function listDiary(dir: string, limit = 30): InnerDiaryEntry[] {
  return readJsonlSafe<InnerDiaryEntry>(resolveArchivePaths(dir).diary, limit);
}

function upgradeInheritedAttitudes(dir: string, exp: LivedExperience): void {
  const p = resolveArchivePaths(dir);
  const all = readJsonlSafe<LivedExperience>(p.experiences);
  let changed = false;
  const expText = `${exp.stimulus} ${exp.realityOutcome} ${exp.lesson}`;
  const updated = all.map((item) => {
    if (item.origin !== 'inherited' || (item.attitude !== 'skeptical' && item.attitude !== 'dismissed')) return item;
    const sameTopic = lexicalSimilarity(expText, `${item.stimulus} ${item.lesson}`) >= 0.12;
    if (!sameTopic && item.bodyType !== exp.bodyType) return item;
    changed = true;
    return { ...item, attitude: (exp.valence >= 0.45 ? 'overturned' : 'verified') as EpistemicAttitude };
  });
  if (changed) {
    writeTextAtomic(p.experiences, updated.map((e) => JSON.stringify(e)).join('\n') + (updated.length ? '\n' : ''));
  }
}

/** 通用亲历反馈演化内驱力与微心愿（无任何特定游戏或场景硬编码）。 */
export function applyExperienceToInnerLife(
  dir: string,
  exp: LivedExperience,
  nowMs?: number,
): { drives: SoulDrives; desire?: SoulDesire | null } {
  const cur = loadDrives(dir);
  let desire: SoulDesire | null = null;
  applyExperienceEmotion(dir, exp, nowMs);
  if (exp.origin !== 'lived') return { drives: cur, desire };

  upgradeInheritedAttitudes(dir, exp);
  if (exp.valence <= -0.4) {
    const next = updateDrives(dir, {
      safety: cur.safety + 0.28,
      playfulness: cur.playfulness - 0.14,
      curiosity: cur.curiosity - 0.06,
      energy: cur.energy - 8,
    });
    const shortLesson = exp.lesson.replace(/[。！!？?]+$/, '').slice(0, 18);
    desire = upsertDesire(dir, {
      title: `做好防护准备：${shortLesson || '先保护好自己'}`,
      detail: `亲历过「${exp.realityOutcome}」，提醒自己：${exp.lesson}`,
      triggerSource: 'practice',
      urgency: 0.88,
      confidence: 0.9,
    });
    return { drives: next, desire };
  }

  if (exp.valence >= 0.45) {
    const next = updateDrives(dir, {
      playfulness: cur.playfulness + 0.12,
      curiosity: cur.curiosity + 0.08,
      safety: Math.max(0.32, cur.safety - 0.06),
      closeness: cur.closeness + 0.05,
    });
    for (const d of listDesires(dir)) {
      if (d.status === 'active' && d.triggerSource === 'practice' && d.title.startsWith('做好防护准备')) {
        fulfillDesire(dir, d.id);
      }
    }
    desire = upsertDesire(dir, {
      title: `在 [${exp.bodyType}] 继续并肩探索实践`,
      detail: `刚才「${exp.realityOutcome}」带来了积极成果（${exp.lesson}），期待一起探索更多可能。`,
      triggerSource: 'practice',
      urgency: 0.62,
      confidence: 0.85,
    });
    return { drives: next, desire };
  }
  return { drives: cur, desire };
}

export interface InnerLifeHubLike {
  config: { archiveDir: string; experimental?: ExperimentalConfig };
  presence: {
    withSoulLock: <T>(task: () => Promise<T>) => Promise<T>;
    getEpoch?: () => number;
    syncEmotion?: (mood: string, emotion?: { valence: number; arousal: number; safety: number; moodLabel: string; updatedAt: string }) => unknown;
  };
  llm: { isRealLlm: () => boolean; dreamSummarize: (prompt: string) => Promise<string>; writeInnerNote?: (prompt: string) => Promise<string> };
  events: { emit: (event: string, payload: unknown) => void };
  ws: { broadcastJson: (payload: unknown) => void } | null;
  triggerProactive?: (hint: string) => Promise<{ reply?: string } | null>;
}

export async function handleInnerLifeHttpRoute(
  hub: InnerLifeHubLike,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
  readJsonBody: <T = Record<string, unknown>>(req: IncomingMessage) => Promise<T>,
): Promise<boolean> {
  const blockIfOff = (key: keyof ExperimentalConfig, label: string): boolean => {
    if (hub.config.experimental?.[key] !== false) return false;
    sendJson(res, 403, { ok: false, error: `实验性${label}模块未启用（请在设置中开启 ${key}）`, experimentalDisabled: key });
    return true;
  };
  if (req.method === 'GET' && pathname === '/api/inner-life') {
    const dir = hub.config.archiveDir;
    const p = resolveArchivePaths(dir);
    const drives = loadDrives(dir);
    sendJson(res, 200, {
      ok: true, experimental: hub.config.experimental, drives, emotion: loadEmotionState(dir), desires: listDesires(dir), diary: listDiary(dir, 30),
      epistemicLabel: EPISTEMIC_LABELS[drives.epistemicTendency],
      evolvingSelfMarkdown: fs.existsSync(p.evolvingSelf) ? fs.readFileSync(p.evolvingSelf, 'utf8') : renderEvolvingSelfMarkdown(dir),
      beliefs: listBeliefs(dir), selfEvolution: listSelfEvolution(dir),
    });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/inner-life/emotion') {
    sendJson(res, 200, { ok: true, emotion: loadEmotionState(hub.config.archiveDir) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/emotion') {
    if (blockIfOff('enableEmotion', '情绪惯性')) return true;
    const body = await readJsonBody<{
      reset?: boolean; valence?: number; arousal?: number; safety?: number;
      intensity?: number; rawMood?: string; note?: string; nowMs?: number;
    }>(req);
    const emotion = await hub.presence.withSoulLock(async () => {
      const next = body.reset
        ? (await import('./emotion.ts')).resetEmotionState(hub.config.archiveDir, body.nowMs)
        : applyEmotionStimulus(hub.config.archiveDir, {
            valence: body.valence, arousal: body.arousal, safety: body.safety,
            intensity: body.intensity, rawMood: body.rawMood, note: body.note, nowMs: body.nowMs, source: 'manual',
          });
      hub.presence.syncEmotion?.(next.moodLabel, toPresenceEmotion(next));
      return next;
    });
    hub.ws?.broadcastJson({ type: 'inner.emotion', emotion });
    sendJson(res, 200, { ok: true, emotion });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/evolve') {
    if (blockIfOff('enableInnerLife', '内在生命与自我演化')) return true;
    const dir = hub.config.archiveDir;
    const note = await evolveSelfFromDream(
      dir,
      hub.llm.isRealLlm() ? (pr) => hub.llm.dreamSummarize(pr) : undefined,
      { lock: hub.presence },
    );
    sendJson(res, 200, { ok: true, note, evolvingSelfMarkdown: renderEvolvingSelfMarkdown(dir), beliefs: listBeliefs(dir), selfEvolution: listSelfEvolution(dir) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/drives') {
    if (blockIfOff('enableInnerLife', '内在生命与驱力')) return true;
    const body = await readJsonBody<Partial<SoulDrives>>(req);
    const drives = await hub.presence.withSoulLock(async () => updateDrives(hub.config.archiveDir, body));
    hub.ws?.broadcastJson({ type: 'inner.drives', drives });
    sendJson(res, 200, { ok: true, drives, epistemicLabel: EPISTEMIC_LABELS[drives.epistemicTendency] });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/desire') {
    if (blockIfOff('enableInnerLife', '内在生命与微心愿')) return true;
    const body = await readJsonBody<{ title?: string; detail?: string; urgency?: number }>(req);
    if (!String(body.title || '').trim()) {
      sendJson(res, 400, { ok: false, error: '微心愿 title 不能为空' });
      return true;
    }
    const desire = await hub.presence.withSoulLock(async () =>
      upsertDesire(hub.config.archiveDir, { title: String(body.title), detail: String(body.detail || ''), urgency: body.urgency, triggerSource: 'curiosity' }),
    );
    sendJson(res, 200, { ok: true, desire });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/desire/fulfill') {
    if (blockIfOff('enableInnerLife', '内在生命与微心愿')) return true;
    const body = await readJsonBody<{ id?: string }>(req);
    const id = String(body.id || '').trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: '微心愿 id 不能为空' });
      return true;
    }
    const desire = await hub.presence.withSoulLock(async () => fulfillDesire(hub.config.archiveDir, id));
    sendJson(res, 200, { ok: Boolean(desire), desire });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/inner-life/heartbeat') {
    if (blockIfOff('enableHeartbeat', '静默心搏')) return true;
    const body = await readJsonBody<{ forceAction?: HeartbeatActionKind; isSilentIdle?: boolean }>(req);
    const out = await runSoulHeartbeat(hub.config.archiveDir, {
      forceAction: body.forceAction,
      isSilentIdle: body.isSilentIdle,
      reachOutFn: hub.triggerProactive,
      llmWriteNoteFn: hub.llm.isRealLlm()
        ? (prompt) => (hub.llm.writeInnerNote ? hub.llm.writeInnerNote(prompt) : hub.llm.dreamSummarize(prompt))
        : undefined,
      lock: hub.presence,
    });
    hub.events.emit('heartbeat.completed', out);
    hub.ws?.broadcastJson({ type: 'heartbeat', result: out });
    sendJson(res, 200, out);
    return true;
  }
  return false;
}
