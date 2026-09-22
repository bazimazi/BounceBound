/**
 * In-run screens: reward, route, altar, build panel, pause, results.
 *
 * Every one of these interrupts play, so each is built to be read and dismissed
 * quickly: one question per screen, keyboard-first, and never more than a screenful
 * of text. Number keys pick options, Escape backs out, Enter confirms.
 *
 * The results screen deserves special mention. The brief is emphatic that losing
 * must feel worthwhile, so it leads with what the player *gained* - echoes,
 * discoveries, achievements, unlock progress - and only then shows how the run
 * ended. It also names the build they were playing, because "that was my Storm
 * run" is what makes someone want another go.
 */

import { formatNumber } from '../core/math';
import { ARCHETYPE_HINTS, ARCHETYPE_LABELS, type MapNode } from '../gen/mapgen';
import { getUpgrade } from '../game/upgradeSystem';
import { STAT_SPECS, formatStat, type StatKey } from '../sim/stats';
import { boundName } from '../content/modifiers';
import { getBiome } from '../content/biomes';
import { getBallClass } from '../content/balls';
import type { Run } from '../run/run';
import type { Profile } from '../meta/profile';
import { bar, button, clear, el, formatDuration, row, section } from './dom';
import { synergyChip, upgradeCard, upgradeChip } from './cards';

export interface ScreenHost {
  profile: Profile;
  playClick: () => void;
  playHover: () => void;
  /** Leaves the current run and returns to the menu. */
  abandonRun: () => void;
  resume: () => void;
  startNewRun: () => void;
  openMenu: () => void;
  openSettings: () => void;
  openJournal: () => void;
}

/** Renders the reward offer. Returns the number of selectable options. */
export function renderReward(root: HTMLElement, run: Run, host: ScreenHost): number {
  const offer = run.reward;
  if (!offer) return 0;
  const showHints = host.profile.isUnlocked('synergy_hints');

  const cards = offer.upgrades.map((def, index) =>
    upgradeCard({
      def,
      build: run.build,
      isNew: !host.profile.hasDiscovered('upgrades', def.id),
      showSynergyHints: showHints,
      index,
      onPick: () => {
        host.playClick();
        run.takeUpgrade(def.id);
      },
      onHover: host.playHover,
    }),
  );

  root.append(
    el('div', { class: 'bb-panel bb-panel-reward' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: offer.title }),
        el('p', {
          class: 'bb-sub',
          text: offer.remaining > 1 ? `${offer.remaining} rewards remaining` : 'Choose one',
        }),
      ]),
      el('div', { class: 'bb-cards' }, cards),
      row(
        [
          button({
            label: `Reroll (${offer.rerolls})`,
            hint: 'R',
            disabled: offer.rerolls <= 0,
            onClick: () => {
              host.playClick();
              run.rerollReward();
            },
            onHover: host.playHover,
          }),
          button({
            label: `Skip for ${offer.skipShards} shards`,
            hint: 'X',
            onClick: () => {
              host.playClick();
              run.skipReward();
            },
            onHover: host.playHover,
          }),
        ],
        'bb-row-end',
      ),
      buildSummaryStrip(run),
    ]),
  );
  return cards.length;
}

/**
 * The route screen.
 *
 * Shows the whole act as a graph with the reachable next nodes highlighted. Each
 * option states what it is and one line about what it costs or offers, because a
 * routing decision the player cannot reason about is just a button press.
 */
export function renderMap(root: HTMLElement, run: Run, host: ScreenHost): number {
  const actIndex = run.map.acts.findIndex((a) => a.nodes.some((n) => n.id === run.currentNode.id));
  const act = run.map.acts[actIndex] ?? run.map.acts[0];
  const choiceIds = new Set(run.mapChoices.map((c) => c.id));
  const biome = getBiome(act.biome);

  const layers: MapNode[][] = [];
  for (const node of act.nodes) {
    (layers[node.layer] ??= []).push(node);
  }

  const graph = el(
    'div',
    { class: 'bb-map' },
    layers.map((nodes, layer) =>
      el(
        'div',
        { class: 'bb-map-layer' },
        [
          el('span', { class: 'bb-map-depth', text: `${layer + 1}` }),
          ...nodes
            .slice()
            .sort((a, b) => a.column - b.column)
            .map((node) => {
              const selectable = choiceIds.has(node.id);
              const current = node.id === run.currentNode.id;
              const label = node.hidden && !selectable ? '?' : ARCHETYPE_LABELS[node.archetype] ?? node.archetype;
              const classes = [
                'bb-node',
                `bb-node-${node.archetype}`,
                selectable ? 'bb-node-open' : '',
                current ? 'bb-node-current' : '',
                node.visited ? 'bb-node-visited' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return el('span', { class: classes, text: label });
            }),
        ],
      ),
    ),
  );

  const options = run.mapChoices.map((node, index) => {
    const label = node.hidden ? 'Unknown' : ARCHETYPE_LABELS[node.archetype] ?? node.archetype;
    return el(
      'button',
      {
        class: `bb-route bb-route-${node.archetype}`,
        type: 'button',
        ariaLabel: `${label}. ${ARCHETYPE_HINTS[node.archetype]}`,
      },
      [
        el('span', { class: 'bb-route-key', text: `${index + 1}` }),
        el('span', { class: 'bb-route-body' }, [
          el('strong', { text: label }),
          el('small', { text: node.hidden ? 'Could be anything. Not a boss.' : ARCHETYPE_HINTS[node.archetype] }),
        ]),
      ],
    );
  });

  for (const [index, node] of run.mapChoices.entries()) {
    options[index].addEventListener('click', (event) => {
      event.preventDefault();
      host.playClick();
      run.chooseNode(node.id);
    });
    options[index].addEventListener('mouseenter', host.playHover);
  }

  root.append(
    el('div', { class: 'bb-panel bb-panel-map' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: biome.name }),
        el('p', { class: 'bb-sub', text: biome.rules }),
      ]),
      graph,
      el('div', { class: 'bb-routes' }, options),
      buildSummaryStrip(run),
    ]),
  );
  return options.length;
}

/** The altar. One prompt, two or three trades, each stating its price. */
export function renderEvent(root: HTMLElement, run: Run, host: ScreenHost): number {
  const prompt = run.eventPrompt;
  if (!prompt) return 0;

  if (prompt.resolved) {
    root.append(
      el('div', { class: 'bb-panel bb-panel-event' }, [
        el('header', { class: 'bb-panel-head' }, [el('h2', { text: prompt.def.name })]),
        el(
          'div',
          { class: 'bb-event-result' },
          prompt.resultLines.filter(Boolean).map((line) => el('p', { text: line })),
        ),
        button({
          label: 'Continue',
          hint: 'Enter',
          onClick: () => {
            host.playClick();
            run.closeEvent();
          },
        }),
      ]),
    );
    return 0;
  }

  const options = prompt.def.choices.map((choice, index) => {
    const allowed = run.canChooseEvent(choice);
    const reason = !allowed
      ? choice.price && run.shards < choice.price
        ? `Needs ${choice.price} shards`
        : 'Not enough integrity'
      : '';
    const node = el(
      'button',
      { class: `bb-route${allowed ? '' : ' bb-card-disabled'}`, type: 'button', disabled: !allowed },
      [
        el('span', { class: 'bb-route-key', text: `${index + 1}` }),
        el('span', { class: 'bb-route-body' }, [
          el('strong', { text: choice.label }),
          el('small', { text: allowed ? choice.preview : `${choice.preview} - ${reason}` }),
          choice.price ? el('small', { class: 'bb-price', text: `${choice.price} shards` }) : null,
        ]),
      ],
    );
    if (allowed) {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        host.playClick();
        run.chooseEventOption(index);
      });
      node.addEventListener('mouseenter', host.playHover);
    }
    return node;
  });

  root.append(
    el('div', { class: 'bb-panel bb-panel-event' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: prompt.def.name }),
        el('p', { class: 'bb-sub', text: prompt.def.text }),
      ]),
      el('div', { class: 'bb-routes' }, options),
      el('p', { class: 'bb-note', text: `${formatNumber(run.shards)} shards available` }),
    ]),
  );
  return options.length;
}

/**
 * The build panel.
 *
 * Reachable at any time with Tab. Shows the full build, active synergies, and the
 * resolved stat block with attribution, so a player who wants to know *why* their
 * damage is what it is can find out.
 */
export function renderBuild(root: HTMLElement, run: Run, host: ScreenHost): void {
  const sheet = run.build.statSheet();
  const stats = run.stats();
  const changed = sheet.changedKeys();
  const identity = run.build.identity();
  const ballClass = getBallClass(run.ballId);

  const statRows = changed.slice(0, 22).map((key: StatKey) => {
    const spec = STAT_SPECS[key];
    const base = sheet.baseValue(key);
    const value = stats[key];
    const better = spec.inverted ? value < base : value > base;
    const contributions = sheet.contributionsFor(key);
    return el('li', { class: better ? 'bb-good' : 'bb-bad' }, [
      el('span', { class: 'bb-stat-name', text: spec.label }),
      el('span', { class: 'bb-stat-value', text: `${formatStat(key, base)} -> ${formatStat(key, value)}` }),
      el('span', {
        class: 'bb-stat-sources',
        text: contributions.map((c) => c.sourceName).slice(0, 3).join(', '),
      }),
    ]);
  });

  const nearMisses = run.build.nearMisses().slice(0, 4);

  root.append(
    el('div', { class: 'bb-panel bb-panel-build' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: `${ballClass.name} - ${identity.map((i) => i.name).join(' / ') || 'Improvised'}` }),
        el('p', { class: 'bb-sub', text: `${run.build.size} upgrades - room ${run.currentNode.layer + 1} - ${boundName(run.bound.level)}` }),
      ]),
      el('div', { class: 'bb-build-grid' }, [
        section(
          'Upgrades',
          [
            el(
              'div',
              { class: 'bb-chips' },
              run.build.list().map((entry) => upgradeChip(entry.def, entry.stacks)),
            ),
          ],
        ),
        section('Synergies', [
          run.build.synergies().length > 0
            ? el('div', { class: 'bb-chips' }, run.build.synergies().map((s) => synergyChip(s.id)))
            : el('p', { class: 'bb-note', text: 'None yet. Two related upgrades will do it.' }),
          nearMisses.length > 0
            ? el('div', { class: 'bb-nearmiss' }, [
                el('h4', { text: 'One piece away' }),
                ...nearMisses.map((s) =>
                  el('p', {}, [
                    el('strong', { text: s.name }),
                    ' - needs ',
                    s.requiresAll
                      .filter((id) => !run.build.has(id))
                      .map((id) => getUpgrade(id)?.name ?? id)
                      .join(', '),
                  ]),
                ),
              ])
            : null,
        ]),
        section('Stats', [el('ul', { class: 'bb-stats' }, statRows.length > 0 ? statRows : [el('li', { text: 'Baseline' })])]),
      ]),
      row([button({ label: 'Back', hint: 'Tab', onClick: () => { host.playClick(); host.resume(); } })], 'bb-row-end'),
    ]),
  );
}

export function renderPause(root: HTMLElement, run: Run, host: ScreenHost): void {
  root.append(
    el('div', { class: 'bb-panel bb-panel-pause' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: 'Paused' }),
        el('p', { class: 'bb-sub', text: `Seed ${run.seed} - ${boundName(run.bound.level)}` }),
      ]),
      el('div', { class: 'bb-stack' }, [
        button({ label: 'Resume', hint: 'Esc', onClick: () => { host.playClick(); host.resume(); } }),
        button({ label: 'Settings', onClick: () => { host.playClick(); host.openSettings(); } }),
        button({ label: 'Journal', onClick: () => { host.playClick(); host.openJournal(); } }),
        button({
          label: 'Abandon run',
          className: 'bb-danger',
          onClick: () => {
            host.playClick();
            host.abandonRun();
          },
        }),
      ]),
      el('p', { class: 'bb-note', text: 'A D steer - Space bounce - Shift brake - S dive - Tab build' }),
    ]),
  );
}

/**
 * The run summary.
 *
 * Structured so that the first thing a player reads is what they earned, and the
 * last thing is how they died. Failure has to feel like progress or the loop
 * breaks.
 */
export function renderResults(root: HTMLElement, run: Run, host: ScreenHost): void {
  const telemetry = run.telemetry;
  const identity = run.build.identity();
  const achievements = run.newAchievements;
  const discoveries = run.build.list().filter((entry) => !host.profile.hasDiscovered('upgrades', entry.def.id));
  const damageEntries = Object.entries(telemetry.damageBySource).sort((a, b) => b[1] - a[1]);
  const totalTaken = damageEntries.reduce((sum, [, value]) => sum + value, 0) || 1;
  const nextBound = host.profile.maxBoundLevel();

  root.append(
    el('div', { class: 'bb-panel bb-panel-results' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: run.victory ? 'Unbound' : 'Run ended' }),
        el('p', {
          class: 'bb-sub',
          text: run.victory
            ? `Completed with ${run.build.size} upgrades as ${identity.map((i) => i.name).join(' / ') || 'an improvised build'}`
            : `${causeText(run.deathCause)} in ${getBiome(telemetry.deepestBiome).name}`,
        }),
      ]),

      section('Earned', [
        el('div', { class: 'bb-gains' }, [
          gain('Echoes', `+${run.earnedEchoes}`, 'Permanent currency, spent in the unlock tree'),
          gain('Rooms cleared', `${telemetry.roomsCleared}`, ''),
          gain('Enemies', `${telemetry.enemiesKilled}`, `${telemetry.elitesKilled} elite`),
          gain('Best combo', `${telemetry.bestCombo}`, `peak multiplier`),
          gain('Bosses', `${telemetry.bossesKilled}`, ''),
          gain('Shards', `${formatNumber(telemetry.shardsEarned)}`, `${formatNumber(telemetry.shardsSpent)} spent`),
        ]),
      ]),

      achievements.length > 0
        ? section(
            'Unlocked',
            achievements.map((result) =>
              el('div', { class: 'bb-unlock-row' }, [
                el('strong', { text: result.def.name }),
                el('span', { text: result.def.description }),
                result.echoes ? el('em', { text: `+${result.echoes} echoes` }) : null,
              ]),
            ),
          )
        : null,

      discoveries.length > 0
        ? section('First seen this run', [
            el('div', { class: 'bb-chips' }, discoveries.map((entry) => upgradeChip(entry.def, entry.stacks))),
          ])
        : null,

      section('The build', [
        el('div', { class: 'bb-chips' }, run.build.list().map((entry) => upgradeChip(entry.def, entry.stacks))),
        run.build.synergies().length > 0
          ? el('div', { class: 'bb-chips' }, run.build.synergies().map((s) => synergyChip(s.id)))
          : el('p', { class: 'bb-note', text: 'No synergies came together this time.' }),
      ]),

      section('What hurt you', [
        ...damageEntries.map(([source, amount]) =>
          el('div', { class: 'bb-damage-row' }, [
            el('span', { text: causeText(source) }),
            bar(amount / totalTaken, '#ff4d6a', `${Math.round(amount)}`),
          ]),
        ),
        el('p', {
          class: 'bb-note',
          text: `Run time ${formatDuration(telemetry.durationSeconds)} - ${telemetry.impacts} impacts - ${telemetry.perfectBounces} perfect`,
        }),
      ]),

      nextBound > run.bound.level
        ? el('p', { class: 'bb-note bb-highlight', text: `${boundName(nextBound)} is now available.` })
        : null,

      row([
        button({ label: 'New run', hint: 'Enter', onClick: () => { host.playClick(); host.startNewRun(); } }),
        button({ label: 'Menu', hint: 'Esc', onClick: () => { host.playClick(); host.openMenu(); } }),
      ], 'bb-row-end'),
    ]),
  );
}

function gain(label: string, value: string, note: string): HTMLElement {
  return el('div', { class: 'bb-gain' }, [
    el('span', { class: 'bb-gain-value', text: value }),
    el('span', { class: 'bb-gain-label', text: label }),
    note ? el('small', { text: note }) : null,
  ]);
}

function causeText(cause: string): string {
  switch (cause) {
    case 'enemy':
      return 'Destroyed by an enemy';
    case 'hazard':
      return 'Destroyed by hazards';
    case 'projectile':
      return 'Shot down';
    case 'field':
      return 'Burned away';
    case 'curse':
      return 'Consumed by a curse';
    case 'completed':
      return 'Finished the descent';
    case 'abandoned':
      return 'Abandoned';
    default:
      return cause;
  }
}

/** A one-line build summary reused at the bottom of interrupting screens. */
function buildSummaryStrip(run: Run): HTMLElement {
  const identity = run.build.identity();
  return el('footer', { class: 'bb-strip' }, [
    el('span', { text: `${formatNumber(run.shards)} shards` }),
    el('span', { text: `${Math.ceil(run.world.ball.hp)}/${Math.round(run.world.ball.maxHp)} integrity` }),
    el('span', { text: identity.map((i) => i.name).join(' / ') || 'Improvised' }),
    el('span', { text: `${run.build.size} upgrades` }),
  ]);
}

export function clearRoot(root: HTMLElement): void {
  clear(root);
}
