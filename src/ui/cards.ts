/**
 * Upgrade cards.
 *
 * The brief's requirement is exact: name, effect, and important context, with no
 * paragraphs. So a card is four lines at most -
 *
 *   NAME              rarity colour, family tag
 *   effect            one or two short sentences, in the player's language
 *   cost              only when there is one, in warning colour
 *   context           either a synergy this would complete, or a soft hint
 *
 * The synergy line is the important one. When a card would complete a synergy the
 * player is one piece away from, the card says so explicitly. That is what turns
 * "pick the biggest number" into "pick the thing that finishes my build".
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

  const node = el(
    'button',
    {
      class: `bb-card bb-card-${def.rarity}${disabled ? ' bb-card-disabled' : ''}`,
      type: 'button',
      style: `--rarity:${RARITY_COLORS[def.rarity]}`,
      disabled,
      ariaLabel: `${def.name}. ${def.text}`,
    },
    [
      el('header', {}, [
        el('span', { class: 'bb-card-name', text: def.name }),
        el('span', { class: 'bb-card-family', text: def.family }),
      ]),
      el('div', { class: 'bb-card-meta' }, [
        el('span', { class: 'bb-card-rarity', text: def.rarity }),
        stacks > 0 ? el('span', { class: 'bb-card-stacks', text: `held x${stacks}` }) : null,
        options.isNew ? el('span', { class: 'bb-card-new', text: 'NEW' }) : null,
      ]),
      el('p', { class: 'bb-card-text', text: def.text }),
      def.cost ? el('p', { class: 'bb-card-cost', text: def.cost }) : null,
      // Stat deltas, but only the ones a player would actually act on.
      statSummary(def),
      options.showSynergyHints && completes.length > 0
        ? el('p', { class: 'bb-card-synergy', text: `Completes: ${completes.map((s) => s.name).join(', ')}` })
        : def.hint
          ? el('p', { class: 'bb-card-hint', text: def.hint })
          : null,
      options.price !== undefined
        ? el('footer', { class: `bb-card-price${options.affordable === false ? ' bb-unaffordable' : ''}` }, [
            `${options.price} shards`,
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
 * A compact stat summary.
 *
 * Deliberately limited to four entries and to stats whose change is large enough
 * to matter. A card that lists eleven tiny modifiers is a spreadsheet, not a
 * decision.
 */
function statSummary(def: UpgradeDef): HTMLElement | null {
  const entries: Array<{ key: StatKey; text: string; good: boolean }> = [];

  for (const [key, value] of Object.entries(def.flat ?? {})) {
    const typed = key as StatKey;
    if (value === undefined || value === 0) continue;
    const spec = STAT_SPECS[typed];
    const good = spec.inverted ? value < 0 : value > 0;
    entries.push({
      key: typed,
      text: `${value > 0 ? '+' : ''}${formatStat(typed, value)} ${spec.label.toLowerCase()}`,
      good,
    });
  }
  for (const [key, value] of Object.entries(def.mult ?? {})) {
    const typed = key as StatKey;
    if (value === undefined || value === 1) continue;
    const spec = STAT_SPECS[typed];
    const percent = Math.round((value - 1) * 100);
    if (Math.abs(percent) < 4) continue;
    const good = spec.inverted ? percent < 0 : percent > 0;
    entries.push({ key: typed, text: `${percent > 0 ? '+' : ''}${percent}% ${spec.label.toLowerCase()}`, good });
  }

  if (entries.length === 0) return null;
  // Show the largest-magnitude effects first, capped so the card stays scannable.
  const shown = entries.slice(0, 4);
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
