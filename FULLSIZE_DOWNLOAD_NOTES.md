# 全尺寸下载方案与差异分析

## 背景
目前使用 `=s0` 拉取图片，得到的文件约 1.7–2 MB；手动点击 “Download full size” 的文件约 5–7 MB，质量明显更高。经抓包发现，“Download full size” 使用的是 `rd-gg-dl` 直链，参数形如 `=s0-d-I`，而非简单 `=s0`。

## 已实现的代码改进
- 在下载阶段增加 `buildFullSizeCandidates`：
  - 对 `googleusercontent.com` 链接依次尝试 `=s0-d-I` → `=s0-d` → `=s0`（兜底）。
  - 保留原始 URL 作为最后 fallback。
- 按生成顺序下载，文件名严格 `page1..N.png`，并过滤非位图资源（跳过 svg/blob 直链）。

## 观察到的直链模式
- 主机：`work.fife.usercontent.google.com`（或类似 rd-gg-dl 域）
- 末尾参数：`=s0-d-I?alr=yes`（可能含签名/授权参数）
- 这是 “Download full size” 按钮触发的真正大图直链。

## 后续可进一步优化（若需要更稳）
1) 直接捕获按钮直链：在 content script 监听/模拟点击 “Download full size image”，读取真实下载 URL（若可见）。
2) 若返回 blob：在页面上下文 `fetch(blobUrl)`，转 data URL 后交给 background 下载。
3) 对 `=s0-d-I` 的 HEAD/GET 取 `Content-Length`，若明显大于 `=s0`，则永久使用该模式；否则回退。

## 结论
- `=s0` 不是最终原图；`=s0-d-I` 才更接近 “Download full size” 的大文件。
- 代码现已优先尝试 `=s0-d-I` / `=s0-d`，并保持顺序命名与类型过滤，避免乱序和 SVG 混入。

