# 长音频波形缩略图生成器

纯原生 Web 技术（无框架）：Web Audio、OfflineAudioContext、Canvas、Web Worker、PerformanceObserver、IndexedDB。

## 运行

Worker 与 IndexedDB 需要 HTTP 环境，请在项目目录启动本地服务器：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- 加载长音频（1 小时以上），或一键合成 10/30/60 分钟测试 WAV
- 三种解码方案对比：
  - **全量解码**：一次性 `decodeAudioData`，PCM 全部驻留内存
  - **分块解码**：WAV 按 PCM 字节切片补头逐片解码；MP3/AAC/FLAC 走 WebCodecs `AudioDecoder` 流式解码，PCM 不落地
  - **降采样**：全量解码后只保留约 8K 峰的低分辨率金字塔，保留内存最小
- 多分辨率波形金字塔（min/max 峰，逐层 2:1 合并），缩放自动选层
- 指标对比：总耗时、解码耗时、峰计算耗时、PCM 体积、保留数据、主线程堆增量、长任务数
- 滚轮缩放、拖动平移、总览条定位、导出当前视图 PNG
- 金字塔按 文件名+大小+方案 缓存到 IndexedDB，二次生成秒开

## 边界处理

- 长音频：分块方案不一次性解码到内存；Worker 内解码避免阻塞 UI
- 解码失败：逐块 try/catch，失败块计数并提示；全部失败给出明确报错
- 方案切换：切换只影响下次运行；重新生成会先终止旧 Worker（runId 防串扰）
- 缩放抖动：rAF 节流渲染 + 视口 clamp + devicePixelRatio 适配
- 导出失败：toBlob 异常捕获并 toast 提示
- 内存压力：堆峰值轮询监控；Worker 异常（含 OOM）兜底提示不崩溃

## 文件结构

- `js/peaks.js` — 金字塔构建、WAV 切片、WebCodecs 流式解码（主线程/Worker 共用）
- `js/worker.js` — Worker 内解码与测试音频合成
- `js/renderer.js` — Canvas 波形视图（缩放/平移/总览/导出）
- `js/metrics.js` — PerformanceObserver + performance.memory 监控
- `js/store.js` — IndexedDB 缓存
- `js/app.js` — 主控与方案调度
