# 图片生成业务逻辑完善方案

## 问题分析

根据 log.txt 分析和用户反馈，发现以下关键问题：

### 1. ❌ 没有检测错误响应
- **问题**：当前代码只检测下载按钮数量，不检测 Gemini 是否返回错误消息
- **影响**：如果 Gemini 返回"系统原因没有生成"、"无法生成图片"等错误，代码无法识别，会继续等待超时
- **示例**：用户截图显示"系统原因没有生成"，但代码仍然等待下载按钮出现

### 2. ❌ 没有验证图片是否真正存在
- **问题**：只检查下载按钮，不检查图片元素是否真的存在且有效
- **影响**：可能检测到按钮但图片未加载完成，导致下载失败
- **风险**：下载空文件或损坏的图片

### 3. ❌ 重试机制可能重复提交
- **问题**：如果重试，可能会重复提交提示词，导致重复生成
- **影响**：浪费 API 配额，可能生成重复图片
- **风险**：用户看到重复的生成请求

### 4. ❌ 没有验证图片生成成功
- **问题**：只检查按钮数量，不验证图片是否真正生成成功
- **影响**：可能检测到按钮但图片生成失败
- **风险**：下载失败或下载错误内容

### 5. ❌ 下载时机不明确
- **问题**：应该在每张图片确认生成后再继续下一张，最后统一下载
- **影响**：如果中间某张失败，可能导致下载不完整

## 解决方案

### 1. ✅ 添加错误消息检测

**实现方式：**
```javascript
function detectErrorMessage() {
  // 检查页面文本中是否包含错误关键词
  const errorKeywords = [
    '无法生成',
    '系统原因',
    '生成失败',
    'I can\'t generate',
    'I\'m unable to',
    'Sorry, I can\'t',
    'unable to generate',
    'cannot generate'
  ];
  
  // 查找包含错误关键词的元素（在对话区域内）
  // 返回错误消息文本
}
```

**工作流程：**
1. 在等待生成时，定期检查页面是否出现错误消息
2. 如果检测到错误消息，立即抛出错误，不继续等待
3. 错误消息包含在异常信息中，便于用户了解失败原因

### 2. ✅ 添加图片存在性验证

**实现方式：**
```javascript
function verifyImageExists(targetCount) {
  // 1. 检查下载按钮数量
  // 2. 检查对应的图片元素是否存在
  // 3. 检查最近的图片是否加载完成
  // 4. 检查是否有错误消息
  // 返回：{ exists: boolean, reason: string, images: [], downloadBtns: [] }
}
```

**验证步骤：**
1. ✅ 下载按钮数量 >= targetCount
2. ✅ 有效图片数量 >= targetCount（排除头像、图标）
3. ✅ 图片已加载完成（`img.complete && img.naturalWidth > 0`）
4. ✅ 没有检测到错误消息

### 3. ✅ 改进重试机制（避免重复提交）

**实现方式：**
```javascript
async function submitPromptWithRetry(prompt, maxRetries = 3, promptIndex = null) {
  // 检查是否已经提交过这个提示词（使用 sessionStorage）
  const promptKey = `prompt_${promptIndex}_submitted`;
  const wasSubmitted = sessionStorage.getItem(promptKey);
  
  if (wasSubmitted) {
    console.log(`提示词 ${promptIndex + 1} 已提交过，跳过重复提交`);
    return;
  }
  
  // 提交后标记
  sessionStorage.setItem(promptKey, 'true');
}
```

**关键改进：**
- ✅ 使用 `sessionStorage` 记录已提交的提示词
- ✅ 如果已提交，跳过重复提交，只等待结果
- ✅ 重试时只等待，不重新提交提示词

### 4. ✅ 确保每张图片生成完成后再继续

**实现方式：**
```javascript
// 记录成功生成的图片索引
const successfullyGenerated = [];

for (let i = startFrom; i < currentPrompts.length; i++) {
  try {
    // 提交提示词
    await submitPromptWithRetry(currentPrompts[i], 3, i);
    
    // 等待生成完成（验证图片存在）
    const verification = await waitForGenerationWithRetry(displayIndex, 3, i);
    
    if (verification && verification.exists) {
      generationSuccess = true;
      successfullyGenerated.push(i);
      console.log(`第 ${displayIndex} 张图片生成成功`);
    }
  } catch (error) {
    // 记录失败，但继续下一张（除非用户停止）
    console.error(`第 ${displayIndex} 张图片生成失败:`, error.message);
  }
}
```

**关键改进：**
- ✅ 每张图片生成后立即验证
- ✅ 只有验证成功才标记为成功
- ✅ 失败后继续下一张（除非用户停止）
- ✅ 最终统计成功/失败数量

### 5. ✅ 最终统一下载所有成功生成的图片

**实现方式：**
```javascript
// 生成完成后，统一下载
if (!shouldStop) {
  console.log("所有图片生成完毕，开始批量下载...");
  await downloadAllGeneratedImages();
}
```

**下载逻辑：**
- ✅ 只下载成功生成的图片
- ✅ 验证图片已加载完成
- ✅ 应用高清化处理（=s0）
- ✅ 按顺序命名（page1.png, page2.png...）

## 完整工作流程

```
1. 用户点击"开始生成"
   ↓
2. 循环处理每个提示词：
   ├─ 检查是否已提交（避免重复）
   ├─ 提交提示词（如果未提交）
   ├─ 等待生成完成
   │  ├─ 检测下载按钮
   │  ├─ 验证图片存在
   │  ├─ 检查图片加载完成
   │  └─ 检测错误消息
   ├─ 验证成功 → 记录成功
   └─ 验证失败 → 记录失败，继续下一张
   ↓
3. 所有提示词处理完成
   ↓
4. 统计成功/失败数量
   ↓
5. 批量下载所有成功生成的图片
   ├─ 提取图片 URL
   ├─ 应用高清化处理（=s0）
   └─ 下载到指定目录
```

## 错误处理策略

### 1. 用户停止
- **行为**：立即停止，不继续下一张
- **处理**：抛出错误，清理状态

### 2. 检测到错误消息
- **行为**：立即失败，不继续等待
- **处理**：记录错误，继续下一张（除非是最后一次尝试）

### 3. 超时
- **行为**：重试最多3次
- **处理**：每次重试等待时间递增（3秒、6秒、9秒）

### 4. 图片验证失败
- **行为**：记录失败，继续下一张
- **处理**：最终统计时显示成功/失败数量

### 5. 所有图片生成失败
- **行为**：抛出错误，不进行下载
- **处理**：提示用户检查提示词或网络连接

## 关键代码改进

### 1. 错误消息检测
```javascript
function detectErrorMessage() {
  const errorKeywords = [
    '无法生成', '系统原因', '生成失败',
    'I can\'t generate', 'I\'m unable to',
    'Sorry, I can\'t', 'unable to generate'
  ];
  
  // 在对话区域内查找错误消息
  // 返回错误消息文本或 null
}
```

### 2. 图片验证
```javascript
function verifyImageExists(targetCount) {
  // 1. 检查下载按钮
  // 2. 检查图片元素
  // 3. 检查图片加载状态
  // 4. 检查错误消息
  return { exists: boolean, reason: string, images: [], downloadBtns: [] };
}
```

### 3. 避免重复提交
```javascript
async function submitPromptWithRetry(prompt, maxRetries, promptIndex) {
  // 使用 sessionStorage 记录已提交的提示词
  // 如果已提交，跳过重复提交
}
```

### 4. 智能重试
```javascript
async function waitForGenerationWithRetry(targetCount, maxRetries, promptIndex) {
  // 重试时不重新提交提示词
  // 只等待，检测错误消息
  // 根据错误类型决定是否继续重试
}
```

## 测试场景

### 场景1：正常生成
- ✅ 提交提示词
- ✅ 等待生成完成
- ✅ 验证图片存在
- ✅ 继续下一张
- ✅ 最终统一下载

### 场景2：检测到错误消息
- ✅ 提交提示词
- ✅ 检测到"系统原因没有生成"
- ✅ 立即失败，不等待超时
- ✅ 继续下一张
- ✅ 最终只下载成功生成的图片

### 场景3：图片未加载完成
- ✅ 检测到下载按钮
- ✅ 但图片未加载完成
- ✅ 继续等待直到加载完成
- ✅ 或超时后重试

### 场景4：重试机制
- ✅ 第一次失败
- ✅ 不重新提交提示词
- ✅ 只等待并检测
- ✅ 最多重试3次

### 场景5：部分成功
- ✅ 5张图片，3张成功，2张失败
- ✅ 最终只下载3张成功的图片
- ✅ 显示成功/失败统计

## 总结

通过以上改进，我们实现了：

1. ✅ **错误检测**：能够检测 Gemini 返回的错误消息
2. ✅ **图片验证**：验证图片是否真正存在且加载完成
3. ✅ **避免重复提交**：使用 sessionStorage 防止重复提交提示词
4. ✅ **智能重试**：重试时不重新提交，只等待并检测
5. ✅ **完整流程**：确保每张图片生成完成后再继续，最终统一下载

现在，即使 Gemini 返回错误消息、图片未加载完成、或网络延迟，代码都能正确处理，不会重复提交，也不会下载失败的图片。

