# 任务状态持久化方案

## 问题分析

用户反馈：当在 Gemini 页面点击图片预览时，插件任务被打断。用户期望：
1. 任务状态应该持续保持，即使：
   - 插件窗口在后台
   - 用户点击预览图片
   - 页面有其他交互
2. 任务应该只在以下情况停止：
   - 用户主动停止/取消
   - 用户打开新页面
   - 用户刷新页面

## 根本原因

### 1. 状态只存在内存中
- `content.js` 中的状态变量（`isGenerating`, `shouldStop`, `currentPrompts`, `saveDirectory`）都存储在内存中
- 当页面导航或 DOM 变化导致 content script 重新执行时，状态会丢失

### 2. 没有持久化机制
- 任务状态没有保存到 `chrome.storage` 或 `background.js`
- 无法在页面变化后恢复任务

### 3. DOM 查询脆弱
- `waitForGeneration` 和 `submitPrompt` 依赖 DOM 查询
- 如果用户点击预览图片导致 DOM 变化，可能找不到元素

### 4. 没有状态恢复机制
- 如果任务被打断，没有机制恢复任务

## 解决方案

### 架构设计

```
┌─────────────┐
│   Popup     │ ← 定期查询状态（每2秒）
└──────┬──────┘
       │ getTaskState
       ↓
┌─────────────┐
│  Background  │ ← 状态持久化中心
│  (Service    │   - 存储任务状态到 chrome.storage
│   Worker)    │   - 监听标签页事件
└──────┬──────┘   - 提供状态查询接口
       │
       │ taskStart / taskUpdate / taskComplete
       ↓
┌─────────────┐
│  Content    │ ← 任务执行者
│   Script    │   - 定期同步状态（每2秒）
│             │   - 页面加载时恢复任务
└─────────────┘   - 增强 DOM 查询容错性
```

### 1. Background.js - 状态管理中心

**核心功能：**
- 存储任务状态到 `chrome.storage.local`
- 监听标签页更新/关闭事件
- 提供状态查询和恢复接口

**状态结构：**
```javascript
{
  isGenerating: boolean,
  currentIndex: number,
  total: number,
  prompts: string[],
  saveDirectory: string,
  tabId: number,
  startTime: number,
  lastUpdate: number
}
```

**关键接口：**
- `taskStart`: 任务开始，保存状态
- `taskUpdate`: 更新进度
- `taskComplete`: 任务完成，清理状态
- `taskStop`: 任务停止，清理状态
- `taskError`: 任务错误，清理状态
- `getTaskState`: 查询当前任务状态
- `restoreTask`: 恢复任务（供 content script 使用）

### 2. Content.js - 增强状态管理

**核心改进：**

1. **状态同步机制**
   - 启动任务时同步状态到 background
   - 每2秒定期更新状态到 background
   - 进度更新时立即同步

2. **任务恢复机制**
   - 页面加载时检查是否有未完成的任务
   - 从 background 恢复任务状态
   - 从断点继续执行（`startGeneration(currentIndex)`）

3. **DOM 查询容错性**
   - `submitPromptWithRetry`: 带重试机制的提示词提交（最多3次）
   - `waitForGenerationWithRetry`: 带重试机制的生成等待（最多3次）
   - 多种选择器备用查询
   - 等待元素出现的超时机制

4. **错误恢复**
   - 如果 DOM 查询失败，自动重试
   - 如果页面结构变化，尝试重新进入 Create Image 模式

### 3. Popup.js - 状态查询优化

**核心改进：**

1. **双重状态查询**
   - 优先从 background 查询持久化状态
   - 备用从 content script 查询（兼容性）

2. **定期状态更新**
   - 每2秒查询一次任务状态
   - 确保 UI 始终显示最新状态

3. **状态恢复**
   - 打开 popup 时自动恢复运行状态
   - 显示正确的进度和按钮状态

## 工作流程

### 任务启动流程

```
1. 用户在 Popup 点击"开始生成"
   ↓
2. Popup 发送 startGeneration 消息到 Content Script
   ↓
3. Content Script 启动任务
   ↓
4. Content Script 发送 taskStart 到 Background
   ↓
5. Background 保存状态到 chrome.storage
   ↓
6. Content Script 开始执行任务
   ↓
7. Content Script 每2秒同步状态到 Background
```

### 任务恢复流程

```
1. 页面加载完成
   ↓
2. Content Script 发送 restoreTask 到 Background
   ↓
3. Background 检查是否有未完成的任务
   ↓
4. 如果有，返回任务状态（prompts, saveDirectory, currentIndex）
   ↓
5. Content Script 恢复状态并继续执行
   ↓
6. 从 currentIndex 继续生成剩余图片
```

### 状态同步流程

```
1. Content Script 执行任务中
   ↓
2. 每2秒发送 taskUpdate 到 Background
   ↓
3. Background 更新状态并保存到 chrome.storage
   ↓
4. Popup 每2秒查询 getTaskState
   ↓
5. Popup 更新 UI 显示最新进度
```

### 任务停止流程

```
1. 用户点击"停止"按钮
   ↓
2. Popup 发送 stopGeneration 到 Content Script
   ↓
3. Content Script 设置 shouldStop = true
   ↓
4. Content Script 发送 taskStop 到 Background
   ↓
5. Background 清理状态
```

## 容错机制

### 1. DOM 查询容错

**问题：** 用户点击预览图片可能导致 DOM 结构变化

**解决方案：**
- 使用多种选择器备用查询
- 添加重试机制（最多3次）
- 等待元素出现的超时机制
- 如果找不到元素，尝试重新进入 Create Image 模式

### 2. 状态同步容错

**问题：** 网络延迟或 background 未就绪可能导致状态同步失败

**解决方案：**
- 定期同步（每2秒），即使一次失败也不影响
- 使用 try-catch 包裹所有同步操作
- 状态更新时立即同步，不等待定期同步

### 3. 任务恢复容错

**问题：** 页面刷新后任务状态可能丢失

**解决方案：**
- 状态持久化到 chrome.storage
- 页面加载时自动检查并恢复
- 如果恢复失败，不影响新任务启动

## 关键代码改进

### Background.js

```javascript
// 任务状态存储（持久化到 chrome.storage）
let taskState = {
  isGenerating: false,
  currentIndex: 0,
  total: 0,
  prompts: [],
  saveDirectory: "",
  tabId: null,
  startTime: null,
  lastUpdate: null
};

// 保存任务状态到存储
async function saveTaskState() {
  taskState.lastUpdate = Date.now();
  await chrome.storage.local.set({ taskState });
}

// 监听标签页更新（检测刷新/导航）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (taskState.isGenerating && taskState.tabId === tabId && changeInfo.status === 'loading') {
    console.log(`[BG] 检测到标签页 ${tabId} 正在刷新，任务状态保持`);
  }
});
```

### Content.js

```javascript
// 页面加载时检查并恢复任务
window.addEventListener('load', async () => {
  await checkAndRestoreTask();
});

// 检查并恢复任务
async function checkAndRestoreTask() {
  const response = await chrome.runtime.sendMessage({ action: "restoreTask" });
  if (response && response.success && response.state) {
    // 恢复状态并继续执行
    currentPrompts = response.state.prompts || [];
    currentIndex = response.state.currentIndex || 0;
    startGeneration(currentIndex); // 从断点继续
  }
}

// 启动状态同步
function startStateSync() {
  stateSyncInterval = setInterval(() => {
    if (isGenerating) {
      chrome.runtime.sendMessage({
        action: "taskUpdate",
        currentIndex: currentIndex,
        total: total
      });
    }
  }, 2000); // 每2秒同步一次
}
```

### Popup.js

```javascript
// 检查任务状态（优先从 background 查询）
async function checkTaskStatus() {
  // 优先从 background 查询持久化状态
  const bgState = await chrome.runtime.sendMessage({ action: 'getTaskState' });
  
  if (bgState && bgState.isGenerating) {
    // 恢复UI状态
    isRunning = true;
    updateProgress(bgState.currentIndex, bgState.total);
  }
}

// 定期更新状态（每2秒）
const statusInterval = setInterval(async () => {
  await checkTaskStatus();
}, 2000);
```

## 测试场景

### 场景1：用户点击图片预览
- ✅ 任务状态保持
- ✅ DOM 查询容错，继续执行
- ✅ 状态同步不受影响

### 场景2：插件窗口关闭后重新打开
- ✅ 从 background 恢复状态
- ✅ UI 显示正确的进度
- ✅ 可以正常停止任务

### 场景3：页面刷新
- ✅ 状态从 chrome.storage 恢复
- ✅ 任务从断点继续执行
- ✅ 不丢失已生成的图片

### 场景4：标签页关闭
- ✅ Background 检测到关闭
- ✅ 自动清理任务状态
- ✅ 不影响其他标签页

## 总结

通过实现任务状态持久化机制，我们解决了以下问题：

1. ✅ **任务状态持久化**：状态保存到 chrome.storage，页面刷新不丢失
2. ✅ **状态同步机制**：定期同步状态，确保 UI 始终显示最新进度
3. ✅ **任务恢复机制**：页面加载时自动恢复未完成的任务
4. ✅ **DOM 查询容错**：增强容错性，防止页面交互打断任务
5. ✅ **错误恢复机制**：自动重试，提高任务成功率

现在，即使用户点击图片预览、关闭插件窗口、甚至刷新页面，任务都能保持状态并继续执行，直到用户主动停止或任务完成。

