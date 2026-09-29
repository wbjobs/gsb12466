/* Canvas 波形渲染：
 *  - 按当前缩放级别自动选择金字塔层（每像素聚合 1~4 个桶，绘制 O(像素宽)）
 *  - 滚轮以光标为锚点缩放，拖拽平移，双击适应全曲
 *  - requestAnimationFrame 合并重绘，避免高频事件导致抖动
 */
(function () {
  'use strict';

  const MIN_VIEW_SECONDS = 0.01;

  // 通用绘制：把 [startSec, startSec+durSec] 的波形画到 ctx 的 w×h 区域
  function drawWaveform(ctx, pyramid, w, h, startSec, durSec, opts) {
    const { levels, sampleRate, duration } = pyramid;
    const samplesPerPixel = (durSec * sampleRate) / w;

    // 选层：最细的、且每桶不超过每像素采样数的层
    let level = levels[0];
    for (const l of levels) {
      if (l.spb <= samplesPerPixel) level = l;
      else break;
    }

    // 背景
    ctx.fillStyle = (opts && opts.bg) || '#10141a';
    ctx.fillRect(0, 0, w, h);

    // 中轴线
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();

    const bucketsPerPixel = samplesPerPixel / level.spb;
    const startBucketFloat = (startSec * sampleRate) / level.spb;
    const totalBuckets = level.min.length;
    const mid = h / 2;
    const amp = h / 2 - 2;

    ctx.fillStyle = (opts && opts.color) || '#4cc38a';
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(startBucketFloat + x * bucketsPerPixel);
      let b1 = Math.floor(startBucketFloat + (x + 1) * bucketsPerPixel);
      if (b1 <= b0) b1 = b0 + 1;
      if (b0 >= totalBuckets) break;

      let lo = Infinity;
      let hi = -Infinity;
      const end = Math.min(b1, totalBuckets);
      for (let b = Math.max(0, b0); b < end; b++) {
        const vLo = level.min[b];
        const vHi = level.max[b];
        if (vLo < lo) lo = vLo;
        if (vHi > hi) hi = vHi;
      }
      if (lo === Infinity) continue;

      const yTop = mid - hi * amp;
      const yBot = mid - lo * amp;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }

    return { level, samplesPerPixel, duration };
  }

  // 时间刻度：挑选“好看”的步长
  const NICE_STEPS = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
  function pickStep(durSec, maxTicks) {
    for (const s of NICE_STEPS) {
      if (durSec / s <= maxTicks) return s;
    }
    return 7200;
  }
  function fmtClock(sec) {
    const s = Math.round(sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mmss = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    return hh > 0 ? hh + ':' + mmss : mmss;
  }

  class WaveformRenderer {
    constructor(canvas, onViewChange) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.pyramid = null;
      this.viewStart = 0;
      this.viewDuration = 1;
      this.onViewChange = onViewChange || function () {};
      this._dirty = false;
      this._drag = null;
      this._bindEvents();
      this._observeResize();
    }

    setData(pyramid) {
      this.pyramid = pyramid;
      this.resetView();
    }

    resetView() {
      this.viewStart = 0;
      this.viewDuration = this.pyramid ? this.pyramid.duration : 1;
      this.requestRender();
    }

    zoom(factor, anchorFrac) {
      if (!this.pyramid) return;
      const dur = this.pyramid.duration;
      const anchor = anchorFrac === undefined ? 0.5 : anchorFrac;
      const t = this.viewStart + anchor * this.viewDuration;
      let nd = this.viewDuration * factor;
      nd = Math.max(MIN_VIEW_SECONDS, Math.min(dur, nd));
      this.viewDuration = nd;
      this.viewStart = t - anchor * nd;
      this._clamp();
      this.requestRender();
    }

    panBy(seconds) {
      if (!this.pyramid) return;
      this.viewStart += seconds;
      this._clamp();
      this.requestRender();
    }

    _clamp() {
      const dur = this.pyramid.duration;
      if (this.viewDuration >= dur) {
        this.viewDuration = dur;
        this.viewStart = 0;
      } else {
        this.viewStart = Math.max(0, Math.min(dur - this.viewDuration, this.viewStart));
      }
    }

    requestRender() {
      if (this._dirty) return; // 合并到下一帧，防止缩放抖动
      this._dirty = true;
      requestAnimationFrame(() => {
        this._dirty = false;
        this._render();
      });
    }

    _render() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = this.canvas.clientWidth;
      const cssH = this.canvas.clientHeight;
      if (!cssW || !cssH) return;
      // 按物理像素取整，避免亚像素抖动
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
        this.canvas.width = pxW;
        this.canvas.height = pxH;
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (!this.pyramid) return;

      const rulerH = 18;
      drawWaveform(ctx, this.pyramid, cssW, cssH - rulerH, this.viewStart, this.viewDuration);
      this._drawRuler(ctx, cssW, cssH, rulerH);
      this.onViewChange(this.viewStart, this.viewDuration, this.pyramid.duration);
    }

    _drawRuler(ctx, w, h, rulerH) {
      const step = pickStep(this.viewDuration, 8);
      ctx.fillStyle = 'rgba(138,148,163,0.9)';
      ctx.font = '10px monospace';
      ctx.textBaseline = 'bottom';
      const secPerPx = this.viewDuration / w;
      const first = Math.ceil(this.viewStart / step) * step;
      for (let t = first; t <= this.viewStart + this.viewDuration; t += step) {
        const x = (t - this.viewStart) / secPerPx;
        ctx.fillRect(x, h - rulerH, 1, 5);
        ctx.fillText(fmtClock(t), x + 3, h - 2);
      }
    }

    _bindEvents() {
      const c = this.canvas;

      c.addEventListener('wheel', (e) => {
        if (!this.pyramid) return;
        e.preventDefault();
        if (e.shiftKey) {
          this.panBy(e.deltaY * this.viewDuration / this.canvas.clientWidth);
          return;
        }
        const rect = c.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        this.zoom(e.deltaY > 0 ? 1.25 : 0.8, frac);
      }, { passive: false });

      c.addEventListener('pointerdown', (e) => {
        if (!this.pyramid) return;
        c.setPointerCapture(e.pointerId);
        this._drag = { x: e.clientX, start: this.viewStart };
        c.classList.add('dragging');
      });
      c.addEventListener('pointermove', (e) => {
        if (!this._drag || !this.pyramid) return;
        const secPerPx = this.viewDuration / c.clientWidth;
        this.viewStart = this._drag.start - (e.clientX - this._drag.x) * secPerPx;
        this._clamp();
        this.requestRender();
      });
      const endDrag = () => {
        this._drag = null;
        c.classList.remove('dragging');
      };
      c.addEventListener('pointerup', endDrag);
      c.addEventListener('pointercancel', endDrag);

      c.addEventListener('dblclick', () => this.resetView());
    }

    _observeResize() {
      if (typeof ResizeObserver === 'undefined') return;
      new ResizeObserver(() => this.requestRender()).observe(this.canvas);
    }
  }

  window.WaveRender = { WaveformRenderer, drawWaveform, fmtClock };
})();
