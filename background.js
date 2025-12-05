// background.js - 任务状态持久化版本 + webRequest 网络监听

// 任务状态存储（持久化到 chrome.storage）
let taskState = {
  isGenerating: false,
  currentIndex: 0,
  total: 0,
  prompts: [],
  saveDirectory: "",
  tabId: null,
  startTime: null,
  lastUpdate: null,
  status: "idle", // generating | downloading | idle
};

// 网络监听队列：用于捕获点击按钮后的真实下载请求
let downloadQueue = []; // 存放预期的文件名队列
let isSniffing = false; // 开关，防止平时误下载
let capturedUrls = new Set(); // 已捕获的 URL，避免重复下载

// 初始化：从存储恢复状态
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Gemini Auto PPT Generator installed");
  const saved = await chrome.storage.local.get(["taskState"]);
  if (saved.taskState) {
    taskState = { ...taskState, ...saved.taskState };
    console.log("[BG] 恢复任务状态:", taskState);
  }
});

// 监听标签页更新（检测刷新/导航）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 如果任务正在运行且标签页被刷新
  if (
    taskState.isGenerating &&
    taskState.tabId === tabId &&
    changeInfo.status === "loading"
  ) {
    console.log(`[BG] 检测到标签页 ${tabId} 正在刷新，任务状态保持`);
    // 状态保持，等待 content script 恢复
  }
});

// 监听标签页关闭
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (taskState.isGenerating && taskState.tabId === tabId) {
    console.log(`[BG] 任务标签页 ${tabId} 已关闭，清理任务状态`);
    await clearTaskState();
  }
});

// 保存任务状态到存储
async function saveTaskState() {
  taskState.lastUpdate = Date.now();
  await chrome.storage.local.set({ taskState });
  console.log("[BG] 任务状态已保存:", taskState);
}

// 清理任务状态
async function clearTaskState() {
  taskState = {
    isGenerating: false,
    currentIndex: 0,
    total: 0,
    prompts: [],
    saveDirectory: "",
    tabId: null,
    startTime: null,
    lastUpdate: null,
  };
  await chrome.storage.local.remove(["taskState"]);
  console.log("[BG] 任务状态已清理");
}

// 【已删除】requestDownloadMap 不再需要，因为不再使用 onCompleted 监听器
// 之前的代码：const requestDownloadMap = new Map();

// 核心：监听网络请求，捕获 /rd-gg/ 高清图链接
chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    // 【核心修复1】根据 fix.md：必须明确排除 /rd-gg-dl/，避免下载到 833 字节的元数据文件
    // /rd-gg-dl/ 也包含 /rd-gg/，但它是假文件，不是真正的图片
    const isTargetUrl =
      details.url.includes("/rd-gg/") && !details.url.includes("/rd-gg-dl/");

    // 只在任务进行中，且 URL 是目标 URL 时触发
    // 【优化】根据 fix.md 建议：检查完整 URL 和基础 URL（去掉查询参数）是否已被捕获
    const baseUrl = details.url.split("?")[0];
    const isDuplicate =
      capturedUrls.has(details.url) || capturedUrls.has(baseUrl);

    if (isSniffing && isTargetUrl && !isDuplicate) {
      // 检查队列是否为空
      if (downloadQueue.length === 0) {
        console.warn(
          `[BG] ⚠️ 队列已空，但收到新请求: ${details.url.substring(0, 80)}...`
        );
        return {};
      }

      // 取出队列中的下一个文件名（同步操作，避免竞态条件）
      const currentFilename = downloadQueue.shift();
      const remainingCount = downloadQueue.length;

      console.log(
        `[BG] 🎯 捕获到高清链接 (请求ID: ${
          details.requestId
        }): ${details.url.substring(0, 80)}...`
      );
      console.log(
        `[BG] 📝 分配文件名: ${currentFilename} (剩余队列: ${remainingCount})`
      );

      // 标记已捕获，避免重复
      // 【优化】根据 fix.md 建议：如果 URL 带有时间戳参数，去重可能失效
      // 我们同时保存完整 URL 和基础 URL（去掉查询参数）进行双重去重
      capturedUrls.add(details.url);
      if (baseUrl !== details.url) {
        capturedUrls.add(baseUrl); // 也标记基础 URL，防止时间戳变体
      }

      // 发起真实下载（使用捕获到的真实 URL，带完整 cookies 和 referer）
      chrome.downloads.download(
        {
          url: details.url,
          filename: currentFilename,
          conflictAction: "uniquify",
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(
              `[BG] ❌ 下载失败 (${currentFilename}):`,
              chrome.runtime.lastError.message
            );
            // 通知 content script 下载失败
            if (details.tabId) {
              chrome.tabs
                .sendMessage(details.tabId, {
                  action: "downloadFailed",
                  filename: currentFilename,
                })
                .catch(() => {});
            }
          } else {
            console.log(
              `[BG] ✅ 下载任务已建立: ${currentFilename} (下载ID: ${downloadId}, 请求ID: ${details.requestId})`
            );
            // 【核心修复2】根据 fix.md：在这里直接通知前台成功！不要去等 onCompleted！
            // 当网络请求被识别为"下载文件"时，onCompleted 事件往往不会触发，导致超时
            if (details.tabId >= 0) {
              chrome.tabs
                .sendMessage(details.tabId, {
                  action: "downloadStarted", // 告诉前台：搞定了，继续下一个
                  filename: currentFilename,
                  downloadId: downloadId,
                })
                .catch(() => {
                  // Content script 可能未就绪，忽略错误
                });
            }
          }
        }
      );

      // 【修复】根据分析报告：不要因为队列空就关闭监听器
      // Gemini 的请求有严重延迟（36-123秒），如果提前关闭监听器，延迟的请求无法被捕获
      // 改为：等待 content script 主动发送 stopSniffing 消息
      if (downloadQueue.length === 0) {
        console.log(
          `[BG] ⚠️ 队列已空，但保持监听器开启（等待可能的延迟请求）`
        );
        // 不关闭 isSniffing，继续监听可能的延迟请求
        // 监听器将在 content script 发送 stopSniffing 时关闭
      }
    } else if (isSniffing && details.url.includes("/rd-gg/")) {
      // URL 已被捕获过，跳过
      // 【优化】检查完整 URL 和基础 URL 是否都被捕获过
      const checkBaseUrl = details.url.split("?")[0];
      const isAlreadyCaptured =
        capturedUrls.has(details.url) || capturedUrls.has(checkBaseUrl);
      if (isAlreadyCaptured) {
        console.log(`[BG] ⏭️ 跳过重复URL: ${details.url.substring(0, 80)}...`);
      }
    }
    // 不阻塞请求，让页面原本的逻辑继续
    return {};
  },
  { urls: ["*://*.googleusercontent.com/rd-gg/*"] }, // 过滤 Log 中的特征域名
  [] // Manifest V3 不支持 blocking，使用空数组
);

// 【核心修复3】根据 fix.md：删除 onCompleted 监听器
// 原因：当网络请求被识别为"下载文件"时，onCompleted 事件往往不会触发，导致超时
// 解决方案：在 onBeforeRequest 的 chrome.downloads.download 回调里直接发送成功消息
// 这个监听器是导致超时的罪魁祸首，已删除

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 开始监听网络请求（由 content script 调用）
  if (message.action === "startSniffing") {
    // 【优化】根据 fix.md 建议：确保在开始新任务前清理所有状态
    isSniffing = true;
    downloadQueue = [...(message.filenames || [])]; // 创建新数组，避免引用问题
    capturedUrls.clear(); // 清空已捕获记录
    console.log(
      `[BG] 🎬 开始监听高清图请求，队列长度: ${downloadQueue.length}`
    );
    console.log(`[BG] 📋 队列内容:`, downloadQueue);
    // 【优化】验证队列不为空
    if (downloadQueue.length === 0) {
      console.warn(`[BG] ⚠️ 警告：队列为空，无法开始下载任务`);
      isSniffing = false;
      sendResponse({ success: false, error: "队列为空" });
      return true;
    }
    sendResponse({ success: true });
    return true;
  }

  // 停止监听（清理状态）
  if (message.action === "stopSniffing") {
    isSniffing = false;
    downloadQueue = [];
    capturedUrls.clear();
    console.log("[BG] 停止监听");
    sendResponse({ success: true });
    return true;
  }

  // 下载功能（保留用于兜底）
  if (message.action === "downloadDirectly") {
    console.log(`[BG] API Downloading: ${message.filename}`);

    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(`[BG] Error: ${chrome.runtime.lastError.message}`);
          sendResponse({
            success: false,
            error: chrome.runtime.lastError.message,
          });
        } else {
          console.log(`[BG] Started ID: ${downloadId}`);
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }

  // 任务状态管理
  if (message.action === "taskStart") {
    taskState = {
      isGenerating: true,
      currentIndex: 0,
      total: message.total || 0,
      prompts: message.prompts || [],
      saveDirectory: message.saveDirectory || "",
      tabId: sender.tab?.id || null,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      status: message.status || "generating",
    };
    saveTaskState();
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "taskUpdate") {
    if (taskState.isGenerating && taskState.tabId === sender.tab?.id) {
      // currentIndex 应该是 displayIndex（1-based），确保进度正确
      taskState.currentIndex = message.currentIndex || taskState.currentIndex;
      if (message.status) {
        taskState.status = message.status;
      }
      taskState.lastUpdate = Date.now();
      saveTaskState();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "任务状态不匹配" });
    }
    return true;
  }

  if (message.action === "taskComplete") {
    if (taskState.isGenerating && taskState.tabId === sender.tab?.id) {
      clearTaskState();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  if (message.action === "taskStop") {
    if (taskState.isGenerating && taskState.tabId === sender.tab?.id) {
      clearTaskState();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  if (message.action === "taskError") {
    if (taskState.isGenerating && taskState.tabId === sender.tab?.id) {
      clearTaskState();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  // 查询任务状态（供 popup 使用）
  if (message.action === "getTaskState") {
    sendResponse({ ...taskState });
    return true;
  }

  // 恢复任务（供 content script 使用）
  if (message.action === "restoreTask") {
    if (taskState.isGenerating && taskState.tabId === sender.tab?.id) {
      sendResponse({
        success: true,
        state: {
          prompts: taskState.prompts,
          saveDirectory: taskState.saveDirectory,
          currentIndex: taskState.currentIndex,
          total: taskState.total,
        },
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
});
