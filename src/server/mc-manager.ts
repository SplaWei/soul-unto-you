import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './config.ts';

function probeTcp(port: number, host = '127.0.0.1', timeoutMs = 600): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

export function sanitizeMcBotName(raw?: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return cleaned.length >= 3 ? cleaned : 'Hajimi';
}

export class McBotManager {
  private readonly runtimeDir: string;
  private proc: ChildProcess | null;
  private logs: string[];
  private installing: boolean;
  private activePort: number | null;
  private activeBotName: string;

  constructor() {
    this.runtimeDir = path.join(os.homedir(), '.soul-unto-you', 'mc-runtime');
    this.proc = null;
    this.logs = [];
    this.installing = false;
    this.activePort = null;
    this.activeBotName = 'Hajimi';
  }

  private pushLog(line: string): void {
    const t = new Date().toTimeString().slice(0, 8);
    this.logs.push(`[${t}] ${line}`);
    if (this.logs.length > 60) {
      this.logs = this.logs.slice(-60);
    }
  }

  isRuntimeReady(): boolean {
    const pkgs = ['mineflayer', 'mineflayer-pathfinder', 'mineflayer-pvp', 'mineflayer-armor-manager'];
    return pkgs.every((pkg) => fs.existsSync(path.join(this.runtimeDir, 'node_modules', pkg, 'package.json')));
  }

  isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  getState() {
    return {
      runtimeReady: this.isRuntimeReady(),
      installing: this.installing,
      running: this.isRunning(),
      pid: this.isRunning() ? (this.proc?.pid ?? null) : null,
      port: this.activePort,
      botName: this.activeBotName,
      logs: [...this.logs],
    };
  }

  async ensureRuntimeInstalled(): Promise<{ ok: boolean; alreadyInstalled?: boolean }> {
    if (this.isRuntimeReady()) return { ok: true, alreadyInstalled: true };
    if (this.installing) throw new Error('正在自动安装 MC 联机组件，请稍候几十秒…');

    this.installing = true;
    this.pushLog('首次使用正在自动下载 MC 联机组件（mineflayer），仓库仍保持零依赖…');
    try {
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      const pkgPath = path.join(this.runtimeDir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({ name: 'soul-mc-runtime', private: true }, null, 2), 'utf8');
      }

      const pkgs = ['mineflayer', 'mineflayer-pathfinder', 'mineflayer-pvp', 'mineflayer-armor-manager'];
      const cmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
      const args = process.platform === 'win32'
        ? ['/c', 'npm', 'install', '--no-audit', '--no-fund', ...pkgs]
        : ['install', '--no-audit', '--no-fund', ...pkgs];

      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: this.runtimeDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const onData = (chunk: Buffer) => {
          for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
            const s = raw.trim();
            if (s && /(added|warn|error)/i.test(s)) this.pushLog(s.slice(0, 140));
          }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error('安装 MC 联机组件超时，请检查网络后重试。'));
        }, 180_000);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });

      if (code !== 0 || !this.isRuntimeReady()) {
        throw new Error(`自动安装 MC 联机组件失败 (exit=${code ?? 'null'})`);
      }
      this.pushLog('MC 联机组件安装完成 ✓');
      return { ok: true, alreadyInstalled: false };
    } finally {
      this.installing = false;
    }
  }

  async startMc(input: { mcPort: number; botName?: string; hubUrl: string; mcVersion?: string; apiToken?: string }) {
    if (this.isRunning()) {
      return { ok: true, alreadyRunning: true, pid: this.proc?.pid ?? null, port: this.activePort, botName: this.activeBotName };
    }
    const mcPort = Math.floor(Number(input.mcPort) || 0);
    if (mcPort < 1 || mcPort > 65535) {
      throw new Error('请填写有效的 1~65535 局域网端口号');
    }
    const lanOpen = await probeTcp(mcPort);
    if (!lanOpen) {
      throw new Error(`还没检测到端口 ${mcPort}，请先在 Minecraft 存档里按 Esc 点「对局域网开放」，再把游戏左下角显示的 5 位数字填进来。`);
    }

    await this.ensureRuntimeInstalled();
    const botName = sanitizeMcBotName(input.botName);
    const runner = path.join(REPO_ROOT, 'adapters', 'minecraft-mindcraft', 'mc-companion-runner.mjs');

    const proc = spawn(process.execPath, [runner], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MC_RUNTIME_DIR: this.runtimeDir,
        SOUL_HUB_URL: input.hubUrl,
        MC_HOST: '127.0.0.1',
        MC_PORT: String(mcPort),
        MC_BOT_NAME: botName,
        ...(input.mcVersion ? { MC_VERSION: input.mcVersion } : {}),
        ...(input.apiToken ? { SOUL_API_TOKEN: input.apiToken } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.activePort = mcPort;
    this.activeBotName = botName;
    this.pushLog(`正在召唤「${botName}」进入 127.0.0.1:${mcPort} (PID ${proc.pid ?? '?'})`);

    const onOut = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        if (/^(PartialReadError|at (new |Object\.|eval )|deprecated event \(physicTick\)|Mineflayer detected that you)/i.test(s)) continue;
        this.pushLog(s);
      }
    };
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onOut);
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.activePort = null;
      }
      this.pushLog(`MC 伴侣进程已结束 (exit=${code ?? 'null'})`);
    });
    proc.on('error', (err) => {
      if (this.proc === proc) {
        this.proc = null;
        this.activePort = null;
      }
      this.pushLog(`MC 伴侣启动失败: ${err.message}`);
    });

    return { ok: true, pid: proc.pid ?? null, port: mcPort, botName };
  }

  stopMc() {
    if (!this.isRunning() || !this.proc) {
      this.proc = null;
      this.activePort = null;
      return { ok: true, stopped: false };
    }
    try { this.proc.kill(); } catch {}
    this.proc = null;
    this.activePort = null;
    this.pushLog('已让她离开 Minecraft 世界');
    return { ok: true, stopped: true };
  }
}
