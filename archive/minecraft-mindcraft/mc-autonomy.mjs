import {
  eatFoodIfHungry,
  equipBestGearFromInventory,
  exploreSurroundings,
  findTargetMob,
  gotoNearSafe,
  inspectMcTacticalState,
  isHostileEntity,
  runCombatAction,
  searchAndEquipGear,
  stepBackFrom,
} from './mc-combat-gear.mjs';

const PAIN_EXP_RE = /(苦力怕|creeper|僵尸|zombie|骷髅|skeleton|蜘蛛|spider|怪物|爆炸|炸|阵亡|重创|掉血|伤害|挨揍)/i;

function pickNearestPlayer(bot) {
  const pos = bot.entity?.position;
  if (!pos) return null;
  let best = null;
  for (const p of Object.values(bot.players || {})) {
    if (!p || p.username === bot.username || !p.entity?.position) continue;
    const dist = pos.distanceTo(p.entity.position);
    if (!best || dist < best.dist) best = { username: p.username, entity: p.entity, dist };
  }
  return best;
}

export function setupAutonomousGameLoop(bot, ctx) {
  let hasDangerPainMemory = false;
  let hasLivedPainExp = false;
  let hasActiveDangerBelief = false;
  let epistemicTendency = 'skeptical';
  let lastSyncedCount = -1;
  let lastSyncAt = 0;
  let runningTick = false;
  const cooldowns = new Map();

  function ready(key, ms) {
    const now = Date.now();
    if (now - (cooldowns.get(key) || 0) < ms) return false;
    cooldowns.set(key, now);
    return true;
  }

  async function syncState(force = false) {
    if (!force && Date.now() - lastSyncAt < 2500) return;
    lastSyncAt = Date.now();
    try {
      const [expRes, ilRes] = await Promise.all([
        fetch(`${ctx.hubUrl}/api/archive/experiences?limit=50`, { signal: AbortSignal.timeout(2500) }),
        fetch(`${ctx.hubUrl}/api/inner-life`, { signal: AbortSignal.timeout(2500) }),
      ]);
      let expsEmpty = false;
      if (expRes.ok) {
        const data = await expRes.json();
        const exps = Array.isArray(data?.experiences) ? data.experiences : [];
        expsEmpty = exps.length === 0;
        if (lastSyncedCount > 0 && expsEmpty) cooldowns.clear();
        lastSyncedCount = exps.length;
        hasLivedPainExp = exps.some(
          (e) => e.origin === 'lived' && Number(e.valence) <= -0.4 && PAIN_EXP_RE.test(`${e.stimulus} ${e.realityOutcome} ${e.lesson}`),
        );
      }
      if (ilRes.ok) {
        const ilData = await ilRes.json();
        epistemicTendency = String(ilData?.drives?.epistemicTendency || 'skeptical');
        hasActiveDangerBelief = Array.isArray(ilData?.beliefs) && ilData.beliefs.some(
          (b) => !b.supersededAtSeq && b.topic === '危险防备底线' && Number(b.confidence) >= 0.75,
        );
      }
      const nextDanger = hasLivedPainExp || hasActiveDangerBelief;
      if ((hasDangerPainMemory && !nextDanger) || (expsEmpty && !hasActiveDangerBelief)) {
        cooldowns.clear();
        ctx.combatState.awaitingPlayerGear = false;
        ctx.combatState.awaitingGearUntil = 0;
      }
      hasDangerPainMemory = nextDanger;
    } catch {}
  }

  function refreshHostileMemory() {
    const pos = bot.entity?.position;
    if (!pos) return;
    let best = null;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !isHostileEntity(e)) continue;
      const dist = pos.distanceTo(e.position);
      if (dist <= 12 && (!best || dist < best.dist)) best = { name: String(e.name || 'mob').toLowerCase(), dist };
    }
    if (best) ctx.combatState.lastSeenHostile = { name: best.name, dist: best.dist, at: Date.now() };
  }

  const timer = setInterval(async () => {
    if (!bot.entity?.position || (bot.health ?? 0) <= 0) return;
    refreshHostileMemory();
    if (ctx.combatState.awaitingPlayerGear && ctx.combatState.awaitingGearUntil > 0 && Date.now() > ctx.combatState.awaitingGearUntil) {
      ctx.combatState.awaitingPlayerGear = false;
      ctx.combatState.awaitingGearUntil = 0;
    }
    if (runningTick || ctx.combatState.busy || ctx.isThinking()) return;
    runningTick = true;
    try {
      await syncState(false);
      let tactical = inspectMcTacticalState(bot);

      if (tactical.backpackArmor.length || (tactical.hasShieldInBag && !tactical.hasShield) || (tactical.backpackWeapons.length && tactical.equippedWeapon === 'none')) {
        tactical = await equipBestGearFromInventory(bot);
      }

      const nearestPlayer = pickNearestPlayer(bot);
      const playerName = nearestPlayer?.username || '';
      const hasWeapon = tactical.equippedWeapon !== 'none';
      const creeper = findTargetMob(bot, 'creeper');
      const creeperDist = creeper ? bot.entity.position.distanceTo(creeper.position) : 999;
      const threat = creeper && creeperDist <= 14 ? creeper : findTargetMob(bot, '');
      const threatDist = threat ? bot.entity.position.distanceTo(threat.position) : 999;
      const threatName = threat ? String(threat.name || 'mob').toLowerCase() : '';

      // 1. 危急低血自保：任何时刻残血遇险先拉开并吃食回血
      if ((bot.health ?? 20) <= 6 && threat && threatDist <= 12) {
        await stepBackFrom(bot, threat.position, 8.5, 1100);
        await eatFoodIfHungry(bot, ctx);
        if (ready('lowHpWarn', 15000)) {
          void ctx.reportBodyEvent(
            `[危险撤离感知] 被 ${threatName} 逼近且血量危急（仅剩 ${Math.round(bot.health ?? 6)}/20），已本能后退避险。`,
            { allowSpeak: true, urgency: 'normal', allowActions: false, requester: playerName },
          ).catch(() => {});
        }
        return;
      }

      // 2. 泛化遭遇所有敌对怪物：按实战痛感/认知倾向决定空手试探还是退后搜装，或持剑迎战
      if (threat && threatDist <= 14 && !hasWeapon) {
        if (hasDangerPainMemory || epistemicTendency === 'believed') {
          if (threatDist <= 9) await stepBackFrom(bot, threat.position, 8.5, 1100);
          if (ready('evadeSearch', 12000) && (!ctx.combatState.awaitingPlayerGear || tactical.nearbyChestCount > 0)) {
            await searchAndEquipGear(bot, ctx, playerName);
          }
          return;
        }
        if (ready('recklessCombat', 14000)) {
          void ctx.reportBodyEvent(
            `[视觉感知] 前方 ${Math.round(threatDist)} 格出现 ${threatName}！我还没吃过它的亏且两手空空，正按好奇本能靠过去试探/动手。`,
            { allowSpeak: true, urgency: 'normal', allowActions: false, requester: playerName },
          ).catch(() => {});
          await runCombatAction(bot, ctx, 'reckless', threatName, playerName);
          await syncState(true);
          return;
        }
      }

      if (hasWeapon && (bot.health ?? 20) > 6 && threat && threatDist <= (threatName === 'creeper' ? 18 : 14) && ready('armedCombat', 5000)) {
        void ctx.reportBodyEvent(
          `[视觉感知] 前方 ${Math.round(threatDist)} 格发现 ${threatName}，我手里握着 ${tactical.equippedWeapon}${tactical.hasShield ? ' 和盾牌' : ''}，身上穿有 ${tactical.equippedArmor.length} 件护甲（血量 ${Math.round(bot.health ?? 20)}/20），正主动走位迎战。`,
          { allowSpeak: true, urgency: 'normal', allowActions: false, requester: playerName },
        ).catch(() => {});
        await runCombatAction(bot, ctx, 'armed', threatName, playerName);
        await syncState(true);
        return;
      }

      // 3. 和平期自主生活循环：饥饿进食、仅远距时跟随、短时注视讨装、其余时间在 16 格半径内自由散步
      if ((bot.food ?? 20) < 16 && ready('eat', 12000)) {
        if (await eatFoodIfHungry(bot, ctx)) return;
      }

      if (nearestPlayer && nearestPlayer.dist > 16 && nearestPlayer.dist <= 42 && ready('followIdle', 4000)) {
        await gotoNearSafe(bot, nearestPlayer.entity.position, 5, 2500);
        return;
      }

      if (nearestPlayer && ctx.combatState.awaitingPlayerGear && nearestPlayer.dist <= 6 && ready('lookWait', 2500)) {
        void bot.lookAt(nearestPlayer.entity.position.offset(0, 1.6, 0)).catch(() => {});
        return;
      }

      const nearestHostile = tactical.nearbyHostiles[0];
      if (!nearestHostile && ready('exploreIdle', 8000)) {
        await exploreSurroundings(bot);
      }
    } catch {} finally {
      runningTick = false;
    }
  }, 1200);

  return { stop: () => clearInterval(timer), forceSync: () => syncState(true) };
}
