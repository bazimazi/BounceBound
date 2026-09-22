/**
 * Procedural audio.
 *
 * Every sound in Bouncebound is synthesised at runtime from oscillators and
 * filtered noise. That is a deliberate design choice rather than an asset
 * shortcut: because the ball's material, speed, angle and combo state are all
 * available at the moment of impact, the *sound itself* can carry gameplay
 * information that a fixed recording could not.
 *
 * Concretely:
 *  - Timbre comes from the surface material. Steel pings, moss thuds, crystal
 *    rings. A player learns what they are bouncing on without looking.
 *  - Pitch rises with the combo tier, so a long chain audibly escalates.
 *  - Impact speed drives amplitude and brightness, so a heavy hit sounds heavy.
 *  - Perfect bounces get a distinct, consonant two-note cue that is impossible to
 *    confuse with an ordinary bounce. This is the main feedback channel for the
 *    game's core skill.
 *
 * A hard voice cap and a per-sound cooldown keep a chain reaction from turning
 * into white noise, which is both unpleasant and unreadable.
 */

import { clamp, clamp01 } from '../core/math';
import type { EventBus } from '../core/events';
import type { GameEvents } from '../sim/gameEvents';
import { ORDER } from '../sim/gameEvents';
import { impactIntensity } from '../sim/impact';
import { getMaterial, type Material } from '../sim/materials';
import { comboTier } from '../sim/combo';
import type { Settings } from '../meta/settings';
import type { BiomeDef } from '../content/biomes';

const MAX_VOICES = 22;
/** Minimum seconds between two sounds of the same kind. */
const COOLDOWNS: Record<string, number> = {
  bounce: 0.028,
  enemyHit: 0.035,
  shard: 0.045,
  arc: 0.05,
  explosion: 0.06,
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private voices = 0;
  private lastPlayed = new Map<string, number>();
  private settings: Settings;
  /** Musical intensity 0..1, driven by combo and threat. */
  private intensity = 0;
  private targetIntensity = 0;
  private ambientOsc: OscillatorNode | null = null;
  private ambientGain: GainNode | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private currentBiome: BiomeDef | null = null;
  private started = false;
  private muted = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /**
   * Browsers require a user gesture before audio can start, so this is called
   * from the first input event rather than at construction.
   */
  start(): void {
    if (this.started) return;
    try {
      const Ctor: typeof AudioContext =
        (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
        (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.started = true;
    } catch {
      return;
    }

    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    // Gentle limiting: chain reactions can stack a dozen voices in one frame, and
    // without this the mix clips into a harsh crackle exactly when the game is at
    // its most exciting.
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.14;

    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(ctx.destination);
    this.applyVolumes();

    this.noiseBuffer = this.makeNoiseBuffer();
    this.startAmbient();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.applyVolumes();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.master || !this.musicBus || !this.sfxBus) return;
    const master = this.muted ? 0 : this.settings.masterVolume;
    this.master.gain.value = master;
    this.musicBus.gain.value = this.settings.musicVolume;
    this.sfxBus.gain.value = this.settings.sfxVolume;
  }

  private makeNoiseBuffer(): AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let value = 0;
    for (let i = 0; i < length; i++) {
      // Slightly low-passed noise: pure white noise reads as a hiss rather than
      // as an impact.
      value = value * 0.4 + (Math.random() * 2 - 1) * 0.6;
      data[i] = value;
    }
    return buffer;
  }

  private canPlay(kind: string): boolean {
    if (!this.ctx || !this.sfxBus) return false;
    if (this.voices >= MAX_VOICES) return false;
    const cooldown = COOLDOWNS[kind];
    if (cooldown !== undefined) {
      const now = this.ctx.currentTime;
      const last = this.lastPlayed.get(kind) ?? -1;
      if (now - last < cooldown) return false;
      this.lastPlayed.set(kind, now);
    }
    return true;
  }

  private trackVoice(node: AudioScheduledSourceNode, duration: number): void {
    this.voices++;
    node.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
    // Fallback in case onended does not fire (some browsers with stopped contexts).
    setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
    }, (duration + 0.2) * 1000);
  }

  /* ------------------------------------------------------------ primitives -- */

  private tone(options: {
    frequency: number;
    type?: OscillatorType;
    duration: number;
    gain: number;
    attack?: number;
    /** Frequency at the end of the sound, for pitch sweeps. */
    endFrequency?: number;
    filter?: number;
    detune?: number;
    pan?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = options.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(20, options.frequency), now);
    if (options.endFrequency !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.endFrequency), now + options.duration);
    }
    if (options.detune) osc.detune.value = options.detune;

    const gain = ctx.createGain();
    const attack = options.attack ?? 0.004;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(options.gain, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    let node: AudioNode = gain;
    if (options.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = options.filter;
      gain.connect(filter);
      node = filter;
    }
    if (options.pan !== undefined && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(options.pan, -1, 1);
      node.connect(panner);
      node = panner;
    }
    node.connect(this.sfxBus);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + options.duration + 0.02);
    this.trackVoice(osc, options.duration);
  }

  private noise(options: { duration: number; gain: number; filter: number; filterEnd?: number; pan?: number; type?: BiquadFilterType }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuffer) return;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = options.type ?? 'bandpass';
    filter.frequency.setValueAtTime(options.filter, now);
    if (options.filterEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, options.filterEnd), now + options.duration);
    }
    filter.Q.value = 1.1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(options.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter);
    filter.connect(gain);
    let node: AudioNode = gain;
    if (options.pan !== undefined && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(options.pan, -1, 1);
      gain.connect(panner);
      node = panner;
    }
    node.connect(this.sfxBus);
    source.start(now);
    source.stop(now + options.duration + 0.02);
    this.trackVoice(source, options.duration);
  }

  /* ---------------------------------------------------------------- ambient -- */

  setBiome(biome: BiomeDef): void {
    this.currentBiome = biome;
    if (this.ambientOsc) {
      this.ambientOsc.frequency.value = biome.ambientHz;
    }
  }

  private startAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    // A low drone plus a sparse arpeggio driven by intensity. Deliberately
    // minimal: a busy soundtrack competes with the impact sounds, which are the
    // sounds that actually carry information.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = this.currentBiome?.ambientHz ?? 55;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0.06;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicBus);
    osc.start();
    this.ambientOsc = osc;
    this.ambientGain = gain;

    this.pulseTimer = setInterval(() => this.musicStep(), 260);
  }

  /** One step of the intensity-driven arpeggio. */
  private musicStep(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || this.settings.musicVolume <= 0.001) return;
    this.intensity += (this.targetIntensity - this.intensity) * 0.2;
    if (this.intensity < 0.05) return;

    const root = 110 * 2 ** ((this.currentBiome?.musicRoot ?? 0) / 12);
    // Minor pentatonic degrees: unambiguous, and it stays consonant with the
    // impact cues regardless of which note lands.
    const degrees = [0, 3, 5, 7, 10];
    const octave = this.intensity > 0.65 ? 2 : 1;
    const degree = degrees[Math.floor(Math.random() * degrees.length)];
    const frequency = root * octave * 2 ** (degree / 12);

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = this.intensity > 0.5 ? 'square' : 'triangle';
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.035 * this.intensity, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900 + this.intensity * 2600;
    osc.connect(gain);
    gain.connect(filter);
    filter.connect(this.musicBus);
    osc.start(now);
    osc.stop(now + 0.28);

    if (this.ambientGain) this.ambientGain.gain.value = 0.05 + this.intensity * 0.05;
  }

  /** Called each frame with the current gameplay intensity. */
  setIntensity(value: number): void {
    this.targetIntensity = clamp01(value);
  }

  dispose(): void {
    if (this.pulseTimer !== null) clearInterval(this.pulseTimer);
    this.pulseTimer = null;
    try {
      this.ambientOsc?.stop();
    } catch {
      // Already stopped.
    }
    this.ambientOsc = null;
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }

  /* ------------------------------------------------------------ event wiring -- */

  install(bus: EventBus<GameEvents>, panOf: (x: number) => number): void {
    bus.on(
      'impactResolved',
      (ctx) => {
        const material = getMaterial(ctx.material);
        const intensity = impactIntensity(ctx);
        const pan = panOf(ctx.px);
        const tier = comboTier(ctx.combo);

        if (ctx.isPerfect) {
          this.perfectBounce(material, tier, ctx.perfectQuality, pan);
        } else if (ctx.enemy) {
          this.enemyHit(intensity, tier, ctx.isCrit, pan);
        } else {
          this.bounce(material, intensity, tier, pan);
        }

        if (ctx.killed) this.kill(intensity, pan);
        for (const effect of ctx.effects) {
          if (effect === 'armor' || effect === 'ward' || effect === 'hardened') this.clang(pan);
          if (effect === 'breach') this.breach(pan);
        }
      },
      { order: ORDER.feedback },
    );

    bus.on(
      'effectRequested',
      (request) => {
        const pan = panOf(request.x);
        switch (request.kind) {
          case 'explosion':
            this.explosion(pan);
            break;
          case 'arc':
            this.arc(pan);
            break;
          case 'dash':
          case 'airBounce':
            this.whoosh(pan);
            break;
          case 'phase':
          case 'foldIn':
          case 'foldOut':
          case 'teleportIn':
          case 'teleportOut':
            this.warp(pan);
            break;
          case 'shieldBreak':
            this.shieldBreak(pan);
            break;
          case 'bossPhase':
            this.bossPhase();
            break;
          case 'crusherSlam':
            this.slam(pan);
            break;
          case 'crusherWarn':
            this.warn(pan);
            break;
          case 'singularity':
            this.singularity(pan);
            break;
          default:
            break;
        }
      },
      { order: ORDER.feedback },
    );

    bus.on('pickupCollected', ({ kind, x }) => {
      const pan = panOf(x);
      if (kind === 'shard') this.shard(pan);
      else this.reward(pan);
    });

    bus.on('ballDamaged', (payload) => {
      if (payload.blocked) this.shieldBreak(panOf(payload.x));
      else this.hurt();
    });

    bus.on('ballDeath', () => this.death());
    bus.on('roomCleared', () => this.roomClear());
    bus.on('upgradeGained', () => this.upgrade());
    bus.on('synergyActivated', () => this.synergy());
    bus.on('achievementUnlocked', () => this.unlock());
    bus.on('comboChanged', ({ value }) => {
      const tier = comboTier(value);
      if (tier > 0 && value % 5 === 0) this.comboStep(tier);
    });
    bus.on('bossDefeated', () => this.bossDefeated());
  }

  /* -------------------------------------------------------------- the sounds -- */

  /** Material-flavoured impact. This is the sound the player hears most. */
  bounce(material: Material, intensity: number, tier: number, pan: number): void {
    if (!this.canPlay('bounce')) return;
    const semitones = material.pitch + tier * 2;
    const base = 220 * 2 ** (semitones / 12);
    const gain = 0.06 + intensity * 0.16;

    switch (material.timbre) {
      case 'ping':
        this.tone({ frequency: base * 2, type: 'sine', duration: 0.16, gain, endFrequency: base * 1.5, pan });
        this.tone({ frequency: base * 3.01, type: 'sine', duration: 0.1, gain: gain * 0.4, pan });
        break;
      case 'glass':
        this.tone({ frequency: base * 3, type: 'triangle', duration: 0.2, gain: gain * 0.9, pan });
        this.tone({ frequency: base * 4.8, type: 'sine', duration: 0.13, gain: gain * 0.35, pan });
        break;
      case 'knock':
        this.tone({ frequency: base, type: 'triangle', duration: 0.09, gain, endFrequency: base * 0.6, pan });
        this.noise({ duration: 0.05, gain: gain * 0.5, filter: 900, pan });
        break;
      case 'soft':
        this.tone({ frequency: base * 0.75, type: 'sine', duration: 0.1, gain: gain * 0.8, endFrequency: base * 0.45, filter: 700, pan });
        break;
      case 'boom':
        this.tone({ frequency: base * 0.6, type: 'sine', duration: 0.24, gain: gain * 1.2, endFrequency: base * 0.3, pan });
        this.noise({ duration: 0.1, gain: gain * 0.5, filter: 300, pan });
        break;
      default:
        this.tone({ frequency: base, type: 'sine', duration: 0.11, gain, endFrequency: base * 0.55, pan });
        this.noise({ duration: 0.04, gain: gain * 0.35, filter: 600, pan });
        break;
    }
  }

  /**
   * The Perfect Bounce cue: a rising perfect fifth with a bright transient.
   *
   * It is intentionally the most distinctive sound in the game. A player should be
   * able to tell whether they nailed the timing with their eyes closed.
   */
  perfectBounce(material: Material, tier: number, quality: number, pan: number): void {
    const base = 330 * 2 ** ((material.pitch + tier * 2) / 24);
    const gain = 0.1 + quality * 0.1;
    this.tone({ frequency: base, type: 'sine', duration: 0.1, gain, endFrequency: base * 1.5, pan });
    this.tone({ frequency: base * 1.5, type: 'sine', duration: 0.26, gain: gain * 0.8, attack: 0.002, pan });
    this.tone({ frequency: base * 3, type: 'triangle', duration: 0.14, gain: gain * 0.3, pan });
    this.noise({ duration: 0.05, gain: 0.05 + quality * 0.05, filter: 5200, filterEnd: 1800, pan });
  }

  enemyHit(intensity: number, tier: number, crit: boolean, pan: number): void {
    if (!this.canPlay('enemyHit')) return;
    const base = 160 * 2 ** (tier / 12);
    this.tone({
      frequency: crit ? base * 1.6 : base,
      type: 'square',
      duration: 0.09,
      gain: 0.08 + intensity * 0.12,
      endFrequency: base * 0.5,
      filter: crit ? 4200 : 2400,
      pan,
    });
    this.noise({ duration: 0.07, gain: 0.07 + intensity * 0.08, filter: crit ? 3200 : 1500, filterEnd: 500, pan });
  }

  kill(intensity: number, pan: number): void {
    this.tone({ frequency: 520, type: 'triangle', duration: 0.2, gain: 0.07 + intensity * 0.05, endFrequency: 180, pan });
    this.noise({ duration: 0.16, gain: 0.08, filter: 2200, filterEnd: 300, pan });
  }

  clang(pan: number): void {
    this.tone({ frequency: 880, type: 'square', duration: 0.13, gain: 0.07, endFrequency: 760, filter: 5200, pan });
    this.tone({ frequency: 1320, type: 'sine', duration: 0.08, gain: 0.04, pan });
  }

  breach(pan: number): void {
    this.tone({ frequency: 220, type: 'sawtooth', duration: 0.34, gain: 0.1, endFrequency: 660, filter: 3200, pan });
    this.noise({ duration: 0.22, gain: 0.09, filter: 900, filterEnd: 4200, pan });
  }

  explosion(pan: number): void {
    if (!this.canPlay('explosion')) return;
    this.tone({ frequency: 90, type: 'sine', duration: 0.38, gain: 0.16, endFrequency: 36, pan });
    this.noise({ duration: 0.3, gain: 0.14, filter: 1400, filterEnd: 160, type: 'lowpass', pan });
  }

  arc(pan: number): void {
    if (!this.canPlay('arc')) return;
    this.noise({ duration: 0.12, gain: 0.07, filter: 3400, filterEnd: 7200, pan });
    this.tone({ frequency: 1400, type: 'sawtooth', duration: 0.07, gain: 0.035, endFrequency: 2600, filter: 6000, pan });
  }

  whoosh(pan: number): void {
    this.noise({ duration: 0.2, gain: 0.08, filter: 500, filterEnd: 2600, pan });
  }

  warp(pan: number): void {
    this.tone({ frequency: 180, type: 'sine', duration: 0.26, gain: 0.08, endFrequency: 1400, pan });
  }

  shieldBreak(pan: number): void {
    this.tone({ frequency: 660, type: 'triangle', duration: 0.24, gain: 0.1, endFrequency: 240, filter: 3200, pan });
    this.noise({ duration: 0.14, gain: 0.07, filter: 2600, filterEnd: 700, pan });
  }

  hurt(): void {
    this.tone({ frequency: 150, type: 'sawtooth', duration: 0.3, gain: 0.14, endFrequency: 62, filter: 900 });
    this.noise({ duration: 0.2, gain: 0.1, filter: 700, filterEnd: 180, type: 'lowpass' });
  }

  death(): void {
    this.tone({ frequency: 220, type: 'sawtooth', duration: 1.5, gain: 0.16, endFrequency: 40, filter: 800 });
    this.noise({ duration: 1.2, gain: 0.1, filter: 900, filterEnd: 90, type: 'lowpass' });
  }

  shard(pan: number): void {
    if (!this.canPlay('shard')) return;
    this.tone({ frequency: 1180, type: 'sine', duration: 0.07, gain: 0.04, endFrequency: 1560, pan });
  }

  reward(pan: number): void {
    // A major arpeggio: unmistakably positive, and distinct from the perfect cue.
    for (const [index, ratio] of [1, 1.25, 1.5, 2].entries()) {
      setTimeout(() => this.tone({ frequency: 520 * ratio, type: 'triangle', duration: 0.24, gain: 0.07, pan }), index * 55);
    }
  }

  roomClear(): void {
    for (const [index, ratio] of [1, 1.335, 1.5].entries()) {
      setTimeout(() => this.tone({ frequency: 392 * ratio, type: 'sine', duration: 0.4, gain: 0.08 }), index * 90);
    }
  }

  upgrade(): void {
    for (const [index, ratio] of [1, 1.5, 2, 2.5].entries()) {
      setTimeout(() => this.tone({ frequency: 440 * ratio, type: 'triangle', duration: 0.3, gain: 0.07 }), index * 70);
    }
  }

  synergy(): void {
    // A wide, bright chord. Discovering a synergy should sound like a discovery.
    for (const ratio of [1, 1.5, 2, 3, 4]) {
      this.tone({ frequency: 330 * ratio, type: 'sine', duration: 0.9, gain: 0.05 });
    }
    this.noise({ duration: 0.5, gain: 0.05, filter: 1200, filterEnd: 6000 });
  }

  unlock(): void {
    for (const [index, ratio] of [1, 1.25, 1.5, 1.875, 2.5].entries()) {
      setTimeout(() => this.tone({ frequency: 392 * ratio, type: 'triangle', duration: 0.45, gain: 0.07 }), index * 80);
    }
  }

  comboStep(tier: number): void {
    this.tone({ frequency: 520 * 2 ** (tier / 12), type: 'sine', duration: 0.14, gain: 0.05 + tier * 0.008 });
  }

  warn(pan: number): void {
    this.tone({ frequency: 320, type: 'square', duration: 0.18, gain: 0.07, endFrequency: 240, filter: 1200, pan });
  }

  slam(pan: number): void {
    this.tone({ frequency: 70, type: 'sine', duration: 0.5, gain: 0.2, endFrequency: 30, pan });
    this.noise({ duration: 0.4, gain: 0.16, filter: 900, filterEnd: 90, type: 'lowpass', pan });
  }

  singularity(pan: number): void {
    this.tone({ frequency: 1200, type: 'sine', duration: 0.8, gain: 0.09, endFrequency: 60, pan });
    this.noise({ duration: 0.7, gain: 0.08, filter: 4000, filterEnd: 120, type: 'lowpass', pan });
  }

  bossPhase(): void {
    this.tone({ frequency: 110, type: 'sawtooth', duration: 1.1, gain: 0.16, endFrequency: 55, filter: 700 });
    for (const ratio of [1, 1.19, 1.5]) {
      this.tone({ frequency: 220 * ratio, type: 'square', duration: 0.9, gain: 0.05, filter: 1400 });
    }
  }

  bossDefeated(): void {
    for (const [index, ratio] of [1, 1.25, 1.5, 2, 2.5, 3].entries()) {
      setTimeout(() => this.tone({ frequency: 330 * ratio, type: 'triangle', duration: 0.7, gain: 0.08 }), index * 110);
    }
  }

  /** UI click, used by menus. */
  click(): void {
    this.tone({ frequency: 760, type: 'square', duration: 0.045, gain: 0.04, filter: 3200 });
  }

  hover(): void {
    this.tone({ frequency: 1040, type: 'sine', duration: 0.03, gain: 0.02 });
  }

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get voiceCount(): number {
    return this.voices;
  }
}
