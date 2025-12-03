// Popup script - handles UI interactions and communicates with content script

let isRunning = false;
let currentTab = null;

const elements = {
  prompts: document.getElementById('prompts'),
  saveDirectory: document.getElementById('saveDirectory'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText')
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved prompts and directory
  const saved = await chrome.storage.local.get(['prompts', 'saveDirectory']);
  if (saved.prompts) {
    elements.prompts.value = saved.prompts;
  }
  if (saved.saveDirectory) {
    elements.saveDirectory.value = saved.saveDirectory;
  }

  // Check if we're on Gemini page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab.url.includes('gemini.google.com')) {
    showStatus('请在 Gemini 页面使用此插件', 'error');
    elements.startBtn.disabled = true;
    return;
  }

  // Check if generation is already running
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      action: 'getStatus'
    });

    if (response && response.isGenerating) {
      // Restore running state
      isRunning = true;
      elements.startBtn.style.display = 'none';
      elements.stopBtn.style.display = 'block';
      elements.prompts.disabled = true;

      // Restore progress
      if (response.current && response.total) {
        updateProgress(response.current, response.total);
        showStatus(`正在生成第 ${response.current} 张图片...`, 'processing');
      } else {
        showStatus('正在生成图片...', 'processing');
      }
    }
  } catch (error) {
    // Content script not ready or no generation running
    console.log('No active generation or content script not ready');
  }
});

// Save prompts and directory on change
elements.prompts.addEventListener('input', () => {
  chrome.storage.local.set({ prompts: elements.prompts.value });
});

elements.saveDirectory.addEventListener('input', () => {
  chrome.storage.local.set({ saveDirectory: elements.saveDirectory.value });
});

// Start button
elements.startBtn.addEventListener('click', async () => {
  const promptsText = elements.prompts.value.trim();
  if (!promptsText) {
    showStatus('请输入至少一个提示词', 'error');
    return;
  }

  const prompts = promptsText.split('\n').filter(p => p.trim());
  if (prompts.length === 0) {
    showStatus('请输入至少一个提示词', 'error');
    return;
  }

  isRunning = true;
  elements.startBtn.style.display = 'none';
  elements.stopBtn.style.display = 'block';
  elements.prompts.disabled = true;

  showStatus(`准备生成 ${prompts.length} 张图片...`, 'processing');
  updateProgress(0, prompts.length);

  // Send to content script
  try {
    await chrome.tabs.sendMessage(currentTab.id, {
      action: 'startGeneration',
      prompts: prompts,
      saveDirectory: elements.saveDirectory.value.trim()
    });
  } catch (error) {
    showStatus('发送消息失败，请刷新 Gemini 页面后重试', 'error');
    resetUI();
  }
});

// Stop button
elements.stopBtn.addEventListener('click', async () => {
  if (currentTab) {
    await chrome.tabs.sendMessage(currentTab.id, {
      action: 'stopGeneration'
    });
  }
  resetUI();
  showStatus('已停止', 'error');
});

// Clear button
elements.clearBtn.addEventListener('click', () => {
  elements.prompts.value = '';
  elements.saveDirectory.value = '';
  chrome.storage.local.remove(['prompts', 'saveDirectory']);
  showStatus('已清空', 'success');
  setTimeout(() => {
    elements.status.classList.remove('active');
  }, 1500);
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateProgress') {
    updateProgress(message.current, message.total);
    showStatus(`正在生成第 ${message.current} 张图片...`, 'processing');
  } else if (message.action === 'generationComplete') {
    showStatus(`✅ 成功生成 ${message.total} 张图片！`, 'success');
    resetUI();
  } else if (message.action === 'generationError') {
    showStatus(`❌ 错误: ${message.error}`, 'error');
    resetUI();
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
  elements.startBtn.style.display = 'block';
  elements.stopBtn.style.display = 'none';
  elements.prompts.disabled = false;
}
