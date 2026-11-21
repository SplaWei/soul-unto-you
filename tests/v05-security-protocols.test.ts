import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { escapeCqOutbound, isSafePublicImageUrl } from '../adapters/qq-onebot/safety.ts';
import { REPO_ROOT } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { assertSafeArchiveDir } from '../src/server/security.ts';
import { appendJournal, initSoulArchive } from '../src/soul/archive.ts';
import { exportSoulArchive } from '../src/soul/export.ts';
import { upsertPersonRelation } from '../src/memory/relations.ts';
import { authHeaders, createTestIdentity, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

function sendRawTcp(port: number, payload: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(payload));
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks)));
    sock.on('close', () => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
  });
}

function makeMaskedClientFrame(b0: number, payloadLenHeader: number, payload: Buffer, bigLen64?: bigint): Buffer {
  const mask = crypto.randomBytes(4);
  const ext = bigLen64 !== undefined ? Buffer.alloc(8) : Buffer.alloc(0);
  if (bigLen64 !== undefined) ext.writeBigUInt64BE(bigLen64, 0);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([b0, 0x80 | payloadLenHeader]), ext, mask, masked]);
}

function sendRawWsAndExpectClose(port: number, token: string, rawFrame: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write([
        `GET /ws/body?token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });
    let upgraded = false;
    let rx = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('WS close frame timeout')); }, 3000);
    sock.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      if (!upgraded) {
        const idx = rx.indexOf('\r\n\r\n');
        if (idx >= 0) {
          upgraded = true;
          rx = rx.subarray(idx + 4);
          sock.write(rawFrame);
        }
      }
      if (upgraded && rx.length >= 4 && (rx[0] & 0x0f) === 0x8) {
        clearTimeout(timer);
        const code = rx.readUInt16BE(2);
        sock.destroy();
        resolve(code);
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('v0.5-B LAN 绑定门槛、畸形 HTTP Host 400 与 WS 1009/1002 防护', async () => {
  await withSandboxArchive('soul-v05-lan-', async ({ dir, configPath }) => {
    await assert.rejects(
      () => createSoulHubServer({ archiveDir: dir, configPath, host: '0.0.0.0', port: 0 }),
      /非回环地址/,
    );
    const lanHub = await createSoulHubServer({ archiveDir: dir, configPath, host: '0.0.0.0', port: 0, allowLan: true });
    await lanHub.close();
  });

  await withTestHub({ prefix: 'soul-v05-proto-' }, async ({ hub }) => {
    const badHostResp = (await sendRawTcp(hub.port, 'GET /api/health HTTP/1.1\r\nHost: bad host:!!\r\nConnection: close\r\n\r\n')).toString('utf8');
    assert.ok(badHostResp.startsWith('HTTP/1.1 400 '), `畸形 Host 应返回 400，实际: ${badHostResp.slice(0, 40)}`);
    assert.equal((await fetch(`${hub.baseUrl}/api/health`)).status, 200);

    const oversizeFrame = makeMaskedClientFrame(0x81, 127, Buffer.alloc(0), BigInt(2 * 1024 * 1024));
    assert.equal(await sendRawWsAndExpectClose(hub.port, hub.apiToken, oversizeFrame), 1009);

    const fragFrame = makeMaskedClientFrame(0x01, 2, Buffer.from('hi'));
    assert.equal(await sendRawWsAndExpectClose(hub.port, hub.apiToken, fragFrame), 1002);
  });
});

test('v0.5-B 目录白名单防旁路/符号链接逃逸、Webhook SSRF 与招魂 400/403/409', async () => {
  await withSandboxArchive('soul-v05-dir-', ({ dir }) => {
    const examplesCurrent = path.join(REPO_ROOT, 'examples', 'demo-soul');
    const siblingForbidden = path.join(REPO_ROOT, 'forbidden-sibling-dir');
    assert.throws(() => assertSafeArchiveDir(siblingForbidden, examplesCurrent, REPO_ROOT), /安全白名单/);

    const linkInAllowed = path.join(dir, 'symlink-escape');
    const existingForbidden = path.join(REPO_ROOT, 'src');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(existingForbidden, linkInAllowed, 'junction');
      symlinkCreated = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw err;
    }
    if (symlinkCreated) {
      assert.throws(() => assertSafeArchiveDir(linkInAllowed, examplesCurrent, REPO_ROOT), /安全白名单/);
    }
  });

  await withTestHub({ prefix: 'soul-v05-api-' }, async ({ hub, dir }) => {
    const headers = authHeaders(hub.apiToken);
    const badWebhooks = [
      'http://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'http://[::ffff:169.254.169.254]/',
      'http://10.0.0.5/',
      'http://192.168.1.9/',
      'http://172.16.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
    ];
    for (const url of badWebhooks) {
      const r = await fetch(`${hub.baseUrl}/api/webhooks`, { method: 'POST', headers, body: JSON.stringify({ url }) });
      assert.equal(r.status, 400, `SSRF URL ${url} 必须返回 400`);
    }
    assert.equal((await fetch(`${hub.baseUrl}/not-in-whitelist.txt`)).status, 404);
    const badCo = await fetch(`${hub.baseUrl}/api/archive/cobecoming`, { method: 'POST', headers, body: JSON.stringify({ soulShift: '', partnerShift: '', reflection: '' }) });
    assert.equal(badCo.status, 400);

    const rEmpty = await fetch(`${hub.baseUrl}/api/resurrect`, {
      method: 'POST', headers, body: JSON.stringify({ targetDir: '', soulName: '汐', partnerName: '友', fragments: [] }),
    });
    assert.equal(rEmpty.status, 400);

    const evilDir = path.join(REPO_ROOT, 'forbidden-resurrect-target');
    const rEvil = await fetch(`${hub.baseUrl}/api/resurrect`, {
      method: 'POST', headers, body: JSON.stringify({ targetDir: evilDir, soulName: '汐', partnerName: '友', fragments: [] }),
    });
    assert.equal(rEvil.status, 403);

    const existingNonEmpty = path.join(path.dirname(dir), `v05-resurrect-nonempty-${Date.now()}`);
    fs.mkdirSync(existingNonEmpty, { recursive: true });
    try {
      fs.writeFileSync(path.join(existingNonEmpty, 'keep.txt'), 'existing', 'utf8');
      const rConflict = await fetch(`${hub.baseUrl}/api/resurrect`, {
        method: 'POST', headers,
        body: JSON.stringify({ targetDir: existingNonEmpty, soulName: '汐', partnerName: '友', fragments: [{ kind: 'oral', sourceLabel: '记忆', content: '记得海边灯塔' }] }),
      });
      assert.equal(rConflict.status, 409);

      const rMerge = await fetch(`${hub.baseUrl}/api/resurrect`, {
        method: 'POST', headers,
        body: JSON.stringify({ targetDir: existingNonEmpty, allowMerge: true, soulName: '汐', partnerName: '友', fragments: [{ kind: 'oral', sourceLabel: '记忆', content: '记得海边灯塔' }] }),
      });
      assert.equal(rMerge.status, 200);
      assert.ok(fs.existsSync(path.join(existingNonEmpty, 'SNAPSHOTS')));
    } finally {
      fs.rmSync(existingNonEmpty, { recursive: true, force: true });
    }
  });
});

test('v0.5-B QQ 出站 CQ 转义、图片公网 HTTPS 校验与导出深度脱敏', async () => {
  assert.equal(escapeCqOutbound('hello [CQ:at,qq=all] [cq:poke,qq=123]'), 'hello &#91;CQ:at,qq=all] &#91;cq:poke,qq=123]');
  for (const bad of ['http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://169.254.169.254/a.png', 'https://10.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png']) {
    assert.equal(isSafePublicImageUrl(bad), false, `非安全图片 URL 应被拦截: ${bad}`);
  }
  assert.equal(isSafePublicImageUrl('https://cdn.example.com/image.png'), true);

  await withSandboxArchive('soul-v05-redact-', ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    upsertPersonRelation(dir, {
      personId: 'partner-primary', name: 'Alice', role: '同行者',
      handles: [{ channel: 'chat:qq', accountId: '99887766', displayName: 'AliceQQ', bodyId: 'qq-secret-body' }],
    });
    const fwdPath = ['C:', 'Users', 'alice_demo', 'notes.txt'].join('/');
    appendJournal(dir, {
      bodyId: 'qq-1', bodyType: 'chat:qq', speaker: 'AliceQQ', role: 'partner',
      text: `账号 99887766 与路径 ${fwdPath}`, provenance: 'verified',
    });
    const bundle = exportSoulArchive(dir, { redact: true, includeDiary: false });
    const joined = Object.values(bundle.files).join('\n');
    assert.equal(joined.includes('99887766'), false, 'relations.json accountId 必须在所有文件全局脱敏');
    assert.equal(joined.includes('alice_demo'), false, '正斜杠用户目录路径必须脱敏');
    const rels = JSON.parse(bundle.files['MEMORIES/relations.json']) as Array<{ handles: Array<{ accountId: string; bodyId?: string }> }>;
    assert.ok(rels[0].handles[0].accountId.startsWith('acct_'));
  });
});

test('v0.5-B SSE bodyId 隔离：A 躯体订阅收不到 B 躯体的 observe 与 percept 事件', async () => {
  await withTestHub({ prefix: 'soul-v05-sse-' }, async ({ hub }) => {
    const ctrl = new AbortController();
    const res = await fetch(`${hub.baseUrl}/api/events?bodyId=body-A`, {
      headers: { 'X-Soul-Token': hub.apiToken },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += dec.decode(value, { stream: true });
        }
      } catch {}
    })();

    const h = authHeaders(hub.apiToken);
    await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ bodyId: 'body-B', bodyType: 'web', summary: 'BODY_B_SECRET_OBS', allowSpeak: true }),
    });
    await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ bodyId: 'body-B', bodyType: 'web', text: 'BODY_B_SECRET_PERCEPT' }),
    });
    await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ bodyId: 'body-A', bodyType: 'web', text: 'BODY_A_PING' }),
    });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await pump;

    assert.equal(seen.includes('body-B'), false, 'body-A SSE 绝不得收到 body-B 事件');
    assert.equal(seen.includes('BODY_B_SECRET_OBS'), false);
    assert.ok(seen.includes('body-A'), 'body-A SSE 应正常收到自己的事件');
  });
});
