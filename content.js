// Content script - runs on Gemini page and handles automation

let isGenerating = false;
let shouldStop = false;
let currentPrompts = [];
let currentIndex = 0;
let saveDirectory = '';
let currentDownloadId = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startGeneration') {
        currentPrompts = message.prompts;
        saveDirectory = message.saveDirectory || '';
        currentIndex = 0;
        shouldStop = false;
        startGeneration();
    } else if (message.action === 'stopGeneration') {
        shouldStop = true;
        isGenerating = false;
    } else if (message.action === 'getStatus') {
        sendResponse({
            isGenerating: isGenerating,
            current: currentIndex,
            total: currentPrompts.length
        });
        return true;
    } else if (message.action === 'downloadStarted') {
        console.log('[Content] Received downloadStarted message, downloadId:', message.downloadId);
        currentDownloadId = message.downloadId;
        sendResponse({ success: true });
        return true;
    }
});

async function startGeneration() {
    if (isGenerating || shouldStop) return;
    isGenerating = true;

    try {
        for (let i = 0; i < currentPrompts.length; i++) {
            if (shouldStop) break;

            currentIndex = i + 1;
            const prompt = currentPrompts[i];

            chrome.runtime.sendMessage({
                action: 'updateProgress',
                current: currentIndex,
                total: currentPrompts.length
            });

            await submitPrompt(prompt);
            await waitForImageGeneration();
            await downloadImage(currentIndex);
            await sleep(1000);
        }

        if (!shouldStop) {
            chrome.runtime.sendMessage({
                action: 'generationComplete',
                total: currentPrompts.length
            });
        }
    } catch (error) {
        chrome.runtime.sendMessage({
            action: 'generationError',
            error: error.message
        });
    } finally {
        isGenerating = false;
    }
}

async function submitPrompt(prompt) {
    const input = document.querySelector('rich-textarea[placeholder*="Enter a prompt"], textarea[placeholder*="Enter a prompt"], div[contenteditable="true"][role="textbox"]');

    if (!input) {
        throw new Error('找不到输入框');
    }

    if (input.tagName === 'TEXTAREA') {
        input.value = '';
        input.focus();
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        input.focus();
        input.textContent = '';
        input.textContent = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await sleep(500);

    const submitButton = document.querySelector('button[aria-label*="Send"], button[aria-label*="提交"], button[type="submit"]');
    if (submitButton && !submitButton.disabled) {
        submitButton.click();
    } else {
        const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true
        });
        input.dispatchEvent(enterEvent);
    }

    await sleep(1000);
}

async function waitForImageGeneration() {
    const maxWaitTime = 180000; // 3分钟
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
        if (shouldStop) break;

        // Check for thinking/loading indicators
        const thinkingElement = document.querySelector(
            '[data-test-id="thinking"], ' +
            '.thinking, ' +
            '[aria-label*="Thinking"], ' +
            '[aria-label*="思考中"], ' +
            '[aria-label*="生成中"]'
        );

        // Check for download button with multiple selectors
        const downloadButton = document.querySelector(
            'mat-icon[fonticon="download"], ' +
            'button[aria-label*="Download"], ' +
            'button[aria-label*="下载"], ' +
            'button[title*="Download"], ' +
            'button[title*="下载"], ' +
            'div[role="button"][aria-label*="Download"], ' +
            'div[role="button"][aria-label*="下载"], ' +
            'button[aria-label*="Save"], ' +
            'button[aria-label*="保存"]'
        );

        // Image is ready when thinking is gone and download button exists
        if (!thinkingElement && downloadButton) {
            console.log('Image generation complete, download button found');
            await sleep(2000); // Wait a bit more to ensure button is fully ready
            return;
        }

        await sleep(1000);
    }

    throw new Error('图片生成超时（3分钟）');
}

// Prepare download with filename before clicking
async function prepareDownload(pageNumber) {
    const filename = saveDirectory
        ? `${saveDirectory}/page${pageNumber}.png`
        : `page${pageNumber}.png`;

    console.log(`[Page ${pageNumber}] Preparing download with filename: ${filename}`);

    // Notify background to prepare download queue
    // Background script will get tabId from sender.tab.id
    await chrome.runtime.sendMessage({
        action: 'prepareDownload',
        filename: filename,
        pageNumber: pageNumber
    });
}

// Click download button and wait for completion
async function clickDownloadButton() {
    // Find download button - try multiple selectors
    let downloadButton = document.querySelector(
        'mat-icon[fonticon="download"], ' +
        'button[aria-label*="Download"], ' +
        'button[aria-label*="下载"], ' +
        'button[title*="Download"], ' +
        'button[title*="下载"], ' +
        'div[role="button"][aria-label*="Download"], ' +
        'div[role="button"][aria-label*="下载"], ' +
        'button[aria-label*="Save"], ' +
        'button[aria-label*="保存"]'
    );

    // If button is inside a mat-icon, find the parent button
    if (downloadButton && downloadButton.tagName === 'MAT-ICON') {
        downloadButton = downloadButton.closest('button') || downloadButton.parentElement;
    }

    if (!downloadButton) {
        throw new Error('找不到下载按钮');
    }

    console.log('Found download button, clicking...');
    console.log('Button element:', downloadButton);
    
    // Scroll into view if needed
    downloadButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300);

    // Try multiple click methods
    if (downloadButton.click) {
        downloadButton.click();
    } else if (downloadButton.dispatchEvent) {
        const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
        });
        downloadButton.dispatchEvent(clickEvent);
    } else {
        // Fallback: trigger click on parent
        const parent = downloadButton.parentElement;
        if (parent && parent.click) {
            parent.click();
        } else {
            throw new Error('无法点击下载按钮');
        }
    }
    
    console.log('Download button clicked');
    // 增加等待时间，确保下载事件被触发
    await sleep(1500);
}

// Wait for download completion using event-based approach
async function waitForDownloadCompletion(pageNumber) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            // Clean up listener
            chrome.runtime.onMessage.removeListener(messageHandler);
            reject(new Error(`下载超时（3分钟）- Page ${pageNumber}`));
        }, 180000); // 3分钟超时

        const messageHandler = (message, sender, sendResponse) => {
            // Only handle messages for this specific download
            if (message.action === 'downloadComplete' && message.pageNumber === pageNumber) {
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageHandler);
                console.log(`[Page ${pageNumber}] Download completed via event`);
                currentDownloadId = null;
                resolve();
                return true;
            } else if (message.action === 'downloadFailed' && message.pageNumber === pageNumber) {
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageHandler);
                currentDownloadId = null;
                reject(new Error(`下载失败 - Page ${pageNumber}`));
                return true;
            }
        };

        // Set up listener before clicking download
        chrome.runtime.onMessage.addListener(messageHandler);

        // Also set a timeout to check if download started
        let waitForStart = 0;
        const startCheckInterval = setInterval(() => {
            waitForStart++;
            if (currentDownloadId) {
                clearInterval(startCheckInterval);
                console.log(`[Page ${pageNumber}] Download ID received: ${currentDownloadId}, waiting for completion...`);
            } else if (waitForStart >= 15) {
                clearInterval(startCheckInterval);
                clearTimeout(timeout);
                chrome.runtime.onMessage.removeListener(messageHandler);
                reject(new Error(`下载未启动 - Page ${pageNumber}（15秒内未检测到下载）`));
            }
        }, 1000);
    });
}

async function downloadImage(pageNumber) {
    console.log(`[Page ${pageNumber}] Starting download process...`);

    try {
        // Reset downloadId before starting
        currentDownloadId = null;
        
        // Step 1: Prepare download with filename (add to queue)
        await prepareDownload(pageNumber);
        
        // Small delay to ensure queue is ready
        await sleep(200);

        // Step 2: Set up completion listener BEFORE clicking
        const downloadPromise = waitForDownloadCompletion(pageNumber);

        // Step 3: Click download button
        await clickDownloadButton();

        // Step 4: Wait for download to complete (event-based, not polling)
        await downloadPromise;

        console.log(`[Page ${pageNumber}] Download successful`);

    } catch (error) {
        console.error(`[Page ${pageNumber}] Error:`, error);
        currentDownloadId = null;
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

if (window.location.href.includes('gemini.google.com')) {
    console.log('Gemini Auto PPT Generator: Ready (Page Context Mode)');
}
