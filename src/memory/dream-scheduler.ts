import { readJsonSafe, readJsonlSafe, resolveArchivePaths } from '../soul/archive.ts';
import type { JournalEntry, SoulMeta } from '../soul/types.ts';
import type { DreamResult } from './dream.ts';

export interface DreamSchedulerConfig {
  enabled: boolean;
  idleMinutes: number;
  minPendingEntries: number;
  checkIntervalSec: number;
}

export interface DreamSchedulerStatus {
  enabled: boolean;
  idleMinutes: number;
  minPendingEntries: number;
  checkIntervalSec: number;
  running: boolean;
  idleSeconds: number;
  pendingEntries: number;
  lastRunAt: string | null;
  lastResult: DreamResult | null;
  lastError: string | null;
}

export interface DreamTickOutcome {
  triggered: boolean;
  reason: string;
  result?: DreamResult;
}

export interface AutoDreamSchedulerOptions {
  config: DreamSchedulerConfig;
  getArchiveDir: () => string;
  runDream: () => Promise<DreamResult>;
  onDreamCompleted?: (result: DreamResult) => void;
}

function normalizeDreamConfig(raw?: Partial<DreamSchedulerConfig>): DreamSchedulerConfig {
  const idleNum = Number(raw?.idleMinutes);
  const minNum = Number(raw?.minPendingEntries);
  const checkNum = Number(raw?.checkIntervalSec);
  return {
    enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : true,
    idleMinutes: raw?.idleMinutes !== undefined && Number.isFinite(idleNum) ? Math.max(0, idleNum) : 15,
    minPendingEntries: raw?.minPendingEntries !== undefined && Number.isFinite(minNum) ? Math.max(1, Math.floor(minNum)) : 4,
    checkIntervalSec: raw?.checkIntervalSec !== undefined && Number.isFinite(checkNum) && checkNum > 0 ? checkNum : 60,
  };
}

/**
 * 闲置自动做梦整理定时器：在多躯体安静一段时间且积累了足够新经历后自动浓缩记忆。
 */
export class AutoDreamScheduler {
  private readonly options: AutoDreamSchedulerOptions;
  private config: DreamSchedulerConfig;
  private lastActivityAtMs: number;
  private running: boolean;
  private lastRunAt: string | null;
  private lastResult: DreamResult | null;
  private lastError: string | null;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(options: AutoDreamSchedulerOptions) {
    this.options = options;
    this.config = normalizeDreamConfig(options.config);
    this.lastActivityAtMs = Date.now();
    this.running = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.lastError = null;
    this.timer = null;
  }

  markActivity(nowMs = Date.now()): void {
    this.lastActivityAtMs = nowMs;
  }

  countPendingEntries(): number {
    try {
      const p = resolveArchivePaths(this.options.getArchiveDir());
      const meta = readJsonSafe<Partial<SoulMeta>>(p.meta, {});
      const lastSeq = typeof meta.lastDreamSeq === 'number' ? meta.lastDreamSeq : 0;
      const entries = readJsonlSafe<JournalEntry>(p.journal);
      let pending = 0;
      for (const j of entries) {
        if (j.seq > lastSeq) pending += 1;
      }
      return pending;
    } catch {
      return 0;
    }
  }

  getStatus(nowMs = Date.now()): DreamSchedulerStatus {
    return {
      ...this.config,
      running: this.running,
      idleSeconds: Math.max(0, Math.floor((nowMs - this.lastActivityAtMs) / 1000)),
      pendingEntries: this.countPendingEntries(),
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  updateConfig(next: DreamSchedulerConfig): void {
    const wasRunning = this.timer !== null;
    this.config = normalizeDreamConfig(next);
    if (wasRunning) {
      if (this.config.enabled) this.start();
      else this.stop();
    }
  }

  start(): void {
    this.stop();
    if (!this.config.enabled) return;
    const intervalMs = Math.max(50, Math.round(this.config.checkIntervalSec * 1000));
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(nowMs = Date.now()): Promise<DreamTickOutcome> {
    if (!this.config.enabled) {
      return { triggered: false, reason: 'disabled' };
    }
    if (this.running) {
      return { triggered: false, reason: 'already-running' };
    }
    const idleMs = Math.max(0, this.config.idleMinutes) * 60_000;
    if (nowMs - this.lastActivityAtMs < idleMs) {
      return { triggered: false, reason: 'not-idle' };
    }
    const pending = this.countPendingEntries();
    if (pending < Math.max(1, this.config.minPendingEntries)) {
      return { triggered: false, reason: 'insufficient-pending' };
    }

    this.running = true;
    this.lastError = null;
    try {
      const res = await this.options.runDream();
      this.lastRunAt = new Date().toISOString();
      this.lastResult = res;
      if (res.processedEntries > 0) {
        this.options.onDreamCompleted?.(res);
      }
      return { triggered: true, reason: 'completed', result: res };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return { triggered: false, reason: 'error' };
    } finally {
      this.running = false;
    }
  }
}
