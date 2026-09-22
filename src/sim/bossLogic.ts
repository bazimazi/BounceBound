/**
 * Boss controllers.
 *
 * Each boss is a state machine that manipulates the arena rather than a bag of
 * hit points. Two conventions keep them readable:
 *
 *  - Vulnerability is expressed through the *existing* armour arc, not a special
 *    case. Setting `armorArc` to PI makes a boss immune; setting it to 0 opens it
 *    up. That means every "when can I damage this" question is answered by the
 *    same visual language the player already learned from Platewrights.
 *  - Every dangerous action has a telegraph phase with a distinct visual, and the
 *    telegraph duration never shrinks below the player's reaction floor, even in
 *    the final phase. Later phases add *more* to read, not less time to read it.
 */

import { clamp, TAU } from '../core/math';
import { EnemyFlag, type Enemy, type Prop } from './entities';
import { hasFlag, syncEnemyShape } from './enemyLogic';
import { spikes, temporaryPlatform, platform, bouncePad, blade } from './propFactory';
import { BOSS_BY_ID, type BossDef } from '../content/bosses';
import type { EnemyDef } from '../content/enemies';
import type { World } from './world';

export function updateBossBehavior(world: World, enemy: Enemy, def: EnemyDef, dt: number): void {
  switch (def.ai) {
    case 'bossMirror':
      updateMirror(world, enemy, def as BossDef, dt);
      break;
    case 'bossCrusher':
      updateCrusher(world, enemy, def as BossDef, dt);
      break;
    case 'bossArchitect':
      updateArchitect(world, enemy, def as BossDef, dt);
      break;
    case 'bossPart':
      updatePart(world, enemy, dt);
      break;
    default:
      break;
  }
}

/** Advances the phase when health crosses a threshold. Returns true on change. */
function updatePhase(world: World, enemy: Enemy, def: BossDef): boolean {
  const fraction = enemy.hp / enemy.maxHp;
  let target = 0;
  for (let i = 0; i < def.phaseThresholds.length; i++) {
    if (fraction <= def.phaseThresholds[i]) target = i + 1;
  }
  if (target === enemy.phase) return false;
  enemy.phase = target;
  enemy.stateTime = 0;
  // A phase change always includes a readable pause so the player can register
  // that the rules just changed.
  enemy.scratch.phaseIntro = 1.4;
  world.requestEffect('bossPhase', enemy.x, enemy.y, enemy.radius * 4, 1);
  world.bus.emit('bossPhase', { enemy, phase: target });
  return true;
}

function partsOf(world: World, parentId: number, defId?: string): Enemy[] {
  const out: Enemy[] = [];
  for (const e of world.enemies) {
    if (e.dead || e.parentId !== parentId) continue;
    if (defId && e.defId !== defId) continue;
    out.push(e);
  }
  return out;
}

function clearOwnedProps(world: World, tag: string): void {
  for (const prop of world.props) {
    if (prop.tags.includes(tag)) prop.destroyed = true;
  }
  world.rebuildPropGrid();
}

/* ------------------------------------------------------------- The Mirror -- */

/**
 * The Mirror: a reflection puzzle.
 *
 * A shell of reflecting panels orbits the core, and the core's armour leaves a
 * single rotating gap. Hitting a panel gives your velocity straight back, so the
 * fight is about *arriving at the gap on the correct vector* rather than about
 * output. Later phases spin the gap faster and add wall-bouncing volleys, so the
 * player has to solve the same geometry under pressure.
 */
function updateMirror(world: World, enemy: Enemy, def: BossDef, dt: number): void {
  updatePhase(world, enemy, def);
  if (enemy.scratch.init !== 1) {
    enemy.scratch.init = 1;
    enemy.scratch.homeX = enemy.x;
    enemy.scratch.homeY = enemy.y;
    const panels = 4;
    for (let i = 0; i < panels; i++) {
      const part = world.spawnEnemyById('mirror_panel', enemy.x, enemy.y, { parentId: enemy.id, generation: 1 });
      part.scratch.orbitAngle = (i / panels) * TAU;
      part.scratch.orbitRadius = 128;
    }
  }

  if (enemy.scratch.phaseIntro > 0) {
    enemy.scratch.phaseIntro = Math.max(0, enemy.scratch.phaseIntro - dt);
    enemy.armorArc = Math.PI;
    return;
  }

  const spin = (def.params.shellSpin ?? 0.55) * (1 + enemy.phase * 0.45);
  enemy.scratch.shellAngle = (enemy.scratch.shellAngle ?? 0) + spin * dt;

  // The gap sits opposite the armour direction, so rotating the armour rotates
  // the opening the player must thread.
  enemy.armorArc = def.armorArc - enemy.phase * 0.18;
  enemy.armorAngle = enemy.scratch.shellAngle + Math.PI;

  // Panels orbit with the shell, one quarter turn offset from the gap.
  const panels = partsOf(world, enemy.id, 'mirror_panel');
  for (let i = 0; i < panels.length; i++) {
    const part = panels[i];
    const a = enemy.scratch.shellAngle + part.scratch.orbitAngle;
    const radius = part.scratch.orbitRadius * (1 - enemy.phase * 0.12);
    part.x = enemy.x + Math.cos(a) * radius;
    part.y = enemy.y + Math.sin(a) * radius;
    part.armorAngle = a;
    syncEnemyShape(part);
  }

  // Phase 2+: volleys that ricochet off the arena walls, filling the space the
  // player wanted to use for their approach.
  if (enemy.phase >= 1) {
    enemy.scratch.volleyTimer = (enemy.scratch.volleyTimer ?? 0) + dt;
    const interval = (def.params.volleyInterval ?? 3.4) / (1 + enemy.phase * 0.3);
    if (enemy.scratch.volleyTimer > interval) {
      enemy.scratch.volleyTimer = 0;
      const count = Math.round((def.params.volleyCount ?? 5) + enemy.phase);
      const base = enemy.scratch.shellAngle;
      for (let i = 0; i < count; i++) {
        const a = base + (i / count) * TAU;
        world.spawnProjectile({
          kind: 'shard',
          faction: 'hostile',
          x: enemy.x + Math.cos(a) * (enemy.radius + 14),
          y: enemy.y + Math.sin(a) * (enemy.radius + 14),
          vx: Math.cos(a) * (def.params.bulletSpeed ?? 300),
          vy: Math.sin(a) * (def.params.bulletSpeed ?? 300),
          radius: 7,
          damage: def.params.bulletDamage ?? 11,
          life: 5.5,
          color: def.accent,
          bounces: 2,
        });
      }
      world.requestEffect('bossVolley', enemy.x, enemy.y, enemy.radius * 3, 1);
    }
  }

  // Phase 3: echoes mirror the core across the arena centre. Only the original
  // takes damage, so the player must identify it by its behaviour.
  if (enemy.phase >= 2 && enemy.scratch.echoesSpawned !== 1) {
    enemy.scratch.echoesSpawned = 1;
    const count = Math.round(def.params.echoCount ?? 2);
    for (let i = 0; i < count; i++) {
      const echo = world.spawnEnemyById('mirror_echo', enemy.x, enemy.y, { parentId: enemy.id, generation: 1 });
      echo.scratch.echoIndex = i + 1;
    }
  }
  const echoes = partsOf(world, enemy.id, 'mirror_echo');
  for (const echo of echoes) {
    const a = enemy.scratch.shellAngle * 0.7 + (echo.scratch.echoIndex * TAU) / (echoes.length + 1);
    echo.x = world.width / 2 + Math.cos(a) * (world.width * 0.3);
    echo.y = world.height * 0.45 + Math.sin(a) * (world.height * 0.26);
    syncEnemyShape(echo);
  }

  syncEnemyShape(enemy);
}

/* ------------------------------------------------------------ The Crusher -- */

/**
 * The Crusher: a geometry fight.
 *
 * Two pistons slam shut on a schedule. The core is sealed except during the
 * recovery window right after a slam, so the player has to be *already in
 * position* when the window opens - which means committing to a trajectory while
 * the arena is still closing. Later phases add spinning blades and leave spike
 * banks behind, shrinking the set of legal routes rather than raising damage.
 */
function updateCrusher(world: World, enemy: Enemy, def: BossDef, dt: number): void {
  updatePhase(world, enemy, def);
  if (enemy.scratch.init !== 1) {
    enemy.scratch.init = 1;
    enemy.x = world.width / 2;
    enemy.y = world.height * 0.42;
    enemy.scratch.homeX = enemy.x;
    enemy.scratch.homeY = enemy.y;
    for (let i = 0; i < 2; i++) {
      const piston = world.spawnEnemyById('crusher_piston', enemy.x, enemy.y, { parentId: enemy.id, generation: 1 });
      piston.scratch.side = i === 0 ? -1 : 1;
    }
    enemy.armorArc = Math.PI;
    enemy.state = 'idle';
  }

  if (enemy.scratch.phaseIntro > 0) {
    enemy.scratch.phaseIntro = Math.max(0, enemy.scratch.phaseIntro - dt);
    enemy.armorArc = Math.PI;
    return;
  }

  const interval = (def.params.slamInterval ?? 4.2) / (1 + enemy.phase * 0.35);
  const telegraph = Math.max(0.55, 0.95 - enemy.phase * 0.12);
  const openSpan = (def.params.vulnerableWindow ?? 2.2) * (1 - enemy.phase * 0.18);
  const pistons = partsOf(world, enemy.id, 'crusher_piston');

  switch (enemy.state) {
    case 'idle':
    case 'active': {
      enemy.armorArc = Math.PI;
      // Pistons ride out wide, presenting themselves as platforms.
      setPistons(world, enemy, pistons, 250, dt);
      if (enemy.stateTime > interval) {
        enemy.state = 'telegraph';
        enemy.stateTime = 0;
        world.requestEffect('crusherWarn', enemy.x, enemy.y, 240, 1);
      }
      break;
    }
    case 'telegraph': {
      enemy.armorArc = Math.PI;
      setPistons(world, enemy, pistons, 280, dt);
      if (enemy.stateTime > telegraph) {
        enemy.state = 'attacking';
        enemy.stateTime = 0;
      }
      break;
    }
    case 'attacking': {
      // Slam: pistons converge fast, then a shockwave along the floor.
      const progress = clamp(enemy.stateTime / 0.26, 0, 1);
      setPistons(world, enemy, pistons, 250 - 190 * progress, dt, true);
      if (progress >= 1) {
        enemy.state = 'vulnerable';
        enemy.stateTime = 0;
        world.requestEffect('crusherSlam', enemy.x, world.height - 20, world.width, 1);
        world.damageArea(enemy.x, enemy.y, 150, def.params.shockDamage ?? 16, 'environment', null, {
          knockbackPower: 400,
          hurtsBall: false,
        });
        // A slam near the floor is what actually threatens the player.
        if (world.ball.y > world.height * 0.72) {
          world.damageBall(def.params.shockDamage ?? 16, 'hazard', enemy.id, world.ball.x, world.height - 10);
        }
        if (enemy.phase >= 1) {
          const x = clamp(world.ball.x + world.rng.range(-120, 120), 90, world.width - 90);
          world.addProp({ ...spikes(x, world.height - 16, 56, 14, 14), tags: ['hazard', 'crusher-debris'] });
        }
      }
      break;
    }
    case 'vulnerable': {
      // The only window. Pistons retract fully and the core opens.
      enemy.armorArc = 0;
      setPistons(world, enemy, pistons, 330, dt);
      if (enemy.stateTime > openSpan) {
        enemy.state = 'active';
        enemy.stateTime = 0;
        enemy.armorArc = Math.PI;
      }
      break;
    }
    default:
      enemy.state = 'active';
      break;
  }

  // Phase 2 installs blades; phase 3 doubles them.
  const wantBlades = enemy.phase >= 1 ? Math.round((def.params.bladeCount ?? 2) * enemy.phase) : 0;
  if ((enemy.scratch.blades ?? 0) < wantBlades) {
    const index = enemy.scratch.blades ?? 0;
    const x = index % 2 === 0 ? world.width * 0.22 : world.width * 0.78;
    const y = world.height * (0.3 + 0.28 * Math.floor(index / 2));
    world.addProp({ ...blade(x, y, 46, 0.5 + index * 0.1, 16), tags: ['hazard', 'mover', 'crusher-blade'] });
    enemy.scratch.blades = index + 1;
  }

  syncEnemyShape(enemy);
}

function setPistons(world: World, core: Enemy, pistons: Enemy[], spread: number, dt: number, slamming = false): void {
  for (const piston of pistons) {
    const targetX = core.x + piston.scratch.side * spread;
    const rate = slamming ? 1 : 0.14;
    piston.x += (targetX - piston.x) * Math.min(1, rate * (slamming ? 26 : 6) * dt);
    piston.y = core.y;
    // While retracted the piston is a safe platform; while slamming it is spiked.
    if (slamming) {
      piston.flags |= EnemyFlag.Spiked;
    } else {
      piston.flags &= ~EnemyFlag.Spiked;
    }
    syncEnemyShape(piston);
  }
  void world;
}

/* ---------------------------------------------------------- The Architect -- */

/**
 * The Architect: a surface fight.
 *
 * It rebuilds the room on a timer. Its core cannot be damaged directly off the
 * floor (the RicochetGated flag), and every rebuild invalidates the route the
 * player was using. Destroying its anchors both stuns it and permanently reduces
 * how much it can build, which makes "attack the structure, not the boss" the
 * correct read.
 */
function updateArchitect(world: World, enemy: Enemy, def: BossDef, dt: number): void {
  updatePhase(world, enemy, def);
  if (enemy.scratch.init !== 1) {
    enemy.scratch.init = 1;
    enemy.x = world.width / 2;
    enemy.y = world.height * 0.24;
    enemy.scratch.anchorsLeft = Math.round(def.params.anchorCount ?? 3);
    const count = enemy.scratch.anchorsLeft;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const anchor = world.spawnEnemyById('architect_anchor', world.width * t, world.height * 0.62, {
        parentId: enemy.id,
        generation: 1,
      });
      anchor.scratch.slot = i;
    }
    enemy.scratch.editTimer = 1.5;
  }

  if (enemy.scratch.phaseIntro > 0) {
    enemy.scratch.phaseIntro = Math.max(0, enemy.scratch.phaseIntro - dt);
    return;
  }

  const anchors = partsOf(world, enemy.id, 'architect_anchor');
  const anchorsLost = Math.round(def.params.anchorCount ?? 3) - anchors.length;
  if (anchorsLost > (enemy.scratch.anchorsLostSeen ?? 0)) {
    enemy.scratch.anchorsLostSeen = anchorsLost;
    // Losing an anchor is the player's reward: a long, unmistakable opening.
    enemy.stun = 3.2;
    world.requestEffect('architectStagger', enemy.x, enemy.y, 200, 1);
  }

  enemy.x = world.width / 2 + Math.sin(enemy.age * 0.5) * world.width * 0.18;
  enemy.y = world.height * 0.24 + Math.sin(enemy.age * 0.8) * 26;

  enemy.scratch.editTimer = (enemy.scratch.editTimer ?? 0) - dt;
  if (enemy.scratch.editTimer <= 0 && enemy.stun <= 0) {
    const interval = (def.params.editInterval ?? 5) / (1 + enemy.phase * 0.25);
    enemy.scratch.editTimer = interval;
    rebuildArchitecture(world, enemy, def, anchors.length);
  }

  // Phase 3 removes the safety of the floor: staying low becomes a cost.
  if (enemy.phase >= 2 && enemy.scratch.floorHazard !== 1) {
    enemy.scratch.floorHazard = 1;
    for (let x = 70; x < world.width - 40; x += 140) {
      world.addProp({ ...spikes(x, world.height - 14, 62, 12, 13), tags: ['hazard', 'architect-build'] });
    }
    world.requestEffect('architectDemolish', world.width / 2, world.height - 20, world.width, 1);
  }

  if (enemy.phase >= 1) {
    enemy.scratch.turretTimer = (enemy.scratch.turretTimer ?? 0) + dt;
    if (enemy.scratch.turretTimer > (def.params.turretInterval ?? 2.6)) {
      enemy.scratch.turretTimer = 0;
      const a = Math.atan2(world.ball.y - enemy.y, world.ball.x - enemy.x);
      world.spawnProjectile({
        kind: 'orb',
        faction: 'hostile',
        x: enemy.x,
        y: enemy.y + enemy.radius,
        vx: Math.cos(a) * 300,
        vy: Math.sin(a) * 300,
        radius: 9,
        damage: 12,
        life: 4,
        color: def.accent,
        homing: 0.6,
      });
    }
  }

  syncEnemyShape(enemy);
}

function rebuildArchitecture(world: World, enemy: Enemy, def: BossDef, anchorsLeft: number): void {
  clearOwnedProps(world, 'architect-build');
  world.requestEffect('architectEdit', world.width / 2, world.height / 2, world.width, 1);
  const budget = Math.max(1, anchorsLeft * 2);
  const life = def.params.platformLife ?? 6;
  for (let i = 0; i < budget; i++) {
    const x = world.rng.range(140, world.width - 140);
    const y = world.rng.range(world.height * 0.4, world.height * 0.82);
    if (world.overlapsSolid(x, y, 60)) continue;
    const spec =
      enemy.phase >= 1 && world.rng.chance(0.35)
        ? bouncePad(x, y, 54, 0.6, world.rng.range(-0.5, 0.5))
        : enemy.phase >= 2
          ? temporaryPlatform(x, y, 66, 0.6, life)
          : platform(x, y, 78, 'obsidian');
    world.addProp({ ...spec, tags: [...spec.tags, 'architect-build'] });
  }
}

/* -------------------------------------------------------------- boss parts -- */

function updatePart(world: World, enemy: Enemy, dt: number): void {
  // Parts are positioned by their parent controller; this only handles the case
  // where the parent has died, so a part never outlives the fight.
  const parent = world.enemies.find((e) => e.id === enemy.parentId && !e.dead);
  if (!parent) {
    world.killEnemy(enemy, 'other', null);
    return;
  }
  if (hasFlag(enemy, EnemyFlag.Boss) && enemy.defId === 'crusher_piston') {
    // Pistons are schedule, not target: keep them topped up so a stray
    // area-of-effect build cannot delete the fight's core mechanic.
    enemy.hp = enemy.maxHp;
  }
  void dt;
}

/** Cleans up props a boss owns; called when the fight ends. */
export function cleanupBossProps(world: World): void {
  for (const tag of ['architect-build', 'crusher-blade', 'crusher-debris']) {
    clearOwnedProps(world, tag);
  }
}

export function bossDefFor(id: string): BossDef | undefined {
  return BOSS_BY_ID[id];
}

/** Boss health bar data for the HUD. */
export function bossBarInfo(world: World): { name: string; fraction: number; phase: string } | null {
  for (const enemy of world.enemies) {
    if (enemy.dead || !hasFlag(enemy, EnemyFlag.Boss) || enemy.parentId !== 0) continue;
    const def = BOSS_BY_ID[enemy.defId];
    if (!def) continue;
    return {
      name: def.name,
      fraction: clamp(enemy.hp / enemy.maxHp, 0, 1),
      phase: def.phaseNames[enemy.phase] ?? '',
    };
  }
  return null;
}

/** Used by the debug overlay to describe a boss's current intent. */
export function describeBossState(enemy: Enemy): string {
  return `${enemy.defId} p${enemy.phase} ${enemy.state} t=${enemy.stateTime.toFixed(2)} armor=${enemy.armorArc.toFixed(2)}`;
}

export function isProp(value: unknown): value is Prop {
  return !!value && typeof value === 'object' && 'kind' in (value as Prop);
}
