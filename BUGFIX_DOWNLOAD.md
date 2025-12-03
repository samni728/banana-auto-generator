# Bug修复：第二张及后续图片下载失败

## 问题描述

用户反馈：第一张图片能成功下载到指定目录，但从第二张开始，图片就消失了，没有被保存。

## 根本原因

在 `background.js` 中，下载拦截逻辑存在严重bug：

1. 当检测到blob下载时，取消原下载并创建新下载
2. **问题**：新创建的下载也会触发 `chrome.downloads.onCreated` 事件
3. 这导致队列中的下一个项目被错误消耗
4. 结果：第2、3、4...张图片的下载信息被提前消耗，实际下载时队列已空

## 修复方案

### 1. 添加处理标志 (`processingDownload`)

```javascript
let processingDownload = false;

chrome.downloads.onCreated.addListener((downloadItem) => {
    // 只在未处理状态下处理
    if (downloadQueue.length > 0 && downloadItem.url.includes('blob:') && !processingDownload) {
        processingDownload = true;
        const downloadInfo = downloadQueue.shift();
        
        chrome.downloads.cancel(downloadItem.id, () => {
            chrome.downloads.download({
                url: downloadItem.url,
                filename: downloadInfo.filename,
                saveAs: false
            }, (newDownloadId) => {
                // 延迟重置标志，避免新下载触发事件
                setTimeout(() => {
                    processingDownload = false;
                }, 500);
            });
        });
    }
});
```

### 2. 增加等待时间

在 `content.js` 中增加等待时间，确保下载完成：

- 消息发送后等待 500ms
- 点击下载后等待 5000ms（从3000ms增加）
- 处理下一个提示词前等待 3000ms（从2000ms增加）

### 3. 添加日志

添加 `console.log` 以便调试：
- 记录队列长度
- 记录每次下载的文件名
- 记录错误信息

## 修改的文件

1. **background.js** - 完全重写下载拦截逻辑
2. **content.js** - 增加等待时间，添加消息发送延迟

## 测试建议

1. 重新加载扩展
2. 打开Chrome开发者工具 → Console
3. 测试生成3-5张图片
4. 检查控制台日志，确认每张图片都正确处理
5. 验证所有文件都保存到指定目录

## 预期结果

- ✅ page1.png - 保存成功
- ✅ page2.png - 保存成功
- ✅ page3.png - 保存成功
- ✅ page4.png - 保存成功
- ...所有后续图片都应该成功保存
