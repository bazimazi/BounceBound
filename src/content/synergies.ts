/**
 * Explicit synergies.
 *
 * Most combinations in Bouncebound are emergent - two upgrades that both react to
 * wall impacts simply both fire, and the player discovers that on their own. The
 * synergies in this file are the *authored* ones: specific pairs that unlock a
 * genuinely new behaviour rather than two behaviours at once.
 *
 * They exist for three reasons:
 *  - They give buildcraft a vocabulary. "Storm Chain" is something a player can
 *    plan toward and talk about.
 *  - They make a discovery announceable. The moment a synergy activates is a
 *    highlight of the run, and the journal remembers it.
 *  - They reward commitment over breadth, offsetting the offer system's built-in
 *    pressure toward variety.
 *
 * Deliberately *not* balanced to equal power. A synergy that requires two rare
 * upgrades should feel disproportionate when it lands.
 */

import type { StatModifiers } from '../sim/stats';
import type { UpgradeContext } from '../game/upgradeSystem';
import { ORDER } from '../sim/gameEvents';
import { applyStatus } from '../sim/enemyLogic';
import type { ArchetypeId } from './ids';

export interface SynergyDef {
  id: string;
  name: string;
  /** Written for the player: what new thing happens now. */
  description: string;
  requiresAll: string[];
  requiresAny?: string[];
  /** Tag thresholds, e.g. [['wall', 2]]. */
  requiresTags?: Array<[string, number]>;
  flat?: StatModifiers;
  mult?: StatModifiers;
  install?: (ctx: UpgradeContext) => void;
  archetypes?: ArchetypeId[];
}

export const SYNERGY_DEFS: SynergyDef[] = [
  {
    id: 'storm_chain',
    name: 'Storm Chain',
    description: 'Arcs follow your airborne chain: the longer you stay up, the further the lightning reaches.',
    requiresAll: ['arc_impact', 'chain_bounce'],
    archetypes: ['lightning', 'ricochet'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.chain < 2 || impact.damageDealt <= 0) return;
          const world = ctx.world();
          const stats = ctx.stats();
          const bonusJumps = Math.min(5, Math.floor(impact.chain / 2));
          if (bonusJumps <= 0) return;
          world.arcChain(
            impact.px,
            impact.py,
            bonusJumps,
            stats.lightningDamage * 0.5,
            260,
            impact,
            impact.enemy?.id,
          );
          impact.effects.push('storm-chain');
        },
        { order: ORDER.effect + 10 },
      );
    },
  },
  {
    id: 'magnetic_demolition',
    name: 'Magnetic Demolition',
    description: 'Your blasts implode first, dragging everything nearby into the centre before they detonate.',
    requiresAll: ['explosive_impact', 'magnetism'],
    archetypes: ['demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (!impact.effects.includes('explosion')) return;
          const world = ctx.world();
          // A short inward pull before the blast, which is what turns a crowd
          // into a single target.
          for (const enemy of world.enemiesInRadius(impact.px, impact.py, ctx.stats().explosionRadius * 1.9)) {
            const dx = impact.px - enemy.x;
            const dy = impact.py - enemy.y;
            const dist = Math.hypot(dx, dy) || 1;
            enemy.vx += (dx / dist) * 520;
            enemy.vy += (dy / dist) * 520;
          }
          world.requestEffect('implode', impact.px, impact.py, ctx.stats().explosionRadius * 1.9, 1);
        },
        { order: ORDER.effect - 5 },
      );
    },
  },
  {
    id: 'scorched_walls',
    name: 'Scorched Walls',
    description: 'Walls you strike keep burning. Ricochet corridors become damage over time.',
    requiresAll: ['burning_impact', 'wall_ride'],
    archetypes: ['ricochet', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'impact',
        (impact) => {
          if (impact.surface !== 'wall') return;
          const world = ctx.world();
          world.spawnField('fire', impact.px, impact.py, 58, 3.4, ctx.stats().burnDamage * 1.4);
          impact.effects.push('scorched-wall');
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'frozen_moment',
    name: 'Frozen Moment',
    description: 'A perfect bounce stops the world for an instant. Precision buys you time.',
    requiresAll: ['time_dilation', 'perfect_focus'],
    archetypes: ['precision', 'control'],
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        (impact) => {
          ctx.world().requestEffect('timeFreeze', impact.px, impact.py, 200, 0.42 + impact.perfectQuality * 0.3);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'siege_core',
    name: 'Siege Core',
    description: 'All that mass goes into the blast instead of the contact. Enormous explosions, softer hits.',
    requiresAll: ['heavy_core', 'explosive_impact'],
    archetypes: ['demolition', 'bulwark'],
    mult: { explosionRadius: 1.55, explosionDamage: 1.4, damage: 0.85 },
  },
  {
    id: 'needle',
    name: 'Needle',
    description: 'Small, fast, and lethal on contact. Nothing survives a clean hit; nothing forgives a sloppy one.',
    requiresAll: ['feather_core', 'double_bounce'],
    archetypes: ['precision', 'glass'],
    flat: { airBounceCharges: 1, critChance: 0.12 },
    mult: { critMult: 1.25 },
  },
  {
    id: 'wall_crawler',
    name: 'Wall Crawler',
    description: 'Walls hold you. Contact along a wall keeps your vertical speed instead of bleeding it away.',
    requiresAll: ['wall_ride', 'magnetism'],
    archetypes: ['ricochet', 'trickster'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (impact.surface !== 'wall') return;
          const world = ctx.world();
          // Preserve the tangential (vertical) component so a wall can be
          // climbed rather than merely bounced off.
          const along = impact.inVx * -impact.ny + impact.inVy * impact.nx;
          world.ball.scratch.wallHold = along;
          impact.reboundTag = 'preserved';
          const restitution = 0.92;
          const vn = impact.inVx * impact.nx + impact.inVy * impact.ny;
          impact.outVx = -impact.ny * along + impact.nx * -vn * restitution;
          impact.outVy = impact.nx * along + impact.ny * -vn * restitution;
        },
        { order: ORDER.bounce },
      );
    },
  },
  {
    id: 'kinetic_crit',
    name: 'Kinetic Threshold',
    description: 'Above roughly 900 units per second every impact is critical. Speed is the whole build now.',
    requiresAll: ['critical_impact', 'velocity_crit'],
    archetypes: ['momentum', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          if (impact.relativeSpeed > 900) impact.isCrit = true;
        },
        { order: ORDER.bounce + 10 },
      );
    },
  },
  {
    id: 'shatterstorm',
    name: 'Shatterstorm',
    description: 'Frozen enemies burst into shrapnel when they die, freezing whatever the shards touch.',
    requiresAll: ['frost_impact', 'explosive_impact'],
    archetypes: ['control', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'enemyKilled',
        ({ enemy, x, y }) => {
          if (enemy.status.frostTime <= 0) return;
          const world = ctx.world();
          const stats = ctx.stats();
          world.explode(x, y, stats.explosionRadius * 0.8, stats.explosionDamage * 0.7, null, 'explosion', enemy.id);
          for (const other of world.enemiesInRadius(x, y, stats.explosionRadius * 0.8)) {
            applyStatus(other, 'frost', 2, 2.2);
          }
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'conduit_network',
    name: 'Conduit Network',
    description: 'Arcs leap to breakable structures too, and every arc leaves its target shocked.',
    requiresAll: ['arc_impact', 'storm_conduit'],
    archetypes: ['lightning'],
    flat: { lightningJumps: 2 },
    install: (ctx) => {
      ctx.on(
        'enemyDamaged',
        (payload) => {
          if (payload.source !== 'lightning') return;
          applyStatus(payload.enemy, 'shock', 1, 1.4);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'blood_engine',
    name: 'Blood Engine',
    description: 'Fragile and feeding. Every kill returns far more than it should.',
    requiresAll: ['siphon_impact', 'glass_core'],
    archetypes: ['glass', 'parasite'],
    mult: { healOnKill: 2.4 },
  },
  {
    id: 'overclock',
    name: 'Overclock',
    description: 'Braking charges the core much faster, and releasing it hits like a dropped anvil.',
    requiresAll: ['momentum_storage', 'air_brake'],
    archetypes: ['momentum', 'precision'],
    install: (ctx) => {
      ctx.on(
        'impactPre',
        (impact) => {
          const ball = ctx.world().ball;
          const stored = ball.storedMomentum;
          if (stored <= 0) return;
          impact.damage *= 1 + Math.min(2.2, stored / 900);
          ball.storedMomentum = 0;
          impact.effects.push('overclock');
        },
        { order: ORDER.bounce + 20 },
      );
    },
  },
  {
    id: 'event_horizon',
    name: 'Event Horizon',
    description: 'Your singularities hold longer and pull harder. Rooms collapse toward a single point.',
    requiresAll: ['singularity', 'gravity_impact'],
    archetypes: ['control', 'demolition'],
    mult: { explosionRadius: 1.2 },
    install: (ctx) => {
      ctx.on(
        'fieldCreated',
        (field) => {
          if (field.kind !== 'singularity') return;
          field.life *= 1.8;
          field.maxLife *= 1.8;
          field.force = -Math.abs(field.force || 700) * 1.6;
          field.radius *= 1.25;
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'swarm_logic',
    name: 'Swarm Logic',
    description: 'Every shard your impacts throw off carries toxin. Many small hits beat one big one.',
    requiresAll: ['splitting_impact', 'toxic_impact'],
    archetypes: ['swarm', 'parasite'],
    install: (ctx) => {
      ctx.on(
        'enemyDamaged',
        (payload) => {
          if (payload.source !== 'projectile') return;
          applyStatus(payload.enemy, 'poison', ctx.stats().poisonDamage * 0.5, 4);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'mirror_logic',
    name: 'Mirror Logic',
    description: 'Phasing sends you back the way you came, untouchable, on your own terms.',
    requiresAll: ['reverse_bounce', 'phase_bounce'],
    archetypes: ['trickster'],
    flat: { phaseDuration: 0.25 },
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        () => {
          const ball = ctx.world().ball;
          ball.iframes = Math.max(ball.iframes, 0.6);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'living_terrain',
    name: 'Living Terrain',
    description: 'The enemies you turn into platforms detonate when they give out.',
    requiresAll: ['living_platforms', 'shockwave'],
    archetypes: ['parasite', 'demolition'],
    install: (ctx) => {
      ctx.on(
        'enemyKilled',
        ({ enemy, x, y }) => {
          if (enemy.status.shockTime <= 0) return;
          const stats = ctx.stats();
          ctx.world().explode(x, y, 96, stats.shockwavePower * 0.8, null, 'explosion', enemy.id);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'parasitic_chain',
    name: 'Parasitic Chain',
    description: 'Your husks inherit your chain: the longer you stay airborne, the harder they hit.',
    requiresAll: ['parasite', 'chain_bounce'],
    archetypes: ['parasite', 'swarm'],
    install: (ctx) => {
      ctx.on(
        'projectileSpawned',
        (projectile) => {
          if (projectile.faction !== 'player') return;
          const chain = ctx.world().ball.chain;
          projectile.damage *= 1 + Math.min(1.5, chain * 0.14);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'bulwark_protocol',
    name: 'Bulwark Protocol',
    description: 'A perfect bounce rebuilds a spent shield. Precision becomes defence.',
    requiresAll: ['carapace', 'impact_shield'],
    archetypes: ['bulwark', 'precision'],
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        () => {
          const world = ctx.world();
          const max = ctx.stats().shieldCharges;
          if (world.ball.shield >= max) return;
          if ((ctx.memory.cooldown ?? 0) > world.simTime) return;
          ctx.memory.cooldown = world.simTime + 6;
          world.ball.shield++;
          world.requestEffect('shieldRestore', world.ball.x, world.ball.y, world.ball.radius * 3, 1);
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'hazard_artist',
    name: 'Hazard Artist',
    description: 'The trail you leave scales with your speed. Draw the room, then let it burn.',
    requiresAll: ['hazard_trail'],
    requiresTags: [['momentum', 2]],
    archetypes: ['momentum', 'trickster'],
    install: (ctx) => {
      ctx.on(
        'fieldCreated',
        (field) => {
          if (field.kind !== 'trail') return;
          const speed = Math.hypot(ctx.world().ball.vx, ctx.world().ball.vy);
          field.power *= 1 + Math.min(1.8, speed / 900);
          field.radius *= 1.15;
        },
        { order: ORDER.effect },
      );
    },
  },
  {
    id: 'perfect_economy',
    name: 'Perfect Economy',
    description: 'Precision pays literally: every perfect bounce sheds shards.',
    requiresAll: ['perfect_focus', 'resource_vacuum'],
    archetypes: ['precision'],
    install: (ctx) => {
      ctx.on(
        'perfectBounce',
        (impact) => {
          const world = ctx.world();
          if ((ctx.memory.cooldown ?? 0) > world.simTime) return;
          ctx.memory.cooldown = world.simTime + 0.5;
          world.spawnPickup('shard', impact.px, impact.py, 1 + Math.round(impact.perfectQuality * 2));
        },
        { order: ORDER.effect },
      );
    },
  },
];

export const SYNERGY_BY_ID: Record<string, SynergyDef> = Object.fromEntries(SYNERGY_DEFS.map((s) => [s.id, s]));

/** Every upgrade id that participates in at least one authored synergy. */
export function synergyPartnersOf(upgradeId: string): SynergyDef[] {
  return SYNERGY_DEFS.filter((s) => s.requiresAll.includes(upgradeId) || (s.requiresAny ?? []).includes(upgradeId));
}
