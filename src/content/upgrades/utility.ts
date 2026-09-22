/**
 * Utility-family upgrades.
 *
 * Economy, information and time. These do not raise damage, so they have to earn
 * their slot by changing what the player *knows* or *chooses*: an extra reroll
 * changes which builds are reachable; room preview changes routing; time dilation
 * changes what is executable.
 */

import { ORDER } from '../../sim/gameEvents';
import { applyStatus } from '../../sim/enemyLogic';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const UTILITY_UPGRADES: UpgradeDef[] = [
  {
    id: 'magnetism',
    name: 'Magnetism',
    family: 'utility',
    rarity: 'common',
    text: 'Shards come to you from much further away.',
    flat: { magnetRadius: 130 },
    maxStacks: 3,
    tags: ['economy', 'magnet'],
    archetypes: ['control'],
    weight: 1.2,
  },
  {
    id: 'resource_vacuum',
    name: 'Resource Vacuum',
    family: 'utility',
    rarity: 'uncommon',
    text: 'Collection range covers most of the room, and every shard is worth more.',
    evolvesFrom: 'magnetism',
    flat: { magnetRadius: 420 },
    mult: { shardGain: 1.35 },
    tags: ['economy', 'magnet'],
    archetypes: ['control'],
  },
  {
    id: 'time_dilation',
    name: 'Time Dilation',
    family: 'utility',
    rarity: 'uncommon',
    text: 'The world slows as you close on a surface, giving you time to aim the bounce.',
    hint: 'The clearest quality-of-life upgrade in the game, and a real power spike for precision play.',
    flat: { timeSlowPower: 0.35 },
    maxStacks: 2,
    tags: ['time', 'control', 'precision'],
    archetypes: ['control', 'precision'],
    install: (ctx) => {
      ctx.on(
        'tick',
        () => {
          const world = ctx.world();
          const ttc = world.timeToImpact();
          const stats = ctx.stats();
          // Only near a genuine imminent contact, so the game does not spend most
          // of its time in slow motion.
          if (ttc > 0.24 || !Number.isFinite(ttc)) return;
          const strength = Math.min(0.75, stats.timeSlowPower);
          world.timeScaleRequest = Math.min(world.timeScaleRequest, 1 - strength);
        },
        { order: ORDER.gameplay },
      );
    },
  },
  {
    id: 'enemy_marking',
    name: 'Hunter Mark',
    family: 'utility',
    rarity: 'common',
    text: 'The most dangerous enemy in the room is marked and takes 30% more damage.',
    hint: 'Tells you what the room wants you to kill first.',
    tags: ['mark', 'control', 'info'],
    archetypes: ['precision', 'control'],
    install: (ctx) => {
      ctx.on(
        'tick',
        ({ dt }) => {
          ctx.memory.timer = (ctx.memory.timer ?? 0) - dt;
          if (ctx.memory.timer > 0) return;
          ctx.memory.timer = 0.5;
          const world = ctx.world();
          let best = null;
          let bestScore = -Infinity;
          for (const enemy of world.enemies) {
            if (enemy.dead) continue;
            const score = enemy.maxHp + enemy.contactDamage * 6;
            if (score > bestScore) {
              bestScore = score;
              best = enemy;
            }
          }
          if (best) applyStatus(best, 'mark', 0.3 * ctx.stacks(), 0.8);
        },
        { order: ORDER.gameplay },
      );
    },
    maxStacks: 2,
  },
  {
    id: 'loot_duplication',
    name: 'Echo Harvest',
    family: 'utility',
    rarity: 'uncommon',
    text: 'A third of everything that drops drops twice.',
    mult: { shardGain: 1.15 },
    tags: ['economy', 'luck'],
    archetypes: ['control'],
    install: (ctx) => {
      ctx.on(
        'pickupSpawned',
        (pickup) => {
          if (pickup.kind !== 'shard') return;
          if (!ctx.rng.chance(0.33)) return;
          const world = ctx.world();
          // Guard against recursion: the duplicate must not duplicate itself.
          if (ctx.memory.guard === 1) return;
          ctx.memory.guard = 1;
          world.spawnPickup('shard', pickup.x + ctx.rng.range(-12, 12), pickup.y - 8, pickup.value);
          ctx.memory.guard = 0;
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'foresight',
    name: 'Foresight',
    family: 'utility',
    rarity: 'common',
    text: 'Hidden rooms on the route are revealed, and you gain an extra reroll.',
    flat: { rerolls: 1, luck: 0.4 },
    maxStacks: 2,
    tags: ['info', 'economy', 'luck'],
    archetypes: ['control'],
  },
  {
    id: 'reroll_engine',
    name: 'Reroll Engine',
    family: 'utility',
    rarity: 'uncommon',
    text: 'Two more rerolls, and one more option on every upgrade offer.',
    hint: 'The most reliable way to actually find the build you want.',
    flat: { rerolls: 2, upgradeChoices: 1 },
    tags: ['economy', 'info', 'luck'],
    archetypes: ['control'],
  },
  {
    id: 'bargain_sense',
    name: 'Bargain Sense',
    family: 'utility',
    rarity: 'common',
    text: 'Everything in an Exchange costs 30% less.',
    flat: { shopDiscount: 0.3 },
    maxStacks: 2,
    tags: ['economy', 'shop'],
    archetypes: ['control'],
  },
  {
    id: 'shard_alchemy',
    name: 'Shard Alchemy',
    family: 'utility',
    rarity: 'uncommon',
    text: 'Collecting shards briefly raises your damage. Keep collecting to keep it up.',
    hint: 'Pairs with anything that widens collection range.',
    mult: { shardGain: 1.2 },
    tags: ['economy', 'magnet', 'momentum'],
    archetypes: ['control', 'momentum'],
    install: (ctx) => {
      ctx.on(
        'pickupCollected',
        ({ kind }) => {
          if (kind !== 'shard') return;
          const world = ctx.world();
          ctx.memory.charge = Math.min(20, (ctx.memory.charge ?? 0) + 1);
          ctx.memory.expiry = world.simTime + 4;
        },
        { order: ORDER.effect },
      );
      ctx.on(
        'impactPre',
        (impact) => {
          const world = ctx.world();
          if ((ctx.memory.expiry ?? 0) < world.simTime) {
            ctx.memory.charge = 0;
            return;
          }
          impact.damage *= 1 + (ctx.memory.charge ?? 0) * 0.02;
        },
        { order: ORDER.bounce },
      );
    },
  },
  {
    id: 'vital_exchange',
    name: 'Vital Exchange',
    family: 'utility',
    rarity: 'uncommon',
    text: 'Clearing a room restores a little integrity.',
    hint: 'Quiet, reliable, and the reason long runs are survivable.',
    tags: ['heal', 'economy'],
    archetypes: ['bulwark'],
    install: (ctx) => {
      ctx.on(
        'roomCleared',
        () => {
          ctx.world().healBall(8 * ctx.stacks());
        },
        { order: ORDER.effect },
      );
    },
    maxStacks: 3,
  },
];
