/* worker.js — 在 Web Worker 中执行解码与峰计算，避免阻塞主线程 */
importScripts('peaks.js');

var cancelled = false;

function decodeWithOffline(buf) {
  var ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(buf);
}

/* 合成测试用长音频：单声道 22050Hz 16bit WAV，内容含扫频/鼓点/噪声/静音段 */
function synthWav(seconds, sampleRate, onProgress) {
  var n = Math.floor(seconds * sampleRate);
  var buf = new ArrayBuffer(44 + n * 2);
  var dv = new DataView(buf);
  dv.setUint32(0, 0x46464952); dv.setUint32(4, 36 + n * 2, true);
  dv.setUint32(8, 0x45564157); dv.setUint32(12, 0x20746d66);
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); dv.setUint32(36, 0x61746164);
  dv.setUint32(40, n * 2, true);

  function hash(i) { var x = (i * 2654435761) >>> 0; x ^= x >>> 13; x = (x * 2246822519) >>> 0; return ((x >>> 8) & 0xffff) / 0x10000; }

  for (var i = 0; i < n; i++) {
    var t = i / sampleRate;
    var seg = Math.floor(t / 60) % 5; // 每 5 分钟一个内容循环
    var v = 0;
    if (seg === 0) {          // 扫频
      var f = 100 + 900 * ((t % 60) / 60);
      v = 0.6 * Math.sin(2 * Math.PI * f * t);
    } else if (seg === 1) {   // 鼓点 120bpm
      var beat = (t % 0.5) / 0.5;
      v = 0.9 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-beat * 12);
    } else if (seg === 2) {   // 噪声
      v = (hash(i) * 2 - 1) * 0.35;
    } else if (seg === 3) {   // 静音 + 稀疏脉冲
      v = (i % (sampleRate * 7) < 800) ? 0.8 * Math.sin(2 * Math.PI * 440 * t) : 0;
    } else {                  // 和弦淡出
      var env = 1 - (t % 60) / 60;
      v = env * 0.4 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t));
    }
    if (v > 1) v = 1; else if (v < -1) v = -1;
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
    if ((i & 0x3fffff) === 0) onProgress(i / n);
  }
  return buf;
}

onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }

  if (msg.type === 'synthesize') {
    cancelled = false;
    try {
      var buf = synthWav(msg.seconds, 22050, function (p) {
        postMessage({ type: 'progress', phase: 'synth', p: p });
      });
      postMessage({ type: 'synth-done', buffer: buf, name: msg.name }, [buf]);
    } catch (err) {
      postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === 'generate') {
    cancelled = false;
    if (typeof OfflineAudioContext === 'undefined') {
      postMessage({ type: 'unsupported' }); // 让主线程兜底
      return;
    }
    var file = msg.file;
    Peaks.generatePyramid({
      scheme: msg.scheme,
      fileName: file.name,
      mime: file.type,
      getBuffer: function () { return file.arrayBuffer(); },
      decode: decodeWithOffline,
      isCancelled: function () { return cancelled; },
      onProgress: function (phase, p) { postMessage({ type: 'progress', phase: phase, p: p }); }
    }).then(function (result) {
      var transfers = result.levels.map(function (l) { return l.peaks.buffer; });
      postMessage({
        type: 'done',
        levels: result.levels,
        sampleRate: result.sampleRate,
        duration: result.duration,
        stats: result.stats
      }, transfers);
    }).catch(function (err) {
      postMessage({ type: 'error', message: String(err && err.message || err) });
    });
  }
};
