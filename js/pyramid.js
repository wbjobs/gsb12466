/* 多分辨率峰值金字塔：
 * 每一层是 { spb: 每桶采样点数, min: Float32Array, max: Float32Array }
 * 上层由下层按 4:1 抽取（min 取小、max 取大），渲染时按缩放级别选层。
 */
(function () {
  'use strict';

  const LEVEL_FACTOR = 4;
  const BASE_BUCKET = 256;       // 最细层每桶采样点数
  const MAX_LEVELS = 8;
  const YIELD_EVERY = 1 << 22;   // 每处理约 400 万采样让出一次主线程

  function yieldToUI() {
    return new Promise((r) => setTimeout(r, 0));
  }

  // 从一组声道数据计算基层峰值（分片处理，避免长任务卡死 UI）
  async function computeBasePeaks(channels, samplesPerBucket, shouldCancel, onProgress) {
    const len = channels[0] ? channels[0].length : 0;
    const n = Math.ceil(len / samplesPerBucket) || 0;
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    let processed = 0;

    for (let i = 0; i < n; i++) {
      let lo = Infinity;
      let hi = -Infinity;
      const start = i * samplesPerBucket;
      const end = Math.min(start + samplesPerBucket, len);
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        for (let j = start; j < end; j++) {
          const v = ch[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[i] = lo === Infinity ? 0 : lo;
      max[i] = hi === -Infinity ? 0 : hi;

      processed = end;
      if ((processed & (YIELD_EVERY - 1)) === 0) {
        if (shouldCancel && shouldCancel()) throw new Error('已取消');
        if (onProgress) onProgress(processed / len);
        await yieldToUI();
      }
    }
    if (onProgress) onProgress(1);
    return { spb: samplesPerBucket, min, max };
  }

  // 由细层向粗层抽取
  function decimate(level) {
    const n = Math.ceil(level.min.length / LEVEL_FACTOR);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = Infinity;
      let hi = -Infinity;
      const start = i * LEVEL_FACTOR;
      const end = Math.min(start + LEVEL_FACTOR, level.min.length);
      for (let j = start; j < end; j++) {
        if (level.min[j] < lo) lo = level.min[j];
        if (level.max[j] > hi) hi = level.max[j];
      }
      min[i] = lo === Infinity ? 0 : lo;
      max[i] = hi === -Infinity ? 0 : hi;
    }
    return { spb: level.spb * LEVEL_FACTOR, min, max };
  }

  function buildLevels(base, totalSamples) {
    const levels = [base];
    while (
      levels.length < MAX_LEVELS &&
      levels[levels.length - 1].min.length > 1024 &&
      levels[levels.length - 1].spb < totalSamples
    ) {
      levels.push(decimate(levels[levels.length - 1]));
    }
    return levels;
  }

  // 拼接多个分块的基层峰值
  function concatBases(parts, samplesPerBucket) {
    let total = 0;
    for (const p of parts) total += p.min.length;
    const min = new Float32Array(total);
    const max = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
      min.set(p.min, offset);
      max.set(p.max, offset);
      offset += p.min.length;
    }
    return { spb: samplesPerBucket, min, max };
  }

  function bucketCount(levels) {
    return levels.reduce((sum, l) => sum + l.min.length, 0);
  }

  window.WavePyramid = {
    BASE_BUCKET,
    computeBasePeaks,
    buildLevels,
    concatBases,
    bucketCount,
    yieldToUI,
  };
})();
