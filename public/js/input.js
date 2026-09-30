// Pointer, wheel and keyboard handling for the map. The controller only turns
// gestures into intents; the game UI decides what each intent means for the
// selected tool.
//
//   left drag with the inspect tool, right/middle drag, two fingers: pan
//   wheel, pinch, +/-: zoom
//   click: pick a tile (inspect, or apply a one-shot deed)
//   drag with a shaping tool: paint; with the river tool: carve

const CLICK_SLOP = 6;

export class MapInput {
  // intents: { mode(): 'inspect'|'paint'|'river'|'pick', hover(i), pick(i, event),
  //            strokeStart(i), paint(i), strokeEnd(), riverStep(from, to), riverTap(i) }
  constructor(canvas, renderer, grid, intents) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.grid = grid;
    this.intents = intents;
    this.pointers = new Map();
    this.press = null;
    this.pinch = null;
    this.bind();
  }

  local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  tileAt(e) {
    const [x, y] = this.local(e);
    return this.renderer.tileAt(x, y);
  }

  bind() {
    const c = this.canvas;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    c.addEventListener('pointerdown', (e) => this.down(e), { signal });
    window.addEventListener('pointermove', (e) => this.move(e), { signal });
    window.addEventListener('pointerup', (e) => this.up(e), { signal });
    window.addEventListener('pointercancel', (e) => this.cancel(e), { signal });
    c.addEventListener(
      'pointerleave',
      () => {
        if (!this.press) this.intents.hover(-1);
      },
      { signal },
    );
    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [x, y] = this.local(e);
        const scale = e.deltaMode === 1 ? 16 : 1;
        const speed = e.ctrlKey ? 0.01 : 0.0016;
        this.renderer.zoomAt(x, y, Math.exp(-e.deltaY * scale * speed));
      },
      { passive: false, signal },
    );
    c.addEventListener('keydown', (e) => this.key(e), { signal });
  }

  destroy() {
    this.abort.abort();
    this.press = null;
    this.pinch = null;
    this.pointers.clear();
  }

  down(e) {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    this.canvas.focus({ preventScroll: true });
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (synthetic or inactive pointer): the window listeners still work
    }
    if (this.pointers.size === 2) {
      // A second finger turns whatever the first one started into a pinch.
      this.abortPress();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    const tile = this.renderer.tileAt(x, y);
    const panButton = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2);
    const mode = panButton ? 'pan' : this.intents.mode();
    this.press = { id: e.pointerId, x, y, lx: x, ly: y, tile, last: tile, moved: false, mode, shift: e.shiftKey };
    if (mode === 'paint' && tile >= 0) {
      this.intents.strokeStart(tile);
      this.intents.paint(tile);
    } else if (mode === 'river') {
      this.renderer.overlay.path = tile >= 0 ? [tile] : [];
    }
  }

  move(e) {
    const known = this.pointers.get(e.pointerId);
    const [x, y] = this.local(e);
    if (known) {
      known.x = x;
      known.y = y;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.renderer.panBy(mx - this.pinch.mx, my - this.pinch.my);
      if (this.pinch.dist > 10 && dist > 10) this.renderer.zoomAt(mx, my, dist / this.pinch.dist);
      this.pinch = { dist, mx, my };
      return;
    }
    const p = this.press;
    if (!p) {
      if (e.target === this.canvas) this.intents.hover(this.renderer.tileAt(x, y));
      return;
    }
    if (e.pointerId !== p.id) return;
    if (!p.moved && Math.hypot(x - p.x, y - p.y) > CLICK_SLOP) p.moved = true;
    const tile = this.renderer.tileAt(x, y);
    if (p.mode === 'pan' || ((p.mode === 'inspect' || p.mode === 'pick') && p.moved)) {
      this.canvas.classList.add('panning');
      this.renderer.panBy(x - p.lx, y - p.ly);
    } else if (p.mode === 'paint') {
      this.intents.hover(tile);
      if (tile >= 0 && tile !== p.last) {
        const steps = p.last >= 0 ? this.grid().line(p.last, tile).slice(1) : [tile];
        for (const t of steps) this.intents.paint(t);
        p.last = tile;
      }
    } else if (p.mode === 'river') {
      this.intents.hover(tile);
      if (tile >= 0 && tile !== p.last && p.last >= 0) {
        let prev = p.last;
        for (const t of this.grid().line(p.last, tile).slice(1)) {
          this.intents.riverStep(prev, t);
          this.renderer.overlay.path.push(t);
          prev = t;
        }
        p.last = tile;
        this.renderer.requestDraw();
      }
    }
    p.lx = x;
    p.ly = y;
  }

  // The release belongs to the press that started the gesture, wherever the
  // pointer is now.
  up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.press = null;
    this.canvas.classList.remove('panning');
    if (p.mode === 'paint') this.intents.strokeEnd();
    else if (p.mode === 'river') {
      if (this.renderer.overlay.path.length <= 1 && p.tile >= 0) this.intents.riverTap(p.tile);
      this.renderer.overlay.path = [];
      this.renderer.requestDraw();
    } else if (!p.moved && p.mode !== 'pan' && p.tile >= 0) {
      this.intents.pick(p.tile, { shift: p.shift || e.shiftKey });
    }
  }

  cancel(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.press?.id === e.pointerId) this.abortPress();
  }

  abortPress() {
    const p = this.press;
    this.press = null;
    this.canvas.classList.remove('panning');
    if (p?.mode === 'paint') this.intents.strokeEnd();
    this.renderer.overlay.path = [];
  }

  key(e) {
    const step = 90;
    const r = this.renderer;
    switch (e.key) {
      case 'ArrowLeft':
        r.panBy(step, 0);
        break;
      case 'ArrowRight':
        r.panBy(-step, 0);
        break;
      case 'ArrowUp':
        r.panBy(0, step);
        break;
      case 'ArrowDown':
        r.panBy(0, -step);
        break;
      case '+':
      case '=':
        r.zoomAt(r.view.w / 2, r.view.h / 2, 1.25);
        break;
      case '-':
      case '_':
        r.zoomAt(r.view.w / 2, r.view.h / 2, 0.8);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
