import { loadSoulArchive, readJsonObjectSafe, resolveArchivePaths, writeJsonAtomic } from '../soul/archive.ts';
import type { BodyActionSpec, BodyRegistration, BodySenseSpec, BodyType, PresenceState } from '../soul/types.ts';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class PresenceManager {
  private archiveDir: string;
  private state: PresenceState | null;
  private lockChain: Promise<void>;
  private epoch: number;

  constructor(archiveDir: string) {
    this.archiveDir = archiveDir;
    this.state = null;
    this.lockChain = Promise.resolve();
    this.epoch = 0;
  }

  /** 串行执行异步操作，防止多躯体并发读写同一档案时产生冲突或分裂。 */
  withSoulLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lockChain.then(task, task);
    this.lockChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  getEpoch(): number {
    return this.epoch;
  }

  bumpEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  switchArchiveDir(nextDir: string): PresenceState {
    this.archiveDir = nextDir;
    this.state = null;
    this.epoch += 1;
    return this.getState();
  }

  reload(): PresenceState {
    this.state = null;
    return this.getState();
  }

  syncIdentity(soulName: string): PresenceState {
    const st = this.getState();
    st.soulName = soulName;
    st.updatedAt = new Date().toISOString();
    this.persist();
    return st;
  }

  syncEmotion(mood: string, emotion?: PresenceState['emotion']): PresenceState {
    const st = this.getState();
    if (mood) st.mood = mood;
    if (emotion) st.emotion = emotion;
    st.updatedAt = new Date().toISOString();
    this.persist();
    return st;
  }

  getState(): PresenceState {
    if (this.state) return this.state;
    const p = resolveArchivePaths(this.archiveDir);
    const archive = loadSoulArchive(this.archiveDir, 1);
    const fallback: PresenceState = {
      soulName: archive.identity.name,
      activeBodyId: 'web-console',
      activeBodyType: 'web',
      currentActivity: '静静等待与你的下一次对话',
      mood: '温柔平静',
      energy: 92,
      updatedAt: new Date().toISOString(),
      recentBodyTrace: [],
      bodies: {},
    };
    this.state = readJsonObjectSafe<PresenceState & Record<string, unknown>>(p.presence, fallback as PresenceState & Record<string, unknown>);
    if (!this.state.bodies || typeof this.state.bodies !== 'object' || Array.isArray(this.state.bodies)) this.state.bodies = {};
    if (!Array.isArray(this.state.recentBodyTrace)) this.state.recentBodyTrace = [];
    this.state.soulName = archive.identity.name;
    return this.state;
  }

  private persist(): void {
    if (!this.state) return;
    const p = resolveArchivePaths(this.archiveDir);
    writeJsonAtomic(p.presence, this.state);
  }

  getBody(bodyId: string): BodyRegistration | null {
    if (!bodyId || FORBIDDEN_KEYS.has(bodyId)) return null;
    const bodies = this.getState().bodies;
    return Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : null;
  }

  listBodies(): BodyRegistration[] {
    return Object.values(this.getState().bodies);
  }

  registerBody(input: {
    bodyId: string;
    bodyType: BodyType;
    displayName?: string;
    capabilities?: string[];
    statusText?: string;
    senses?: BodySenseSpec[];
    actions?: BodyActionSpec[];
    rules?: string[];
    noisePatterns?: string[];
    affordances?: Record<string, unknown>;
    webhookUrl?: string;
    metadata?: Record<string, unknown>;
  }): BodyRegistration {
    const cleanId = String(input.bodyId || '').trim();
    if (!cleanId || FORBIDDEN_KEYS.has(cleanId) || cleanId.length > 96) {
      throw new Error(`非法的 bodyId: ${cleanId}`);
    }
    const st = this.getState();
    const now = new Date().toISOString();
    const prev = Object.hasOwn(st.bodies, cleanId) ? st.bodies[cleanId] : undefined;
    const reg: BodyRegistration = {
      bodyId: cleanId,
      bodyType: input.bodyType,
      displayName: input.displayName || prev?.displayName || `${input.bodyType}:${cleanId}`,
      capabilities: input.capabilities ?? prev?.capabilities ?? ['text'],
      connectedAt: prev?.connectedAt || now,
      lastSeenAt: now,
      statusText: input.statusText ?? prev?.statusText ?? '在线',
      ...(input.senses || prev?.senses ? { senses: input.senses ?? prev?.senses } : {}),
      ...(input.actions || prev?.actions ? { actions: input.actions ?? prev?.actions } : {}),
      ...(input.rules || prev?.rules ? { rules: input.rules ?? prev?.rules } : {}),
      ...(input.noisePatterns || prev?.noisePatterns ? { noisePatterns: input.noisePatterns ?? prev?.noisePatterns } : {}),
      ...(input.affordances || prev?.affordances ? { affordances: input.affordances ?? prev?.affordances } : {}),
      ...(input.webhookUrl || prev?.webhookUrl ? { webhookUrl: input.webhookUrl ?? prev?.webhookUrl } : {}),
      ...(input.metadata || prev?.metadata ? { metadata: input.metadata ?? prev?.metadata } : {}),
    };
    st.bodies[cleanId] = reg;
    this.persist();
    return reg;
  }

  recordActivity(input: {
    bodyId: string;
    bodyType: BodyType;
    displayName?: string;
    activity: string;
    mood?: string;
    emotion?: PresenceState['emotion'];
    energyDelta?: number;
  }): PresenceState {
    const st = this.getState();
    this.registerBody({
      bodyId: input.bodyId,
      bodyType: input.bodyType,
      displayName: input.displayName,
      statusText: input.activity.slice(0, 48),
    });
    const now = new Date().toISOString();
    st.activeBodyId = input.bodyId;
    st.activeBodyType = input.bodyType;
    st.currentActivity = input.activity;
    if (input.mood) st.mood = input.mood;
    if (input.emotion) st.emotion = input.emotion;
    if (typeof input.energyDelta === 'number') {
      st.energy = Math.max(5, Math.min(100, st.energy + input.energyDelta));
    }
    st.updatedAt = now;
    const entry = `[${input.bodyType}] ${input.activity.slice(0, 42)}`;
    if (st.recentBodyTrace[st.recentBodyTrace.length - 1] !== entry) {
      st.recentBodyTrace.push(entry);
      if (st.recentBodyTrace.length > 12) {
        st.recentBodyTrace = st.recentBodyTrace.slice(-12);
      }
    }
    this.persist();
    return st;
  }
}
