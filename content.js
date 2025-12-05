// Content script - 任务状态持久化版本

let isGenerating = false;
let shouldStop = false;
let currentPrompts = [];
let saveDirectory = "";
let currentIndex = 0;
let total = 0;

// 状态同步到 background（定期更新）
let stateSyncInterval = null;

// 页面加载时检查并恢复任务
window.addEventListener('load', async () => {
  await checkAndRestoreTask();
});

// 如果页面已经加载完成，立即检查
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  checkAndRestoreTask();
}

// 检查并恢复任务
async function checkAndRestoreTask() {
  try {
    const response = await chrome.runtime.sendMessage({ action: "restoreTask" });
    if (response && response.success && response.state) {
      console.log("[Content] 检测到未完成的任务，正在恢复...", response.state);
      currentPrompts = response.state.prompts || [];
      saveDirectory = response.state.saveDirectory || "";
      currentIndex = response.state.currentIndex || 0;
      total = response.state.total || 0;
      shouldStop = false;
      
      // 如果任务未完成，继续执行
      if (currentIndex < total && !isGenerating) {
        console.log(`[Content] 恢复任务：从第 ${currentIndex + 1} 张继续`);
        startGeneration(currentIndex); // 从断点继续
      }
    }
  } catch (error) {
    console.log("[Content] 无待恢复任务或 background 未就绪");
  }
}

// 启动状态同步
function startStateSync() {
  if (stateSyncInterval) clearInterval(stateSyncInterval);
  stateSyncInterval = setInterval(() => {
    if (isGenerating) {
      chrome.runtime.sendMessage({
        action: "taskUpdate",
        currentIndex: currentIndex,
        total: total
      }).catch(err => console.error("[Content] 状态同步失败:", err));
    }
  }, 2000); // 每2秒同步一次
}

// 停止状态同步
function stopStateSync() {
  if (stateSyncInterval) {
    clearInterval(stateSyncInterval);
    stateSyncInterval = null;
  }
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startGeneration") {
    // 清理之前的提交记录（开始新任务）
    clearSubmissionRecords();
    
    currentPrompts = message.prompts || [];
    saveDirectory = message.saveDirectory || "";
    currentIndex = 0;
    total = currentPrompts.length;
    shouldStop = false;
    
    // 同步状态到 background
    chrome.runtime.sendMessage({
      action: "taskStart",
      prompts: currentPrompts,
      saveDirectory: saveDirectory,
      total: total
    });
    
    startGeneration(0);
  } else if (message.action === "stopGeneration") {
    shouldStop = true;
    isGenerating = false;
    stopStateSync();
    
    // 清理提交记录（停止任务）
    clearSubmissionRecords();
    
    // 通知 background 任务已停止
    chrome.runtime.sendMessage({ action: "taskStop" });
  } else if (message.action === "clearSubmissionRecords") {
    // 清理提交记录（响应清空按钮）
    clearSubmissionRecords();
    sendResponse({ success: true });
    return true;
  } else if (message.action === "getStatus") {
    // 返回 displayIndex（1-based）而不是 currentIndex（0-based）
    const displayIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    sendResponse({
      isGenerating,
      current: displayIndex, // 使用 displayIndex 确保进度正确
      total: total,
    });
    return true;
  }
});

// 进入 Create Image (nano banana) 模式
async function ensureCreateImageMode() {
  const input = document.querySelector(
    'div[contenteditable="true"][role="textbox"][data-placeholder*="Describe your image"]'
  );
  if (input) return;

  const btns = Array.from(document.querySelectorAll("button"));
  const createBtn = btns.find((b) =>
    (b.textContent || "").includes("Create Image")
  );

  if (createBtn) {
    createBtn.click();
    await sleep(1000);
  }
}

// 主流程：先生成，后统一下载
// startFrom: 从第几张开始（用于恢复任务）
async function startGeneration(startFrom = 0) {
  if (isGenerating || shouldStop || !currentPrompts.length) return;
  if (startFrom >= currentPrompts.length) {
    console.log("[Content] 所有任务已完成，开始下载...");
    await downloadAllGeneratedImages();
    return;
  }
  
  isGenerating = true;
  currentIndex = startFrom;
  startStateSync(); // 启动状态同步

  try {
    await ensureCreateImageMode();
    await sleep(500);

    // 第一阶段：循环生成（从断点继续）
    // 记录成功生成的图片索引
    const successfullyGenerated = [];
    
    for (let i = startFrom; i < currentPrompts.length; i++) {
      if (shouldStop) {
        console.log("[Content] 用户停止任务");
        break;
      }
      
      currentIndex = i;
      const displayIndex = i + 1;
      let generationSuccess = false;

      // 更新进度（通知 popup）
      chrome.runtime.sendMessage({
        action: "updateProgress",
        current: displayIndex,
        total: currentPrompts.length,
        status: "generating"
      });

      // 同步状态到 background（使用 displayIndex，1-based）
      chrome.runtime.sendMessage({
        action: "taskUpdate",
        currentIndex: displayIndex, // displayIndex 是 1-based，确保进度正确
        total: currentPrompts.length
      });

      try {
        // 提交提示词（增强容错性，避免重复提交）
        await submitPromptWithRetry(currentPrompts[i], 3, i);
        
        // 等待生成完成（增强容错性，验证图片存在）
        const verification = await waitForGenerationWithRetry(displayIndex, 3, i);
        
        if (verification && verification.exists) {
          // 再次确认图片完全加载完成（额外等待，确保稳定）
          console.log(`[Content] 第 ${displayIndex} 张图片验证成功，等待图片稳定...`);
          await sleep(1000); // 额外等待 1 秒，确保图片完全渲染
          
          // 最终验证：确保图片仍然存在且已加载
          const finalVerification = verifyImageExists(displayIndex);
          if (finalVerification.exists) {
            generationSuccess = true;
            successfullyGenerated.push(i);
            console.log(`[Content] 第 ${displayIndex} 张图片生成成功并已完全加载`);
            
            // 更新进度为成功
            chrome.runtime.sendMessage({
              action: "updateProgress",
              current: displayIndex,
              total: currentPrompts.length,
              status: "success"
            });
          } else {
            throw new Error(`第 ${displayIndex} 张图片最终验证失败: ${finalVerification.reason}`);
          }
        } else {
          throw new Error(`第 ${displayIndex} 张图片验证失败`);
        }
      } catch (error) {
        console.error(`[Content] 第 ${displayIndex} 张图片生成失败:`, error.message);
        
        // 更新进度为失败
        chrome.runtime.sendMessage({
          action: "updateProgress",
          current: displayIndex,
          total: currentPrompts.length,
          status: "error",
          error: error.message
        });
        
        // 决定是否继续：如果是关键错误（如用户停止），则停止；否则继续下一张
        if (error.message.includes('用户停止')) {
          throw error; // 用户停止，抛出错误
        }
        
        // 其他错误继续下一张
        console.warn(`[Content] 第 ${displayIndex} 张图片生成失败，继续下一张...`);
      }
      
      if (generationSuccess) {
        // 成功生成后，等待更长时间确保图片完全渲染和稳定
        // 增加等待时间，避免触发 Gemini 的速率限制
        await sleep(4000); // 增加到 4 秒，给 Gemini 足够的处理时间
      } else {
        await sleep(2000); // 失败后等待稍长，避免连续失败
      }
    }
    
    // 记录成功生成的图片数量
    console.log(`[Content] 生成完成：成功 ${successfullyGenerated.length}/${currentPrompts.length} 张`);
    
    // 如果所有图片都生成失败，抛出错误
    if (successfullyGenerated.length === 0 && currentPrompts.length > 0) {
      throw new Error("所有图片生成失败，请检查提示词或网络连接");
    }

    // 第二阶段：批量高清下载
    if (!shouldStop) {
      console.log("所有图片生成完毕，开始批量下载...");
      await downloadAllGeneratedImages();

      // 通知完成
      chrome.runtime.sendMessage({
        action: "generationComplete",
        total: currentPrompts.length,
      });
      
      chrome.runtime.sendMessage({
        action: "taskComplete"
      });
    }
  } catch (error) {
    console.error("[Content] 任务错误:", error);
    
    // 通知错误
    chrome.runtime.sendMessage({
      action: "generationError",
      error: error.message || String(error),
    });
    
    chrome.runtime.sendMessage({
      action: "taskError",
      error: error.message || String(error)
    });
  } finally {
    isGenerating = false;
    stopStateSync();
    // 任务结束时清理提交记录
    clearSubmissionRecords();
  }
}

// 清理所有提交记录
function clearSubmissionRecords() {
  // 清理所有 prompt_*_submitted 记录
  const keysToRemove = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('prompt_') && key.endsWith('_submitted')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => sessionStorage.removeItem(key));
  console.log(`[Content] 已清理 ${keysToRemove.length} 条提交记录`);
}

// 提交提示词（带重试机制，但避免重复提交）
async function submitPromptWithRetry(prompt, maxRetries = 3, promptIndex = null) {
  // 检查是否已经提交过这个提示词（避免重复提交）
  const promptKey = `prompt_${promptIndex}_submitted`;
  const wasSubmitted = sessionStorage.getItem(promptKey);
  
  if (wasSubmitted) {
    console.log(`[Content] 提示词 ${promptIndex + 1} 已提交过，跳过重复提交`);
    // 等待一下，确保之前的提交已处理
    await sleep(2000);
    return;
  }
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await submitPrompt(prompt);
      // 标记已提交
      if (promptIndex !== null) {
        sessionStorage.setItem(promptKey, 'true');
      }
      return; // 成功
    } catch (error) {
      console.warn(`[Content] 提交提示词失败 (尝试 ${attempt}/${maxRetries}):`, error);
      if (attempt === maxRetries) {
        throw new Error(`提交提示词失败: ${error.message}`);
      }
      await sleep(2000 * attempt); // 递增延迟
    }
  }
}

// 提交提示词
async function submitPrompt(prompt) {
  // 容错查询：等待输入框出现
  let input = null;
  for (let i = 0; i < 10; i++) {
    input = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (input) break;
    await sleep(500);
  }
  
  if (!input) {
    // 尝试进入 Create Image 模式
    await ensureCreateImageMode();
    await sleep(1000);
    input = document.querySelector('div[contenteditable="true"][role="textbox"]');
  }
  
  if (!input) throw new Error("找不到输入框");

  // 检查输入框是否可用（确保上一个请求已完成）
  let checkCount = 0;
  while (checkCount < 10) {
    // 检查输入框是否可编辑
    if (!input.hasAttribute('contenteditable') || input.getAttribute('contenteditable') !== 'true') {
      await sleep(500);
      checkCount++;
      continue;
    }
    
    // 检查是否有禁用状态
    if (input.closest('[disabled]') || input.hasAttribute('disabled')) {
      await sleep(500);
      checkCount++;
      continue;
    }
    
    break; // 输入框可用
  }

  input.focus();
  input.textContent = prompt;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(800); // 稍微增加等待时间，确保输入完成

  const allBtns = Array.from(document.querySelectorAll("button"));
  let sendBtn = allBtns.find(
    (b) =>
      !b.disabled &&
      (b.getAttribute("aria-label") === "Send" ||
        (b.textContent && b.textContent.includes("Send")))
  );

  if (!sendBtn) {
    sendBtn = document.querySelector('button[data-testid="send-button"]');
  }

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
    });
    input.dispatchEvent(enter);
  }

  // 增加等待时间，确保请求已发送
  await sleep(1500);
}

// 快速检查图片是否已生成（不等待，立即返回结果）
function quickCheckImageExists(targetCount) {
  return verifyImageExists(targetCount);
}

// 等待生成完成（带重试机制，但不重复提交提示词）
async function waitForGenerationWithRetry(targetCount, maxRetries = 3, promptIndex = null) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const verification = await waitForGeneration(targetCount);
      // 成功！确保图片真正加载完成
      if (verification.exists) {
        // 再次验证图片加载完成（确保稳定性）
        await ensureImagesFullyLoaded(verification.images);
        return verification;
      }
    } catch (error) {
      lastError = error;
      console.warn(`[Content] 等待生成失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      
      // 检查是否是用户停止
      if (error.message.includes('用户停止')) {
        throw error; // 用户停止，不重试
      }
      
      // 检查是否是明确的错误消息（如"系统原因"）
      if (error.message.includes('错误消息') || error.message.includes('无法生成')) {
        // 如果是最后一次尝试，抛出错误
        if (attempt === maxRetries) {
          throw new Error(`生成第 ${targetCount} 张图片失败: ${error.message}`);
        }
        // 否则等待后重试（不重新提交提示词，只等待）
        console.log(`[Content] 检测到错误，等待 ${3 * attempt} 秒后重试...`);
        await sleep(3000 * attempt);
        
        // 重试前先快速检查一次，可能图片已经生成了
        const quickCheck = quickCheckImageExists(targetCount);
        if (quickCheck.exists) {
          console.log(`[Content] 重试前检查：图片已生成！`);
          await ensureImagesFullyLoaded(quickCheck.images);
          return quickCheck;
        }
        continue;
      }
      
      // 如果是超时，且不是最后一次尝试
      if (attempt < maxRetries) {
        console.log(`[Content] 超时，等待 ${3 * attempt} 秒后重试...`);
        await sleep(3000 * attempt);
        
        // 重试前先快速检查一次，可能图片已经生成了
        const quickCheck = quickCheckImageExists(targetCount);
        if (quickCheck.exists) {
          console.log(`[Content] 重试前检查：图片已生成！`);
          await ensureImagesFullyLoaded(quickCheck.images);
          return quickCheck;
        }
        continue;
      }
    }
  }
  
  // 所有重试都失败，最后再检查一次
  const finalCheck = quickCheckImageExists(targetCount);
  if (finalCheck.exists) {
    console.log(`[Content] 最终检查：图片已生成！`);
    await ensureImagesFullyLoaded(finalCheck.images);
    return finalCheck;
  }
  
  // 所有重试都失败
  throw lastError || new Error(`生成第 ${targetCount} 张图片失败: 重试 ${maxRetries} 次后仍失败`);
}

// 确保图片完全加载完成（连续检查，确保稳定性）
async function ensureImagesFullyLoaded(images, maxChecks = 5) {
  for (let check = 0; check < maxChecks; check++) {
    let allLoaded = true;
    
    for (const img of images) {
      // 检查图片是否真正加载完成
      if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
        allLoaded = false;
        break;
      }
      
      // 检查图片是否有有效的 src
      if (!img.src || img.src === '' || img.src.startsWith('data:image/svg')) {
        allLoaded = false;
        break;
      }
    }
    
    if (allLoaded) {
      // 连续 2 次检查都通过，认为图片已稳定加载
      if (check >= 1) {
        console.log(`[Content] 图片加载完成确认 (连续 ${check + 1} 次检查通过)`);
        return true;
      }
    } else {
      // 如果检查失败，重置计数器
      check = -1;
    }
    
    await sleep(500);
  }
  
  // 如果多次检查都失败，记录警告但继续
  console.warn(`[Content] 图片加载检查：部分图片可能未完全加载，但继续流程`);
  return false;
}

// 检测错误消息（Gemini 返回的错误）
// 只检测最新的对话消息，避免误判
function detectErrorMessage() {
  // 检查页面文本中是否包含错误关键词
  const errorKeywords = [
    '无法生成',
    '系统原因',
    '生成失败',
    '连接暂时中断', // 新增：检测中断消息
    '生图工具连接暂时中断', // 新增：检测中断消息
    'I can\'t generate',
    'I\'m unable to',
    'Sorry, I can\'t',
    'unable to generate',
    'cannot generate'
  ];
  
  // 排除的关键词（这些不是错误）
  const excludeKeywords = [
    '设计草图', // 排除设计草图提示
    'MJ 提示词', // 排除MJ提示词
    'Midjourney', // 排除Midjourney相关
    'visual design sketch' // 排除设计草图英文
  ];
  
  // 查找所有对话消息容器（按时间倒序，最新的在前）
  const messageContainers = Array.from(document.querySelectorAll(
    '[class*="message"], [class*="response"], [class*="chat-message"]'
  )).reverse(); // 反转，最新的在前
  
  // 只检查最新的3条消息（避免检查太多旧消息）
  for (const container of messageContainers.slice(0, 3)) {
    const containerText = (container.innerText || container.textContent || '').toLowerCase();
    
    // 如果包含排除关键词，跳过
    if (excludeKeywords.some(exclude => containerText.includes(exclude.toLowerCase()))) {
      continue;
    }
    
    // 检查是否包含错误关键词
    for (const keyword of errorKeywords) {
      if (containerText.includes(keyword.toLowerCase())) {
        // 确认是错误消息（不是设计草图提示）
        const fullText = container.innerText || container.textContent || '';
        // 如果同时包含"设计草图"和错误关键词，可能是设计草图提示，不是错误
        if (fullText.toLowerCase().includes('设计草图') && 
            !fullText.toLowerCase().includes('连接暂时中断') &&
            !fullText.toLowerCase().includes('无法生成')) {
          continue; // 跳过设计草图提示
        }
        
        // 返回错误消息（限制长度）
        return fullText.trim().substring(0, 200);
      }
    }
  }
  
  return null;
}

// 验证图片是否真正存在且有效
function verifyImageExists(targetCount) {
  // 1. 检查下载按钮
  let downloadBtns = document.querySelectorAll(
    'button[aria-label*="Download full size"]'
  );
  
  if (downloadBtns.length === 0) {
    downloadBtns = document.querySelectorAll(
      'button[data-test-id="download-generated-image-button"]'
    );
  }
  
  if (downloadBtns.length < targetCount) {
    return { exists: false, reason: `下载按钮数量不足 (${downloadBtns.length} < ${targetCount})` };
  }
  
  // 2. 检查对应的图片元素是否存在
  const allImages = Array.from(document.querySelectorAll("img"));
  const validImages = allImages.filter((img) => {
    const src = img.src || "";
    if (!src) return false;
    if (src.includes("nano-banana")) return false;
    if (src.includes("profile_photo")) return false;
    return img.naturalWidth > 200;
  });
  
  if (validImages.length < targetCount) {
    return { exists: false, reason: `有效图片数量不足 (${validImages.length} < ${targetCount})` };
  }
  
  // 3. 检查最近的图片是否加载完成
  const recentImages = validImages.slice(-targetCount);
  for (let i = 0; i < recentImages.length; i++) {
    const img = recentImages[i];
    if (!img.complete || img.naturalWidth === 0) {
      return { exists: false, reason: `第 ${i + 1} 张图片未加载完成` };
    }
  }
  
  // 4. 检查是否有错误消息
  const errorMsg = detectErrorMessage();
  if (errorMsg) {
    return { exists: false, reason: `检测到错误消息: ${errorMsg.substring(0, 100)}` };
  }
  
  return { exists: true, images: recentImages, downloadBtns: downloadBtns };
}

// 等待生成完成（检测下载按钮数量，增强容错性）
async function waitForGeneration(targetCount, timeoutSeconds = 120) {
  let attempts = 0;
  let lastErrorReason = null;
  const maxAttempts = timeoutSeconds; // 每 1 秒检查一次（减少检测频率）
  
  while (attempts < maxAttempts) {
    if (shouldStop) throw new Error("用户停止");

    // 验证图片是否存在
    const verification = verifyImageExists(targetCount);
    
    if (verification.exists) {
      console.log(
        `[Page ${targetCount}] 生成确认 (检测到 ${verification.downloadBtns.length} 个下载按钮, ${verification.images.length} 张有效图片)`
      );
      
      // 确保图片真正加载完成
      const allLoaded = await ensureImagesFullyLoaded(verification.images, 3);
      if (allLoaded) {
        return verification; // 返回验证结果，包含图片和按钮信息
      } else {
        // 图片未完全加载，继续等待
        console.log(`[Content] 图片检测到但未完全加载，继续等待...`);
      }
    } else {
      lastErrorReason = verification.reason;
      // 如果检测到错误消息，立即抛出（但只在最新消息中检测）
      if (verification.reason && verification.reason.includes('错误消息')) {
        // 再次确认是最新的错误消息，避免误判
        const latestError = detectErrorMessage();
        if (latestError) {
          throw new Error(`生成第 ${targetCount} 张图片失败: ${verification.reason}`);
        }
      }
    }

    await sleep(1000); // 改为 1 秒检查一次，减少检测频率
    attempts++;
  }

  throw new Error(`生成第 ${targetCount} 张图片超时: ${lastErrorReason || '未检测到图片或下载按钮'}`);
}

// 批量获取图片链接 -> 转换为高清 -> 下载
async function downloadAllGeneratedImages() {
  console.log("[Batch] 开始提取图片链接...");

  // 1. 再等一下，确保最后一张图完全渲染
  await sleep(2000);

  // 2. 筛选页面上的有效生成图
  const allImages = Array.from(document.querySelectorAll("img"));
  const validImages = allImages.filter((img) => {
    const src = img.src || "";
    if (!src) return false;
    if (src.includes("nano-banana")) return false;
    if (src.includes("profile_photo")) return false;
    // 确保图片已加载完成
    if (!img.complete || img.naturalWidth === 0) return false;
    return img.naturalWidth > 200;
  });

  if (!validImages.length) {
    console.warn("[Batch] 未找到任何有效图片");
    chrome.runtime.sendMessage({
      action: "generationError",
      error: "未找到任何生成的图片，请检查生成是否成功"
    });
    return;
  }

  // 3. 截取最后 N 张图（对应本次生成的 N 个提示词）
  const count = currentPrompts.length;
  const targetImages = validImages.slice(-count);

  if (targetImages.length < count) {
    console.warn(`[Batch] 警告：期望 ${count} 张图片，但只找到 ${targetImages.length} 张`);
  }

  console.log(
    `[Batch] 找到 ${validImages.length} 张图，准备下载最后 ${targetImages.length} 张`
  );

  for (let i = 0; i < targetImages.length; i++) {
    const img = targetImages[i];
    let finalUrl = img.src;
    const pageNum = i + 1;

    // 魔法步骤：高清化处理
    if (
      finalUrl.includes("googleusercontent.com") &&
      finalUrl.includes("=")
    ) {
      const baseUrl = finalUrl.split("=")[0];
      finalUrl = `${baseUrl}=s0`;
      console.log(`[Batch] Page ${pageNum}: URL 已升级为高清版 (=s0)`);
    } else {
      console.log(
        `[Batch] Page ${pageNum}: 使用原始 URL (可能是 blob 或已是原图)`
      );
    }

    const filename = saveDirectory
      ? `${saveDirectory}/page${pageNum}.png`
      : `page${pageNum}.png`;

    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "downloadDirectly",
          url: finalUrl,
          filename,
        },
        (res) => {
          if (res && res.success) {
            console.log(`[Batch] Page ${pageNum} 下载任务已发送`);
          } else {
            console.error(
              `[Batch] Page ${pageNum} 下载失败`,
              res && res.error
            );
          }
          resolve();
        }
      );
    });

    await sleep(800);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (window.location.href.includes("gemini.google.com")) {
  console.log("Gemini Auto PPT Generator: Ready (Page Context Mode)");
}





