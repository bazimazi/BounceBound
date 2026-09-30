/**
 * The career: account rank, ball mastery, and the cosmetics they pay out.
 *
 * Echoes answer "what can a run contain?". The career answers a different
 * question - "am I getting anywhere?" - and it has to answer it after *every* run,
 * including the short, bad ones. Echoes alone could not do that: a run that dies
 * in the second room buys nothing, and the unlock tree runs out of nodes.
 *
 * So every run pays experience, and experience fills two bars at once:
 *
 *  - Rank, shared by the whole profile. Each rank pays something on a fixed track:
 *    echoes, relics, a title, or a finish for the ball. The track is authored for
 *    the first thirty ranks and pays echoes forever after, so the bar never stops
 *    meaning something.
 *  - Mastery, per ball class. Five tiers, paid in echoes, a relic and titles, with
 *    the Gilded finish for the first class taken all the way. It gives every class
 *    a reason to be played for longer than it takes to unlock the next one.
 *
 * Nothing on either track is power. Echoes and relics feed the unlock tree, which
 * already has its own ceiling; titles and finishes are cosmetic. That is the same
 * rule the tree follows: progression widens and decorates, it never flattens.
 */

export interface Finish {
  id: string;
  name: string;
  /** Body colour; replaces the ball class colour when worn. */
  color: string;
  /** Rim, glow and trail colour. */
  accent: string;
}

/**
 * Ball finishes. `class` is the absence of a finish: the ball wears its own
 * colours. Every other finish is earned on a track below.
 */
export const FINISHES: Finish[] = [
  { id: 'class', name: 'Class colours', color: '', accent: '' },
  { id: 'ember', name: 'Ember', color: '#ffb27a', accent: '#ff6a3a' },
  { id: 'glacier', name: 'Glacier', color: '#dff6ff', accent: '#6fd8ff' },
  { id: 'verdigris', name: 'Verdigris', color: '#b8f0d2', accent: '#3fd49a' },
  { id: 'dusk', name: 'Dusk', color: '#e2c8ff', accent: '#9a6aff' },
  { id: 'signal', name: 'Signal', color: '#fff4b0', accent: '#ffd23a' },
  { id: 'voidglass', name: 'Voidglass', color: '#5a4a8a', accent: '#ff5ad2' },
  { id: 'prism', name: 'Prism', color: '#ffffff', accent: '#7affe4' },
  { id: 'gilded', name: 'Gilded', color: '#ffe6a0', accent: '#f0a82a' },
];

export const FINISH_BY_ID: Record<string, Finish> = Object.fromEntries(FINISHES.map((f) => [f.id, f]));

export interface CareerReward {
  echoes?: number;
  relics?: number;
  title?: string;
  finish?: string;
}

/**
 * What reaching each rank pays. Index 0 is rank 2 (rank 1 is where everyone
 * starts). Front-loaded with small, frequent payouts so the first few runs each
 * visibly move something; the cosmetics are spaced out so there is always one
 * within reach.
 */
const RANK_TRACK: CareerReward[] = [
  { echoes: 5 }, // 2
  { title: 'Drifter' }, // 3
  { echoes: 6, finish: 'ember' }, // 4
  { relics: 1 }, // 5
  { echoes: 8, title: 'Ricochet' }, // 6
  { finish: 'glacier' }, // 7
  { echoes: 10 }, // 8
  { relics: 1, title: 'Rebounder' }, // 9
  { echoes: 12, finish: 'verdigris' }, // 10
  { echoes: 12 }, // 11
  { relics: 1, title: 'Wallrunner' }, // 12
  { echoes: 14, finish: 'dusk' }, // 13
  { echoes: 14 }, // 14
  { relics: 2, title: 'Momentum' }, // 15
  { echoes: 16 }, // 16
  { finish: 'signal', echoes: 10 }, // 17
  { echoes: 16, title: 'Perfect Pitch' }, // 18
  { relics: 2 }, // 19
  { echoes: 20, title: 'Descender' }, // 20
  { echoes: 18 }, // 21
  { finish: 'voidglass', echoes: 10 }, // 22
  { relics: 2 }, // 23
  { echoes: 20, title: 'Unbroken' }, // 24
  { echoes: 22 }, // 25
  { relics: 2, title: 'Gravity Well' }, // 26
  { echoes: 22 }, // 27
  { finish: 'prism', echoes: 12 }, // 28
  { relics: 3 }, // 29
  { echoes: 40, title: 'Bound Breaker' }, // 30
];

/** The track's last authored rank. Beyond it, every rank pays echoes. */
export const RANK_TRACK_END = RANK_TRACK.length + 1;

export function rankReward(rank: number): CareerReward {
  if (rank <= 1) return {};
  const authored = RANK_TRACK[rank - 2];
  if (authored) return authored;
  // Past the track: echoes every rank and a relic every fifth, so the bar keeps
  // paying without inventing cosmetics nobody asked for.
  return rank % 5 === 0 ? { echoes: 20, relics: 1 } : { echoes: 20 };
}

/** Experience needed to go from `rank` to `rank + 1`. */
export function xpToNextRank(rank: number): number {
  const r = Math.max(1, rank);
  // Linear for the authored track, then flat: a rank should take a steady handful
  // of runs forever, not an ever-growing grind.
  return Math.min(120 + (r - 1) * 28, 120 + (RANK_TRACK_END - 1) * 28);
}

/** Where a finish comes from, for the locked swatches on the career screen. */
export function finishSource(id: string): string {
  if (id === 'gilded') return 'Master any ball';
  for (let rank = 2; rank <= RANK_TRACK_END; rank++) {
    if (rankReward(rank).finish === id) return `Rank ${rank}`;
  }
  return '';
}

/** The titles that exist, in the order they are earned. */
export function allTitles(): string[] {
  return RANK_TRACK.map((r) => r.title).filter((t): t is string => !!t);
}

/* ---------------------------------------------------------------- mastery -- */

/** Cumulative mastery experience at which each tier is reached. */
export const MASTERY_TIERS = [150, 400, 900, 1600, 2600];

export const MASTERY_NAMES = ['Novice', 'Familiar', 'Practised', 'Adept', 'Expert', 'Master'];

export function masteryTier(xp: number): number {
  let tier = 0;
  for (const threshold of MASTERY_TIERS) if (xp >= threshold) tier++;
  return tier;
}

/** Progress toward the next tier, 0..1; 1 when mastered. */
export function masteryProgress(xp: number): { tier: number; into: number; span: number; fraction: number } {
  const tier = masteryTier(xp);
  if (tier >= MASTERY_TIERS.length) return { tier, into: 0, span: 0, fraction: 1 };
  const floor = tier === 0 ? 0 : MASTERY_TIERS[tier - 1];
  const span = MASTERY_TIERS[tier] - floor;
  const into = xp - floor;
  return { tier, into, span, fraction: into / span };
}

/** What reaching a mastery tier pays. `ballName` personalises the titles. */
export function masteryReward(tier: number, ballName: string): CareerReward {
  switch (tier) {
    case 1:
      return { echoes: 8 };
    case 2:
      return { relics: 1 };
    case 3:
      return { echoes: 16 };
    case 4:
      return { title: `${ballName} Adept` };
    case 5:
      return { echoes: 30, title: `${ballName} Master`, finish: 'gilded' };
    default:
      return {};
  }
}

/* ------------------------------------------------------------ run payout -- */

export interface RunSummary {
  ballId: string;
  victory: boolean;
  boundLevel: number;
  roomsCleared: number;
  enemiesKilled: number;
  elitesKilled: number;
  bossesKilled: number;
  perfectBounces: number;
  bestCombo: number;
  propsDestroyed: number;
  shardsEarned: number;
  /** 1-based depth reached. */
  depth: number;
  synergies: number;
}

/**
 * Experience for one run, itemised. Scaled toward rooms and bosses, which every
 * run produces in proportion to how well it went, with a small share for the
 * mastery verbs (perfect bounces, combo) so skilful play is felt here too.
 */
export function runExperience(summary: RunSummary): Array<{ label: string; amount: number }> {
  const bound = 1 + summary.boundLevel * 0.1;
  const lines = [
    { label: 'Rooms', amount: summary.roomsCleared * 8 },
    { label: 'Elites', amount: summary.elitesKilled * 15 },
    { label: 'Bosses', amount: summary.bossesKilled * 50 },
    { label: 'Perfect bounces', amount: Math.min(60, summary.perfectBounces) },
    { label: 'Combo', amount: Math.min(45, Math.floor(summary.bestCombo / 5) * 3) },
    { label: 'Victory', amount: summary.victory ? 150 : 0 },
  ];
  return lines
    .map((line) => ({ label: line.label, amount: Math.round(line.amount * bound) }))
    .filter((line) => line.amount > 0);
}

/** Short human-readable form of a reward, for tracks and summaries. */
export function describeReward(reward: CareerReward): string {
  const parts: string[] = [];
  if (reward.echoes) parts.push(`${reward.echoes} echoes`);
  if (reward.relics) parts.push(`${reward.relics} relic${reward.relics > 1 ? 's' : ''}`);
  if (reward.title) parts.push(`title "${reward.title}"`);
  if (reward.finish) parts.push(`${FINISH_BY_ID[reward.finish]?.name ?? reward.finish} finish`);
  return parts.join(', ');
}
