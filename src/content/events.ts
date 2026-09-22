/**
 * Altar events.
 *
 * Every event is a trade, never a gift. The pattern is deliberate: the player is
 * offered something they want, at a price expressed in a *different* currency to
 * the one they are tracking - integrity for power, shards for information, a
 * curse for a legendary. That forces an actual evaluation of the run's state
 * rather than a reflexive yes.
 *
 * Outcomes are resolved by the run layer so that events can touch anything
 * (build, currencies, map, world) without this file depending on all of it.
 */

import type { CurrencyId } from './ids';

export type EventOutcomeKind =
  | 'grantUpgrade'
  | 'grantRandomUpgrade'
  | 'grantCursedUpgrade'
  | 'damage'
  | 'heal'
  | 'maxHealth'
  | 'currency'
  | 'shieldCharge'
  | 'reroll'
  | 'revealMap'
  | 'upgradeOffer'
  | 'spawnElite'
  | 'nothing';

export interface EventOutcome {
  kind: EventOutcomeKind;
  /** Magnitude; meaning depends on kind. */
  amount?: number;
  /** Upgrade id, currency id, or family restriction. */
  ref?: string;
  currency?: CurrencyId;
  /** Player-facing result line. */
  text: string;
}

export interface EventChoice {
  label: string;
  /** Short consequence preview. Never lies, but may be vague. */
  preview: string;
  /** Shard cost to select. */
  price?: number;
  /** Requires this much current integrity to be selectable. */
  requiresHealth?: number;
  outcomes: EventOutcome[];
  /** Weighted alternative outcome sets, for genuinely risky choices. */
  gamble?: Array<{ weight: number; outcomes: EventOutcome[] }>;
}

export interface EventDef {
  id: string;
  name: string;
  /** Flavour, two lines maximum. */
  text: string;
  choices: EventChoice[];
  /** Earliest depth this can appear. */
  minDepth: number;
  weight: number;
  unlock?: string;
  /** Once taken, remembered in the journal. */
  discoveryId: string;
}

export const EVENT_DEFS: EventDef[] = [
  {
    id: 'sacrifice_altar',
    name: 'The Weighing Stone',
    text: 'A flat slab, worn smooth. It does not want shards.',
    minDepth: 1,
    weight: 10,
    discoveryId: 'event_sacrifice',
    choices: [
      {
        label: 'Give it integrity',
        preview: 'Lose 18 integrity. Gain a rare upgrade.',
        requiresHealth: 20,
        outcomes: [
          { kind: 'damage', amount: 18, text: 'The stone takes its share.' },
          { kind: 'upgradeOffer', amount: 3, ref: 'rare', text: 'Something surfaces in return.' },
        ],
      },
      {
        label: 'Give it capacity',
        preview: 'Permanently lose 15 maximum integrity. Gain two upgrades.',
        outcomes: [
          { kind: 'maxHealth', amount: -15, text: 'You are smaller than you were.' },
          { kind: 'upgradeOffer', amount: 3, text: 'Two choices, taken together.' },
          { kind: 'upgradeOffer', amount: 3, text: '' },
        ],
      },
      { label: 'Leave it', preview: 'Nothing happens.', outcomes: [{ kind: 'nothing', text: 'You leave it alone.' }] },
    ],
  },
  {
    id: 'wandering_merchant',
    name: 'The Unlicensed Merchant',
    text: 'It has no stall, no sign, and an unreasonable number of pockets.',
    minDepth: 2,
    weight: 9,
    discoveryId: 'event_merchant',
    choices: [
      {
        label: 'Buy the sealed one',
        preview: 'Pay 25 shards for an unknown upgrade.',
        price: 25,
        outcomes: [{ kind: 'grantRandomUpgrade', amount: 1, text: 'You open it away from the light.' }],
      },
      {
        label: 'Buy information',
        preview: 'Pay 12 shards. The rest of this depth is revealed.',
        price: 12,
        outcomes: [
          { kind: 'revealMap', amount: 1, text: 'It draws the route in the dust.' },
          { kind: 'reroll', amount: 1, text: 'And throws in a reroll.' },
        ],
      },
      {
        label: 'Rob it',
        preview: 'Probably fine.',
        outcomes: [],
        gamble: [
          {
            weight: 45,
            outcomes: [
              { kind: 'currency', amount: 55, currency: 'shards', text: 'The pockets were worth it.' },
              { kind: 'grantRandomUpgrade', amount: 1, text: 'So was the sleeve.' },
            ],
          },
          {
            weight: 55,
            outcomes: [
              { kind: 'damage', amount: 26, text: 'It was faster than it looked.' },
              { kind: 'spawnElite', amount: 1, text: 'And it was not alone.' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'cursed_reliquary',
    name: 'The Reliquary',
    text: 'Sealed for a reason that was never written down.',
    minDepth: 3,
    weight: 8,
    discoveryId: 'event_reliquary',
    choices: [
      {
        label: 'Break the seal',
        preview: 'Gain a legendary upgrade and a curse.',
        outcomes: [
          { kind: 'upgradeOffer', amount: 2, ref: 'legendary', text: 'It was worth opening.' },
          { kind: 'grantCursedUpgrade', amount: 1, text: 'It was also worth sealing.' },
        ],
      },
      {
        label: 'Weigh it and move on',
        preview: 'Gain 40 shards.',
        outcomes: [{ kind: 'currency', amount: 40, currency: 'shards', text: 'Heavy, at least.' }],
      },
    ],
  },
  {
    id: 'injured_traveller',
    name: 'Something Still Bouncing',
    text: 'Another one, slower than you, running out of arc.',
    minDepth: 2,
    weight: 8,
    discoveryId: 'event_traveller',
    choices: [
      {
        label: 'Share your integrity',
        preview: 'Lose 15 integrity. It follows you for the rest of the depth.',
        requiresHealth: 18,
        outcomes: [
          { kind: 'damage', amount: 15, text: 'It steadies.' },
          { kind: 'grantUpgrade', ref: 'parasite', text: 'It stays close after that.' },
        ],
      },
      {
        label: 'Take what it has',
        preview: 'Gain 30 shards and a shield charge.',
        outcomes: [
          { kind: 'currency', amount: 30, currency: 'shards', text: 'It does not resist.' },
          { kind: 'shieldCharge', amount: 1, text: 'You keep its shell.' },
        ],
      },
      { label: 'Leave it bouncing', preview: 'Nothing happens.', outcomes: [{ kind: 'nothing', text: 'You pass it.' }] },
    ],
  },
  {
    id: 'calibration_machine',
    name: 'The Calibrator',
    text: 'It wants to adjust you. It is not clear in which direction.',
    minDepth: 3,
    weight: 7,
    discoveryId: 'event_calibrator',
    choices: [
      {
        label: 'Submit to calibration',
        preview: 'Random: a large gain or a real loss.',
        outcomes: [],
        gamble: [
          {
            weight: 34,
            outcomes: [
              { kind: 'maxHealth', amount: 35, text: 'Reinforced beyond specification.' },
              { kind: 'heal', amount: 999, text: 'And fully restored.' },
            ],
          },
          {
            weight: 33,
            outcomes: [{ kind: 'upgradeOffer', amount: 4, ref: 'rare', text: 'Retuned toward something sharper.' }],
          },
          {
            weight: 33,
            outcomes: [
              { kind: 'maxHealth', amount: -22, text: 'Tolerances reduced.' },
              { kind: 'currency', amount: 60, currency: 'shards', text: 'The excess was returned as shards.' },
            ],
          },
        ],
      },
      {
        label: 'Feed it shards instead',
        preview: 'Pay 30 shards for a guaranteed uncommon upgrade and a reroll.',
        price: 30,
        outcomes: [
          { kind: 'upgradeOffer', amount: 3, text: 'A safe adjustment.' },
          { kind: 'reroll', amount: 1, text: '' },
        ],
      },
    ],
  },
  {
    id: 'unknown_portal',
    name: 'An Opening',
    text: 'It goes somewhere. The somewhere is not specified.',
    minDepth: 4,
    weight: 6,
    unlock: 'event_portals',
    discoveryId: 'event_portal',
    choices: [
      {
        label: 'Go through',
        preview: 'Skip ahead, but arrive in trouble.',
        outcomes: [
          { kind: 'spawnElite', amount: 1, text: 'You arrive mid-fight.' },
          { kind: 'upgradeOffer', amount: 3, ref: 'rare', text: 'Whatever was guarding it is yours now.' },
        ],
      },
      {
        label: 'Reach in only',
        preview: 'Gain 45 shards and take 10 damage.',
        outcomes: [
          { kind: 'currency', amount: 45, currency: 'shards', text: 'Your hand comes back.' },
          { kind: 'damage', amount: 10, text: 'Mostly.' },
        ],
      },
      { label: 'Seal it', preview: 'Gain a shield charge.', outcomes: [{ kind: 'shieldCharge', amount: 1, text: 'You wedge it shut.' }] },
    ],
  },
  {
    id: 'echo_font',
    name: 'The Font',
    text: 'It remembers other runs. It is willing to trade the memory.',
    minDepth: 5,
    weight: 5,
    discoveryId: 'event_font',
    choices: [
      {
        label: 'Trade shards for echoes',
        preview: 'Convert 60 shards into permanent currency.',
        price: 60,
        outcomes: [{ kind: 'currency', amount: 14, currency: 'echoes', text: 'It keeps the shards. You keep the echo.' }],
      },
      {
        label: 'Trade a curse for echoes',
        preview: 'Take a curse. Gain a lot of permanent currency.',
        outcomes: [
          { kind: 'grantCursedUpgrade', amount: 1, text: 'It marks you.' },
          { kind: 'currency', amount: 30, currency: 'echoes', text: 'And pays generously.' },
        ],
      },
      { label: 'Refuse', preview: 'Nothing happens.', outcomes: [{ kind: 'nothing', text: 'You keep your own memories.' }] },
    ],
  },
];

export const EVENT_BY_ID: Record<string, EventDef> = Object.fromEntries(EVENT_DEFS.map((e) => [e.id, e]));

export function eligibleEvents(depth: number, unlocked: (id: string) => boolean, seen: Set<string>): EventDef[] {
  const pool = EVENT_DEFS.filter((e) => e.minDepth <= depth && (!e.unlock || unlocked(e.unlock)));
  // Prefer events not yet seen this run, but never return an empty pool.
  const fresh = pool.filter((e) => !seen.has(e.id));
  return fresh.length > 0 ? fresh : pool;
}
