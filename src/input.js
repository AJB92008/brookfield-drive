// Keyboard + gamepad input.
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.handlers = new Map();
    this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = false;
    this.anyInput = false;
    addEventListener('keydown', (e) => {
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        const h = this.handlers.get(e.code);
        if (h) h();
      }
      this.keys.add(e.code);
      this.anyInput = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.padPrev = [];
  }

  on(code, fn) { this.handlers.set(code, fn); }

  poll() {
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let handbrake = k.has('Space');

    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() || [] : []; } catch { pads = []; } // blocked in some embeds
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.12) steer = ax;
      const rt = pad.buttons[7]?.value || 0, lt = pad.buttons[6]?.value || 0;
      if (rt > 0.05) throttle = rt;
      if (lt > 0.05) brake = lt;
      if (pad.buttons[0]?.pressed || pad.buttons[1]?.pressed) handbrake = true;
      // edge-triggered buttons: Y = camera, Back = map, X = reset, Start = missions (d-pad picks, A starts
      // or retries, B closes), LB = tow
      const map = { 3: 'KeyC', 8: 'KeyM', 2: 'KeyR', 9: 'KeyN', 12: 'ArrowUp', 13: 'ArrowDown', 0: 'Enter', 1: 'Escape', 4: 'KeyF' };
      for (const [b, code] of Object.entries(map)) {
        const pressed = !!pad.buttons[b]?.pressed;
        if (pressed && !this.padPrev[b]) this.handlers.get(code)?.();
        this.padPrev[b] = pressed;
      }
      if (throttle || brake || steer) this.anyInput = true;
      break;
    }
    // Steering on a keyboard is "the car steers to +-1", which feels twitchy at speed; car.js smooths it.
    this.throttle = throttle; this.brake = brake; this.steer = steer; this.handbrake = handbrake;
  }
}
