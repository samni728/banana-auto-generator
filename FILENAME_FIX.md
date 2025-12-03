# 下载文件名修复

## 问题

用户报告：填写了 `myppt` 作为子文件夹，但下载的文件使用随机blob ID作为文件名，而不是 `myppt/page1.png`。

从截图可以看到下载列表中的文件名都是随机字符串，说明重命名逻辑完全没有生效。

## 原因分析

**之前的方法（失败）**：
```javascript
// 1. 监听下载创建
chrome.downloads.onCreated.addListener((downloadItem) => {
    // 2. 取消原下载
    chrome.downloads.cancel(downloadItem.id, () => {
        // 3. 重新下载并指定文件名
        chrome.downloads.download({
            url: downloadItem.url,  // Blob URL
            filename: 'myppt/page1.png'
        });
    });
});
```

**问题**：
1. Blob URL可能在取消后失效
2. 取消时机太晚，原下载可能已经开始
3. 重新下载会触发新的onCreated事件，可能导致混乱

## 解决方案

使用 **`chrome.downloads.onDeterminingFilename`** API，这是Chrome推荐的重命名方法：

```javascript
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    if (downloadItem.url.includes('blob:') && downloadQueue.length > 0) {
        const downloadInfo = downloadQueue.shift();
        
        // 直接建议文件名，不需要取消重下载
        suggest({
            filename: downloadInfo.filename,  // 'myppt/page1.png'
            conflictAction: 'uniquify'
        });
    }
});
```

## 优势

1. ✅ **更可靠**：在Chrome确定文件名时介入，不需要取消下载
2. ✅ **不破坏下载**：原下载继续，只是改变文件名
3. ✅ **Blob URL有效**：不需要重新使用可能失效的URL
4. ✅ **避免重复触发**：不会创建新下载，不会触发新事件
5. ✅ **支持冲突处理**：`uniquify` 会自动处理文件名冲突

## 工作流程

```
用户点击下载
  ↓
Chrome开始下载 (blob URL)
  ↓
触发 onDeterminingFilename
  ↓
从队列获取自定义文件名
  ↓
suggest({ filename: 'myppt/page1.png' })
  ↓
Chrome使用建议的文件名保存
  ↓
文件保存到: 下载文件夹/myppt/page1.png
```

## 关键代码

### Background Script

```javascript
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    console.log('onDeterminingFilename triggered:', downloadItem.url);
    
    if (downloadItem.url.includes('blob:') && downloadQueue.length > 0) {
        const downloadInfo = downloadQueue.shift();
        console.log('Renaming download to:', downloadInfo.filename);
        
        // 建议自定义文件名
        suggest({
            filename: downloadInfo.filename,
            conflictAction: 'uniquify'
        });
        
        // 通知content script
        chrome.tabs.sendMessage(downloadInfo.tabId, {
            action: 'downloadStarted',
            downloadId: downloadItem.id,
            filename: downloadInfo.filename
        });
    } else {
        suggest(); // 使用默认文件名
    }
});
```

## 测试步骤

1. 重新加载插件
2. 在插件中输入 `myppt`
3. 输入提示词并开始生成
4. 检查下载文件夹，应该看到 `myppt/page1.png`, `myppt/page2.png` 等文件
