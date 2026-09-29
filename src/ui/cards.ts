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
 *
 * What replaced the words is *shape*: a portrait card with a large family emblem,
 * a rarity frame (plain, soft edge, glow, animated foil, smoke), and physical
 * motion - dealt in, idly floating, tilting toward the pointer. All of that is
 * presentation only. Every handler fires the pick synchronously; the flourish on
 * pick is a detached clone, so nothing the player sees can delay or swallow input.
 */

import { RARITY_COLORS, type UpgradeFamily } from '../content/ids';
import { SYNERGY_DEFS, synergyPartnersOf } from '../content/synergies';
import { STAT_SPECS, formatStat, type StatKey } from '../sim/stats';
import type { BuildState } from '../game/build';
import type { UpgradeDef } from '../game/upgradeSystem';
import { el, reducedMotion, starPoints, svgIcon } from './dom';

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

/**
 * Family colours. Duplicated from the canvas HUD's `familyColour` on purpose: the
 * DOM layer does not import the renderer, and seven hex values are cheaper to keep
 * in step than a dependency between the two.
 */
export const FAMILY_COLOURS: Record<UpgradeFamily, string> = {
  bounce: '#7fe8ff',
  impact: '#ff9a5a',
  movement: '#a0ffc0',
  defense: '#6ab0ff',
  utility: '#ffd15c',
  body: '#c0a0ff',
  transformation: '#ff7ab0',
};

/**
 * One glyph per family, drawn on a 48-unit grid. Each is a distinct silhouette -
 * arc, burst, chevrons, shield, gear, orbit, hexagram - so the family reads from
 * across the room, before the name does.
 */
const FAMILY_GLYPHS: Record<UpgradeFamily, string> = {
  // A ball squashing at the bottom of a dashed rebound arc.
  bounce:
    '<path d="M4 40 Q14 6 24 36 Q34 12 44 40" stroke-dasharray="3 4" opacity="0.7"/>' +
    '<path d="M6 43 H42" opacity="0.5"/>' +
    '<ellipse cx="24" cy="36.5" rx="7" ry="5" fill="currentColor" fill-opacity="0.35"/>',
  // An eight-point starburst around a hot core.
  impact:
    `<polygon points="${starPoints(24, 24, 21, 8.5, 8, -90)}" fill="currentColor" fill-opacity="0.18"/>` +
    '<circle cx="24" cy="24" r="4.5" fill="currentColor"/>',
  // Three chevrons fading out behind the lead one.
  movement:
    '<path d="M7 12 L17 24 L7 36" opacity="0.35"/>' +
    '<path d="M17 12 L27 24 L17 36" opacity="0.65"/>' +
    '<path d="M27 12 L37 24 L27 36" stroke-width="3"/>',
  // A shield with a centre ridge.
  defense:
    '<path d="M24 4 L40 10 V23 C40 33 33 40 24 44 C15 40 8 33 8 23 V10 Z" fill="currentColor" fill-opacity="0.16"/>' +
    '<path d="M24 11 V36" opacity="0.6"/>',
  // A gear: tool, trick, knack.
  utility:
    `<polygon points="${starPoints(24, 24, 19, 14.5, 10, -90)}" fill="currentColor" fill-opacity="0.16"/>` +
    '<circle cx="24" cy="24" r="6"/>',
  // A heavy sphere with an orbit ring: the ball's own body.
  body:
    '<circle cx="24" cy="24" r="12" fill="currentColor" fill-opacity="0.22"/>' +
    '<ellipse cx="24" cy="24" rx="21" ry="7.5" transform="rotate(-24 24 24)" opacity="0.7"/>' +
    '<circle cx="19.5" cy="19.5" r="2.5" fill="currentColor" stroke="none" opacity="0.8"/>',
  // Two opposed triangles: something turning into something else.
  transformation:
    '<path d="M24 5 L42 36 H6 Z" fill="currentColor" fill-opacity="0.12"/>' +
    '<path d="M24 43 L6 12 H42 Z" opacity="0.75"/>',
};

/** Tilt range in degrees each way. Enough to read as a physical object, not a wobble. */
const TILT_DEGREES = 12;

export function upgradeCard(options: CardOptions): HTMLElement {
  const { def, build } = options;
  const stacks = build.stacksOf(def.id);
  const completes = completedSynergies(def, build);
  const disabled = options.price !== undefined && options.affordable === false;
  const family = FAMILY_COLOURS[def.family] ?? RARITY_COLORS[def.rarity];

  // The tooltip carries what the card deliberately omits, for players who want it.
  const tooltip = [def.text, def.cost, def.hint, `${def.family} - ${def.rarity}`].filter(Boolean).join('\n');

  const node = el(
    'button',
    {
      class: `bb-card bb-card-${def.rarity} bb-fam-${def.family}${disabled ? ' bb-card-disabled' : ''}`,
      type: 'button',
      style: `--rarity:${RARITY_COLORS[def.rarity]};--fam:${family};--i:${options.index}`,
      disabled,
      title: tooltip,
      ariaLabel: `${def.name}. ${def.text}`,
    },
    [
      // The frame is the element that tilts; the button itself carries the deal-in
      // and idle float, so the two motions compose instead of fighting.
      el('span', { class: 'bb-card-frame' }, [
        el('span', { class: 'bb-card-face' }, [
          el('span', { class: 'bb-card-emblem' }, [
            svgIcon(FAMILY_GLYPHS[def.family] ?? FAMILY_GLYPHS.utility, 'bb-card-glyph', '0 0 48 48'),
            stacks > 0 ? el('span', { class: 'bb-card-stacks', text: `x${stacks}` }) : null,
            options.isNew ? el('span', { class: 'bb-card-new', text: 'NEW' }) : null,
          ]),
          el('header', {}, [el('span', { class: 'bb-card-name', text: def.name })]),
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
        ]),
        el('span', { class: 'bb-card-shine', ariaHidden: 'true' }),
      ]),
    ],
  );

  node.addEventListener('click', (event) => {
    event.preventDefault();
    if (disabled) return;
    // The pick happens first and unconditionally; the flourish is decoration.
    options.onPick();
    playPickFlourish(node);
  });
  if (options.onHover) node.addEventListener('mouseenter', options.onHover);
  if (!disabled) attachTilt(node);
  return node;
}

/**
 * Pointer-driven 3D tilt.
 *
 * The pointer position is written into CSS custom properties and the stylesheet
 * does the rest: the frame rotates toward the pointer, a glossy highlight follows
 * it, and the emblem shifts slightly for parallax. Leaving the card clears the
 * properties, and the stylesheet springs the frame back to rest.
 */
function attachTilt(node: HTMLElement): void {
  node.addEventListener('pointermove', (event) => {
    if (reducedMotion()) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    node.style.setProperty('--rx', `${((0.5 - py) * 2 * TILT_DEGREES).toFixed(2)}deg`);
    node.style.setProperty('--ry', `${((px - 0.5) * 2 * TILT_DEGREES).toFixed(2)}deg`);
    node.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    node.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    node.style.setProperty('--px', `${(px * 2 - 1).toFixed(3)}`);
    node.style.setProperty('--py', `${(py * 2 - 1).toFixed(3)}`);
  });
  node.addEventListener('pointerleave', () => {
    for (const prop of ['--rx', '--ry', '--mx', '--my', '--px', '--py']) node.style.removeProperty(prop);
  });
}

/**
 * The "you took it" flourish: a punch, a wobble, a flash, and the card flies off.
 *
 * It plays on a detached clone pinned over the original, because the overlay is
 * rebuilt the moment the pick lands - by the next frame the real card no longer
 * exists. The clone is inert (aria-hidden, no pointer events, not focusable) and
 * removes itself.
 */
function playPickFlourish(card: HTMLElement): void {
  card.classList.add('bb-card-picked');
  if (reducedMotion()) return;
  const rect = card.getBoundingClientRect();
  // No layout (a test DOM, a hidden overlay): nothing to animate from.
  if (rect.width === 0 || rect.height === 0) return;

  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add('bb-card-ghost');
  ghost.removeAttribute('title');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('tabindex', '-1');
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.append(ghost);
  globalThis.setTimeout(() => ghost.remove(), 650);
}

/**
 * Number keys pick cards through the game's own key handler, which never touches
 * the DOM. So the current hand is registered here, and one shared listener plays
 * the same flourish the click path does. Registering replaces the previous hand,
 * and a card that has left the document is ignored, so a stale hand is harmless.
 */
let currentHand: HTMLElement[] = [];
let handListenerInstalled = false;

export function registerHand(cards: HTMLElement[]): void {
  currentHand = cards;
  if (handListenerInstalled) return;
  handListenerInstalled = true;
  globalThis.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    const match = /^Digit([1-9])$/.exec(event.code);
    if (!match) return;
    const card = currentHand[Number(match[1]) - 1];
    if (!card || !card.isConnected || (card as HTMLButtonElement).disabled) return;
    playPickFlourish(card);
  });
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

/**
 * A compact read-only chip for the build panel and run summary: a family dot and
 * the name, on a pill tinted by rarity.
 */
export function upgradeChip(def: UpgradeDef, stacks: number): HTMLElement {
  return el(
    'div',
    {
      class: `bb-chip bb-chip-${def.rarity}`,
      title: def.text,
      style: `--rarity:${RARITY_COLORS[def.rarity]};--fam:${FAMILY_COLOURS[def.family] ?? RARITY_COLORS[def.rarity]}`,
    },
    [
      el('span', { class: 'bb-chip-dot', ariaHidden: 'true' }),
      el('span', { class: 'bb-chip-name', text: def.name }),
      stacks > 1 ? el('span', { class: 'bb-chip-stacks', text: `x${stacks}` }) : null,
    ],
  );
}

export function synergyChip(id: string): HTMLElement {
  const synergy = SYNERGY_DEFS.find((s) => s.id === id);
  return el('div', { class: 'bb-chip bb-chip-synergy', title: synergy?.description ?? '' }, [
    el('span', { class: 'bb-chip-name', text: synergy?.name ?? id }),
  ]);
}
