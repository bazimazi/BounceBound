/**
 * Bounce-family upgrades.
 *
 * This family modifies the act of bouncing itself: how many times you can do it,
 * what a surface gives back, and what the rebound is worth. It is the family most
 * likely to change how the player *moves*, which is why it is offered slightly
 * more often early: a run that finds its movement identity in the first three
 * rooms is a run the player understands.
 */

import { ORDER } from '../../sim/gameEvents';
import { classifySurface } from '../../sim/materials';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const BOUNCE_UPGRADES: UpgradeDef[] = [
  {
    id: 'double_bounce',
    name: 'Double Bounce',
    family: 'bounce',
    rarity: 'common',
    text: 'Press bounce in open air to rebound off nothing. Recharges when you touch the floor.',
    hint: 'Everything that rewards staying airborne gets better.',
    flat: { airBounceCharges: 1 },
    tags: ['air', 'movement', 'chain'],
    archetypes: ['trickster', 'precision'],
    weight: 1.6,
  },
  {
    id: 'triple_bounce',
    name: 'Triple Bounce',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'A second air bounce. The floor becomes optional.',
    evolvesFrom: 'double_bounce',
    flat: { airBounceCharges: 2 },
    tags: ['air', 'movement', 'chain'],
    archetypes: ['trickster', 'swarm'],
  },
  {
    id: 'perfect_focus',
    name: 'Perfect Focus',
    family: 'bounce',
    rarity: 'common',
    text: 'A wider window for perfect bounces, and a stronger rebound when you land one.',
    hint: 'The foundation of every precision build.',
    flat: { perfectWindow: 0.05, perfectPower: 0.25 },
    maxStacks: 3,
    tags: ['perfect', 'precision'],
    archetypes: ['precision'],
    weight: 1.4,
  },
  {
    id: 'chain_bounce',
    name: 'Chain Bounce',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'Each impact without touching the floor adds 14% damage. Resets when you land.',
    hint: 'Pairs with anything that keeps you in the air.',
    tags: ['chain', 'air', 'ricochet'],
    archetypes: ['ricochet', 'momentum'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (impact.chain <= 0) return;
          const perStack = 0.14 * ctx.stacks();
          impact.damage *= 1 + Math.min(2.8, impact.chain * perStack);
          if (impact.chain >= 4) impact.effects.push('chain');
        },
        { order: ORDER.bounce },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'infinite_chain',
    name: 'Infinite Chain',
    family: 'bounce',
    rarity: 'rare',
    text: 'Your chain no longer resets on the floor. Only taking damage breaks it.',
    cost: 'Chain scaling per impact is reduced.',
    evolvesFrom: 'chain_bounce',
    tags: ['chain', 'air', 'ricochet'],
    archetypes: ['ricochet', 'momentum'],
    install: (ctx) => {
      ctx.on(
        'grounded',
        () => {
          // The floor reset is what normally caps a chain. Removing it demands a
          // cost somewhere, so the per-impact rate is halved and any damage taken
          // wipes the accumulated chain entirely.
          const ball = ctx.world().ball;
          ball.chain = Math.max(ball.chain, ball.scratch.keptChain ?? 0);
        },
        { order: ORDER.engine },
      );
      ctx.on(
        'impactResolved',
        (impact) => {
          ctx.world().ball.scratch.keptChain = impact.chain + 1;
        },
        { order: ORDER.feedback },
      );
      ctx.on(
        'impactPre',
        (impact) => {
          impact.damage *= 1 + Math.min(2.8, impact.chain * 0.07);
        },
        { order: ORDER.bounce },
      );
      ctx.on(
        'ballDamaged',
        (payload) => {
          if (payload.blocked) return;
          const ball = ctx.world().ball;
          ball.chain = 0;
          ball.scratch.keptChain = 0;
        },
        { order: ORDER.gameplay },
      );
    },
  },
  {
    id: 'wall_ride',
    name: 'Wall Ride',
    family: 'bounce',
    rarity: 'common',
    text: 'Walls throw you back harder and refresh your air abilities.',
    hint: 'Look for rooms full of pillars.',
    flat: { wallBouncePower: 0.18 },
    maxStacks: 3,
    tags: ['wall', 'ricochet', 'air'],
    archetypes: ['ricochet'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.surface !== 'wall') return;
          const stats = ctx.stats();
          const ball = ctx.world().ball;
          ball.airDashes = stats.airDashCharges;
          ball.airBounces = stats.airBounceCharges;
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'ground_slam',
    name: 'Ground Slam',
    family: 'bounce',
    rarity: 'common',
    text: 'Landing hard sends a shockwave along the floor. Harder landings hit wider.',
    hint: 'Hold down to dive and the slam gets serious.',
    flat: { shockwavePower: 16 },
    maxStacks: 2,
    tags: ['floor', 'area', 'dive'],
    archetypes: ['demolition', 'bulwark'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.surface !== 'floor') return;
          if (impact.normalSpeed < 420) return;
          const stats = ctx.stats();
          const power = Math.min(2.4, impact.normalSpeed / 700);
          const radius = 110 * power * ctx.stacks();
          ctx.world().explode(
            impact.px,
            impact.py,
            radius,
            (stats.shockwavePower + stats.damage * 0.4) * power,
            impact,
            'environment',
          );
          impact.effects.push('slam');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'enemy_step',
    name: 'Enemy Step',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'Bouncing off an enemy refreshes your air abilities and grants a moment of safety.',
    hint: 'Turns a crowd into a staircase.',
    flat: { enemyBouncePower: 0.2 },
    tags: ['enemy', 'air', 'chain'],
    archetypes: ['swarm', 'trickster'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.targetKind !== 'enemy' && impact.targetKind !== 'boss') return;
          const world = ctx.world();
          const stats = ctx.stats();
          world.ball.airDashes = stats.airDashCharges;
          world.ball.airBounces = stats.airBounceCharges;
          world.ball.iframes = Math.max(world.ball.iframes, 0.16);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'infinite_momentum',
    name: 'Infinite Momentum',
    family: 'bounce',
    rarity: 'rare',
    text: 'Bounces return more energy than they take. You will not slow down again.',
    cost: 'Steering authority at speed is noticeably worse.',
    flat: { minBounceSpeed: 180 },
    mult: { restitution: 1.14, momentumRetention: 1.12, steerAuthorityAtSpeed: 0.7 },
    tags: ['momentum', 'speed'],
    archetypes: ['momentum'],
  },
  {
    id: 'reverse_bounce',
    name: 'Reverse Bounce',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'A perfect bounce sends you back exactly the way you came, at full speed.',
    hint: 'Lets you hit the same target twice from the same angle.',
    tags: ['perfect', 'trick', 'precision'],
    archetypes: ['trickster', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (!impact.isPerfect) return;
          const speed = Math.hypot(impact.inVx, impact.inVy);
          const len = Math.hypot(impact.inVx, impact.inVy) || 1;
          impact.outVx = (-impact.inVx / len) * speed;
          impact.outVy = (-impact.inVy / len) * speed;
          impact.reboundTag = 'reversed';
          impact.effects.push('reverse');
        },
        { order: ORDER.bounce + 5 },
      );
    },
  },
  {
    id: 'phase_bounce',
    name: 'Phase Bounce',
    family: 'bounce',
    rarity: 'rare',
    text: 'After a perfect bounce you become intangible briefly, passing through anything.',
    hint: 'Read carefully: intangible means you cannot bounce either.',
    flat: { phaseDuration: 0.3 },
    tags: ['perfect', 'phase', 'trick'],
    archetypes: ['trickster'],
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        () => {
          const ball = ctx.world().ball;
          ball.phase = Math.max(ball.phase, ctx.stats().phaseDuration);
          ctx.world().requestEffect('phase', ball.x, ball.y, ball.radius * 4, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'resonant_shell',
    name: 'Resonant Shell',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'Every third impact in a chain rings out, damaging everything close by.',
    tags: ['chain', 'area', 'resonance'],
    archetypes: ['ricochet', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          ctx.memory.count = (ctx.memory.count ?? 0) + 1;
          if (ctx.memory.count % 3 !== 0) return;
          const stats = ctx.stats();
          ctx.world().explode(impact.px, impact.py, 96, stats.damage * 0.9, impact, 'environment');
          ctx.world().requestEffect('resonance', impact.px, impact.py, 96, 1);
          impact.effects.push('resonance');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'angle_mastery',
    name: 'Angle Mastery',
    family: 'bounce',
    rarity: 'uncommon',
    text: 'Grazing impacts - the shallow ones - deal 55% more damage.',
    hint: 'Rewards skimming along surfaces instead of hitting them head on.',
    tags: ['angle', 'wall', 'precision'],
    archetypes: ['ricochet', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          // Shallow means a large angle from the normal.
          if (impact.incidence < 0.95) return;
          impact.damage *= 1 + 0.55 * ctx.stacks();
          impact.effects.push('graze');
        },
        { order: ORDER.bounce },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'ceiling_hunter',
    name: 'Ceiling Hunter',
    family: 'bounce',
    rarity: 'common',
    text: 'Ceilings and overhangs hit back: impacts above you deal double damage and drop you fast.',
    hint: 'Rooms with low roofs suddenly matter.',
    tags: ['ceiling', 'angle'],
    archetypes: ['ricochet', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (classifySurface(impact.nx, impact.ny) !== 'ceiling') return;
          impact.damage *= 2;
          impact.outVy = Math.abs(impact.outVy) * 1.25;
          impact.effects.push('overhead');
        },
        { order: ORDER.bounce },
      );
    },
  },
];
