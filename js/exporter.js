/* 导出：把完整波形渲染到离屏 Canvas 并导出 PNG */
(function () {
  'use strict';

  async function exportPNG(pyramid, width, height, fileName) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 上下文');

    window.WaveRender.drawWaveform(ctx, pyramid, width, height, 0, pyramid.duration);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('PNG 编码失败（toBlob 返回空）'));
      }, 'image/png');
    });

    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    return blob.size;
  }

  window.WaveExporter = { exportPNG };
})();
