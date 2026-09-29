/* app.js — 主控：文件加载、三种方案调度、指标对比、缓存、导出 */
(function () {
  'use strict';

  var SCHEMES = {
    full: '全量解码',
    chunked: '分块解码',
    downsample: '降采样'
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    fileInput: $('fileInput'), dropzone: $('dropzone'), fileInfo: $('fileInfo'),
    demoLen: $('demoLen'), demoBtn: $('demoBtn'),
    runBtn: $('runBtn'), runAllBtn: $('runAllBtn'), clearCacheBtn: $('clearCacheBtn'),
    metricsBody: $('metricsBody'), status: $('status'), toast: $('toast'),
    mainCanvas: $('mainCanvas'), overviewCanvas: $('overviewCanvas'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomReset: $('zoomReset'),
    exportBtn: $('exportBtn'), progressBar: $('progressBar'), progressWrap: $('progressWrap')
  };

  var state = {
    file: null,
    worker: null,
    runId: 0,
    running: false
  };

  var monitor = new PerfMonitor();
  var view = new WaveformView(els.mainCanvas, els.overviewCanvas);

  /* ---------------- 工具 ---------------- */

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms'; }

  function setStatus(text) { els.status.textContent = text; }

  var toastTimer = 0;
  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 4000);
  }

  function setProgress(p) {
    els.progressWrap.style.display = p == null ? 'none' : 'block';
    if (p != null) els.progressBar.style.width = Math.round(p * 100) + '%';
  }

  /* ---------------- 指标表 ---------------- */

  function ensureRow(scheme) {
    var row = $('row-' + scheme);
    if (row) return row;
    row = document.createElement('tr');
    row.id = 'row-' + scheme;
    row.innerHTML = '<td>' + SCHEMES[scheme] + '</td>' +
      '<td class="c-path">—</td><td class="c-total">—</td><td class="c-decode">—</td>' +
      '<td class="c-peaks">—</td><td class="c-pcm">—</td><td class="c-retained">—</td>' +
      '<td class="c-heap">—</td><td class="c-lt">—</td><td class="c-status">—</td>';
    els.metricsBody.appendChild(row);
    return row;
  }

  function fillRow(scheme, data) {
    var row = ensureRow(scheme);
    row.querySelector('.c-path').textContent = data.path || '—';
    row.querySelector('.c-total').textContent = data.totalMs != null ? fmtMs(data.totalMs) : '—';
    row.querySelector('.c-decode').textContent = data.decodeMs != null ? fmtMs(data.decodeMs) : '—';
    row.querySelector('.c-peaks').textContent = data.peaksMs != null ? fmtMs(data.peaksMs) : '—';
    row.querySelector('.c-pcm').textContent = data.pcmBytes != null ? fmtBytes(data.pcmBytes) : '—';
    row.querySelector('.c-retained').textContent = data.retainedBytes != null ? fmtBytes(data.retainedBytes) : '—';
    row.querySelector('.c-heap').textContent = monitor.heapSupported && data.heapDelta != null ? fmtBytes(data.heapDelta) : 'N/A';
    row.querySelector('.c-lt').textContent = data.longtasks != null ? String(data.longtasks) : '—';
    var st = row.querySelector('.c-status');
    st.textContent = data.status || '—';
    st.className = 'c-status ' + (data.statusClass || '');
  }

  /* ---------------- 缓存 ---------------- */

  function cacheKey(scheme) { return Store.key(state.file, scheme); }

  function tryCache(scheme) {
    return Store.get(cacheKey(scheme)).then(function (hit) {
      if (!hit) return null;
      return {
        levels: hit.levels.map(function (l) { return { spp: l.spp, peaks: new Float32Array(l.peaks) }; }),
        sampleRate: hit.sampleRate,
        duration: hit.duration,
        stats: hit.stats
      };
    }).catch(function () { return null; });
  }

  function saveCache(scheme, result) {
    var val = {
      levels: result.levels.map(function (l) { return { spp: l.spp, peaks: l.peaks.buffer.slice(0) }; }),
      sampleRate: result.sampleRate,
      duration: result.duration,
      stats: result.stats
    };
    Store.set(cacheKey(scheme), val).catch(function (e) {
      console.warn('缓存写入失败（可能超出配额）', e);
    });
  }

  /* ---------------- Worker 管理 ---------------- */

  function abortWorker() {
    if (state.worker) {
      try { state.worker.postMessage({ type: 'cancel' }); } catch (e) {}
      state.worker.terminate();
      state.worker = null;
    }
    state.runId++;
    state.running = false;
  }

  function newWorker() {
    var w = new Worker('js/worker.js');
    state.worker = w;
    return w;
  }

  /* ---------------- 主线程兜底（Worker 不可用 / 不支持解码时） ---------------- */

  var audioCtx = null;
  function mainThreadDecode(buf) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx.decodeAudioData(buf);
  }

  function runOnMainThread(scheme, runId) {
    return Peaks.generatePyramid({
      scheme: scheme,
      fileName: state.file.name,
      mime: state.file.type,
      getBuffer: function () { return state.file.arrayBuffer(); },
      decode: mainThreadDecode,
      isCancelled: function () { return state.runId !== runId; },
      onProgress: function (phase, p) { setProgress(p); }
    });
  }

  /* ---------------- 方案执行 ---------------- */

  function runScheme(scheme, opts) {
    opts = opts || {};
    if (!state.file) { toast('请先选择音频文件', true); return Promise.resolve(false); }
    abortWorker();
    var runId = state.runId;
    state.running = true;
    setProgress(0);
    setStatus('正在生成（' + SCHEMES[scheme] + '）…');
    fillRow(scheme, { status: '运行中', statusClass: 'running' });

    return tryCache(scheme).then(function (cached) {
      if (state.runId !== runId) return false;
      if (cached && !opts.bypassCache) {
        monitor.start(scheme);
        var m = monitor.stop(scheme);
        applyResult(scheme, cached, m, true);
        return true;
      }
      monitor.start(scheme);
      return generate(scheme, runId).then(function (result) {
        if (state.runId !== runId) return false;
        var m = monitor.stop(scheme);
        applyResult(scheme, result, m, false);
        saveCache(scheme, result);
        return true;
      });
    }).catch(function (err) {
      if (state.runId !== runId) return false;
      monitor.stop(scheme);
      state.running = false;
      setProgress(null);
      fillRow(scheme, { status: '失败', statusClass: 'failed' });
      setStatus('生成失败：' + (err && err.message || err));
      toast('生成失败：' + (err && err.message || err), true);
      return false;
    });
  }

  function generate(scheme, runId) {
    return new Promise(function (resolve, reject) {
      var w;
      try {
        w = newWorker();
      } catch (e) {
        // file:// 等场景无法创建 Worker，回退主线程
        toast('Worker 不可用，已在主线程运行（建议用本地服务器打开）');
        runOnMainThread(scheme, runId).then(resolve, reject);
        return;
      }
      w.onmessage = function (e) {
        var msg = e.data;
        if (state.runId !== runId) return;
        if (msg.type === 'progress') {
          setProgress(msg.p);
        } else if (msg.type === 'done') {
          w.terminate();
          if (state.worker === w) state.worker = null;
          resolve({ levels: msg.levels, sampleRate: msg.sampleRate, duration: msg.duration, stats: msg.stats });
        } else if (msg.type === 'unsupported') {
          w.terminate();
          if (state.worker === w) state.worker = null;
          runOnMainThread(scheme, runId).then(resolve, reject);
        } else if (msg.type === 'error') {
          w.terminate();
          if (state.worker === w) state.worker = null;
          reject(new Error(msg.message));
        }
      };
      w.onerror = function (e) {
        if (state.runId !== runId) return;
        w.terminate();
        if (state.worker === w) state.worker = null;
        reject(new Error(e.message || 'Worker 异常（可能是内存不足）'));
      };
      w.postMessage({ type: 'generate', scheme: scheme, file: state.file });
    });
  }

  function applyResult(scheme, result, m, fromCache) {
    state.running = false;
    setProgress(null);
    var s = result.stats || {};
    fillRow(scheme, {
      path: fromCache ? '缓存命中' : s.path,
      totalMs: m.totalMs,
      decodeMs: fromCache ? null : s.decodeMs,
      peaksMs: fromCache ? null : s.peaksMs,
      pcmBytes: s.pcmBytes,
      retainedBytes: s.retainedBytes,
      heapDelta: m.heapDelta,
      longtasks: m.longtasks,
      status: fromCache ? '完成(缓存)' : '完成',
      statusClass: 'done'
    });
    view.setData({ levels: result.levels, sampleRate: result.sampleRate, duration: result.duration });
    var mins = (result.duration / 60).toFixed(1);
    setStatus('完成（' + SCHEMES[scheme] + '）· 时长 ' + mins + ' 分钟 · 采样率 ' + result.sampleRate + ' Hz' +
      (s.failedChunks ? ' · 跳过失败分块 ' + s.failedChunks + ' 个' : ''));
  }

  /* ---------------- 事件绑定 ---------------- */

  function loadFile(file) {
    if (!file) return;
    abortWorker();
    state.file = file;
    view.setData(null);
    els.fileInfo.textContent = file.name + ' · ' + fmtBytes(file.size);
    els.runBtn.disabled = false;
    els.runAllBtn.disabled = false;
    els.exportBtn.disabled = true;
    setStatus('文件已加载，请选择方案并生成');
  }

  els.fileInput.addEventListener('change', function () { loadFile(els.fileInput.files[0]); });

  ['dragover', 'drop'].forEach(function (ev) {
    els.dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
  });

  function currentScheme() {
    var r = document.querySelector('input[name="scheme"]:checked');
    return r ? r.value : 'chunked';
  }

  els.runBtn.addEventListener('click', function () {
    els.exportBtn.disabled = true;
    runScheme(currentScheme()).then(function (ok) { if (ok) els.exportBtn.disabled = false; });
  });

  els.runAllBtn.addEventListener('click', function () {
    if (!state.file) { toast('请先选择音频文件', true); return; }
    els.runAllBtn.disabled = true;
    els.exportBtn.disabled = true;
    var seq = Promise.resolve();
    ['full', 'chunked', 'downsample'].forEach(function (scheme) {
      seq = seq.then(function () {
        return runScheme(scheme, { bypassCache: true });
      }).then(function () {
        return new Promise(function (r) { setTimeout(r, 600); }); // 让 GC 与堆采样稳定
      });
    });
    seq.then(function () {
      els.runAllBtn.disabled = false;
      els.exportBtn.disabled = false;
      setStatus('三种方案对比完成，可切换单方案重新生成查看波形');
    });
  });

  els.clearCacheBtn.addEventListener('click', function () {
    Store.clear().then(function () { toast('缓存已清除'); })
      .catch(function (e) { toast('清除缓存失败：' + e.message, true); });
  });

  els.demoBtn.addEventListener('click', function () {
    var minutes = parseInt(els.demoLen.value, 10);
    abortWorker();
    var runId = state.runId;
    setStatus('正在合成 ' + minutes + ' 分钟测试音频…');
    setProgress(0);
    var w;
    try { w = newWorker(); } catch (e) { toast('Worker 不可用，无法合成', true); return; }
    w.onmessage = function (e) {
      if (state.runId !== runId) return;
      var msg = e.data;
      if (msg.type === 'progress') setProgress(msg.p);
      else if (msg.type === 'synth-done') {
        w.terminate(); state.worker = null;
        setProgress(null);
        var file = new File([msg.buffer], msg.name, { type: 'audio/wav' });
        loadFile(file);
        toast('测试音频已生成（' + minutes + ' 分钟）');
      } else if (msg.type === 'error') {
        w.terminate(); state.worker = null;
        setProgress(null);
        toast('合成失败：' + msg.message, true);
      }
    };
    w.postMessage({ type: 'synthesize', seconds: minutes * 60, name: 'demo-' + minutes + 'min.wav' });
  });

  els.zoomIn.addEventListener('click', function () { view.zoom(0.5); });
  els.zoomOut.addEventListener('click', function () { view.zoom(2); });
  els.zoomReset.addEventListener('click', function () {
    if (view.pyramid) { view.viewStart = 0; view.viewDuration = view.pyramid.duration; view.requestRender(); }
  });

  els.exportBtn.addEventListener('click', function () {
    view.exportPNG(2).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'waveform.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('已导出 waveform.png');
    }).catch(function (e) {
      toast('导出失败：' + e.message, true);
    });
  });

  // 切换方案不崩：只影响下一次生成，不打断当前任务
  document.querySelectorAll('input[name="scheme"]').forEach(function (r) {
    r.addEventListener('change', function () {
      setStatus('已选择「' + SCHEMES[currentScheme()] + '」，点击“生成波形”运行');
    });
  });

  setStatus('请选择或拖入音频文件，或生成测试音频');
})();
