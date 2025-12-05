# 进度条回退和频繁中断问题修复

## 问题分析

### 1. 进度条回退问题

**现象**：生成第3张完成，但进度条显示第2张

**根本原因**：
- `getStatus` 返回的是 `currentIndex`（数组索引，0-based），而不是 `displayIndex`（显示索引，1-based）
- `checkTaskStatus` 每2秒查询一次，可能查询到旧的进度值
- 没有确保进度只增不减的逻辑

**修复方案**：
- `getStatus` 返回 `displayIndex`（currentIndex + 1）
- `checkTaskStatus` 中添加进度比较逻辑，确保进度只增不减
- 使用 `lastDisplayedProgress` 记录当前显示的进度

### 2. 频繁中断问题

**现象**：在第4或第5张时，Gemini返回"由于当前生图工具连接暂时中断"

**根本原因**（对比GitHub历史版本）：
- **提交频率太快**：当前代码在生成成功后只等待2秒就提交下一个，可能触发 Gemini 的速率限制
- **检测太频繁**：`waitForGeneration` 每500ms检查一次，可能干扰正常流程
- **错误检测误判**：`detectErrorMessage` 可能误判了设计草图提示为错误
- **状态同步干扰**：每2秒同步状态可能干扰了正常流程

**修复方案**：
1. **增加提交间隔**：从2秒增加到4秒，给 Gemini 足够的处理时间
2. **减少检测频率**：从500ms改为1000ms，减少DOM查询
3. **优化错误检测**：
   - 只检测最新的3条消息
   - 排除设计草图提示（"设计草图"、"MJ 提示词"等）
   - 专门检测中断消息（"连接暂时中断"）
4. **提交前检查**：确保输入框可用后再提交

## 关键修复

### 1. 进度条修复

**content.js**：
```javascript
// 返回 displayIndex（1-based）而不是 currentIndex（0-based）
const displayIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
sendResponse({
  isGenerating,
  current: displayIndex, // 使用 displayIndex 确保进度正确
  total: total,
});
```

**popup.js**：
```javascript
// 记录当前显示的进度（确保只增不减）
let lastDisplayedProgress = 0;

// 确保进度只增不减
const newProgress = Math.max(message.current, lastDisplayedProgress);
if (newProgress > lastDisplayedProgress) {
  lastDisplayedProgress = newProgress;
  updateProgress(newProgress, message.total);
}
```

### 2. 提交节奏优化

**增加等待时间**：
```javascript
if (generationSuccess) {
  // 成功生成后，等待更长时间确保图片完全渲染和稳定
  // 增加等待时间，避免触发 Gemini 的速率限制
  await sleep(4000); // 从 2 秒增加到 4 秒
}
```

**提交前检查**：
```javascript
// 检查输入框是否可用（确保上一个请求已完成）
while (checkCount < 10) {
  // 检查输入框是否可编辑
  if (!input.hasAttribute('contenteditable') || 
      input.getAttribute('contenteditable') !== 'true') {
    await sleep(500);
    checkCount++;
    continue;
  }
  break; // 输入框可用
}
```

### 3. 减少检测频率

```javascript
// 从 500ms 改为 1000ms，减少检测频率
await sleep(1000);

// 超时时间从 90 秒增加到 120 秒
async function waitForGeneration(targetCount, timeoutSeconds = 120) {
  const maxAttempts = timeoutSeconds; // 每 1 秒检查一次
}
```

### 4. 优化错误检测

```javascript
// 只检查最新的3条消息（避免检查太多旧消息）
const messageContainers = Array.from(document.querySelectorAll(
  '[class*="message"], [class*="response"], [class*="chat-message"]'
)).reverse().slice(0, 3);

// 排除的关键词（这些不是错误）
const excludeKeywords = [
  '设计草图', // 排除设计草图提示
  'MJ 提示词', // 排除MJ提示词
  'Midjourney', // 排除Midjourney相关
  'visual design sketch' // 排除设计草图英文
];

// 专门检测中断消息
const errorKeywords = [
  '连接暂时中断', // 新增：检测中断消息
  '生图工具连接暂时中断', // 新增：检测中断消息
  // ...
];
```

## 对比历史版本

### GitHub Commit 2384310 的特点

根据 [GitHub commit](https://github.com/samni728/banana-auto-generator/commit/2384310fb128534cdcb53cd3e3384e2654accf3f)：

1. **Event-based download completion detection**：基于事件的检测，更简单直接
2. **更简单的流程**：没有复杂的重试和验证逻辑
3. **可能等待时间更长**：给 Gemini 足够的处理时间

### 当前版本的问题

1. **过度优化**：添加了太多验证和重试逻辑，可能干扰了正常流程
2. **检测太频繁**：每500ms检查一次，可能触发某些限制
3. **提交太快**：只等待2秒就提交下一个，可能触发速率限制

## 修复后的工作流程

```
1. 提交提示词
   ↓
2. 等待生成完成（每1秒检查一次，最多120秒）
   ├─ 检测下载按钮
   ├─ 验证图片存在
   ├─ 确保图片加载完成
   └─ 检测错误消息（只检查最新3条，排除设计草图）
   ↓
3. 生成成功
   ├─ 额外等待 1 秒（确保稳定）
   ├─ 最终验证
   └─ 更新进度（确保只增不减）
   ↓
4. 等待 4 秒（给 Gemini 足够的处理时间）
   ↓
5. 检查输入框是否可用
   ↓
6. 提交下一个提示词
```

## 关键改进点

1. ✅ **进度只增不减**：使用 `lastDisplayedProgress` 确保进度正确
2. ✅ **增加提交间隔**：从2秒增加到4秒，避免触发限流
3. ✅ **减少检测频率**：从500ms改为1000ms，减少干扰
4. ✅ **优化错误检测**：只检测最新消息，排除设计草图提示
5. ✅ **提交前检查**：确保输入框可用后再提交

现在系统应该能够：
- 正确显示进度，不会回退
- 避免频繁触发中断
- 更稳健地处理多张图片生成

