/**
 * Fixed-timestep clock with hit-stop and time-scaling.
 *
 * The ball routinely travels 900+ units/second, so the simulation runs at a
 * fixed 240 Hz regardless of display refresh rate. That keeps tunnelling
 * impossible at normal speeds, makes bounces reproducible from a seed, and
 * decouples game feel from the player's monitor.
 *
 * Two time distortions sit on top:
 *  - `timeScale` is gameplay-driven slow motion (Chrono effects, boss phases).
 *  - `hitStop` freezes the simulation for a few frames on heavy impacts. This is
 *    the single highest-leverage game-feel trick available: it makes a collision
 *    read as an event rather than a velocity change.
 */

export const FIXED_DT = 1 / 240;
const MAX_STEPS_PER_FRAME = 12;
/** Ignore absurd frame deltas (tab restore, breakpoint) instead of catching up. */
const MAX_FRAME_DELTA = 0.25;

export class Clock {
  /** Real seconds since start, unaffected by scaling. Drives UI animation. */
  realTime = 0;
  /** Simulated seconds, affected by timeScale and hit-stop. Drives gameplay. */
  simTime = 0;
  /** Gameplay slow motion multiplier. */
  timeScale = 1;
  /** Additional multiplier used by menus/pause transitions. */
  uiScale = 1;
  /** Remaining hit-stop in real seconds. */
  hitStop = 0;
  /** Number of fixed steps executed on the most recent frame. */
  stepsLastFrame = 0;
  /** Interpolation alpha in [0,1) for smooth rendering between sim steps. */
  alpha = 0;

  private accumulator = 0;
  private lastTimestampMs: number | null = null;

  /**
   * Feeds a real timestamp (ms) and invokes `step` for each fixed simulation
   * tick that should run. `step` receives the already-scaled delta.
   */
  advance(timestampMs: number, step: (dt: number) => void): void {
    let frameDelta: number;
    if (this.lastTimestampMs === null) {
      frameDelta = FIXED_DT;
    } else {
      frameDelta = (timestampMs - this.lastTimestampMs) / 1000;
    }
    this.lastTimestampMs = timestampMs;
    if (!Number.isFinite(frameDelta) || frameDelta < 0) frameDelta = FIXED_DT;
    if (frameDelta > MAX_FRAME_DELTA) frameDelta = MAX_FRAME_DELTA;

    this.realTime += frameDelta;

    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - frameDelta);
      this.stepsLastFrame = 0;
      // Do not accumulate during hit-stop: the pause is meant to be felt, not
      // repaid later as a speed-up.
      return;
    }

    const scaled = frameDelta * this.timeScale * this.uiScale;
    this.accumulator += scaled;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      step(FIXED_DT);
      steps++;
    }
    if (steps >= MAX_STEPS_PER_FRAME) {
      // Long stall: drop the backlog rather than fast-forwarding through hazards.
      this.accumulator = 0;
    }
    this.stepsLastFrame = steps;
    this.alpha = this.accumulator / FIXED_DT;
  }

  /** Requests hit-stop, keeping the longest pending request. */
  requestHitStop(seconds: number): void {
    if (seconds > this.hitStop) this.hitStop = seconds;
  }

  /** Called when resuming from a pause so no catch-up burst occurs. */
  resync(): void {
    this.lastTimestampMs = null;
    this.accumulator = 0;
  }

  reset(): void {
    this.accumulator = 0;
    this.lastTimestampMs = null;
    this.hitStop = 0;
    this.timeScale = 1;
    this.uiScale = 1;
    this.simTime = 0;
  }
}

/**
 * Countdown timer helper used pervasively by cooldowns and status effects.
 * Returns true on the tick the timer reaches zero.
 */
export function tickDown(value: number, dt: number): number {
  return value > 0 ? Math.max(0, value - dt) : 0;
}
