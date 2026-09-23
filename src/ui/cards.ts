/**
 * Upgrade cards.
 *
 * A card is a decision, not a document. Playtesting was blunt about the first
 * version: too much text, and it made the game look like a web app. So a card now
 * carries at most four short lines -
 *
 *   NAME              coloured by rarity
 *   effect            one or two short sentences
 *   cost              only when there is one, in warning colour
 *   SYNERGY           only when this card completes one
 *
 * Deliberately cut: the rarity spelled out in words (the colour and the border
 * already say it), the family label, the soft flavour hint, and the long stat
 * list. Numbers are shown as at most two compact deltas, and everything else moved
 * into the tooltip for players who want it.
 *
 * The synergy line is the one addition worth its space. When a card would complete
 * a synergy the player is one piece away from, saying so turns "pick the biggest
 * number" into "pick the thing that finishes my build".
 */

import { RARITY_COLORS } from '../content/ids';
import { SYNERGY_DEFS, synergyPartnersOf } from '../content/synergies';
import { STAT_SPECS, formatStat, type StatKey } from '../sim/stats';
import type { BuildState } from '../game/build';
import type { UpgradeDef } from '../game/upgradeSystem';
import { el } from './dom';

export interface CardOptions {
  def: UpgradeDef;
  build: BuildState;
  /** Shard price; omitted for free rewards. */
  price?: number;
  affordable?: boolean;
  /** Marks upgrades the player has never seen before. */
  isNew?: boolean;
  /** Whether to surface the synergy-completion hint (a meta unlock). */
  showSynergyHints: boolean;
  onPick: () => void;
  onHover?: () => void;
  index: number;
}

export function upgradeCard(options: CardOptions): HTMLElement {
  const { def, build } = options;
  const stacks = build.stacksOf(def.id);
  const completes = completedSynergies(def, build);
  const disabled = options.price !== undefined && options.affordable === false;

  // The tooltip carries what the card deliberately omits, for players who want it.
  const tooltip = [def.text, def.cost, def.hint, `${def.family} - ${def.rarity}`].filter(Boolean).join('\n');

  const node = el(
    'button',
    {
      class: `bb-card bb-card-${def.rarity}${disabled ? ' bb-card-disabled' : ''}`,
      type: 'button',
      style: `--rarity:${RARITY_COLORS[def.rarity]}`,
      disabled,
      title: tooltip,
      ariaLabel: `${def.name}. ${def.text}`,
    },
    [
      el('header', {}, [
        el('span', { class: 'bb-card-name', text: def.name }),
        stacks > 0 ? el('span', { class: 'bb-card-stacks', text: `x${stacks}` }) : null,
        options.isNew ? el('span', { class: 'bb-card-new', text: 'NEW' }) : null,
      ]),
      el('p', { class: 'bb-card-text', text: def.text }),
      def.cost ? el('p', { class: 'bb-card-cost', text: def.cost }) : null,
      statSummary(def),
      options.showSynergyHints && completes.length > 0
        ? el('p', { class: 'bb-card-synergy', text: `COMPLETES ${completes.map((s) => s.name).join(' + ')}` })
        : null,
      options.price !== undefined
        ? el('footer', { class: `bb-card-price${options.affordable === false ? ' bb-unaffordable' : ''}` }, [
            `${options.price}`,
          ])
        : el('footer', { class: 'bb-card-key' }, [`${options.index + 1}`]),
    ],
  );

  node.addEventListener('click', (event) => {
    event.preventDefault();
    if (disabled) return;
    options.onPick();
  });
  if (options.onHover) node.addEventListener('mouseenter', options.onHover);
  return node;
}

/**
 * Which authored synergies this upgrade would complete right now.
 *
 * Only exact completions are listed. Listing "contributes toward" would be noise -
 * almost everything contributes toward something.
 */
export function completedSynergies(def: UpgradeDef, build: BuildState): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const synergy of synergyPartnersOf(def.id)) {
    if (build.hasSynergy(synergy.id)) continue;
    const missing = synergy.requiresAll.filter((id) => !build.has(id));
    const tagsSatisfied = (synergy.requiresTags ?? []).every(([tag, count]) => build.countTag(tag) >= count);
    if (missing.length === 1 && missing[0] === def.id && tagsSatisfied) {
      out.push({ id: synergy.id, name: synergy.name });
    }
  }
  return out;
}

/**
 * A compact stat summary: at most two entries, largest effect first.
 *
 * A card that lists eleven modifiers is a spreadsheet, not a decision. Two is
 * enough to convey the shape of a trade-off; the tooltip has the rest.
 */
function statSummary(def: UpgradeDef): HTMLElement | null {
  const entries: Array<{ key: StatKey; text: string; good: boolean; magnitude: number }> = [];

  for (const [key, value] of Object.entries(def.flat ?? {})) {
    const typed = key as StatKey;
    if (value === undefined || value === 0) continue;
    const spec = STAT_SPECS[typed];
    const good = spec.inverted ? value < 0 : value > 0;
    entries.push({
      key: typed,
      text: `${value > 0 ? '+' : ''}${formatStat(typed, value)} ${spec.label.toLowerCase()}`,
      good,
      // Normalised against the stat's own span so a +45 health and a +0.12 crit
      // chance are comparable when deciding which two to show.
      magnitude: Math.abs(value) / Math.max(1e-6, spec.max - spec.min),
    });
  }
  for (const [key, value] of Object.entries(def.mult ?? {})) {
    const typed = key as StatKey;
    if (value === undefined || value === 1) continue;
    const spec = STAT_SPECS[typed];
    const percent = Math.round((value - 1) * 100);
    if (Math.abs(percent) < 4) continue;
    const good = spec.inverted ? percent < 0 : percent > 0;
    entries.push({
      key: typed,
      text: `${percent > 0 ? '+' : ''}${percent}% ${spec.label.toLowerCase()}`,
      good,
      magnitude: Math.abs(percent) / 100,
    });
  }

  if (entries.length === 0) return null;
  // Largest-magnitude effects first, hard-capped so the card stays scannable.
  entries.sort((a, b) => b.magnitude - a.magnitude);
  const shown = entries.slice(0, 2);
  return el(
    'ul',
    { class: 'bb-card-stats' },
    shown.map((entry) => el('li', { class: entry.good ? 'bb-good' : 'bb-bad', text: entry.text })),
  );
}

/** A compact read-only chip for the build panel and run summary. */
export function upgradeChip(def: UpgradeDef, stacks: number): HTMLElement {
  return el('div', { class: `bb-chip bb-chip-${def.rarity}`, title: def.text }, [
    el('span', { class: 'bb-chip-name', text: def.name }),
    stacks > 1 ? el('span', { class: 'bb-chip-stacks', text: `x${stacks}` }) : null,
  ]);
}

export function synergyChip(id: string): HTMLElement {
  const synergy = SYNERGY_DEFS.find((s) => s.id === id);
  return el('div', { class: 'bb-chip bb-chip-synergy', title: synergy?.description ?? '' }, [
    el('span', { class: 'bb-chip-name', text: synergy?.name ?? id }),
  ]);
}
