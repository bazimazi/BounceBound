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
 */

import { clamp01, formatNumber, lerp, TAU } from '../core/math';
import { comboFill, comboMultiplier, comboTier, COMBO_TIER_NAMES, momentumMultiplier } from '../sim/combo';
import { bossBarInfo } from '../sim/bossLogic';
import type { World } from '../sim/world';
import type { Run } from '../run/run';
import type { SemanticPalette, Settings } from '../meta/settings';
import { ARCHETYPE_LABELS } from '../gen/mapgen';
import { boundName } from '../content/modifiers';

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
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export function drawHud(hud: HudContext): void {
  const { ctx, settings } = hud;
  ctx.save();
  ctx.scale(settings.uiScale, settings.uiScale);
  const scaledWidth = hud.width / settings.uiScale;
  const scaledHeight = hud.height / settings.uiScale;

  drawIntegrity(hud, scaledWidth);
  drawCombo(hud, scaledWidth, scaledHeight);
  drawResources(hud, scaledWidth);
  drawBuildStrip(hud, scaledHeight);
  drawRoomBanner(hud, scaledWidth);
  drawBossBar(hud, scaledWidth);
  drawNotifications(hud, scaledWidth, scaledHeight);
  drawLowHealthWarning(hud, scaledWidth, scaledHeight);
  if (settings.showFps) drawDiagnostics(hud, scaledWidth, scaledHeight);

  ctx.restore();
}

/* ------------------------------------------------------------------ pieces -- */

function drawIntegrity(hud: HudContext, width: number): void {
  const { ctx, palette, world } = hud;
  const ball = world.ball;
  const x = 20;
  const y = 20;
  const w = 248;
  const h = 18;
  const fraction = clamp01(ball.hp / ball.maxHp);

  ctx.fillStyle = 'rgba(8,10,16,0.66)';
  roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 6);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();

  // The bar changes colour by band rather than continuously, so "I am in trouble"
  // is a discrete, glanceable state instead of a gradient the player has to judge.
  const colour = fraction > 0.5 ? palette.safe : fraction > 0.25 ? palette.reward : palette.danger;
  ctx.fillStyle = colour;
  roundRect(ctx, x, y, w * fraction, h, 4);
  ctx.fill();

  ctx.font = `700 12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${Math.ceil(ball.hp)} / ${Math.round(ball.maxHp)}`, x + 8, y + 13);

  // Shields sit next to the bar as discrete pips: a countable resource.
  let pipX = x + w + 12;
  for (let i = 0; i < Math.min(10, ball.shield); i++) {
    ctx.fillStyle = palette.shield;
    ctx.beginPath();
    ctx.arc(pipX, y + h / 2, 5, 0, TAU);
    ctx.fill();
    pipX += 14;
  }
  for (let i = 0; i < Math.min(4, ball.reviveCharges); i++) {
    ctx.strokeStyle = palette.safe;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pipX, y + h / 2, 5.5, 0, TAU);
    ctx.stroke();
    pipX += 14;
  }
  void width;
}

function drawCombo(hud: HudContext, width: number, height: number): void {
  const { ctx, world, palette, run } = hud;
  const combo = world.combo;
  if (combo.value <= 0) return;

  const stats = run.stats();
  const multiplier = comboMultiplier(combo, stats);
  const tier = comboTier(combo.value);
  const fill = comboFill(combo);
  const x = width / 2;
  const y = height - 76;

  ctx.textAlign = 'center';
  // Tier drives size and colour, so escalation is felt rather than read.
  const size = 26 + tier * 4;
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  const label = `x${multiplier.toFixed(2)}`;
  ctx.strokeText(label, x, y);
  ctx.fillStyle = tier >= 4 ? palette.crit : palette.combo;
  ctx.fillText(label, x, y);

  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  const tierName = COMBO_TIER_NAMES[tier];
  ctx.fillText(`${combo.value} impacts${tierName ? ` - ${tierName}` : ''}`, x, y + 16);

  // The decay bar is the actionable part: it says how long you have.
  const barW = 150;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, x - barW / 2, y + 22, barW, 4, 2);
  ctx.fill();
  ctx.fillStyle = fill < 0.3 ? palette.danger : palette.combo;
  roundRect(ctx, x - barW / 2, y + 22, barW * fill, 4, 2);
  ctx.fill();

  // Momentum is a separate, always-available multiplier, shown only when it is
  // actually contributing.
  const speed = Math.hypot(world.ball.vx, world.ball.vy);
  const momentum = momentumMultiplier(speed, stats);
  if (momentum > 1.06) {
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = palette.reward;
    ctx.fillText(`momentum x${momentum.toFixed(2)}`, x, y + 40);
  }
}

function drawResources(hud: HudContext, width: number): void {
  const { ctx, palette, run } = hud;
  ctx.textAlign = 'right';
  ctx.font = `700 14px ${FONT}`;
  ctx.fillStyle = palette.reward;
  ctx.fillText(`${formatNumber(run.shards)} shards`, width - 20, 33);

  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const act = run.map.acts.findIndex((a) => a.nodes.some((n) => n.id === run.currentNode.id)) + 1;
  ctx.fillText(`depth ${act} - room ${run.currentNode.layer + 1}`, width - 20, 50);
  if (run.rerollsLeft > 0) {
    ctx.fillText(`${run.rerollsLeft} rerolls`, width - 20, 65);
  }
  if (run.bound.level > 0) {
    ctx.fillStyle = palette.danger;
    ctx.fillText(boundName(run.bound.level), width - 20, 80);
  }
}

/**
 * The build strip: one small glyph per upgrade held, grouped by family.
 *
 * This is the compromise that keeps the HUD clean without hiding the build. The
 * player can see *shape* of their build at a glance - mostly impact, two defensive
 * picks, one transformation - and press Tab for the detail.
 */
function drawBuildStrip(hud: HudContext, height: number): void {
  const { ctx, run } = hud;
  const upgrades = run.build.list();
  if (upgrades.length === 0) return;

  const x = 20;
  const y = height - 32;
  const size = 15;
  const gap = 5;

  ctx.textAlign = 'center';
  for (const [index, entry] of upgrades.entries()) {
    const cx = x + index * (size + gap);
    if (cx > hud.width - 60) break;
    ctx.fillStyle = familyColour(entry.def.family);
    ctx.globalAlpha = 0.9;
    roundRect(ctx, cx, y, size, size, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.font = `800 10px ${FONT}`;
    ctx.fillText(entry.def.name.slice(0, 1).toUpperCase(), cx + size / 2, y + size - 4);
    if (entry.stacks > 1) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 8px ${FONT}`;
      ctx.fillText(`${entry.stacks}`, cx + size - 2, y + 8);
    }
  }

  const synergies = run.build.synergies();
  const identity = run.build.identity();
  ctx.textAlign = 'left';
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  const parts: string[] = [];
  if (identity.length > 0) parts.push(identity.map((i) => i.name).join(' / '));
  if (synergies.length > 0) parts.push(`${synergies.length} synergy${synergies.length > 1 ? 's' : ''}`);
  parts.push('Tab for build');
  ctx.fillText(parts.join('  -  '), x, y - 8);
}

function drawRoomBanner(hud: HudContext, width: number): void {
  const { ctx, run, world, palette } = hud;
  // Only for the first few seconds: after that it is clutter.
  const age = world.roomTime;
  if (age > 4) return;
  const alpha = age < 3 ? 1 : 1 - (age - 3);
  ctx.globalAlpha = clamp01(alpha);
  ctx.textAlign = 'center';
  ctx.font = `700 17px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  const label = ARCHETYPE_LABELS[run.currentRoom.archetype] ?? run.currentRoom.archetype;
  ctx.fillText(label, width / 2, 42);
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = palette.neutral;
  ctx.fillText(run.currentRoom.templateName, width / 2, 60);
  ctx.globalAlpha = 1;
}

function drawBossBar(hud: HudContext, width: number): void {
  const { ctx, world, palette } = hud;
  const info = bossBarInfo(world);
  if (!info) return;
  const w = Math.min(560, width - 120);
  const x = (width - w) / 2;
  const y = 74;

  ctx.fillStyle = 'rgba(8,10,16,0.7)';
  roundRect(ctx, x - 6, y - 22, w + 12, 44, 6);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.font = `800 15px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(info.name, width / 2, y - 6);
  ctx.font = `600 10px ${FONT}`;
  ctx.fillStyle = palette.neutral;
  ctx.fillText(info.phase.toUpperCase(), width / 2, y + 18);

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, x, y, w, 8, 4);
  ctx.fill();
  ctx.fillStyle = palette.danger;
  roundRect(ctx, x, y, w * info.fraction, 8, 4);
  ctx.fill();
}

function drawNotifications(hud: HudContext, width: number, height: number): void {
  const { ctx, run, palette } = hud;
  const now = Date.now();
  const recent = run.notifications.filter((n) => now - n.at < 3400).slice(-4);
  ctx.textAlign = 'center';
  for (const [index, notification] of recent.entries()) {
    const age = (now - notification.at) / 3400;
    ctx.globalAlpha = clamp01(1 - age ** 3);
    ctx.font = `700 ${notification.tone === 'rare' ? 18 : 14}px ${FONT}`;
    ctx.fillStyle =
      notification.tone === 'good'
        ? palette.safe
        : notification.tone === 'bad'
          ? palette.danger
          : notification.tone === 'rare'
            ? palette.reward
            : '#ffffff';
    const y = height * 0.28 + index * 22 - lerp(0, 10, age);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(notification.text, width / 2, y);
    ctx.fillText(notification.text, width / 2, y);
  }
  ctx.globalAlpha = 1;
}

/**
 * A screen-edge pulse when integrity is critical.
 *
 * Positioned at the edges specifically so it cannot obscure the arena: the one
 * moment the player most needs to see clearly is the moment they are nearly dead.
 */
function drawLowHealthWarning(hud: HudContext, width: number, height: number): void {
  const { ctx, world, palette, settings, time } = hud;
  const fraction = world.ball.hp / world.ball.maxHp;
  if (fraction > 0.3 || !world.ball.alive) return;
  const severity = 1 - fraction / 0.3;
  const pulse = settings.reducedFlashing ? 0.5 : (Math.sin(time * 6) + 1) / 2;
  const alpha = 0.1 + severity * 0.22 * (0.5 + pulse * 0.5);
  const thickness = 52;
  const gradient = ctx.createLinearGradient(0, 0, 0, thickness);
  gradient.addColorStop(0, `rgba(255,60,90,${alpha})`);
  gradient.addColorStop(1, 'rgba(255,60,90,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, thickness);
  ctx.save();
  ctx.translate(0, height);
  ctx.scale(1, -1);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, thickness);
  ctx.restore();
  void palette;
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
 * the player still has to be told which key to press.
 */
export function drawControlHints(
  hud: HudContext,
  learned: { steer: boolean; bounce: boolean; dive: boolean },
): void {
  const { ctx, width, height, settings } = hud;
  const hints: Array<[boolean, string]> = [
    [learned.steer, 'A / D  steer while airborne'],
    [learned.bounce, 'SPACE  just before contact for a perfect bounce'],
    [learned.dive, 'S  dive to hit harder'],
  ];
  if (hints.every(([done]) => done)) return;

  ctx.save();
  ctx.scale(settings.uiScale, settings.uiScale);
  const scaledWidth = width / settings.uiScale;
  const scaledHeight = height / settings.uiScale;
  ctx.textAlign = 'center';
  let y = scaledHeight * 0.62;
  for (const [done, text] of hints) {
    if (done) continue;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(text, scaledWidth / 2, y);
    ctx.fillText(text, scaledWidth / 2, y);
    y += 22;
  }
  ctx.restore();
}
