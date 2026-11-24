import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { checkConflictPorts } from '../../adapters/qq-onebot/guard.ts';
import { DEFAULT_LOCAL_CONFIG_PATH, loadQqAdapterConfig } from '../../adapters/qq-onebot/main.ts';
import type { QqAdapterConfig } from '../../adapters/qq-onebot/types.ts';
import { getMemoryIndexStatus } from '../memory/search.ts';
import { writeJsonAtomic } from '../soul/archive.ts';
import { readJsonBody, sendJson, type SoulHubContext } from './body-api.ts';
import { REPO_ROOT } from './config.ts';

function probePort(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function extractPort(rawUrl: string | undefined, fallback: number): number {
  try {
    const u = new URL(String(rawUrl || ''));
    return Number(u.port) || fallback;
  } catch {
    return fallback;
  }
}

function maskSecret(val?: string): string {
  const s = String(val ?? '').trim();
  if (!s) return '';
  if (s.length <= 6) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function mergeSecret(incoming: unknown, current?: string): string {
  const s = String(incoming ?? '').trim();
  if (!s || s.includes('****')) return current || '';
  return s;
}

function sanitizeQqConfig(cfg: QqAdapterConfig) {
  return {
    ...cfg,
    onebot: {
      ...cfg.onebot,
      wsAccessToken: maskSecret(cfg.onebot.wsAccessToken),
      httpAccessToken: maskSecret(cfg.onebot.httpAccessToken),
      hasWsToken: Boolean(cfg.onebot.wsAccessToken),
      hasHttpToken: Boolean(cfg.onebot.httpAccessToken),
    },
  };
}

function cleanStrList(val: unknown, fallback: string[]): string[] {
  if (!Array.isArray(val)) return fallback;
  return val.map((x) => String(x ?? '').trim()).filter(Boolean);
}

export class Phase2Manager {
  private qqProc: ChildProcess | null;
  private qqLogs: string[];
  private testRunning: boolean;

  constructor() {
    this.qqProc = null;
    this.qqLogs = [];
    this.testRunning = false;
  }

  private pushLog(line: string): void {
    const t = new Date().toTimeString().slice(0, 8);
    this.qqLogs.push(`[${t}] ${line}`);
    if (this.qqLogs.length > 50) {
      this.qqLogs = this.qqLogs.slice(-50);
    }
  }

  isQqRunning(): boolean {
    return Boolean(this.qqProc && !this.qqProc.killed && this.qqProc.exitCode === null);
  }

  getQqPid(): number | null {
    return this.isQqRunning() ? (this.qqProc?.pid ?? null) : null;
  }

  getQqLogs(): string[] {
    return [...this.qqLogs];
  }

  async startQq(configPath = DEFAULT_LOCAL_CONFIG_PATH, apiToken = '') {
    if (this.isQqRunning()) {
      return { ok: true, alreadyRunning: true, pid: this.getQqPid() };
    }
    const cfg = loadQqAdapterConfig(configPath);
    const conflicts = await checkConflictPorts(cfg.guard.conflictCheckPorts);
    if (conflicts.length) {
      throw new Error(`检测到冲突端口 ${conflicts.join(', ')} 仍在占用（可能旧桥接未暂停），请先暂停旧端再启动！`);
    }
    if (!cfg.guard.allowedUsers.length && !cfg.guard.allowedGroups.length) {
      throw new Error('请至少填写一个白名单 QQ 号或测试群号后再启动，避免防风控拦截全部消息。');
    }

    const scriptPath = path.join(REPO_ROOT, 'adapters', 'qq-onebot', 'main.ts');
    const proc = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, QQ_ADAPTER_CONFIG: configPath, ...(apiToken ? { SOUL_API_TOKEN: apiToken } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.qqProc = proc;
    this.pushLog(`已拉起 QQ 适配器进程 (PID ${proc.pid ?? '?'})`);

    const appendChunk = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line) this.pushLog(line);
      }
    };
    proc.stdout?.on('data', appendChunk);
    proc.stderr?.on('data', appendChunk);
    proc.on('exit', (code) => {
      if (this.qqProc === proc) this.qqProc = null;
      this.pushLog(`QQ 适配器已退出 (exit=${code ?? 'null'})`);
    });
    proc.on('error', (err) => {
      if (this.qqProc === proc) this.qqProc = null;
      this.pushLog(`QQ 适配器启动错误: ${err.message}`);
    });

    return { ok: true, pid: proc.pid ?? null };
  }

  stopQq() {
    if (!this.isQqRunning() || !this.qqProc) {
      this.qqProc = null;
      return { ok: true, stopped: false };
    }
    try {
      this.qqProc.kill();
    } catch {}
    this.qqProc = null;
    this.pushLog('已手动停止 QQ 适配器');
    return { ok: true, stopped: true };
  }

  async runAutomatedTests() {
    if (this.testRunning) throw new Error('体检正在运行中，请稍候...');
    this.testRunning = true;
    const startedAt = Date.now();
    try {
      const testFiles = fs.readdirSync(path.join(REPO_ROOT, 'tests'))
        .filter((n) => n.endsWith('.test.ts'))
        .sort()
        .map((n) => path.join('tests', n));
      return await new Promise<{
        ok: boolean;
        exitCode: number | null;
        durationMs: number;
        passedLines: string[];
        failedLines: string[];
        rawOutput: string;
      }>((resolve) => {
        const proc = spawn(process.execPath, ['--test', ...testFiles], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const collect = (chunk: Buffer) => { out += chunk.toString('utf8'); };
        proc.stdout?.on('data', collect);
        proc.stderr?.on('data', collect);
        const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          resolve({
            ok: code === 0,
            exitCode: code,
            durationMs: Date.now() - startedAt,
            passedLines: lines.filter((l) => l.startsWith('✔')),
            failedLines: lines.filter((l) => l.startsWith('✖')),
            rawOutput: out.slice(-4000),
          });
        });
      });
    } finally {
      this.testRunning = false;
    }
  }

  stop(): void {
    this.stopQq();
  }
}

export async function handlePhase2ApiRequest(
  ctx: SoulHubContext,
  manager: Phase2Manager,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const reqPath = url.pathname;
  if (!reqPath.startsWith('/api/phase2/')) return false;

  try {
    if (req.method === 'GET' && reqPath === '/api/phase2/status') {
      const qqCfg = loadQqAdapterConfig();
      const wsPort = extractPort(qqCfg.onebot.wsUrl, 3001);
      const httpPort = extractPort(qqCfg.onebot.httpUrl, 3000);
      const [conflictPorts, onebotWsOpen, onebotHttpOpen] = await Promise.all([
        checkConflictPorts(qqCfg.guard.conflictCheckPorts),
        probePort(wsPort),
        qqCfg.onebot.httpUrl ? probePort(httpPort) : Promise.resolve(false),
      ]);
      sendJson(res, 200, {
        ok: true, hubOk: true, conflictPorts, onebotWsOpen, onebotHttpOpen, onebotWsPort: wsPort, onebotHttpPort: httpPort,
        qqRunning: manager.isQqRunning(), qqPid: manager.getQqPid(), qqLogs: manager.getQqLogs(),
        whitelistCount: { users: qqCfg.guard.allowedUsers.length, groups: qqCfg.guard.allowedGroups.length },
        autoDream: ctx.dreamScheduler?.getStatus() ?? null,
        memoryIndex: getMemoryIndexStatus(ctx.config.archiveDir),
      });
      return true;
    }
    if (req.method === 'GET' && reqPath === '/api/phase2/qq/config') {
      sendJson(res, 200, { ok: true, config: sanitizeQqConfig(loadQqAdapterConfig()) });
      return true;
    }
    if (req.method === 'POST' && reqPath === '/api/phase2/qq/config') {
      const patch = await readJsonBody<Partial<QqAdapterConfig>>(req);
      const cur = loadQqAdapterConfig();
      const next: QqAdapterConfig = {
        ...cur,
        ...(patch.bodyId ? { bodyId: String(patch.bodyId).trim() } : {}),
        ...(patch.displayName ? { displayName: String(patch.displayName).trim() } : {}),
        onebot: {
          ...cur.onebot, ...(patch.onebot || {}),
          wsAccessToken: mergeSecret(patch.onebot?.wsAccessToken, cur.onebot.wsAccessToken),
          httpAccessToken: mergeSecret(patch.onebot?.httpAccessToken, cur.onebot.httpAccessToken),
        },
        guard: {
          ...cur.guard, ...(patch.guard || {}),
          allowedUsers: cleanStrList(patch.guard?.allowedUsers, cur.guard.allowedUsers),
          allowedGroups: cleanStrList(patch.guard?.allowedGroups, cur.guard.allowedGroups),
          wakeWords: cleanStrList(patch.guard?.wakeWords, cur.guard.wakeWords),
        },
        voice: { ...cur.voice, ...(patch.voice || {}) },
        proactive: { ...cur.proactive, ...(patch.proactive || {}) },
      };
      writeJsonAtomic(DEFAULT_LOCAL_CONFIG_PATH, next);
      sendJson(res, 200, { ok: true, config: sanitizeQqConfig(next) });
      return true;
    }
    if (req.method === 'POST' && reqPath === '/api/phase2/qq/start') { sendJson(res, 200, await manager.startQq(undefined, ctx.apiToken)); return true; }
    if (req.method === 'POST' && reqPath === '/api/phase2/qq/stop') { sendJson(res, 200, manager.stopQq()); return true; }
    if (req.method === 'POST' && reqPath === '/api/phase2/run-tests') { sendJson(res, 200, await manager.runAutomatedTests()); return true; }
    if (req.method === 'GET' && reqPath === '/api/phase2/last-prompt') {
      sendJson(res, 200, { ok: true, experimental: ctx.config.experimental, snapshot: ctx.lastPrompt });
      return true;
    }
    sendJson(res, 404, { ok: false, error: `未知 Phase 2 接口: ${reqPath}` });
    return true;
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
