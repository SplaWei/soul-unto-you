import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_DIR = process.env.MC_RUNTIME_DIR || path.join(os.homedir(), '.soul-unto-you', 'mc-runtime');
const req = createRequire(path.join(RUNTIME_DIR, 'package.json'));
const { goals } = req('mineflayer-pathfinder');
const { GoalNear, GoalFollow } = goals;

const WEAPON_RE = /(?:_sword|_axe|^trident$|^mace$)/;
const ARMOR_RE = /(helmet|chestplate|leggings|boots)$/;
const HOSTILE_NAMES = new Set([
  'creeper', 'zombie', 'skeleton', 'spider', 'cave_spider', 'enderman', 'witch',
  'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'slime', 'phantom', 'bogged', 'breeze',
]);
const TIER_SCORE = { netherite: 60, diamond: 50, iron: 40, stone: 30, golden: 25, wooden: 20, chainmail: 32, leather: 15 };

function itemScore(name) {
  let s = 10;
  for (const [k, v] of Object.entries(TIER_SCORE)) {
    if (name.includes(k)) { s += v; break; }
  }
  if (name.endsWith('_sword')) s += 8;
  else if (name.endsWith('trident') || name.endsWith('mace')) s += 7;
  else if (name.endsWith('_axe')) s += 5;
  return s;
}

const ARMOR_SLOTS = [['helmet', 'head'], ['chestplate', 'torso'], ['leggings', 'legs'], ['boots', 'feet']];
const armorSlotOf = (n) => ARMOR_SLOTS.find(([k]) => n.endsWith(k))?.[1] || null;

function isGearName(name) {
  return Boolean(name && (WEAPON_RE.test(name) || ARMOR_RE.test(name) || name === 'shield'));
}

function getDroppedItemName(bot, entity) {
  try {
    const dropped = typeof entity.getDroppedItem === 'function' ? entity.getDroppedItem() : null;
    if (dropped?.name) return dropped.name;
    for (const m of entity.metadata || []) {
      if (m && typeof m === 'object' && typeof m.itemId === 'number') {
        return bot.registry?.items?.[m.itemId]?.name || '';
      }
    }
  } catch {}
  return '';
}

export function normalizeMobName(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('苦力怕') || s.includes('creeper') || s.includes('爬行者')) return 'creeper';
  if (s.includes('僵尸') || s.includes('zombie')) return 'zombie';
  if (s.includes('骷髅') || s.includes('skeleton')) return 'skeleton';
  if (s.includes('蜘蛛') || s.includes('spider')) return 'spider';
  return '';
}

export function isHostileEntity(e) {
  if (!e || e.type === 'player' || !e.position) return false;
  const name = String(e.name || '').toLowerCase();
  if (name === 'item' || name === 'experience_orb' || name === 'arrow' || name === 'armor_stand') return false;
  return HOSTILE_NAMES.has(name) || e.type === 'hostile' || e.type === 'mob';
}

export function findTargetMob(bot, targetName = '') {
  const pos = bot.entity?.position;
  if (!pos) return null;
  const wanted = normalizeMobName(targetName);
  let best = null;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !isHostileEntity(e)) continue;
    const name = String(e.name || '').toLowerCase();
    if (wanted && name !== wanted) continue;
    const dist = pos.distanceTo(e.position);
    if (dist <= 28 && (!best || dist < best.dist)) best = { entity: e, dist };
  }
  return best?.entity || null;
}

export function inspectMcTacticalState(bot) {
  const pos = bot.entity?.position;
  const invItems = bot.inventory?.items?.() || [];
  const weapons = invItems.filter((i) => WEAPON_RE.test(i.name)).sort((a, b) => itemScore(b.name) - itemScore(a.name));
  const armors = invItems.filter((i) => ARMOR_RE.test(i.name));
  const hasShieldInBag = invItems.some((i) => i.name === 'shield');
  const held = bot.heldItem;
  const equippedWeapon = held && WEAPON_RE.test(held.name) ? held.name : 'none';
  const offHand = bot.inventory?.slots?.[45];
  const hasShield = offHand?.name === 'shield';
  const equippedArmor = [5, 6, 7, 8].map((idx) => bot.inventory?.slots?.[idx]?.name).filter(Boolean);

  const nearbyHostiles = [];
  const nearbyDroppedGear = [];
  if (pos) {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position) continue;
      const dist = Math.round(pos.distanceTo(e.position) * 10) / 10;
      const eName = String(e.name || '').toLowerCase();
      if ((HOSTILE_NAMES.has(eName) || e.type === 'hostile') && dist <= 24) {
        nearbyHostiles.push({ name: eName, dist });
      } else if ((eName === 'item' || e.type === 'object') && dist <= 16) {
        const dropName = getDroppedItemName(bot, e);
        if (!dropName || isGearName(dropName)) nearbyDroppedGear.push({ name: dropName || 'dropped_item', dist });
      }
    }
  }
  nearbyHostiles.sort((a, b) => a.dist - b.dist);

  const chestIds = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry?.blocksByName?.[n]?.id).filter((id) => typeof id === 'number');
  const chestPositions = chestIds.length ? bot.findBlocks({ matching: chestIds, maxDistance: 16, count: 4 }) : [];

  return {
    equippedWeapon, hasShield, equippedArmor,
    backpackWeapons: weapons.map((w) => w.name), backpackArmor: armors.map((a) => a.name),
    hasShieldInBag, nearbyHostiles: nearbyHostiles.slice(0, 5),
    nearbyDroppedGear: nearbyDroppedGear.slice(0, 5), nearbyChestCount: chestPositions.length,
  };
}

export async function equipBestGearFromInventory(bot) {
  try { await bot.armorManager?.equipAll(); } catch {}
  for (const item of bot.inventory?.items?.() || []) {
    const slot = armorSlotOf(item.name);
    if (slot) try { await bot.equip(item, slot); } catch {}
  }
  const shield = (bot.inventory?.items?.() || []).find((i) => i.name === 'shield');
  if (shield) try { await bot.equip(shield, 'off-hand'); } catch {}
  const weapons = (bot.inventory?.items?.() || []).filter((i) => WEAPON_RE.test(i.name)).sort((a, b) => itemScore(b.name) - itemScore(a.name));
  if (weapons.length) try { await bot.equip(weapons[0], 'hand'); } catch {}
  return inspectMcTacticalState(bot);
}

export async function gotoNearSafe(bot, pos, range = 2, timeoutMs = 6000) {
  if (!pos) return false;
  try {
    const goal = new GoalNear(pos.x, pos.y, pos.z, range);
    await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rej) => setTimeout(() => rej(new Error('goto timeout')), timeoutMs))]);
    return true;
  } catch { try { bot.pathfinder.setGoal(null); } catch {} return false; }
}

async function lootNearbyChests(bot, maxChests = 3) {
  const chestIds = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry?.blocksByName?.[n]?.id).filter((id) => typeof id === 'number');
  if (!chestIds.length) return [];
  const positions = bot.findBlocks({ matching: chestIds, maxDistance: 16, count: maxChests });
  const taken = [];
  for (const pos of positions) {
    if (!(await gotoNearSafe(bot, pos, 2.5, 6500))) continue;
    const block = bot.blockAt(pos);
    if (!block) continue;
    let win = null;
    try {
      win = await bot.openContainer(block);
      for (const item of win.containerItems()) {
        if (isGearName(item.name)) { await win.withdraw(item.type, null, item.count); taken.push(item.name); }
      }
    } catch {} finally { try { win?.close(); } catch {} }
    if (taken.some((n) => WEAPON_RE.test(n))) break;
  }
  return taken;
}

function findDroppedGear(bot, maxRadius = 16) {
  const pos = bot.entity?.position;
  if (!pos) return [];
  return Object.values(bot.entities || {}).filter((e) => {
    if (!e || e === bot.entity || !e.position) return false;
    const n = String(e.name || '').toLowerCase();
    if (n !== 'item' && e.type !== 'object') return false;
    if (pos.distanceTo(e.position) > maxRadius) return false;
    const dName = getDroppedItemName(bot, e);
    return !dName || isGearName(dName);
  });
}

async function collectDroppedGear(bot, maxRadius = 16) {
  const drops = findDroppedGear(bot, maxRadius);
  for (const drop of drops.slice(0, 4)) {
    await gotoNearSafe(bot, drop.position, 1, 5000);
    await new Promise((r) => setTimeout(r, 350));
  }
  return drops.length > 0;
}

export async function searchAndEquipGear(bot, ctx, requester = '') {
  const steps = [
    ['backpack', async () => null],
    ['ground', async () => { await collectDroppedGear(bot, 16); return null; }],
    ['chest', async () => lootNearbyChests(bot, 3)],
  ];
  for (const [source, fn] of steps) {
    const extra = await fn();
    const state = await equipBestGearFromInventory(bot);
    if (state.equippedWeapon !== 'none') {
      ctx.combatState.awaitingPlayerGear = false;
      ctx.combatState.awaitingGearUntil = 0;
      const detail = source === 'chest' ? `从周围箱子搜到了 ${(extra || []).join('、') || state.equippedWeapon}` : (source === 'ground' ? `在地上捡到 ${state.equippedWeapon}` : `从背包翻出 ${state.equippedWeapon}`);
      await ctx.reportBodyEvent(`[躯体行动结果] 我${detail}并穿戴好了（护甲 ${state.equippedArmor.length} 件${state.hasShield ? '、含盾牌' : ''}）。`, { allowSpeak: true, urgency: 'normal', allowActions: true });
      return { armed: true, state, source };
    }
  }
  ctx.combatState.awaitingPlayerGear = true;
  ctx.combatState.awaitingGearUntil = Date.now() + 22000;
  ctx.combatState.lastRequester = requester;
  const player = bot.players[requester]?.entity || Object.values(bot.players || {}).find((p) => p?.username !== bot.username && p?.entity)?.entity;
  if (player) {
    await gotoNearSafe(bot, player.position, 2, 5000);
    void bot.lookAt(player.position.offset(0, 1.6, 0)).catch(() => {});
  }
  await ctx.reportBodyEvent('[躯体行动结果] 我翻遍了自己的背包、周围地面和附近箱子，没有找到任何武器防具，现在跑到了同伴面前站定看着对方（等待同伴按 Q 丢装备或回应）。', { allowSpeak: true, urgency: 'high', allowActions: false });
  return { armed: false, state: inspectMcTacticalState(bot), source: 'none' };
}

export function setupAutoGearPickup(bot, ctx) {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || ctx.combatState.busy) return;
    const held = bot.heldItem;
    if (held && WEAPON_RE.test(held.name) && !ctx.combatState.awaitingPlayerGear) return;
    checking = true;
    try {
      const before = inspectMcTacticalState(bot);
      if (before.backpackWeapons.length && before.equippedWeapon === 'none') {
        const after = await equipBestGearFromInventory(bot);
        ctx.combatState.awaitingPlayerGear = false;
        ctx.combatState.awaitingGearUntil = 0;
        await ctx.reportBodyEvent(`[躯体感知] 背包里刚获得了 ${after.equippedWeapon} 并已穿戴到身上（护甲 ${after.equippedArmor.length} 件）。`, { allowSpeak: true, urgency: 'normal', allowActions: true });
        return;
      }
      const nearbyDrop = findDroppedGear(bot, 10)[0];
      if (nearbyDrop) {
        await gotoNearSafe(bot, nearbyDrop.position, 1, 4000);
        await new Promise((r) => setTimeout(r, 350));
        const after = await equipBestGearFromInventory(bot);
        if (after.equippedWeapon !== 'none' || after.equippedArmor.length > before.equippedArmor.length) {
          ctx.combatState.awaitingPlayerGear = false;
          ctx.combatState.awaitingGearUntil = 0;
          await ctx.reportBodyEvent(`[躯体感知] 我跑过去捡起了地上丢给我的装备（主手:${after.equippedWeapon}，已穿护甲:${after.equippedArmor.length}件）。`, { allowSpeak: true, urgency: 'normal', allowActions: true });
        }
      }
    } catch {} finally { checking = false; }
  }, 1500);
  return () => clearInterval(timer);
}

export async function stepBackFrom(bot, targetPos, dist = 5.5, waitMs = 1150) {
  const me = bot.entity?.position;
  if (!me || !targetPos) return;
  const dx = me.x - targetPos.x;
  const dz = me.z - targetPos.z;
  const len = Math.hypot(dx, dz) || 1;
  const destX = me.x + (dx / len) * dist;
  const destZ = me.z + (dz / len) * dist;
  try { bot.pathfinder.setGoal(new GoalNear(destX, me.y, destZ, 1)); } catch {}
  await new Promise((r) => setTimeout(r, waitMs));
  try { bot.pathfinder.setGoal(null); } catch {}
}

export async function exploreSurroundings(bot) {
  const me = bot.entity?.position;
  if (!me) return false;
  const angle = Math.random() * Math.PI * 2;
  const r = 5 + Math.random() * 5;
  const dest = { x: me.x + Math.cos(angle) * r, y: me.y, z: me.z + Math.sin(angle) * r };
  const ok = await gotoNearSafe(bot, dest, 1.5, 4500);
  try { await bot.look((bot.entity.yaw || 0) + (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 0.4); } catch {}
  return ok;
}

const FOOD_RE = /(bread|apple|cooked_|steak|porkchop|mutton|chicken|rabbit|salmon|cod|potato|carrot|melon|berries|cookie|pie|stew)/i;

export async function eatFoodIfHungry(bot, ctx) {
  if ((bot.food ?? 20) >= 16) return false;
  const food = (bot.inventory?.items?.() || []).find((i) => FOOD_RE.test(i.name));
  if (!food) return false;
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    await ctx.reportBodyEvent(`[躯体行动结果] 刚才肚子饿了（饱食度），自己从背包吃掉了 ${food.name}。`, { allowSpeak: true, urgency: 'low', allowActions: false });
    return true;
  } catch {
    return false;
  }
}

export async function runCombatAction(bot, ctx, mode, targetName, requester) {
  if (ctx.combatState.busy) return;
  ctx.combatState.busy = true;
  try {
    let tactical = inspectMcTacticalState(bot);
    if (mode === 'armed') {
      if (tactical.equippedWeapon === 'none') {
        const searchRes = await searchAndEquipGear(bot, ctx, requester);
        if (!searchRes.armed) return;
      } else {
        await equipBestGearFromInventory(bot);
      }
      tactical = inspectMcTacticalState(bot);
    }

    const mob = findTargetMob(bot, targetName);
    if (!mob) {
      await ctx.reportBodyEvent('[躯体感知] 环顾周围 28 格内暂时没有发现敌对怪物。', { allowSpeak: false, urgency: 'low', allowActions: false });
      return;
    }
    const mobName = String(mob.name || 'mob').toLowerCase();
    ctx.combatState.activeCombat = { targetName: mobName, mode, weapon: tactical.equippedWeapon, startedAt: Date.now() };
    const startHealth = bot.health ?? 20;
    const deadline = Date.now() + 40_000;

    while (Date.now() < deadline && mob.isValid && (bot.health ?? 0) > 0) {
      if (mode === 'reckless' && startHealth - (bot.health ?? startHealth) >= 2.0) {
        try { bot.pathfinder.setGoal(null); } catch {}
        await stepBackFrom(bot, mob.position, 8.0, 1200);
        return;
      }
      if (mode === 'armed' && (bot.health ?? 20) <= 5) {
        try { bot.pathfinder.setGoal(null); } catch {}
        await stepBackFrom(bot, mob.position, 8.5, 1200);
        await eatFoodIfHungry(bot, ctx);
        break;
      }
      const dist = bot.entity.position.distanceTo(mob.position);
      if (dist > 2.8) {
        if (mode === 'reckless') {
          bot.pathfinder.setGoal(new GoalFollow(mob, 1.2), true);
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        await gotoNearSafe(bot, mob.position, 2.2, 2200);
      }
      await bot.lookAt(mob.position.offset(0, (mob.height || 1.7) * 0.6, 0)).catch(() => {});
      if (bot.entity.position.distanceTo(mob.position) <= 3.5) bot.attack(mob);
      if (mode === 'armed' && mobName === 'creeper') {
        if (tactical.hasShield) try { bot.activateItem(true); } catch {}
        await stepBackFrom(bot, mob.position, 5.5, 1100);
        if (tactical.hasShield) try { bot.deactivateItem(); } catch {}
      } else if (mode === 'armed') {
        await stepBackFrom(bot, mob.position, 2.8, 380);
      } else {
        await new Promise((r) => setTimeout(r, 550));
      }
    }
    try { bot.pathfinder.setGoal(null); } catch {}

    const dmgTaken = startHealth - (bot.health ?? startHealth);
    if (!mob.isValid && (bot.health ?? 0) > 0 && !(mobName === 'creeper' && dmgTaken >= 6)) {
      const wLabel = tactical.equippedWeapon === 'none' ? '拳头' : tactical.equippedWeapon;
      const isCreeper = mobName === 'creeper';
      const chosenAction = mode === 'armed'
        ? (isCreeper ? `装备 ${tactical.equippedWeapon} 并配合防爆走位迎战` : `装备 ${tactical.equippedWeapon} 并配合拉扯走位迎战`)
        : '空手正面硬拼';
      const lesson = mode === 'armed'
        ? (isCreeper
          ? `拿好 ${tactical.equippedWeapon} 并采取打一刀退一步防爆走位，就能安全击败 ${mobName}！`
          : `手持 ${tactical.equippedWeapon} 保持近战拉扯走位，成功击败 ${mobName}！备齐武器装备就能从容战胜危险怪物。`)
        : '这次险胜了，但面对危险怪物还是有武器防具更稳妥。';
      await ctx.reportBodyEvent(`[躯体战斗胜利] 使用「${wLabel}」成功击败了 ${mobName}（血量 ${Math.round(startHealth)}→${Math.round(bot.health ?? 20)}/20）。`, {
        allowSpeak: true, urgency: 'high', allowActions: false,
        metadata: {
          realityFeedback: {
            origin: 'lived', stimulus: `在 Minecraft 面对 ${mobName}`, chosenAction,
            realityOutcome: `成功击败 ${mobName} 且自身存活（血量 ${Math.round(startHealth)}→${Math.round(bot.health ?? 20)}）`,
            valence: 0.9, arousal: 0.85, lesson,
          },
        },
      });
    }
  } finally {
    ctx.combatState.busy = false;
    setTimeout(() => { if (ctx.combatState.activeCombat && Date.now() - ctx.combatState.activeCombat.startedAt > 5000) ctx.combatState.activeCombat = null; }, 3500);
  }
}
