/**
 * Body-family upgrades: pure trade-offs.
 *
 * Every entry here makes the ball physically different and charges for it. This
 * is the family that answers "is this powerful, but does it fit my build?" - a
 * Heavy Core is excellent with explosions and terrible with precision play, and
 * the card says so.
 *
 * Nothing in this file is an unconditional improvement. That is the point.
 */

import { ORDER } from '../../sim/gameEvents';
import type { UpgradeDef } from '../../game/upgradeSystem';

export const BODY_UPGRADES: UpgradeDef[] = [
  {
    id: 'heavy_core',
    name: 'Heavy Core',
    family: 'body',
    rarity: 'common',
    text: 'Dense and punishing. Impacts land far harder and shove everything aside.',
    cost: 'Slower to steer, lower top speed, and you lose more energy on every bounce.',
    flat: { mass: 0.9, knockback: 0.6 },
    mult: { damage: 1.3, airAccel: 0.82, maxSpeed: 0.88, restitution: 0.94 },
    maxStacks: 2,
    tags: ['body', 'heavy', 'momentum'],
    archetypes: ['demolition', 'bulwark'],
  },
  {
    id: 'feather_core',
    name: 'Feather Core',
    family: 'body',
    rarity: 'common',
    text: 'Small, quick and precise. You fit through gaps and change direction instantly.',
    cost: 'Much less integrity, and a smaller body hits fewer things per pass.',
    flat: { radius: -3 },
    mult: { airAccel: 1.35, maxSpeed: 1.15, maxHealth: 0.72, steerAuthorityAtSpeed: 1.25 },
    maxStacks: 2,
    tags: ['body', 'light', 'precision'],
    archetypes: ['precision', 'glass', 'trickster'],
  },
  {
    id: 'glass_core',
    name: 'Glass Core',
    family: 'body',
    rarity: 'uncommon',
    text: 'Enormous damage. Genuinely enormous.',
    cost: 'Half your integrity, and shields no longer form.',
    mult: { damage: 1.75, maxHealth: 0.5, shieldCharges: 0 },
    tags: ['body', 'glass', 'risk'],
    archetypes: ['glass'],
  },
  {
    id: 'dense_alloy',
    name: 'Dense Alloy',
    family: 'body',
    rarity: 'common',
    text: 'You keep almost all your speed through every surface contact.',
    cost: 'Bounces return less height, so you sit lower in the room.',
    mult: { momentumRetention: 1.2, restitution: 0.9 },
    flat: { minBounceSpeed: 60 },
    maxStacks: 2,
    tags: ['body', 'momentum', 'speed'],
    archetypes: ['momentum', 'ricochet'],
  },
  {
    id: 'rubber_shell',
    name: 'Rubber Shell',
    family: 'body',
    rarity: 'common',
    text: 'Everything is a trampoline. You will be high in the air constantly.',
    cost: 'Harder to bring down when you need to be low.',
    mult: { restitution: 1.18 },
    flat: { minBounceSpeed: 90 },
    maxStacks: 2,
    tags: ['body', 'bounce', 'air'],
    archetypes: ['ricochet', 'trickster'],
  },
  {
    id: 'overgrown_mass',
    name: 'Overgrown Mass',
    family: 'body',
    rarity: 'uncommon',
    text: 'A much larger body. You cover lanes, block projectiles by existing, and hit several enemies per pass.',
    cost: 'Steering is heavy and many gaps close to you entirely.',
    flat: { radius: 9, maxHealth: 30 },
    mult: { airAccel: 0.75, damage: 1.15 },
    tags: ['body', 'heavy'],
    archetypes: ['bulwark', 'demolition'],
  },
  {
    id: 'unstable_core',
    name: 'Unstable Core',
    family: 'body',
    rarity: 'rare',
    text: 'Your damage swings wildly on every impact, from half to triple.',
    hint: 'Average output is higher than any safe option. Variance is the cost.',
    tags: ['body', 'risk', 'crit'],
    archetypes: ['glass', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          const roll = ctx.rng.range(0.5, 3);
          impact.damage *= roll;
          if (roll > 2.3) {
            impact.effects.push('surge');
            impact.isCrit = true;
          }
        },
        { order: ORDER.bounce + 30 },
      );
    },
  },
];
