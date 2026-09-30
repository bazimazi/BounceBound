/**
 * The in-game HUD.
 *
 * Drawn on the canvas in screen space, above the arena. The brief's instruction is
 * the design rule: during gameplay, show only what matters. So the HUD is four
 * things and nothing else -
 *
 *   integrity (with shields), because it is the only losable resource
 *   combo, only while it is actually running
 *   shards and depth, small and in a corner
 *   the current build, as icons, because it is what the player is thinking about
 *
 * Everything else lives behind a key: the full build panel, the map, the journal.
 * Anything that is not needed *between two bounces* does not belong on screen.
 *
 * Every number that changes animates, because a value that silently swaps is a
 * value the player misses. Integrity keeps a trailing "ghost" of what was just
 * lost (the fighting-game health bar), the combo number pops on each hit, shards
 * count up, and the whole bar shakes when you are hurt. The combo sits on the right
 * edge rather than bottom centre, which is where the floor - and so the ball - is
 * most of the time.
 */

import { clamp, clamp01, damp, formatNumber, lerp, TAU } from '../core/math';
import { comboFill, comboMultiplier, comboTier, COMBO_TIER_NAMES, momentumMultiplier } from '../sim/combo';
import { bossBarInfo } from '../sim/bossLogic';
import type { World } from '../sim/world';
import type { Run } from '../run/run';
import type { SemanticPalette, Settings } from '../meta/settings';
import { ARCHETYPE_LABELS } from '../gen/mapgen';
import { boundName } from '../content/modifiers';
import { alpha, darken, DISPLAY_FONT, easeOutBack, easeOutCubic, lighten, UI_FONT } from './paint';

export interface HudContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  palette: SemanticPalette;
  settings: Settings;
  run: Run;
  world: World;
  time: number;
  fps: number;
  /** Screen layout; without one the HUD assumes a desktop window. */
  layout?: HudLayout;
}

/**
 * Where the HUD may draw, in CSS pixels. Phones need all of it: the safe area
 * keeps the bars out of the notch, `arena` lets combo, banners and callouts sit on
 * the play area rather than the screen, `compact` shrinks everything for a small
 * screen, and `topRightReserve` leaves room for the touch pause and build buttons.
 */
export interface HudLayout {
  arena: { x: number; y: number; w: number; h: number };
  safe: { top: number; right: number; bottom: number; left: number };
  compact: boolean;
  touch: boolean;
  portrait: boolean;
  topRightReserve: number;
}

/** The layout in the HUD's own (interface-scaled) units. */
interface Frame {
  arena: { x: number; y: number; w: number; h: number };
  safe: { top: number; right: number; bottom: number; left: number };
  compact: boolean;
  touch: boolean;
  portrait: boolean;
  reserve: number;
}

function frameOf(hud: HudContext, width: number, height: number): Frame {
  const k = 1 / hud.settings.uiScale;
  const layout = hud.layout;
  if (!layout) {
    return {
      arena: { x: 0, y: 0, w: width, h: height },
      safe: { top: 0, right: 0, bottom: 0, left: 0 },
      compact: false,
      touch: false,
      portrait: false,
      reserve: 0,
    };
  }
  return {
    arena: { x: layout.arena.x * k, y: layout.arena.y * k, w: layout.arena.w * k, h: layout.arena.h * k },
    safe: { top: layout.safe.top * k, right: layout.safe.right * k, bottom: layout.safe.bottom * k, left: layout.safe.left * k },
    compact: layout.compact,
    touch: layout.touch,
    portrait: layout.portrait,
    reserve: layout.topRightReserve * k,
  };
}

const FONT = UI_FONT;

/** Presentation state carried between frames; the run itself knows none of it. */
interface HudState {
  lastTime: number;
  dt: number;
  lastHp: number;
  ghostHp: number;
  ghostHold: number;
  /** Seconds of damage shake remaining. */
  hurt: number;
  shardsShown: number;
  lastShards: number;
  shardPop: number;
  lastCombo: number;
  comboPop: number;
  lastTier: number;
  tierPop: number;
  bossGhost: number;
  bossLast: number;
  bossHold: number;
  bossHurt: number;
}

const states = new WeakMap<Run, HudState>();

function stateFor(hud: HudContext): HudState {
  let state = states.get(hud.run);
  const ball = hud.world.ball;
  if (!state) {
    state = {
      lastTime: hud.time,
      dt: 0,
      lastHp: ball.hp,
      ghostHp: ball.hp,
      ghostHold: 0,
      hurt: 0,
      shardsShown: hud.run.shards,
      lastShards: hud.run.shards,
      shardPop: 0,
      lastCombo: 0,
      comboPop: 0,
      lastTier: 0,
      tierPop: 0,
      bossGhost: 1,
      bossLast: 1,
      bossHold: 0,
      bossHurt: 0,
    };
    states.set(hud.run, state);
  }
  state.dt = clamp(hud.time - state.lastTime, 0, 0.1);
  state.lastTime = hud.time;
  return state;
}

export function drawHud(hud: HudContext): void {
  const { ctx, settings } = hud;
  const state = stateFor(hud);
  ctx.save();
  ctx.scale(settings.uiScale, settings.uiScale);
  const scaledWidth = hud.width / settings.uiScale;
  const scaledHeight = hud.height / settings.uiScale;
  ctx.textBaseline = 'alphabetic';
  const frame = frameOf(hud, scaledWidth, scaledHeight);

  drawLowHealthWarning(hud, scaledWidth, scaledHeight);
  drawIntegrity(hud, state, frame);
  drawResources(hud, state, scaledWidth, frame);
  drawCombo(hud, state, frame);
  drawBuildStrip(hud, scaledWidth, scaledHeight, frame);
  drawRoomBanner(hud, frame);
  drawBossBar(hud, state, scaledWidth, frame);
  drawNotifications(hud, frame);
  if (settings.showFps) drawDiagnostics(hud, scaledWidth, scaledHeight);

  ctx.restore();
}

function motionOn(hud: HudContext): boolean {
  return !hud.settings.reducedMotion;
}

/* ------------------------------------------------------------------ pieces -- */

/** A parallelogram: the HUD's one shape, matching the clipped corners of the menus. */
function slant(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, skew: number): void {
  ctx.beginPath();
  ctx.moveTo(x + skew, y);
  ctx.lineTo(x + w + skew, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

function drawIntegrity(hud: HudContext, state: HudState, frame: Frame): void {
  const { ctx, palette, world, time } = hud;
  const ball = world.ball;
  const dt = state.dt;

  if (ball.hp < state.lastHp - 1e-6) {
    state.ghostHold = 0.45;
    state.hurt = 0.35;
  }
  if (ball.hp > state.ghostHp) state.ghostHp = ball.hp;
  state.lastHp = ball.hp;
  if (state.ghostHold > 0) state.ghostHold -= dt;
  else state.ghostHp = damp(state.ghostHp, ball.hp, 6, dt);
  state.hurt = Math.max(0, state.hurt - dt);

  const fraction = clamp01(ball.hp / ball.maxHp);
  const ghost = clamp01(state.ghostHp / ball.maxHp);
  const critical = fraction <= 0.3 && ball.alive;

  const compact = frame.compact;
  let x = (compact ? 14 : 22) + frame.safe.left;
  let y = (compact ? 13 : 20) + frame.safe.top;
  if (motionOn(hud) && state.hurt > 0) {
    const k = state.hurt / 0.35;
    x += Math.sin(time * 90) * 5 * k;
    y += Math.cos(time * 77) * 3 * k;
  }
  const w = compact ? 150 : 250;
  const h = compact ? 13 : 18;
  const skew = compact ? 5 : 7;

  // Plate
  ctx.save();
  ctx.fillStyle = 'rgba(6,8,14,0.72)';
  slant(ctx, x - 8, y - 7, w + (compact ? 50 : 60), h + 14, skew + 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Track
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  slant(ctx, x, y, w, h, skew);
  ctx.fill();

  // The bar changes colour by band rather than continuously, so "I am in trouble"
  // is a discrete, glanceable state instead of a gradient the player has to judge.
  const colour = fraction > 0.5 ? palette.safe : fraction > 0.25 ? palette.reward : palette.danger;

  ctx.save();
  slant(ctx, x, y, w, h, skew);
  ctx.clip();
  // Ghost: what the last hit took, lingering before it drains.
  if (ghost > fraction) {
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x + w * fraction, y, w * (ghost - fraction) + skew, h);
    ctx.globalAlpha = 1;
  }
  const fill = ctx.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, lighten(colour, 0.35));
  fill.addColorStop(0.5, colour);
  fill.addColorStop(1, darken(colour, 0.25));
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w * fraction + (fraction >= 1 ? skew : 0), h);
  // Segment ticks every 10% so a chunk of damage is countable.
  ctx.strokeStyle = 'rgba(6,8,14,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) {
    const tx = x + (w * i) / 10;
    ctx.moveTo(tx + skew, y);
    ctx.lineTo(tx, y + h);
  }
  ctx.stroke();
  // Gloss on the top half.
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(x, y, w, h * 0.42);
  ctx.restore();

  if (critical && !hud.settings.reducedFlashing) {
    ctx.strokeStyle = palette.danger;
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(time * (6 + (1 - fraction / 0.3) * 6));
    ctx.lineWidth = 2;
    slant(ctx, x - 1, y - 1, w + 2, h + 2, skew);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Readout, right of the bar.
  ctx.textAlign = 'left';
  ctx.font = `${compact ? 14 : 17}px ${DISPLAY_FONT}`;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  const hpText = `${Math.ceil(ball.hp)}`;
  const readX = x + w + (compact ? 10 : 14);
  ctx.strokeText(hpText, readX, y + h - 1);
  ctx.fillStyle = critical ? palette.danger : '#ffffff';
  ctx.fillText(hpText, readX, y + h - 1);
  const hpWidth = ctx.measureText(hpText).width;
  ctx.font = `600 ${compact ? 9 : 10}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`/${Math.round(ball.maxHp)}`, readX + 2 + hpWidth, y + h - 2);

  // Shields and revives sit under the bar as discrete pips: a countable resource.
  let pipX = x + 8;
  const pipY = y + h + (compact ? 11 : 13);
  for (let i = 0; i < Math.min(10, ball.shield); i++) {
    hexagon(ctx, pipX, pipY, 5.5);
    ctx.fillStyle = palette.shield;
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,8,14,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    pipX += 15;
  }
  for (let i = 0; i < Math.min(4, ball.reviveCharges); i++) {
    ctx.strokeStyle = palette.safe;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pipX, pipY, 5.5, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = palette.safe;
    ctx.fillRect(pipX - 1, pipY - 3.5, 2, 7);
    ctx.fillRect(pipX - 3.5, pipY - 1, 7, 2);
    pipX += 15;
  }
  ctx.restore();
}

function hexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * The combo meter. Big, slanted and loud on purpose: it is the game's score, and
 * escalation should be felt rather than read. It pops on every hit, grows and
 * shifts colour with each tier, announces a new tier, and its decay bar - the
 * actionable part - jitters when it is about to run out.
 */
function drawCombo(hud: HudContext, state: HudState, frame: Frame): void {
  const { ctx, world, palette, run, time } = hud;
  const combo = world.combo;
  const dt = state.dt;
  if (combo.value > state.lastCombo) state.comboPop = 1;
  state.lastCombo = combo.value;
  state.comboPop = Math.max(0, state.comboPop - dt * 7);
  const tier = comboTier(combo.value);
  if (tier > state.lastTier) state.tierPop = 1;
  state.lastTier = tier;
  state.tierPop = Math.max(0, state.tierPop - dt * 1.6);
  if (combo.value <= 0) return;

  const stats = run.stats();
  const multiplier = comboMultiplier(combo, stats);
  const fill = comboFill(combo);
  const motion = motionOn(hud);
  const compact = frame.compact;
  const x = frame.arena.x + frame.arena.w - (compact ? 14 : 26) - (frame.portrait ? 0 : frame.safe.right);
  // Below the shard panel on a desktop; inside the arena's top corner on a phone,
  // where the top of the screen belongs to the integrity bar and touch buttons.
  const y = compact ? frame.arena.y + (frame.portrait ? 52 : 96) : 128;
  const color = tier >= 4 ? palette.crit : tier >= 2 ? palette.combo : lighten(palette.combo, 0.35);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.07);
  const pop = motion ? 1 + easeOutCubic(state.comboPop) * 0.28 : 1;
  const size = compact ? 22 + tier * 3 : 30 + tier * 5;
  ctx.scale(pop, pop);

  ctx.textAlign = 'right';
  ctx.lineJoin = 'round';
  ctx.font = `${size}px ${DISPLAY_FONT}`;
  const label = `x${multiplier.toFixed(2)}`;
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  ctx.strokeText(label, 0, 0);
  if (tier >= 2) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + 0.15 * tier;
    ctx.fillStyle = color;
    ctx.fillText(label, 0, 2);
    ctx.restore();
  }
  const gradient = ctx.createLinearGradient(0, -size, 0, 0);
  gradient.addColorStop(0, lighten(color, 0.55));
  gradient.addColorStop(1, color);
  ctx.fillStyle = gradient;
  ctx.fillText(label, 0, 0);
  ctx.restore();

  // Hits and tier name.
  ctx.save();
  ctx.textAlign = 'right';
  ctx.font = `700 11px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(`${Math.floor(combo.value)} HITS`, x, y + 18);
  const tierName = COMBO_TIER_NAMES[tier];
  if (tierName) {
    const announce = state.tierPop;
    const tierScale = motion ? 1 + announce * 0.5 : 1;
    ctx.font = `12px ${DISPLAY_FONT}`;
    const tw = ctx.measureText(tierName.toUpperCase()).width;
    ctx.save();
    ctx.translate(x - tw / 2 - 6, y - size - 10);
    ctx.scale(tierScale, tierScale);
    ctx.fillStyle = alpha(color, 0.2 + announce * 0.5);
    slant(ctx, -tw / 2 - 8, -12, tw + 14, 17, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(tierName.toUpperCase(), 0, 1);
    ctx.restore();
  }

  // The decay bar is the actionable part: it says how long you have.
  const barW = compact ? 92 : 140;
  const barY = y + 25;
  const urgent = fill < 0.3;
  const jitter = urgent && motion ? Math.sin(time * 60) * 1.5 : 0;
  ctx.fillStyle = 'rgba(6,8,14,0.7)';
  slant(ctx, x - barW - 1 + jitter, barY - 1, barW + 2, 7, 3);
  ctx.fill();
  ctx.fillStyle = urgent ? palette.danger : color;
  if (urgent && !hud.settings.reducedFlashing) ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 24);
  slant(ctx, x - barW * fill + jitter, barY, barW * fill, 5, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Momentum is a separate, always-available multiplier, shown only when it is
  // actually contributing.
  const speed = Math.hypot(world.ball.vx, world.ball.vy);
  const momentum = momentumMultiplier(speed, stats);
  if (momentum > 1.06) {
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = palette.reward;
    ctx.fillText(`MOMENTUM x${momentum.toFixed(2)}`, x, barY + 20);
  }
  ctx.restore();
}

function drawResources(hud: HudContext, state: HudState, width: number, frame: Frame): void {
  const { ctx, palette, run } = hud;
  const dt = state.dt;
  if (run.shards > state.lastShards) state.shardPop = 1;
  if (run.shards < state.shardsShown) state.shardsShown = run.shards;
  state.lastShards = run.shards;
  // Count up quickly toward the real value; never lag by more than a moment.
  state.shardsShown = run.shards - (run.shards - state.shardsShown) * Math.exp(-12 * dt);
  if (Math.abs(run.shards - state.shardsShown) < 0.5) state.shardsShown = run.shards;
  state.shardPop = Math.max(0, state.shardPop - dt * 6);

  const compact = frame.compact;
  // A portrait phone is too narrow for two corner panels plus the touch buttons,
  // so the shards and depth drop to one line under the integrity bar instead.
  if (frame.portrait && frame.touch) {
    drawResourceLine(hud, state, frame);
    return;
  }
  const x = width - (compact ? 14 : 24) - frame.safe.right - frame.reserve;
  const y = (compact ? 30 : 38) + frame.safe.top;
  ctx.save();
  ctx.fillStyle = 'rgba(6,8,14,0.72)';
  if (compact) slant(ctx, x - 122, y - 20, 130, 44, 6);
  else slant(ctx, x - 150, y - 25, 160, 58, 8);
  ctx.fill();

  const pop = motionOn(hud) ? 1 + state.shardPop * 0.22 : 1;
  ctx.textAlign = 'right';
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pop, pop);
  ctx.font = `${compact ? 17 : 22}px ${DISPLAY_FONT}`;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  const value = formatNumber(Math.round(state.shardsShown));
  ctx.strokeText(value, 0, 0);
  ctx.fillStyle = palette.reward;
  ctx.fillText(value, 0, 0);
  const vw = ctx.measureText(value).width;
  // Shard glyph: the same diamond the pickups use.
  const gx = -vw - 14;
  const gy = -8;
  ctx.beginPath();
  ctx.moveTo(gx, gy - 9);
  ctx.lineTo(gx + 6, gy);
  ctx.lineTo(gx, gy + 9);
  ctx.lineTo(gx - 6, gy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.moveTo(gx, gy - 9);
  ctx.lineTo(gx + 3, gy - 1);
  ctx.lineTo(gx, gy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.font = `700 ${compact ? 9 : 10}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const act = run.currentAct();
  const line = [`DEPTH ${act.tier + 1}/${run.map.tiers}`, `ROOM ${run.currentNode.layer + 1}/${act.layers}`];
  // Rerolls are shown on the reward screen too; a small screen drops them here.
  if (run.rerollsLeft > 0 && !compact) line.push(`${run.rerollsLeft} REROLL${run.rerollsLeft > 1 ? 'S' : ''}`);
  ctx.fillText(line.join(compact ? ' · ' : '  ·  '), x, y + (compact ? 15 : 18));
  if (run.bound.level > 0) {
    ctx.fillStyle = palette.danger;
    ctx.fillText(boundName(run.bound.level).toUpperCase(), x, y + (compact ? 34 : 44));
  }
  ctx.restore();
}

/** Shards, depth and room as a single left-aligned line, for portrait phones. */
function drawResourceLine(hud: HudContext, state: HudState, frame: Frame): void {
  const { ctx, palette, run } = hud;
  const x = frame.safe.left + 16;
  const y = frame.safe.top + 60;
  const pop = motionOn(hud) ? 1 + state.shardPop * 0.22 : 1;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  // Shard glyph, then the count.
  ctx.fillStyle = palette.reward;
  ctx.beginPath();
  ctx.moveTo(x + 5, y - 13);
  ctx.lineTo(x + 10, y - 6);
  ctx.lineTo(x + 5, y + 1);
  ctx.lineTo(x, y - 6);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.translate(x + 15, y);
  ctx.scale(pop, pop);
  ctx.font = `16px ${DISPLAY_FONT}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  const value = formatNumber(Math.round(state.shardsShown));
  ctx.strokeText(value, 0, 0);
  ctx.fillText(value, 0, 0);
  const vw = ctx.measureText(value).width;
  ctx.restore();
  const act = run.currentAct();
  const parts = [`DEPTH ${act.tier + 1}/${run.map.tiers}`, `ROOM ${run.currentNode.layer + 1}/${act.layers}`];
  if (run.bound.level > 0) parts.push(boundName(run.bound.level).toUpperCase());
  ctx.font = `700 9px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeStyle = 'rgba(6,8,14,0.85)';
  ctx.lineWidth = 3;
  const line = parts.join(' · ');
  ctx.strokeText(line, x + 24 + vw, y - 1);
  ctx.fillText(line, x + 24 + vw, y - 1);
  ctx.restore();
}

/**
 * The build strip: one small glyph per upgrade held, grouped by family.
 *
 * This is the compromise that keeps the HUD clean without hiding the build. The
 * player can see *shape* of their build at a glance - mostly impact, two defensive
 * picks, one transformation - and press Tab for the detail.
 */
function drawBuildStrip(hud: HudContext, width: number, height: number, frame: Frame): void {
  const { ctx, run } = hud;
  const upgrades = run.build.list();
  if (upgrades.length === 0) return;

  // Desktop: bottom-left. Touch: the bottom belongs to the thumbs, so the strip
  // sits just under the arena in portrait and under the integrity bar otherwise.
  const size = frame.compact ? 13 : 16;
  const gap = frame.compact ? 4 : 5;
  const x = (frame.compact ? 14 : 22) + frame.safe.left;
  const y = !frame.touch
    ? height - 30 - frame.safe.bottom
    : frame.portrait
      ? frame.arena.y + frame.arena.h + 10
      : frame.safe.top + (frame.compact ? 52 : 62);
  const maxX = frame.touch && !frame.portrait ? width * 0.42 : width - 60;

  ctx.save();
  ctx.textAlign = 'center';
  for (const [index, entry] of upgrades.entries()) {
    const cx = x + index * (size + gap);
    if (cx > maxX) break;
    const colour = familyColour(entry.def.family);
    ctx.fillStyle = 'rgba(6,8,14,0.7)';
    diamond(ctx, cx + size / 2, y + size / 2 + 1.5, size * 0.66);
    ctx.fill();
    const g = ctx.createLinearGradient(0, y, 0, y + size);
    g.addColorStop(0, lighten(colour, 0.35));
    g.addColorStop(1, darken(colour, 0.2));
    ctx.fillStyle = g;
    diamond(ctx, cx + size / 2, y + size / 2, size * 0.62);
    ctx.fill();
    ctx.fillStyle = 'rgba(6,8,14,0.85)';
    ctx.font = `9px ${DISPLAY_FONT}`;
    ctx.fillText(entry.def.name.slice(0, 1).toUpperCase(), cx + size / 2, y + size / 2 + 3.5);
    if (entry.stacks > 1) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 9px ${FONT}`;
      ctx.fillText(`${entry.stacks}`, cx + size - 1, y + 3);
    }
  }

  const synergies = run.build.synergies();
  const identity = run.build.identity();
  ctx.textAlign = 'left';
  ctx.font = `700 10px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const parts: string[] = [];
  if (identity.length > 0) parts.push(identity.map((i) => i.name.toUpperCase()).join(' / '));
  if (synergies.length > 0) parts.push(`${synergies.length} SYNERG${synergies.length > 1 ? 'IES' : 'Y'}`);
  // The key prompt only makes sense with a keyboard; touch has a build button.
  if (!frame.touch) parts.push('TAB FOR BUILD');
  const labelY = frame.touch ? y + size + 12 : y - 9;
  if (parts.length > 0) ctx.fillText(parts.join('  ·  '), x, labelY);
  ctx.restore();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

/**
 * Room title card: two rules draw outward from the centre, the room type rises
 * into place between them, and the whole card dissolves after three seconds.
 */
function drawRoomBanner(hud: HudContext, frame: Frame): void {
  const { ctx, run, world, palette } = hud;
  // Only for the first few seconds: after that it is clutter.
  const age = world.roomTime;
  if (age > 3.6) return;
  const motion = motionOn(hud);
  const inT = motion ? easeOutCubic((age - 0.25) / 0.5) : 1;
  const out = clamp01((age - 2.9) / 0.7);
  const opacity = clamp01(inT) * (1 - out);
  if (opacity <= 0) return;

  const compact = frame.compact;
  const cx = frame.arena.x + frame.arena.w / 2;
  // On a phone the banner sits inside the arena, clear of the corner HUD.
  const y = compact ? frame.arena.y + (frame.portrait ? 30 : 40) : 46;
  const label = (ARCHETYPE_LABELS[run.currentRoom.archetype] ?? run.currentRoom.archetype).toUpperCase();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'center';
  ctx.font = `${compact ? 18 : 26}px ${DISPLAY_FONT}`;
  const spaced = label.split('').join(' ');
  const tw = ctx.measureText(spaced).width;
  const rule = (tw / 2 + (compact ? 40 : 90)) * inT;
  const rise = motion ? (1 - inT) * 12 : 0;

  ctx.strokeStyle = alpha(palette.perfect, 0.7);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - rule, y - 9);
  ctx.lineTo(cx - tw / 2 - 16, y - 9);
  ctx.moveTo(cx + tw / 2 + 16, y - 9);
  ctx.lineTo(cx + rule, y - 9);
  ctx.stroke();

  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(6,8,14,0.85)';
  ctx.strokeText(spaced, cx, y + rise);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(spaced, cx, y + rise);
  ctx.font = `600 ${compact ? 10 : 12}px ${FONT}`;
  ctx.fillStyle = palette.neutral;
  ctx.lineWidth = 3;
  const sub = run.currentRoom.templateName.toUpperCase();
  const subY = y + (compact ? 15 : 20) + rise * 1.5;
  ctx.strokeText(sub, cx, subY);
  ctx.fillText(sub, cx, subY);
  ctx.restore();
}

function drawBossBar(hud: HudContext, state: HudState, width: number, frame: Frame): void {
  const { ctx, world, palette, time } = hud;
  const info = bossBarInfo(world);
  if (!info) {
    state.bossGhost = 1;
    state.bossLast = 1;
    return;
  }
  const dt = state.dt;
  if (info.fraction < state.bossLast - 1e-6) {
    state.bossHold = 0.5;
    state.bossHurt = 0.2;
  }
  if (info.fraction > state.bossGhost) state.bossGhost = info.fraction;
  state.bossLast = info.fraction;
  if (state.bossHold > 0) state.bossHold -= dt;
  else state.bossGhost = damp(state.bossGhost, info.fraction, 4, dt);
  state.bossHurt = Math.max(0, state.bossHurt - dt);

  const compact = frame.compact;
  // Between the corner panels on a small landscape screen, across the arena in
  // portrait, and wide and centred on a desktop.
  const w = !compact
    ? Math.min(600, width - 140)
    : frame.portrait
      ? frame.arena.w - 44
      : clamp(width - 540, 200, 420);
  const centre = compact ? frame.arena.x + frame.arena.w / 2 : width / 2;
  let x = centre - w / 2;
  // Sits below the room title card, which shares the top centre for three seconds.
  const y = !compact ? 104 : frame.portrait ? frame.arena.y + 70 : frame.safe.top + 84;
  if (motionOn(hud) && state.bossHurt > 0) x += Math.sin(time * 80) * 3 * (state.bossHurt / 0.2);
  const skew = 8;

  ctx.save();
  ctx.fillStyle = 'rgba(6,8,14,0.78)';
  slant(ctx, x - 14, y - 30, w + 28, 52, skew + 4);
  ctx.fill();
  ctx.strokeStyle = alpha(palette.danger, 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `${compact ? 14 : 18}px ${DISPLAY_FONT}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  const name = info.name.toUpperCase();
  ctx.strokeText(name, centre, y - 9);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, centre, y - 9);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  slant(ctx, x, y, w, 10, skew);
  ctx.fill();
  ctx.save();
  slant(ctx, x, y, w, 10, skew);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.8;
  ctx.fillRect(x, y, w * state.bossGhost + skew, 10);
  ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(0, y, 0, y + 10);
  g.addColorStop(0, lighten(palette.danger, 0.3));
  g.addColorStop(1, darken(palette.danger, 0.25));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w * info.fraction, 10);
  ctx.restore();

  if (info.phase) {
    ctx.font = `700 10px ${FONT}`;
    ctx.fillStyle = palette.neutral;
    ctx.fillText(info.phase.toUpperCase().split('').join(' '), centre, y + 23);
  }
  ctx.restore();
}

function drawNotifications(hud: HudContext, frame: Frame): void {
  const { ctx, run, palette } = hud;
  const now = Date.now();
  const recent = run.notifications.filter((n) => now - n.at < 3400).slice(-4);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (const [index, notification] of recent.entries()) {
    const ageSeconds = (now - notification.at) / 1000;
    const age = ageSeconds / 3.4;
    const opacity = clamp01(1 - age ** 3) * clamp01(ageSeconds / 0.08);
    const pop = motionOn(hud) ? easeOutBack(clamp01(ageSeconds / 0.22), 2.4) : 1;
    const rare = notification.tone === 'rare';
    ctx.globalAlpha = opacity;
    ctx.fillStyle =
      notification.tone === 'good'
        ? palette.safe
        : notification.tone === 'bad'
          ? palette.danger
          : rare
            ? palette.reward
            : '#ffffff';
    const y = frame.arena.y + frame.arena.h * 0.28 + index * (frame.compact ? 20 : 26) - lerp(0, 10, age);
    ctx.save();
    ctx.translate(frame.arena.x + frame.arena.w / 2, y);
    ctx.scale(pop, pop);
    ctx.font = frame.compact ? (rare ? `15px ${DISPLAY_FONT}` : `700 12px ${FONT}`) : rare ? `20px ${DISPLAY_FONT}` : `700 15px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(6,8,14,0.85)';
    ctx.strokeText(notification.text, 0, 0);
    ctx.fillText(notification.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * A screen-edge pulse when integrity is critical.
 *
 * Positioned at the edges specifically so it cannot obscure the arena: the one
 * moment the player most needs to see clearly is the moment they are nearly dead.
 * It beats like a heart, faster the closer to death.
 */
function drawLowHealthWarning(hud: HudContext, width: number, height: number): void {
  const { ctx, world, settings, time } = hud;
  const fraction = world.ball.hp / world.ball.maxHp;
  if (fraction > 0.3 || !world.ball.alive) return;
  const severity = 1 - fraction / 0.3;
  const rate = 1.2 + severity * 1.4;
  const phase = (time * rate) % 1;
  // Two beats per cycle: lub-dub.
  const beat = settings.reducedFlashing ? 0.5 : Math.max(Math.exp(-phase * 14), Math.exp(-Math.abs(phase - 0.22) * 14) * 0.7);
  const opacity = 0.12 + severity * 0.2 + beat * 0.16 * (0.5 + severity);
  const thickness = 60 + severity * 30;
  ctx.save();
  const edges: Array<[number, number, number, number, number, number, number, number]> = [
    [0, 0, 0, thickness, 0, 0, width, thickness],
    [0, height, 0, height - thickness, 0, height - thickness, width, thickness],
    [0, 0, thickness, 0, 0, 0, thickness, height],
    [width, 0, width - thickness, 0, width - thickness, 0, thickness, height],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, `rgba(255,50,80,${opacity})`);
    gradient.addColorStop(1, 'rgba(255,50,80,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(rx, ry, rw, rh);
  }
  ctx.restore();
}

function drawDiagnostics(hud: HudContext, width: number, height: number): void {
  const { ctx, world, fps } = hud;
  ctx.textAlign = 'left';
  ctx.font = `500 10px ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  const lines = [
    `${fps.toFixed(0)} fps`,
    `entities ${world.enemies.length}e ${world.projectiles.length}p ${world.props.length}o ${world.fields.length}f`,
    `impacts ${world.stats.impacts}`,
  ];
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, 20, height - 90 - (lines.length - index) * 12);
  }
  void width;
}

/* ------------------------------------------------------------------ helpers -- */

export function familyColour(family: string): string {
  switch (family) {
    case 'bounce':
      return '#7fe8ff';
    case 'impact':
      return '#ff9a5a';
    case 'movement':
      return '#a0ffc0';
    case 'defense':
      return '#6ab0ff';
    case 'utility':
      return '#ffd15c';
    case 'body':
      return '#c0a0ff';
    case 'transformation':
      return '#ff7ab0';
    default:
      return '#9fb3cc';
  }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/**
 * The first-run control prompt.
 *
 * Shown only during the very first room of a player's first run, and only until
 * they have used each verb once. Teaching by doing beats a tutorial screen, but
 * the player still has to be told which key to press - so the key is drawn as a
 * key cap, which is how every game says "press this".
 */
export function drawControlHints(
  hud: HudContext,
  learned: { steer: boolean; bounce: boolean; dive: boolean },
): void {
  const { ctx, width, height, settings, time } = hud;
  const touch = hud.layout?.touch ?? false;
  // The same three lessons, in the vocabulary of whichever controls are showing.
  const hints: Array<[boolean, string, string]> = touch
    ? [
        [learned.steer, 'STICK', 'drag to steer while airborne'],
        [learned.bounce, 'BOUNCE', 'tap just before contact'],
        [learned.dive, 'PULL DOWN', 'on the stick to dive'],
      ]
    : [
        [learned.steer, 'A / D', 'steer while airborne'],
        [learned.bounce, 'SPACE', 'just before contact for a perfect bounce'],
        [learned.dive, 'S', 'dive to hit harder'],
      ];
  if (hints.every(([done]) => done)) return;

  ctx.save();
  ctx.scale(settings.uiScale, settings.uiScale);
  const frame = frameOf(hud, width / settings.uiScale, height / settings.uiScale);
  const centreX = frame.arena.x + frame.arena.w / 2;
  let y = frame.arena.y + frame.arena.h * (frame.compact ? 0.5 : 0.6);
  const bob = settings.reducedMotion ? 0 : Math.sin(time * 3) * 2;
  for (const [done, key, text] of hints) {
    if (done) continue;
    ctx.font = `12px ${DISPLAY_FONT}`;
    const kw = ctx.measureText(key).width + 18;
    ctx.font = `600 14px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const total = kw + 10 + tw;
    const left = Math.max(frame.arena.x + 6, centreX - total / 2);

    // Key cap: a raised face over a darker base.
    ctx.fillStyle = 'rgba(6,8,14,0.85)';
    roundRect(ctx, left, y - 15 + bob, kw, 24, 5);
    ctx.fill();
    ctx.fillStyle = '#e8eef8';
    roundRect(ctx, left, y - 17 + bob, kw, 21, 5);
    ctx.fill();
    ctx.fillStyle = '#0b0e16';
    ctx.font = `12px ${DISPLAY_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(key, left + kw / 2, y - 2 + bob);

    ctx.textAlign = 'left';
    ctx.font = `600 14px ${FONT}`;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(6,8,14,0.8)';
    ctx.strokeText(text, left + kw + 10, y - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(text, left + kw + 10, y - 2);
    y += frame.compact ? 28 : 32;
  }
  ctx.restore();
}
