/**
 * Small painting helpers shared by the renderer, HUD and menu backdrop.
 *
 * Two things live here. Colour arithmetic, because shading a flat body colour into
 * a lit, three-dimensional-looking object needs a lighter and a darker version of
 * it every frame. And a glow sprite cache, because a pre-rendered radial gradient
 * drawn with `lighter` compositing is the cheap way to get bloom on Canvas 2D -
 * `shadowBlur` per particle would cost more than the rest of the frame combined.
 */

import { clamp01 } from '../core/math';

/** The display face for numbers and headings; falls back to the interface face. */
export const DISPLAY_FONT = '"Russo One", "Chakra Petch", system-ui, sans-serif';
/** The interface face for labels and small text. */
export const UI_FONT = '"Chakra Petch", system-ui, -apple-system, "Segoe UI", sans-serif';

type Rgb = [number, number, number];

const rgbCache = new Map<string, Rgb>();

function parseHex(color: string): Rgb | null {
  const cached = rgbCache.get(color);
  if (cached) return cached;
  let hex = color.trim();
  if (!hex.startsWith('#')) return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const value = Number.parseInt(hex.slice(0, 6), 16);
  if (Number.isNaN(value)) return null;
  const rgb: Rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  rgbCache.set(color, rgb);
  return rgb;
}

function toHex([r, g, b]: Rgb): string {
  const part = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Mixes two hex colours; `t` = 0 returns `a`. Non-hex input is returned unchanged. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = clamp01(t);
  return toHex([ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]);
}

export function lighten(color: string, amount: number): string {
  return mix(color, '#ffffff', amount);
}

export function darken(color: string, amount: number): string {
  return mix(color, '#000000', amount);
}

/** A hex colour with an alpha channel, as an rgba() string. */
export function alpha(color: string, a: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp01(a)})`;
}

/* ------------------------------------------------------------------ easing -- */

export function easeOutCubic(t: number): number {
  const k = 1 - clamp01(t);
  return 1 - k * k * k;
}

export function easeInOutCubic(t: number): number {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
}

/** Overshoots then settles: the "pop" curve for anything appearing. */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const k = clamp01(t) - 1;
  return 1 + (overshoot + 1) * k * k * k + overshoot * k * k;
}

/** Deterministic hash in [0, 1) for decorative variation that must not flicker. */
export function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* ------------------------------------------------------------- glow sprites -- */

const SPRITE_SIZE = 64;
const glowCache = new Map<string, CanvasImageSource>();

/**
 * A soft radial glow in the given colour, pre-rendered once. Draw it with
 * `globalCompositeOperation = 'lighter'` for bloom.
 */
export function glowSprite(color: string): CanvasImageSource | null {
  const cached = glowCache.get(color);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const half = SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, alpha(color, 1));
  gradient.addColorStop(0.25, alpha(color, 0.55));
  gradient.addColorStop(0.6, alpha(color, 0.14));
  gradient.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  if (glowCache.size > 96) glowCache.clear();
  glowCache.set(color, canvas);
  return canvas;
}

/** Draws a glow sprite centred on (x, y) with the given radius and opacity. */
export function drawGlow(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, radius: number, opacity: number): void {
  if (opacity <= 0.003 || radius <= 0.5) return;
  const sprite = glowSprite(color);
  if (!sprite) return;
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * clamp01(opacity);
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = previous;
}

/** Traces a four-point star, the shape of a contact flare. */
export function traceStar(ctx: CanvasRenderingContext2D, x: number, y: number, length: number, width: number, rotation: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = rotation + (i * Math.PI) / 4;
    const r = i % 2 === 0 ? length : width;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
