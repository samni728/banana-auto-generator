# 刷新按钮业务逻辑确认

## 业务逻辑验证

### 当前代码流程

```
1. startGeneration()
   ↓
2. submitPromptWithRetry()  ← 提交提示词
   ├─ 检查是否已提交（sessionStorage）
   ├─ 如果未提交 → 调用 submitPrompt()
   └─ 如果已提交 → 跳过，直接返回
   ↓
3. waitForGenerationWithRetry()  ← 等待生成完成
   ├─ 调用 waitForGeneration() 等待
   ├─ 如果成功 → 返回 ✅
   └─ 如果失败（超时/错误）
      ├─ 第一次/第二次尝试
      │  └─ ✅ 调用 clickRefreshButton()  ← 刷新按钮在这里！
      │     ├─ 等待 8-10 秒
      │     ├─ 检查是否生成成功
      │     └─ 如果成功 → 返回 ✅
      └─ 第三次尝试
         └─ 等待后重试（不点击刷新）
```

## ✅ 确认：刷新按钮使用时机正确

### 刷新按钮只在以下情况使用：

1. ✅ **提示词已提交**：`submitPromptWithRetry()` 已完成
2. ✅ **等待生成时超时**：`waitForGeneration()` 超时（60-180秒）
3. ✅ **检测到错误消息**：Gemini返回错误（如"系统原因"、"无法生成"）
4. ✅ **第一次/第二次尝试**：避免重复刷新

### 刷新按钮不会在以下情况使用：

1. ❌ **提示词未提交**：不会在 `submitPromptWithRetry()` 中调用
2. ❌ **提交失败**：提交提示词失败时会重试提交，不会点击刷新
3. ❌ **第三次尝试**：最后一次尝试不点击刷新，避免过度操作

## 代码验证

### 1. 提交提示词流程

```javascript
// startGeneration() 中的流程
await submitPromptWithRetry(currentPrompts[i], 3, i);  // ← 先提交
await waitForGenerationWithRetry(displayIndex, 3, i);  // ← 再等待
```

**确认**：刷新按钮在 `waitForGenerationWithRetry()` 中，不在 `submitPromptWithRetry()` 中 ✅

### 2. 等待生成流程

```javascript
async function waitForGenerationWithRetry(targetCount, maxRetries = 3, promptIndex = null) {
  // ...
  try {
    const verification = await waitForGeneration(targetCount);  // ← 等待生成
    if (verification.exists) {
      return verification;  // ← 成功，直接返回
    }
  } catch (error) {
    // 只有在这里（等待失败）才会调用刷新按钮
    if (error.message.includes('超时')) {
      if (attempt <= 2) {
        await clickRefreshButton();  // ← 刷新按钮在这里！
      }
    }
  }
}
```

**确认**：刷新按钮只在"等待生成失败"时调用 ✅

### 3. 提交提示词流程（不会调用刷新）

```javascript
async function submitPromptWithRetry(prompt, maxRetries = 3, promptIndex = null) {
  // 检查是否已提交
  if (wasSubmitted) {
    return;  // ← 已提交，跳过
  }
  
  // 提交提示词
  await submitPrompt(prompt);
  // ← 这里不会调用刷新按钮 ✅
}
```

**确认**：提交提示词时不会调用刷新按钮 ✅

## 业务逻辑总结

### ✅ 正确的使用场景

```
场景1：提示词已提交，等待超时
提交提示词 → 等待60秒 → 超时 → 点击刷新按钮 ✅

场景2：提示词已提交，检测到错误
提交提示词 → 检测到错误消息 → 点击刷新按钮 ✅

场景3：提示词已提交，等待成功
提交提示词 → 等待 → 成功 → 不点击刷新 ✅
```

### ❌ 不会出现的场景

```
场景1：提示词未提交
未提交 → 不会点击刷新 ✅

场景2：提交失败
提交失败 → 重试提交 → 不会点击刷新 ✅
```

## 结论

✅ **业务逻辑正确**：
- 刷新按钮只在"提示词已提交，但没有返回成功图片"的情况下使用
- 不会在"提示词未提交"或"提交失败"时使用
- 符合真实用户行为：用户看到没生成会点刷新，而不是重新输入

## 建议

当前逻辑已经正确，但可以添加更明确的日志说明：

```javascript
console.log(`[Content] ⏱️ 提示词已提交，但等待 ${timeoutSeconds} 秒后未检测到图片，尝试点击刷新按钮...`);
```

这样可以更清楚地表明：刷新按钮是在"已提交但未成功"的情况下使用的。

