/**
 * Combo and momentum.
 *
 * The combo meter is an optimisation layer, not a survival requirement: nothing
 * in the base game demands a high combo, but a player who chains impacts,
 * lands perfect bounces and keeps their speed up multiplies their output
 * substantially. That split is deliberate - a new player is never blocked by a
 * mechanic they have not learned, and an expert is never capped by one.
 *
 * Scaling is intentionally sublinear and hard-capped so that no build can turn
 * the combo meter into unbounded damage.
 */

import { clamp, clamp01 } from '../core/math';
import type { ResolvedStats } from './stats';

/** Base seconds before the combo lapses. Scaled by the comboDecayRate stat. */
export const COMBO_WINDOW = 2.6;
/** Damage gained per combo point at comboDamageScale = 1. */
const DAMAGE_PER_POINT = 0.055;

export interface ComboState {
  value: number;
  timer: number;
  window: number;
  peak: number;
  /** Peak reached during the current run. */
  runPeak: number;
  /** Total combo points earned, for telemetry. */
  lifetimeGain: number;
  /** Rolling count of impacts in the last second, drives audio intensity. */
  recentImpacts: number;
  recentTimer: number;
}

export function createCombo(): ComboState {
  return {
    value: 0,
    timer: 0,
    window: COMBO_WINDOW,
    peak: 0,
    runPeak: 0,
    lifetimeGain: 0,
    recentImpacts: 0,
    recentTimer: 0,
  };
}

export function comboMultiplier(state: ComboState, stats: ResolvedStats): number {
  const effective = Math.min(state.value, stats.comboCap);
  return 1 + stats.comboDamageScale * DAMAGE_PER_POINT * effective;
}

/**
 * Momentum bonus from raw speed, separate from the combo counter.
 *
 * Reported as a multiplier in the 1.0-1.5 range. It exists so that "go faster"
 * is always a live option even when the combo meter is empty, and so that
 * Momentum builds have something to scale that is purely physical.
 */
export function momentumMultiplier(speed: number, stats: ResolvedStats): number {
  const t = clamp01((speed - 450) / Math.max(200, stats.maxSpeed - 450));
  return 1 + t * 0.5;
}

export function addCombo(state: ComboState, amount: number, stats: ResolvedStats): number {
  if (amount <= 0) return 0;
  const before = state.value;
  state.value = Math.min(stats.comboCap, state.value + amount);
  state.window = COMBO_WINDOW / clamp(stats.comboDecayRate, 0.1, 4);
  state.timer = state.window;
  state.peak = Math.max(state.peak, state.value);
  state.runPeak = Math.max(state.runPeak, state.value);
  const delta = state.value - before;
  state.lifetimeGain += delta;
  return delta;
}

/** Returns the peak value when the combo lapses this tick, otherwise -1. */
export function tickCombo(state: ComboState, dt: number): number {
  state.recentTimer -= dt;
  if (state.recentTimer <= 0) {
    state.recentTimer = 1;
    state.recentImpacts = 0;
  }
  if (state.value <= 0) return -1;
  state.timer -= dt;
  if (state.timer > 0) return -1;
  const peak = state.value;
  state.value = 0;
  state.timer = 0;
  state.peak = 0;
  return peak;
}

export function resetCombo(state: ComboState): void {
  state.value = 0;
  state.timer = 0;
  state.peak = 0;
}

/** 0..1 fill used by the HUD gauge. */
export function comboFill(state: ComboState): number {
  return state.window > 0 ? clamp01(state.timer / state.window) : 0;
}

/**
 * Tier thresholds drive escalating feedback: the audio layer raises pitch and
 * adds harmonics per tier, and the HUD changes colour. Feeling the tier change
 * is what makes the meter worth chasing.
 */
export function comboTier(value: number): number {
  if (value >= 32) return 5;
  if (value >= 22) return 4;
  if (value >= 14) return 3;
  if (value >= 8) return 2;
  if (value >= 4) return 1;
  return 0;
}

export const COMBO_TIER_NAMES = ['', 'Linked', 'Chained', 'Resonant', 'Violent', 'Unbound'] as const;
