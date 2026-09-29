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
import { bar, button, clear, countUp, el, formatDuration, row, section, starPoints, svgEl, svgIcon } from './dom';
import { registerHand, synergyChip, upgradeCard, upgradeChip } from './cards';

export interface ScreenHost {
  profile: Profile;
  playClick: () => void;
  playHover: () => void;
  /** Ends the run for good and shows the summary. */
  abandonRun: () => void;
  /** Leaves the run shelved so it can be resumed later. */
  suspendRun: () => void;
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

  registerHand(cards);

  // The reward screen has no panel box: the hand floats over the dimmed arena, so
  // the cards are the only objects on screen.
  root.append(
    el('div', { class: 'bb-panel bb-panel-bare bb-panel-reward' }, [
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
 * Archetype glyphs for the route map, on a 24-unit grid. Every room type gets a
 * distinct silhouette so the map can be read by shape alone - colour is a second
 * cue, never the only one, which matters under the colour-vision palettes.
 */
const ARCHETYPE_ICONS: Record<string, string> = {
  combat:
    '<path d="M5 5 L16 16"/><path d="M19 5 L8 16"/><path d="M13 19 L19 13"/><path d="M5 13 L11 19"/>' +
    '<path d="M17 17 L20 20"/><path d="M7 17 L4 20"/>',
  elite: `<polygon points="${starPoints(12, 12, 10, 4.2, 6, -90)}" fill="currentColor" fill-opacity="0.25"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  trap: '<path d="M12 3 L22 20 H2 Z" fill="currentColor" fill-opacity="0.18"/><path d="M12 9.5 V14"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
  traversal: '<path d="M5 12 L12 5 L19 12"/><path d="M5 19 L12 12 L19 19" opacity="0.6"/>',
  treasure:
    '<path d="M6 4 H18 L22 9 L12 21 L2 9 Z" fill="currentColor" fill-opacity="0.2"/><path d="M2 9 H22"/><path d="M9 4 L12 9 L15 4"/>',
  challenge: '<path d="M6 3 H18"/><path d="M6 21 H18"/><path d="M7 3 C7 10 17 11 17 21"/><path d="M17 3 C17 10 7 11 7 21"/>',
  puzzle: `<polygon points="${starPoints(12, 12, 10, 7.6, 8, -90)}"/><circle cx="12" cy="12" r="3"/>`,
  shop: '<circle cx="12" cy="12" r="9"/><path d="M12 7 L16 12 L12 17 L8 12 Z" fill="currentColor" fill-opacity="0.45"/>',
  respite:
    '<path d="M12 3 C12 3 5 11 5 15 A7 7 0 0 0 19 15 C19 11 12 3 12 3 Z" fill="currentColor" fill-opacity="0.22"/><path d="M9 15 A3 3 0 0 0 12 18"/>',
  event: '<path d="M2 12 C6 5 18 5 22 12 C18 19 6 19 2 12 Z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  gamble:
    '<rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" fill-opacity="0.15"/>' +
    '<circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/>',
  miniboss:
    '<path d="M12 2 L20 5 V11 C20 16 16.5 19.5 12 22 C7.5 19.5 4 16 4 11 V5 Z" fill="currentColor" fill-opacity="0.2"/><path d="M12 7 V16"/><path d="M8 11 H16"/>',
  boss: '<path d="M3 17 L4.5 7 L9.5 11.5 L12 4 L14.5 11.5 L19.5 7 L21 17 Z" fill="currentColor" fill-opacity="0.3"/><path d="M3 20.5 H21"/>',
  secret: '<circle cx="12" cy="9" r="4"/><path d="M10.4 12.3 L9 20 H15 L13.6 12.3"/>',
};

const UNKNOWN_ICON =
  '<path d="M9 9 A3 3 0 1 1 13.6 11.5 C12.6 12.1 12 12.9 12 14.5"/><circle cx="12" cy="18" r="0.7" fill="currentColor"/>';

/**
 * Archetype colours. Grouped by meaning rather than made unique: danger warm,
 * rest and trade green, oddities violet, plain fights neutral, so a route's
 * temperament reads at a glance even before the icon does.
 */
const ARCHETYPE_COLOURS: Record<string, string> = {
  combat: '#c8d4e8',
  elite: '#f0b14a',
  trap: '#ff9a5a',
  traversal: '#7fe8ff',
  treasure: '#ffd15c',
  challenge: '#ff9a5a',
  puzzle: '#7fe8ff',
  shop: '#5ce8a0',
  respite: '#5ce8a0',
  event: '#c0a0ff',
  gamble: '#ff7ab0',
  miniboss: '#f0b14a',
  boss: '#ff4d6a',
  secret: '#c0a0ff',
};

/** Map board coordinate space; the board's CSS aspect ratio matches it exactly. */
const MAP_W = 1000;
const MAP_H = 300;

/**
 * The route screen.
 *
 * Shows the whole act as a node graph, entrance on the left and the boss on the
 * right, with the reachable next nodes pulsing. Nodes are clickable as well as the
 * numbered route options under the board: the board is for seeing the shape of
 * the act, the options are for keyboard play and for the one-line hint. Each
 * option states what it is and what it costs or offers, because a routing
 * decision the player cannot reason about is just a button press.
 */
export function renderMap(root: HTMLElement, run: Run, host: ScreenHost): number {
  const actIndex = run.map.acts.findIndex((a) => a.nodes.some((n) => n.id === run.currentNode.id));
  const act = run.map.acts[actIndex] ?? run.map.acts[0];
  const choiceIds = new Set(run.mapChoices.map((c) => c.id));
  const biome = getBiome(act.biome);

  const choose = (node: MapNode): void => {
    host.playClick();
    run.chooseNode(node.id);
  };

  const { graph, tokens } = routeGraph(act.nodes, run.currentNode.id, choiceIds, choose, host.playHover);

  const options = run.mapChoices.map((node, index) => {
    const label = node.hidden ? 'Unknown' : ARCHETYPE_LABELS[node.archetype] ?? node.archetype;
    const option = el(
      'button',
      {
        class: `bb-route bb-route-${node.archetype}`,
        type: 'button',
        style: `--node:${node.hidden ? '#9fb3cc' : ARCHETYPE_COLOURS[node.archetype] ?? '#9fb3cc'};--i:${index}`,
        ariaLabel: `${label}. ${ARCHETYPE_HINTS[node.archetype]}`,
      },
      [
        el('span', { class: 'bb-route-key', text: `${index + 1}` }),
        svgIcon(node.hidden ? UNKNOWN_ICON : ARCHETYPE_ICONS[node.archetype] ?? UNKNOWN_ICON, 'bb-route-icon'),
        el('span', { class: 'bb-route-body' }, [
          el('strong', { text: label }),
          el('small', { text: node.hidden ? 'Could be anything. Not a boss.' : ARCHETYPE_HINTS[node.archetype] }),
        ]),
      ],
    );
    option.addEventListener('click', (event) => {
      event.preventDefault();
      choose(node);
    });
    option.addEventListener('mouseenter', host.playHover);
    // Hovering an option lights its node on the board, and vice versa, so the
    // list and the graph read as one thing.
    const token = tokens.get(node.id);
    if (token) linkHover(option, token);
    return option;
  });

  root.append(
    el('div', { class: 'bb-panel bb-panel-map' }, [
      el('header', { class: 'bb-panel-head' }, [
        el('h2', { text: biome.name }),
        el('p', { class: 'bb-sub', text: biome.rules }),
      ]),
      graph,
      el('div', { class: 'bb-routes bb-routes-row' }, options),
      buildSummaryStrip(run),
    ]),
  );
  return options.length;
}

/**
 * Builds the act board: an SVG layer of curved edges under absolutely positioned
 * node tokens. Positions are percentages of a fixed-aspect board, so the SVG and
 * the tokens agree at any interface scale without measuring anything.
 */
function routeGraph(
  nodes: MapNode[],
  currentId: number,
  choiceIds: Set<number>,
  choose: (node: MapNode) => void,
  playHover: () => void,
): { graph: HTMLElement; tokens: Map<number, HTMLElement> } {
  const layerCount = Math.max(1, ...nodes.map((n) => n.layer + 1));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const position = (node: MapNode): { x: number; y: number } => ({
    x: 5.5 + (layerCount > 1 ? node.layer / (layerCount - 1) : 0.5) * 89,
    y: 15 + (Math.min(3, Math.max(0, node.column)) / 3) * 70,
  });

  // Edges first, so tokens sit on top. Travelled edges are solid, the edges out of
  // the current room march toward the choices, and the rest of the act is a faint
  // dotted suggestion of what lies ahead.
  const edges: SVGElement[] = [];
  for (const node of nodes) {
    for (const nextId of node.next) {
      const target = byId.get(nextId);
      if (!target) continue;
      const a = position(node);
      const b = position(target);
      const x1 = (a.x / 100) * MAP_W;
      const y1 = (a.y / 100) * MAP_H;
      const x2 = (b.x / 100) * MAP_W;
      const y2 = (b.y / 100) * MAP_H;
      const mid = (x1 + x2) / 2;
      const kind =
        node.visited && target.visited
          ? ' bb-map-edge-visited'
          : node.id === currentId && choiceIds.has(target.id)
            ? ' bb-map-edge-open'
            : '';
      edges.push(
        svgEl('path', {
          class: `bb-map-edge${kind}`,
          d: `M${x1.toFixed(1)} ${y1.toFixed(1)} C${mid.toFixed(1)} ${y1.toFixed(1)} ${mid.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        }),
      );
    }
  }

  const tokens = new Map<number, HTMLElement>();
  const tokenNodes = nodes.map((node) => {
    const selectable = choiceIds.has(node.id);
    const current = node.id === currentId;
    const concealed = node.hidden && !selectable;
    const label = concealed ? 'Unknown' : ARCHETYPE_LABELS[node.archetype] ?? node.archetype;
    const { x, y } = position(node);
    const classes = [
      'bb-node',
      `bb-node-${node.archetype}`,
      selectable ? 'bb-node-open' : '',
      current ? 'bb-node-current' : '',
      node.visited ? 'bb-node-visited' : '',
      concealed ? 'bb-node-hidden' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const attrs = {
      class: classes,
      title: label,
      style: `--x:${x.toFixed(2)};--y:${y.toFixed(2)};--node:${concealed ? '#8a98b0' : ARCHETYPE_COLOURS[node.archetype] ?? '#9fb3cc'};--i:${node.layer}`,
    };
    const icon = svgIcon(concealed ? UNKNOWN_ICON : ARCHETYPE_ICONS[node.archetype] ?? UNKNOWN_ICON, 'bb-node-icon');

    if (!selectable) return el('span', attrs, [icon]);

    // Selectable tokens are real buttons, but kept out of the tab order: the
    // numbered route options below already give keyboard players the same choice,
    // and tabbing through both would visit every option twice.
    const token = el('button', { ...attrs, type: 'button', tabindex: -1, ariaLabel: label }, [icon]);
    token.addEventListener('click', (event) => {
      event.preventDefault();
      choose(node);
    });
    token.addEventListener('mouseenter', playHover);
    tokens.set(node.id, token);
    return token;
  });

  const graph = el('div', { class: 'bb-map' }, [
    svgEl('svg', { class: 'bb-map-lines', viewBox: `0 0 ${MAP_W} ${MAP_H}`, ariaHidden: 'true', focusable: 'false' }, edges),
    ...tokenNodes,
  ]);
  return { graph, tokens };
}

/** Mirrors hover between a route option and its board token. */
function linkHover(option: HTMLElement, token: HTMLElement): void {
  const on = (): void => {
    option.classList.add('bb-route-hot');
    token.classList.add('bb-node-hot');
  };
  const off = (): void => {
    option.classList.remove('bb-route-hot');
    token.classList.remove('bb-node-hot');
  };
  for (const target of [option, token]) {
    target.addEventListener('mouseenter', on);
    target.addEventListener('mouseleave', off);
    target.addEventListener('focus', on);
    target.addEventListener('blur', off);
  }
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
          label: 'Save and quit',
          title: 'Keeps this run so you can continue it later',
          onClick: () => {
            host.playClick();
            host.suspendRun();
          },
        }),
        button({
          label: 'Abandon run',
          className: 'bb-danger',
          title: 'Ends the run and discards it',
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

  const panel = el('div', { class: `bb-panel bb-panel-results ${run.victory ? 'bb-results-victory' : 'bb-results-defeat'}` }, [
    el('header', { class: 'bb-panel-head' }, [
      el('h2', { class: 'bb-results-title', text: run.victory ? 'Unbound' : 'Run ended' }),
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
            el('div', { class: 'bb-unlock-row', title: result.def.description }, [
              el('strong', { text: result.def.name }),
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

    // Damage breakdown is bars, not prose: the shape is the information.
    section('What hurt you', [
      ...damageEntries.slice(0, 4).map(([source, amount]) =>
        el('div', { class: 'bb-damage-row' }, [
          el('span', { text: causeText(source) }),
          bar(amount / totalTaken, '#ff4d6a', `${Math.round(amount)}`),
        ]),
      ),
      el('p', {
        class: 'bb-note',
        text: `${formatDuration(telemetry.durationSeconds)} - ${telemetry.impacts} impacts - ${telemetry.perfectBounces} perfect`,
      }),
    ]),

    nextBound > run.bound.level
      ? el('p', { class: 'bb-note bb-highlight', text: `${boundName(nextBound)} is now available.` })
      : null,

    row([
      button({ label: 'New run', hint: 'Enter', onClick: () => { host.playClick(); host.startNewRun(); } }),
      button({ label: 'Menu', hint: 'Esc', onClick: () => { host.playClick(); host.openMenu(); } }),
    ], 'bb-row-end'),
  ]);
  root.append(panel);

  // The payout counts up after the title lands, one number after another, so the
  // eye is walked through what the run earned instead of being handed a table.
  countUp([...panel.querySelectorAll<HTMLElement>('.bb-gain-value')], { delay: 420 });
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
