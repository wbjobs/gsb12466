/* 性能指标采集：耗时、JS 堆内存（Chrome）、长任务（PerformanceObserver） */
(function () {
  'use strict';

  function heapUsed() {
    return (performance.memory && performance.memory.usedJSHeapSize) || 0;
  }

  function heapSupported() {
    return !!(performance.memory && performance.memory.usedJSHeapSize);
  }

  function start() {
    const m = {
      t0: performance.now(),
      heap0: heapUsed(),
      heapPeak: heapUsed(),
      longTasks: 0,
      _observer: null,
      _timer: null,
    };

    // 周期性采样堆内存峰值（生成期间）
    m._timer = setInterval(() => {
      const used = heapUsed();
      if (used > m.heapPeak) m.heapPeak = used;
    }, 100);

    // 长任务监控：>50ms 的主线程阻塞
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        m._observer = new PerformanceObserver((list) => {
          m.longTasks += list.getEntries().length;
        });
        m._observer.observe({ entryTypes: ['longtask'] });
      } catch (e) { /* 浏览器不支持 longtask，忽略 */ }
    }
    return m;
  }

  function stop(m) {
    clearInterval(m._timer);
    if (m._observer) m._observer.disconnect();
    const heapEnd = heapUsed();
    if (heapEnd > m.heapPeak) m.heapPeak = heapEnd;
    return {
      timeMs: performance.now() - m.t0,
      heapDelta: heapSupported() ? heapEnd - m.heap0 : null,
      heapPeak: heapSupported() ? m.heapPeak - m.heap0 : null,
      longTasks: m.longTasks,
    };
  }

  function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    const sign = bytes < 0 ? '-' : '';
    const abs = Math.abs(bytes);
    if (abs < 1024) return sign + abs + ' B';
    if (abs < 1024 * 1024) return sign + (abs / 1024).toFixed(1) + ' KB';
    return sign + (abs / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtTime(ms) {
    if (ms < 1000) return ms.toFixed(0) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  window.WaveMetrics = { start, stop, fmtBytes, fmtTime, heapSupported };
})();
