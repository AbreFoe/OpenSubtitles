// Звуковая дорожка + блоки субтитров. Колесо — прокрутка, Ctrl+колесо — масштаб.

import { fmtShort, plainText } from './formats.js';

const RULER = 18, OVERVIEW = 10, EDGE = 6;
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

export class Timeline {
  constructor(canvas, cb) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = cb; // { cues(), selectedId(), field(), time(), onSeek, onSelectCue, onCueEdit, onSelection }
    this.peaks = new Uint8Array(0);
    this.rate = 100;
    this.duration = 0;
    this.view = 0;       // секунда у левого края
    this.pps = 80;       // пикселей на секунду
    this.selection = null;
    this.drag = null;
    this.readColors();
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('mousedown', e => this.down(e));
    window.addEventListener('mousemove', e => this.move(e));
    window.addEventListener('mouseup', e => this.up(e));
    canvas.addEventListener('mousemove', e => this.hover(e));
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => {
      const hit = this.hit(this.pos(e));
      if (hit) this.cb.onSeek(hit.cue.start, true);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { this.readColors(); this.draw(); });
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    this.c = {
      bg: v('--tl-bg'), wave: v('--tl-wave'), ruler: v('--tl-ruler'), text: v('--muted'),
      cue: v('--tl-cue'), cueSel: v('--tl-cue-sel'), edge: v('--accent'), sel: v('--tl-sel'),
      head: v('--tl-head'), cueText: v('--text'),
    };
  }

  setAudio(peaks, rate, duration) {
    this.peaks = peaks; this.rate = rate; this.duration = duration;
    this.view = 0;
    this.fitZoom();
  }

  setDuration(d) { if (d && Math.abs(d - this.duration) > 0.5) { this.duration = d; this.draw(); } }

  fitZoom() {
    const w = this.cv.clientWidth || 800;
    this.pps = Math.max(2, Math.min(100, w / Math.max(5, Math.min(this.duration || 60, 120))));
    this.draw();
  }

  get width() { return this.cv.clientWidth; }
  get height() { return this.cv.clientHeight; }
  x2t(x) { return this.view + x / this.pps; }
  t2x(t) { return (t - this.view) * this.pps; }
  pos(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  clampView() {
    const span = this.width / this.pps;
    this.view = Math.max(0, Math.min(this.view, Math.max(0, this.duration - span * 0.9)));
  }

  zoom(factor, x = this.width / 2) {
    const t = this.x2t(x);
    this.pps = Math.max(0.5, Math.min(600, this.pps * factor));
    this.view = t - x / this.pps;
    this.clampView();
    this.draw();
  }

  follow(t) { // держим курсор воспроизведения в кадре
    const span = this.width / this.pps;
    if (t < this.view || t > this.view + span * 0.92) {
      this.view = t - span * 0.1;
      this.clampView();
    }
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return this.zoom(e.deltaY < 0 ? 1.25 : 0.8, this.pos(e).x);
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.view += d / this.pps * 0.8;
    this.clampView();
    this.draw();
  }

  hit({ x, y }) {
    if (y < RULER || y > this.height - OVERVIEW) return null;
    const cues = this.cb.cues(), sel = this.cb.selectedId();
    const order = [...cues].sort((a, b) => (b.id === sel) - (a.id === sel));
    for (const cue of order) {
      const x1 = this.t2x(cue.start), x2 = this.t2x(cue.end);
      if (x < x1 - EDGE || x > x2 + EDGE) continue;
      if (Math.abs(x - x1) <= EDGE && x2 - x1 > EDGE * 2 || x < x1) return { cue, mode: 'start' };
      if (Math.abs(x - x2) <= EDGE || x > x2) return { cue, mode: 'end' };
      return { cue, mode: 'move' };
    }
    return null;
  }

  hover(e) {
    if (this.drag) return;
    const p = this.pos(e);
    if (p.y > this.height - OVERVIEW) { this.cv.style.cursor = 'pointer'; return; }
    const h = this.hit(p);
    this.cv.style.cursor = !h ? 'text' : h.mode === 'move' ? 'grab' : 'ew-resize';
  }

  down(e) {
    if (e.button !== 0) return;
    const p = this.pos(e);
    if (p.y > this.height - OVERVIEW) {
      this.drag = { mode: 'overview' };
      this.overviewTo(p.x);
      return;
    }
    const h = this.hit(p);
    if (h) {
      this.cb.onSelectCue(h.cue.id);
      this.drag = { mode: h.mode, id: h.cue.id, x0: p.x, s0: h.cue.start, e0: h.cue.end, moved: false };
    } else {
      this.drag = { mode: 'range', x0: p.x, t0: this.x2t(p.x) };
    }
  }

  overviewTo(x) {
    const span = this.width / this.pps;
    this.view = x / this.width * this.duration - span / 2;
    this.clampView();
    this.draw();
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const p = this.pos(e);
    if (d.mode === 'overview') return this.overviewTo(p.x);
    const dt = (p.x - d.x0) / this.pps;
    if (d.mode === 'range') {
      if (Math.abs(p.x - d.x0) < 4) return;
      const t = Math.max(0, Math.min(this.duration || Infinity, this.x2t(p.x)));
      this.selection = { a: Math.min(d.t0, t), b: Math.max(d.t0, t) };
      this.cb.onSelection(this.selection);
      return this.draw();
    }
    if (!d.moved && Math.abs(p.x - d.x0) < 3) return;
    if (!d.moved) { d.moved = true; this.cb.onCueEdit(d.id, null, null, 'begin'); }
    let s = d.s0, en = d.e0;
    if (d.mode === 'move') { s = Math.max(0, d.s0 + dt); en = s + (d.e0 - d.s0); }
    if (d.mode === 'start') s = Math.max(0, Math.min(d.e0 - 0.1, d.s0 + dt));
    if (d.mode === 'end') en = Math.max(d.s0 + 0.1, d.e0 + dt);
    this.cb.onCueEdit(d.id, s, en, 'drag');
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.mode === 'range') {
      const p = this.pos(e);
      if (Math.abs(p.x - d.x0) < 4) {
        this.selection = null;
        this.cb.onSelection(null);
        this.cb.onSeek(Math.max(0, d.t0));
      }
      this.draw();
    } else if (d.mode !== 'overview') {
      if (d.moved) this.cb.onCueEdit(d.id, null, null, 'end');
      else this.cb.onSeek(this.x2t(d.x0));
    }
  }

  draw() {
    const cv = this.cv, dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const g = this.ctx, c = this.c;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.bg; g.fillRect(0, 0, w, h);
    const top = RULER, bottom = h - OVERVIEW, mid = (top + bottom) / 2, amp = (bottom - top) / 2 - 2;

    // волна
    g.fillStyle = c.wave;
    const n = this.peaks.length;
    if (n) {
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor(this.x2t(x) * this.rate), i1 = Math.max(i0 + 1, Math.floor(this.x2t(x + 1) * this.rate));
        if (i1 <= 0 || i0 >= n) continue;
        let m = 0;
        for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) if (this.peaks[i] > m) m = this.peaks[i];
        const hh = Math.max(0.5, m / 255 * amp);
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
    } else {
      g.fillRect(0, mid, w, 1);
    }

    // выделение
    if (this.selection) {
      const x1 = this.t2x(this.selection.a), x2 = this.t2x(this.selection.b);
      g.fillStyle = c.sel; g.fillRect(x1, top, x2 - x1, bottom - top);
    }

    // субтитры
    const sel = this.cb.selectedId(), field = this.cb.field();
    g.font = '12px system-ui, sans-serif';
    g.textBaseline = 'top';
    for (const cue of this.cb.cues()) {
      const x1 = this.t2x(cue.start), x2 = this.t2x(cue.end);
      if (x2 < 0 || x1 > w) continue;
      const isSel = cue.id === sel;
      g.fillStyle = isSel ? c.cueSel : c.cue;
      g.fillRect(x1, top, x2 - x1, bottom - top);
      g.fillStyle = c.edge;
      g.fillRect(x1, top, isSel ? 2 : 1, bottom - top);
      g.fillRect(x2 - (isSel ? 2 : 1), top, isSel ? 2 : 1, bottom - top);
      if (x2 - x1 > 24) {
        g.save();
        g.beginPath(); g.rect(x1 + 3, top, x2 - x1 - 6, bottom - top); g.clip();
        g.fillStyle = c.cueText;
        const lines = plainText(cue[field] || cue.text).split('\n');
        lines.forEach((l, k) => g.fillText(l, x1 + 4, top + 4 + k * 14));
        g.restore();
      }
    }

    // линейка
    g.fillStyle = c.ruler; g.fillRect(0, 0, w, RULER);
    const step = STEPS.find(s => s * this.pps >= 70) || 3600;
    g.fillStyle = c.text; g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let t = Math.floor(this.view / step) * step; t < this.x2t(w); t += step) {
      const x = Math.round(this.t2x(t)) + 0.5;
      g.fillRect(x, RULER - 6, 1, 6);
      g.fillText(fmtShort(t).replace(/\.0$/, ''), x + 3, RULER / 2 - 1);
    }

    // мини-карта всего ролика
    g.fillStyle = c.ruler; g.fillRect(0, bottom, w, OVERVIEW);
    if (this.duration) {
      const span = w / this.pps;
      g.fillStyle = c.edge; g.globalAlpha = 0.5;
      g.fillRect(this.view / this.duration * w, bottom + 2, Math.max(4, span / this.duration * w), OVERVIEW - 4);
      g.globalAlpha = 1;
    }

    // курсор воспроизведения
    const hx = Math.round(this.t2x(this.cb.time())) + 0.5;
    if (hx >= 0 && hx <= w) {
      g.fillStyle = c.head;
      g.fillRect(hx - 0.5, 0, 2, bottom);
      if (this.duration) g.fillRect(this.cb.time() / this.duration * w, bottom, 2, OVERVIEW);
    }
  }
}
