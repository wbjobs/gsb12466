/* 三种波形生成方案：
 *  - full:       全量解码。一次性 decodeAudioData 整个文件，PCM 全部驻留内存。
 *  - chunked:    分块解码。PCM WAV 按时间切片、逐块解码、算完峰值即释放；
 *                非 PCM WAV 的压缩格式无法任意切片，回退为整段解码并在备注中说明。
 *  - downsample: 降采样。用 8kHz 单声道 OfflineAudioContext 解码，
 *                PCM 体积约为 44.1kHz 立体声的 1/11，再从低采样率 PCM 建金字塔。
 */
(function () {
  'use strict';

  const P = window.WavePyramid;
  const DOWNSAMPLE_RATE = 8000;
  const CHUNK_SECONDS = 30; // 分块方案每片的时长

  let sharedCtx = null;
  function getAudioContext() {
    if (!sharedCtx || sharedCtx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      sharedCtx = new AC();
    }
    return sharedCtx;
  }

  function getChannels(audioBuffer) {
    const ch = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      ch.push(audioBuffer.getChannelData(i));
    }
    return ch;
  }

  /* ---------- 方案一：全量解码 ---------- */
  async function strategyFull(fileBuffer, shouldCancel, onProgress) {
    onProgress(0.05, '解码整个文件…');
    const ctx = getAudioContext();
    // decodeAudioData 会 detach 传入的 buffer，这里复制一份
    const audio = await ctx.decodeAudioData(fileBuffer.slice(0));
    if (shouldCancel()) throw new Error('已取消');

    onProgress(0.4, '计算峰值（PCM 全量驻留内存）…');
    const base = await P.computeBasePeaks(
      getChannels(audio), P.BASE_BUCKET, shouldCancel,
      (f) => onProgress(0.4 + f * 0.55, '计算峰值…')
    );
    const result = {
      levels: P.buildLevels(base, audio.length),
      sampleRate: audio.sampleRate,
      duration: audio.duration,
      note: '整段 PCM 曾全部驻留内存',
    };
    return result;
  }

  /* ---------- 方案二：分块解码 ---------- */

  // 解析 WAV 头，仅支持可直接切片的 PCM / float 格式
  function parseWav(buf) {
    const v = new DataView(buf);
    if (buf.byteLength < 44) return null;
    if (v.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
    if (v.getUint32(8, false) !== 0x57415645) return null; // 'WAVE'

    let offset = 12;
    let fmt = null;
    let dataOffset = 0;
    let dataSize = 0;
    while (offset + 8 <= buf.byteLength) {
      const id = v.getUint32(offset, false);
      const size = v.getUint32(offset + 4, true);
      if (id === 0x666d7420) { // 'fmt '
        fmt = {
          format: v.getUint16(offset + 8, true),
          channels: v.getUint16(offset + 10, true),
          sampleRate: v.getUint32(offset + 12, true),
          bits: v.getUint16(offset + 22, true),
        };
      } else if (id === 0x64617461) { // 'data'
        dataOffset = offset + 8;
        dataSize = Math.min(size, buf.byteLength - dataOffset);
      }
      offset += 8 + size + (size & 1);
    }
    if (!fmt || !dataOffset) return null;
    if (fmt.format !== 1 && fmt.format !== 3) return null; // 仅 PCM / IEEE float
    fmt.blockAlign = fmt.channels * (fmt.bits / 8);
    if (!fmt.blockAlign) return null;
    return { fmt, dataOffset, dataSize };
  }

  // 为一段裸 PCM 数据重建 WAV 头，供 decodeAudioData 解码
  function buildWavSlice(fmt, pcmBytes) {
    const buf = new ArrayBuffer(44 + pcmBytes.byteLength);
    const v = new DataView(buf);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + pcmBytes.byteLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, fmt.format, true);
    v.setUint16(22, fmt.channels, true);
    v.setUint32(24, fmt.sampleRate, true);
    v.setUint32(28, fmt.sampleRate * fmt.blockAlign, true);
    v.setUint16(32, fmt.blockAlign, true);
    v.setUint16(34, fmt.bits, true);
    writeStr(36, 'data');
    v.setUint32(40, pcmBytes.byteLength, true);
    new Uint8Array(buf, 44).set(pcmBytes);
    return buf;
  }

  async function strategyChunked(fileBuffer, shouldCancel, onProgress) {
    const wav = parseWav(fileBuffer);
    if (!wav) {
      // 压缩格式无法按字节切片：回退为整段解码，但峰值仍分块计算
      onProgress(0.05, '非 PCM WAV，回退为整段解码…');
      const ctx = getAudioContext();
      const audio = await ctx.decodeAudioData(fileBuffer.slice(0));
      if (shouldCancel()) throw new Error('已取消');
      const base = await P.computeBasePeaks(
        getChannels(audio), P.BASE_BUCKET, shouldCancel,
        (f) => onProgress(0.4 + f * 0.55, '分块计算峰值…')
      );
      return {
        levels: P.buildLevels(base, audio.length),
        sampleRate: audio.sampleRate,
        duration: audio.duration,
        note: '压缩格式不支持切片，已回退整段解码',
      };
    }

    const { fmt, dataOffset, dataSize } = wav;
    // 每片采样数对齐到基层桶的整数倍，保证跨片拼接后峰值桶不错位
    const chunkSamples =
      Math.ceil((CHUNK_SECONDS * fmt.sampleRate) / P.BASE_BUCKET) * P.BASE_BUCKET;
    const bytesPerChunk = chunkSamples * fmt.blockAlign;
    const chunkCount = Math.max(1, Math.ceil(dataSize / bytesPerChunk));
    const ctx = getAudioContext();
    const parts = [];
    let decodedSamples = 0;
    let decodedRate = fmt.sampleRate;

    for (let i = 0; i < chunkCount; i++) {
      if (shouldCancel()) throw new Error('已取消');
      const start = dataOffset + i * bytesPerChunk;
      const end = Math.min(start + bytesPerChunk, dataOffset + dataSize);
      const slice = buildWavSlice(fmt, new Uint8Array(fileBuffer, start, end - start));

      // 每片解码后立即算峰值并释放 PCM，峰值内存 ≈ 一片的大小
      const audio = await ctx.decodeAudioData(slice);
      decodedRate = audio.sampleRate;
      const base = await P.computeBasePeaks(getChannels(audio), P.BASE_BUCKET, shouldCancel);
      parts.push(base);
      decodedSamples += audio.length;
      onProgress((i + 1) / chunkCount * 0.95, `分块解码 ${i + 1}/${chunkCount}…`);
      await P.yieldToUI();
    }

    const merged = P.concatBases(parts, P.BASE_BUCKET);
    return {
      levels: P.buildLevels(merged, decodedSamples),
      sampleRate: decodedRate,
      duration: decodedSamples / decodedRate,
      note: `共 ${chunkCount} 片，单片 PCM 即用即弃`,
    };
  }

  /* ---------- 方案三：降采样 ---------- */
  async function strategyDownsample(fileBuffer, shouldCancel, onProgress) {
    onProgress(0.05, `以 ${DOWNSAMPLE_RATE}Hz 单声道解码…`);
    // OfflineAudioContext 会把解码结果重采样到其采样率
    const off = new OfflineAudioContext(1, DOWNSAMPLE_RATE, DOWNSAMPLE_RATE);
    const audio = await off.decodeAudioData(fileBuffer.slice(0));
    if (shouldCancel()) throw new Error('已取消');

    onProgress(0.5, '低采样率 PCM 上计算峰值…');
    const base = await P.computeBasePeaks(
      getChannels(audio), P.BASE_BUCKET, shouldCancel,
      (f) => onProgress(0.5 + f * 0.45, '计算峰值…')
    );
    return {
      levels: P.buildLevels(base, audio.length),
      sampleRate: audio.sampleRate,
      duration: audio.duration,
      note: `解码为 ${audio.sampleRate}Hz 单声道，PCM 体积大幅下降`,
    };
  }

  window.WaveStrategies = {
    full: { name: '全量解码', run: strategyFull },
    chunked: { name: '分块解码', run: strategyChunked },
    downsample: { name: '降采样', run: strategyDownsample },
  };
})();
