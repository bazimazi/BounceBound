/**
 * The route screen at the moments progression hinges on.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../src/core/storage';
import { Profile } from '../src/meta/profile';
import { Run } from '../src/run/run';
import { renderMap, renderResults, type ScreenHost } from '../src/ui/screens';

function host(profile: Profile): ScreenHost {
  const noop = (): void => {};
  return {
    profile,
    playClick: noop,
    playHover: noop,
    abandonRun: noop,
    suspendRun: noop,
    resume: noop,
    startNewRun: noop,
    openMenu: noop,
    openSettings: noop,
    openJournal: noop,
    openCareer: noop,
    touch: false,
  };
}

/** Puts the run on the route screen as if the first boss had just fallen. */
function afterFirstBoss(run: Run): void {
  const boss = run.map.nodesById.get(run.map.acts[0].bossId)!;
  run.phase = 'map';
  run.mapChoices = [boss];
  run.chooseNode(boss.id);
  // Private in the run; the route screen only needs the phase and the choices.
  (run as unknown as { openMap: () => void }).openMap();
}

describe('route screen', () => {
  it('shows what each branch still holds, with the distance to the boss', () => {
    const profile = new Profile(new MemoryStorage());
    const run = new Run({ profile, seed: 'ROUTE-UI', ballId: 'standard' });
    run.phase = 'map';
    run.mapChoices = run.map.acts[0].nodes.filter((n) => n.layer === 1);
    const root = document.createElement('div');
    const count = renderMap(root, run, host(profile));
    expect(count).toBe(run.mapChoices.length);
    const outlooks = root.querySelectorAll('.bb-route .bb-outlook');
    expect(outlooks.length).toBe(count);
    for (const outlook of outlooks) expect(outlook.querySelector('.bb-outlook-boss')).not.toBeNull();
    expect(root.textContent).toContain('Depth 1 of 3');
    run.dispose();
  });

  it('shows the next depth, not the cleared one, after a boss', () => {
    const profile = new Profile(new MemoryStorage());
    const run = new Run({ profile, seed: 'ROUTE-NEXT', ballId: 'standard' });
    afterFirstBoss(run);
    const root = document.createElement('div');
    renderMap(root, run, host(profile));
    expect(root.querySelector('h2')?.textContent).toBe('Clockwork Foundry');
    expect(root.querySelectorAll('.bb-node-open').length).toBe(run.mapChoices.length);
    run.dispose();
  });

  it('lays a fork out as two depths, each with its own board and boss', () => {
    const profile = new Profile(new MemoryStorage());
    profile.grant('biome_citadel');
    const run = new Run({ profile, seed: 'ROUTE-FORK', ballId: 'standard' });
    afterFirstBoss(run);
    const root = document.createElement('div');
    renderMap(root, run, host(profile));
    const forks = [...root.querySelectorAll('.bb-fork')];
    expect(forks).toHaveLength(2);
    expect(forks.map((f) => f.querySelector('h3')?.textContent)).toEqual(['Clockwork Foundry', 'Storm Citadel']);
    for (const fork of forks) {
      expect(fork.querySelector('.bb-map')).not.toBeNull();
      expect(fork.querySelectorAll('.bb-route').length).toBeGreaterThan(0);
      expect(fork.textContent).toContain('The Crusher');
    }
    run.dispose();
  });

  it('ends a run pointing at the next unlock', () => {
    const profile = new Profile(new MemoryStorage());
    const run = new Run({ profile, seed: 'RESULTS', ballId: 'standard' });
    run.finish(false, 'hazard');
    const root = document.createElement('div');
    renderResults(root, run, host(profile));
    expect(root.textContent).toContain('Next');
    expect(root.querySelector('.bb-goal, .bb-highlight')).not.toBeNull();
    run.dispose();
  });
});
