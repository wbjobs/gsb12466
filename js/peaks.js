/* peaks.js — 波形金字塔构建与三种解码方案的核心逻辑
 * 同时被主线程 (app.js) 与 Web Worker (worker.js) 使用，无依赖、无框架。
 */
(function (global) {
  'use strict';

  var FINEST_SPP = 64;            // 最细层级：每个峰覆盖的采样数
  var MAX_FINEST_PEAKS = 1 << 20; // 最细层级峰数上限（约 104 万）
  var DOWNSAMPLE_FINEST = 8192;   // 降采样方案保留的最细峰数
  var SLICE_PEAKS = 4096;         // 分块方案：每片包含的峰数

  function now() { return performance.now(); }
  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  /* ---------------- WAV 解析与头部合成 ---------------- */

  function parseWav(buf) {
    if (buf.byteLength < 44) return null;
    var dv = new DataView(buf);
    if (dv.getUint32(0) !== 0x46464952) return null; // 'RIFF'
    if (dv.getUint32(8) !== 0x45564157) return null; // 'WAVE'
    var off = 12, fmt = null, dataOff = 0, dataLen = 0;
    while (off + 8 <= buf.byteLength) {
      var id = dv.getUint32(off);
      var size = dv.getUint32(off + 4, true);
      if (id === 0x20746d66) { // 'fmt '
        fmt = {
          audioFormat: dv.getUint16(off + 8, true),
          channels: dv.getUint16(off + 10, true),
          sampleRate: dv.getUint32(off + 12, true),
          blockAlign: dv.getUint16(off + 20, true),
          bits: dv.getUint16(off + 22, true)
        };
      } else if (id === 0x61746164) { // 'data'
        dataOff = off + 8;
        dataLen = Math.min(size, buf.byteLength - dataOff);
      }
      off += 8 + size + (size & 1);
    }
    if (!fmt || !dataOff || !fmt.blockAlign) return null;
    fmt.dataOffset = dataOff;
    fmt.dataLength = dataLen;
    return fmt;
  }

  function buildWavHeader(fmt, dataLength) {
    var buf = new ArrayBuffer(44);
    var dv = new DataView(buf);
    dv.setUint32(0, 0x46464952);              // RIFF
    dv.setUint32(4, 36 + dataLength, true);
    dv.setUint32(8, 0x45564157);              // WAVE
    dv.setUint32(12, 0x20746d66);             // 'fmt '
    dv.setUint32(16, 16, true);
    dv.setUint16(20, fmt.audioFormat, true);
    dv.setUint16(22, fmt.channels, true);
    dv.setUint32(24, fmt.sampleRate, true);
    dv.setUint32(28, fmt.sampleRate * fmt.blockAlign, true);
    dv.setUint16(32, fmt.blockAlign, true);
    dv.setUint16(34, fmt.bits, true);
    dv.setUint32(36, 0x61746164);             // 'data'
    dv.setUint32(40, dataLength, true);
    return buf;
  }

  /* ---------------- 峰计算 ---------------- */

  // 把一段解码后的 PCM 按 spp 聚合成 min/max 峰，写入 out 的 outPeakStart 处
  function fillPeaks(audio, spp, out, outPeakStart, onProgress) {
    var nCh = audio.numberOfChannels, len = audio.length;
    var nPeaks = Math.ceil(len / spp);
    var chans = [];
    for (var c = 0; c < nCh; c++) chans.push(audio.getChannelData(c));
    for (var p = 0; p < nPeaks; p++) {
      var s0 = p * spp, s1 = Math.min(len, s0 + spp);
      var mn = Infinity, mx = -Infinity;
      for (c = 0; c < nCh; c++) {
        var d = chans[c];
        for (var i = s0; i < s1; i++) {
          var v = d[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      var o = (outPeakStart + p) * 2;
      out[o] = mn; out[o + 1] = mx;
      if (onProgress && (p & 0x3fff) === 0) onProgress(p / nPeaks);
    }
    return nPeaks;
  }

  // 2:1 合并，生成更粗一层
  function coarsen(peaks) {
    var n = peaks.length >> 2; // 输出峰数
    var out = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) {
      var a = peaks[i * 4], b = peaks[i * 4 + 2];
      var c = peaks[i * 4 + 1], d = peaks[i * 4 + 3];
      out[i * 2] = a < b ? a : b;
      out[i * 2 + 1] = c > d ? c : d;
    }
    return out;
  }

  function buildLevels(finest, spp) {
    var levels = [{ spp: spp, peaks: finest }];
    var p = finest, s = spp;
    while ((p.length >> 1) > 1024) {
      p = coarsen(p); s *= 2;
      levels.push({ spp: s, peaks: p });
    }
    return levels;
  }

  // WebCodecs 流式解码用的窗口累积器：按帧序号对齐窗口，逐声道合并 min/max
  function PeakWindowAcc(spp) {
    this.spp = spp;
    this.frames = 0;
    this.base = 0;
    this.winCount = 0;
    this.peaks = [];
  }
  PeakWindowAcc.prototype.addChannel = function (a, chIdx) {
    var spp = this.spp, i, w, v;
    if (chIdx === 0) {
      this.base = this.frames;
      var end = this.base + a.length;
      var w1 = Math.ceil(end / spp);
      for (w = this.winCount; w < w1; w++) {
        this.peaks[w * 2] = Infinity;
        this.peaks[w * 2 + 1] = -Infinity;
      }
      if (w1 > this.winCount) this.winCount = w1;
      this.frames = end;
    }
    var pk = this.peaks, base = this.base;
    for (i = 0; i < a.length; i++) {
      w = ((base + i) / spp) | 0;
      v = a[i];
      if (v < pk[w * 2]) pk[w * 2] = v;
      if (v > pk[w * 2 + 1]) pk[w * 2 + 1] = v;
    }
  };
  PeakWindowAcc.prototype.finalize = function () {
    var out = new Float32Array(this.winCount * 2);
    for (var i = 0; i < out.length; i++) {
      var v = this.peaks[i];
      out[i] = (v === Infinity || v === -Infinity || v === undefined) ? 0 : v;
    }
    return out;
  };

  /* ---------------- WebCodecs 流式解码 ---------------- */

  function sniffCodec(name, mime) {
    var n = (name || '').toLowerCase();
    if (/\.mp3$/.test(n) || mime === 'audio/mpeg') return 'mp3';
    if (/\.(m4a|aac|mp4)$/.test(n) || mime === 'audio/mp4' || mime === 'audio/aac') return 'mp4a.40.2';
    if (/\.flac$/.test(n) || mime === 'audio/flac') return 'flac';
    return null;
  }

  function decodeStreamWebCodecs(buffer, codec, acc, onProgress) {
    return new Promise(function (resolve, reject) {
      var sampleRate = 0, settled = false;
      var decoder;
      try {
        decoder = new AudioDecoder({
          output: function (frame) {
            try {
              sampleRate = frame.sampleRate;
              var frames = frame.numberOfFrames;
              var tmp = new Float32Array(frames);
              for (var c = 0; c < frame.numberOfChannels; c++) {
                frame.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
                acc.addChannel(tmp, c);
              }
              frame.close();
            } catch (e) { if (!settled) { settled = true; reject(e); } }
          },
          error: function (e) { if (!settled) { settled = true; reject(e); } }
        });
        decoder.configure({ codec: codec });
      } catch (e) { reject(e); return; }
      var CH = 4 * 1024 * 1024, ts = 0;
      for (var off = 0; off < buffer.byteLength; off += CH) {
        decoder.decode(new EncodedAudioChunk({
          type: off === 0 ? 'key' : 'delta',
          timestamp: ts++,
          data: buffer.slice(off, off + CH)
        }));
        if (onProgress) onProgress(off / buffer.byteLength);
      }
      decoder.flush().then(function () {
        settled = true;
        try { decoder.close(); } catch (e) {}
        resolve(sampleRate);
      }, function (e) { if (!settled) { settled = true; reject(e); } });
    });
  }

  /* ---------------- 主流程：三种方案 ----------------
   * opts: { scheme, getBuffer, fileName, mime, decode, isCancelled, onProgress }
   * decode: async (ArrayBuffer) => AudioBuffer 风格对象
   */
  async function generatePyramid(opts) {
    var scheme = opts.scheme;
    var onProgress = opts.onProgress || function () {};
    var cancelled = function () { return opts.isCancelled && opts.isCancelled(); };
    var stats = { decodeMs: 0, peaksMs: 0, chunks: 0, failedChunks: 0, pcmBytes: 0, path: '' };
    var buffer = await opts.getBuffer();
    if (cancelled()) throw new Error('已取消');

    var wav = parseWav(buffer);
    var finest = null, spp = FINEST_SPP, sampleRate = 0;

    if (scheme === 'chunked' && wav && (wav.audioFormat === 1 || wav.audioFormat === 3)) {
      /* 分块方案 · WAV 路径：按 PCM 字节切片，补 WAV 头后逐片解码，解码一片释放一片 */
      stats.path = 'wav-slice';
      sampleRate = wav.sampleRate;
      var totalSamples = Math.floor(wav.dataLength / wav.blockAlign);
      spp = Math.max(FINEST_SPP, nextPow2(Math.ceil(totalSamples / MAX_FINEST_PEAKS)));
      var sliceBytes = spp * SLICE_PEAKS * wav.blockAlign;
      var finestCount = Math.ceil(totalSamples / spp);
      finest = new Float32Array(finestCount * 2);
      var offset = 0, peakPos = 0;
      while (offset < wav.dataLength) {
        if (cancelled()) throw new Error('已取消');
        var len = Math.min(sliceBytes, wav.dataLength - offset);
        len -= len % wav.blockAlign;
        if (len <= 0) break;
        var header = buildWavHeader(wav, len);
        var sliceBuf = new Uint8Array(44 + len);
        sliceBuf.set(new Uint8Array(header), 0);
        sliceBuf.set(new Uint8Array(buffer, wav.dataOffset + offset, len), 44);
        var tD = now();
        var audio;
        try {
          audio = await opts.decode(sliceBuf.buffer);
        } catch (e) {
          stats.failedChunks++;
          offset += len;
          continue;
        }
        stats.decodeMs += now() - tD;
        stats.chunks++;
        var tP = now();
        peakPos += fillPeaks(audio, spp, finest, peakPos, function (p) {
          onProgress('peaks', (offset / wav.dataLength) + (p * len / wav.dataLength));
        });
        stats.peaksMs += now() - tP;
        offset += len;
        onProgress('decode', offset / wav.dataLength);
      }
      // 尾部长度不足时截断到实际峰数
      if (peakPos < finestCount) finest = finest.subarray(0, peakPos * 2);

    } else if (scheme === 'chunked' && !wav && sniffCodec(opts.fileName, opts.mime) && typeof AudioDecoder !== 'undefined') {
      /* 分块方案 · WebCodecs 路径：流式送入编码数据，边解码边聚合，PCM 不落地 */
      stats.path = 'webcodecs';
      var codec = sniffCodec(opts.fileName, opts.mime);
      var acc = new PeakWindowAcc(FINEST_SPP);
      var tD2 = now();
      sampleRate = await decodeStreamWebCodecs(buffer, codec, acc, function (p) {
        onProgress('decode', p);
      });
      stats.decodeMs = now() - tD2;
      stats.chunks = Math.ceil(buffer.byteLength / (4 * 1024 * 1024));
      var tP2 = now();
      finest = acc.finalize();
      stats.peaksMs = now() - tP2;
      spp = FINEST_SPP;

    } else if (scheme === 'chunked') {
      /* 分块方案 · 兜底：按字节切片尽力解码，失败片跳过 */
      stats.path = 'byte-slice';
      var CH = 8 * 1024 * 1024;
      var parts = [], total = 0;
      for (var off2 = 0; off2 < buffer.byteLength; off2 += CH) {
        if (cancelled()) throw new Error('已取消');
        var tD3 = now();
        try {
          var a2 = await opts.decode(buffer.slice(off2, Math.min(off2 + CH, buffer.byteLength)));
          stats.decodeMs += now() - tD3;
          stats.chunks++;
          if (!sampleRate) sampleRate = a2.sampleRate;
          var tP3 = now();
          var tmp = new Float32Array(Math.ceil(a2.length / FINEST_SPP) * 2);
          var used = fillPeaks(a2, FINEST_SPP, tmp, 0, null);
          parts.push(tmp.subarray(0, used * 2));
          total += used * 2;
          stats.peaksMs += now() - tP3;
        } catch (e) {
          stats.failedChunks++;
        }
        onProgress('decode', Math.min(1, (off2 + CH) / buffer.byteLength));
      }
      if (!parts.length) throw new Error('所有分块均解码失败，请换用 WAV 文件或其他方案');
      finest = new Float32Array(total);
      var wp = 0;
      for (var pi = 0; pi < parts.length; pi++) { finest.set(parts[pi], wp); wp += parts[pi].length; }
      spp = FINEST_SPP;

    } else {
      /* 全量解码 / 降采样：一次性 decodeAudioData */
      var tD4 = now();
      var audio4 = await opts.decode(buffer);
      stats.decodeMs = now() - tD4;
      stats.chunks = 1;
      sampleRate = audio4.sampleRate;
      stats.pcmBytes = audio4.length * audio4.numberOfChannels * 4;
      var totalS = audio4.length;
      spp = scheme === 'downsample'
        ? nextPow2(Math.ceil(totalS / DOWNSAMPLE_FINEST))
        : Math.max(FINEST_SPP, nextPow2(Math.ceil(totalS / MAX_FINEST_PEAKS)));
      stats.path = scheme === 'downsample' ? 'full-decode+downsample' : 'full-decode';
      var tP4 = now();
      finest = new Float32Array(Math.ceil(totalS / spp) * 2);
      fillPeaks(audio4, spp, finest, 0, function (p) { onProgress('peaks', p); });
      stats.peaksMs = now() - tP4;
      // audio4 离开作用域后可被 GC（降采样方案只保留极小的金字塔）
    }

    if (!sampleRate) throw new Error('无法确定采样率，解码可能失败');
    var levels = buildLevels(finest, spp);
    var retained = 0;
    for (var li = 0; li < levels.length; li++) retained += levels[li].peaks.byteLength;
    stats.retainedBytes = retained;
    return {
      levels: levels,
      sampleRate: sampleRate,
      duration: (finest.length / 2) * spp / sampleRate,
      stats: stats
    };
  }

  global.Peaks = {
    FINEST_SPP: FINEST_SPP,
    parseWav: parseWav,
    buildWavHeader: buildWavHeader,
    fillPeaks: fillPeaks,
    coarsen: coarsen,
    buildLevels: buildLevels,
    PeakWindowAcc: PeakWindowAcc,
    sniffCodec: sniffCodec,
    generatePyramid: generatePyramid
  };
})(typeof self !== 'undefined' ? self : this);
