# 下载完成检测改进

## 问题

用户指出使用固定5秒超时不可靠：
- 不同用户网络速度不同
- 大文件可能需要更长时间
- 固定延迟容易误判

## 解决方案

使用Chrome Downloads API的事件监听机制，真正等待下载完成。

## 实现细节

### 1. Background Script (background.js)

**监听下载状态变化**：
```javascript
chrome.downloads.onChanged.addListener((downloadDelta) => {
    if (downloadDelta.state && downloadDelta.state.current === 'complete') {
        // 下载完成，通知content script
        chrome.runtime.sendMessage({
            action: 'downloadComplete',
            downloadId: downloadDelta.id
        });
    } else if (downloadDelta.state && downloadDelta.state.current === 'interrupted') {
        // 下载失败
        chrome.runtime.sendMessage({
            action: 'downloadFailed',
            downloadId: downloadDelta.id
        });
    }
});
```

### 2. Content Script (content.js)

**等待下载完成事件**：
```javascript
async function downloadImage(pageNumber) {
    // 设置监听器
    const downloadPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('下载超时（60秒）'));
        }, 60000); // 60秒作为后备超时

        const messageListener = (message) => {
            if (message.action === 'downloadComplete') {
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageListener);
                resolve();
            } else if (message.action === 'downloadFailed') {
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageListener);
                reject(new Error('下载失败'));
            }
        };

        chrome.runtime.onMessage.addListener(messageListener);
    });

    // 点击下载
    clickableElement.click();

    // 等待实际完成
    await downloadPromise;
}
```

## 优势

1. ✅ **可靠性**：真正等待下载完成，不依赖固定延迟
2. ✅ **适应性**：自动适应不同网络速度
3. ✅ **效率**：快速网络不需要等待固定时间
4. ✅ **安全**：仍有60秒后备超时防止永久卡住
5. ✅ **状态感知**：能检测下载失败并报错

## 工作流程

1. Content script准备下载信息
2. 设置完成监听器
3. 点击下载按钮
4. Background script拦截并重命名下载
5. Chrome开始下载文件
6. `chrome.downloads.onChanged` 检测到状态变为 'complete'
7. Background发送 'downloadComplete' 消息
8. Content script收到消息，继续下一张

## 超时处理

- 正常情况：等待实际完成事件（可能几秒到几十秒）
- 异常情况：60秒后超时，抛出错误
- 这比固定5秒更合理，给慢速网络足够时间
