/**
 * Defence-family upgrades.
 *
 * Defence in Bouncebound is deliberately *active*. There is no flat damage
 * reduction anywhere in this file, because reducing a number does not teach
 * anything. Instead these upgrades reward reading a situation: a shield you can
 * count, a rebound that fires when you are hit, invulnerability you earn by
 * timing a bounce correctly.
 */

import { ORDER } from '../../sim/gameEvents';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const DEFENSE_UPGRADES: UpgradeDef[] = [
  {
    id: 'impact_shield',
    name: 'Impact Shield',
    family: 'defense',
    rarity: 'common',
    text: 'A charge that absorbs one hit completely, whatever it was.',
    hint: 'Countable, visible, and worth spending deliberately.',
    flat: { shieldCharges: 1 },
    maxStacks: 4,
    tags: ['shield', 'defense'],
    archetypes: ['bulwark'],
    weight: 1.3,
  },
  {
    id: 'emergency_rebound',
    name: 'Emergency Rebound',
    family: 'defense',
    rarity: 'common',
    text: 'Taking damage launches you clear of whatever hit you and briefly slows the world.',
    hint: 'Turns a mistake into an escape instead of a spiral.',
    flat: { iframeDuration: 0.25 },
    tags: ['defense', 'escape'],
    archetypes: ['bulwark', 'glass'],
    install: (ctx) => {
      ctx.on(
        'ballDamaged',
        (payload) => {
          if (payload.blocked) return;
          const world = ctx.world();
          const ball = world.ball;
          const dx = ball.x - payload.x;
          const dy = ball.y - payload.y;
          const len = Math.hypot(dx, dy) || 1;
          const power = 880;
          ball.vx = (dx / len) * power;
          ball.vy = (dy / len) * power - 220;
          world.timeScaleRequest = Math.min(world.timeScaleRequest, 0.45);
          world.requestEffect('rebound', ball.x, ball.y, ball.radius * 5, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'perfect_guard',
    name: 'Perfect Guard',
    family: 'defense',
    rarity: 'uncommon',
    text: 'Landing a perfect bounce makes you invulnerable for a full second.',
    hint: 'Skilled play becomes the defence.',
    requires: (build) => build.countTag('perfect') > 0 || build.depth >= 3,
    tags: ['perfect', 'defense', 'precision'],
    archetypes: ['precision', 'bulwark'],
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        (impact) => {
          const ball = ctx.world().ball;
          ball.iframes = Math.max(ball.iframes, 0.75 + 0.25 * impact.perfectQuality);
          ctx.world().requestEffect('guard', ball.x, ball.y, ball.radius * 4, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'damage_conversion',
    name: 'Damage Conversion',
    family: 'defense',
    rarity: 'uncommon',
    text: 'Half of every hit you take is converted into shards and combo instead of lost integrity.',
    hint: 'Makes chip damage a resource rather than a countdown.',
    tags: ['defense', 'economy'],
    archetypes: ['bulwark', 'glass'],
    install: (ctx) => {
      ctx.on(
        'ballDamagePre',
        (payload) => {
          const converted = payload.finalAmount * 0.5;
          payload.finalAmount -= converted;
          const world = ctx.world();
          world.spawnPickup('shard', world.ball.x, world.ball.y, Math.max(1, Math.round(converted * 0.4)));
        },
        { order: ORDER.gameplay - 5 },
      );
    },
  },
  {
    id: 'reforge',
    name: 'Reforge',
    family: 'defense',
    rarity: 'rare',
    text: 'The first time you would be destroyed, you reassemble at 40% integrity instead.',
    flat: { reviveCharges: 1 },
    maxStacks: 2,
    tags: ['defense', 'revive'],
    archetypes: ['bulwark'],
    noShop: false,
  },
  {
    id: 'carapace',
    name: 'Carapace',
    family: 'defense',
    rarity: 'common',
    text: 'A heavier shell: far more integrity and a wider body that hits more things at once.',
    cost: 'Bigger and slower to steer. Tight gaps stop being options.',
    flat: { maxHealth: 45, radius: 4 },
    mult: { airAccel: 0.88, maxSpeed: 0.95 },
    maxStacks: 3,
    tags: ['body', 'defense', 'heavy'],
    archetypes: ['bulwark'],
  },
  {
    id: 'kinetic_absorption',
    name: 'Kinetic Absorption',
    family: 'defense',
    rarity: 'uncommon',
    text: 'While you are moving fast, hazards cannot touch you at all.',
    cost: 'Only works above 800 units per second. Slow down and you are exposed.',
    hint: 'Momentum builds become genuinely hard to kill.',
    tags: ['defense', 'momentum', 'speed'],
    archetypes: ['momentum'],
    install: (ctx) => {
      ctx.on(
        'ballDamagePre',
        (payload) => {
          if (payload.sourceKind !== 'hazard' && payload.sourceKind !== 'field') return;
          const ball = ctx.world().ball;
          if (Math.hypot(ball.vx, ball.vy) < 800) return;
          payload.blocked = true;
          payload.blockedBy = 'absorption';
          ctx.world().requestEffect('absorb', ball.x, ball.y, ball.radius * 3, 1);
        },
        { order: ORDER.gameplay - 10 },
      );
    },
  },
  {
    id: 'last_stand',
    name: 'Last Stand',
    family: 'defense',
    rarity: 'rare',
    text: 'Below a quarter integrity you deal 60% more damage and recover on every kill.',
    hint: 'A comeback mechanic, not a plan.',
    flat: { healOnKill: 4 },
    tags: ['defense', 'glass', 'comeback'],
    archetypes: ['glass'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          const ball = ctx.world().ball;
          if (ball.hp / ball.maxHp > 0.25) return;
          impact.damage *= 1.6;
          impact.effects.push('desperate');
        },
        { order: ORDER.bounce },
      );
    },
  },
];
