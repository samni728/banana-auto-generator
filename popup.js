// Popup script - handles UI interactions and communicates with content script

let isRunning = false;
let currentTab = null;

const elements = {
  prompts: document.getElementById("prompts"),
  saveDirectory: document.getElementById("saveDirectory"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  progressFill: document.getElementById("progressFill"),
  progressText: document.getElementById("progressText"),
  fastMode: document.getElementById("fastMode"), // 极速模式复选框
};
// 动态创建"仅下载当前页图片"按钮（当页面已有图片时才显示）
const downloadExistingBtn = document.createElement("button");
downloadExistingBtn.id = "downloadExistingBtn";
downloadExistingBtn.textContent = "📥 下载本页图片";
downloadExistingBtn.style.display = "none";
downloadExistingBtn.style.marginLeft = "8px";
downloadExistingBtn.style.whiteSpace = "nowrap";
downloadExistingBtn.style.fontSize = "13px";
downloadExistingBtn.style.padding = "8px 12px";
downloadExistingBtn.style.background = "#10b981";
downloadExistingBtn.style.color = "white";
downloadExistingBtn.style.border = "none";
downloadExistingBtn.style.borderRadius = "6px";
downloadExistingBtn.style.cursor = "pointer";
downloadExistingBtn.className = "btn secondary";

// 记录当前检测到的图片数量
let detectedImageCount = 0;

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  // Load saved prompts, directory and fastMode
  const saved = await chrome.storage.local.get([
    "prompts",
    "saveDirectory",
    "fastMode",
  ]);
  if (saved.prompts) {
    elements.prompts.value = saved.prompts;
  }
  if (saved.saveDirectory) {
    elements.saveDirectory.value = saved.saveDirectory;
  }
  if (saved.fastMode !== undefined) {
    elements.fastMode.checked = saved.fastMode;
  }

  // 初始化按钮显示数量
  updateStartButtonText();

  // Check if we're on Gemini page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab.url.includes("gemini.google.com")) {
    showStatus("请在 Gemini 页面使用此插件", "error");
    elements.startBtn.disabled = true;
    return;
  }

  // 检查任务状态（优先从 background 查询持久化状态）
  await checkTaskStatus();
  // 检查当前页是否已有可下载图片，决定是否显示一键下载按钮
  await checkExistingImagesAndToggle();

  // 定期更新状态（每2秒）
  const statusInterval = setInterval(async () => {
    await checkTaskStatus();
    await checkExistingImagesAndToggle();
  }, 2000);

  // 页面关闭时清理定时器
  window.addEventListener("beforeunload", () => {
    clearInterval(statusInterval);
  });

  // 将下载按钮插入到停止按钮后面
  const stopParent = elements.stopBtn.parentElement || elements.stopBtn;
  stopParent.appendChild(downloadExistingBtn);
});

// 记录当前显示的进度（确保只增不减）
let lastDisplayedProgress = 0;

// 检查任务状态
async function checkTaskStatus() {
  try {
    // 优先从 background 查询持久化状态
    const bgState = await chrome.runtime.sendMessage({
      action: "getTaskState",
    });

    if (bgState && bgState.isGenerating) {
      // 从 background 恢复状态
      isRunning = true;
      elements.startBtn.style.display = "none";
      elements.stopBtn.style.display = "block";
      elements.prompts.disabled = true;

      if (bgState.currentIndex && bgState.total) {
        // 确保进度只增不减
        const newProgress = Math.max(
          bgState.currentIndex,
          lastDisplayedProgress
        );
        if (newProgress > lastDisplayedProgress) {
          lastDisplayedProgress = newProgress;
          updateProgress(newProgress, bgState.total);
          const statusText =
            bgState.status === "downloading"
              ? `正在下载第 ${newProgress} 张图片...`
              : `正在生成第 ${newProgress} 张图片...`;
          showStatus(statusText, "processing");
        }
      } else {
        const statusText =
          bgState.status === "downloading"
            ? "正在下载图片..."
            : "正在生成图片...";
        showStatus(statusText, "processing");
      }
      return;
    }

    // 备用：从 content script 查询（如果 background 没有状态）
    try {
      const response = await chrome.tabs.sendMessage(currentTab.id, {
        action: "getStatus",
      });

      if (response && response.isGenerating) {
        isRunning = true;
        elements.startBtn.style.display = "none";
        elements.stopBtn.style.display = "block";
        elements.prompts.disabled = true;

        if (response.current && response.total) {
          // 确保进度只增不减
          const newProgress = Math.max(response.current, lastDisplayedProgress);
          if (newProgress > lastDisplayedProgress) {
            lastDisplayedProgress = newProgress;
            updateProgress(newProgress, response.total);
            showStatus(`正在生成第 ${newProgress} 张图片...`, "processing");
          }
        } else {
          showStatus("正在生成图片...", "processing");
        }
      } else if (isRunning) {
        // 如果之前显示运行中，但现在没有运行，重置UI
        resetUI();
        lastDisplayedProgress = 0; // 重置进度
      }
    } catch (error) {
      // Content script 未就绪或没有运行的任务
      if (isRunning) {
        // 如果 background 也没有状态，重置UI
        if (!bgState || !bgState.isGenerating) {
          resetUI();
          lastDisplayedProgress = 0; // 重置进度
        }
      }
    }
  } catch (error) {
    console.log("查询任务状态失败:", error);
  }
}

// Save prompts and directory on change
elements.prompts.addEventListener("input", () => {
  chrome.storage.local.set({ prompts: elements.prompts.value });
  updateStartButtonText(); // 实时更新按钮显示
});

elements.saveDirectory.addEventListener("input", () => {
  chrome.storage.local.set({ saveDirectory: elements.saveDirectory.value });
});

// 保存极速模式设置
elements.fastMode.addEventListener("change", () => {
  chrome.storage.local.set({ fastMode: elements.fastMode.checked });
  console.log(
    `[Popup] 极速模式: ${elements.fastMode.checked ? "开启" : "关闭"}`
  );
});

// 实时更新开始按钮文本（显示图片数量）
function updateStartButtonText() {
  const text = elements.prompts.value.trim();
  const count = text ? text.split("\n").filter((p) => p.trim()).length : 0;

  if (count > 0) {
    elements.startBtn.textContent = `🚀 开始生成 (${count} 张)`;
  } else {
    elements.startBtn.textContent = `🚀 开始生成`;
  }
}

// Start button
elements.startBtn.addEventListener("click", async () => {
  const promptsText = elements.prompts.value.trim();
  if (!promptsText) {
    showStatus("请输入至少一个提示词", "error");
    return;
  }

  const prompts = promptsText.split("\n").filter((p) => p.trim());
  if (prompts.length === 0) {
    showStatus("请输入至少一个提示词", "error");
    return;
  }

  isRunning = true;
  elements.startBtn.style.display = "none";
  elements.stopBtn.style.display = "block";
  elements.prompts.disabled = true;

  showStatus(`准备生成 ${prompts.length} 张图片...`, "processing");
  updateProgress(0, prompts.length);

  // Send to content script
  try {
    await chrome.tabs.sendMessage(currentTab.id, {
      action: "startGeneration",
      prompts: prompts,
      saveDirectory: elements.saveDirectory.value.trim(),
      isFastMode: elements.fastMode.checked, // 传递极速模式参数
    });
    console.log(
      `[Popup] 任务启动，模式: ${
        elements.fastMode.checked ? "⚡极速" : "🐢模拟人类"
      }`
    );
  } catch (error) {
    showStatus("发送消息失败，请刷新 Gemini 页面后重试", "error");
    resetUI();
  }
});

// Stop button
elements.stopBtn.addEventListener("click", async () => {
  if (currentTab) {
    await chrome.tabs.sendMessage(currentTab.id, {
      action: "stopGeneration",
    });
  }
  resetUI();
  showStatus("已停止", "error");
});

// Clear button
elements.clearBtn.addEventListener("click", async () => {
  elements.prompts.value = "";
  elements.saveDirectory.value = "";
  chrome.storage.local.remove(["prompts", "saveDirectory"]);

  // 通知 content script 清理提交记录
  if (currentTab) {
    try {
      await chrome.tabs.sendMessage(currentTab.id, {
        action: "clearSubmissionRecords",
      });
    } catch (error) {
      // Content script 可能未就绪，忽略错误
      console.log("清理提交记录失败（可能 content script 未就绪）");
    }
  }

  showStatus("已清空", "success");
  setTimeout(() => {
    elements.status.classList.remove("active");
  }, 1500);
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateProgress") {
    // 确保进度只增不减
    const newProgress = Math.max(message.current, lastDisplayedProgress);
    if (newProgress > lastDisplayedProgress) {
      lastDisplayedProgress = newProgress;
      updateProgress(newProgress, message.total);
      const statusText =
        message.status === "downloading"
          ? `正在下载第 ${newProgress} 张图片...`
          : `正在生成第 ${newProgress} 张图片...`;
      showStatus(statusText, "processing");
    }
    // 确保UI状态正确
    if (!isRunning) {
      isRunning = true;
      elements.startBtn.style.display = "none";
      elements.stopBtn.style.display = "block";
      elements.prompts.disabled = true;
    }
  } else if (message.action === "generationComplete") {
    showStatus(`✅ 成功生成 ${message.total} 张图片！`, "success");
    resetUI();
    lastDisplayedProgress = 0; // 重置进度
  } else if (message.action === "generationError") {
    showStatus(`❌ 错误: ${message.error}`, "error");
    resetUI();
    lastDisplayedProgress = 0; // 重置进度
  }
});

// 检查当前页是否已有可下载图片，控制"下载当前页图片"按钮显示
async function checkExistingImagesAndToggle() {
  if (!currentTab) return;
  try {
    const res = await chrome.tabs.sendMessage(currentTab.id, {
      action: "checkExistingImages",
    });
    if (res && res.count && res.count > 0) {
      detectedImageCount = res.count;
      downloadExistingBtn.style.display = "inline-block";
      downloadExistingBtn.disabled = false;
      // 在按钮上显示图片数量
      downloadExistingBtn.textContent = `📥 下载 ${res.count} 张图片`;
      downloadExistingBtn.title = `检测到 ${res.count} 张高清图片，点击下载`;
    } else {
      detectedImageCount = 0;
      downloadExistingBtn.style.display = "none";
    }
  } catch (e) {
    detectedImageCount = 0;
    downloadExistingBtn.style.display = "none";
  }
}

// 仅下载当前页已有图片
downloadExistingBtn.addEventListener("click", async () => {
  if (!currentTab) return;
  const dir = elements.saveDirectory.value.trim();
  downloadExistingBtn.disabled = true;

  // 更新按钮文本显示下载中状态
  const originalText = downloadExistingBtn.textContent;
  downloadExistingBtn.textContent = `⏳ 下载中...`;

  showStatus(`正在下载 ${detectedImageCount} 张图片...`, "processing");
  updateProgress(0, detectedImageCount);

  try {
    const res = await chrome.tabs.sendMessage(currentTab.id, {
      action: "downloadExisting",
      saveDirectory: dir,
      expectedCount: detectedImageCount, // 传递期望的图片数量
    });
    if (res && res.success) {
      showStatus(`开始下载 ${detectedImageCount} 张图片...`, "success");
    } else {
      showStatus("下载启动失败", "error");
      downloadExistingBtn.textContent = originalText;
    }
  } catch (e) {
    showStatus("下载启动失败，请刷新页面重试", "error");
    downloadExistingBtn.textContent = originalText;
  } finally {
    setTimeout(() => {
      downloadExistingBtn.disabled = false;
      // 恢复按钮文本
      downloadExistingBtn.textContent = originalText;
    }, 3000);
  }
});

function showStatus(text, type) {
  elements.statusText.textContent = text;
  elements.status.className = `status active ${type}`;
}

function updateProgress(current, total) {
  const percent = (current / total) * 100;
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = `${current} / ${total}`;
}

function resetUI() {
  isRunning = false;
  elements.startBtn.style.display = "block";
  elements.stopBtn.style.display = "none";
  elements.prompts.disabled = false;
  lastDisplayedProgress = 0; // 重置进度
}
