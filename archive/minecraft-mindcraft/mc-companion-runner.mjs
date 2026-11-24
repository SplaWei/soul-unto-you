import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setupAutonomousGameLoop } from './mc-autonomy.mjs';
import {
  eatFoodIfHungry,
  exploreSurroundings,
  inspectMcTacticalState,
  isHostileEntity,
  runCombatAction,
  searchAndEquipGear,
  setupAutoGearPickup,
} from './mc-combat-gear.mjs';

const RUNTIME_DIR = process.env.MC_RUNTIME_DIR || path.join(os.homedir(), '.soul-unto-you', 'mc-runtime');
const HUB_URL = (process.env.SOUL_HUB_URL || 'http://127.0.0.1:7777').replace(/\/+$/, '');
const MC_HOST = process.env.MC_HOST || '127.0.0.1';
const MC_PORT = Number(process.env.MC_PORT) || 55916;
const RAW_NAME = String(process.env.MC_BOT_NAME || 'Hajimi').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
const BOT_NAME = RAW_NAME.length >= 3 ? RAW_NAME : 'Hajimi';
const MC_VERSION = String(process.env.MC_VERSION || '').trim();
const BODY_ID = process.env.SOUL_BODY_ID || 'mc-companion-main';
const API_TOKEN = String(process.env.SOUL_API_TOKEN || '').trim();

const req = createRequire(path.join(RUNTIME_DIR, 'package.json'));
const mineflayer = req('mineflayer');
const { pathfinder, Movements, goals } = req('mineflayer-pathfinder');
const { plugin: pvpPlugin } = req('mineflayer-pvp');
const armorManager = req('mineflayer-armor-manager');
const { GoalNear, GoalFollow } = goals;

const SYSTEM_ECHO_RE = /^(Set\s+.*game mode|Summoned new|Gave \d+|Teleported|Killed|Time set|Weather set|Changed game rule|已将.*游戏模式|已召唤|给予|已将)/i;

async function postHub(endpoint, body, timeoutMs = 40000) {
  const res = await fetch(`${HUB_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(API_TOKEN ? { 'X-Soul-Token': API_TOKEN } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

function cleanChatReply(raw) {
  return String(raw ?? '')
    .replace(/<soul_meta>[\s\S]*?<\/soul_meta>/gi, '')
    .replace(/[`*_#]/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitChatChunks(text, maxChars = 180) {
  const clean = cleanChatReply(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < 2) {
    if (rest.length <= maxChars) {
      chunks.push(rest);
      break;
    }
    let cut = -1;
    const win = rest.slice(0, maxChars);
    for (const sep of ['。', '！', '？', '. ', '! ', '? ', '，', ' ']) {
      const idx = win.lastIndexOf(sep);
      if (idx >= Math.floor(maxChars * 0.4)) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks.filter(Boolean);
}

function hintIfForgeError(errMsg) {
  if (/(fml|forge|incompatible|unsupported|handshake|registry|channel|econnreset|partial packet)/i.test(errMsg)) {
    console.log('⚠️ 检测到当前游戏端可能装有 Forge/Mod 导致联机协议握手不兼容！');
    console.log('👉 解决办法：在 PCL2 启动器点击「下载 → 原版」，单下一个纯净原版 1.21.1（不装 Forge），进存档开局域网后再点召唤即可！');
  }
}

console.log(`[mc-companion] 正在以「${BOT_NAME}」身份连接 Minecraft ${MC_HOST}:${MC_PORT} ...`);

const bot = mineflayer.createBot({
  host: MC_HOST,
  port: MC_PORT,
  username: BOT_NAME,
  auth: 'offline',
  version: MC_VERSION && MC_VERSION !== 'auto' ? MC_VERSION : false,
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvpPlugin);
bot.loadPlugin(armorManager);

let thinking = false;
let lastHurtNotifyMs = 0;
let lastHealth = 20;
let stopPickupLoop = null;
let autonomy = null;
function buildMcStatePacket() {
  const pos = bot.entity?.position;
  const nearbyPlayers = Object.keys(bot.players || {}).filter((n) => n !== bot.username).slice(0, 6);
  return {
    health: Math.round((bot.health ?? 20) * 10) / 10,
    food: Math.round((bot.food ?? 20) * 10) / 10,
    timeOfDay: bot.time?.timeOfDay ?? 0,
    pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
    nearbyPlayers,
    ...inspectMcTacticalState(bot),
  };
}

const combatState = { activeCombat: null, lastSeenHostile: null, awaitingPlayerGear: false, awaitingGearUntil: 0, lastRequester: '', busy: false };
const combatCtx = {
  hubUrl: HUB_URL,
  combatState,
  isThinking: () => thinking,
  say: (txt) => {
    for (const chunk of splitChatChunks(txt)) bot.chat(chunk);
  },
  reportBodyEvent: async (summary, opts = {}) => {
    try {
      const out = await postHub('/api/body/observe', {
        bodyId: BODY_ID,
        bodyType: 'game:minecraft',
        displayName: `Minecraft(${BOT_NAME})`,
        summary,
        allowSpeak: opts.allowSpeak ?? false,
        urgency: opts.urgency || 'normal',
        modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: buildMcStatePacket() }],
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      }, 18000);
      if (out?.decidedToSpeak && out.reply) combatCtx.say(out.reply);
      if (opts.allowActions && Array.isArray(out?.actions) && out.actions.length) {
        executeActions(out.actions, opts.requester || combatState.lastRequester || '');
      }
      return out;
    } catch {
      return null;
    }
  },
};

async function registerBody() {
  await postHub('/api/body/register', {
    bodyId: BODY_ID,
    bodyType: 'game:minecraft',
    displayName: `Minecraft(${BOT_NAME})`,
    senses: [{ id: 'mc-world', modality: 'telemetry', description: 'Minecraft 位置、血量、装备、附近箱子/掉落物与敌对生物' }],
    actions: [
      { name: 'attack_mob_reckless', description: '不顾装备直接冲上去近战攻击指定怪物（仅在尚无痛感记忆时初试或执意硬冲）', params: { target: 'creeper|zombie|any' } },
      { name: 'search_and_equip_gear', description: '翻找背包、捡地上掉落物、开附近箱子寻找并穿戴武器护甲；找不到则跑到玩家面前等待装备' },
      { name: 'equip_and_attack_mob', description: '先搜寻穿戴武器护甲盾牌，再用防爆走位攻击指定怪物', params: { target: 'creeper|zombie|any' } },
      { name: 'explore_surroundings', description: '在安全和平时段自主漫步探索周围地形和风景' },
      { name: 'eat_food', description: '饥饿时从背包拿出食物进食恢复' },
      { name: 'come_here', description: '跑到说话的玩家身边' },
      { name: 'follow_player', description: '一直跟着说话的玩家一起行动' },
      { name: 'stop_moving', description: '停下脚步留在原地' },
      { name: 'look_at_player', description: '转头看向说话的玩家' },
      { name: 'wave_jump', description: '开心地原地跳两下并挥手打招呼' },
    ],
    rules: [
      '若尚无被怪物伤痛的 lived 体验且收到打怪请求，可初生无畏地触发 attack_mob_reckless 亲自试探。',
      '若已有被怪物炸伤/阵亡的 lived 痛感且 telemetry 显示 equippedWeapon="none" 且背包无武器：绝对不要再触发 attack_mob_reckless，应拒绝空手送死并优先触发 search_and_equip_gear。',
      '若手中或背包已有武器装备：可触发 equip_and_attack_mob 穿戴装备并走位迎战。',
    ],
  }, 8000).catch(() => {});
}

function executeActions(actions, username) {
  if (!Array.isArray(actions) || !actions.length) return;
  const target = bot.players[username]?.entity;
  for (const act of actions) {
    try {
      if (act.name === 'attack_mob_reckless') {
        void runCombatAction(bot, combatCtx, 'reckless', String(act.params?.target || 'creeper'), username);
      } else if (act.name === 'search_and_equip_gear') {
        void searchAndEquipGear(bot, combatCtx, username);
      } else if (act.name === 'equip_and_attack_mob') {
        void runCombatAction(bot, combatCtx, 'armed', String(act.params?.target || 'creeper'), username);
      } else if (act.name === 'explore_surroundings') {
        void exploreSurroundings(bot);
      } else if (act.name === 'eat_food') {
        void eatFoodIfHungry(bot, combatCtx);
      } else if (act.name === 'come_here' && target) {
        bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
      } else if (act.name === 'follow_player' && target) {
        bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
      } else if (act.name === 'stop_moving') {
        bot.pathfinder.setGoal(null);
      } else if (act.name === 'look_at_player' && target) {
        void bot.lookAt(target.position.offset(0, 1.6, 0));
      } else if (act.name === 'wave_jump') {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 350);
        bot.swingArm?.();
      }
    } catch {}
  }
}

bot.on('spawn', () => {
  lastHealth = bot.health ?? 20;
});

bot.once('spawn', async () => {
  try {
    const movements = new Movements(bot);
    movements.canDig = false;
    bot.pathfinder.setMovements(movements);
  } catch {}
  lastHealth = bot.health ?? 20;
  stopPickupLoop = setupAutoGearPickup(bot, combatCtx);
  autonomy = setupAutonomousGameLoop(bot, combatCtx);
  await registerBody();
  const pos = bot.entity?.position;
  await combatCtx.reportBodyEvent(
    `已进入 Minecraft 世界（出生点 ${Math.round(pos?.x ?? 0)}, ${Math.round(pos?.y ?? 0)}, ${Math.round(pos?.z ?? 0)}）`,
    { allowSpeak: false },
  );

  console.log('✅ 已成功进入 Minecraft 世界！');
  console.log('💬 在游戏里按 T 打开聊天框打字，她就会回应并支持实战打怪/找装备/讨要装备！');
});

bot.on('chat', async (username, message) => {
  if (username === bot.username) return;
  const text = String(message ?? '').trim();
  if (!text || SYSTEM_ECHO_RE.test(text) || thinking) return;

  thinking = true;
  try {
    const out = await postHub('/api/body/percept', {
      bodyId: BODY_ID,
      bodyType: 'game:minecraft',
      displayName: `Minecraft(${BOT_NAME})`,
      speaker: username,
      text,
      modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: buildMcStatePacket() }],
    });

    if (out?.ok && out.reply) {
      executeActions(out.actions, username);
      const chunks = splitChatChunks(out.reply);
      for (let i = 0; i < chunks.length; i += 1) {
        if (i > 0) await new Promise((r) => setTimeout(r, 450));
        bot.chat(chunks[i]);
      }
      console.log(`[对话] ${username}: ${text} -> ${BOT_NAME}: ${chunks.join(' ')}`);
    }
  } catch (err) {
    console.error('[mc-companion] 思考回复失败:', err instanceof Error ? err.message : String(err));
  } finally {
    thinking = false;
  }
});

function findNearbyThreat() {
  try {
    const pos = bot.entity?.position;
    if (pos) {
      let best = null;
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !isHostileEntity(e)) continue;
        const dist = pos.distanceTo(e.position);
        if (dist <= 11 && (!best || dist < best.dist)) {
          best = { name: String(e.name || '敌对生物').toLowerCase(), dist };
        }
      }
      if (best) return best.name;
    }
    if (combatState.lastSeenHostile && Date.now() - combatState.lastSeenHostile.at <= 6500) {
      return combatState.lastSeenHostile.name;
    }
    return '';
  } catch {
    return '';
  }
}

bot.on('health', () => {
  const cur = bot.health ?? 20;
  const delta = lastHealth - cur;
  lastHealth = cur;
  const combat = combatState.activeCombat;
  const tactical = inspectMcTacticalState(bot);
  const isArmed = tactical.equippedWeapon !== 'none' || Boolean(combat?.weapon && combat.weapon !== 'none');
  const cooldownMs = isArmed ? 8000 : 5000;
  const shouldNotify = cur > 0 && Date.now() - lastHurtNotifyMs > cooldownMs && (!isArmed ? delta >= 1.5 : (delta >= 7 || cur <= 6));
  if (shouldNotify) {
    lastHurtNotifyMs = Date.now();
    const threat = findNearbyThreat() || combat?.targetName || '';
    const dmg = Math.round(delta * 10) / 10;
    const isCreeper = threat === 'creeper';
    const summary = `在 Minecraft 中受到 ${dmg} 点伤害${threat ? `（附近威胁: ${threat}）` : ''}，当前生命值仅剩 ${Math.round(cur)}/20`;
    const lesson = isArmed
      ? `虽然手握武器，但在血量危急（仅剩 ${Math.round(cur)}/20）或被近身围攻时仍会重伤，需要立刻拉开距离吃食物回血或请同伴掩护。`
      : (isCreeper
        ? '空手或没有足够防备去打 creeper 会被炸掉巨额生命值！下次必须先找箱子或向同行者讨要武器护甲盾牌再战。'
        : `空手无防备去跟 ${threat || '怪物'} 搏斗会不断挨揍受伤！面对任何危险怪物都绝不能空手硬冲，必须先退避找箱子或向同伴讨要武器护甲。`);
    const realityOutcome = isCreeper
      ? `遭到 ${threat} 爆炸重创，掉血 ${dmg} 点（仅剩 ${Math.round(cur)}/20），浑身剧痛`
      : `遭到 ${threat || '敌对生物'} 攻击受伤，掉血 ${dmg} 点（剩余 ${Math.round(cur)}/20）`;
    void combatCtx.reportBodyEvent(summary, {
      allowSpeak: true,
      urgency: 'high',
      metadata: {
        realityFeedback: {
          origin: 'lived',
          stimulus: !isArmed ? `在无防备状态下遭遇或迎战 ${threat || '危险怪物'}` : `在 Minecraft 迎战 ${threat || '危险怪物'}`,
          chosenAction: !isArmed ? '没有任何武器护甲就近身接触或挨打' : '在当前装备状态下与强敌周旋并承受重击',
          realityOutcome,
          valence: (dmg >= 6 || !isArmed) ? -0.92 : -0.78,
          arousal: 0.94,
          lesson,
        },
      },
    }).then(() => { void autonomy?.forceSync(); });
  }
});

bot.on('death', () => {
  const combat = combatState.activeCombat;
  const threat = findNearbyThreat() || combat?.targetName || '';
  const summary = `刚刚在 Minecraft 世界里阵亡复活了${threat ? `（倒在 ${threat} 手下）` : ''}`;
  const isCreeper = threat === 'creeper';
  combatState.activeCombat = null;
  void combatCtx.reportBodyEvent(summary, {
    allowSpeak: true,
    urgency: 'high',
    metadata: {
      realityFeedback: {
        origin: 'lived',
        stimulus: combat ? `在 Minecraft 尝试${combat.weapon === 'none' ? '空手' : `持 ${combat.weapon}`}打 ${combat.targetName}` : '在 Minecraft 面对致命危险',
        chosenAction: combat?.weapon === 'none' ? '毫无武器防具就冲上去贴脸硬刚' : '硬扛高危袭击未能及时撤离',
        realityOutcome: summary,
        valence: -0.96,
        arousal: 0.98,
        lesson: isCreeper
          ? '刚刚因为冲上去打 creeper 直接被炸死了！以后绝对不能再空手硬冲，必须先翻箱子或找同行者拿剑、护甲和盾牌！'
          : `刚刚在与 ${threat || '危险怪物'} 交战时阵亡复活了！事实证明缺乏足够武器护甲或残血硬拼非常致命，以后遇到任何怪物都必须先备齐装备并注意血量安全！`,
      },
    },
  }).then(() => { void autonomy?.forceSync(); });
});

bot.on('kicked', (reason) => {
  const txt = typeof reason === 'string' ? reason : JSON.stringify(reason);
  console.error(`[mc-companion] 被游戏世界踢出/断开: ${txt}`);
  hintIfForgeError(txt);
});

bot.on('error', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[mc-companion] 连接出错: ${msg}`);
  hintIfForgeError(msg);
});

bot.on('end', (reason) => {
  try { stopPickupLoop?.(); autonomy?.stop(); } catch {}
  console.log(`[mc-companion] 已退出 Minecraft (${reason || 'disconnected'})`);
  process.exit(0);
});

const shutdown = () => {
  try { bot.quit('bye'); } catch {}
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
