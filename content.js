// Content script - 任务状态持久化版本

let isGenerating = false;
let shouldStop = false;
let currentPrompts = [];
let saveDirectory = "";
let currentIndex = 0;
let total = 0;

// 状态同步到 background（定期更新）
let stateSyncInterval = null;
// 记录成功生成的图片（用于有序下载和过滤非图片资源）
let successImages = [];

// 页面加载时检查并恢复任务
window.addEventListener("load", async () => {
  await checkAndRestoreTask();
});

// 如果页面已经加载完成，立即检查
if (
  document.readyState === "complete" ||
  document.readyState === "interactive"
) {
  checkAndRestoreTask();
}

// 检查并恢复任务
async function checkAndRestoreTask() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "restoreTask",
    });
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
      chrome.runtime
        .sendMessage({
          action: "taskUpdate",
          currentIndex: currentIndex,
          total: total,
        })
        .catch((err) => console.error("[Content] 状态同步失败:", err));
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
      total: total,
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
  } else if (message.action === "checkExistingImages") {
    const count = countExistingImages();
    sendResponse({ count });
    return true;
  } else if (message.action === "downloadExisting") {
    // 仅下载当前页面已有的图片，不重新生成
    saveDirectory = message.saveDirectory || "";
    const expectedCount = message.expectedCount || null;
    isGenerating = true;
    shouldStop = false;
    downloadAllGeneratedImages(expectedCount).finally(() => {
      isGenerating = false;
      currentIndex = 0;
      total = 0;
    });
    sendResponse({ success: true });
    return true;
  } else if (message.action === "downloadStarted") {
    // 处理下载启动确认（由 background.js 发送）
    if (
      window.downloadWaiters &&
      window.downloadWaiters.has(message.filename)
    ) {
      const { resolve, data } = window.downloadWaiters.get(message.filename);
      window.downloadWaiters.delete(message.filename);
      resolve({ ...message, ...data });
    }
  } else if (message.action === "downloadFailed") {
    // 处理下载失败通知（由 background.js 发送）
    if (
      window.downloadWaiters &&
      window.downloadWaiters.has(message.filename)
    ) {
      const { reject, data } = window.downloadWaiters.get(message.filename);
      window.downloadWaiters.delete(message.filename);
      reject(new Error(`下载启动失败: ${message.statusCode || "未知错误"}`));
    }
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
    // 记录成功生成的图片索引和对应图片
    const successfullyGenerated = [];
    successImages = [];

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
        status: "generating",
      });

      // 同步状态到 background（使用 displayIndex，1-based）
      chrome.runtime.sendMessage({
        action: "taskUpdate",
        currentIndex: displayIndex, // displayIndex 是 1-based，确保进度正确
        total: currentPrompts.length,
      });

      try {
        // 提交前检查是否被风控
        const rateLimitCheck = detectRateLimitOrBlock();
        if (rateLimitCheck.blocked) {
          console.warn(
            `[Content] ⚠️ 检测到可能被风控: ${rateLimitCheck.reason} (类型: ${rateLimitCheck.type})`
          );
          chrome.runtime.sendMessage({
            action: "updateProgress",
            current: displayIndex,
            total: currentPrompts.length,
            status: "warning",
            warning: `可能被限制: ${rateLimitCheck.reason}`,
          });
          // 等待更长时间后重试
          await sleep(10000); // 等待10秒
          // 再次检查
          const recheck = detectRateLimitOrBlock();
          if (recheck.blocked) {
            throw new Error(
              `检测到风控限制: ${rateLimitCheck.reason}，建议稍后再试`
            );
          }
        }

        // 提交提示词（增强容错性，避免重复提交）
        await submitPromptWithRetry(currentPrompts[i], 3, i);

        // 等待生成完成（增强容错性，验证图片存在）
        const verification = await waitForGenerationWithRetry(
          displayIndex,
          3,
          i
        );

        if (verification && verification.exists) {
          // 再次确认图片完全加载完成（额外等待，确保稳定）
          console.log(
            `[Content] 第 ${displayIndex} 张图片验证成功，等待图片稳定...`
          );
          await sleep(1000); // 额外等待 1 秒，确保图片完全渲染

          // 最终验证：确保图片仍然存在且已加载
          const finalVerification = verifyImageExists(displayIndex);
          if (finalVerification.exists) {
            generationSuccess = true;
            successfullyGenerated.push(i);

            // 记录当前成功图片（取最新的一张，保持顺序）
            const selectedImage =
              finalVerification.images && finalVerification.images.length
                ? finalVerification.images[finalVerification.images.length - 1]
                : null;
            if (selectedImage && selectedImage.src) {
              successImages.push({
                index: displayIndex,
                src: selectedImage.src,
              });
            }

            console.log(
              `[Content] 第 ${displayIndex} 张图片生成成功并已完全加载`
            );

            // 更新进度为成功
            chrome.runtime.sendMessage({
              action: "updateProgress",
              current: displayIndex,
              total: currentPrompts.length,
              status: "success",
            });
          } else {
            throw new Error(
              `第 ${displayIndex} 张图片最终验证失败: ${finalVerification.reason}`
            );
          }
        } else {
          throw new Error(`第 ${displayIndex} 张图片验证失败`);
        }
      } catch (error) {
        console.error(
          `[Content] 第 ${displayIndex} 张图片生成失败:`,
          error.message
        );

        // 更新进度为失败
        chrome.runtime.sendMessage({
          action: "updateProgress",
          current: displayIndex,
          total: currentPrompts.length,
          status: "error",
          error: error.message,
        });

        // 决定是否继续：如果是关键错误（如用户停止），则停止；否则继续下一张
        if (error.message.includes("用户停止")) {
          throw error; // 用户停止，抛出错误
        }

        // 其他错误继续下一张
        console.warn(
          `[Content] 第 ${displayIndex} 张图片生成失败，继续下一张...`
        );
      }

      if (generationSuccess) {
        // 成功生成后，随机等待15-25秒，模拟真实用户行为，避免触发Google反机器人检测
        const minWait = 15000; // 15秒
        const maxWait = 25000; // 25秒
        const waitTime =
          Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
        console.log(
          `[Content] 第 ${displayIndex} 张生成完成，等待 ${
            waitTime / 1000
          } 秒（模拟真实用户行为）...`
        );
        await sleep(waitTime);
      } else {
        await sleep(5000); // 失败后等待5秒，避免连续失败
      }
    }

    // 记录成功生成的图片数量
    console.log(
      `[Content] 生成完成：成功 ${successfullyGenerated.length}/${currentPrompts.length} 张`
    );

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
        action: "taskComplete",
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
      error: error.message || String(error),
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
    if (key && key.startsWith("prompt_") && key.endsWith("_submitted")) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => sessionStorage.removeItem(key));
  console.log(`[Content] 已清理 ${keysToRemove.length} 条提交记录`);
}

// 提交提示词（带重试机制，但避免重复提交）
async function submitPromptWithRetry(
  prompt,
  maxRetries = 3,
  promptIndex = null
) {
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
      // 传递 displayIndex 给 submitPrompt，用于动态调整等待时间
      const displayIndex = promptIndex !== null ? promptIndex + 1 : null;
      await submitPrompt(prompt, displayIndex);
      // 标记已提交
      if (promptIndex !== null) {
        sessionStorage.setItem(promptKey, "true");
      }
      return; // 成功
    } catch (error) {
      console.warn(
        `[Content] 提交提示词失败 (尝试 ${attempt}/${maxRetries}):`,
        error
      );
      if (attempt === maxRetries) {
        throw new Error(`提交提示词失败: ${error.message}`);
      }
      await sleep(2000 * attempt); // 递增延迟
    }
  }
}

// 提交提示词
async function submitPrompt(prompt, currentDisplayIndex = null) {
  // 容错查询：等待输入框出现（减少查询次数，避免触发检测）
  let input = null;
  for (let i = 0; i < 5; i++) {
    // 减少查询次数：从10次改为5次
    input = document.querySelector(
      'div[contenteditable="true"][role="textbox"]'
    );
    if (input) break;
    await sleep(500);
  }

  if (!input) {
    // 尝试进入 Create Image 模式
    await ensureCreateImageMode();
    await sleep(1000);
    input = document.querySelector(
      'div[contenteditable="true"][role="textbox"]'
    );
  }

  if (!input) throw new Error("找不到输入框");

  // 简化输入框检查（减少DOM查询）
  // 只检查一次，如果不可用就等待一下
  if (
    !input.hasAttribute("contenteditable") ||
    input.getAttribute("contenteditable") !== "true"
  ) {
    await sleep(1000);
    // 重新获取输入框
    input = document.querySelector(
      'div[contenteditable="true"][role="textbox"]'
    );
    if (!input) throw new Error("输入框不可用");
  }

  input.focus();
  input.textContent = prompt;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(600); // 稍微减少等待时间

  // 简化按钮查找（减少DOM查询）
  const sendBtn =
    document.querySelector('button[data-testid="send-button"]') ||
    Array.from(document.querySelectorAll("button")).find(
      (b) => !b.disabled && b.getAttribute("aria-label") === "Send"
    );

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

  // 提交后等待2秒，确保请求已发送
  await sleep(2000);
}

// 查找并点击刷新/重试按钮（优先于重新提交提示词）
async function clickRefreshButton() {
  // 查找刷新按钮（根据图片中的元素特征）
  // 可能的选择器：
  // 1. 包含 refresh-icon 类的按钮
  // 2. aria-label 包含 refresh 或 刷新 的按钮
  // 3. 圆形刷新图标（Material Design）

  const refreshSelectors = [
    'button[class*="refresh"]',
    'button[aria-label*="refresh" i]',
    'button[aria-label*="刷新" i]',
    'button[aria-label*="retry" i]',
    'button[aria-label*="重试" i]',
    ".refresh-icon",
    'button[class*="refresh-icon"]',
    // Material Design 图标
    "button mat-icon.refresh-icon",
    "button .mat-icon.refresh-icon",
  ];

  for (const selector of refreshSelectors) {
    try {
      const refreshBtn = document.querySelector(selector);
      if (
        refreshBtn &&
        !refreshBtn.disabled &&
        refreshBtn.offsetParent !== null
      ) {
        console.log(
          `[Content] 找到刷新按钮，点击刷新... (选择器: ${selector})`
        );
        refreshBtn.click();
        await sleep(500); // 点击后等待一下
        return true;
      }
    } catch (error) {
      // 继续尝试下一个选择器
      continue;
    }
  }

  // 如果标准选择器找不到，尝试查找所有按钮，检查图标
  try {
    const allButtons = Array.from(document.querySelectorAll("button"));
    for (const btn of allButtons) {
      // 检查按钮是否包含刷新图标
      const icon = btn.querySelector(
        'mat-icon.refresh-icon, .refresh-icon, [class*="refresh"]'
      );
      if (icon && !btn.disabled && btn.offsetParent !== null) {
        // 检查按钮是否在可见区域（通常在消息底部）
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          console.log(`[Content] 找到刷新按钮（通过图标查找），点击刷新...`);
          btn.click();
          await sleep(500);
          return true;
        }
      }
    }
  } catch (error) {
    console.warn(`[Content] 查找刷新按钮时出错:`, error);
  }

  console.log(`[Content] 未找到刷新按钮`);
  return false;
}

// 快速检查图片是否已生成（不等待，立即返回结果）
function quickCheckImageExists(targetCount) {
  return verifyImageExists(targetCount);
}

// 等待生成完成（带重试机制，但不重复提交提示词）
async function waitForGenerationWithRetry(
  targetCount,
  maxRetries = 3,
  promptIndex = null
) {
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
      console.warn(
        `[Content] 等待生成失败 (尝试 ${attempt}/${maxRetries}):`,
        error.message
      );

      // 检查是否是用户停止
      if (error.message.includes("用户停止")) {
        throw error; // 用户停止，不重试
      }

      // 检查是否是明确的错误消息（如"系统原因"）
      // 注意：刷新按钮只在"提示词已提交，但检测到错误消息"时使用
      if (
        error.message.includes("错误消息") ||
        error.message.includes("无法生成")
      ) {
        // 如果是第一次或第二次尝试，优先点击刷新按钮
        if (attempt <= 2) {
          console.log(
            `[Content] 提示词已提交，但检测到错误消息，优先尝试点击刷新按钮（避免重复提交提示词）...`
          );
          const refreshClicked = await clickRefreshButton();
          if (refreshClicked) {
            console.log(`[Content] ✅ 已点击刷新按钮，等待 8 秒后检查...`);
            await sleep(8000); // 等待8秒

            // 检查是否生成成功
            const quickCheck = quickCheckImageExists(targetCount);
            if (quickCheck.exists) {
              console.log(`[Content] ✅ 刷新后检查：图片已生成！`);
              await ensureImagesFullyLoaded(quickCheck.images);
              return quickCheck;
            }
            // 如果刷新后仍然失败，继续等待
            console.log(`[Content] 刷新后仍未生成，继续等待 5 秒...`);
            await sleep(5000);
            continue; // 继续重试
          }
        }

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
          console.log(`[Content] ✅ 重试前检查：图片已生成！`);
          await ensureImagesFullyLoaded(quickCheck.images);
          return quickCheck;
        }
        continue;
      }

      // 超时错误：优先点击刷新按钮（更接近真实用户行为，避免重复提交）
      // 注意：刷新按钮只在"提示词已提交，但等待生成超时"时使用
      if (error.message.includes("超时")) {
        // 第一次或第二次超时，优先尝试点击刷新按钮
        if (attempt <= 2) {
          console.log(
            `[Content] ⏱️ 提示词已提交，但等待 ${targetCount} 秒后未检测到图片，优先尝试点击刷新按钮（避免重复提交提示词）...`
          );
          const refreshClicked = await clickRefreshButton();
          if (refreshClicked) {
            console.log(`[Content] ✅ 已点击刷新按钮，等待 10 秒后检查...`);
            await sleep(10000); // 等待10秒，给Gemini时间重新生成

            // 检查是否生成成功
            const quickCheck = quickCheckImageExists(targetCount);
            if (quickCheck.exists) {
              console.log(`[Content] ✅ 刷新后检查：图片已生成！`);
              await ensureImagesFullyLoaded(quickCheck.images);
              return quickCheck;
            }
            // 如果刷新后仍然超时，继续等待一段时间
            console.log(`[Content] 刷新后仍未生成，继续等待 5 秒...`);
            await sleep(5000);
            continue; // 继续重试
          } else {
            console.log(`[Content] ⚠️ 未找到刷新按钮，将使用等待重试策略`);
          }
        }

        // 如果刷新失败或已经是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          console.log(`[Content] 超时，等待 ${5 * attempt} 秒后重试...`);
          await sleep(5000 * attempt);

          // 重试前先快速检查一次，可能图片已经生成了
          const quickCheck = quickCheckImageExists(targetCount);
          if (quickCheck.exists) {
            console.log(`[Content] ✅ 重试前检查：图片已生成！`);
            await ensureImagesFullyLoaded(quickCheck.images);
            return quickCheck;
          }
          continue;
        }
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
  throw (
    lastError ||
    new Error(`生成第 ${targetCount} 张图片失败: 重试 ${maxRetries} 次后仍失败`)
  );
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
      if (!img.src || img.src === "" || img.src.startsWith("data:image/svg")) {
        allLoaded = false;
        break;
      }
    }

    if (allLoaded) {
      // 连续 2 次检查都通过，认为图片已稳定加载
      if (check >= 1) {
        console.log(
          `[Content] 图片加载完成确认 (连续 ${check + 1} 次检查通过)`
        );
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

// 检测是否被Google风控/限制
function detectRateLimitOrBlock() {
  // 1. 检查是否跳转到Google的"sorry"页面
  if (
    window.location.href.includes("google.com/sorry") ||
    window.location.href.includes("accounts.google.com/signin")
  ) {
    return {
      blocked: true,
      reason: "检测到Google验证页面，可能触发了反机器人检测",
      type: "sorry_page",
    };
  }

  // 2. 检查页面标题是否包含"sorry"或"验证"
  const pageTitle = document.title.toLowerCase();
  if (
    pageTitle.includes("sorry") ||
    pageTitle.includes("verify") ||
    pageTitle.includes("验证") ||
    pageTitle.includes("unusual traffic")
  ) {
    return {
      blocked: true,
      reason: "页面标题显示可能被限制",
      type: "title_detection",
    };
  }

  // 3. 检查是否有验证码元素
  const captchaElements = document.querySelectorAll(
    '[id*="captcha"], [class*="captcha"], [id*="recaptcha"], [class*="recaptcha"]'
  );
  if (captchaElements.length > 0) {
    return {
      blocked: true,
      reason: "检测到验证码元素，可能被要求验证",
      type: "captcha",
    };
  }

  // 4. 检查输入框是否被禁用（可能是临时限制）
  const input = document.querySelector(
    'div[contenteditable="true"][role="textbox"]'
  );
  if (input) {
    const isDisabled =
      input.hasAttribute("disabled") ||
      input.getAttribute("contenteditable") === "false" ||
      input.closest("[disabled]");

    // 检查是否有"暂时无法使用"等提示
    const parentText = (
      input.closest('[class*="input"], [class*="textbox"]')?.innerText || ""
    ).toLowerCase();
    if (
      isDisabled &&
      (parentText.includes("暂时") || parentText.includes("unavailable"))
    ) {
      return {
        blocked: true,
        reason: "输入框被禁用，可能被临时限制",
        type: "input_disabled",
      };
    }
  }

  // 5. 检查是否有"访问被拒绝"或"请求过多"的提示
  const bodyText = document.body.innerText.toLowerCase();
  if (
    bodyText.includes("too many requests") ||
    bodyText.includes("rate limit") ||
    bodyText.includes("请求过多") ||
    bodyText.includes("访问被拒绝") ||
    bodyText.includes("access denied")
  ) {
    return {
      blocked: true,
      reason: "检测到速率限制或访问拒绝提示",
      type: "rate_limit_message",
    };
  }

  return { blocked: false };
}

// 检测错误消息（Gemini 返回的错误）
// 只检测最新的对话消息，避免误判
function detectErrorMessage() {
  // 检查页面文本中是否包含错误关键词
  const errorKeywords = [
    "无法生成",
    "系统原因",
    "生成失败",
    "连接暂时中断", // 新增：检测中断消息
    "生图工具连接暂时中断", // 新增：检测中断消息
    "I can't generate",
    "I'm unable to",
    "Sorry, I can't",
    "unable to generate",
    "cannot generate",
  ];

  // 排除的关键词（这些不是错误）
  const excludeKeywords = [
    "设计草图", // 排除设计草图提示
    "MJ 提示词", // 排除MJ提示词
    "Midjourney", // 排除Midjourney相关
    "visual design sketch", // 排除设计草图英文
  ];

  // 查找所有对话消息容器（按时间倒序，最新的在前）
  const messageContainers = Array.from(
    document.querySelectorAll(
      '[class*="message"], [class*="response"], [class*="chat-message"]'
    )
  ).reverse(); // 反转，最新的在前

  // 只检查最新的3条消息（避免检查太多旧消息）
  for (const container of messageContainers.slice(0, 3)) {
    const containerText = (
      container.innerText ||
      container.textContent ||
      ""
    ).toLowerCase();

    // 如果包含排除关键词，跳过
    if (
      excludeKeywords.some((exclude) =>
        containerText.includes(exclude.toLowerCase())
      )
    ) {
      continue;
    }

    // 检查是否包含错误关键词
    for (const keyword of errorKeywords) {
      if (containerText.includes(keyword.toLowerCase())) {
        // 确认是错误消息（不是设计草图提示）
        const fullText = container.innerText || container.textContent || "";
        // 如果同时包含"设计草图"和错误关键词，可能是设计草图提示，不是错误
        if (
          fullText.toLowerCase().includes("设计草图") &&
          !fullText.toLowerCase().includes("连接暂时中断") &&
          !fullText.toLowerCase().includes("无法生成")
        ) {
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
    return {
      exists: false,
      reason: `下载按钮数量不足 (${downloadBtns.length} < ${targetCount})`,
    };
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
    return {
      exists: false,
      reason: `有效图片数量不足 (${validImages.length} < ${targetCount})`,
    };
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
    return {
      exists: false,
      reason: `检测到错误消息: ${errorMsg.substring(0, 100)}`,
    };
  }

  return { exists: true, images: recentImages, downloadBtns: downloadBtns };
}

// 等待生成完成（检测下载按钮数量，增强容错性）
async function waitForGeneration(targetCount, timeoutSeconds = 180) {
  let attempts = 0;
  let lastErrorReason = null;
  const maxAttempts = timeoutSeconds; // 每 2 秒检查一次（减少检测频率，避免触发反机器人检测）

  while (attempts < maxAttempts) {
    if (shouldStop) throw new Error("用户停止");

    // 检查是否被风控（每10次检查一次，减少检测频率）
    if (attempts % 5 === 0) {
      const rateLimitCheck = detectRateLimitOrBlock();
      if (rateLimitCheck.blocked) {
        console.warn(
          `[Content] ⚠️ 等待生成时检测到风控: ${rateLimitCheck.reason}`
        );
        throw new Error(
          `检测到风控限制: ${rateLimitCheck.reason}，建议稍后再试`
        );
      }
    }

    // 验证图片是否存在
    const verification = verifyImageExists(targetCount);

    if (verification.exists) {
      console.log(
        `[Page ${targetCount}] 生成确认 (检测到 ${verification.downloadBtns.length} 个下载按钮, ${verification.images.length} 张有效图片)`
      );

      // 确保图片真正加载完成
      const allLoaded = await ensureImagesFullyLoaded(verification.images, 2);
      if (allLoaded) {
        return verification; // 返回验证结果，包含图片和按钮信息
      } else {
        // 图片未完全加载，继续等待
        console.log(`[Content] 图片检测到但未完全加载，继续等待...`);
      }
    } else {
      lastErrorReason = verification.reason;
      // 只在明确检测到错误时才抛出
      if (
        verification.reason &&
        (verification.reason.includes("连接暂时中断") ||
          verification.reason.includes("无法生成") ||
          verification.reason.includes("生成失败"))
      ) {
        // 再次确认是最新的错误消息
        const latestError = detectErrorMessage();
        if (latestError && !latestError.includes("设计草图")) {
          throw new Error(
            `生成第 ${targetCount} 张图片失败: ${verification.reason}`
          );
        }
      }
    }

    // 每2秒检查一次，减少检测频率
    await sleep(2000);
    attempts++;
  }

  throw new Error(
    `生成第 ${targetCount} 张图片超时: ${
      lastErrorReason || "未检测到图片或下载按钮"
    }`
  );
}

// 判断是否为可下载的位图格式（PNG/JPEG）
function isRasterImageUrl(src) {
  if (!src) return false;
  const lower = src.toLowerCase();
  if (lower.startsWith("data:image/svg")) return false;
  if (lower.endsWith(".svg")) return false;
  if (lower.includes("image/svg")) return false;
  if (lower.startsWith("data:image/png")) return true;
  if (lower.startsWith("data:image/jpeg") || lower.startsWith("data:image/jpg"))
    return true;
  if (lower.includes(".png")) return true;
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return true;
  if (lower.includes("googleusercontent.com")) return true; // 可升级为 =s0 PNG
  if (lower.startsWith("blob:")) return true; // 假定为图片，后续尝试下载
  return false;
}

// 计算当前页面已有的有效图片数量（优先检查下载按钮，因为新逻辑基于按钮点击）
function countExistingImages() {
  // 优先检查下载按钮数量（新逻辑基于按钮点击）
  const downloadButtons = findDownloadFullSizeButtons();
  if (downloadButtons.length > 0) {
    return downloadButtons.length;
  }

  // 如果没有按钮，回退到检查图片数量（用于兜底）
  if (successImages && successImages.length) {
    return successImages.filter((item) => isRasterImageUrl(item.src)).length;
  }
  const allImages = Array.from(document.querySelectorAll("img"));
  const validImages = allImages.filter((img) => {
    const src = img.src || "";
    if (!isRasterImageUrl(src)) return false;
    if (!img.complete || img.naturalWidth === 0) return false;
    if (src.includes("nano-banana")) return false;
    if (src.includes("profile_photo")) return false;
    return img.naturalWidth > 200;
  });
  return validImages.length;
}

// 尝试构造“Download full size”直链（基于观察到的 rd-gg-dl / =s0-d-I 模式）
function buildFullSizeCandidates(src) {
  if (!src) return [];
  try {
    const url = new URL(src);
    if (!url.hostname.includes("googleusercontent.com")) {
      return [src];
    }

    // 核心修复：统一路径为 /rd-gg/（日志显示 rd-gg-dl 会返回元数据/HTML）
    let pathname = url.pathname.replace(
      /\/gg\/|\/rd-gg-dl\/|\/rd-gg\//,
      "/rd-gg/"
    );

    // 去掉已有的尺寸参数
    pathname = pathname.replace(/=s\d[^/]*$/i, "");
    pathname = pathname.replace(/=w\d[^/]*$/i, "");
    pathname = pathname.replace(/=no[^/]*$/i, "");

    // 保证 alr=yes
    if (!url.searchParams.has("alr")) {
      url.searchParams.set("alr", "yes");
    }
    const query = url.searchParams.toString();
    const suffix = query ? `?${query}` : "";
    const base = `${url.origin}${pathname}`;

    return [
      `${base}=s0-d-I${suffix}`, // 优先与手动全尺寸一致
      `${base}=s0${suffix}`, // 备选高清
      src, // 兜底原始
    ];
  } catch (e) {
    return [src];
  }
}

// 批量获取图片链接 -> 通过点击按钮触发网络请求 -> 后台捕获下载
// 【核心改进】不再使用 fetch+blob，改为监听浏览器真实网络请求
async function downloadAllGeneratedImages(expectedCount = null) {
  console.log("[Batch] 🎬 开始使用网络监听模式下载...");

  // 1. 再等一下，确保最后一张图完全渲染
  await sleep(2000);

  // 2. 查找所有 "Download full size" 按钮（按页面顺序）
  const downloadButtons = findDownloadFullSizeButtons();

  if (downloadButtons.length === 0) {
    console.warn("[Batch] ❌ 未找到任何下载按钮，尝试回退到 DOM 提取模式");
    // 回退到旧的 fetch 模式
    await downloadAllGeneratedImagesFallback(expectedCount);
    return;
  }

  const totalCount = downloadButtons.length;
  console.log(`[Batch] ✅ 找到 ${totalCount} 个下载按钮`);

  // 3. 生成文件名列表（按顺序）
  const filenames = downloadButtons.map((_, i) => {
    const pageNum = i + 1;
    return saveDirectory
      ? `${saveDirectory}/page${pageNum}.png`
      : `page${pageNum}.png`;
  });

  // 4. 通知后台开始监听网络请求
  total = totalCount;
  currentIndex = 0;
  chrome.runtime.sendMessage({
    action: "taskStart",
    total: totalCount,
    prompts: [],
    saveDirectory,
    status: "downloading",
  });
  chrome.runtime.sendMessage({
    action: "updateProgress",
    current: 0,
    total: totalCount,
    status: "downloading",
  });

  await chrome.runtime.sendMessage({
    action: "startSniffing",
    filenames: filenames,
  });
  console.log(`[Batch] 📡 后台监听已启动，准备点击 ${totalCount} 个按钮`);

  // 初始化下载等待器 Map（用于存储等待中的 Promise）
  if (!window.downloadWaiters) {
    window.downloadWaiters = new Map();
  }

  // 5. 慢速依次点击按钮，让后台捕获网络请求，并等待每个请求返回 200
  for (let i = 0; i < downloadButtons.length; i++) {
    const pageNum = i + 1;
    const button = downloadButtons[i];
    const currentFilename = filenames[i];

    try {
      console.log(`[Batch] 🖱️ 点击第 ${pageNum}/${totalCount} 个按钮...`);

      // 滚动到按钮可见
      button.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(500);

      // 创建 Promise 来等待下载启动确认
      const downloadConfirmed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          window.downloadWaiters.delete(currentFilename);
          reject(new Error(`等待下载启动超时 (${pageNum}/${totalCount})`));
        }, 15000); // 15秒超时

        // 将 resolve/reject 存储到 Map 中，等待全局消息监听器处理
        window.downloadWaiters.set(currentFilename, {
          resolve: (data) => {
            clearTimeout(timeout);
            resolve(data);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          data: { pageNum, totalCount },
        });
      });

      // 点击按钮（触发浏览器发起 /rd-gg/ 请求）
      console.log(
        `[Batch] 🖱️ 准备点击按钮 ${pageNum}/${totalCount}，预期文件名: ${currentFilename}`
      );
      button.click();
      console.log(
        `[Batch] ✅ 第 ${pageNum} 个按钮已点击，等待网络请求返回 200...`
      );

      // 等待下载启动确认（网络请求返回 200）
      try {
        const confirmResult = await downloadConfirmed;
        console.log(
          `[Batch] ✅ 第 ${pageNum} 张图片下载已启动 (下载ID: ${confirmResult.downloadId}, 文件名: ${confirmResult.filename}, 状态码: 200)`
        );

        // 验证文件名是否正确
        if (confirmResult.filename !== currentFilename) {
          console.warn(
            `[Batch] ⚠️ 文件名不匹配！预期: ${currentFilename}, 实际: ${confirmResult.filename}`
          );
        }

        // 更新下载进度
        currentIndex = pageNum;
        chrome.runtime.sendMessage({
          action: "updateProgress",
          current: pageNum,
          total: totalCount,
          status: "downloading",
        });

        // 【优化】根据 fix.md 建议：在继续下一个之前，等待更长时间（3000ms）
        // 确保下载任务已稳定启动，避免并发问题
        console.log(`[Batch] ⏳ 等待 3 秒后继续下一个...`);
        await sleep(3000);
      } catch (err) {
        console.error(
          `[Batch] ❌ 第 ${pageNum} 张图片下载启动失败:`,
          err.message
        );
        // 继续下一个，不中断整个流程
        // 但也要等待一段时间，避免连续失败
        await sleep(2000);
      }
    } catch (err) {
      console.error(`[Batch] ❌ 点击第 ${pageNum} 个按钮失败:`, err);
    }
  }

  // 清理等待器 Map
  window.downloadWaiters.clear();

  // 6. 等待所有下载启动（后台会自动关闭监听）
  console.log(`[Batch] ✅ 所有按钮已点击，等待下载完成...`);

  // 下载阶段结束，通知后台清理状态
  await sleep(3000); // 给后台一些时间完成最后的下载启动
  chrome.runtime.sendMessage({ action: "stopSniffing" });
  chrome.runtime.sendMessage({ action: "taskComplete" });

  isGenerating = false;
  currentIndex = 0;
  total = 0;
  console.log(`[Batch] 🎉 下载任务完成`);
}

// 查找所有 "Download full size" 按钮（按页面顺序）
function findDownloadFullSizeButtons() {
  // 多种选择器尝试
  const selectors = [
    'button[aria-label*="Download full size"]',
    'button[aria-label*="下载完整尺寸"]',
    'button[data-test-id="download-generated-image-button"]',
    'button[aria-label*="Download"]',
    'button[title*="Download full size"]',
    'button[title*="下载完整尺寸"]',
    'mat-icon[fonticon="download"]',
    'button:has(mat-icon[fonticon="download"])',
  ];

  const buttons = [];
  for (const selector of selectors) {
    try {
      const found = Array.from(document.querySelectorAll(selector));
      for (const btn of found) {
        // 如果是 mat-icon，找最近的 button 父元素
        let button = btn;
        if (btn.tagName === "MAT-ICON") {
          button = btn.closest("button") || btn.parentElement;
        }

        // 检查按钮文本或 aria-label 是否包含下载相关关键词
        const text = (
          button.textContent ||
          button.getAttribute("aria-label") ||
          ""
        ).toLowerCase();
        if (
          text.includes("download") ||
          text.includes("下载") ||
          text.includes("full size") ||
          text.includes("完整尺寸")
        ) {
          // 避免重复添加
          if (!buttons.includes(button)) {
            buttons.push(button);
          }
        }
      }
      if (buttons.length > 0) break; // 找到就停止
    } catch (e) {
      // 某些选择器可能不支持（如 :has），忽略错误
      continue;
    }
  }

  // 按 DOM 顺序排序（从上到下）
  return buttons.sort((a, b) => {
    const posA = a.getBoundingClientRect().top;
    const posB = b.getBoundingClientRect().top;
    return posA - posB;
  });
}

// 兜底方案：如果找不到按钮，回退到旧的 fetch 模式
async function downloadAllGeneratedImagesFallback(expectedCount = null) {
  console.log("[Batch] ⚠️ 使用兜底 fetch 模式...");

  // 这里保留原来的 fetch 逻辑作为兜底
  const allImages = Array.from(document.querySelectorAll("img"));
  const validImages = allImages.filter((img) => {
    const src = img.src || "";
    if (!isRasterImageUrl(src)) return false;
    if (!img.complete || img.naturalWidth === 0) return false;
    if (src.includes("nano-banana")) return false;
    if (src.includes("profile_photo")) return false;
    return img.naturalWidth > 200;
  });

  if (!validImages.length) {
    console.warn("[Batch] 未找到任何有效图片");
    chrome.runtime.sendMessage({
      action: "generationError",
      error: "未找到任何生成的图片，请检查生成是否成功",
    });
    return;
  }

  const count =
    expectedCount !== null
      ? expectedCount
      : currentPrompts.length || validImages.length;
  const targetImages = validImages.slice(-count);

  console.warn(
    `[Batch] 兜底模式：找到 ${targetImages.length} 张图，但无法保证高清质量`
  );
  // 这里可以调用旧的 fetchAndDownloadWithAuth，但建议用户使用按钮模式
}

// 使用带凭证的 fetch 获取图片并下载（解决 rd-gg-dl 需身份校验导致的 pageX.html 问题）
async function fetchAndDownloadWithAuth(url, filename, pageNum, options = {}) {
  const { skipTypeCheck = false, skipSizeCheck = false } = options;
  try {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "include",
      headers: {
        // 尽量模拟来源，减少 403/重定向
        Referer: "https://gemini.google.com/",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (!skipTypeCheck && !contentType.startsWith("image/")) {
      throw new Error(`Invalid content-type: ${contentType || "unknown"}`);
    }

    const blob = await res.blob();
    if (!skipSizeCheck && blob.size < 2000) {
      throw new Error(
        `Image too small (${blob.size} bytes), likely error response`
      );
    }

    const objectUrl = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "downloadDirectly",
          url: objectUrl,
          filename,
        },
        (res) => {
          if (res && res.success) {
            console.log(
              `[Batch] Page ${pageNum} 已通过 fetch+blob 发送下载 (size ${(
                blob.size /
                1024 /
                1024
              ).toFixed(2)} MB)`
            );
          } else {
            console.error(`[Batch] Page ${pageNum} 下载失败`, res && res.error);
          }
          // 下载请求发出后即可释放 blob
          setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
          resolve();
        }
      );
    });
  } catch (err) {
    console.error(`[Batch] Page ${pageNum} fetch 下载失败，尝试直接下载`, err);
    // 兜底：回退到背景页直链下载（可能返回小图或 html）
    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "downloadDirectly",
          url,
          filename,
        },
        () => resolve()
      );
    });
    throw err; // 将错误抛出给上层以尝试下一候选
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (window.location.href.includes("gemini.google.com")) {
  console.log("Gemini Auto PPT Generator: Ready (Page Context Mode)");
}
