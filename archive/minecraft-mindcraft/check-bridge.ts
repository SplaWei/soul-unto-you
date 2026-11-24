import net from 'node:net';

function parseArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function probeTcp(host: string, port: number, timeoutMs = 800): Promise<boolean> {
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

async function main(): Promise<void> {
  const hubBase = parseArg('--hub', 'http://127.0.0.1:7777').replace(/\/+$/, '');
  const mcHost = parseArg('--mc-host', '127.0.0.1');
  const mcPort = Number(parseArg('--mc-port', '55916')) || 55916;
  const runSmoke = process.argv.includes('--smoke');

  let hubOk = false;
  let modelsOk = false;
  let soulName = '';
  let autoDreamEnabled = false;

  try {
    const res = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(3000) });
    const data = (await res.json()) as { ok?: boolean; soulName?: string; autoDream?: { enabled?: boolean } };
    hubOk = Boolean(res.ok && data.ok);
    soulName = String(data.soulName ?? '');
    autoDreamEnabled = Boolean(data.autoDream?.enabled);
  } catch {}

  try {
    const res = await fetch(`${hubBase}/v1/bodies/game:minecraft/mindcraft-bot/models`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    modelsOk = Boolean(res.ok && Array.isArray(data.data) && data.data.some((m) => m.id === 'soul-unto-you'));
  } catch {}

  const mcLanOpen = await probeTcp(mcHost, mcPort);

  let smokeResult: { ok: boolean; replyPreview?: string; registeredInBodies?: boolean } | undefined;
  if (runSmoke && hubOk) {
    const chatRes = await fetch(`${hubBase}/v1/bodies/game:minecraft/mindcraft-bot/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'soul-unto-you',
        messages: [
          { role: 'system', content: '你是 Minecraft 世界的搭档，请用简短自然中文回答。' },
          { role: 'user', content: '方块世界测试连通：今天先一起找块安全空地搭个小营地吧！' },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    });
    const chatJson = (await chatRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const bodiesRes = await fetch(`${hubBase}/api/bodies`, { signal: AbortSignal.timeout(3000) });
    const bodiesJson = (await bodiesRes.json()) as { bodies?: Array<{ bodyId: string; bodyType: string }> };
    const found = Boolean(
      bodiesJson.bodies?.some((b) => b.bodyId === 'mindcraft-bot' && b.bodyType === 'game:minecraft'),
    );
    smokeResult = {
      ok: Boolean(chatRes.ok && chatJson.choices?.[0]?.message?.content && found),
      replyPreview: chatJson.choices?.[0]?.message?.content?.slice(0, 80),
      registeredInBodies: found,
    };
  }

  const report = {
    hubBase,
    hubOk,
    soulName,
    autoDreamEnabled,
    openAiBodyRouteOk: modelsOk,
    minecraftLanListening: mcLanOpen,
    minecraftTarget: `${mcHost}:${mcPort}`,
    ...(smokeResult ? { smokeResult } : {}),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!hubOk || !modelsOk || (smokeResult && !smokeResult.ok)) {
    process.exitCode = 1;
  }
}

void main();
