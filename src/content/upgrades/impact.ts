/**
 * Impact-family upgrades.
 *
 * These attach consequences to a collision: blasts, arcs, statuses, secondary
 * projectiles. They are the family the player reads as "damage", but the design
 * rule is that each one should change *where* damage lands, not just how much.
 * Explosive hits things you did not aim at; arcs hit the thing behind the thing;
 * frost changes when you can hit at all.
 */

import { ORDER } from '../../sim/gameEvents';
import { applyStatus } from '../../sim/enemyLogic';
import { materialHasTag } from '../../sim/materials';
import type { UpgradeDef } from '../../game/upgradeSystem';

/** Impacts that actually connected with something damageable. */
function landedOnTarget(kind: string): boolean {
  return kind === 'enemy' || kind === 'boss' || kind === 'breakable';
}

export const IMPACT_UPGRADES: UpgradeDef[] = [
  {
    id: 'explosive_impact',
    name: 'Explosive Impact',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts that connect detonate, damaging and scattering everything nearby.',
    hint: 'Loves crowds, and anything that gathers them.',
    flat: { explosionRadius: 92, explosionDamage: 12 },
    maxStacks: 3,
    tags: ['explosion', 'area', 'fire'],
    archetypes: ['demolition'],
    weight: 1.5,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!landedOnTarget(impact.targetKind) || impact.damageDealt <= 0) return;
          const stats = ctx.stats();
          ctx.world().explode(
            impact.px,
            impact.py,
            stats.explosionRadius,
            stats.explosionDamage,
            impact,
            'explosion',
            impact.enemy?.id,
          );
          impact.effects.push('explosion');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'cluster_charge',
    name: 'Cluster Charge',
    family: 'impact',
    rarity: 'rare',
    text: 'Every blast throws out three smaller blasts around it.',
    evolvesFrom: 'explosive_impact',
    flat: { explosionRadius: 60, explosionDamage: 16 },
    tags: ['explosion', 'area', 'cluster'],
    archetypes: ['demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.effects.includes('explosion')) return;
          const stats = ctx.stats();
          const world = ctx.world();
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + ctx.rng.next() * 2;
            const dist = stats.explosionRadius * 0.75;
            world.explode(
              impact.px + Math.cos(a) * dist,
              impact.py + Math.sin(a) * dist,
              stats.explosionRadius * 0.55,
              stats.explosionDamage * 0.5,
              impact,
              'explosion',
            );
          }
          impact.effects.push('cluster');
        },
        { order: ORDER.effect + 5 },
      );
    },
  },
  {
    id: 'singularity',
    name: 'Singularity',
    family: 'impact',
    rarity: 'legendary',
    text: 'Every third critical impact tears a hole that drags everything in and grinds it down.',
    hint: 'Anything that raises critical chance raises how often this happens.',
    tags: ['explosion', 'gravity', 'field', 'void'],
    archetypes: ['control', 'demolition'],
    noShop: true,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.isCrit) return;
          ctx.memory.crits = (ctx.memory.crits ?? 0) + 1;
          if (ctx.memory.crits % 3 !== 0) return;
          const stats = ctx.stats();
          const field = ctx
            .world()
            .spawnField('singularity', impact.px, impact.py, 108, 2.6, stats.damage * 1.5 + 22, -820);
          ctx.world().requestEffect('singularity', field.x, field.y, field.radius, 1);
          impact.effects.push('singularity');
          ctx.notify('Singularity', 'rare');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'arc_impact',
    name: 'Arc Impact',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts throw lightning to nearby enemies, jumping between them.',
    hint: 'Metal and crystal surfaces conduct further.',
    flat: { lightningDamage: 9, lightningJumps: 2 },
    maxStacks: 3,
    tags: ['lightning', 'chain', 'conductive'],
    archetypes: ['lightning'],
    weight: 1.5,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.damageDealt <= 0 && !landedOnTarget(impact.targetKind)) return;
          const stats = ctx.stats();
          const conductive = materialHasTag(impact.material, 'conductive');
          const jumps = Math.round(stats.lightningJumps + (conductive ? 2 : 0));
          if (jumps <= 0) return;
          const hits = ctx
            .world()
            .arcChain(impact.px, impact.py, jumps, stats.lightningDamage, conductive ? 300 : 230, impact, impact.enemy?.id);
          if (hits > 0) impact.effects.push('arc');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'storm_conduit',
    name: 'Storm Conduit',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Striking a conductive surface releases lightning even when you hit nothing else.',
    hint: 'The Foundry and the Citadel are built out of this.',
    flat: { lightningDamage: 7, lightningJumps: 1 },
    tags: ['lightning', 'conductive', 'wall'],
    archetypes: ['lightning', 'ricochet'],
    requires: (build) => build.countTag('lightning') > 0,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!materialHasTag(impact.material, 'conductive')) return;
          if (impact.effects.includes('arc')) return;
          const stats = ctx.stats();
          ctx.world().arcChain(impact.px, impact.py, Math.round(stats.lightningJumps + 1), stats.lightningDamage * 0.8, 320, impact);
          impact.effects.push('conduit');
        },
        { order: ORDER.effect + 2 },
      );
    },
  },
  {
    id: 'frost_impact',
    name: 'Frost Impact',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts chill what they touch. Chilled enemies move slowly and telegraph forever.',
    hint: 'Control first, damage later.',
    flat: { frostPower: 2 },
    maxStacks: 3,
    tags: ['frost', 'control', 'status'],
    archetypes: ['control'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          const stats = ctx.stats();
          if (impact.enemy) applyStatus(impact.enemy, 'frost', stats.frostPower, 2.4);
          for (const enemy of ctx.world().enemiesInRadius(impact.px, impact.py, 70)) {
            applyStatus(enemy, 'frost', stats.frostPower * 0.5, 1.6);
          }
          if (impact.enemy) impact.effects.push('frost');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'flash_freeze',
    name: 'Flash Freeze',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Fully chilled enemies take 60% more damage and cannot be knocked away.',
    evolvesFrom: 'frost_impact',
    flat: { frostPower: 3 },
    tags: ['frost', 'control', 'status'],
    archetypes: ['control', 'precision'],
    install: (ctx) => {
      ctx.on(
        'enemyDamaged',
        (payload) => {
          if (payload.enemy.status.frost < 4) return;
          payload.finalAmount *= 1.6;
        },
        { order: ORDER.gameplay - 10 },
      );
    },
  },
  {
    id: 'burning_impact',
    name: 'Burning Impact',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts set things alight. Fire keeps working while you line up the next shot.',
    flat: { burnDamage: 11 },
    maxStacks: 3,
    tags: ['fire', 'status', 'dot'],
    archetypes: ['demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.enemy) return;
          applyStatus(impact.enemy, 'burn', ctx.stats().burnDamage, 3.2);
          impact.effects.push('burn');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'scorched_earth',
    name: 'Scorched Earth',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Striking wood, moss or flesh leaves a patch of fire behind.',
    hint: 'The Verdant Ruins burn beautifully.',
    flat: { burnDamage: 8 },
    tags: ['fire', 'field', 'scorchable'],
    archetypes: ['demolition', 'control'],
    requires: (build) => build.countTag('fire') > 0,
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!materialHasTag(impact.material, 'scorchable')) return;
          ctx.world().spawnField('fire', impact.px, impact.py, 62, 3.6, ctx.stats().burnDamage * 1.2);
          impact.effects.push('scorch');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'toxic_impact',
    name: 'Toxic Impact',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts apply stacking toxin. Many light hits outperform one heavy one.',
    hint: 'The outlet for builds that hit constantly.',
    flat: { poisonDamage: 5 },
    maxStacks: 4,
    tags: ['poison', 'status', 'dot', 'swarm'],
    archetypes: ['swarm', 'parasite'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.enemy) return;
          applyStatus(impact.enemy, 'poison', ctx.stats().poisonDamage, 4.5);
          impact.effects.push('toxin');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'shockwave',
    name: 'Shockwave',
    family: 'impact',
    rarity: 'common',
    text: 'Impacts push. Enemies are thrown clear, and props are shoved out of your path.',
    flat: { shockwavePower: 20, knockback: 0.4 },
    maxStacks: 2,
    tags: ['area', 'knockback', 'resonance'],
    archetypes: ['bulwark', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.relativeSpeed < 300) return;
          const stats = ctx.stats();
          ctx.world().damageArea(impact.px, impact.py, 118, stats.shockwavePower, 'environment', impact, {
            knockbackPower: 360 * stats.knockback,
            excludeId: impact.enemy?.id,
          });
          ctx.world().requestEffect('shockwave', impact.px, impact.py, 118, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'critical_impact',
    name: 'Critical Impact',
    family: 'impact',
    rarity: 'common',
    text: 'A real chance for any impact to hit critically, for much more damage.',
    flat: { critChance: 0.14 },
    mult: { critMult: 1.15 },
    maxStacks: 4,
    tags: ['crit', 'precision'],
    archetypes: ['precision', 'glass'],
    weight: 1.3,
  },
  {
    id: 'velocity_crit',
    name: 'Terminal Velocity',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Critical chance climbs with your speed, up to an extra 45% when you are flying.',
    hint: 'Dive before you hit. Always.',
    tags: ['crit', 'momentum', 'speed'],
    archetypes: ['momentum', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (impact.isCrit) return;
          const bonus = Math.min(0.45, Math.max(0, (impact.relativeSpeed - 450) / 1600));
          if (ctx.rng.chance(bonus * ctx.stacks())) {
            impact.isCrit = true;
            impact.damage *= ctx.stats().critMult;
          }
        },
        { order: ORDER.bounce + 10 },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'gravity_impact',
    name: 'Gravity Impact',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Impacts drag nearby enemies toward the point of contact.',
    hint: 'Sets up everything that wants a crowd.',
    tags: ['gravity', 'control', 'area'],
    archetypes: ['control', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          const world = ctx.world();
          const radius = 190;
          for (const enemy of world.enemiesInRadius(impact.px, impact.py, radius)) {
            const dx = impact.px - enemy.x;
            const dy = impact.py - enemy.y;
            const dist = Math.hypot(dx, dy) || 1;
            const force = 460 * (1 - dist / radius) * ctx.stacks();
            enemy.vx += (dx / dist) * force;
            enemy.vy += (dy / dist) * force;
          }
          world.requestEffect('gravityPulse', impact.px, impact.py, radius, 1);
        },
        { order: ORDER.effect },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'splitting_impact',
    name: 'Splitting Impact',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Each impact throws off two bouncing shards that seek out enemies.',
    flat: { extraBalls: 0 },
    tags: ['projectile', 'swarm', 'split'],
    archetypes: ['swarm'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if ((ctx.memory.cooldown ?? 0) > ctx.world().simTime) return;
          ctx.memory.cooldown = ctx.world().simTime + 0.12;
          const stats = ctx.stats();
          const count = 2 * ctx.stacks();
          for (let i = 0; i < count; i++) {
            const a = Math.atan2(impact.ny, impact.nx) + ctx.rng.range(-0.9, 0.9);
            ctx.world().spawnProjectile({
              kind: 'shard',
              faction: 'player',
              x: impact.px + impact.nx * 6,
              y: impact.py + impact.ny * 6,
              vx: Math.cos(a) * 480,
              vy: Math.sin(a) * 480,
              radius: 5,
              damage: stats.damage * 0.4,
              life: 1.6,
              color: '#ffe9a0',
              bounces: 2,
              gravityScale: 0.35,
              homing: 1.6,
            });
          }
          impact.effects.push('split');
        },
        { order: ORDER.effect },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'siphon_impact',
    name: 'Siphon Impact',
    family: 'impact',
    rarity: 'uncommon',
    text: 'Kills return a little integrity. Staying aggressive becomes staying alive.',
    flat: { healOnKill: 3 },
    maxStacks: 3,
    tags: ['heal', 'leech', 'parasite'],
    archetypes: ['parasite', 'glass'],
  },
  {
    id: 'executioner',
    name: 'Executioner',
    family: 'impact',
    rarity: 'rare',
    text: 'Impacts on enemies below a third health kill outright.',
    hint: 'Turns any chip damage into a finisher.',
    tags: ['execute', 'crit'],
    archetypes: ['precision', 'glass'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          const enemy = impact.enemy;
          if (!enemy || impact.damage <= 0) return;
          if (enemy.hp / enemy.maxHp > 0.33) return;
          impact.damage = enemy.hp + 1;
          impact.effects.push('execute');
        },
        { order: ORDER.bounce + 20 },
      );
    },
  },
];
