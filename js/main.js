/* 主控：文件加载、方案调度、指标记录、视图与导出 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $('file-input'),
    fileInfo: $('file-info'),
    synthMinutes: $('synth-minutes'),
    synthRate: $('synth-rate'),
    btnSynth: $('btn-synth'),
    strategySelect: $('strategy-select'),
    btnRun: $('btn-run'),
    btnRunAll: $('btn-run-all'),
    btnCancel: $('btn-cancel'),
    btnClearCache: $('btn-clear-cache'),
    progress: $('progress'),
    status: $('status'),
    metricsBody: document.querySelector('#metrics-table tbody'),
    canvas: $('wave-canvas'),
    canvasEmpty: $('canvas-empty'),
    viewInfo: $('view-info'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    btnZoomFit: $('btn-zoom-fit'),
    exportWidth: $('export-width'),
    btnExport: $('btn-export'),
    toast: $('toast'),
  };

  const state = {
    file: null,          // File 或合成的 Blob
    fileKey: null,       // 缓存键前缀
    fileBuffer: null,    // 压缩字节，只保留一份
    pyramid: null,
    runId: 0,            // 递增使旧任务失效，保证方案切换不崩
    running: false,
  };

  /* ---------- 提示 ---------- */
  let toastTimer = null;
  function toast(msg, ok) {
    els.toast.textContent = msg;
    els.toast.className = ok ? 'ok' : '';
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
  }

  function setStatus(text, fraction) {
    els.status.textContent = text;
    if (fraction !== undefined) els.progress.value = fraction;
  }

  /* ---------- 渲染器 ---------- */
  const renderer = new window.WaveRender.WaveformRenderer(els.canvas, (start, dur, total) => {
    els.viewInfo.textContent =
      `视图 ${window.WaveRender.fmtClock(start)} 起 · 窗口 ${dur.toFixed(2)}s · 全长 ${window.WaveRender.fmtClock(total)}`;
  });

  function onPyramidReady(pyramid) {
    state.pyramid = pyramid;
    renderer.setData(pyramid);
    els.canvasEmpty.style.display = 'none';
    for (const b of [els.btnZoomIn, els.btnZoomOut, els.btnZoomFit, els.btnExport]) {
      b.disabled = false;
    }
  }

  /* ---------- 指标表 ---------- */
  function addMetricRow(strategyName, metrics, bucketCount, note, failed) {
    const tr = document.createElement('tr');
    if (failed) tr.className = 'failed';
    const M = window.WaveMetrics;
    const cells = [
      strategyName,
      failed ? '失败' : M.fmtTime(metrics.timeMs),
      failed ? '—' : M.fmtBytes(metrics.heapDelta),
      failed ? '—' : M.fmtBytes(metrics.heapPeak),
      failed ? '—' : String(metrics.longTasks),
      failed ? '—' : bucketCount.toLocaleString(),
      note || '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tr.lastChild.className = 'note';
    els.metricsBody.appendChild(tr);
  }

  /* ---------- 方案执行 ---------- */
  function cacheKey(strategyId) {
    return `${state.fileKey}::${strategyId}`;
  }

  async function runStrategy(strategyId) {
    const myRun = state.runId;
    const strategy = window.WaveStrategies[strategyId];
    const isStale = () => myRun !== state.runId;
    const M = window.WaveMetrics;

    // 先查缓存
    const cached = await window.WaveDB.get(cacheKey(strategyId));
    if (isStale()) return;
    if (cached) {
      setStatus(`${strategy.name}：命中 IndexedDB 缓存`, 1);
      addMetricRow(strategy.name, { timeMs: 0, heapDelta: null, heapPeak: null, longTasks: 0 },
        window.WavePyramid.bucketCount(cached.levels), '缓存命中，未重新解码');
      onPyramidReady(cached);
      return;
    }

    const metrics = M.start();
    try {
      const pyramid = await strategy.run(state.fileBuffer, isStale, (f, text) => {
        if (!isStale()) setStatus(`${strategy.name}：${text}`, f);
      });
      const result = M.stop(metrics);
      if (isStale()) return;

      setStatus(`${strategy.name}：完成`, 1);
      addMetricRow(strategy.name, result, window.WavePyramid.bucketCount(pyramid.levels), pyramid.note);
      onPyramidReady(pyramid);
      // 异步写缓存，失败不阻塞
      window.WaveDB.set(cacheKey(strategyId), pyramid).then((ok) => {
        if (!ok) toast('缓存写入失败（可能空间不足），不影响本次使用');
      });
    } catch (err) {
      const result = M.stop(metrics);
      if (isStale()) return;
      if (String(err.message).includes('已取消')) {
        setStatus(`${strategy.name}：已取消`, 0);
        return;
      }
      console.error(err);
      setStatus(`${strategy.name}：失败 — ${err.message}`, 0);
      addMetricRow(strategy.name, result, 0, err.message, true);
      toast(`${strategy.name} 失败：${err.message}`);
    }
  }

  async function runSelected() {
    if (!state.fileBuffer || state.running) return;
    state.running = true;
    state.runId++;
    updateButtons();
    await runStrategy(els.strategySelect.value);
    state.running = false;
    updateButtons();
  }

  async function runAll() {
    if (!state.fileBuffer || state.running) return;
    state.running = true;
    state.runId++;
    updateButtons();
    for (const id of Object.keys(window.WaveStrategies)) {
      if (state.running) await runStrategy(id);
    }
    state.running = false;
    updateButtons();
  }

  function updateButtons() {
    const hasFile = !!state.fileBuffer;
    els.btnRun.disabled = !hasFile || state.running;
    els.btnRunAll.disabled = !hasFile || state.running;
    els.btnCancel.disabled = !state.running;
    els.btnSynth.disabled = state.running;
  }

  /* ---------- 文件加载 ---------- */
  async function loadFile(file) {
    try {
      setStatus('读取文件…', 0);
      state.file = file;
      state.fileKey = `${file.name}::${file.size}`;
      state.fileBuffer = await file.arrayBuffer();
      state.runId++; // 使正在运行的任务失效
      const mb = (file.size / 1024 / 1024).toFixed(1);
      els.fileInfo.textContent = `${file.name} · ${mb} MB`;
      setStatus('文件已就绪，请选择方案生成波形', 0);
      updateButtons();
    } catch (err) {
      toast(`文件读取失败：${err.message}`);
    }
  }

  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
  });

  // 拖拽加载
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragover');
  });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  /* ---------- 测试音频生成（Web Worker） ---------- */
  els.btnSynth.addEventListener('click', () => {
    const minutes = Number(els.synthMinutes.value);
    const sampleRate = Number(els.synthRate.value);
    const estMB = (minutes * 60 * sampleRate * 2 / 1024 / 1024).toFixed(0);
    if (estMB > 400 && !confirm(`预计生成 ${estMB} MB 的 WAV，可能占用较多内存，继续？`)) return;

    els.btnSynth.disabled = true;
    setStatus(`正在合成 ${minutes} 分钟测试音频…`, 0);
    const worker = new Worker('js/synth-worker.js');
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setStatus(`正在合成测试音频… ${(msg.value * 100).toFixed(0)}%`, msg.value);
      } else if (msg.type === 'done') {
        worker.terminate();
        els.btnSynth.disabled = false;
        const blob = new Blob([msg.buffer], { type: 'audio/wav' });
        blob.name = `test-${minutes}min-${sampleRate}Hz.wav`;
        loadFile(blob);
      } else if (msg.type === 'error') {
        worker.terminate();
        els.btnSynth.disabled = false;
        toast(`合成失败：${msg.message}`);
        setStatus('合成失败', 0);
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      els.btnSynth.disabled = false;
      toast(`合成 Worker 出错：${err.message}`);
    };
    worker.postMessage({ minutes, sampleRate });
  });

  /* ---------- 按钮 ---------- */
  els.btnRun.addEventListener('click', runSelected);
  els.btnRunAll.addEventListener('click', runAll);
  els.btnCancel.addEventListener('click', () => {
    state.runId++; // 让当前任务在下一次让出时退出
    state.running = false;
    updateButtons();
    setStatus('已取消', 0);
  });
  els.btnClearCache.addEventListener('click', async () => {
    const ok = await window.WaveDB.clear();
    toast(ok ? '缓存已清除' : '缓存清除失败', ok);
  });

  els.btnZoomIn.addEventListener('click', () => renderer.zoom(0.5));
  els.btnZoomOut.addEventListener('click', () => renderer.zoom(2));
  els.btnZoomFit.addEventListener('click', () => renderer.resetView());

  els.btnExport.addEventListener('click', async () => {
    if (!state.pyramid) return;
    const width = Number(els.exportWidth.value);
    const height = Math.round(width / 8);
    const name = `waveform-${els.strategySelect.value}-${Date.now()}.png`;
    try {
      const size = await window.WaveExporter.exportPNG(state.pyramid, width, height, name);
      toast(`已导出 ${name}（${(size / 1024).toFixed(0)} KB）`, true);
    } catch (err) {
      console.error(err);
      toast(`导出失败：${err.message}`);
    }
  });

  updateButtons();
})();
