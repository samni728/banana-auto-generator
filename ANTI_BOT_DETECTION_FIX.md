# 反机器人检测问题修复

## 问题分析

### 关键发现

从log.txt第719-720行发现：
```
Access to XMLHttpRequest at 'https://www.google.com/sorry/index?continue=...'
GET https://www.google.com/sorry/index?continue=... net::ERR_FAILED
```

**这不是"连接暂时中断"，而是触发了Google的反机器人检测！**

### 问题时间线

1. **第4张图片生成成功**（line 642）
2. **提交第5张提示词**（line 713-715）
3. **触发Google的"sorry"页面**（line 719-720）

### 根本原因

1. **频繁的DOM查询**：当前版本每1秒检查一次，大量DOM操作被识别为机器人行为
2. **固定的操作模式**：没有随机延迟，行为模式太规律
3. **累积效应**：前几张的操作累积，在第4/5张时触发Google的检测阈值
4. **过度验证**：过多的图片验证和DOM查询操作

## 对比历史版本

### GitHub Commit 2384310（历史版本）

```javascript
// 更简单的逻辑
async function submitPrompt(text) {
  // 简单查询，不做过多次检查
  const input = document.querySelector('div[contenteditable="true"][role="textbox"]');
  input.focus();
  input.textContent = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(500);
  
  // 简单查找按钮
  const sendBtn = sendBtns.find(b => b.ariaLabel === "Send");
  if (sendBtn) sendBtn.click();
  
  await sleep(1000); // 只等待1秒
}

// 等待生成
async function waitForGeneration(index) {
  while (attempts < 120) { // 每500ms检查一次
    const downloadBtns = document.querySelectorAll('button[aria-label*="Download full size"]');
    if (downloadBtns.length >= index) break;
    await sleep(500);
  }
}

// 主流程
for (let i = 0; i < currentPrompts.length; i++) {
  await submitPrompt(currentPrompts[i]);
  await waitForGeneration(i + 1);
  await sleep(1500); // 每张后等待1.5秒
}
```

**特点**：
- ✅ 简单的DOM查询
- ✅ 较短的等待时间（1-1.5秒）
- ✅ 没有复杂的验证逻辑
- ✅ 没有频繁的状态同步

### 当前版本的问题

1. **过多的DOM查询**：
   - 输入框检查：最多10次循环检查
   - 按钮查找：多次查询
   - 图片验证：每1秒检查一次，包含多次DOM查询
   - 状态同步：每2秒同步一次

2. **固定的等待时间**：
   - 没有根据图片序号动态调整
   - 没有随机延迟

3. **复杂的验证逻辑**：
   - 多次图片验证
   - 错误检测
   - 状态同步

## 修复方案

### 1. 动态等待时间

```javascript
// 第4张后增加等待时间，避免触发反机器人检测
let waitTime = 3000; // 默认3秒
if (displayIndex >= 4) {
  waitTime = 6000; // 第4张后等待6秒
} else if (displayIndex >= 3) {
  waitTime = 4000; // 第3张后等待4秒
}

// 添加随机延迟（±500ms），模拟人类行为
const randomDelay = Math.random() * 1000 - 500;
await sleep(waitTime + randomDelay);
```

### 2. 减少DOM查询频率

```javascript
// 减少检测间隔：第4张后每2秒检查一次
const checkInterval = targetCount >= 4 ? 2000 : 1500;
await sleep(checkInterval);

// 减少输入框检查次数：从10次改为5次
for (let i = 0; i < 5; i++) {
  input = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (input) break;
  await sleep(500);
}
```

### 3. 简化验证逻辑

```javascript
// 减少图片验证次数：从3次改为2次
const allLoaded = await ensureImagesFullyLoaded(verification.images, 2);

// 简化输入框检查：只检查一次
if (!input.hasAttribute('contenteditable')) {
  await sleep(1000);
  input = document.querySelector('div[contenteditable="true"][role="textbox"]');
}
```

### 4. 动态提交等待

```javascript
// 第4张后增加提交后等待时间
let waitAfterSubmit = 1500; // 默认1.5秒
if (currentDisplayIndex >= 4) {
  waitAfterSubmit = 3000; // 第4张后等待3秒
}
await sleep(waitAfterSubmit);
```

## 关键改进

1. ✅ **动态等待时间**：第4张后等待6秒，第3张后等待4秒
2. ✅ **随机延迟**：添加±500ms随机延迟，模拟人类行为
3. ✅ **减少DOM查询**：减少检测频率和查询次数
4. ✅ **简化验证**：减少不必要的验证操作
5. ✅ **动态提交等待**：第4张后提交后等待3秒

## 工作流程对比

### 历史版本（简单）
```
提交提示词 → 等待1秒 → 等待生成（每500ms检查） → 等待1.5秒 → 下一张
```

### 当前版本（修复后）
```
提交提示词（第4张后等待3秒） → 等待生成（第4张后每2秒检查） → 
等待（第4张后6秒+随机延迟） → 下一张
```

## 预期效果

- ✅ 避免触发Google反机器人检测
- ✅ 第4/5张不再中断
- ✅ 更接近人类行为模式
- ✅ 减少DOM查询干扰

