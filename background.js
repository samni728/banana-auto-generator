// background.js - 任务状态持久化版本 + webRequest 网络监听（智能头信息校验版）

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
let processedRequestIds = new Set(); // 已处理的请求ID，防止重复（用于 onHeadersReceived）

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

// 【核心优化】根据 fix1.md：改用 onHeadersReceived 监听
// 原因：onBeforeRequest 只能看 URL，无法分辨文件真假
// onHeadersReceived 可以看到 Content-Length 和 Content-Type，实现智能过滤

chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    // 未开启监听，跳过
    if (!isSniffing) return;

    // 1. URL 粗筛：必须包含 rd-gg（兼容 rd-gg 和 rd-gg-dl）
    if (!details.url.includes("rd-gg")) return;

    // 2. 检查是否已处理过该请求（防止重复）
    if (processedRequestIds.has(details.requestId)) {
      console.log(`[BG] ⏭️ 跳过已处理的请求ID: ${details.requestId}`);
      return;
    }

    // 3. 获取响应头信息
    const headers = details.responseHeaders || [];

    // 获取 Content-Length (文件大小)
    const lengthHeader = headers.find(
      (h) => h.name.toLowerCase() === "content-length"
    );
    const contentLength = lengthHeader ? parseInt(lengthHeader.value, 10) : 0;

    // 获取 Content-Type (文件类型)
    const typeHeader = headers.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentType = typeHeader ? typeHeader.value.toLowerCase() : "";

    // 4. 【关键智能过滤】
    // 条件A: 大小必须超过 50KB（过滤掉 833 bytes 的元数据文件）
    // 条件B: 类型必须是图片（image/png, image/jpeg, image/webp）
    const MIN_SIZE = 50000; // 50KB
    const isRealImage =
      contentLength > MIN_SIZE && contentType.startsWith("image/");

    if (isRealImage) {
      // 检查 URL 去重
      const baseUrl = details.url.split("?")[0];
      const isDuplicate =
        capturedUrls.has(details.url) || capturedUrls.has(baseUrl);

      if (isDuplicate) {
        console.log(`[BG] ⏭️ 跳过重复URL: ${details.url.substring(0, 80)}...`);
        return;
      }

      // 检查队列是否为空
      if (downloadQueue.length === 0) {
        console.warn(
          `[BG] ⚠️ 队列已空，但捕获到合格大图: ${details.url.substring(
            0,
            80
          )}...`
        );
        console.warn(
          `[BG] 📊 大小: ${(contentLength / 1024 / 1024).toFixed(
            2
          )}MB, 类型: ${contentType}`
        );
        return;
      }

      // 取出队列中的下一个文件名
      const currentFilename = downloadQueue.shift();
      processedRequestIds.add(details.requestId); // 标记该请求ID已处理

      // 标记 URL 已捕获
      capturedUrls.add(details.url);
      if (baseUrl !== details.url) {
        capturedUrls.add(baseUrl);
      }

      console.log(
        `[BG] 🎯 捕获合格大图 (大小: ${(contentLength / 1024 / 1024).toFixed(
          2
        )}MB, 类型: ${contentType})`
      );
      console.log(
        `[BG] 📝 分配文件名: ${currentFilename} (剩余队列: ${downloadQueue.length})`
      );

      // 发起下载（复用这个经过验证的 URL）
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
            if (details.tabId >= 0) {
              chrome.tabs
                .sendMessage(details.tabId, {
                  action: "downloadFailed",
                  filename: currentFilename,
                })
                .catch(() => {});
            }
          } else {
            console.log(
              `[BG] ✅ 下载任务已建立: ${currentFilename} (下载ID: ${downloadId})`
            );
            // 直接通知前台成功
            if (details.tabId >= 0) {
              chrome.tabs
                .sendMessage(details.tabId, {
                  action: "downloadStarted",
                  filename: currentFilename,
                  downloadId: downloadId,
                })
                .catch(() => {});
            }
          }
        }
      );

      // 队列空了但保持监听（等待可能的延迟请求）
      if (downloadQueue.length === 0) {
        console.log(`[BG] ⚠️ 队列已空，保持监听器开启（等待延迟请求）`);
      }
    } else if (details.url.includes("rd-gg")) {
      // 这是一个被过滤掉的请求（比如 833 字节的元数据文件）
      console.log(
        `[BG] 🗑️ 忽略无效/小文件: ${contentLength} bytes, Type: ${contentType}, URL: ${details.url.substring(
          0,
          60
        )}...`
      );
    }

    return {};
  },
  { urls: ["*://*.googleusercontent.com/*rd-gg*"] }, // 匹配所有 rd-gg 相关 URL
  ["responseHeaders"] // 需要这个权限来读取响应头
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 开始监听网络请求（由 content script 调用）
  if (message.action === "startSniffing") {
    // 【优化】确保在开始新任务前清理所有状态
    isSniffing = true;
    downloadQueue = [...(message.filenames || [])]; // 创建新数组，避免引用问题
    capturedUrls.clear(); // 清空已捕获记录
    processedRequestIds.clear(); // 清空已处理请求ID
    console.log(
      `[BG] 🎬 开始监听高清图请求（智能头信息校验模式），队列长度: ${downloadQueue.length}`
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
    processedRequestIds.clear();
    console.log("[BG] 停止监听，已清理所有状态");
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
