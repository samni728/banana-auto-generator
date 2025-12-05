// background.js - 任务状态持久化版本

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
  status: "idle" // generating | downloading | idle
};

// 初始化：从存储恢复状态
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Gemini Auto PPT Generator installed");
  const saved = await chrome.storage.local.get(['taskState']);
  if (saved.taskState) {
    taskState = { ...taskState, ...saved.taskState };
    console.log("[BG] 恢复任务状态:", taskState);
  }
});

// 监听标签页更新（检测刷新/导航）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 如果任务正在运行且标签页被刷新
  if (taskState.isGenerating && taskState.tabId === tabId && changeInfo.status === 'loading') {
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
    lastUpdate: null
  };
  await chrome.storage.local.remove(['taskState']);
  console.log("[BG] 任务状态已清理");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 下载功能
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
    status: message.status || "generating"
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
          total: taskState.total
        }
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
});





