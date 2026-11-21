import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkEmbeddingHealth, cosineSimilarity, fetchEmbeddings, type EmbeddingConfig } from '../src/memory/search.ts';
import { defaultConfigPath, loadHubConfig, REPO_ROOT } from '../src/server/config.ts';

interface StageSpec {
  name: string;
  files: string[];
}

interface StageReport {
  name: string;
  files: string[];
  ok: boolean;
  passed: number;
  failed: number;
  durationMs: number;
}

interface LiveProbeReport {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

function parseCliArgs(argv: string[]) {
  const quick = argv.includes('--quick');
  const live = argv.includes('--live');
  const json = argv.includes('--json');
  const featureArg = argv.find((a) => a.startsWith('--feature='))?.slice('--feature='.length).trim().toLowerCase() || '';
  const repeatRaw = Number(argv.find((a) => a.startsWith('--repeat='))?.slice('--repeat='.length) || 1);
  const repeat = Number.isFinite(repeatRaw) && repeatRaw >= 1 ? Math.min(20, Math.floor(repeatRaw)) : 1;
  return { quick, live, json, featureArg, repeat };
}

function buildStages(quick: boolean, featureKw: string): StageSpec[] {
  const testsDir = path.join(REPO_ROOT, 'tests');
  const all = fs.readdirSync(testsDir).filter((n) => n.endsWith('.test.ts')).sort();
  const toRel = (names: string[]) => names.filter((n) => all.includes(n)).map((n) => `tests/${n}`);

  if (quick) {
    return [
      { name: 'Stage 1 · 合规与静态门禁', files: toRel(['governance.test.ts']) },
      { name: 'Stage 2 · 核心交叉验证', files: toRel(['cross-verify.test.ts']) },
    ].filter((s) => s.files.length > 0);
  }

  if (featureKw) {
    const matched = all.filter((n) => n.toLowerCase().includes(featureKw) && n !== 'governance.test.ts' && n !== 'cross-verify.test.ts');
    if (!matched.length && !all.some((n) => n.toLowerCase().includes(featureKw))) {
      throw new Error(`未找到匹配关键字 "${featureKw}" 的测试文件（可选: ${all.join(', ')}）`);
    }
    return [
      { name: 'Stage 1 · 合规与静态门禁', files: toRel(['governance.test.ts']) },
      { name: `Stage 2 · 特性功能套件 (${featureKw})`, files: toRel(matched) },
      { name: 'Stage 3 · 自动关联交叉验证', files: toRel(['cross-verify.test.ts']) },
    ].filter((s) => s.files.length > 0);
  }

  const coreUnit = all.filter((n) => !['governance.test.ts', 'server-ports.test.ts', 'cross-verify.test.ts'].includes(n));
  return [
    { name: 'Stage 1 · 合规与静态门禁', files: toRel(['governance.test.ts']) },
    { name: 'Stage 2 · 核心单元与分阶段功能套件', files: toRel(coreUnit) },
    { name: 'Stage 3 · 多端协议与交叉验证套件', files: toRel(['server-ports.test.ts', 'cross-verify.test.ts']) },
  ].filter((s) => s.files.length > 0);
}

function runStage(stage: StageSpec, jsonMode: boolean): StageReport {
  const startedAt = Date.now();
  if (!jsonMode) console.log(`\n▶ ${stage.name} (${stage.files.length} 个文件)...`);
  const res = spawnSync(process.execPath, ['--test', ...stage.files], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (!jsonMode && out.trim()) console.log(out.trimEnd());
  const passMatch = out.match(/ℹ\s+pass\s+(\d+)/);
  const failMatch = out.match(/ℹ\s+fail\s+(\d+)/);
  const passed = passMatch ? Number(passMatch[1]) : out.split(/\r?\n/).filter((l) => l.trim().startsWith('✔')).length;
  const failed = failMatch ? Number(failMatch[1]) : out.split(/\r?\n/).filter((l) => l.trim().startsWith('✖')).length;
  return {
    name: stage.name,
    files: stage.files,
    ok: res.status === 0,
    passed,
    failed: res.status === 0 ? failed : Math.max(1, failed),
    durationMs: Date.now() - startedAt,
  };
}

function probeTcp(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
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

async function runLiveProbes(): Promise<LiveProbeReport[]> {
  const reports: LiveProbeReport[] = [];
  const cfg = loadHubConfig(defaultConfigPath());
  const embCfg: EmbeddingConfig = {
    enabled: true,
    endpoint: cfg.embedding.endpoint || 'http://127.0.0.1:11434/v1',
    model: cfg.embedding.model || 'qwen3-embedding:0.6b',
    apiKey: cfg.embedding.apiKey,
    timeoutMs: 15000,
  };

  const health = await checkEmbeddingHealth(embCfg);
  if (!health.ok) {
    reports.push({ name: 'Ollama 语义向量实测', status: 'SKIP', detail: `未连通 ${embCfg.endpoint}（服务未启动，安全跳过）` });
  } else {
    const vecs = await fetchEmbeddings(['花生过敏不能吃坚果', '今晚外卖不要放坚果类食材', '?'], embCfg);
    if (!vecs || vecs.length !== 3) {
      reports.push({ name: 'Ollama 语义向量实测', status: 'FAIL', detail: '向量服务返回条数异常' });
    } else {
      const simRel = cosineSimilarity(vecs[0], vecs[1]);
      const simNoise = cosineSimilarity(vecs[0], vecs[2]);
      const ok = simRel > simNoise;
      reports.push({
        name: 'Ollama 语义向量实测',
        status: ok ? 'PASS' : 'FAIL',
        detail: `${embCfg.model} · 相关语义=${simRel.toFixed(3)} vs 废话=${simNoise.toFixed(3)}`,
      });
    }
  }

  try {
    const hubRes = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (hubRes.ok) {
      const data = (await hubRes.json()) as { ok?: boolean; phase?: string };
      reports.push({ name: '本机工作台健康探测', status: data.ok ? 'PASS' : 'FAIL', detail: `http://${cfg.host}:${cfg.port} (phase=${data.phase || '?'})` });
    } else {
      reports.push({ name: '本机工作台健康探测', status: 'FAIL', detail: `HTTP ${hubRes.status}` });
    }
  } catch {
    reports.push({ name: '本机工作台健康探测', status: 'SKIP', detail: `${cfg.host}:${cfg.port} 未运行（安全跳过）` });
  }

  const [gsvOpen, onebotOpen] = await Promise.all([probeTcp(8765), probeTcp(3001)]);
  reports.push({ name: 'GPT-SoVITS 声带端口 (:8765)', status: gsvOpen ? 'PASS' : 'SKIP', detail: gsvOpen ? '端口可达' : '未启动（安全跳过）' });
  reports.push({ name: 'OneBot QQ 协议端口 (:3001)', status: onebotOpen ? 'PASS' : 'SKIP', detail: onebotOpen ? '端口可达' : '未启动（安全跳过）' });
  return reports;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const stages = buildStages(args.quick, args.featureArg);
  const rounds: StageReport[][] = [];
  let passedRounds = 0;

  for (let r = 1; r <= args.repeat; r += 1) {
    if (!args.json && args.repeat > 1) console.log(`\n================ 第 ${r}/${args.repeat} 轮稳定性测试 ================`);
    const roundReports: StageReport[] = [];
    let roundOk = true;
    for (const stage of stages) {
      const rep = runStage(stage, args.json);
      roundReports.push(rep);
      if (!rep.ok) {
        roundOk = false;
        break;
      }
    }
    rounds.push(roundReports);
    if (roundOk) passedRounds += 1;
    else break;
  }

  const allDeterministicOk = passedRounds === args.repeat;
  const liveReports = args.live && allDeterministicOk ? await runLiveProbes() : [];
  const liveFailed = liveReports.some((p) => p.status === 'FAIL');
  const finalOk = allDeterministicOk && !liveFailed;

  if (args.json) {
    console.log(JSON.stringify({ ok: finalOk, repeat: args.repeat, passedRounds, rounds, liveProbes: liveReports }, null, 2));
  } else {
    console.log('\n==================== 全局测试总览 ====================');
    const lastRound = rounds[rounds.length - 1] || [];
    for (const s of lastRound) {
      console.log(`${s.ok ? '✅ PASS' : '❌ FAIL'} | ${s.name} | 通过 ${s.passed} / 失败 ${s.failed} | ${s.durationMs} ms`);
    }
    if (args.repeat > 1) {
      console.log(`🔁 稳定性复跑：${passedRounds}/${args.repeat} 轮全绿`);
    }
    if (liveReports.length) {
      console.log('--- 实机环境只读探测 (--live) ---');
      for (const lp of liveReports) {
        const icon = lp.status === 'PASS' ? '✅ PASS' : lp.status === 'SKIP' ? '⏭️ SKIP' : '❌ FAIL';
        console.log(`${icon} | ${lp.name} | ${lp.detail}`);
      }
    }
    console.log('======================================================');
  }
  if (!finalOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试脚本执行失败:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
