/* metrics.js — 耗时 / 内存 / 长任务监控（PerformanceObserver + performance.memory） */
(function (global) {
  'use strict';

  function PerfMonitor() {
    this.heapSupported = !!performance.memory;
    this.longtasks = [];
    this.measures = [];
    try {
      var lt = new PerformanceObserver((list) => {
        for (const en of list.getEntries()) this.longtasks.push(en);
      });
      lt.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* longtask 不支持则忽略 */ }
    try {
      var mo = new PerformanceObserver((list) => {
        for (const en of list.getEntries()) this.measures.push(en);
      });
      mo.observe({ entryTypes: ['measure'] });
    } catch (e) {}
  }

  PerfMonitor.prototype.heapNow = function () {
    return this.heapSupported ? performance.memory.usedJSHeapSize : 0;
  };

  PerfMonitor.prototype.start = function (label) {
    this.t0 = performance.now();
    this.heapStart = this.heapNow();
    this.heapPeak = this.heapStart;
    this.ltStart = this.longtasks.length;
    var self = this;
    this.timer = setInterval(function () {
      var h = self.heapNow();
      if (h > self.heapPeak) self.heapPeak = h;
    }, 100);
    try { performance.mark(label + ':start'); } catch (e) {}
  };

  PerfMonitor.prototype.stop = function (label) {
    clearInterval(this.timer);
    var h = this.heapNow();
    if (h > this.heapPeak) this.heapPeak = h;
    var total = performance.now() - this.t0;
    try {
      performance.mark(label + ':end');
      performance.measure(label, label + ':start', label + ':end');
    } catch (e) {}
    return {
      totalMs: total,
      heapStart: this.heapStart,
      heapPeak: this.heapPeak,
      heapDelta: this.heapPeak - this.heapStart,
      longtasks: this.longtasks.length - this.ltStart
    };
  };

  global.PerfMonitor = PerfMonitor;
})(typeof self !== 'undefined' ? self : this);
