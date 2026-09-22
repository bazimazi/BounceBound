/**
 * Debug and balance tooling.
 *
 * Toggled with the backtick key. Everything here exists to make a balance question
 * answerable in seconds rather than in a play session: what did the generator
 * actually build, what is the collision solver seeing, where is damage coming
 * from, and what happens if this build had one more piece.
 *
 * The overlay is drawn in two layers - world space for collision and trajectory
 * visualisation, screen space for the readouts - and it never affects simulation
 * state unless a command is explicitly invoked.
 */

import { TAU, formatNumber } from '../core/math';
import { describeImpact, type ImpactContext } from '../sim/impact';
import { EnemyFlag } from '../sim/entities';
import { hasFlag } from '../sim/enemyLogic';
import { propIsSolid } from '../sim/propLogic';
import { describeBossState } from '../sim/bossLogic';
import { comboMultiplier, momentumMultiplier } from '../sim/combo';
import { describeRoom } from '../gen/roomgen';
import { upgradeCatalogue } from '../content/upgrades/index';
import { BOSS_DEFS } from '../content/bosses';
import { ENEMY_DEFS } from '../content/enemies';
import type { Run } from '../run/run';
import type { Profile } from '../meta/profile';
import { roundRect } from '../render/hud';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export class DebugTools {
  enabled = false;
  /** Draw collision shapes, normals and the broad-phase grid. */
  showCollision = false;
  /** Draw the full predicted trajectory and the timing window. */
  showTrajectory = false;
  /** Freeze the simulation, stepping only on demand. */
  paused = false;
  /** One step requested while paused. */
  stepRequested = false;
  /** Slow the simulation for frame-by-frame inspection. */
  slowMotion = false;

  private readonly impactLog: string[] = [];
  private readonly frameTimes: number[] = [];
  private lastMessage = '';
  private messageAt = 0;

  install(run: Run): void {
    run.bus.on(
      'impactResolved',
      (ctx: ImpactContext) => {
        if (!this.enabled) return;
        this.impactLog.push(describeImpact(ctx));
        if (this.impactLog.length > 14) this.impactLog.shift();
      },
      { order: 500, group: 'debug' },
    );
  }

  recordFrame(ms: number): void {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
  }

  message(text: string): void {
    this.lastMessage = text;
    this.messageAt = Date.now();
  }

  /* --------------------------------------------------------------- commands -- */

  /**
   * Keyboard commands, active only while the overlay is open. Deliberately
   * single-key: a debug tool that takes three keystrokes does not get used.
   */
  handleKey(code: string, run: Run | null, profile: Profile): boolean {
    if (!this.enabled) {
      return false;
    }
    switch (code) {
      case 'Digit1':
        this.showCollision = !this.showCollision;
        this.message(`collision overlay ${this.showCollision ? 'on' : 'off'}`);
        return true;
      case 'Digit2':
        this.showTrajectory = !this.showTrajectory;
        this.message(`trajectory overlay ${this.showTrajectory ? 'on' : 'off'}`);
        return true;
      case 'Digit3':
        this.paused = !this.paused;
        this.message(this.paused ? 'simulation frozen (period to step)' : 'simulation running');
        return true;
      case 'Period':
        this.stepRequested = true;
        return true;
      case 'Digit4':
        this.slowMotion = !this.slowMotion;
        this.message(`slow motion ${this.slowMotion ? 'on' : 'off'}`);
        return true;
      case 'KeyG':
        if (run) {
          run.shards += 250;
          this.message('+250 shards');
        }
        return true;
      case 'KeyE':
        profile.addCurrency('echoes', 200);
        profile.flush();
        this.message('+200 echoes');
        return true;
      case 'KeyH':
        if (run) {
          run.world.healBall(9999);
          run.world.ball.shield += 3;
          this.message('restored and shielded');
        }
        return true;
      case 'KeyK':
        if (run) {
          for (const enemy of [...run.world.enemies]) {
            if (!enemy.dead) run.world.killEnemy(enemy, 'other', null);
          }
          this.message('room cleared');
        }
        return true;
      case 'KeyU':
        if (run) {
          // Inject a random offerable upgrade: the fastest way to test a build.
          const catalogue = upgradeCatalogue();
          const candidate = catalogue[Math.floor(Math.random() * catalogue.length)];
          if (run.build.add(candidate.id)) this.message(`granted ${candidate.name}`);
        }
        return true;
      case 'KeyB':
        if (run) {
          const boss = BOSS_DEFS[Math.floor(Math.random() * BOSS_DEFS.length)];
          run.world.spawnEnemyById(boss.id, run.world.width / 2, run.world.height * 0.38);
          this.message(`spawned ${boss.name}`);
        }
        return true;
      case 'KeyN':
        if (run) {
          const def = ENEMY_DEFS[Math.floor(Math.random() * ENEMY_DEFS.length)];
          run.world.spawnEnemyById(def.id, run.world.ball.x + 180, run.world.height * 0.4);
          this.message(`spawned ${def.name}`);
        }
        return true;
      case 'KeyI':
        if (run) this.message(describeRoom(run.currentRoom));
        return true;
      case 'KeyP':
        profile.wipe();
        this.message('profile reset');
        return true;
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------- drawing -- */

  /** World-space overlay: collision geometry, normals, prediction. */
  drawWorld(ctx: CanvasRenderingContext2D, run: Run): void {
    if (!this.enabled) return;
    const world = run.world;

    if (this.showCollision) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#00ff88';
      ctx.globalAlpha = 0.75;
      for (const prop of world.props) {
        if (prop.destroyed) continue;
        ctx.strokeStyle = propIsSolid(prop) ? '#00ff88' : '#ffcc00';
        const shape = prop.shape;
        ctx.beginPath();
        if (shape.kind === 'aabb') {
          ctx.rect(shape.x - shape.halfW, shape.y - shape.halfH, shape.halfW * 2, shape.halfH * 2);
        } else if (shape.kind === 'circle') {
          ctx.arc(shape.x, shape.y, shape.radius, 0, TAU);
        } else if (shape.kind === 'poly') {
          const v = shape.worldVerts;
          ctx.moveTo(v[0], v[1]);
          for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i], v[i + 1]);
          ctx.closePath();
        } else {
          ctx.moveTo(shape.x1, shape.y1);
          ctx.lineTo(shape.x2, shape.y2);
        }
        ctx.stroke();
      }

      // Enemy collision shapes plus their armour normal, which is the thing most
      // worth verifying visually.
      for (const enemy of world.enemies) {
        if (enemy.dead) continue;
        ctx.strokeStyle = hasFlag(enemy, EnemyFlag.Boss) ? '#ff00cc' : '#ff4d6a';
        ctx.beginPath();
        if (enemy.shape.kind === 'circle') {
          ctx.arc(enemy.shape.x, enemy.shape.y, enemy.shape.radius, 0, TAU);
        } else {
          const v = enemy.shape.worldVerts;
          ctx.moveTo(v[0], v[1]);
          for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i], v[i + 1]);
          ctx.closePath();
        }
        ctx.stroke();
        if (enemy.armorArc > 0) {
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(enemy.x, enemy.y);
          ctx.lineTo(enemy.x + Math.cos(enemy.armorAngle) * (enemy.radius + 24), enemy.y + Math.sin(enemy.armorAngle) * (enemy.radius + 24));
          ctx.stroke();
        }
      }

      // The ball's collision radius and velocity vector.
      const ball = world.ball;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = '#00ffff';
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(ball.x + ball.vx * 0.12, ball.y + ball.vy * 0.12);
      ctx.stroke();
      ctx.restore();
    }

    if (this.showTrajectory && world.predictedPath.length >= 4) {
      ctx.save();
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(world.predictedPath[0], world.predictedPath[1]);
      for (let i = 2; i < world.predictedPath.length; i += 2) {
        ctx.lineTo(world.predictedPath[i], world.predictedPath[i + 1]);
      }
      ctx.stroke();
      for (let i = 0; i < world.predictedPath.length; i += 2) {
        ctx.fillStyle = '#ffcc00';
        ctx.fillRect(world.predictedPath[i] - 1.5, world.predictedPath[i + 1] - 1.5, 3, 3);
      }
      if (world.prediction.valid) {
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(world.prediction.x, world.prediction.y);
        ctx.lineTo(world.prediction.x + world.prediction.nx * 30, world.prediction.y + world.prediction.ny * 30);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Screen-space readouts. */
  drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, run: Run | null, profile: Profile): void {
    if (!this.enabled) return;
    const lines: string[] = [];

    const avg = this.frameTimes.length > 0 ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length : 0;
    const worst = this.frameTimes.length > 0 ? Math.max(...this.frameTimes) : 0;
    lines.push(`frame avg ${avg.toFixed(2)}ms  worst ${worst.toFixed(2)}ms  (${(1000 / Math.max(0.01, avg)).toFixed(0)} fps)`);

    if (run) {
      const world = run.world;
      const stats = run.stats();
      lines.push('');
      lines.push(`seed ${run.seed}   node ${run.currentNode.id}   depth ${run.currentNode.depth}`);
      lines.push(describeRoom(run.currentRoom));
      lines.push(
        `entities  enemies ${world.enemies.length}  props ${world.props.length}  proj ${world.projectiles.length}  fields ${world.fields.length}  pickups ${world.pickups.length}`,
      );
      lines.push(
        `ball  pos ${world.ball.x.toFixed(0)},${world.ball.y.toFixed(0)}  vel ${Math.hypot(world.ball.vx, world.ball.vy).toFixed(0)}  chain ${world.ball.chain}  arm ${world.ball.armState}`,
      );
      lines.push(
        `combo ${world.combo.value} (x${comboMultiplier(world.combo, stats).toFixed(2)})  momentum x${momentumMultiplier(
          Math.hypot(world.ball.vx, world.ball.vy),
          stats,
        ).toFixed(2)}  timeScale ${world.timeScaleRequest.toFixed(2)}`,
      );
      lines.push(
        `stats  dmg ${stats.damage.toFixed(1)}  crit ${(stats.critChance * 100).toFixed(0)}%x${stats.critMult.toFixed(1)}  window ${stats.perfectWindow.toFixed(
          3,
        )}s  radius ${stats.radius.toFixed(1)}`,
      );
      lines.push(
        `run  impacts ${run.telemetry.impacts}  perfect ${run.telemetry.perfectBounces}  dealt ${formatNumber(
          run.telemetry.damageDealt,
        )}  taken ${formatNumber(run.telemetry.damageTaken)}`,
      );

      const effects = Object.entries(run.telemetry.damageByEffect).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (effects.length > 0) {
        lines.push(`damage by effect  ${effects.map(([k, v]) => `${k} ${formatNumber(v)}`).join('  ')}`);
      }

      for (const enemy of world.enemies) {
        if (hasFlag(enemy, EnemyFlag.Boss) && enemy.parentId === 0) lines.push(`boss  ${describeBossState(enemy)}`);
      }

      if (this.impactLog.length > 0) {
        lines.push('');
        lines.push('recent impacts:');
        for (const entry of this.impactLog) lines.push(`  ${entry}`);
      }
    }

    lines.push('');
    lines.push(`echoes ${profile.balance('echoes')}  granted ${profile.data.granted.length}  achievements ${Object.keys(profile.data.achievements).length}`);
    lines.push('1 collision  2 trajectory  3 freeze  . step  4 slow-mo');
    lines.push('G shards  E echoes  H heal  K clear  U upgrade  N enemy  B boss  I room  P wipe profile');

    ctx.save();
    ctx.font = `11px ${MONO}`;
    const lineHeight = 14;
    const panelWidth = 640;
    const panelHeight = lines.length * lineHeight + 20;
    ctx.fillStyle = 'rgba(4,6,10,0.85)';
    roundRect(ctx, 12, 12, panelWidth, panelHeight, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,255,136,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    for (const [index, line] of lines.entries()) {
      ctx.fillStyle = line.startsWith('  ') ? 'rgba(180,255,220,0.75)' : '#9effc8';
      ctx.fillText(line, 24, 30 + index * lineHeight);
    }

    if (this.lastMessage && Date.now() - this.messageAt < 2600) {
      ctx.font = `700 14px ${MONO}`;
      ctx.fillStyle = '#ffcc00';
      ctx.textAlign = 'center';
      ctx.fillText(this.lastMessage, width / 2, height - 24);
    }
    ctx.restore();
  }
}
