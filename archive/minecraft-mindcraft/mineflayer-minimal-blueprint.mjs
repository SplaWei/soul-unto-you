/**
 * 极简 Mineflayer 伴侣蓝图（独立于 Mindcraft 的备选方案，直连《灵魂予你》Body Protocol）。
 * 说明：本仓库保持零外部 npm 依赖，因此不在仓库中安装 mineflayer；
 *       若需直接运行本脚本，请在单独的临时目录执行 `npm install mineflayer` 后再运行。
 */
import mineflayer from 'mineflayer';

const HUB_URL = process.env.SOUL_HUB_URL || 'http://127.0.0.1:7777';
const MC_HOST = process.env.MC_HOST || '127.0.0.1';
const MC_PORT = Number(process.env.MC_PORT) || 55916;
const BOT_NAME = process.env.MC_BOT_NAME || 'SoulCompanion';
const BODY_ID = process.env.SOUL_BODY_ID || 'mc-mineflayer-1';

async function postHub(endpoint, body) {
  const res = await fetch(`${HUB_URL.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

const bot = mineflayer.createBot({
  host: MC_HOST,
  port: MC_PORT,
  username: BOT_NAME,
  auth: 'offline',
});

bot.once('spawn', async () => {
  await postHub('/api/body/register', {
    bodyId: BODY_ID,
    bodyType: 'game:minecraft',
    displayName: `Minecraft(${BOT_NAME})`,
    senses: [{ id: 'mc-world', modality: 'telemetry', description: 'Minecraft 坐标、生命值、昼夜与玩家聊天' }],
    actions: [{ name: 'wave_jump', description: '在原地开心跳一下回应玩家' }],
  }).catch(() => {});

  const pos = bot.entity?.position;
  await postHub('/api/body/observe', {
    bodyId: BODY_ID,
    bodyType: 'game:minecraft',
    summary: `已进入 Minecraft 世界，出生点 (${Math.round(pos?.x ?? 0)}, ${Math.round(pos?.y ?? 0)}, ${Math.round(pos?.z ?? 0)})`,
    allowSpeak: false,
  }).catch(() => {});
});

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  const pos = bot.entity?.position;
  const out = await postHub('/api/body/percept', {
    bodyId: BODY_ID,
    bodyType: 'game:minecraft',
    speaker: username,
    text: message,
    modalities: [
      {
        kind: 'telemetry',
        label: 'minecraft-state',
        data: { health: bot.health, food: bot.food, pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null },
      },
    ],
  }).catch(() => null);

  if (out?.ok && out.reply) {
    bot.chat(String(out.reply).slice(0, 220));
    if (out.actions?.some((a) => a.name === 'wave_jump')) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
    }
  }
});

bot.on('health', () => {
  if (bot.health > 0 && bot.health <= 8) {
    void postHub('/api/body/observe', {
      bodyId: BODY_ID,
      bodyType: 'game:minecraft',
      summary: `在 Minecraft 中受伤了，当前生命值仅剩 ${bot.health}/20`,
      allowSpeak: true,
      urgency: 'high',
    }).then((out) => {
      if (out?.decidedToSpeak && out.reply) bot.chat(String(out.reply).slice(0, 220));
    }).catch(() => {});
  }
});
