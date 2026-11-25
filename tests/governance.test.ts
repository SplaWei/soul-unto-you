import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getOralInterviewQuestions } from '../src/resurrection/reconstructor.ts';
import { REPO_ROOT } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.name.endsWith('.local.json') || entry.name.endsWith('.token') || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test('工程门禁 1：零运行时依赖、纯净根目录与主干瘦身校验', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies, {}, 'package.json dependencies 必须保持空对象');
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const val = pkg[field];
    assert.equal(!val || Object.keys(val).length === 0, true, `package.json ${field} 必须为空或未定义`);
  }
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'node_modules')), false, '根目录严禁生成 node_modules');
  for (const lockFile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, lockFile)), false, `根目录严禁生成 ${lockFile}`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts || {}, 'check:mc'), false, 'package.json 不得保留 check:mc 脚本');
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    assert.equal(cmd.includes('adapters/minecraft-mindcraft'), false, `脚本 ${name} 不得引用已归档的 adapters/minecraft-mindcraft`);
  }
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'adapters', 'minecraft-mindcraft')), false, 'adapters/minecraft-mindcraft 必须归档移出主干');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'src', 'server', 'mc-manager.ts')), false, 'src/server/mc-manager.ts 死模块必须移除');

  for (const d of ['src', 'web', 'tests', 'scripts', 'adapters', 'examples', 'docs']) {
    for (const file of walkFiles(path.join(REPO_ROOT, d))) {
      assert.equal(/\.(py|cs)$/i.test(file), false, `活跃目录禁止残留外部语言源码桩: ${path.relative(REPO_ROOT, file)}`);
    }
  }
});

test('工程门禁 2：全仓核心源码/文档/测试单文件行数红线校验 (<=380, CURRENT_STATE <=60)', () => {
  const dirs = ['src', 'web', 'tests', 'scripts', 'docs', 'adapters'];
  const violations: string[] = [];
  for (const d of dirs) {
    for (const file of walkFiles(path.join(REPO_ROOT, d))) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
      const limit = rel === 'docs/CURRENT_STATE.md' ? 60 : 380;
      if (lines > limit) violations.push(`${rel} (${lines} > ${limit})`);
    }
  }
  assert.deepEqual(violations, [], `存在超行数红线文件: ${violations.join(', ')}`);
});

test('工程门禁 3：Node 原生可擦除 TypeScript 语法、显式 .ts 导入与死模块校验', () => {
  const importFromRe = /(?:^|\n)\s*(?:import|export)(?:\s+type)?(?:\s+\{[^}]*\}|\s+\*\s+as\s+\w+|\s+[\w$,\s*{}]+)?\s+from\s+['"](\.[^'"]+)['"]/g;
  const sideEffectImportRe = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
  const dynImportRe = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const badTsRe = /^\s*(?:export\s+)?(?:const\s+)?(?:enum|namespace)\s+/m;
  const ctorParamRe = /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+[A-Za-z_$]/;
  const errors: string[] = [];
  const importedTargets = new Set<string>();

  for (const d of ['src', 'adapters', 'scripts', 'tests']) {
    for (const file of walkFiles(path.join(REPO_ROOT, d)).filter((f) => f.endsWith('.ts'))) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      for (const re of [importFromRe, sideEffectImportRe, dynImportRe]) {
        for (const m of text.matchAll(re)) {
          const spec = m[1];
          if (!spec.endsWith('.ts')) errors.push(`${rel} 相对导入缺少 .ts 后缀: ${spec}`);
          const resolved = path.resolve(path.dirname(file), spec);
          if (!fs.existsSync(resolved)) errors.push(`${rel} 存在悬空相对导入: ${spec}`);
          else importedTargets.add(resolved);
        }
      }
      if (badTsRe.test(text)) {
        errors.push(`${rel} 包含不可擦除语法 (enum/namespace)`);
      }
      if (ctorParamRe.test(text)) {
        errors.push(`${rel} 包含不可擦除构造函数参数属性`);
      }
      try {
        stripTypeScriptTypes(text, { mode: 'strip', sourceUrl: rel });
      } catch (err) {
        errors.push(`${rel} Node 原生可擦除 TS 解析失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const cliEntries = new Set([
    path.resolve(REPO_ROOT, 'src', 'server', 'main.ts'),
    path.resolve(REPO_ROOT, 'src', 'server', 'mcp-stdio.ts'),
  ]);
  for (const file of walkFiles(path.join(REPO_ROOT, 'src')).filter((f) => f.endsWith('.ts'))) {
    const abs = path.resolve(file);
    if (!cliEntries.has(abs) && !importedTargets.has(abs)) {
      errors.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')} 为未被任何模块引用的死文件`);
    }
  }
  assert.deepEqual(errors, [], errors.join('; '));
});

test('工程门禁 4：跨模块 Phase/Version 标识与测试入口防漂移一致性校验', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version?: string; engines?: { node?: string };
  };
  const covenant = fs.readFileSync(path.join(REPO_ROOT, 'src', 'soul', 'covenant.ts'), 'utf8');
  const bodyApi = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'body-api.ts'), 'utf8');
  const mcp = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'mcp.ts'), 'utf8');
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const launcher = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'launch-workbench.ts'), 'utf8');
  const phase2Api = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'phase2-api.ts'), 'utf8');

  const covenantPhase = covenant.match(/HUB_PHASE\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const hubVersion = covenant.match(/HUB_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  assert.ok(covenantPhase, 'covenant.ts 必须导出有效的 HUB_PHASE 版本号');
  assert.equal(hubVersion, '0.6.0', 'covenant.ts HUB_VERSION 必须为 0.6.0');
  assert.equal(pkg.version, hubVersion, 'package.json version 必须与 HUB_VERSION 一致');
  assert.equal(pkg.engines?.node, '>=22.18.0', 'package.json engines.node 必须锁定 >=22.18.0');
  assert.ok(mcp.includes('HUB_VERSION'), 'mcp.ts serverInfo.version 必须复用 HUB_VERSION');
  assert.ok(changelog.includes(`## [${hubVersion}]`), 'CHANGELOG.md 必须包含当前发布版本号条目');
  assert.ok(bodyApi.includes('phase: HUB_PHASE'), 'body-api.ts /api/health 必须复用 HUB_PHASE 单一事实源');
  assert.ok(launcher.includes('EXPECTED_HUB_PHASE = HUB_PHASE'), 'launch-workbench.ts 必须复用 HUB_PHASE 单一事实源');

  assert.ok(phase2Api.includes('readdirSync'), 'phase2-api.ts runAutomatedTests 必须动态扫描 tests/*.test.ts');
  assert.equal(phase2Api.includes("'tests/archive.test.ts'"), false, 'phase2-api.ts 不得硬编码旧测试清单');
});

test('工程门禁 5：前端静态资源引用完整性、白名单、CSP 合规与 JS 语法检查', () => {
  const webRoot = path.join(REPO_ROOT, 'web');
  const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const secText = fs.readFileSync(path.join(REPO_ROOT, 'src', 'server', 'security.ts'), 'utf8');
  const whitelistBlock = secText.match(/PUBLIC_STATIC_PATHS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
  const whitelisted = new Set(Array.from(whitelistBlock.matchAll(/'([^']+)'/g), (m) => m[1]));

  assert.ok(html.includes('id="btnToggleLang"'), 'web/index.html 必须包含中英切换按钮 #btnToggleLang');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, '严格 CSP 禁止内联 <script>');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, '严格 CSP 禁止内联事件属性');

  for (const m of html.matchAll(/<(?:script|link)\s+[^>]*(?:src|href)="\/([^"]+)"/g)) {
    const asset = path.join(webRoot, m[1]);
    assert.ok(fs.existsSync(asset), `web/index.html 引用的资源缺失: /${m[1]}`);
    assert.ok(whitelisted.has(`/${m[1]}`), `security.ts PUBLIC_STATIC_PATHS 缺失静态白名单: /${m[1]}`);
  }
  for (const jsFile of walkFiles(webRoot).filter((f) => f.endsWith('.js'))) {
    const res = spawnSync(process.execPath, ['--check', jsFile], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${path.basename(jsFile)} 语法检查失败: ${res.stderr}`);
  }
});

test('Web 英文本地化静态脚本公开访问与招魂英文提示完整性', async () => {
  const qs = getOralInterviewQuestions();
  assert.ok(qs.length >= 7);
  for (const q of qs) {
    assert.ok(q.zh.trim() && q.en.trim() && (q.hintEn || '').trim(), `招魂问题 ${q.id} 缺少完整中英文文案或 hintEn`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-i18n-test-'));
  const archiveDir = path.join(tmp, 'archive');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ archiveDir, host: '127.0.0.1', port: 0 }), 'utf8');
  const hub = await createSoulHubServer({ archiveDir, configPath, port: 0 });
  try {
    for (const [asset, marker] of [['/i18n-en.js', 'SOUL_I18N_EN'], ['/i18n.js', 'SoulI18n']] as const) {
      const res = await fetch(`${hub.baseUrl}${asset}`);
      assert.equal(res.status, 200, `${asset} 应免 Token 放行返回 200`);
      const body = await res.text();
      assert.ok(body.includes(marker), `${asset} 响应体缺少 ${marker}`);
    }
  } finally {
    await hub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('工程门禁 6：核心中枢禁止硬编码特定游戏规则（Phase 5.0b 去硬编码校验）', () => {
  const coreFiles = [
    path.join('src', 'soul', 'free-will.ts'),
    path.join('src', 'soul', 'living-self.ts'),
    path.join('src', 'presence', 'inner-life.ts'),
    path.join('src', 'presence', 'heartbeat.ts'),
    path.join('src', 'memory', 'experience.ts'),
    path.join('src', 'memory', 'relations.ts'),
  ];
  const forbiddenRe = /(苦力怕|creeper|attack_mob_reckless|Minecraft 躯体实战)/i;
  for (const rel of coreFiles) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const hit = text.match(forbiddenRe);
    assert.equal(hit, null, `${rel} 发现特定游戏硬编码 (${hit?.[0]})，请移交适配器注册 rules`);
  }
});
