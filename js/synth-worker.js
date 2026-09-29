/* 测试音频生成 Worker：合成带包络/噪声的混合信号，输出 16bit PCM WAV。
 * 在 Worker 中生成，避免长音频合成阻塞主线程。
 */
'use strict';

self.onmessage = function (e) {
  const { minutes, sampleRate } = e.data;
  try {
    const totalSamples = Math.floor(minutes * 60 * sampleRate);
    const dataBytes = totalSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    const out = new Int16Array(buffer, 44);
    const f1 = Math.max(40, sampleRate * 0.02);
    const f2 = Math.max(110, sampleRate * 0.05);
    const f3 = Math.max(220, sampleRate * 0.11);
    let noiseSeed = 12345;
    const noise = () => {
      noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
      return noiseSeed / 0x7fffffff * 2 - 1;
    };

    const reportEvery = Math.max(1, Math.floor(totalSamples / 100));
    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      // 慢包络：每 30 秒起伏一次，叠加随机“安静段”
      const env = 0.25 + 0.75 * Math.abs(Math.sin(t * Math.PI / 30));
      const quiet = (Math.sin(t * 0.013) > 0.85) ? 0.05 : 1;
      const v = env * quiet * (
        0.5 * Math.sin(2 * Math.PI * f1 * t) +
        0.3 * Math.sin(2 * Math.PI * f2 * t + 1.3) +
        0.15 * Math.sin(2 * Math.PI * f3 * t + 2.1) +
        0.05 * noise()
      );
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (i % reportEvery === 0) {
        self.postMessage({ type: 'progress', value: i / totalSamples });
      }
    }

    self.postMessage({ type: 'done', buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
