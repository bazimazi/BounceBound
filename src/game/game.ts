/**
 * The application.
 *
 * Owns the frame loop and the screen state machine, and is the only place where
 * simulation, rendering, audio, input, UI and persistence meet. Everything below
 * it is independent: the simulation runs headlessly in tests, the renderer only
 * reads state, and the UI only calls documented methods on `Run` and `Profile`.
 *
 * Frame order matters and is fixed:
 *   1. Sample input.
 *   2. Advance the clock, which calls the simulation zero or more times at a fixed
 *      timestep. Hit-stop and time dilation are applied here, not in the sim.
 *   3. Drain the effect requests the simulation produced (shake, hit-stop, punch).
 *   4. Update presentation (camera, particles, audio intensity).
 *   5. Draw.
 *   6. Reconcile the UI if the run's phase changed.
 */

import { Clock, FIXED_DT } from '../core/clock';
import { clamp, clamp01 } from '../core/math';
import { generateSeedString, Rng } from '../core/rng';
import { createInput } from '../sim/ball';
import { Profile } from '../meta/profile';
import type { Settings } from '../meta/settings';
import { Run } from '../run/run';
import { RunStore, type RunSnapshot } from '../run/runSave';
import { Renderer } from '../render/renderer';
import { FxSystem } from '../render/fx';
import { drawControlHints, drawHud } from '../render/hud';
import { AudioEngine } from '../audio/audio';
import { InputManager, type ActionName } from './input';
import { DebugTools } from './debug';
import { renderMainMenu, renderJournal, renderSettings, renderUnlocks, type MenuHost } from '../ui/menus';
import { renderBuild, renderEvent, renderMap, renderPause, renderResults, renderReward, type ScreenHost } from '../ui/screens';
import { clear } from '../ui/dom';
import { getBiome } from '../content/biomes';

type Screen =
  | 'menu'
  | 'playing'
  | 'reward'
  | 'map'
  | 'event'
  | 'build'
  | 'pause'
  | 'results'
  | 'settings'
  | 'journal'
  | 'unlocks';

export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly profile: Profile;
  private readonly clock = new Clock();
  private readonly fx: FxSystem;
  private readonly renderer: Renderer;
  private readonly audio: AudioEngine;
  private readonly input: InputManager;
  private readonly debug = new DebugTools();

  private run: Run | null = null;
  private screen: Screen = 'menu';
  /** Screen to return to when a nested screen closes. */
  private returnScreen: Screen = 'menu';
  /** Number of selectable options on the current screen, for number keys. */
  private optionCount = 0;
  private lastRenderedScreen: Screen | null = null;
  /** Run revision the overlay was last built from. */
  private lastRevision = -1;
  private uiDirty = true;

  private rafHandle = 0;
  private lastFrameTime = 0;
  private fps = 60;
  private readonly draft: { seed: string; ballId: string; boundLevel: number };

  private readonly runStore = new RunStore();
  /** Seconds until the next periodic run save. */
  private runSaveTimer = 0;

  /** First-run teaching state: which verbs the player has used. */
  private learned = { steer: false, bounce: false, dive: false };

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.profile = new Profile();
    this.fx = new FxSystem(this.profile.settings);
    this.renderer = new Renderer(canvas, this.profile.settings, this.fx);
    this.audio = new AudioEngine(this.profile.settings);
    this.draft = {
      seed: this.profile.data.lastSeed || generateSeedString(new Rng(Date.now())),
      ballId: this.profile.data.selectedBall,
      boundLevel: Math.min(this.profile.data.boundLevel, this.profile.maxBoundLevel()),
    };

    this.input = new InputManager(this.profile.settings, {
      canvas,
      toWorld: (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        return this.renderer.camera.screenToWorld(clientX - rect.left, clientY - rect.top, this.renderer.viewWidth, this.renderer.viewHeight);
      },
      ballPosition: () => (this.run ? { x: this.run.world.ball.x, y: this.run.world.ball.y } : { x: 0, y: 0 }),
      onFirstInteraction: () => {
        this.audio.start();
        this.audio.resume();
      },
      onAction: (action) => this.handleAction(action),
    });

    this.renderer.updateSettings(this.profile.settings);
    this.renderer.resize();
    this.applyInterfacePreferences();

    globalThis.addEventListener('resize', () => {
      this.renderer.resize();
      if (this.run) this.renderer.configureFor(this.run.world);
    });
    globalThis.addEventListener('keydown', (event) => this.handleRawKey(event));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.profile.settings.pauseOnBlur && this.screen === 'playing') this.setScreen('pause');
      if (document.hidden) this.audio.suspend();
      else this.audio.resume();
    });
    // Best-effort flush on exit, for both the profile and the in-progress run. The
    // run is also saved on every meaningful transition, so these handlers are a
    // safety net rather than the mechanism.
    const flushAll = (): void => {
      this.profile.flush();
      this.saveRun();
    };
    globalThis.addEventListener('pagehide', flushAll);
    globalThis.addEventListener('beforeunload', flushAll);

    if (this.profile.loadOutcome === 'recovered-backup' || this.profile.loadOutcome === 'recovered-staging') {
      // Tell the player rather than silently continuing from an older state.
      globalThis.setTimeout(() => {
        this.toast('Recovered your profile from a backup after an interrupted save.', 'bad');
      }, 600);
    }

    // Resume straight back into an interrupted run. A reload should be invisible,
    // so this deliberately skips the menu rather than asking for confirmation.
    const saved = this.runStore.load();
    if (saved) {
      this.resumeRun(saved);
    } else {
      this.setScreen('menu');
    }
  }

  start(): void {
    const loop = (timestamp: number): void => {
      this.frame(timestamp);
      this.rafHandle = globalThis.requestAnimationFrame(loop);
    };
    this.rafHandle = globalThis.requestAnimationFrame(loop);
  }

  stop(): void {
    globalThis.cancelAnimationFrame(this.rafHandle);
    this.input.dispose();
    this.audio.dispose();
    // Persist the run as well as the profile: shutting the game down is exactly the
    // case the resume feature exists for, and relying on the unload handlers alone
    // would leave up to one periodic-save interval unrecorded.
    this.saveRun();
    this.profile.flush();
  }

  /* ------------------------------------------------------------------ frame -- */

  private frame(timestamp: number): void {
    const frameStart = performance.now();
    const realDelta = this.lastFrameTime === 0 ? 1 / 60 : Math.min(0.25, (timestamp - this.lastFrameTime) / 1000);
    this.lastFrameTime = timestamp;
    this.fps = this.fps * 0.9 + (1 / Math.max(0.0001, realDelta)) * 0.1;

    const run = this.run;
    const playing = this.screen === 'playing' && run !== null && !run.finished;

    if (playing && run) {
      const input = this.input.sample(realDelta);
      this.trackLearning(input.moveX, input.bouncePressed, input.moveY);

      // Time dilation from upgrades and boss phases. Applied to the clock so the
      // simulation itself never needs to know about it.
      const requested = run.world.timeScaleRequest;
      this.clock.timeScale = clamp(requested, 0.12, 1);
      if (this.debug.slowMotion) this.clock.timeScale *= 0.25;

      if (!this.debug.paused || this.debug.stepRequested) {
        if (this.debug.paused && this.debug.stepRequested) {
          this.debug.stepRequested = false;
          run.step(FIXED_DT, input);
          run.observeHealth();
        } else {
          this.clock.advance(timestamp, (dt) => {
            run.step(dt, input);
            run.observeHealth();
          });
        }
      } else {
        this.clock.resync();
      }

      // Periodic save so that shards and incidental progress within a long room are
      // not lost to a reload either.
      this.runSaveTimer -= realDelta;
      if (this.runSaveTimer <= 0) {
        this.runSaveTimer = 6;
        this.saveRun();
      }

      run.world.predict();
      this.drainEffects();
      this.renderer.camera.update(realDelta, run.world.ball, {
        roomWidth: run.world.width,
        roomHeight: run.world.height,
        viewWidth: this.renderer.viewWidth,
        viewHeight: this.renderer.viewHeight,
      });
      this.audio.setIntensity(this.gameplayIntensity(run));
    } else {
      this.clock.resync();
      this.clock.timeScale = 1;
    }

    // Effects animate in real time so a hit-stop freeze still shows its sparks.
    this.fx.update(realDelta);

    if (run) {
      this.renderer.draw({
        world: run.world,
        biome: getBiome(run.currentRoom.biome),
        ballClassId: run.ballId,
        alpha: this.clock.alpha,
        time: this.clock.realTime,
      });
      const hud = {
        ctx: this.renderer.context,
        width: this.renderer.viewWidth,
        height: this.renderer.viewHeight,
        palette: this.renderer.semanticPalette,
        settings: this.profile.settings,
        run,
        world: run.world,
        time: this.clock.realTime,
        fps: this.fps,
      };
      if (this.screen === 'playing' || this.screen === 'build') {
        drawHud(hud);
        if (this.isFirstRun()) drawControlHints(hud, this.learned);
      }
      if (this.debug.enabled) {
        const ctx = this.renderer.context;
        ctx.save();
        this.renderer.camera.apply(ctx, this.renderer.viewWidth, this.renderer.viewHeight);
        this.debug.drawWorld(ctx, run);
        ctx.restore();
        this.debug.drawOverlay(ctx, this.renderer.viewWidth, this.renderer.viewHeight, run, this.profile);
      }
    } else {
      this.drawMenuBackdrop();
      if (this.debug.enabled) {
        this.debug.drawOverlay(this.renderer.context, this.renderer.viewWidth, this.renderer.viewHeight, null, this.profile);
      }
    }

    this.reconcileScreen();
    this.debug.recordFrame(performance.now() - frameStart);
  }

  /**
   * Applies the presentation requests the simulation raised this frame.
   *
   * Hit-stop is applied here rather than inside the simulation so that the pause
   * is a *rendering* concern: the physics never sees a variable timestep, which is
   * what keeps seeded runs reproducible while still feeling punchy.
   */
  private drainEffects(): void {
    if (this.fx.pendingHitStop > 0) {
      this.clock.requestHitStop(this.fx.pendingHitStop);
      this.fx.pendingHitStop = 0;
    }
    if (this.fx.pendingShake > 0) {
      this.renderer.camera.shake(this.fx.pendingShake);
      this.input.vibrate(Math.min(1, this.fx.pendingShake * 0.7), 80);
      this.fx.pendingShake = 0;
    }
    if (this.fx.pendingPunch > 0) {
      this.renderer.camera.punch(this.fx.pendingPunch);
      this.fx.pendingPunch = 0;
    }
  }

  /** 0..1 musical intensity, so the soundtrack tracks what is happening. */
  private gameplayIntensity(run: Run): number {
    const world = run.world;
    const threat = clamp01(world.enemies.filter((e) => !e.dead).length / 8);
    const combo = clamp01(world.combo.value / 20);
    const danger = 1 - clamp01(world.ball.hp / world.ball.maxHp);
    const boss = world.enemies.some((e) => !e.dead && e.parentId === 0 && e.maxHp > 600) ? 0.5 : 0;
    return clamp01(threat * 0.45 + combo * 0.35 + danger * 0.2 + boss);
  }

  private drawMenuBackdrop(): void {
    // A quiet animated backdrop behind the menus: the same visual language as the
    // arena, without implying interactivity.
    const ctx = this.renderer.context;
    const { viewWidth: w, viewHeight: h } = this.renderer;
    ctx.setTransform(this.renderer.devicePixelRatio, 0, 0, this.renderer.devicePixelRatio, 0, 0);
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#0b0f1a');
    gradient.addColorStop(1, '#141a2b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    const t = this.clock.realTime;
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#6aa8f0';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const phase = t * 0.35 + i * 1.2;
      const x = (Math.sin(phase) * 0.5 + 0.5) * w;
      const y = h * 0.5 + Math.sin(phase * 2.3) * h * 0.32;
      ctx.beginPath();
      ctx.arc(x, y, 10 + i * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------------- screens -- */

  private setScreen(screen: Screen): void {
    if (this.screen === screen) return;
    this.screen = screen;
    this.uiDirty = true;
    this.clock.resync();
  }

  /** Keeps the DOM overlay in sync with the run's phase and the current screen. */
  private reconcileScreen(): void {
    const run = this.run;
    if (run) {
      // The run owns its own phase; the screen follows it unless the player has
      // deliberately opened a nested screen.
      const nested = this.screen === 'build' || this.screen === 'pause' || this.screen === 'settings' || this.screen === 'journal';
      if (!nested) {
        const desired: Screen =
          run.phase === 'reward'
            ? 'reward'
            : run.phase === 'map'
              ? 'map'
              : run.phase === 'event'
                ? 'event'
                : run.phase === 'defeat' || run.phase === 'victory'
                  ? 'results'
                  : 'playing';
        if (desired !== this.screen) this.setScreen(desired);
      }
    }

    // Rebuild when the screen changes *or* when the run reports that the content of
    // the current screen changed. Screen identity alone is not enough: a second
    // queued reward replaces the offer without leaving the reward screen.
    const revision = run?.uiRevision ?? 0;
    if (!this.uiDirty && this.lastRenderedScreen === this.screen && this.lastRevision === revision) return;
    this.uiDirty = false;
    this.lastRenderedScreen = this.screen;
    this.lastRevision = revision;
    clear(this.overlay);
    this.overlay.classList.toggle('bb-overlay-active', this.screen !== 'playing');
    this.optionCount = 0;

    const menuHost: MenuHost = {
      profile: this.profile,
      playClick: () => this.audio.click(),
      playHover: () => this.audio.hover(),
      startRun: (options) => {
        // Starting fresh discards any shelved run, which is the only destructive
        // thing the menu can do, so it is surfaced on the button itself.
        this.runStore.clear();
        this.startRun(options);
      },
      savedRun: () => this.runStore.load(),
      continueRun: () => {
        const saved = this.runStore.load();
        if (saved) this.resumeRun(saved);
      },
      refresh: () => {
        this.uiDirty = true;
        this.lastRenderedScreen = null;
      },
      close: () => this.setScreen(this.returnScreen),
      openUnlocks: () => {
        this.returnScreen = 'menu';
        this.setScreen('unlocks');
      },
      openJournal: () => {
        this.returnScreen = this.screen === 'pause' ? 'pause' : 'menu';
        this.setScreen('journal');
      },
      openSettings: () => {
        this.returnScreen = this.screen === 'pause' ? 'pause' : 'menu';
        this.setScreen('settings');
      },
      openMenu: () => this.setScreen('menu'),
      applySettings: (patch) => this.applySettings(patch),
      draft: this.draft,
    };

    const screenHost: ScreenHost = {
      profile: this.profile,
      playClick: () => this.audio.click(),
      playHover: () => this.audio.hover(),
      abandonRun: () => this.abandonRun(),
      suspendRun: () => this.suspendToMenu(),
      resume: () => this.setScreen('playing'),
      startNewRun: () => this.startRun({ ballId: this.draft.ballId, boundLevel: this.draft.boundLevel }),
      openMenu: () => this.returnToMenu(),
      openSettings: () => {
        this.returnScreen = 'pause';
        this.setScreen('settings');
      },
      openJournal: () => {
        this.returnScreen = 'pause';
        this.setScreen('journal');
      },
    };

    switch (this.screen) {
      case 'menu':
        renderMainMenu(this.overlay, menuHost);
        break;
      case 'unlocks':
        renderUnlocks(this.overlay, menuHost);
        break;
      case 'journal':
        renderJournal(this.overlay, menuHost);
        break;
      case 'settings':
        renderSettings(this.overlay, menuHost, this.run !== null);
        break;
      case 'reward':
        if (run) this.optionCount = renderReward(this.overlay, run, screenHost);
        break;
      case 'map':
        if (run) this.optionCount = renderMap(this.overlay, run, screenHost);
        break;
      case 'event':
        if (run) this.optionCount = renderEvent(this.overlay, run, screenHost);
        break;
      case 'build':
        if (run) renderBuild(this.overlay, run, screenHost);
        break;
      case 'pause':
        if (run) renderPause(this.overlay, run, screenHost);
        break;
      case 'results':
        if (run) renderResults(this.overlay, run, screenHost);
        break;
      case 'playing':
      default:
        break;
    }
  }

  /** Forces the overlay to rebuild, e.g. after the run mutates its own state. */
  private invalidateUi(): void {
    this.uiDirty = true;
    this.lastRenderedScreen = null;
  }

  /* ------------------------------------------------------------------ actions -- */

  private handleAction(action: ActionName): void {
    switch (action) {
      case 'pause':
        if (this.screen === 'playing') this.setScreen('pause');
        else if (this.screen === 'pause') this.setScreen('playing');
        else if (this.screen === 'build') this.setScreen('playing');
        else if (this.screen === 'settings' || this.screen === 'journal' || this.screen === 'unlocks') {
          this.setScreen(this.returnScreen);
        } else if (this.screen === 'results') this.returnToMenu();
        break;
      case 'build':
        if (this.screen === 'playing') this.setScreen('build');
        else if (this.screen === 'build') this.setScreen('playing');
        break;
      case 'debug':
        this.debug.enabled = !this.debug.enabled;
        break;
      case 'confirm':
        if (this.screen === 'menu') this.startRun({ seed: this.draft.seed, ballId: this.draft.ballId, boundLevel: this.draft.boundLevel });
        else if (this.screen === 'results') this.startRun({ ballId: this.draft.ballId, boundLevel: this.draft.boundLevel });
        else if (this.screen === 'event' && this.run?.eventPrompt?.resolved) this.run.closeEvent();
        break;
      case 'restart':
        if (this.screen === 'reward' && this.run) {
          this.run.rerollReward();
          this.invalidateUi();
        }
        break;
      default:
        break;
    }
  }

  /**
   * Raw key handling for things the action map cannot express: number keys for the
   * current screen's options, and the debug command set.
   */
  private handleRawKey(event: KeyboardEvent): void {
    if (this.debug.enabled && this.debug.handleKey(event.code, this.run, this.profile)) {
      event.preventDefault();
      this.invalidateUi();
      return;
    }

    if (event.code === 'KeyX' && this.screen === 'reward' && this.run) {
      this.run.skipReward();
      this.invalidateUi();
      return;
    }

    const match = /^Digit([1-9])$/.exec(event.code);
    if (!match || this.optionCount === 0) return;
    const index = Number(match[1]) - 1;
    if (index >= this.optionCount) return;
    const run = this.run;
    if (!run) return;
    event.preventDefault();
    this.audio.click();

    if (this.screen === 'reward' && run.reward) {
      const def = run.reward.upgrades[index];
      if (def) run.takeUpgrade(def.id);
    } else if (this.screen === 'map') {
      const node = run.mapChoices[index];
      if (node) run.chooseNode(node.id);
    } else if (this.screen === 'event') {
      run.chooseEventOption(index);
    }
    this.invalidateUi();
  }

  /* ---------------------------------------------------------------- run flow -- */

  private startRun(options: { seed?: string; ballId: string; boundLevel: number; restore?: RunSnapshot }): void {
    this.run?.dispose();
    this.fx.clear();

    const run = new Run({
      profile: this.profile,
      seed: options.restore?.seed ?? options.seed,
      ballId: options.ballId,
      boundLevel: options.boundLevel,
      clock: this.clock,
      restore: options.restore,
    });
    this.run = run;
    this.draft.ballId = options.ballId;
    this.draft.boundLevel = options.boundLevel;
    this.draft.seed = run.seed;
    this.profile.data.selectedBall = options.ballId;
    this.profile.data.boundLevel = options.boundLevel;
    this.profile.data.lastSeed = run.seed;
    this.profile.markDirty();

    // Presentation attaches to the run's bus. Both are torn down together.
    this.fx.install(run.bus);
    this.audio.install(run.bus, (x) => clamp((x / run.world.width) * 2 - 1, -1, 1) * 0.6);
    this.debug.install(run);
    run.bus.on('roomEntered', () => {
      this.audio.setBiome(getBiome(run.currentRoom.biome));
      this.renderer.configureFor(run.world);
      // Entering a room is the natural save point: it is exactly the state a
      // resume restores to.
      this.saveRun();
    });
    run.bus.on('upgradeGained', () => this.saveRun());
    run.bus.on('pickupCollected', ({ kind }) => {
      // Interactables change the run meaningfully; plain shards are covered by the
      // periodic save and do not deserve a write each.
      if (kind !== 'shard') this.saveRun();
    });
    run.bus.on('achievementUnlocked', ({ id }) => this.toast(`Unlocked: ${id}`, 'rare'));
    run.bus.on('runEnded', () => {
      // The run is over: the snapshot must not outlive it, or the player would be
      // dropped back into a finished run on reload.
      this.runStore.clear();
      for (const result of run.newAchievements) this.toast(`${result.def.name}`, 'rare');
    });

    this.renderer.configureFor(run.world);
    this.audio.setBiome(getBiome(run.currentRoom.biome));
    this.clock.reset();
    this.setScreen('playing');
    this.invalidateUi();
  }

  /** Resumes a saved run, falling back to the menu if it cannot be rebuilt. */
  private resumeRun(snapshot: RunSnapshot): void {
    try {
      this.startRun({ ballId: snapshot.ballId, boundLevel: snapshot.boundLevel, restore: snapshot });
      this.toast('Run resumed', 'good');
    } catch (error) {
      // A snapshot that cannot be rebuilt is discarded rather than retried, so a
      // bad save can never trap the player in a boot loop.
      console.error('Could not resume the saved run', error);
      this.runStore.clear();
      this.run = null;
      this.setScreen('menu');
    }
  }

  private saveRun(): void {
    const run = this.run;
    if (!run || run.finished) return;
    try {
      this.runStore.save(run.captureSnapshot());
    } catch (error) {
      // Persistence failing must never interrupt play.
      console.warn('Could not save the run', error);
    }
  }

  private abandonRun(): void {
    const run = this.run;
    if (!run) return;
    this.runStore.clear();
    run.finish(false, 'abandoned');
    this.setScreen('results');
    this.invalidateUi();
  }

  /** Leaves the run on the shelf: the snapshot survives so it can be resumed. */
  private suspendToMenu(): void {
    this.saveRun();
    this.run?.dispose();
    this.run = null;
    this.profile.flush();
    this.setScreen('menu');
    this.invalidateUi();
  }

  private returnToMenu(): void {
    this.run?.dispose();
    this.run = null;
    this.profile.flush();
    this.draft.boundLevel = Math.min(this.draft.boundLevel, this.profile.maxBoundLevel());
    this.setScreen('menu');
    this.invalidateUi();
  }

  private applySettings(patch: Partial<Settings>): void {
    this.profile.updateSettings(patch);
    const settings = this.profile.settings;
    this.renderer.updateSettings(settings);
    this.fx.updateSettings(settings);
    this.audio.updateSettings(settings);
    this.input.updateSettings(settings);
    this.applyInterfacePreferences();
    this.profile.flush();
  }

  /**
   * Mirrors the motion and flashing settings onto the document root so the
   * stylesheet can honour them. The in-game toggles have to affect the DOM panels
   * as well as the canvas, or a player who disables motion still gets animated
   * menus.
   */
  private applyInterfacePreferences(): void {
    const settings = this.profile.settings;
    const root = document.documentElement;
    root.classList.toggle('bb-reduced-motion', settings.reducedMotion);
    root.classList.toggle('bb-reduced-flashing', settings.reducedFlashing);
    root.style.setProperty('--bb-ui-scale', `${settings.uiScale}`);
  }

  /* -------------------------------------------------------------- onboarding -- */

  private isFirstRun(): boolean {
    return this.profile.counter('runsPlayed') === 0 && (this.run?.currentNode.depth ?? 1) === 0;
  }

  private trackLearning(moveX: number, bouncePressed: boolean, moveY: number): void {
    if (Math.abs(moveX) > 0.4) this.learned.steer = true;
    if (bouncePressed) this.learned.bounce = true;
    if (moveY > 0.5) this.learned.dive = true;
  }

  private toast(text: string, tone: 'info' | 'good' | 'bad' | 'rare'): void {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = document.createElement('div');
    node.className = `bb-toast bb-toast-${tone}`;
    node.textContent = text;
    host.append(node);
    globalThis.setTimeout(() => node.classList.add('bb-toast-out'), 3200);
    globalThis.setTimeout(() => node.remove(), 3800);
  }

  /** Exposed for the dev console and for automated smoke checks. */
  get currentRun(): Run | null {
    return this.run;
  }

  get currentScreen(): string {
    return this.screen;
  }

  get profileRef(): Profile {
    return this.profile;
  }
}

/** Convenience used by `main.ts`; kept here so the entry point stays trivial. */
export function createGame(canvas: HTMLCanvasElement, overlay: HTMLElement): Game {
  const game = new Game(canvas, overlay);
  game.start();
  return game;
}

export { createInput };
