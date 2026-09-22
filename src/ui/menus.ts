/**
 * Out-of-run screens: main menu, unlock tree, journal, settings.
 *
 * The main menu carries the discovery curve. It shows the ball classes the player
 * has, hints at the ones they do not, and puts the unlock tree and journal one
 * click away - because "what is that, and how do I get it" is the question that
 * brings someone back for another run.
 *
 * The journal deliberately shows silhouettes for undiscovered content: a count of
 * what exists, with names withheld. Knowing there are four more bosses is far more
 * motivating than not knowing whether there are any.
 */

import { formatNumber } from '../core/math';
import { dailySeed, generateSeedString, normalizeSeed, Rng } from '../core/rng';
import { ACHIEVEMENT_DEFS } from '../content/achievements';
import { BALL_CLASSES, getBallClass } from '../content/balls';
import { BIOME_DEFS } from '../content/biomes';
import { ENEMY_DEFS } from '../content/enemies';
import { BOSS_DEFS } from '../content/bosses';
import { EVENT_DEFS } from '../content/events';
import { SYNERGY_DEFS } from '../content/synergies';
import { BOUND_MODIFIERS, boundName } from '../content/modifiers';
import { BRANCH_NAMES, UNLOCK_NODES, maxRanks, nodeCost, type UnlockBranch } from '../content/unlocks';
import { upgradeCatalogue } from '../content/upgrades/index';
import { RARITY_COLORS } from '../content/ids';
import type { Profile } from '../meta/profile';
import { defaultSettings, type ColorMode, type Settings, type TrajectoryMode } from '../meta/settings';
import { bar, button, el, formatDuration, row, section, select, slider, toggle } from './dom';

export interface MenuHost {
  profile: Profile;
  playClick: () => void;
  playHover: () => void;
  startRun: (options: { seed?: string; ballId: string; boundLevel: number }) => void;
  refresh: () => void;
  close: () => void;
  openUnlocks: () => void;
  openJournal: () => void;
  openSettings: () => void;
  openMenu: () => void;
  applySettings: (patch: Partial<Settings>) => void;
  /** Current draft run configuration, persisted between visits. */
  draft: { seed: string; ballId: string; boundLevel: number };
}

export function renderMainMenu(root: HTMLElement, host: MenuHost): void {
  const profile = host.profile;
  const unlockedBalls = BALL_CLASSES.filter((b) => !b.unlock || profile.isUnlocked(b.unlock));
  const lockedBalls = BALL_CLASSES.filter((b) => b.unlock && !profile.isUnlocked(b.unlock));
  const maxBound = profile.maxBoundLevel();
  const history = profile.data.history.slice(-3).reverse();

  const ballCards = unlockedBalls.map((ballClass) => {
    const selected = host.draft.ballId === ballClass.id;
    const node = el(
      'button',
      {
        class: `bb-ball${selected ? ' bb-ball-selected' : ''}`,
        type: 'button',
        style: `--ball:${ballClass.color};--ball-accent:${ballClass.accent}`,
      },
      [
        el('span', { class: 'bb-ball-dot' }),
        el('div', {}, [
          el('strong', { text: ballClass.name }),
          el('em', { text: ballClass.tagline }),
          el('p', { text: ballClass.description }),
          el('small', { class: 'bb-bad', text: ballClass.cost }),
          ballClass.startingUpgrade
            ? el('small', { class: 'bb-note', text: `Starts with ${getUpgradeName(ballClass.startingUpgrade)}` })
            : null,
        ]),
      ],
    );
    node.addEventListener('click', () => {
      host.playClick();
      host.draft.ballId = ballClass.id;
      host.refresh();
    });
    node.addEventListener('mouseenter', host.playHover);
    return node;
  });

  const seedInput = el('input', { type: 'text', value: host.draft.seed, placeholder: 'random', ariaLabel: 'Run seed', maxlength: 24 });
  seedInput.addEventListener('change', () => {
    host.draft.seed = seedInput.value.trim();
  });

  root.append(
    el('div', { class: 'bb-panel bb-panel-menu' }, [
      el('header', { class: 'bb-title' }, [
        el('h1', { text: 'BOUNCEBOUND' }),
        el('p', { text: 'The ball is the weapon. It never stops.' }),
      ]),

      el('div', { class: 'bb-menu-grid' }, [
        el('div', {}, [
          section('Ball', [
            el('div', { class: 'bb-balls' }, ballCards),
            lockedBalls.length > 0
              ? el('div', { class: 'bb-locked' }, [
                  el('h4', { text: `${lockedBalls.length} more to find` }),
                  ...lockedBalls.map((ballClass) =>
                    el('p', {}, [el('strong', { text: '???' }), ' - ', ballClass.unlockHint ?? 'Hidden']),
                  ),
                ])
              : null,
          ]),
        ]),

        el('div', {}, [
          section('Run', [
            el('label', { class: 'bb-field' }, [el('span', { text: 'Seed' }), seedInput]),
            row([
              button({
                label: 'Random',
                onClick: () => {
                  host.playClick();
                  host.draft.seed = generateSeedString(new Rng(Date.now()));
                  host.refresh();
                },
              }),
              profile.isUnlocked('mode_daily')
                ? button({
                    label: "Today's seed",
                    title: 'Identical for everyone today',
                    onClick: () => {
                      host.playClick();
                      host.draft.seed = dailySeed();
                      host.refresh();
                    },
                  })
                : null,
            ]),
            maxBound > 0
              ? el('div', { class: 'bb-bound' }, [
                  slider({
                    label: 'Bound level',
                    value: Math.min(host.draft.boundLevel, maxBound),
                    min: 0,
                    max: maxBound,
                    step: 1,
                    format: (value) => `${value}`,
                    onChange: (value) => {
                      host.draft.boundLevel = value;
                      host.refresh();
                    },
                  }),
                  el('p', { class: 'bb-note', text: boundName(host.draft.boundLevel) }),
                  ...BOUND_MODIFIERS.filter((m) => m.level <= host.draft.boundLevel).map((m) =>
                    el('p', { class: 'bb-note bb-bad' }, [el('strong', { text: m.name }), ' - ', m.description]),
                  ),
                ])
              : el('p', { class: 'bb-note', text: 'Complete a run to open Bound levels.' }),
            button({
              label: 'Begin descent',
              className: 'bb-primary',
              hint: 'Enter',
              onClick: () => {
                host.playClick();
                host.startRun({
                  seed: host.draft.seed ? normalizeSeed(host.draft.seed) : undefined,
                  ballId: host.draft.ballId,
                  boundLevel: host.draft.boundLevel,
                });
              },
              onHover: host.playHover,
            }),
          ]),

          section('Progress', [
            el('div', { class: 'bb-gains bb-gains-compact' }, [
              statTile('Echoes', formatNumber(profile.balance('echoes'))),
              statTile('Runs', `${profile.counter('runsPlayed')}`),
              statTile('Wins', `${profile.counter('runsWon')}`),
              statTile('Best combo', `${profile.counter('bestCombo')}`),
            ]),
            row([
              button({ label: 'Unlocks', onClick: () => { host.playClick(); host.openUnlocks(); } }),
              button({ label: 'Journal', onClick: () => { host.playClick(); host.openJournal(); } }),
              button({ label: 'Settings', onClick: () => { host.playClick(); host.openSettings(); } }),
            ]),
          ]),

          history.length > 0
            ? section(
                'Recent runs',
                history.map((record) =>
                  el('p', { class: 'bb-note' }, [
                    el('strong', { text: record.victory ? 'Won' : `Room ${record.roomsCleared}` }),
                    ` - ${getBallClass(record.ballId).name} - ${record.identity} - ${formatDuration(record.durationSeconds)}`,
                  ]),
                ),
              )
            : null,
        ]),
      ]),
    ]),
  );
}

function statTile(label: string, value: string): HTMLElement {
  return el('div', { class: 'bb-gain' }, [
    el('span', { class: 'bb-gain-value', text: value }),
    el('span', { class: 'bb-gain-label', text: label }),
  ]);
}

function getUpgradeName(id: string): string {
  return upgradeCatalogue().find((u) => u.id === id)?.name ?? id;
}

/* ----------------------------------------------------------------- unlocks -- */

export function renderUnlocks(root: HTMLElement, host: MenuHost): void {
  const profile = host.profile;
  const branches: UnlockBranch[] = ['core', 'abilities', 'world', 'adversaries', 'trials', 'secrets'];

  const columns = branches.map((branch) => {
    const nodes = UNLOCK_NODES.filter((node) => node.branch === branch).filter(
      (node) => !node.secret || node.requires.every((req) => profile.ranksOf(req) > 0),
    );
    if (nodes.length === 0) return null;
    return el('div', { class: 'bb-branch' }, [
      el('h3', { text: BRANCH_NAMES[branch] }),
      ...nodes.map((node) => {
        const ranks = profile.ranksOf(node.id);
        const max = maxRanks(node);
        const check = profile.canPurchase(node);
        const owned = ranks >= max;
        const card = el(
          'button',
          {
            class: `bb-unlock${owned ? ' bb-unlock-owned' : check.ok ? ' bb-unlock-ready' : ' bb-unlock-locked'}`,
            type: 'button',
            disabled: owned || !check.ok,
            title: check.reason,
          },
          [
            el('header', {}, [
              el('strong', { text: node.name }),
              el('span', { text: max > 1 ? `${ranks}/${max}` : owned ? 'owned' : `${nodeCost(node, ranks)}` }),
            ]),
            el('p', { text: node.description }),
            !owned ? el('small', { class: check.ok ? 'bb-good' : 'bb-bad', text: check.ok ? `${check.cost} echoes` : check.reason }) : null,
          ],
        );
        if (!owned && check.ok) {
          card.addEventListener('click', () => {
            host.playClick();
            profile.purchase(node.id);
            profile.flush();
            host.refresh();
          });
          card.addEventListener('mouseenter', host.playHover);
        }
        return card;
      }),
    ]);
  });

  root.append(
    el('div', { class: 'bb-panel bb-panel-wide' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: 'Unlocks' }),
        el('p', {
          class: 'bb-sub',
          text: `${formatNumber(profile.balance('echoes'))} echoes. These widen what a run can be; they are not a power requirement.`,
        }),
      ]),
      el('div', { class: 'bb-branches' }, columns.filter(Boolean) as Node[]),
      row([button({ label: 'Back', hint: 'Esc', onClick: () => { host.playClick(); host.openMenu(); } })], 'bb-row-end'),
    ]),
  );
}

/* ----------------------------------------------------------------- journal -- */

export function renderJournal(root: HTMLElement, host: MenuHost): void {
  const profile = host.profile;
  const catalogue = upgradeCatalogue();

  const upgradeList = catalogue.map((def) => {
    const found = profile.hasDiscovered('upgrades', def.id);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}`, style: `--rarity:${RARITY_COLORS[def.rarity]}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.text : `${def.family} - ${def.rarity}` }),
      found && def.cost ? el('small', { class: 'bb-bad', text: def.cost }) : null,
    ]);
  });

  const enemyList = ENEMY_DEFS.map((def) => {
    const found = profile.hasDiscovered('enemies', def.id);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.approach : 'Not yet encountered' }),
    ]);
  });

  const bossList = BOSS_DEFS.map((def) => {
    const found = profile.hasDiscovered('bosses', def.id);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.approach : `Guards the ${getBiomeName(def.biome)}` }),
      found ? el('small', { class: 'bb-note', text: def.lore }) : null,
    ]);
  });

  const synergyList = SYNERGY_DEFS.map((def) => {
    const found = profile.hasDiscovered('synergies', def.id);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.description : `Combine ${def.requiresAll.length} specific upgrades` }),
    ]);
  });

  const eventList = EVENT_DEFS.map((def) => {
    const found = profile.hasDiscovered('events', def.discoveryId);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.text : 'Somewhere on a route' }),
    ]);
  });

  const biomeList = BIOME_DEFS.map((def) => {
    const found = profile.hasDiscovered('biomes', def.id);
    return el('div', { class: `bb-entry${found ? '' : ' bb-entry-hidden'}` }, [
      el('strong', { text: found ? def.name : '???' }),
      el('small', { text: found ? def.rules : 'Undiscovered depth' }),
    ]);
  });

  const achievementList = ACHIEVEMENT_DEFS.map((def) => {
    const done = profile.isAchieved(def.id);
    const progress = profile.achievementProgress(def);
    const hidden = def.secret && !done;
    return el('div', { class: `bb-entry${done ? ' bb-entry-done' : ''}` }, [
      el('strong', { text: hidden ? '???' : def.name }),
      el('small', { text: hidden ? def.hint ?? 'Hidden' : def.description }),
      !done && !hidden ? bar(progress.fraction, '#6aa8f0', `${progress.current}/${progress.target}`) : null,
      done && def.echoes ? el('small', { class: 'bb-good', text: `+${def.echoes} echoes` }) : null,
    ]);
  });

  root.append(
    el('div', { class: 'bb-panel bb-panel-wide' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: 'Journal' }),
        el('p', {
          class: 'bb-sub',
          text: [
            `${profile.discoveryCount('upgrades')}/${catalogue.length} upgrades`,
            `${profile.discoveryCount('synergies')}/${SYNERGY_DEFS.length} synergies`,
            `${profile.discoveryCount('enemies')}/${ENEMY_DEFS.length} adversaries`,
            `${profile.discoveryCount('bosses')}/${BOSS_DEFS.length} bosses`,
            `${Object.keys(profile.data.achievements).length}/${ACHIEVEMENT_DEFS.length} achievements`,
          ].join('  -  '),
        }),
      ]),
      el('div', { class: 'bb-journal' }, [
        journalColumn('Upgrades', upgradeList),
        journalColumn('Synergies', synergyList),
        journalColumn('Adversaries', enemyList),
        journalColumn('Bosses', bossList),
        journalColumn('Depths', biomeList),
        journalColumn('Encounters', eventList),
        journalColumn('Achievements', achievementList),
      ]),
      row([button({ label: 'Back', hint: 'Esc', onClick: () => { host.playClick(); host.close(); } })], 'bb-row-end'),
    ]),
  );
}

function journalColumn(title: string, entries: HTMLElement[]): HTMLElement {
  return el('div', { class: 'bb-journal-col' }, [el('h3', { text: `${title} (${entries.length})` }), ...entries]);
}

function getBiomeName(id: string): string {
  return BIOME_DEFS.find((b) => b.id === id)?.name ?? id;
}

/* ---------------------------------------------------------------- settings -- */

export function renderSettings(root: HTMLElement, host: MenuHost, inRun: boolean): void {
  const settings = host.profile.settings;
  const apply = (patch: Partial<Settings>): void => {
    host.applySettings(patch);
    host.refresh();
  };

  root.append(
    el('div', { class: 'bb-panel bb-panel-wide' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: 'Settings' }),
        el('p', { class: 'bb-sub', text: 'The game should be hard because of the physics, not the presentation.' }),
      ]),

      el('div', { class: 'bb-settings' }, [
        section('Readability', [
          select<TrajectoryMode>({
            label: 'Trajectory guide',
            value: settings.trajectory,
            choices: [
              { value: 'reticle', label: 'Impact point only (default)' },
              { value: 'full', label: 'Full predicted path' },
              { value: 'off', label: 'Off' },
            ],
            onChange: (trajectory) => apply({ trajectory }),
          }),
          toggle({
            label: 'Perfect-bounce timing ring',
            hint: 'Teaches the timing window. Off is a challenge option.',
            value: settings.impactTiming,
            onChange: (impactTiming) => apply({ impactTiming }),
          }),
          toggle({
            label: 'Hazard outlines',
            hint: 'Adds shape cues so colour is never the only signal',
            value: settings.dangerOutlines,
            onChange: (dangerOutlines) => apply({ dangerOutlines }),
          }),
          toggle({ label: 'Damage numbers', value: settings.damageNumbers, onChange: (damageNumbers) => apply({ damageNumbers }) }),
          select<ColorMode>({
            label: 'Colour mode',
            value: settings.colorMode,
            choices: [
              { value: 'default', label: 'Default' },
              { value: 'protan', label: 'Protanopia' },
              { value: 'deutan', label: 'Deuteranopia' },
              { value: 'tritan', label: 'Tritanopia' },
              { value: 'highContrast', label: 'High contrast' },
            ],
            onChange: (colorMode) => apply({ colorMode }),
          }),
          slider({
            label: 'Interface scale',
            value: settings.uiScale,
            min: 0.8,
            max: 1.6,
            step: 0.1,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (uiScale) => apply({ uiScale }),
          }),
        ]),

        section('Motion and effects', [
          slider({
            label: 'Screen shake',
            value: settings.screenShake,
            min: 0,
            max: 1.5,
            step: 0.1,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (screenShake) => apply({ screenShake }),
          }),
          slider({
            label: 'Hit-stop',
            value: settings.hitStop,
            min: 0,
            max: 1.5,
            step: 0.1,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (hitStop) => apply({ hitStop }),
          }),
          slider({
            label: 'Particle density',
            value: settings.particleDensity,
            min: 0.2,
            max: 1.5,
            step: 0.1,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (particleDensity) => apply({ particleDensity }),
          }),
          toggle({
            label: 'Reduce flashing',
            hint: 'Removes full-screen flashes and strobing',
            value: settings.reducedFlashing,
            onChange: (reducedFlashing) => apply({ reducedFlashing }),
          }),
          toggle({
            label: 'Reduce motion',
            hint: 'Disables camera movement, parallax and shake',
            value: settings.reducedMotion,
            onChange: (reducedMotion) => apply({ reducedMotion }),
          }),
        ]),

        section('Controls', [
          slider({
            label: 'Stick sensitivity',
            value: settings.aimSensitivity,
            min: 0.5,
            max: 2,
            step: 0.1,
            format: (v) => `${v.toFixed(1)}x`,
            onChange: (aimSensitivity) => apply({ aimSensitivity }),
          }),
          slider({
            label: 'Dash aim assist',
            value: settings.aimAssist,
            min: 0,
            max: 1,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (aimAssist) => apply({ aimAssist }),
          }),
          toggle({
            label: 'Hold to arm bounce',
            hint: 'Holding the button re-arms automatically. The window is unchanged.',
            value: settings.holdToArm,
            onChange: (holdToArm) => apply({ holdToArm }),
          }),
          toggle({ label: 'Swap brake and dash', value: settings.swapBrakeDash, onChange: (swapBrakeDash) => apply({ swapBrakeDash }) }),
          toggle({ label: 'Controller vibration', value: settings.vibration, onChange: (vibration) => apply({ vibration }) }),
        ]),

        section('Audio', [
          slider({
            label: 'Master',
            value: settings.masterVolume,
            min: 0,
            max: 1,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (masterVolume) => apply({ masterVolume }),
          }),
          slider({
            label: 'Music',
            value: settings.musicVolume,
            min: 0,
            max: 1,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (musicVolume) => apply({ musicVolume }),
          }),
          slider({
            label: 'Effects',
            value: settings.sfxVolume,
            min: 0,
            max: 1,
            step: 0.05,
            format: (v) => `${Math.round(v * 100)}%`,
            onChange: (sfxVolume) => apply({ sfxVolume }),
          }),
        ]),

        section('Diagnostics and data', [
          toggle({ label: 'Show performance', value: settings.showFps, onChange: (showFps) => apply({ showFps }) }),
          toggle({ label: 'Show seed', value: settings.showSeed, onChange: (showSeed) => apply({ showSeed }) }),
          toggle({ label: 'Pause when window loses focus', value: settings.pauseOnBlur, onChange: (pauseOnBlur) => apply({ pauseOnBlur }) }),
          row([
            button({
              label: 'Reset to defaults',
              onClick: () => {
                host.playClick();
                apply(defaultSettings());
              },
            }),
            button({
              label: 'Export save',
              onClick: () => {
                host.playClick();
                void copyToClipboard(host.profile.exportSave());
              },
            }),
            button({
              label: 'Import save',
              onClick: () => {
                host.playClick();
                const text = globalThis.prompt('Paste a save export');
                if (text && host.profile.importSave(text)) host.refresh();
              },
            }),
          ]),
          el('p', {
            class: 'bb-note',
            text: `Played ${formatDuration(host.profile.data.totalPlaySeconds)} across ${host.profile.counter('runsPlayed')} runs.`,
          }),
        ]),
      ]),

      row(
        [
          button({
            label: inRun ? 'Back to pause' : 'Back',
            hint: 'Esc',
            onClick: () => {
              host.playClick();
              host.close();
            },
          }),
        ],
        'bb-row-end',
      ),
    ]),
  );
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    globalThis.prompt('Copy this save data', text);
  }
}
