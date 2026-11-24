import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { buildRecallContext, recallMemories } from '../src/memory/search.ts';
import { listBeliefs, listSelfEvolution } from '../src/soul/living-self.ts';
import { runSoulHeartbeat } from '../src/presence/heartbeat.ts';
import { listDesires } from '../src/presence/inner-life.ts';
import { initSoulArchive, loadSoulArchive } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { authHeaders, createTestIdentity, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

function rawHttpRequest(port: number, reqPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('5.0-A 心搏防骚扰 24 小时加速验证 & 真实时钟/互动间隔感知注入', async () => {
  await withSandboxArchive('soul-p5-hb-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    awakenSoul(dir, { bodyId: 'web-main', bodyType: 'web' });

    const startMs = new Date('2026-11-21T00:00:00').getTime();
    let reachOutCount = 0;
    const reachOutHours: number[] = [];
    const postReachCloseness: number[] = [];

    for (let step = 0; step < 48; step += 1) {
      const nowMs = startMs + step * 30 * 60_000;
      const hr = new Date(nowMs).getHours();
      const res = await runSoulHeartbeat(dir, {
        nowMs,
        isSilentIdle: true,
        reachOutFn: async () => ({ reply: `想你了（第${step}步）` }),
      });
      if (res.action === 'reach_out') {
        reachOutCount += 1;
        reachOutHours.push(hr);
        postReachCloseness.push(res.drives.closeness);
      }
    }

    assert.ok(reachOutCount >= 1 && reachOutCount <= 3, `24h 主动搭话必须在 [1, 3] 范围内，实际为 ${reachOutCount}`);
    for (const hr of reachOutHours) {
      assert.ok(hr >= 7 && hr < 23, `夜间作息静音时段 (23:00-07:00) 禁止主动搭话，误触发小时=${hr}`);
    }
    for (const c of postReachCloseness) {
      assert.ok(c <= 0.55, `主动搭话后 closeness 必须回落以避免连环刷屏，实际=${c}`);
    }

    const archive = loadSoulArchive(dir, 10);
    assert.ok(archive.diary.some((d) => d.actionTaken === 'reach_out'));

    const recall = await buildRecallContext({
      archiveDir: dir,
      query: '现在几点了，我们上次是什么时候聊天的',
      bodyId: 'web-main',
      bodyType: 'web',
      nowMs: new Date('2026-11-21T15:30:00').getTime(),
    });
    assert.ok(recall.systemPrompt.includes('- 当前现实时间：2026-11-21 周六 15:30'), 'Prompt 必须注入完整现实日期与星期');
    assert.ok(recall.systemPrompt.includes('- 距上次互动：'), 'Prompt 必须注入距上次互动间隔');

    const recalledList = await recallMemories(dir, '今天在忙什么', { topK: 3, reinforce: false });
    assert.ok(Array.isArray(recalledList));
  });
});

test('5.0-B 本地 Hub 安全防线：Token 鉴权、Host/Origin 校验、Content-Type 与目录白名单', async () => {
  await withTestHub({ prefix: 'soul-p5-sec-' }, async ({ hub }) => {
    const hAuth = authHeaders(hub.apiToken);

    // 1. 公开静态页（含动态注入的 meta token）与 /api/health 脱敏响应
    const healthRes = await fetch(`${hub.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal('apiToken' in healthJson, false, '/api/health 绝不可泄漏 apiToken');

    const htmlRes = await fetch(`${hub.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.equal(html.includes('<meta name="soul-api-token"'), false, 'index.html 绝不可再注入明文 meta token');
    assert.equal(html.includes(hub.apiToken), false, 'index.html HTML 正文不得包含原始 apiToken');
    const csp = htmlRes.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("script-src 'self'"), '静态首页必须启用严格 CSP');
    const setCookie = htmlRes.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('soul_session=') && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), '回环首页必须下发 HttpOnly SameSite=Strict 会话 Cookie');
    const cookiePair = setCookie.split(';')[0];
    const cookieAuthRes = await fetch(`${hub.baseUrl}/api/config`, { headers: { Cookie: cookiePair } });
    assert.equal(cookieAuthRes.status, 200, '合法 HttpOnly 会话 Cookie 必须可鉴权 /api/config');

    for (const asset of ['/style.css', '/theme.css', '/cosmos.js', '/favicon.svg']) {
      const assetRes = await fetch(`${hub.baseUrl}${asset}`);
      assert.equal(assetRes.status, 200, `静态资源 ${asset} 必须可正常加载`);
      assert.equal(assetRes.headers.get('x-content-type-options'), 'nosniff');
    }

    // 2. 无 Token 或错误 Token 访问受保护端点 -> 401
    for (const ep of [
      { method: 'GET', path: '/api/config' },
      { method: 'POST', path: '/api/body/percept', body: '{"bodyId":"x","bodyType":"web","text":"hi"}' },
      { method: 'POST', path: '/api/phase2/run-tests', body: '{}' },
    ]) {
      const noTok = await fetch(`${hub.baseUrl}${ep.path}`, {
        method: ep.method,
        ...(ep.body ? { headers: { 'Content-Type': 'application/json' }, body: ep.body } : {}),
      });
      assert.equal(noTok.status, 401, `${ep.method} ${ep.path} 缺令牌应返回 401`);
    }

    // 3. 合法 Token 但携带跨站 Origin / Sec-Fetch-Site / 恶意 Host -> 403
    const evilOrigin = await fetch(`${hub.baseUrl}/api/config`, {
      headers: { 'X-Soul-Token': hub.apiToken, Origin: 'https://evil.example' },
    });
    assert.equal(evilOrigin.status, 403);

    const crossSite = await fetch(`${hub.baseUrl}/api/config`, {
      headers: { 'X-Soul-Token': hub.apiToken, 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);

    const evilHost = await rawHttpRequest(hub.port, '/api/health', { Host: 'evil.example:7777' });
    assert.equal(evilHost.status, 403, '恶意 Host 请求头必须被 403 拦截');

    // 4. 写操作非 application/json -> 415
    const badCtype = await fetch(`${hub.baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'X-Soul-Token': hub.apiToken, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(badCtype.status, 415);

    // 5. 开启招魂开关后验证越权切换档案目录 -> 403 安全白名单拦截
    await fetch(`${hub.baseUrl}/api/config`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ experimental: { enableResurrection: true } }),
    });
    const evilDir = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil-soul' : '/etc/evil-soul';
    const dirRes = await fetch(`${hub.baseUrl}/api/resurrect`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ targetDir: evilDir }),
    });
    assert.equal(dirRes.status, 403);

    // 6. WebSocket 缺令牌被拒绝，带合法令牌正常收到 welcome
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/body`);
      const timer = setTimeout(() => { badWs.close(); resolve(); }, 1500);
      badWs.addEventListener('error', () => { clearTimeout(timer); resolve(); });
      badWs.addEventListener('close', () => { clearTimeout(timer); resolve(); });
      badWs.addEventListener('open', () => {
        clearTimeout(timer);
        badWs.close();
        assert.fail('未携带 Token 的 WebSocket 连接不应成功打开');
      });
    });

    const welcomeMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const okWs = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/body?token=${encodeURIComponent(hub.apiToken)}`);
      const timer = setTimeout(() => { okWs.close(); reject(new Error('认证 WS 超时')); }, 3000);
      okWs.addEventListener('open', () => {
        okWs.send(JSON.stringify({ type: 'register', bodyId: 'sec-ws', bodyType: 'api' }));
      });
      okWs.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.type === 'welcome') {
          clearTimeout(timer);
          okWs.close();
          resolve(msg);
        }
      });
      okWs.addEventListener('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.equal(welcomeMsg.type, 'welcome');
  });
});

test('5.0b 去硬编码：通用躯体自声明规则隔离与非游戏厨艺机器人从痛暖实践演化闭环', async () => {
  await withTestHub({ prefix: 'soul-p5-dehard-', experimental: { enableFreeWill: true, enableInnerLife: true } }, async ({ hub, dir }) => {
    const hAuth = authHeaders(hub.apiToken);
    const kitchenRule = '触碰高温器皿前必须先检测表面温度并戴隔热手套';

    // 1. chat:qq 场景的 Prompt 不得泄漏任何游戏专有规则或特定怪物名
    const qqRecall = await buildRecallContext({ archiveDir: dir, query: '今晚吃什么呀', bodyId: 'qq-1', bodyType: 'chat:qq' });
    assert.equal(/(Minecraft|苦力怕|creeper|attack_mob_reckless)/i.test(qqRecall.systemPrompt), false, 'QQ Prompt 不得含游戏规则');
    assert.equal(qqRecall.systemPrompt.includes(kitchenRule), false, '未注册厨房机器人的规则不得泄漏给 QQ');

    // 2. 注册全新非游戏躯体 robot:kitchen，自带声明式 rules 与通用动作能力
    const regRes = await fetch(`${hub.baseUrl}/api/body/register`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'kitchen-bot',
        bodyType: 'robot:kitchen',
        displayName: '厨房帮手机器人',
        rules: [kitchenRule],
        actions: [
          { name: 'touch_hot_pot_direct', description: '无防护直接空手去端高温砂锅' },
          { name: 'find_protective_gloves', description: '先找隔热手套做好防护 (protect)' },
          { name: 'armed_lift_with_gloves', description: '持防烫手套安全端起器皿 (armed)' },
        ],
      }),
    });
    assert.equal(regRes.status, 200);

    const kitchenRecall = await buildRecallContext({
      archiveDir: dir,
      query: '帮我端一下汤锅',
      bodyId: 'kitchen-bot',
      bodyType: 'robot:kitchen',
      bodyRegistration: {
        bodyId: 'kitchen-bot', bodyType: 'robot:kitchen', displayName: '厨房帮手机器人',
        rules: [kitchenRule], senses: [], actions: [], transport: 'http', registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      },
    });
    assert.ok(kitchenRecall.systemPrompt.includes(kitchenRule), '厨房机器人自身的 Prompt 必须注入其自声明守则');
    assert.equal(kitchenRecall.systemPrompt.includes('苦力怕'), false);

    // 3. 验证烫伤痛感体验 -> 拒绝空手端锅 -> 通用防护微心愿 -> 戴手套成功后扬弃升级
    await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'kitchen-bot',
        bodyType: 'robot:kitchen',
        summary: '空手直接触碰高温砂锅被烫伤手掌，剧痛无比',
        allowSpeak: false,
        urgency: 'high',
        metadata: {
          realityFeedback: {
            origin: 'lived',
            stimulus: '空手端滚烫砂锅',
            chosenAction: '无防护直接去端高温砂锅',
            realityOutcome: '手掌被高温烫伤剧痛',
            valence: -0.9,
            arousal: 0.9,
            lesson: '必须先戴隔热手套做好防护再端高温砂锅',
          },
        },
      }),
    });
    assert.ok(listDesires(dir).some((d) => d.status === 'active' && d.title.includes('防护准备')));

    const askRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'kitchen-bot',
        bodyType: 'robot:kitchen',
        text: '快空手直接把那个滚烫砂锅端起来！',
        modalities: [{ kind: 'telemetry', label: 'kitchen-sensors', data: { equippedGear: 'none', hasProtection: false } }],
      }),
    });
    const askJson = (await askRes.json()) as { freeWill?: { stance: string }; actions: Array<{ name: string }> };
    assert.ok(['negotiate_condition', 'firm_refuse'].includes(askJson.freeWill?.stance || ''));
    assert.equal(askJson.actions[0]?.name, 'find_protective_gloves');

    await fetch(`${hub.baseUrl}/api/archive/experience`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'kitchen-bot',
        bodyType: 'robot:kitchen',
        origin: 'lived',
        stimulus: '戴好隔热手套安全端起滚烫砂锅',
        chosenAction: '先戴隔热手套再测温端锅',
        realityOutcome: '双手毫无烫伤并顺利上菜',
        valence: 0.92,
        lesson: '戴好隔热手套配合测温即可安全端起高温砂锅',
      }),
    });
    assert.ok(listDesires(dir).some((d) => d.title.includes('防护准备') && d.status === 'fulfilled'));
    assert.ok(listDesires(dir).some((d) => d.status === 'active' && d.title.includes('探索实践')));
    const beliefs = listBeliefs(dir);
    assert.ok(beliefs.some((b) => Boolean(b.supersededAtSeq) && b.topic === '实战破局信心'));
    assert.ok(beliefs.some((b) => !b.supersededAtSeq && b.topic === '实战破局信心' && b.statement.includes('隔热手套')));
    assert.ok(listSelfEvolution(dir).length >= 2);
  });
});
