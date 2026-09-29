# 长音频波形缩略图生成器

纯 Web 技术（无框架）实现的长音频波形缩略图工具，内置三种解码方案的性能对比。

## 运行

需要通过 HTTP 访问（Web Worker 不支持 file://）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

推荐使用 Chrome：堆内存指标依赖 `performance.memory`，长任务监控依赖 `PerformanceObserver` 的 `longtask`，其他浏览器这两项会显示为 —。

## 功能

- **加载长音频**：选择本地文件 / 拖拽，或一键合成 65/125 分钟的测试 WAV（Web Worker 中生成，不卡 UI）。
- **三种方案对比**：
  - 全量解码：一次性 `decodeAudioData`，PCM 全量驻留内存（基线）。
  - 分块解码：PCM WAV 按 30 秒切片逐块解码，峰值算完即释放，峰值内存 ≈ 一片大小；压缩格式（mp3 等）无法按字节切片，自动回退整段解码并在备注中说明。
  - 降采样：用 8kHz 单声道 `OfflineAudioContext` 解码，PCM 体积约为 44.1kHz 立体声的 1/11。
- **多分辨率金字塔**：基层每桶 256 采样，向上按 4:1 逐级抽取，渲染时按缩放级别自动选层，绘制复杂度 O(像素宽)。
- **性能指标**：耗时、JS 堆内存增量/峰值、长任务数、峰值桶数，同屏对照。
- **缩放/滚动**：滚轮以光标为锚点缩放、拖拽平移、Shift+滚轮平移、双击适应全曲；rAF 合并重绘 + 物理像素取整，避免抖动。
- **导出**：整曲波形导出为 PNG（可选 2048/4096/8192 宽度）。
- **缓存**：生成的金字塔按 文件+方案 存入 IndexedDB，二次打开秒出。

## 边界处理

- 长音频：峰值计算分片让出主线程，UI 不卡死；支持中途取消。
- 解码失败 / 导出失败 / 缓存写失败：均有提示，不会导致页面崩溃。
- 方案切换：每次运行递增 runId，旧任务在下一次让出时自动失效。
- 内存压力：分块与降采样方案的 PCM 驻留量有硬上限；测试音频合成前对超大文件弹确认。

## 文件结构

```
index.html          页面骨架
css/style.css       样式
js/db.js            IndexedDB 缓存
js/metrics.js       耗时 / 内存 / 长任务采集
js/pyramid.js       多分辨率峰值金字塔
js/strategies.js    三种解码方案
js/renderer.js      Canvas 渲染（缩放/平移/刻度）
js/exporter.js      PNG 导出
js/synth-worker.js  测试音频合成 Worker
js/main.js          主控逻辑
```
