/**
 * On-screen touch controls.
 *
 * The first touch scheme split the canvas into three invisible strips: far left
 * steered left, the middle steered right, the right half bounced. It technically
 * worked and was unplayable - there was no analogue steering, no dive, no brake or
 * dash, no way to pause, and nothing on screen said where the strips were.
 *
 * This is the conventional twin-thumb layout instead:
 *
 *  - A floating stick on one side. It appears wherever the thumb lands, so there is
 *    no dead zone to find by feel, and it drifts with a thumb that overshoots. Push
 *    sideways to steer; pull down to dive. Vertical needs a firmer push than
 *    horizontal, so steering hard never dives by accident.
 *  - Buttons on the other side. The whole half is the Bounce button except for the
 *    smaller Brake and Dash buttons, because Bounce is the timing input and a
 *    timing input must never miss because a thumb was a few pixels off.
 *  - Pause and build buttons in the top corner, out of the thumbs' way.
 *
 * Presses are latched: a tap that begins and ends between two frames still
 * registers, which matters because a perfect bounce is exactly that kind of tap.
 */

import { clamp } from '../core/math';
import type { Settings } from '../meta/settings';
import type { ScreenLayout } from './layout';

export type TouchRole = 'stick' | 'bounce' | 'brake' | 'dash' | 'pause' | 'build';

interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface TouchGeometry {
  stickHome: Circle;
  bounce: Circle;
  brake: Circle;
  dash: Circle;
  pause: Circle;
  build: Circle;
  /** Touches starting on this side of the screen steer. */
  steerLeft: boolean;
  /** Screen x dividing the stick half from the button half. */
  split: number;
  width: number;
  height: number;
}

interface TrackedTouch {
  role: TouchRole;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

export interface TouchDrawInfo {
  /** Whether the dash button should be shown at all. */
  dashAvailable: boolean;
  /** Dash charges ready now. */
  dashReady: boolean;
  time: number;
  reducedMotion: boolean;
  accent: string;
}

/** Width, in CSS pixels, the HUD should leave free in the top-right corner. */
export function touchTopReserve(layout: ScreenLayout, settings: Settings): number {
  return layout.touch ? 96 * settings.touchScale + 8 : 0;
}

export function touchGeometry(layout: ScreenLayout, settings: Settings): TouchGeometry {
  const { width: w, height: h, safe } = layout;
  const s = settings.touchScale * clamp(Math.min(w, h) / 390, 0.85, 1.3);
  const steerLeft = !settings.touchSwapSides;
  const mirror = (x: number): number => (steerLeft ? x : w - x);

  const pauseR = 20 * settings.touchScale;
  const pause = { x: w - safe.right - 12 - pauseR, y: safe.top + 12 + pauseR, r: pauseR };
  const build = { x: pause.x - pauseR * 2 - 14, y: pause.y, r: pauseR };

  const bounceR = 46 * s;
  const smallR = 29 * s;
  const stickR = 62 * s;

  let bounce: Circle;
  let stickHome: Circle;
  if (layout.portrait) {
    // The deck under the arena. Controls sit in its lower half, where a thumb
    // holding the phone naturally rests.
    const deckH = h - layout.deckTop - safe.bottom;
    const cy = layout.deckTop + deckH * 0.62;
    bounce = { x: mirror(w - safe.right - 30 - bounceR), y: cy, r: bounceR };
    stickHome = { x: mirror(safe.left + 28 + stickR), y: cy, r: stickR };
  } else {
    bounce = { x: mirror(w - safe.right - 26 - bounceR), y: h - safe.bottom - 22 - bounceR, r: bounceR };
    stickHome = { x: mirror(safe.left + 22 + stickR), y: h - safe.bottom - 20 - stickR, r: stickR };
  }
  const toward = steerLeft ? -1 : 1;
  const brake = { x: bounce.x + toward * (bounceR + smallR + 16), y: bounce.y + bounceR * 0.35, r: smallR };
  const dash = { x: bounce.x + toward * bounceR * 0.35, y: bounce.y - bounceR - smallR - 14, r: smallR };

  return { stickHome, bounce, brake, dash, pause, build, steerLeft, split: w / 2, width: w, height: h };
}

export class TouchControls {
  /** Whether the controls are showing and taking input. */
  visible = false;
  moveX = 0;
  moveY = 0;
  /** Stick direction when pushed firmly, for aiming the dash. */
  aimX = 0;
  aimY = 0;
  aiming = false;

  private readonly touches = new Map<number, TrackedTouch>();
  private readonly latched = new Set<TouchRole>();
  private geometry: TouchGeometry | null = null;
  private dashShown = false;
  private readonly onAction: (role: 'pause' | 'build') => void;

  constructor(onAction: (role: 'pause' | 'build') => void) {
    this.onAction = onAction;
  }

  setGeometry(geometry: TouchGeometry): void {
    this.geometry = geometry;
  }

  /** Called every frame with whether the dash button exists this frame. */
  setDashShown(shown: boolean): void {
    this.dashShown = shown;
  }

  isHeld(role: TouchRole): boolean {
    for (const touch of this.touches.values()) if (touch.role === role) return true;
    return false;
  }

  /** True if the role was pressed since the last call, even if already released. */
  consumePress(role: TouchRole): boolean {
    const pressed = this.latched.has(role);
    this.latched.delete(role);
    return pressed;
  }

  reset(): void {
    this.touches.clear();
    this.latched.clear();
    this.moveX = 0;
    this.moveY = 0;
    this.aiming = false;
  }

  /** Assigns a role to a new touch from where it landed. */
  private classify(x: number, y: number): TouchRole {
    const g = this.geometry;
    if (!g) return 'bounce';
    const inside = (c: Circle, slack: number): boolean => Math.hypot(x - c.x, y - c.y) <= c.r * slack;
    if (inside(g.pause, 1.35)) return 'pause';
    if (inside(g.build, 1.35)) return 'build';
    const steerSide = g.steerLeft ? x < g.split : x >= g.split;
    if (steerSide) return 'stick';
    if (inside(g.brake, 1.2)) return 'brake';
    if (this.dashShown && inside(g.dash, 1.2)) return 'dash';
    return 'bounce';
  }

  touchStart(id: number, x: number, y: number): void {
    const role = this.classify(x, y);
    const g = this.geometry;
    let originX = x;
    let originY = y;
    if (role === 'stick' && g) {
      // Keep the whole stick on screen even when the thumb lands at the edge.
      const r = g.stickHome.r;
      originX = g.steerLeft ? clamp(x, r * 0.6, g.split - r * 0.2) : clamp(x, g.split + r * 0.2, g.width - r * 0.6);
      originY = clamp(y, r * 0.6, g.height - r * 0.6);
    }
    this.touches.set(id, { role, originX, originY, x, y });
    this.latched.add(role);
    if (role === 'pause' || role === 'build') this.onAction(role);
    this.updateStick();
  }

  touchMove(id: number, x: number, y: number): void {
    const touch = this.touches.get(id);
    if (!touch) return;
    touch.x = x;
    touch.y = y;
    if (touch.role === 'stick' && this.geometry) {
      // Floating stick: a thumb that overshoots drags the base along, so steering
      // back the other way responds immediately instead of first unwinding.
      const r = this.geometry.stickHome.r;
      const dx = x - touch.originX;
      const dy = y - touch.originY;
      const d = Math.hypot(dx, dy);
      if (d > r) {
        touch.originX = x - (dx / d) * r;
        touch.originY = y - (dy / d) * r;
      }
    }
    this.updateStick();
  }

  touchEnd(id: number): void {
    this.touches.delete(id);
    this.updateStick();
  }

  private updateStick(): void {
    const stick = [...this.touches.values()].find((t) => t.role === 'stick');
    const r = this.geometry?.stickHome.r ?? 60;
    if (!stick) {
      this.moveX = 0;
      this.moveY = 0;
      this.aiming = false;
      return;
    }
    const nx = clamp((stick.x - stick.originX) / r, -1, 1);
    const ny = clamp((stick.y - stick.originY) / r, -1, 1);
    // Separate deadzones: steering is sensitive, diving and climbing need intent.
    const axis = (value: number, dead: number): number => {
      const m = Math.abs(value);
      if (m < dead) return 0;
      return Math.sign(value) * Math.min(1, (m - dead) / (1 - dead));
    };
    this.moveX = axis(nx, 0.12);
    this.moveY = axis(ny, 0.3);
    const len = Math.hypot(nx, ny);
    this.aiming = len > 0.45;
    if (this.aiming) {
      this.aimX = nx / len;
      this.aimY = ny / len;
    }
  }

  /** Draws the controls in screen space (CSS pixels). */
  draw(ctx: CanvasRenderingContext2D, settings: Settings, info: TouchDrawInfo): void {
    const g = this.geometry;
    if (!this.visible || !g) return;
    const idle = clamp(settings.touchOpacity, 0.15, 1);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // Stick: the live stick where the thumb is, or a faint home ring as a hint.
    const stick = [...this.touches.values()].find((t) => t.role === 'stick');
    const base = stick ? { x: stick.originX, y: stick.originY } : g.stickHome;
    const r = g.stickHome.r;
    ctx.globalAlpha = stick ? Math.min(1, idle + 0.35) : idle * 0.7;
    ctx.fillStyle = 'rgba(6,8,14,0.35)';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(base.x, base.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Dive notch: the lower arc is marked, so "pull down to dive" is visible.
    ctx.strokeStyle = 'rgba(255,209,92,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(base.x, base.y, r - 5, Math.PI * 0.32, Math.PI * 0.68);
    ctx.stroke();
    const knobX = stick ? clamp(stick.x, base.x - r, base.x + r) : base.x;
    const knobY = stick ? clamp(stick.y, base.y - r, base.y + r) : base.y;
    const k = Math.hypot(knobX - base.x, knobY - base.y);
    const kx = k > r ? base.x + ((knobX - base.x) / k) * r : knobX;
    const ky = k > r ? base.y + ((knobY - base.y) / k) * r : knobY;
    ctx.fillStyle = stick ? info.accent : 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(kx, ky, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,8,14,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const button = (c: Circle, label: string, held: boolean, tint: string, disabled = false): void => {
      ctx.globalAlpha = disabled ? idle * 0.45 : held ? Math.min(1, idle + 0.4) : idle;
      const scale = held && !info.reducedMotion ? 0.92 : 1;
      ctx.fillStyle = held ? tint : 'rgba(6,8,14,0.45)';
      ctx.strokeStyle = tint;
      ctx.lineWidth = held ? 3 : 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = held ? '#0b0e16' : '#ffffff';
      ctx.font = `700 ${Math.round(Math.max(10, c.r * 0.34))}px "Chakra Petch", system-ui, sans-serif`;
      ctx.fillText(label, c.x, c.y + 1);
    };

    button(g.bounce, 'BOUNCE', this.isHeld('bounce'), info.accent);
    button(g.brake, 'BRAKE', this.isHeld('brake'), '#9fb3cc');
    if (info.dashAvailable) button(g.dash, 'DASH', this.isHeld('dash'), '#a0ffc0', !info.dashReady);

    // Pause and build: small glyph buttons.
    const glyphButton = (c: Circle, draw: () => void): void => {
      ctx.globalAlpha = Math.max(idle, 0.6);
      ctx.fillStyle = 'rgba(6,8,14,0.6)';
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      draw();
    };
    glyphButton(g.pause, () => {
      const u = g.pause.r * 0.16;
      ctx.fillRect(g.pause.x - u * 2.2, g.pause.y - u * 3, u * 1.5, u * 6);
      ctx.fillRect(g.pause.x + u * 0.7, g.pause.y - u * 3, u * 1.5, u * 6);
    });
    glyphButton(g.build, () => {
      // Four diamonds: the build strip's glyph.
      const u = g.build.r * 0.2;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = g.build.x + dx * u * 1.3;
        const cy = g.build.y + dy * u * 1.3;
        ctx.beginPath();
        ctx.moveTo(cx, cy - u);
        ctx.lineTo(cx + u, cy);
        ctx.lineTo(cx, cy + u);
        ctx.lineTo(cx - u, cy);
        ctx.closePath();
        ctx.fill();
      }
    });
    ctx.restore();
  }
}
