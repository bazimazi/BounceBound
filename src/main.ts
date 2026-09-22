/**
 * Entry point.
 *
 * Deliberately thin: it finds the canvas, starts the game, and exposes a handle on
 * `window` for debugging from the console. Everything else lives behind `Game`.
 */

import './style.css';
import { createGame, type Game } from './game/game';

declare global {
  // eslint-disable-next-line no-var
  var bouncebound: Game | undefined;
}

function boot(): void {
  const canvas = document.getElementById('game');
  const overlay = document.getElementById('overlay');
  if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
    document.body.textContent = 'Bouncebound could not find its canvas.';
    return;
  }

  try {
    const game = createGame(canvas, overlay);
    globalThis.bouncebound = game;
  } catch (error) {
    // A hard failure at boot is almost always a missing browser capability, so say
    // so rather than leaving a black rectangle.
    const message = error instanceof Error ? error.message : String(error);
    overlay.classList.add('bb-overlay-active');
    overlay.innerHTML = `<div class="bb-panel"><h2>Unable to start</h2><p class="bb-sub">${message}</p><p class="bb-note">Bouncebound needs a browser with Canvas 2D support.</p></div>`;
    console.error(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
