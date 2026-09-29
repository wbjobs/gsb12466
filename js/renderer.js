/* renderer.js — Canvas 波形视图：多分辨率渲染、缩放、滚动、总览条、导出 */
(function (global) {
  'use strict';

  var TIME_STEPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 600, 1800, 3600];

  function fmtTime(s) {
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var ss = sec < 10 ? '0' + sec.toFixed(sec % 1 ? 1 : 0) : (sec % 1 ? sec.toFixed(1) : String(Math.floor(sec)));
    return (h ? h + ':' : '') + (h && m < 10 ? '0' : '') + m + ':' + ss;
  }

  function WaveformView(mainCanvas, overviewCanvas) {
    this.canvas = mainCanvas;
    this.overview = overviewCanvas;
    this.pyramid = null;   // {levels, sampleRate, duration}
    this.viewStart = 0;
    this.viewDuration = 1;
    this._raf = 0;
    this._bind();
    var self = this;
    new ResizeObserver(function () { self.requestRender(); }).observe(mainCanvas.parentElement);
  }

  WaveformView.prototype.setData = function (pyramid) {
    this.pyramid = pyramid;
    this.viewStart = 0;
    this.viewDuration = pyramid ? pyramid.duration : 1;
    this.requestRender();
  };

  WaveformView.prototype._clamp = function () {
    var dur = this.pyramid ? this.pyramid.duration : 1;
    var minV = Math.max(0.001, dur / 200000);
    this.viewDuration = Math.min(Math.max(this.viewDuration, minV), dur);
    this.viewStart = Math.min(Math.max(this.viewStart, 0), Math.max(0, dur - this.viewDuration));
  };

  WaveformView.prototype._bind = function () {
    var self = this, c = this.canvas;

    c.addEventListener('wheel', function (e) {
      if (!self.pyramid) return;
      e.preventDefault();
      var rect = c.getBoundingClientRect();
      var frac = (e.clientX - rect.left) / rect.width;
      var anchor = self.viewStart + frac * self.viewDuration;
      var factor = Math.exp(e.deltaY * 0.0015);
      self.viewDuration *= factor;
      self._clamp();
      self.viewStart = anchor - frac * self.viewDuration;
      self._clamp();
      self.requestRender();
    }, { passive: false });

    var dragging = false, lastX = 0;
    c.addEventListener('pointerdown', function (e) {
      dragging = true; lastX = e.clientX;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', function (e) {
      if (!dragging || !self.pyramid) return;
      var rect = c.getBoundingClientRect();
      self.viewStart -= (e.clientX - lastX) / rect.width * self.viewDuration;
      lastX = e.clientX;
      self._clamp();
      self.requestRender();
    });
    c.addEventListener('pointerup', function () { dragging = false; });

    // 总览条：点击 / 拖动定位视口
    var ov = this.overview, ovDrag = false;
    function ovSeek(e) {
      if (!self.pyramid) return;
      var rect = ov.getBoundingClientRect();
      var t = (e.clientX - rect.left) / rect.width * self.pyramid.duration;
      self.viewStart = t - self.viewDuration / 2;
      self._clamp();
      self.requestRender();
    }
    ov.addEventListener('pointerdown', function (e) { ovDrag = true; ov.setPointerCapture(e.pointerId); ovSeek(e); });
    ov.addEventListener('pointermove', function (e) { if (ovDrag) ovSeek(e); });
    ov.addEventListener('pointerup', function () { ovDrag = false; });
  };

  WaveformView.prototype.zoom = function (factor) {
    if (!this.pyramid) return;
    var center = this.viewStart + this.viewDuration / 2;
    this.viewDuration *= factor;
    this._clamp();
    this.viewStart = center - this.viewDuration / 2;
    this._clamp();
    this.requestRender();
  };

  WaveformView.prototype.requestRender = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = 0;
      self.render();
    });
  };

  // 根据当前缩放选择最合适的金字塔层级
  WaveformView.prototype._pickLevel = function (width) {
    var levels = this.pyramid.levels;
    var samplesPerPx = this.viewDuration * this.pyramid.sampleRate / width;
    for (var i = levels.length - 1; i >= 0; i--) { // 从粗到细
      if (levels[i].spp <= samplesPerPx * 2) return levels[i];
    }
    return levels[0];
  };

  WaveformView.prototype._drawWave = function (ctx, w, h, level, viewStart, viewDuration, color) {
    var sr = this.pyramid.sampleRate;
    var peaks = level.peaks, spp = level.spp;
    var nPeaks = peaks.length / 2;
    var mid = h / 2, amp = h / 2 - 2;
    ctx.fillStyle = color;
    for (var x = 0; x < w; x++) {
      var t0 = viewStart + (x / w) * viewDuration;
      var t1 = viewStart + ((x + 1) / w) * viewDuration;
      var i0 = Math.max(0, Math.floor(t0 * sr / spp));
      var i1 = Math.min(nPeaks, Math.ceil(t1 * sr / spp));
      if (i1 <= i0) i1 = Math.min(nPeaks, i0 + 1);
      var mn = Infinity, mx = -Infinity;
      for (var i = i0; i < i1; i++) {
        var a = peaks[i * 2], b = peaks[i * 2 + 1];
        if (a < mn) mn = a;
        if (b > mx) mx = b;
      }
      if (mn === Infinity) continue;
      var y0 = mid - mx * amp, y1 = mid - mn * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  };

  WaveformView.prototype._drawRuler = function (ctx, w, h) {
    var step = TIME_STEPS[TIME_STEPS.length - 1];
    for (var i = 0; i < TIME_STEPS.length; i++) {
      if (TIME_STEPS[i] * w / this.viewDuration >= 90) { step = TIME_STEPS[i]; break; }
    }
    ctx.fillStyle = 'rgba(139,148,158,0.9)';
    ctx.strokeStyle = 'rgba(139,148,158,0.25)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    var t = Math.ceil(this.viewStart / step) * step;
    for (; t <= this.viewStart + this.viewDuration; t += step) {
      var x = (t - this.viewStart) / this.viewDuration * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(fmtTime(t), x + 3, 2);
    }
  };

  WaveformView.prototype._setupCanvas = function (canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.parentElement.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  };

  WaveformView.prototype.render = function () {
    var m = this._setupCanvas(this.canvas);
    m.ctx.fillStyle = '#0d1117';
    m.ctx.fillRect(0, 0, m.w, m.h);
    if (this.pyramid) {
      var level = this._pickLevel(m.w);
      this._drawWave(m.ctx, m.w, m.h, level, this.viewStart, this.viewDuration, '#58a6ff');
      this._drawRuler(m.ctx, m.w, m.h);
    } else {
      m.ctx.fillStyle = '#8b949e';
      m.ctx.font = '14px system-ui, sans-serif';
      m.ctx.textAlign = 'center';
      m.ctx.fillText('加载音频并生成波形后在此显示', m.w / 2, m.h / 2);
      m.ctx.textAlign = 'left';
    }

    var o = this._setupCanvas(this.overview);
    o.ctx.fillStyle = '#161b22';
    o.ctx.fillRect(0, 0, o.w, o.h);
    if (this.pyramid) {
      var coarse = this.pyramid.levels[this.pyramid.levels.length - 1];
      this._drawWave(o.ctx, o.w, o.h, coarse, 0, this.pyramid.duration, '#388bfd');
      var dur = this.pyramid.duration;
      var x0 = this.viewStart / dur * o.w;
      var x1 = (this.viewStart + this.viewDuration) / dur * o.w;
      o.ctx.fillStyle = 'rgba(88,166,255,0.15)';
      o.ctx.fillRect(x0, 0, Math.max(2, x1 - x0), o.h);
      o.ctx.strokeStyle = '#58a6ff';
      o.ctx.strokeRect(x0, 0.5, Math.max(2, x1 - x0), o.h - 1);
    }
  };

  // 导出当前视图为 PNG Blob
  WaveformView.prototype.exportPNG = function (scale) {
    var self = this;
    return new Promise(function (resolve, reject) {
      try {
        if (!self.pyramid) throw new Error('没有可导出的波形');
        scale = scale || 2;
        var rect = self.canvas.parentElement.getBoundingClientRect();
        var w = Math.round(rect.width), h = Math.round(rect.height);
        var c = document.createElement('canvas');
        c.width = w * scale; c.height = h * scale;
        var ctx = c.getContext('2d');
        if (!ctx) throw new Error('无法创建导出画布');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, w, h);
        var level = self._pickLevel(w);
        self._drawWave(ctx, w, h, level, self.viewStart, self.viewDuration, '#58a6ff');
        self._drawRuler(ctx, w, h);
        c.toBlob(function (b) {
          if (b) resolve(b); else reject(new Error('toBlob 返回空，画布可能过大'));
        }, 'image/png');
      } catch (e) { reject(e); }
    });
  };

  global.WaveformView = WaveformView;
})(typeof self !== 'undefined' ? self : this);
