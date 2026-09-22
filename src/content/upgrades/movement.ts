/**
 * Movement-family upgrades.
 *
 * These grant verbs. A movement upgrade should let the player reach somewhere or
 * survive something they previously could not, and the cost is almost always
 * paid in commitment: a dash spends a charge, a brake spends momentum, a stored
 * charge has to be released at the right moment.
 */

import { ORDER } from '../../sim/gameEvents';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const MOVEMENT_UPGRADES: UpgradeDef[] = [
  {
    id: 'air_dash',
    name: 'Air Dash',
    family: 'movement',
    rarity: 'common',
    text: 'A burst of speed in the direction you aim. One charge, refreshed on landing.',
    hint: 'The single best answer to "I am not going to make it".',
    flat: { airDashCharges: 1 },
    maxStacks: 3,
    tags: ['dash', 'air', 'movement'],
    archetypes: ['trickster', 'momentum'],
    weight: 1.4,
  },
  {
    id: 'dash_cascade',
    name: 'Dash Cascade',
    family: 'movement',
    rarity: 'uncommon',
    text: 'Killing anything refunds a dash charge.',
    hint: 'In a crowded room you effectively fly.',
    evolvesFrom: 'air_dash',
    flat: { airDashCharges: 1, airDashPower: 90 },
    tags: ['dash', 'air', 'movement', 'kill'],
    archetypes: ['trickster', 'swarm'],
    install: (ctx) => {
      ctx.on(
        'enemyKilled',
        () => {
          const world = ctx.world();
          const stats = ctx.stats();
          if (world.ball.airDashes < stats.airDashCharges) world.ball.airDashes++;
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'air_brake',
    name: 'Air Brake',
    family: 'movement',
    rarity: 'common',
    text: 'Hold brake to kill your speed and regain full steering authority.',
    cost: 'Speed is damage. Braking costs you both.',
    flat: { airBrakePower: 4.5, steerAuthorityAtSpeed: 0.12 },
    maxStacks: 2,
    tags: ['control', 'brake', 'precision'],
    archetypes: ['precision', 'control'],
  },
  {
    id: 'directional_boost',
    name: 'Directional Boost',
    family: 'movement',
    rarity: 'uncommon',
    text: 'A perfect bounce launches you toward where you are aiming, not where the surface points.',
    hint: 'Precision play becomes free routing.',
    tags: ['perfect', 'movement', 'aim'],
    archetypes: ['precision', 'trickster'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (!impact.isPerfect) return;
          const world = ctx.world();
          const ax = world.lastAimX;
          const ay = world.lastAimY;
          const len = Math.hypot(ax, ay);
          if (len < 0.01) return;
          const speed = Math.max(Math.hypot(impact.outVx, impact.outVy), 620);
          impact.outVx = (ax / len) * speed;
          impact.outVy = (ay / len) * speed;
          impact.reboundTag = 'redirected';
          impact.effects.push('boost');
        },
        { order: ORDER.bounce + 15 },
      );
    },
  },
  {
    id: 'momentum_storage',
    name: 'Momentum Storage',
    family: 'movement',
    rarity: 'uncommon',
    text: 'Braking stores the speed you give up. Your next impact spends all of it at once.',
    hint: 'Turns the defensive button into the offensive one.',
    tags: ['momentum', 'brake', 'charge'],
    archetypes: ['momentum', 'precision'],
    install: (ctx) => {
      ctx.on(
        'tick',
        ({ dt }) => {
          const world = ctx.world();
          const ball = world.ball;
          const speed = Math.hypot(ball.vx, ball.vy);
          const previous = ctx.memory.lastSpeed ?? speed;
          ctx.memory.lastSpeed = speed;
          const lost = previous - speed;
          // Only speed lost to braking counts, not speed lost to a collision.
          if (lost > 0 && world.simTime - ball.lastImpactTime > 0.08) {
            ball.storedMomentum = Math.min(1400, ball.storedMomentum + lost * 0.8 * ctx.stacks());
          }
          // Slow decay so the charge has to be used reasonably soon.
          ball.storedMomentum = Math.max(0, ball.storedMomentum - dt * 120);
        },
        { order: ORDER.gameplay },
      );
      ctx.on(
        'impactPre',
        (impact) => {
          const ball = ctx.world().ball;
          if (ball.storedMomentum < 60) return;
          impact.damage *= 1 + Math.min(1.6, ball.storedMomentum / 1100);
          const speed = Math.hypot(impact.outVx, impact.outVy) || 1;
          const boost = 1 + Math.min(0.8, ball.storedMomentum / 1600);
          impact.outVx = (impact.outVx / speed) * speed * boost;
          impact.outVy = (impact.outVy / speed) * speed * boost;
          ball.storedMomentum = 0;
          impact.effects.push('release');
        },
        { order: ORDER.bounce + 25 },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'midair_reversal',
    name: 'Midair Reversal',
    family: 'movement',
    rarity: 'uncommon',
    text: 'Air bounces also flip your horizontal direction, at full speed.',
    hint: 'Lets you re-enter a fight you just left.',
    requires: (build) => build.stats.airBounceCharges > 0,
    tags: ['air', 'trick', 'movement'],
    archetypes: ['trickster'],
    install: (ctx) => {
      ctx.on(
        'abilityUsed',
        ({ kind }) => {
          if (kind !== 'airBounce') return;
          const ball = ctx.world().ball;
          ball.vx = -ball.vx * 1.08;
          ctx.world().requestEffect('reversal', ball.x, ball.y, ball.radius * 3, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'short_teleport',
    name: 'Fold',
    family: 'movement',
    rarity: 'rare',
    text: 'Your dash becomes a fold through space: you appear ahead, keeping your speed exactly.',
    hint: 'Ignores walls, hazards and armour plates.',
    evolvesFrom: 'air_dash',
    flat: { airDashCharges: 1 },
    tags: ['dash', 'phase', 'trick'],
    archetypes: ['trickster'],
    install: (ctx) => {
      ctx.on(
        'abilityUsed',
        ({ kind }) => {
          if (kind !== 'dash') return;
          const world = ctx.world();
          const ball = world.ball;
          const speed = Math.hypot(ball.vx, ball.vy) || 1;
          const dx = ball.vx / speed;
          const dy = ball.vy / speed;
          const distance = 190;
          const targetX = ball.x + dx * distance;
          const targetY = ball.y + dy * distance;
          // Only fold into legal space; otherwise the dash behaves normally.
          if (!world.overlapsSolid(targetX, targetY, ball.radius + 2)) {
            world.requestEffect('foldOut', ball.x, ball.y, 70, 1);
            ball.x = targetX;
            ball.y = targetY;
            ball.phase = Math.max(ball.phase, 0.12);
            world.requestEffect('foldIn', ball.x, ball.y, 70, 1);
          }
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'gravity_flip',
    name: 'Gravity Flip',
    family: 'movement',
    rarity: 'rare',
    text: 'An air bounce inverts gravity for a moment. Ceilings become floors.',
    hint: 'Changes which half of the room you live in.',
    requires: (build) => build.stats.airBounceCharges > 0,
    tags: ['air', 'gravity', 'trick'],
    archetypes: ['trickster', 'control'],
    install: (ctx) => {
      ctx.on(
        'abilityUsed',
        ({ kind }) => {
          if (kind !== 'airBounce') return;
          const world = ctx.world();
          world.gravityFlipTimer = 1.3;
          world.requestEffect('gravityFlip', world.ball.x, world.ball.y, 160, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'glide_vanes',
    name: 'Glide Vanes',
    family: 'movement',
    rarity: 'common',
    text: 'Much stronger vertical steering. You can fight gravity directly now.',
    cost: 'Slightly lower impact damage: control is not free.',
    flat: { airAccelVertical: 900 },
    mult: { damage: 0.94 },
    maxStacks: 2,
    tags: ['control', 'air', 'movement'],
    archetypes: ['control', 'precision'],
  },
  {
    id: 'kinetic_dive',
    name: 'Kinetic Dive',
    family: 'movement',
    rarity: 'common',
    text: 'Diving pulls you down far harder, and diving impacts hit for 30% more.',
    hint: 'Hold down. Commit.',
    flat: { diveGravity: 1.4 },
    maxStacks: 2,
    tags: ['dive', 'momentum', 'speed'],
    archetypes: ['momentum', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          // A diving impact is one arriving steeply downward at speed.
          if (impact.inVy < 600) return;
          impact.damage *= 1 + 0.3 * ctx.stacks();
          impact.effects.push('dive');
        },
        { order: ORDER.bounce },
      );
    },
  },
];
