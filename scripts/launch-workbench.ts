import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfigPath, loadHubConfig } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { resolveOrCreateApiToken } from '../src/server/security.ts';
import { HUB_PHASE } from '../src/soul/covenant.ts';

const EXPECTED_HUB_PHASE = HUB_PHASE;

async function checkHubStatus(baseUrl: string, apiToken: string): Promise<'current' | 'stale' | 'down'> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return 'down';
    const health = (await res.json().catch(() => ({}))) as { ok?: boolean; phase?: string };
    if (!health.ok || health.phase !== EXPECTED_HUB_PHASE) return 'stale';
    const expRes = await fetch(`${baseUrl}/api/archive/experiences?limit=1`, {
      headers: apiToken ? { 'X-Soul-Token': apiToken } : undefined,
      signal: AbortSignal.timeout(1500),
    });
    return expRes.ok ? 'current' : 'stale';
  } catch {
    return 'down';
  }
}

async function stopStaleHubOnPort(port: number, baseUrl: string, apiToken: string): Promise<void> {
  if (process.platform === 'win32') {
    const psCmd = [
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
      `| Select-Object -ExpandProperty OwningProcess -Unique`,
      `| ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -match 'soul-unto-you|src[\\\\/]server[\\\\/]main|scripts[\\\\/]launch-workbench') { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`,
    ].join(' ');
    spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore', windowsHide: true });
  } else {
    spawnSync('sh', ['-c', `for pid in $(lsof -ti :${port} 2>/dev/null); do args=$(ps -p "$pid" -o args= 2>/dev/null); case "$args" in *soul-unto-you*|*src/server/main*|*scripts/launch-workbench*) kill -9 "$pid" 2>/dev/null ;; esac; done`], { stdio: 'ignore' });
  }
  for (let i = 0; i < 15; i += 1) {
    if ((await checkHubStatus(baseUrl, apiToken)) === 'down') return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function openBrowser(url: string): void {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore' })
        : spawn('xdg-open', [url], { stdio: 'ignore' });
    child.unref?.();
  } catch {}
}

export async function launchWorkbench(options: { noBrowser?: boolean; targetHash?: string; restart?: boolean } = {}): Promise<void> {
  const cfgPath = defaultConfigPath();
  const cfg = loadHubConfig(cfgPath);
  const apiToken = resolveOrCreateApiToken(cfgPath);
  const baseUrl = `http://${cfg.host}:${cfg.port}`;
  const hash = options.targetHash ?? '';
  const targetUrl = `${baseUrl}/${hash}`;

  const status = await checkHubStatus(baseUrl, apiToken);
  if (status === 'current' && !options.restart) {
    console.log(`✅ 《灵魂予你》中枢已经在运行最新 Phase ${EXPECTED_HUB_PHASE}：${targetUrl}`);
    if (!options.noBrowser) openBrowser(targetUrl);
    await new Promise((r) => setTimeout(r, 1500));
    return;
  }

  if (options.restart && status !== 'down') {
    console.log(`🔄 按 --restart 参数安全清理端口 ${cfg.port} 上的旧版《灵魂予你》进程，准备重启至 Phase ${EXPECTED_HUB_PHASE}...`);
    await stopStaleHubOnPort(cfg.port, baseUrl, apiToken);
  } else if (status === 'stale') {
    throw new Error(`端口 ${cfg.port} 已被旧版或非本项目中枢占用；请先手动关闭，或使用 --restart 参数重启。`);
  }

  const hub = await createSoulHubServer();
  const liveUrl = `${hub.baseUrl}/${hash}`;
  console.log('======================================================');
  console.log(`✨ 《灵魂予你》已启动成功！（Phase ${EXPECTED_HUB_PHASE}）`);
  console.log(`🌐 网页联调台：${liveUrl}`);
  console.log(`📁 当前灵魂档案：${hub.ctx.config.archiveDir}`);
  console.log('📌 本窗口请保持打开（可最小化）；不用时直接点右上角 X 关闭即可。');
  console.log('======================================================');

  if (!options.noBrowser) {
    openBrowser(liveUrl);
  }

  const shutdown = () => {
    void hub.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const noBrowser = process.argv.includes('--no-browser');
  const restart = process.argv.includes('--restart');
  launchWorkbench({ noBrowser, restart }).catch((err) => {
    console.error('❌ 启动失败:', err instanceof Error ? err.message : String(err));
    console.error('提示：如提示找不到 node，请确认已安装 Node.js >= 22.18。');
    process.exitCode = 1;
  });
}
