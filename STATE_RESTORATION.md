# 状态恢复功能

## 问题

用户报告：点击"开始生成"后，如果关闭插件弹窗再重新打开，UI显示的是"开始生成"按钮，而不是"停止"按钮。这导致用户无法看到当前的生成进度，也无法停止正在运行的任务。

## 原因

Popup窗口每次打开都是全新的实例，之前的状态（`isRunning`、进度等）都会丢失。而content script在后台继续运行，但popup不知道它的状态。

## 解决方案

### 1. Content Script添加状态查询接口

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getStatus') {
        sendResponse({
            isGenerating: isGenerating,
            current: currentIndex,
            total: currentPrompts.length
        });
        return true;
    }
});
```

### 2. Popup初始化时查询状态

```javascript
document.addEventListener('DOMContentLoaded', async () => {
    // ... 加载保存的数据 ...
    
    // 查询content script的当前状态
    try {
        const response = await chrome.tabs.sendMessage(currentTab.id, {
            action: 'getStatus'
        });
        
        if (response && response.isGenerating) {
            // 恢复运行状态
            isRunning = true;
            elements.startBtn.style.display = 'none';
            elements.stopBtn.style.display = 'block';
            elements.prompts.disabled = true;
            
            // 恢复进度
            updateProgress(response.current, response.total);
            showStatus(`正在生成第 ${response.current} 张图片...`, 'processing');
        }
    } catch (error) {
        // 没有正在运行的任务
    }
});
```

## 工作流程

```
用户打开Popup
  ↓
发送 getStatus 消息到 content script
  ↓
Content script返回当前状态:
  - isGenerating: true/false
  - current: 当前进度
  - total: 总数
  ↓
Popup根据返回的状态恢复UI:
  - 显示/隐藏按钮
  - 更新进度条
  - 显示状态文本
```

## 效果

### 之前
1. 点击"开始生成"
2. 关闭popup
3. 重新打开popup
4. ❌ 显示"开始生成"按钮（错误状态）
5. ❌ 看不到进度
6. ❌ 无法停止任务

### 现在
1. 点击"开始生成"
2. 关闭popup
3. 重新打开popup
4. ✅ 显示"停止"按钮（正确状态）
5. ✅ 显示当前进度（如"正在生成第 2 张图片..."）
6. ✅ 可以点击停止

## 关键改进

1. ✅ **状态持久化**：content script的状态在popup关闭后仍然保持
2. ✅ **状态同步**：popup打开时主动查询并恢复状态
3. ✅ **进度可见**：用户随时可以查看当前进度
4. ✅ **可控性**：用户可以随时停止任务

## 测试步骤

1. 打开插件，点击"开始生成"
2. 等待第一张图片开始生成
3. 点击插件外部关闭popup
4. 重新点击插件图标打开popup
5. 验证：
   - ✅ 显示"停止"按钮
   - ✅ 显示进度条和当前进度
   - ✅ 显示"正在生成第 X 张图片..."
   - ✅ 可以点击"停止"按钮
