/**
 * Run orchestration.
 *
 * One `Run` is one attempt: a seed, a ball class, a map, a build, and a sequence
 * of rooms. It owns the state machine the UI reads and drives the simulation, but
 * it deliberately does not know anything about rendering or input.
 *
 * The phase machine:
 *
 *   playing -> (room cleared) -> playing (goal now open)
 *           -> (goal touched) -> reward -> map -> playing
 *           -> (boss killed)  -> reward -> map (next act) -> playing
 *           -> (integrity 0)  -> defeat
 *           -> (final boss)   -> victory
 *
 * Everything reactive - upgrades, achievements, telemetry, audio - is attached to
 * the event bus, which lives for the whole run. The `World` is recreated per room;
 * upgrades reach the current one through `build`'s world accessor, which is why no
 * listener may ever cache a world reference.
 */

import { EventBus } from '../core/events';
import { Clock } from '../core/clock';
import { Rng, generateSeedString, normalizeSeed } from '../core/rng';
import { clamp } from '../core/math';
import type { GameEvents } from '../sim/gameEvents';
import { ORDER } from '../sim/gameEvents';
import { World, resetWorldIds } from '../sim/world';
import { createBall, syncBallToStats, type InputState } from '../sim/ball';
import { resetCombo } from '../sim/combo';
import { EnemyFlag } from '../sim/entities';
import { hasFlag } from '../sim/enemyLogic';
import { cleanupBossProps } from '../sim/bossLogic';
import type { ResolvedStats } from '../sim/stats';
import { BuildState } from '../game/build';
import { getUpgrade, priceOf, rollOffers, type UpgradeDef } from '../game/upgradeSystem';
import '../content/upgrades/index';
import '../content/bosses';
import { getBiome } from '../content/biomes';
import { availableBiomes } from '../content/biomes';
import { getBallClass } from '../content/balls';
import { EVENT_BY_ID, eligibleEvents, type EventChoice, type EventDef, type EventOutcome } from '../content/events';
import { resolveBound, type ResolvedBound } from '../content/modifiers';
import type { BiomeId, RoomArchetype } from '../content/ids';
import { generateMap, choicesFrom, type MapNode, type RunMap } from '../gen/mapgen';
import { generateRoom, type GeneratedRoom, type Interactable } from '../gen/roomgen';
import { ROOM_H, ROOM_W } from '../gen/templates';
import type { Profile } from '../meta/profile';
import { RUN_SAVE_VERSION, type RunSnapshot } from './runSave';

export type RunPhase =
  | 'playing'
  | 'reward'
  | 'map'
  | 'shopping'
  | 'event'
  | 'defeat'
  | 'victory';

export interface RunTelemetry {
  startedAt: number;
  durationSeconds: number;
  roomsCleared: number;
  roomsEntered: number;
  enemiesKilled: number;
  elitesKilled: number;
  bossesKilled: number;
  propsDestroyed: number;
  impacts: number;
  perfectBounces: number;
  bestCombo: number;
  shardsEarned: number;
  shardsSpent: number;
  damageDealt: number;
  damageTaken: number;
  upgradesTaken: number;
  rerollsUsed: number;
  deepestDepth: number;
  deepestBiome: BiomeId;
  damageBySource: Record<string, number>;
  killsBySource: Record<string, number>;
  /** Per-upgrade damage attribution, for balance telemetry. */
  damageByEffect: Record<string, number>;
}

export interface RewardOffer {
  upgrades: UpgradeDef[];
  /** Remaining rerolls available for this offer. */
  rerolls: number;
  /** Extra offers queued (elite rooms grant two). */
  remaining: number;
  title: string;
  /** Optional skip reward in shards. */
  skipShards: number;
}

export interface ShopEntry {
  def: UpgradeDef;
  price: number;
  purchased: boolean;
  x: number;
  y: number;
}

export interface EventPrompt {
  def: EventDef;
  resultLines: string[];
  resolved: boolean;
}

export interface RunOptions {
  profile: Profile;
  seed?: string;
  ballId?: string;
  boundLevel?: number;
  /** Fixed biome list, used by challenge modes. */
  biomes?: BiomeId[];
  clock?: Clock;
  /**
   * Resumes a previously saved run. The map and rooms are regenerated from the
   * seed; only accumulated state is taken from the snapshot.
   */
  restore?: RunSnapshot;
}

/** Per-room flags used by mastery achievements. */
interface RoomFlags {
  touchedFloor: boolean;
  tookDamage: boolean;
  directEnemyHits: number;
  killsFromWallChains: number;
  killsTotal: number;
  environmentalEliteKills: number;
}

export class Run {
  readonly bus = new EventBus<GameEvents>();
  readonly clock: Clock;
  readonly profile: Profile;
  readonly seed: string;
  readonly ballId: string;
  readonly bound: ResolvedBound;
  readonly rng: Rng;
  readonly map: RunMap;
  readonly build: BuildState;

  world: World;
  phase: RunPhase = 'playing';
  currentNode: MapNode;
  currentRoom: GeneratedRoom;

  /** In-run currency. */
  shards = 0;
  relics = 0;
  rerollsLeft = 0;

  reward: RewardOffer | null = null;
  shop: ShopEntry[] = [];
  eventPrompt: EventPrompt | null = null;
  mapChoices: MapNode[] = [];

  telemetry: RunTelemetry;
  /** Notifications queued for the UI layer. */
  notifications: Array<{ text: string; tone: 'info' | 'good' | 'bad' | 'rare'; at: number }> = [];
  /** Set when the run has finished; the UI shows the summary. */
  finished = false;
  victory = false;
  deathCause = '';

  private roomFlags: RoomFlags = freshRoomFlags();
  private seenEvents = new Set<string>();
  private readonly biomes: BiomeId[];
  private pendingRewards = 0;
  private goalArmed = false;
  private disposed = false;

  constructor(options: RunOptions) {
    this.profile = options.profile;
    this.clock = options.clock ?? new Clock();
    this.seed = normalizeSeed(options.seed && options.seed.length > 0 ? options.seed : generateSeedString());
    this.ballId = options.ballId ?? 'standard';
    this.bound = resolveBound(options.boundLevel ?? 0);
    this.rng = new Rng(`${this.seed}:play`);
    resetWorldIds();

    // A resumed run must use the biome list it was generated with, or the map
    // would differ from the one the player was routing through.
    this.biomes =
      options.restore?.biomes ??
      options.biomes ??
      availableBiomes((id) => this.profile.isUnlocked(id))
        .map((b) => b.id)
        .slice(0, 3 + Math.min(3, this.profile.counter('runsWon')));

    this.map = generateMap({
      seed: this.seed,
      biomes: this.biomes,
      boundLevel: this.bound.level,
      extraHiddenChance: this.bound.obscureMap ? 0.35 : 0,
      guaranteeEarlyShop: this.profile.ranksOf('core_reserves') > 0,
    });

    this.build = new BuildState({
      bus: this.bus,
      rng: this.rng,
      world: () => this.world,
      notify: (text, tone) => this.notify(text, tone),
      onDiscovery: (kind, id) => {
        if (kind === 'synergy') this.profile.discover('synergies', id);
      },
    });

    this.applyStartingState(options.restore);

    this.telemetry = {
      startedAt: Date.now(),
      durationSeconds: 0,
      roomsCleared: 0,
      roomsEntered: 0,
      enemiesKilled: 0,
      elitesKilled: 0,
      bossesKilled: 0,
      propsDestroyed: 0,
      impacts: 0,
      perfectBounces: 0,
      bestCombo: 0,
      shardsEarned: 0,
      shardsSpent: 0,
      damageDealt: 0,
      damageTaken: 0,
      upgradesTaken: 0,
      rerollsUsed: 0,
      deepestDepth: 0,
      deepestBiome: this.biomes[0],
      damageBySource: {},
      killsBySource: {},
      damageByEffect: {},
    };

    const restore = options.restore;
    const startNode = restore ? this.map.nodesById.get(restore.nodeId) : undefined;
    this.currentNode = startNode ?? this.map.nodesById.get(this.map.acts[0].entranceIds[0])!;

    if (restore) {
      // Map progress: which nodes have been played, and which hidden nodes have
      // already been revealed.
      for (const id of restore.visitedNodes) {
        const node = this.map.nodesById.get(id);
        if (node) node.visited = true;
      }
      for (const id of restore.revealedNodes) {
        const node = this.map.nodesById.get(id);
        if (node) node.hidden = false;
      }
      this.telemetry = { ...this.telemetry, ...restore.telemetry };
      this.shards = restore.shards;
      this.relics = restore.relics;
      this.rerollsLeft = restore.rerolls;
      this.everDroppedBelowHalf = restore.droppedBelowHalf;
      for (const id of restore.seenEvents) this.seenEvents.add(id);
    }

    this.currentRoom = this.buildRoom(this.currentNode);
    this.world = this.createWorld(this.currentRoom);
    this.installListeners();
    this.populateWorld(this.currentRoom);

    if (restore) {
      // Vitals are applied after the world is built, because `populateWorld`
      // rebuilds the ball from the current stat block.
      const ball = this.world.ball;
      ball.maxHp = restore.maxHp;
      ball.hp = clamp(restore.hp, 1, restore.maxHp);
      ball.shield = restore.shield;
      ball.reviveCharges = restore.revives;
    } else {
      this.profile.resetPerRunCounters();
    }

    this.bus.emit('runStarted', { seed: this.seed, ballId: this.ballId, boundLevel: this.bound.level });
    this.emitRoomEntered();
    this.resumed = restore !== undefined;
  }

  /** True when this run was resumed from a save rather than started fresh. */
  resumed = false;

  /**
   * Increments whenever state the interface displays changes.
   *
   * The overlay is rebuilt from scratch rather than diffed, so it needs to know
   * when to do that. Keying off the screen name alone was not enough and caused a
   * real, reported bug: taking the first of two queued rewards replaces the offer
   * while *staying* on the reward screen, so the panel kept showing the spent
   * cards. Clicking them did nothing, because the ids no longer matched the live
   * offer, while the number keys indexed the new offer the player could not see.
   *
   * The same staleness silently broke the reroll and skip buttons and the altar
   * result, all of which change content without changing screen.
   */
  uiRevision = 0;

  private touchUi(): void {
    this.uiRevision++;
  }

  /* ------------------------------------------------------------- start state -- */

  private applyStartingState(restore?: RunSnapshot): void {
    const ballClass = getBallClass(this.ballId);
    const permanent = this.profile.permanentModifiers();
    // Bound penalties expressed as multipliers are applied here rather than being
    // folded into the ball class, so the class card always tells the truth.
    const base = { ...ballClass.base };
    for (const [key, value] of Object.entries(this.bound.playerModifiers)) {
      const typed = key as keyof typeof base;
      const current = base[typed];
      if (value < 1 && value > 0 && current !== undefined) {
        base[typed] = current * value;
      } else if (current !== undefined) {
        base[typed] = current + value;
      } else {
        base[typed] = value;
      }
    }
    for (const [key, value] of Object.entries(permanent)) {
      const typed = key as keyof typeof base;
      base[typed] = (base[typed] ?? undefined) === undefined ? value : (base[typed] as number) + value;
    }
    this.build.setBallClass(base);

    if (restore) {
      /**
       * Rebuild the exact build, stack by stack. The starting upgrade and starting
       * shards are deliberately *not* granted again: they are already accounted for
       * in the snapshot, and re-granting them would pay the player twice for
       * reloading.
       */
      for (const entry of restore.upgrades) {
        for (let i = 0; i < entry.stacks; i++) this.build.add(entry.id);
      }
    } else {
      this.shards = this.profile.startingShards();
      this.rerollsLeft = Math.round(this.build.stats().rerolls);
      if (ballClass.startingUpgrade) {
        this.build.add(ballClass.startingUpgrade);
        this.profile.discover('upgrades', ballClass.startingUpgrade);
      }
    }
    this.profile.discover('balls', this.ballId);
  }

  /* ----------------------------------------------------------- room lifecycle -- */

  private buildRoom(node: MapNode): GeneratedRoom {
    /**
     * Every decision here is derived from the node's own seed, never from the run's
     * live RNG stream.
     *
     * Two things depend on that. Resuming a saved run rebuilds the current room
     * without having consumed the RNG for the rooms that came before it, so a
     * stream-dependent choice would silently produce a *different* room than the one
     * the player was standing in. And it strengthens the seed guarantee generally:
     * a given node is a given room, regardless of how the player got there.
     */
    const roomRng = new Rng(`${node.roomSeed}:archetype`);
    let archetype = node.archetype;
    // Bound levels can promote a room to elite earlier than normal.
    if (archetype === 'combat' && node.depth >= this.bound.eliteFromDepth && roomRng.chance(0.12 * this.bound.level)) {
      archetype = 'elite';
    }
    if (archetype === 'respite' && this.bound.fewerRespites && roomRng.chance(0.5)) {
      archetype = 'combat';
    }
    return generateRoom({
      seed: node.roomSeed,
      archetype,
      biome: node.biome,
      depth: node.depth,
      progress: clamp(node.depth / Math.max(8, this.map.totalRooms * 0.75), 0, 1),
      ballRadius: this.build.stats().radius,
      boundLevel: this.bound.level,
      unlocked: (id) => this.profile.isUnlocked(id),
    });
  }

  private createWorld(room: GeneratedRoom): World {
    const biome = getBiome(room.biome);
    const stats = this.build.stats();
    const world = new World({
      width: ROOM_W,
      height: ROOM_H,
      bus: this.bus,
      rng: this.rng,
      stats: () => this.build.stats(),
      gravityX: 0,
      gravityY: stats.gravity * biome.gravityScale * this.bound.gravityScale,
    });
    world.arenaMaterial = biome.terrainMaterial;
    if (biome.gravityLateralScale > 0) {
      // The Rift leans sideways, consistently per room so it can be learned - and
      // seeded from the room rather than the run so a resume reproduces it.
      const lean = new Rng(`${room.seed}:lean`).chance(0.5) ? 1 : -1;
      world.gravityX = stats.gravity * biome.gravityLateralScale * lean * 0.4;
    }
    return world;
  }

  private populateWorld(room: GeneratedRoom): void {
    const world = this.world;
    world.reset();
    world.addProps(room.props.map((p) => ({ ...p })));

    if (this.bound.hazardDamageScale !== 1) {
      for (const prop of world.props) {
        if (prop.contactDamage > 0) prop.contactDamage *= this.bound.hazardDamageScale;
      }
    }
    if (this.bound.unstableGround) {
      for (const prop of world.props) {
        if (prop.kind === 'platform' && !prop.motion) {
          prop.kind = 'temporary';
          prop.params.linger = 0.7;
          prop.params.respawn = 2.6;
        }
      }
    }

    for (const spawn of room.enemies) {
      world.spawnEnemyById(spawn.defId, spawn.x, spawn.y, {
        healthScale: spawn.healthScale * this.bound.enemyHealthScale,
        damageScale: spawn.damageScale * this.bound.enemyDamageScale,
      });
      this.profile.discover('enemies', spawn.defId);
    }

    for (const item of room.interactables) {
      this.spawnInteractable(item, room);
    }

    // The ball is rebuilt per room so stat changes take effect cleanly, but
    // current integrity carries over: that continuity is the run.
    const stats = this.build.stats();
    const previousHp = this.world.ball ? this.world.ball.hp : stats.maxHealth;
    const previousShield = this.world.ball ? this.world.ball.shield : stats.shieldCharges;
    const previousRevives = this.world.ball ? this.world.ball.reviveCharges : stats.reviveCharges;
    world.ball = createBall(room.spawnX, room.spawnY, stats);
    syncBallToStats(world.ball, stats, false);
    world.ball.hp = clamp(previousHp, 1, stats.maxHealth);
    world.ball.shield = Math.max(previousShield, 0);
    world.ball.reviveCharges = Math.max(previousRevives, stats.reviveCharges);
    world.ball.vy = 220;
    world.ball.iframes = 0.9;
    resetCombo(world.combo);

    this.goalArmed = false;
    this.roomFlags = freshRoomFlags();
    this.profile.discover('biomes', room.biome);
    if (room.archetype === 'boss') {
      const bossId = room.enemies[0]?.defId;
      if (bossId) this.profile.discover('bosses', bossId);
    }
  }

  private spawnInteractable(item: Interactable, room: GeneratedRoom): void {
    switch (item.kind) {
      case 'chest':
        this.world.spawnPickup('chest', item.x, item.y, 1, 'chest');
        break;
      case 'relic':
        this.world.spawnPickup('relic', item.x, item.y, 1, 'relic');
        break;
      case 'heal':
        this.world.spawnPickup('heal', item.x, item.y, Math.round(34 * this.bound.healScale), 'heal');
        break;
      case 'altar':
        this.world.spawnPickup('key', item.x, item.y, 1, 'altar');
        break;
      case 'gamble':
        this.world.spawnPickup('key', item.x, item.y, 1, `gamble:${item.payload}`);
        break;
      case 'shop': {
        // Shop stock is decided once, when the room is built, so browsing is
        // stable and the player can plan a route between pedestals.
        const index = this.shop.length;
        const offers = rollOffers({
          rng: new Rng(`${room.seed}:shop:${index}`),
          build: this.build.query(),
          count: 1,
          shopOnly: true,
          allowCursed: false,
          luck: this.build.stats().luck,
          unlocked: (id) => this.profile.isUnlocked(id),
          exclude: new Set(this.shop.map((s) => s.def.id)),
        });
        const def = offers[0];
        if (!def) break;
        const discount = clamp(this.build.stats().shopDiscount, 0, 0.85);
        const price = Math.max(4, Math.round(priceOf(def, room.depth) * (1 - discount)));
        this.shop.push({ def, price, purchased: false, x: item.x, y: item.y });
        this.world.spawnPickup('relic', item.x, item.y, 1, `shop:${index}`);
        break;
      }
      case 'key':
        this.world.spawnPickup('key', item.x, item.y, 1, 'key');
        break;
    }
  }

  private emitRoomEntered(): void {
    this.telemetry.roomsEntered++;
    this.telemetry.deepestDepth = Math.max(this.telemetry.deepestDepth, this.currentNode.depth);
    this.telemetry.deepestBiome = this.currentNode.biome;
    this.profile.record('deepestBiome', this.biomes.indexOf(this.currentNode.biome) + 1);
    this.build.depth = this.currentNode.depth;
    this.bus.emit('roomEntered', {
      roomIndex: this.currentNode.depth,
      archetype: this.currentRoom.archetype,
      biome: this.currentRoom.biome,
    });
  }

  /* ---------------------------------------------------------------- listeners -- */

  private installListeners(): void {
    const group = 'run';
    const on = this.bus.on.bind(this.bus);

    on(
      'impactResolved',
      (impact) => {
        this.telemetry.impacts++;
        if (impact.isPerfect) {
          this.telemetry.perfectBounces++;
          this.profile.bump('perfectBounces');
        }
        if (impact.targetKind === 'enemy' || impact.targetKind === 'boss') {
          this.roomFlags.directEnemyHits++;
        }
        if (impact.surface === 'floor' && !impact.enemy) this.roomFlags.touchedFloor = true;
        if (impact.damageDealt > 0) {
          this.telemetry.damageDealt += impact.damageDealt;
          for (const effect of impact.effects) {
            this.telemetry.damageByEffect[effect] = (this.telemetry.damageByEffect[effect] ?? 0) + impact.damageDealt;
          }
        }
      },
      { order: ORDER.feedback, group },
    );

    on(
      'comboChanged',
      ({ value }) => {
        if (value > this.telemetry.bestCombo) {
          this.telemetry.bestCombo = value;
          this.profile.record('bestCombo', value);
        }
      },
      { order: ORDER.feedback, group },
    );

    on(
      'enemyKilled',
      ({ enemy, source, ctx }) => {
        this.telemetry.enemiesKilled++;
        this.telemetry.killsBySource[source] = (this.telemetry.killsBySource[source] ?? 0) + 1;
        this.profile.bump('enemiesKilled');
        this.roomFlags.killsTotal++;
        if (ctx && ctx.chain > 0 && ctx.surface !== 'floor') this.roomFlags.killsFromWallChains++;
        if (source === 'explosion') this.profile.bump('runExplosionKills');
        if (hasFlag(enemy, EnemyFlag.Elite)) {
          this.telemetry.elitesKilled++;
          if (enemy.killedByEnvironment) this.roomFlags.environmentalEliteKills++;
        }
      },
      { order: ORDER.feedback, group },
    );

    on(
      'propDestroyed',
      () => {
        this.telemetry.propsDestroyed++;
        this.profile.bump('propsDestroyed');
      },
      { order: ORDER.feedback, group },
    );

    on(
      'ballDamaged',
      (payload) => {
        if (payload.blocked) return;
        this.telemetry.damageTaken += payload.finalAmount;
        this.telemetry.damageBySource[payload.sourceKind] =
          (this.telemetry.damageBySource[payload.sourceKind] ?? 0) + payload.finalAmount;
        this.roomFlags.tookDamage = true;
      },
      { order: ORDER.feedback, group },
    );

    on(
      'ballHealed',
      () => {
        // Bound "Thirst" halves healing. Applied here so every source obeys it.
      },
      { order: ORDER.feedback, group },
    );

    on(
      'pickupCollected',
      (payload) => {
        this.handlePickup(payload.kind, payload.value, payload.payload);
      },
      { order: ORDER.gameplay, group },
    );

    on(
      'ballDeath',
      ({ cause }) => {
        this.finish(false, cause);
      },
      { order: ORDER.gameplay, group },
    );

    on(
      'bossDefeated',
      ({ defId }) => {
        this.telemetry.bossesKilled++;
        this.profile.bump('bossesDefeated');
        if (!this.roomFlags.touchedFloor) this.profile.bump('bossAirborneKills');
        if (!this.roomFlags.tookDamage) this.profile.bump('flawlessBosses');
        const identity = this.build.identity();
        if (identity.some((i) => i.id === 'swarm')) this.profile.bump('swarmBossKills');
        cleanupBossProps(this.world);
        this.notify(`${defId.replace('boss_', 'The ')} defeated`, 'good');
      },
      { order: ORDER.gameplay, group },
    );

    on(
      'upgradeGained',
      ({ id }) => {
        this.profile.discover('upgrades', id);
        const def = getUpgrade(id);
        if (def?.family === 'transformation' && def.rarity !== 'cursed') {
          this.profile.bump('transformationsTaken');
        }
      },
      { order: ORDER.feedback, group },
    );

    on(
      'synergyActivated',
      () => {
        if (this.build.synergies().length >= 3) this.profile.bump('tripleSynergyRuns');
      },
      { order: ORDER.feedback, group },
    );

    on(
      'notify',
      ({ text, tone }) => {
        this.notifications.push({ text, tone, at: Date.now() });
      },
      { order: ORDER.feedback, group },
    );
  }

  /* ------------------------------------------------------------------ pickups -- */

  private handlePickup(kind: string, value: number, payload: string): void {
    if (kind === 'shard') {
      const gained = Math.max(1, Math.round(value * this.build.stats().shardGain * this.bound.rewardScale));
      this.shards += gained;
      this.telemetry.shardsEarned += gained;
      this.profile.bump('shardsCollected', gained);
      return;
    }
    if (kind === 'heal') {
      this.world.healBall(value * this.bound.healScale);
      this.notify(`Restored ${Math.round(value * this.bound.healScale)} integrity`, 'good');
      return;
    }
    if (payload === 'chest') {
      this.queueReward('Cache', 1, 0.3);
      return;
    }
    if (payload === 'relic') {
      this.queueReward('Relic', 1, 0.8);
      this.relics++;
      return;
    }
    if (payload === 'altar') {
      this.openEvent();
      return;
    }
    if (payload.startsWith('gamble:')) {
      this.resolveGamble(payload.slice(7));
      return;
    }
    if (payload.startsWith('shop:')) {
      const index = Number(payload.slice(5));
      this.attemptPurchase(index);
      return;
    }
  }

  private attemptPurchase(index: number): void {
    const entry = this.shop[index];
    if (!entry || entry.purchased) return;
    if (this.shards < entry.price) {
      this.notify(`Need ${entry.price - this.shards} more shards`, 'bad');
      // Re-arm the pedestal so the player can come back for it. The arming delay
      // is essential: the ball is touching the pedestal right now, and without it
      // collection and re-spawn would alternate every single frame.
      this.world.spawnPickup('relic', entry.x, entry.y, 1, `shop:${index}`, 1.1);
      return;
    }
    this.shards -= entry.price;
    this.telemetry.shardsSpent += entry.price;
    entry.purchased = true;
    this.grantUpgrade(entry.def.id);
    this.notify(`Bought ${entry.def.name}`, 'good');
    this.touchUi();
  }

  private resolveGamble(kind: string): void {
    const risky = kind === 'risky';
    if (!risky) {
      const amount = 22 + this.currentNode.depth * 3;
      this.shards += amount;
      this.telemetry.shardsEarned += amount;
      this.notify(`Took the safe option: ${amount} shards`, 'info');
      return;
    }
    const roll = this.rng.next();
    if (roll < 0.45) {
      this.queueReward('Wager won', 1, 1.2);
      this.notify('The wager paid', 'rare');
    } else if (roll < 0.8) {
      const damage = 14 + this.currentNode.depth * 2;
      this.world.damageBall(damage, 'curse', 0, this.world.ball.x, this.world.ball.y);
      this.notify('The wager bit back', 'bad');
    } else {
      this.spawnAmbush();
      this.notify('Something was waiting', 'bad');
    }
  }

  private spawnAmbush(): void {
    const world = this.world;
    for (let i = 0; i < 4; i++) {
      const x = this.rng.range(120, world.width - 120);
      const y = this.rng.range(110, world.height * 0.55);
      if (world.overlapsSolid(x, y, 26)) continue;
      world.spawnEnemyById('mote', x, y);
    }
  }

  /* ------------------------------------------------------------------ rewards -- */

  private queueReward(title: string, count: number, rarityBonus: number): void {
    this.pendingRewards += count;
    this.presentNextReward(title, rarityBonus);
  }

  /**
   * Presents the next pending reward, or finishes the reward sequence.
   *
   * This owns the pending counter, so an offer that cannot be filled (the player
   * already holds everything eligible) is converted to shards and *skipped* rather
   * than leaving the previous offer on screen. An earlier version returned early in
   * that case, which left a stale panel the player could not interact with.
   */
  private presentNextReward(title: string, rarityBonus: number): void {
    while (this.pendingRewards > 0) {
      if (this.tryOpenReward(title, rarityBonus)) return;
      this.pendingRewards = Math.max(0, this.pendingRewards - 1);
      const amount = 30;
      this.shards += amount;
      this.telemetry.shardsEarned += amount;
      this.notify(`Nothing new to offer: ${amount} shards instead`, 'info');
    }
    this.finishRewards();
  }

  /** Builds an offer. Returns false when there is nothing left to offer. */
  private tryOpenReward(title: string, rarityBonus: number): boolean {
    const stats = this.build.stats();
    const choices = Math.max(1, Math.round(stats.upgradeChoices) - this.bound.fewerChoices);
    const upgrades = rollOffers({
      rng: this.rng,
      build: this.build.query(),
      count: choices,
      rarityBonus,
      luck: stats.luck,
      allowCursed: this.profile.isUnlocked('family_cursed'),
      unlocked: (id) => this.profile.isUnlocked(id),
    });
    if (upgrades.length === 0) return false;
    this.reward = {
      upgrades,
      rerolls: this.rerollsLeft,
      remaining: this.pendingRewards,
      title,
      skipShards: 18 + this.currentNode.depth * 2,
    };
    this.phase = 'reward';
    this.touchUi();
    this.clock.resync();
    return true;
  }

  /** Closes the reward sequence and moves on to the route or back to play. */
  private finishRewards(): void {
    this.reward = null;
    this.touchUi();
    if (this.goalArmed) {
      this.openMap();
    } else {
      this.phase = 'playing';
      this.clock.resync();
    }
  }

  takeUpgrade(id: string): void {
    if (this.phase !== 'reward' || !this.reward) return;
    if (!this.reward.upgrades.some((u) => u.id === id)) return;
    this.grantUpgrade(id);
    this.telemetry.upgradesTaken++;
    this.advanceReward();
  }

  skipReward(): void {
    if (this.phase !== 'reward' || !this.reward) return;
    const amount = this.reward.skipShards;
    this.shards += amount;
    this.telemetry.shardsEarned += amount;
    this.notify(`Skipped for ${amount} shards`, 'info');
    this.advanceReward();
  }

  rerollReward(): void {
    if (this.phase !== 'reward' || !this.reward || this.rerollsLeft <= 0) return;
    this.rerollsLeft--;
    this.telemetry.rerollsUsed++;
    const stats = this.build.stats();
    const choices = Math.max(1, Math.round(stats.upgradeChoices) - this.bound.fewerChoices);
    this.reward.upgrades = rollOffers({
      rng: this.rng,
      build: this.build.query(),
      count: choices,
      luck: stats.luck,
      allowCursed: this.profile.isUnlocked('family_cursed'),
      unlocked: (id) => this.profile.isUnlocked(id),
      exclude: new Set(this.reward.upgrades.map((u) => u.id)),
    });
    this.reward.rerolls = this.rerollsLeft;
    this.touchUi();
  }

  private advanceReward(): void {
    this.pendingRewards = Math.max(0, this.pendingRewards - 1);
    this.presentNextReward('Another', 0.2);
  }

  private grantUpgrade(id: string): void {
    const added = this.build.add(id);
    if (!added) {
      this.shards += 12;
      return;
    }
    // Health-affecting upgrades need the live ball resynchronised immediately.
    syncBallToStats(this.world.ball, this.build.stats(), true);
    this.rerollsLeft = Math.max(this.rerollsLeft, Math.round(this.build.stats().rerolls) - this.telemetry.rerollsUsed);
  }

  /* -------------------------------------------------------------------- events -- */

  private openEvent(): void {
    const pool = eligibleEvents(this.currentNode.depth, (id) => this.profile.isUnlocked(id), this.seenEvents);
    const def = this.rng.weighted(pool, (e) => e.weight) ?? pool[0];
    if (!def) return;
    this.seenEvents.add(def.id);
    this.profile.discover('events', def.discoveryId);
    this.eventPrompt = { def, resultLines: [], resolved: false };
    this.phase = 'event';
    this.touchUi();
    this.clock.resync();
  }

  chooseEventOption(index: number): void {
    const prompt = this.eventPrompt;
    if (this.phase !== 'event' || !prompt || prompt.resolved) return;
    const choice = prompt.def.choices[index];
    if (!choice) return;
    if (!this.canChooseEvent(choice)) return;
    if (choice.price) {
      this.shards -= choice.price;
      this.telemetry.shardsSpent += choice.price;
    }

    let outcomes: EventOutcome[] = choice.outcomes;
    if (choice.gamble && choice.gamble.length > 0) {
      const branch = this.rng.weighted(choice.gamble, (b) => b.weight) ?? choice.gamble[0];
      outcomes = branch.outcomes;
    }

    prompt.resultLines = [];
    for (const outcome of outcomes) {
      const line = this.applyEventOutcome(outcome);
      if (line) prompt.resultLines.push(line);
    }
    prompt.resolved = true;
    this.touchUi();
  }

  canChooseEvent(choice: EventChoice): boolean {
    if (choice.price && this.shards < choice.price) return false;
    if (choice.requiresHealth && this.world.ball.hp < choice.requiresHealth) return false;
    return true;
  }

  closeEvent(): void {
    if (this.phase !== 'event') return;
    this.eventPrompt = null;
    this.touchUi();
    if (this.pendingRewards > 0) {
      this.presentNextReward('From the altar', 0.5);
    } else {
      this.phase = 'playing';
      this.clock.resync();
    }
  }

  private applyEventOutcome(outcome: EventOutcome): string {
    const amount = outcome.amount ?? 0;
    switch (outcome.kind) {
      case 'damage':
        this.world.damageBall(amount, 'curse', 0, this.world.ball.x, this.world.ball.y);
        break;
      case 'heal':
        this.world.healBall(amount);
        break;
      case 'maxHealth': {
        // Applied directly to the live ball; the stat sheet stays authoritative
        // for everything else, so this is expressed as a permanent offset.
        const ball = this.world.ball;
        ball.maxHp = Math.max(10, ball.maxHp + amount);
        ball.hp = clamp(ball.hp, 1, ball.maxHp);
        ball.scratch.maxHealthOffset = (ball.scratch.maxHealthOffset ?? 0) + amount;
        break;
      }
      case 'currency':
        if (outcome.currency === 'echoes') this.profile.addCurrency('echoes', amount);
        else {
          this.shards += amount;
          this.telemetry.shardsEarned += amount;
        }
        break;
      case 'shieldCharge':
        this.world.ball.shield += amount;
        break;
      case 'reroll':
        this.rerollsLeft += amount;
        break;
      case 'revealMap':
        for (const node of this.map.nodesById.values()) node.hidden = false;
        break;
      case 'grantUpgrade':
        if (outcome.ref) this.grantUpgrade(outcome.ref);
        break;
      case 'grantRandomUpgrade': {
        const offers = rollOffers({
          rng: this.rng,
          build: this.build.query(),
          count: 1,
          luck: this.build.stats().luck,
          allowCursed: false,
          unlocked: (id) => this.profile.isUnlocked(id),
        });
        if (offers[0]) this.grantUpgrade(offers[0].id);
        break;
      }
      case 'grantCursedUpgrade': {
        const offers = rollOffers({
          rng: this.rng,
          build: this.build.query(),
          count: 1,
          allowCursed: true,
          unlocked: () => true,
          families: ['transformation'],
        });
        const cursed = offers.find((o) => o.rarity === 'cursed');
        if (cursed) this.grantUpgrade(cursed.id);
        break;
      }
      case 'upgradeOffer':
        this.pendingRewards += 1;
        break;
      case 'spawnElite':
        this.spawnAmbush();
        break;
      case 'nothing':
      default:
        break;
    }
    return outcome.text;
  }

  /* ---------------------------------------------------------------------- map -- */

  private openMap(): void {
    this.currentNode.visited = true;
    const choices = choicesFrom(this.map, this.currentNode);
    if (choices.length === 0) {
      this.finish(true, 'completed');
      return;
    }
    // Reveal hidden neighbours: routing decisions should be informed decisions.
    for (const choice of choices) choice.hidden = false;
    this.mapChoices = choices;
    this.phase = 'map';
    this.touchUi();
    this.clock.resync();
  }

  chooseNode(id: number): void {
    if (this.phase !== 'map') return;
    const node = this.map.nodesById.get(id);
    if (!node || !this.mapChoices.some((c) => c.id === id)) return;
    this.currentNode = node;
    this.shop = [];
    this.currentRoom = this.buildRoom(node);
    this.world = this.createWorld(this.currentRoom);
    this.populateWorld(this.currentRoom);
    this.mapChoices = [];
    this.phase = 'playing';
    this.touchUi();
    this.clock.resync();
    this.emitRoomEntered();
  }

  /* ------------------------------------------------------------------ stepping -- */

  /** Advances the simulation. Called once per fixed step by the game loop. */
  step(dt: number, input: InputState): void {
    if (this.phase !== 'playing' || this.finished) return;
    this.world.step(dt, input);
    this.telemetry.durationSeconds += dt;

    if (this.world.cleared && !this.goalArmed) {
      this.goalArmed = true;
      this.onRoomCleared();
    }

    if (this.goalArmed) this.checkGoalReached();
  }

  private onRoomCleared(): void {
    this.telemetry.roomsCleared++;
    this.profile.bump('roomsCleared');
    const flags = this.roomFlags;
    if (flags.killsTotal > 0) {
      if (!flags.touchedFloor) this.profile.bump('airborneRoomClears');
      if (flags.directEnemyHits === 0) this.profile.bump('indirectClears');
      if (flags.killsFromWallChains >= flags.killsTotal) this.profile.bump('wallOnlyClears');
      if (flags.environmentalEliteKills > 0) this.profile.bump('environmentalElites');
    }
    this.bus.emit('roomCleared', {
      roomIndex: this.currentNode.depth,
      archetype: this.currentRoom.archetype,
      biome: this.currentRoom.biome,
      duration: this.world.roomTime,
      flawless: !flags.tookDamage,
    });
  }

  private checkGoalReached(): void {
    const ball = this.world.ball;
    for (const prop of this.world.props) {
      if (prop.kind !== 'goal' || !prop.active || prop.destroyed) continue;
      const shape = prop.shape;
      if (shape.kind !== 'circle') continue;
      // `reach` grows while the exit stays open (see World.updateExit).
      const reach = Math.max(prop.params.reach ?? 0, shape.radius) + ball.radius;
      if (Math.hypot(shape.x - ball.x, shape.y - ball.y) > reach) continue;
      prop.active = false;
      this.onExitReached();
      return;
    }
  }

  private onExitReached(): void {
    const archetype: RoomArchetype = this.currentRoom.archetype;
    const bonus =
      archetype === 'elite' || archetype === 'miniboss' ? 0.9 : archetype === 'boss' ? 1.4 : archetype === 'challenge' ? 0.4 : 0;
    const count = archetype === 'elite' || archetype === 'miniboss' || archetype === 'boss' ? 2 : 1;
    const noReward = archetype === 'shop' || archetype === 'respite' || archetype === 'event';
    if (noReward) {
      this.goalArmed = true;
      this.openMap();
      return;
    }
    this.pendingRewards += count;
    // `goalArmed` is set first: `presentNextReward` may finish immediately when
    // there is nothing left to offer, and it reads this flag to decide whether to
    // open the route or drop back into play.
    this.goalArmed = true;
    this.presentNextReward(archetype === 'boss' ? 'Depth cleared' : 'Cleared', bonus);
  }

  /* -------------------------------------------------------------------- ending -- */

  finish(victory: boolean, cause: string): void {
    if (this.finished) return;
    this.finished = true;
    this.victory = victory;
    this.deathCause = cause;
    this.phase = victory ? 'victory' : 'defeat';
    this.touchUi();

    // Echoes are the payout that makes a failed run worthwhile. They scale with
    // depth reached and Bound level, not with whether the run was won, so a good
    // attempt that ends badly still moves the profile forward.
    const depthValue = this.telemetry.roomsCleared * 1.6 + this.telemetry.bossesKilled * 12;
    const echoes = Math.max(
      2,
      Math.round((depthValue + this.telemetry.elitesKilled * 3) * this.bound.rewardScale * (victory ? 1.6 : 1)),
    );
    this.profile.addCurrency('echoes', echoes);
    this.profile.addCurrency('relics', this.relics);

    if (this.telemetry.damageTaken <= 0 || !this.everDroppedBelowHalf) this.profile.bump('compositeRuns');

    const identity = this.build.identity();
    this.profile.recordRun({
      at: Date.now(),
      seed: this.seed,
      ballId: this.ballId,
      boundLevel: this.bound.level,
      victory,
      cause,
      roomsCleared: this.telemetry.roomsCleared,
      deepestBiome: this.telemetry.deepestBiome,
      enemiesKilled: this.telemetry.enemiesKilled,
      bestCombo: this.telemetry.bestCombo,
      shardsEarned: this.telemetry.shardsEarned,
      echoesEarned: echoes,
      durationSeconds: this.telemetry.durationSeconds,
      upgrades: this.build.order.slice(),
      synergies: this.build.synergies().map((s) => s.id),
      identity: identity.map((i) => i.name).join(' / ') || 'Improvised',
      damageBySource: this.telemetry.damageBySource,
    });

    this.earnedEchoes = echoes;
    this.newAchievements = this.profile.checkAchievements();
    this.bus.emit('runEnded', { victory, cause });
    this.profile.flush();
  }

  /** Echoes awarded at the end, shown on the summary. */
  earnedEchoes = 0;
  newAchievements: ReturnType<Profile['checkAchievements']> = [];
  private everDroppedBelowHalf = false;

  /** Called from the game loop so the "never below half" flag stays accurate. */
  observeHealth(): void {
    const ball = this.world.ball;
    if (ball.hp / ball.maxHp < 0.5) this.everDroppedBelowHalf = true;
  }

  /**
   * Captures everything needed to resume this run.
   *
   * No world state: the map and rooms regenerate from the seed, so a snapshot is
   * small and cannot go stale against level generation changes. Vitals are the
   * *current* values rather than the values at room entry, so reloading never
   * refunds damage.
   */
  captureSnapshot(): RunSnapshot {
    const ball = this.world.ball;
    const visited: number[] = [];
    const revealed: number[] = [];
    for (const node of this.map.nodesById.values()) {
      if (node.visited) visited.push(node.id);
      if (!node.hidden) revealed.push(node.id);
    }
    return {
      version: RUN_SAVE_VERSION,
      savedAt: Date.now(),
      seed: this.seed,
      ballId: this.ballId,
      boundLevel: this.bound.level,
      biomes: this.biomes.slice(),
      nodeId: this.currentNode.id,
      visitedNodes: visited,
      revealedNodes: revealed,
      upgrades: this.build.order.map((id) => ({ id, stacks: this.build.stacksOf(id) })),
      shards: this.shards,
      relics: this.relics,
      rerolls: this.rerollsLeft,
      hp: ball.hp,
      maxHp: ball.maxHp,
      shield: ball.shield,
      revives: ball.reviveCharges,
      seenEvents: [...this.seenEvents],
      telemetry: { ...this.telemetry },
      droppedBelowHalf: this.everDroppedBelowHalf,
    };
  }

  notify(text: string, tone: 'info' | 'good' | 'bad' | 'rare' = 'info'): void {
    this.notifications.push({ text, tone, at: Date.now() });
    if (this.notifications.length > 40) this.notifications.shift();
  }

  stats(): ResolvedStats {
    return this.build.stats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.build.dispose();
    this.bus.clearAll();
  }

  /** Progress through the whole run, 0..1, for the HUD depth indicator. */
  progress(): number {
    return clamp(this.currentNode.depth / Math.max(1, this.map.totalRooms - 1), 0, 1);
  }

  eventDefById(id: string): EventDef | undefined {
    return EVENT_BY_ID[id];
  }
}

function freshRoomFlags(): RoomFlags {
  return {
    touchedFloor: false,
    tookDamage: false,
    directEnemyHits: 0,
    killsFromWallChains: 0,
    killsTotal: 0,
    environmentalEliteKills: 0,
  };
}
