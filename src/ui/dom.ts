/**
 * Tiny DOM helpers.
 *
 * Menus, cards and panels are DOM rather than canvas for three concrete reasons:
 * text rendering is sharper and reflows for any UI scale, the browser handles
 * focus and keyboard navigation correctly, and screen readers work. Those are all
 * accessibility requirements from the brief that a canvas UI would fail.
 *
 * The gameplay HUD stays on the canvas, because it has to be pixel-aligned with
 * the arena and updates every frame.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data') || key.startsWith('aria') || key === 'role') node.setAttribute(toKebab(key), String(value));
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function toKebab(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export interface ButtonOptions {
  label: string;
  onClick: () => void;
  className?: string;
  /** Keyboard shortcut hint shown on the button. */
  hint?: string;
  disabled?: boolean;
  title?: string;
  onHover?: () => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const node = el(
    'button',
    {
      class: `bb-btn ${options.className ?? ''}`.trim(),
      type: 'button',
      disabled: options.disabled,
      title: options.title,
    },
    [el('span', { class: 'bb-btn-label', text: options.label }), options.hint ? el('kbd', { text: options.hint }) : null],
  );
  node.addEventListener('click', (event) => {
    event.preventDefault();
    if (options.disabled) return;
    options.onClick();
  });
  if (options.onHover) node.addEventListener('mouseenter', options.onHover);
  return node;
}

export function bar(fraction: number, color: string, label?: string): HTMLElement {
  return el('div', { class: 'bb-bar', role: 'progressbar', ariaValuenow: Math.round(fraction * 100) }, [
    el('div', { class: 'bb-bar-fill', style: `width:${Math.max(0, Math.min(1, fraction)) * 100}%;background:${color}` }),
    label ? el('span', { class: 'bb-bar-label', text: label }) : null,
  ]);
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A labelled section with a heading, used throughout the menus. */
export function section(title: string, children: Array<Node | string | null>, className = ''): HTMLElement {
  return el('section', { class: `bb-section ${className}`.trim() }, [el('h3', { text: title }), ...children]);
}

export function row(children: Array<Node | string | null>, className = ''): HTMLElement {
  return el('div', { class: `bb-row ${className}`.trim() }, children);
}

/** Range control with a live readout; used by every numeric setting. */
export function slider(options: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}): HTMLElement {
  const readout = el('output', { class: 'bb-readout', text: (options.format ?? String)(options.value) });
  const input = el('input', {
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
    ariaLabel: options.label,
  });
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = (options.format ?? String)(value);
    options.onChange(value);
  });
  return el('label', { class: 'bb-field' }, [el('span', { text: options.label }), input, readout]);
}

/**
 * A toggle. The optional hint goes in the tooltip rather than under the label:
 * a settings page with an explanatory paragraph per row reads as a web form, and
 * the labels are written to stand on their own.
 */
export function toggle(options: { label: string; value: boolean; hint?: string; onChange: (value: boolean) => void }): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: options.value, ariaLabel: options.label });
  input.addEventListener('change', () => options.onChange(input.checked));
  return el('label', { class: 'bb-field bb-field-toggle', title: options.hint }, [
    el('span', { text: options.label }),
    input,
  ]);
}

export function select<T extends string>(options: {
  label: string;
  value: T;
  choices: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): HTMLElement {
  const node = el('select', { ariaLabel: options.label });
  for (const choice of options.choices) {
    node.append(el('option', { value: choice.value, text: choice.label, selected: choice.value === options.value }));
  }
  node.addEventListener('change', () => options.onChange(node.value as T));
  return el('label', { class: 'bb-field' }, [el('span', { text: options.label }), node]);
}

/** Formats a duration as m:ss. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${`${total % 60}`.padStart(2, '0')}`;
}

/* ---------------------------------------------------------- motion helpers -- */

/**
 * Whether decorative motion should be skipped.
 *
 * Checks the in-game setting (the root class) as well as the OS preference, the
 * same two sources the stylesheet honours. JavaScript-driven motion - card tilt,
 * count-ups, pick flourishes - has to ask explicitly, because CSS media queries
 * cannot switch it off.
 */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.classList.contains('bb-reduced-motion')) return true;
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * An inline SVG icon from authored markup.
 *
 * Only ever called with the literal glyph strings in this folder, never with
 * player or save data, so building it through innerHTML is safe - and it is the
 * simplest way to get the SVG namespace right. Strokes and fills use
 * currentColor so the icon takes its colour from CSS.
 */
export function svgIcon(markup: string, className = 'bb-icon', viewBox = '0 0 24 24'): HTMLElement {
  return el('span', {
    class: className,
    ariaHidden: 'true',
    html: `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${markup}</svg>`,
  });
}

/** Creates an SVG element in the SVG namespace; `el` cannot, it makes HTML nodes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, children: SVGElement[] = []): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key === 'class' ? 'class' : toKebab(key), String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * Points of a regular star polygon, as an SVG `points` string. Used for the
 * impact starburst and the gear teeth, which are easier to generate than to draw.
 */
export function starPoints(cx: number, cy: number, outer: number, inner: number, spikes: number, rotation = -90): string {
  const out: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = ((rotation + (i * 180) / spikes) * Math.PI) / 180;
    out.push(`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return out.join(' ');
}

/**
 * Counts numeric readouts up from zero, one after another.
 *
 * Only plain integers (optionally signed with "+") are animated; anything
 * formatted - "1.2k", "3:05" - is left alone, since counting through a formatted
 * value would show numbers the game never produced. The final text is always
 * restored exactly, and a timer backs up the frame loop so the real value lands
 * even if animation frames never arrive (a background tab, a test harness).
 */
export function countUp(nodes: HTMLElement[], options: { duration?: number; stagger?: number; delay?: number } = {}): void {
  if (reducedMotion()) return;
  const duration = options.duration ?? 700;
  const stagger = options.stagger ?? 110;
  const delay = options.delay ?? 180;
  const now = (): number => globalThis.performance?.now() ?? Date.now();

  nodes.forEach((node, index) => {
    const final = node.textContent ?? '';
    const match = /^(\+?)(\d+)$/.exec(final);
    if (!match) return;
    const target = Number(match[2]);
    if (target === 0) return;
    const prefix = match[1];
    const startAt = now() + delay + index * stagger;
    let done = false;

    const settle = (): void => {
      if (done) return;
      done = true;
      node.textContent = final;
      node.classList.add('bb-counted');
    };
    const step = (time: number): void => {
      if (done) return;
      const t = Math.min(1, Math.max(0, (time - startAt) / duration));
      // Ease-out cubic: fast climb, gentle landing on the real value.
      const eased = 1 - (1 - t) ** 3;
      node.textContent = `${prefix}${Math.round(target * eased)}`;
      if (t < 1) globalThis.requestAnimationFrame(step);
      else settle();
    };

    node.textContent = `${prefix}0`;
    globalThis.requestAnimationFrame(step);
    globalThis.setTimeout(settle, delay + index * stagger + duration + 300);
  });
}
