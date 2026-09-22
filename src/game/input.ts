/**
 * Input.
 *
 * The control scheme is deliberately tiny, because the difficulty is supposed to
 * come from physics rather than from remembering bindings:
 *
 *   Move / steer     A D  or  arrows  or  left stick     (hold down to dive)
 *   Bounce           Space or J or gamepad A             (timing input)
 *   Brake            Shift or K or gamepad LB
 *   Dash             Mouse right, L or gamepad RB        (once unlocked)
 *   Aim              Mouse position or right stick
 *
 * The bounce button is one verb with two meanings resolved by context (see
 * `ballCollision`): near a surface it arms the Perfect Bounce window, far from one
 * it spends an air-bounce charge. That is the single most important decision in
 * this file - a separate jump button would double the things a new player has to
 * hold in their head for no gain.
 *
 * Analog input from a gamepad is passed through with a deadzone and a mild
 * response curve; keyboard input is smoothed toward its target so that tapping a
 * key does not produce an instantaneous velocity change, which would make the
 * keyboard feel different from the stick.
 */

import { clamp, damp } from '../core/math';
import { createInput, type InputState } from '../sim/ball';
import type { Settings } from '../meta/settings';

export type ActionName = 'bounce' | 'brake' | 'dash' | 'pause' | 'build' | 'map' | 'debug' | 'restart' | 'confirm';

const KEY_BINDINGS: Record<string, ActionName> = {
  Space: 'bounce',
  KeyJ: 'bounce',
  ShiftLeft: 'brake',
  ShiftRight: 'brake',
  KeyK: 'brake',
  KeyL: 'dash',
  Escape: 'pause',
  Tab: 'build',
  KeyM: 'map',
  Backquote: 'debug',
  KeyR: 'restart',
  Enter: 'confirm',
};

const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const UP_KEYS = new Set(['KeyW', 'ArrowUp']);
const DOWN_KEYS = new Set(['KeyS', 'ArrowDown']);

export interface InputTargets {
  canvas: HTMLCanvasElement;
  /** Converts a client point to world space. */
  toWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** Ball position, used to derive the aim vector. */
  ballPosition: () => { x: number; y: number };
  /** Called on the first interaction, to start audio. */
  onFirstInteraction: () => void;
  /** Called when an action is pressed, for UI and menu navigation. */
  onAction: (action: ActionName) => void;
}

export class InputManager {
  readonly state: InputState = createInput();
  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private settings: Settings;
  private targets: InputTargets;
  private mouseX = 0;
  private mouseY = 0;
  private mouseInside = false;
  private smoothedX = 0;
  private smoothedY = 0;
  private bounceWasHeld = false;
  private dashWasHeld = false;
  private interacted = false;
  private gamepadIndex: number | null = null;
  private disposers: Array<() => void> = [];
  /** Exposed so the UI can show the right prompts. */
  usingGamepad = false;

  constructor(settings: Settings, targets: InputTargets) {
    this.settings = settings;
    this.targets = targets;
    this.attach();
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  private attach(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Tab and Space would otherwise scroll or move focus, both of which break
      // the game mid-bounce.
      if (event.code === 'Tab' || event.code === 'Space') event.preventDefault();
      if (event.repeat) return;
      this.firstInteraction();
      this.held.add(event.code);
      this.pressedThisFrame.add(event.code);
      this.usingGamepad = false;
      const action = KEY_BINDINGS[event.code];
      if (action) this.targets.onAction(this.remap(action));
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      this.held.delete(event.code);
    };
    const onBlur = (): void => {
      this.held.clear();
    };
    const onMouseMove = (event: MouseEvent): void => {
      this.mouseX = event.clientX;
      this.mouseY = event.clientY;
      this.mouseInside = true;
      this.usingGamepad = false;
    };
    const onMouseDown = (event: MouseEvent): void => {
      this.firstInteraction();
      if (event.button === 2) {
        this.held.add('MouseRight');
        this.pressedThisFrame.add('MouseRight');
        this.targets.onAction(this.remap('dash'));
      } else if (event.button === 0) {
        this.held.add('MouseLeft');
        this.pressedThisFrame.add('MouseLeft');
      }
    };
    const onMouseUp = (event: MouseEvent): void => {
      this.held.delete(event.button === 2 ? 'MouseRight' : 'MouseLeft');
    };
    const onContextMenu = (event: Event): void => event.preventDefault();
    const onLeave = (): void => {
      this.mouseInside = false;
    };
    const onGamepadConnected = (event: GamepadEvent): void => {
      this.gamepadIndex = event.gamepad.index;
    };
    const onGamepadDisconnected = (): void => {
      this.gamepadIndex = null;
    };

    // Touch: a simple two-zone scheme so the game is at least playable on a
    // tablet. Left half steers, right half bounces.
    const onTouch = (event: TouchEvent): void => {
      this.firstInteraction();
      event.preventDefault();
      this.held.delete('TouchLeft');
      this.held.delete('TouchRight');
      this.held.delete('TouchBounce');
      for (const touch of Array.from(event.touches)) {
        const rect = this.targets.canvas.getBoundingClientRect();
        const relX = (touch.clientX - rect.left) / rect.width;
        if (relX > 0.55) {
          if (!this.held.has('TouchBounce')) this.pressedThisFrame.add('TouchBounce');
          this.held.add('TouchBounce');
        } else if (relX < 0.22) {
          this.held.add('TouchLeft');
        } else {
          this.held.add('TouchRight');
        }
      }
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length === 0) {
        this.held.delete('TouchLeft');
        this.held.delete('TouchRight');
        this.held.delete('TouchBounce');
      }
    };

    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    globalThis.addEventListener('blur', onBlur);
    globalThis.addEventListener('mousemove', onMouseMove);
    globalThis.addEventListener('mouseup', onMouseUp);
    globalThis.addEventListener('gamepadconnected', onGamepadConnected as EventListener);
    globalThis.addEventListener('gamepaddisconnected', onGamepadDisconnected as EventListener);
    this.targets.canvas.addEventListener('mousedown', onMouseDown);
    this.targets.canvas.addEventListener('contextmenu', onContextMenu);
    this.targets.canvas.addEventListener('mouseleave', onLeave);
    this.targets.canvas.addEventListener('touchstart', onTouch, { passive: false });
    this.targets.canvas.addEventListener('touchmove', onTouch, { passive: false });
    this.targets.canvas.addEventListener('touchend', onTouchEnd);

    this.disposers = [
      () => globalThis.removeEventListener('keydown', onKeyDown),
      () => globalThis.removeEventListener('keyup', onKeyUp),
      () => globalThis.removeEventListener('blur', onBlur),
      () => globalThis.removeEventListener('mousemove', onMouseMove),
      () => globalThis.removeEventListener('mouseup', onMouseUp),
      () => globalThis.removeEventListener('gamepadconnected', onGamepadConnected as EventListener),
      () => globalThis.removeEventListener('gamepaddisconnected', onGamepadDisconnected as EventListener),
      () => this.targets.canvas.removeEventListener('mousedown', onMouseDown),
      () => this.targets.canvas.removeEventListener('contextmenu', onContextMenu),
      () => this.targets.canvas.removeEventListener('mouseleave', onLeave),
      () => this.targets.canvas.removeEventListener('touchstart', onTouch),
      () => this.targets.canvas.removeEventListener('touchmove', onTouch),
      () => this.targets.canvas.removeEventListener('touchend', onTouchEnd),
    ];
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  private firstInteraction(): void {
    if (this.interacted) return;
    this.interacted = true;
    this.targets.onFirstInteraction();
  }

  /** Applies the left-handed swap setting. */
  private remap(action: ActionName): ActionName {
    if (!this.settings.swapBrakeDash) return action;
    if (action === 'brake') return 'dash';
    if (action === 'dash') return 'brake';
    return action;
  }

  /** Builds the simulation input for this frame. */
  sample(dt: number): InputState {
    const state = this.state;
    const pad = this.pollGamepad();

    let targetX = 0;
    let targetY = 0;
    for (const key of this.held) {
      if (LEFT_KEYS.has(key) || key === 'TouchLeft') targetX -= 1;
      if (RIGHT_KEYS.has(key) || key === 'TouchRight') targetX += 1;
      if (UP_KEYS.has(key)) targetY -= 1;
      if (DOWN_KEYS.has(key)) targetY += 1;
    }
    targetX = clamp(targetX, -1, 1);
    targetY = clamp(targetY, -1, 1);

    if (pad) {
      // The stick takes priority when it is actually being pushed, so a player can
      // switch devices mid-run without a dead frame.
      if (Math.abs(pad.moveX) > 0.12 || Math.abs(pad.moveY) > 0.12) {
        targetX = pad.moveX;
        targetY = pad.moveY;
        this.usingGamepad = true;
      }
    }

    // Smoothing: keyboard is binary, and feeding a binary axis straight into an
    // acceleration makes the ball feel twitchy compared to a stick.
    this.smoothedX = damp(this.smoothedX, targetX, 26, dt);
    this.smoothedY = damp(this.smoothedY, targetY, 26, dt);
    state.moveX = Math.abs(this.smoothedX) < 0.02 ? 0 : this.smoothedX;
    state.moveY = Math.abs(this.smoothedY) < 0.02 ? 0 : this.smoothedY;

    const bounceHeld =
      this.held.has('Space') ||
      this.held.has('KeyJ') ||
      this.held.has('TouchBounce') ||
      this.held.has('MouseLeft') ||
      (pad?.bounce ?? false);
    // `holdToArm` lets a player hold the button and have it re-arm automatically,
    // which makes the timing mechanic reachable for players who cannot tap
    // precisely. It is strictly an accessibility aid: the window is unchanged.
    state.bouncePressed = this.settings.holdToArm ? bounceHeld && !this.bounceWasHeld : bounceHeld && !this.bounceWasHeld;
    if (this.settings.holdToArm && bounceHeld) state.bouncePressed = true;
    state.bounceHeld = bounceHeld;
    this.bounceWasHeld = bounceHeld;

    const brakeAction = this.settings.swapBrakeDash ? 'dash' : 'brake';
    const dashAction = this.settings.swapBrakeDash ? 'brake' : 'dash';
    state.brakeHeld = this.isActionHeld(brakeAction, pad);
    const dashHeld = this.isActionHeld(dashAction, pad);
    state.dashPressed = dashHeld && !this.dashWasHeld;
    this.dashWasHeld = dashHeld;

    // Aim: mouse when present, right stick otherwise, movement direction as a
    // fallback so the dash always has a sensible direction.
    const ball = this.targets.ballPosition();
    if (pad && (Math.abs(pad.aimX) > 0.2 || Math.abs(pad.aimY) > 0.2)) {
      const len = Math.hypot(pad.aimX, pad.aimY) || 1;
      state.aimX = pad.aimX / len;
      state.aimY = pad.aimY / len;
      state.aiming = true;
    } else if (this.mouseInside) {
      const world = this.targets.toWorld(this.mouseX, this.mouseY);
      const dx = world.x - ball.x;
      const dy = world.y - ball.y;
      const len = Math.hypot(dx, dy) || 1;
      state.aimX = dx / len;
      state.aimY = dy / len;
      state.aiming = len > 12;
    } else {
      state.aiming = false;
    }

    this.pressedThisFrame.clear();
    return state;
  }

  private isActionHeld(action: ActionName, pad: GamepadSample | null): boolean {
    switch (action) {
      case 'brake':
        return this.held.has('ShiftLeft') || this.held.has('ShiftRight') || this.held.has('KeyK') || (pad?.brake ?? false);
      case 'dash':
        return this.held.has('MouseRight') || this.held.has('KeyL') || (pad?.dash ?? false);
      default:
        return false;
    }
  }

  private pollGamepad(): GamepadSample | null {
    const getGamepads = (navigator as Navigator & { getGamepads?: () => Array<Gamepad | null> }).getGamepads;
    if (!getGamepads) return null;
    const pads = getGamepads.call(navigator);
    const pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : pads.find((p) => p !== null) ?? null;
    if (!pad) return null;
    this.gamepadIndex = pad.index;

    const deadzone = 0.18;
    const curve = (value: number): number => {
      const magnitude = Math.abs(value);
      if (magnitude < deadzone) return 0;
      const scaled = (magnitude - deadzone) / (1 - deadzone);
      // Mild expo curve for fine control near centre.
      return Math.sign(value) * scaled ** 1.35 * this.settings.aimSensitivity;
    };

    const sample: GamepadSample = {
      moveX: curve(pad.axes[0] ?? 0),
      moveY: curve(pad.axes[1] ?? 0),
      aimX: curve(pad.axes[2] ?? 0),
      aimY: curve(pad.axes[3] ?? 0),
      bounce: (pad.buttons[0]?.pressed ?? false) || (pad.buttons[7]?.pressed ?? false),
      brake: pad.buttons[4]?.pressed ?? false,
      dash: (pad.buttons[5]?.pressed ?? false) || (pad.buttons[2]?.pressed ?? false),
      pause: pad.buttons[9]?.pressed ?? false,
      build: pad.buttons[8]?.pressed ?? false,
    };
    if (sample.bounce || sample.brake || sample.dash) this.usingGamepad = true;
    return sample;
  }

  /** Rumble, used sparingly and only when enabled. */
  vibrate(intensity: number, durationMs = 90): void {
    if (!this.settings.vibration || this.gamepadIndex === null) return;
    const getGamepads = (navigator as Navigator & { getGamepads?: () => Array<Gamepad | null> }).getGamepads;
    if (!getGamepads) return;
    const pad = getGamepads.call(navigator)[this.gamepadIndex];
    const actuator = (pad as unknown as { vibrationActuator?: { playEffect: (type: string, options: unknown) => Promise<unknown> } })
      ?.vibrationActuator;
    if (!actuator) return;
    void actuator
      .playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: clamp(intensity, 0, 1),
        weakMagnitude: clamp(intensity * 0.6, 0, 1),
      })
      .catch(() => undefined);
  }
}

interface GamepadSample {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  bounce: boolean;
  brake: boolean;
  dash: boolean;
  pause: boolean;
  build: boolean;
}
