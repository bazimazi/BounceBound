/**
 * Settings, including accessibility.
 *
 * The rule the brief sets is the right one: the game should be hard because of
 * the gameplay, never because of the presentation or the controls. So everything
 * that could obstruct a player is adjustable, and every option defaults to the
 * setting that is *most readable* rather than the most spectacular.
 *
 * Two options are worth calling out as genuine accessibility features rather than
 * difficulty toggles:
 *  - `trajectoryPreview` draws the ball's predicted path. It removes guesswork for
 *    players who cannot track a fast object, and costs nothing competitively.
 *  - `impactTiming` draws the shrinking ring that teaches the Perfect Bounce
 *    window. Turning it off is a challenge option; it is on by default because the
 *    mechanic is unteachable without it.
 */

export type ColorMode = 'default' | 'protan' | 'deutan' | 'tritan' | 'highContrast';
export type TrajectoryMode = 'off' | 'reticle' | 'full';

export interface Settings {
  /* audio */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;

  /* game feel */
  screenShake: number;
  hitStop: number;
  particleDensity: number;
  /** Suppresses full-screen flashes and rapid strobing. */
  reducedFlashing: boolean;
  /** Suppresses camera motion, parallax and zoom pulses. */
  reducedMotion: boolean;

  /* readability */
  trajectory: TrajectoryMode;
  impactTiming: boolean;
  /** Draws a high-contrast outline around hazards and dangerous enemy arcs. */
  dangerOutlines: boolean;
  colorMode: ColorMode;
  uiScale: number;
  /** Shows numeric damage above targets. */
  damageNumbers: boolean;

  /* controls */
  /** Mouse aim sensitivity for the dash reticle. */
  aimSensitivity: number;
  /** 0 = no assistance, 1 = strong pull toward the nearest enemy when dashing. */
  aimAssist: number;
  vibration: boolean;
  /** Swaps brake and dash bindings for left-handed layouts. */
  swapBrakeDash: boolean;
  /** Holds the bounce input instead of requiring a tap for the perfect window. */
  holdToArm: boolean;

  /* misc */
  showFps: boolean;
  showSeed: boolean;
  /** Pauses when the window loses focus. */
  pauseOnBlur: boolean;
}

export function defaultSettings(): Settings {
  return {
    masterVolume: 0.75,
    musicVolume: 0.45,
    sfxVolume: 0.8,

    screenShake: 0.8,
    hitStop: 1,
    particleDensity: 1,
    reducedFlashing: false,
    reducedMotion: false,

    trajectory: 'reticle',
    impactTiming: true,
    dangerOutlines: true,
    colorMode: 'default',
    uiScale: 1,
    damageNumbers: true,

    aimSensitivity: 1,
    aimAssist: 0.25,
    vibration: true,
    swapBrakeDash: false,
    holdToArm: false,

    showFps: false,
    showSeed: true,
    pauseOnBlur: true,
  };
}

/** Merges stored settings over defaults so new options appear without a migration. */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const base = defaultSettings();
  if (!stored) return base;
  const out = { ...base };
  for (const key of Object.keys(base) as Array<keyof Settings>) {
    const value = stored[key];
    if (value === undefined || value === null) continue;
    if (typeof base[key] === typeof value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = value;
    }
  }
  return out;
}

/**
 * Colour-blind remapping.
 *
 * Rather than filtering the whole frame, gameplay-critical colours are looked up
 * through this function so that "dangerous" and "safe" stay distinguishable in
 * every mode. Hazards also get a shape cue (outlines) so colour is never the only
 * channel carrying the information.
 */
export interface SemanticPalette {
  danger: string;
  safe: string;
  neutral: string;
  reward: string;
  perfect: string;
  crit: string;
  shield: string;
  combo: string;
}

const PALETTES: Record<ColorMode, SemanticPalette> = {
  default: {
    danger: '#ff4d6a',
    safe: '#5ce8a0',
    neutral: '#8fa6c9',
    reward: '#ffd15c',
    perfect: '#7fe8ff',
    crit: '#ffe066',
    shield: '#6ab0ff',
    combo: '#ff9ae0',
  },
  protan: {
    danger: '#ffb000',
    safe: '#00b7e0',
    neutral: '#9aa8c0',
    reward: '#ffe066',
    perfect: '#7fe8ff',
    crit: '#ffffff',
    shield: '#4fa8ff',
    combo: '#c79aff',
  },
  deutan: {
    danger: '#ff8a00',
    safe: '#3fc7ff',
    neutral: '#9aa8c0',
    reward: '#fff066',
    perfect: '#9ae8ff',
    crit: '#ffffff',
    shield: '#5f9fff',
    combo: '#cf9aff',
  },
  tritan: {
    danger: '#ff4d6a',
    safe: '#00c88a',
    neutral: '#a0a8b8',
    reward: '#ff9f40',
    perfect: '#40d0d0',
    crit: '#ffd0d0',
    shield: '#40a0c0',
    combo: '#ff7ab0',
  },
  highContrast: {
    danger: '#ff0040',
    safe: '#00ff88',
    neutral: '#ffffff',
    reward: '#ffcc00',
    perfect: '#00ffff',
    crit: '#ffffff',
    shield: '#0088ff',
    combo: '#ff00cc',
  },
};

export function paletteFor(mode: ColorMode): SemanticPalette {
  return PALETTES[mode] ?? PALETTES.default;
}
