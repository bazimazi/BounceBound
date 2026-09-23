/**
 * Application smoke tests.
 *
 * @vitest-environment jsdom
 *
 * These drive the real `Game` class against a stubbed Canvas 2D context, which
 * catches the whole class of bug that unit tests cannot: a screen that throws when
 * it renders, a listener wired to the wrong event, a menu that references content
 * that does not exist. Every screen is visited and every in-run phase is driven.
 *
 * The canvas context is a permissive stub rather than a real implementation,
 * because what is being tested is that the draw code runs to completion without
 * throwing - not what it produces.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A Canvas 2D stub that accepts every call and returns plausible objects. */
function installCanvasStub(): void {
  const gradient = {
    addColorStop: () => undefined,
  };
  const context: Record<string, unknown> = {
    canvas: null,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 40 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setTransform: () => undefined,
    getTransform: () => ({}),
    save: () => undefined,
    restore: () => undefined,
  };
  // Everything else is a no-op function; property assignments (fillStyle etc.)
  // land on the object harmlessly.
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  };
  const proxy = new Proxy(context, handler);

  HTMLCanvasElement.prototype.getContext = function getContext(): unknown {
    return proxy;
  } as never;

  HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, toJSON: () => ({}) } as DOMRect;
  };
}

function installFrameStub(): { runFrames: (count: number) => void } {
  let callback: FrameRequestCallback | null = null;
  let time = 0;
  globalThis.requestAnimationFrame = ((fn: FrameRequestCallback) => {
    callback = fn;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  if (!globalThis.performance) {
    (globalThis as unknown as { performance: Performance }).performance = { now: () => time } as Performance;
  }
  return {
    runFrames(count: number) {
      for (let i = 0; i < count; i++) {
        time += 1000 / 60;
        const current = callback;
        callback = null;
        current?.(time);
      }
    },
  };
}

function mountDom(): { canvas: HTMLCanvasElement; overlay: HTMLElement } {
  document.body.innerHTML = '<canvas id="game"></canvas><div id="overlay"></div><div id="toasts"></div>';
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  return { canvas, overlay };
}

describe('the application boots and every screen renders', () => {
  beforeEach(() => {
    installCanvasStub();
    // Audio is unavailable in jsdom; the engine must degrade instead of throwing.
    vi.stubGlobal('AudioContext', undefined);
    localStorage.clear();
  });

  it('starts at the main menu with playable options', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(2);

    expect(game.currentScreen).toBe('menu');
    expect(overlay.textContent).toContain('BOUNCEBOUND');
    expect(overlay.querySelectorAll('.bb-ball').length).toBeGreaterThan(0);
    expect(overlay.textContent).toContain('Begin descent');
    game.stop();
  });

  it('runs a full frame loop in-game without throwing', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);

    // Start a run through the menu button, exactly as a player would.
    const begin = [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'));
    expect(begin).toBeDefined();
    begin!.click();
    frames.runFrames(30);

    expect(game.currentRun).not.toBeNull();
    expect(game.currentScreen).toBe('playing');
    expect(Number.isFinite(game.currentRun!.world.ball.x)).toBe(true);
    game.stop();
  });

  it('renders the build panel, pause, settings, journal and unlocks screens', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(5);

    const press = (code: string): void => {
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      frames.runFrames(2);
    };

    press('Tab');
    expect(game.currentScreen).toBe('build');
    expect(overlay.textContent).toContain('Upgrades');

    press('Tab');
    press('Escape');
    expect(game.currentScreen).toBe('pause');
    expect(overlay.textContent).toContain('Paused');

    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Settings'))!.click();
    frames.runFrames(2);
    expect(overlay.textContent).toContain('Trajectory guide');
    expect(overlay.querySelectorAll('input[type="range"]').length).toBeGreaterThan(4);

    press('Escape');
    frames.runFrames(2);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Journal'))!.click();
    frames.runFrames(2);
    expect(overlay.textContent).toContain('Adversaries');
    expect(overlay.querySelectorAll('.bb-entry').length).toBeGreaterThan(30);

    press('Escape');
    frames.runFrames(2);
    game.stop();
  });

  it('renders the reward, route and results screens through a driven run', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(4);

    const run = game.currentRun!;

    // Clear the room the way the debug tool does, then let the exit resolve.
    for (const enemy of [...run.world.enemies]) run.world.killEnemy(enemy, 'other', null);
    for (let i = 0; i < 400 && run.phase === 'playing'; i++) frames.runFrames(4);

    expect(['reward', 'map']).toContain(run.phase);
    frames.runFrames(3);
    if (run.phase === 'reward') {
      expect(overlay.querySelectorAll('.bb-card').length).toBeGreaterThan(0);
      // Pick the first option with the keyboard, as the UI advertises.
      globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', bubbles: true }));
      frames.runFrames(3);
    }

    expect(run.phase).toBe('map');
    frames.runFrames(2);
    expect(overlay.querySelectorAll('.bb-route').length).toBeGreaterThan(0);
    expect(overlay.querySelectorAll('.bb-node').length).toBeGreaterThan(4);

    // End the run and check the summary leads with what was earned.
    run.finish(false, 'hazard');
    frames.runFrames(3);
    expect(game.currentScreen).toBe('results');
    expect(overlay.textContent).toContain('Earned');
    expect(overlay.textContent).toContain('Echoes');
    game.stop();
  });

  it('keeps panels sparse rather than text-heavy', async () => {
    // A guard on the complaint that the interface read as a web app. These are
    // density budgets, not exact values: they should fail if someone reintroduces
    // a paragraph per card or a description per journal entry.
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);

    // Main menu: only the selected ball spells out its full description.
    const ballParagraphs = overlay.querySelectorAll('.bb-ball p');
    expect(ballParagraphs.length).toBeLessThanOrEqual(1);

    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(4);
    const run = game.currentRun!;
    for (const enemy of [...run.world.enemies]) run.world.killEnemy(enemy, 'other', null);
    for (let i = 0; i < 400 && run.phase === 'playing'; i++) frames.runFrames(4);
    frames.runFrames(3);

    if (run.phase === 'reward') {
      const cards = [...overlay.querySelectorAll('.bb-card')];
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        // Name, effect, maybe a cost and two stat deltas. Not an essay.
        expect((card.textContent ?? '').length).toBeLessThan(260);
        expect(card.querySelectorAll('.bb-card-stats li').length).toBeLessThanOrEqual(2);
      }
    }

    game.stop();
  });

  it('renders the journal as a dense name list, not a reference manual', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);

    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Journal'))!.click();
    frames.runFrames(2);

    const entries = [...overlay.querySelectorAll('.bb-entry')];
    expect(entries.length).toBeGreaterThan(80);
    // Detail belongs in the tooltip, so entries stay short and scannable.
    const withLongText = entries.filter((e) => (e.textContent ?? '').length > 60);
    expect(withLongText.length).toBe(0);
    const withTooltip = entries.filter((e) => (e.getAttribute('title') ?? '').length > 0);
    expect(withTooltip.length).toBeGreaterThan(entries.length * 0.5);
    game.stop();
  });

  it('persists settings and progress across game instances', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');

    const first = new Game(canvas, overlay);
    first.start();
    frames.runFrames(1);
    first.profileRef.addCurrency('echoes', 42);
    first.profileRef.updateSettings({ reducedMotion: true, screenShake: 0.2 });
    first.stop();

    const second = new Game(canvas, overlay);
    second.start();
    frames.runFrames(1);
    expect(second.profileRef.balance('echoes')).toBe(42);
    expect(second.profileRef.settings.reducedMotion).toBe(true);
    expect(second.profileRef.settings.screenShake).toBeCloseTo(0.2, 5);
    second.stop();
  });

  it('resumes an in-progress run after a reload', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');

    // Play into a run, take an upgrade, and bank some shards.
    const first = new Game(canvas, overlay);
    first.start();
    frames.runFrames(1);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(4);

    const run = first.currentRun!;
    run.build.add('critical_impact');
    run.shards += 77;
    const expected = {
      seed: run.seed,
      node: run.currentNode.id,
      upgrades: run.build.order.slice(),
      shards: run.shards,
      hp: run.world.ball.hp,
    };
    frames.runFrames(2);
    first.stop();

    // A reload is a brand new Game against the same storage.
    const second = new Game(canvas, overlay);
    second.start();
    frames.runFrames(3);

    const resumed = second.currentRun;
    expect(resumed, 'the run should have been resumed, not discarded').not.toBeNull();
    expect(resumed!.resumed).toBe(true);
    expect(resumed!.seed).toBe(expected.seed);
    expect(resumed!.currentNode.id).toBe(expected.node);
    expect(resumed!.shards).toBe(expected.shards);
    expect(resumed!.build.order).toEqual(expected.upgrades);
    expect(resumed!.world.ball.hp).toBeCloseTo(expected.hp, 3);
    // The same room, rebuilt from the seed rather than stored.
    expect(resumed!.currentRoom.templateId).toBe(run.currentRoom.templateId);
    second.stop();
  });

  it('does not resume a run that has ended', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');

    const first = new Game(canvas, overlay);
    first.start();
    frames.runFrames(1);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(4);
    first.currentRun!.finish(false, 'hazard');
    frames.runFrames(2);
    first.stop();

    const second = new Game(canvas, overlay);
    second.start();
    frames.runFrames(2);
    // A finished run must not be restored, or death would be meaningless.
    expect(second.currentRun).toBeNull();
    expect(second.currentScreen).toBe('menu');
    second.stop();
  });

  it('keeps a shelved run when quitting to the menu, and drops it when abandoning', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const { RunStore } = await import('../src/run/runSave');

    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Begin descent'))!.click();
    frames.runFrames(4);

    // Save and quit keeps it.
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    frames.runFrames(2);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Save and quit'))!.click();
    frames.runFrames(2);
    expect(new RunStore().load()).not.toBeNull();
    expect(overlay.textContent).toContain('Continue run');

    // Resuming from the menu works.
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue run'))!.click();
    frames.runFrames(3);
    expect(game.currentRun).not.toBeNull();

    // Abandoning discards it.
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    frames.runFrames(2);
    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Abandon run'))!.click();
    frames.runFrames(2);
    expect(new RunStore().load()).toBeNull();
    game.stop();
  });

  it('discards a corrupt run save instead of trapping the player', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');

    localStorage.setItem('bouncebound.run', '{"v":2,"sum":"nope","data":{"seed":123}}');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(2);
    expect(game.currentRun).toBeNull();
    expect(game.currentScreen).toBe('menu');
    game.stop();
  });

  it('survives a purchase in the unlock tree', async () => {
    const frames = installFrameStub();
    const { canvas, overlay } = mountDom();
    const { Game } = await import('../src/game/game');
    const game = new Game(canvas, overlay);
    game.start();
    frames.runFrames(1);
    game.profileRef.addCurrency('echoes', 500);

    [...overlay.querySelectorAll('button')].find((b) => b.textContent?.includes('Unlocks'))!.click();
    frames.runFrames(2);
    expect(overlay.textContent).toContain('Unlocks');

    const ready = overlay.querySelector('.bb-unlock-ready') as HTMLButtonElement | null;
    expect(ready).not.toBeNull();
    const before = game.profileRef.balance('echoes');
    ready!.click();
    frames.runFrames(2);
    expect(game.profileRef.balance('echoes')).toBeLessThan(before);
    game.stop();
  });
});
