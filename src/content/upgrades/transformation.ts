/**
 * Transformations and curses.
 *
 * Transformations are the run-defining legendaries. Each one should be the thing
 * the player tells someone about afterwards, so they change a *rule* rather than
 * a number: enemies become terrain, your trail becomes a weapon, kills become
 * flight. They are never offered in shops - finding one has to feel like the room
 * gave it to you.
 *
 * Curses are the other side of the same coin: real power at a real, stated cost.
 * They are always clearly marked, they always say exactly what they take, and the
 * offer system will never fill a whole hand with them.
 */

import { ORDER } from '../../sim/gameEvents';
import { EnemyFlag } from '../../sim/entities';
import { applyStatus } from '../../sim/enemyLogic';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const TRANSFORMATION_UPGRADES: UpgradeDef[] = [
  {
    id: 'living_platforms',
    name: 'Living Platforms',
    family: 'transformation',
    rarity: 'legendary',
    text: 'Shocked enemies harden into solid platforms you can bounce off and stand on.',
    hint: 'The room becomes whatever you have electrified.',
    tags: ['lightning', 'terrain', 'parasite', 'shock'],
    archetypes: ['parasite', 'lightning'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'enemyDamaged',
        (payload) => {
          if (payload.source === 'lightning' || payload.enemy.status.shockTime > 0) {
            applyStatus(payload.enemy, 'shock', 1, 2.6);
            payload.enemy.flags |= EnemyFlag.Platform | EnemyFlag.Anchored;
          }
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'hazard_trail',
    name: 'Scorched Path',
    family: 'transformation',
    rarity: 'legendary',
    text: 'Your trail burns. Everything you have flown through stays dangerous for a few seconds.',
    hint: 'Draw the room. Then watch it work.',
    tags: ['fire', 'field', 'momentum', 'trail'],
    archetypes: ['momentum', 'demolition'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'tick',
        ({ dt }) => {
          const world = ctx.world();
          ctx.memory.timer = (ctx.memory.timer ?? 0) - dt;
          if (ctx.memory.timer > 0) return;
          const speed = Math.hypot(world.ball.vx, world.ball.vy);
          if (speed < 220) return;
          // Cadence scales with speed so a fast pass lays a continuous line
          // rather than a dotted one, without flooding the field list.
          ctx.memory.timer = Math.max(0.08, 0.2 - speed / 9000);
          world.spawnField('trail', world.ball.x, world.ball.y, 34, 2.4, ctx.stats().damage * 0.6 + 6);
        },
        { order: ORDER.gameplay },
      );
    },
  },
  {
    id: 'twin_split',
    name: 'Twin Split',
    family: 'transformation',
    rarity: 'legendary',
    text: 'A critical impact spawns a second ball that bounces on its own and fights for you.',
    hint: 'Critical chance is now a count of how many of you there are.',
    flat: { extraBalls: 1 },
    tags: ['swarm', 'crit', 'split'],
    archetypes: ['swarm', 'precision'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.isCrit) return;
          const world = ctx.world();
          const alive = world.projectiles.filter((p) => p.isBall && p.active).length;
          const cap = Math.round(2 + ctx.stats().extraBalls);
          if (alive >= cap) return;
          const stats = ctx.stats();
          const a = Math.atan2(impact.ny, impact.nx) + ctx.rng.range(-0.5, 0.5);
          world.spawnProjectile({
            kind: 'miniball',
            faction: 'player',
            x: impact.px + impact.nx * 8,
            y: impact.py + impact.ny * 8,
            vx: Math.cos(a) * 660,
            vy: Math.sin(a) * 660,
            radius: Math.max(5, stats.radius * 0.45),
            damage: stats.damage * 0.55,
            life: 5,
            color: '#ffd9f0',
            bounces: 14,
            gravityScale: 0.55,
            pierce: 99,
            isBall: true,
          });
          impact.effects.push('twin');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'parasite',
    name: 'Parasite',
    family: 'transformation',
    rarity: 'legendary',
    text: 'Enemies you kill leave a husk that orbits you and strikes whatever comes close.',
    hint: 'Kills become an escort. Killing faster makes it bigger.',
    tags: ['parasite', 'swarm', 'kill'],
    archetypes: ['parasite', 'swarm'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'enemyKilled',
        ({ x, y }) => {
          const world = ctx.world();
          const alive = world.projectiles.filter((p) => p.kind === 'orb' && p.faction === 'player' && p.active).length;
          if (alive >= 6) return;
          const stats = ctx.stats();
          const a = ctx.rng.range(0, Math.PI * 2);
          world.spawnProjectile({
            kind: 'orb',
            faction: 'player',
            x,
            y,
            vx: Math.cos(a) * 220,
            vy: Math.sin(a) * 220,
            radius: 9,
            damage: stats.damage * 0.5,
            life: 8,
            color: '#b0ff9a',
            homing: 2.4,
            pierce: 2,
          });
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'wall_charge',
    name: 'Accumulator',
    family: 'transformation',
    rarity: 'rare',
    text: 'Every wall you touch charges your next enemy impact by 35%. The charge does not decay.',
    hint: 'Wander the walls, then cash it in on something that matters.',
    tags: ['wall', 'charge', 'ricochet'],
    archetypes: ['ricochet', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (impact.targetKind === 'enemy' || impact.targetKind === 'boss') {
            const charge = ctx.memory.charge ?? 0;
            if (charge > 0) {
              impact.damage *= 1 + charge * 0.35;
              impact.effects.push(`charge x${charge}`);
              ctx.memory.charge = 0;
            }
          }
        },
        { order: ORDER.bounce + 20 },
      );
      ctx.on(
        'impactResolved',
        (impact) => {
          if (impact.surface === 'wall' && !impact.enemy) {
            ctx.memory.charge = Math.min(8, (ctx.memory.charge ?? 0) + 1);
          }
        },
        { order: ORDER.feedback },
      );
    },
  },
  {
    id: 'kill_flight',
    name: 'Ascension',
    family: 'transformation',
    rarity: 'rare',
    text: 'Every kill refunds an air bounce and resets your chain reset. Clear a room without landing.',
    requires: (build) => build.stats.airBounceCharges > 0,
    tags: ['air', 'kill', 'chain'],
    archetypes: ['swarm', 'trickster'],
    install: (ctx) => {
      ctx.on(
        'enemyKilled',
        () => {
          const world = ctx.world();
          const stats = ctx.stats();
          world.ball.airBounces = Math.min(stats.airBounceCharges + 1, world.ball.airBounces + 1);
          world.ball.airTime = Math.max(0, world.ball.airTime - 0.4);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'intangible',
    name: 'Intangible',
    family: 'transformation',
    rarity: 'legendary',
    text: 'While phased you pass through enemies and damage everything you pass through.',
    requires: (build) => build.stats.phaseDuration > 0,
    tags: ['phase', 'trick', 'damage'],
    archetypes: ['trickster', 'glass'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'tick',
        ({ dt }) => {
          const world = ctx.world();
          if (world.ball.phase <= 0) return;
          const stats = ctx.stats();
          for (const enemy of world.enemiesInRadius(world.ball.x, world.ball.y, world.ball.radius + 6)) {
            world.damageEnemy(enemy, stats.damage * 4 * dt, 'other', null);
          }
          world.requestEffect('intangibleTrail', world.ball.x, world.ball.y, world.ball.radius * 2, 1);
        },
        { order: ORDER.gameplay },
      );
    },
  },
  {
    id: 'kinetic_battery',
    name: 'Kinetic Battery',
    family: 'transformation',
    rarity: 'rare',
    text: 'All the speed you ever lose is stored. A perfect bounce spends the whole battery at once.',
    tags: ['momentum', 'charge', 'perfect'],
    archetypes: ['momentum', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactResolved',
        (impact) => {
          const lost = impact.impactSpeed - Math.hypot(impact.outVx, impact.outVy);
          if (lost > 0) ctx.memory.battery = Math.min(3000, (ctx.memory.battery ?? 0) + lost);
        },
        { order: ORDER.feedback },
      );
      ctx.on(
        'impactPre',
        (impact) => {
          if (!impact.isPerfect) return;
          const battery = ctx.memory.battery ?? 0;
          if (battery < 100) return;
          ctx.memory.battery = 0;
          impact.damage *= 1 + Math.min(3, battery / 900);
          const speed = Math.hypot(impact.outVx, impact.outVy) || 1;
          const scale = 1 + Math.min(0.9, battery / 2400);
          impact.outVx *= scale;
          impact.outVy *= scale;
          impact.effects.push('battery');
          ctx.world().requestEffect('batteryRelease', impact.px, impact.py, 150, 1);
        },
        { order: ORDER.bounce + 25 },
      );
    },
  },

  /* ----------------------------------------------------------------- curses -- */
  {
    id: 'cursed_hunger',
    name: 'Hunger',
    family: 'transformation',
    rarity: 'cursed',
    text: 'Half again as much damage on everything you do.',
    cost: 'You lose 6 integrity on entering every room, forever.',
    tags: ['curse', 'risk'],
    archetypes: ['glass'],
    mult: { damage: 1.5 },
    install: (ctx) => {
      ctx.on(
        'roomEntered',
        () => {
          const world = ctx.world();
          world.damageBall(6 * ctx.stacks(), 'curse', 0, world.ball.x, world.ball.y);
        },
        { order: ORDER.gameplay },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'cursed_swarm',
    name: 'Infestation',
    family: 'transformation',
    rarity: 'cursed',
    text: 'Shards are worth 60% more, and rooms are far more crowded.',
    cost: 'Three extra enemies spawn in every combat room.',
    tags: ['curse', 'economy', 'swarm'],
    archetypes: ['swarm'],
    mult: { shardGain: 1.6 },
    install: (ctx) => {
      ctx.on(
        'roomEntered',
        () => {
          const world = ctx.world();
          if (world.requiredKills <= 0) return;
          for (let i = 0; i < 3; i++) {
            const x = ctx.rng.range(120, world.width - 120);
            const y = ctx.rng.range(120, world.height * 0.6);
            if (world.overlapsSolid(x, y, 26)) continue;
            world.spawnEnemyById('mote', x, y);
          }
        },
        { order: ORDER.gameplay },
      );
    },
  },
  {
    id: 'cursed_fragility',
    name: 'Brittle',
    family: 'transformation',
    rarity: 'cursed',
    text: 'Critical impacts deal double their usual bonus.',
    cost: 'Everything that hits you hits twice as hard.',
    tags: ['curse', 'crit', 'risk'],
    archetypes: ['glass', 'precision'],
    mult: { critMult: 2 },
    install: (ctx) => {
      ctx.on(
        'ballDamagePre',
        (payload) => {
          payload.finalAmount *= 2;
        },
        { order: ORDER.gameplay + 10 },
      );
    },
  },
  {
    id: 'cursed_speed',
    name: 'Runaway',
    family: 'transformation',
    rarity: 'cursed',
    text: 'A far higher speed cap and much faster acceleration.',
    cost: 'Steering at speed is halved. You will hit things you did not choose.',
    tags: ['curse', 'speed', 'momentum'],
    archetypes: ['momentum'],
    mult: { maxSpeed: 1.4, airAccel: 1.25, steerAuthorityAtSpeed: 0.5 },
  },
  {
    id: 'cursed_silence',
    name: 'Silence',
    family: 'transformation',
    rarity: 'cursed',
    text: 'Double combo gain and a much slower combo decay.',
    cost: 'You can no longer see the predicted impact point.',
    tags: ['curse', 'combo', 'info'],
    archetypes: ['precision'],
    flat: { comboGain: 1 },
    mult: { comboDecayRate: 0.6 },
    install: (ctx) => {
      ctx.on(
        'tick',
        () => {
          ctx.world().prediction.valid = false;
        },
        { order: ORDER.feedback },
      );
    },
  },
];
