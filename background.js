// Background service worker

// Download queue to store filename info before download starts
const downloadQueue = [];
// Map to track active downloads: downloadId -> { tabId, filename, pageNumber }
const activeDownloads = new Map();

chrome.runtime.onInstalled.addListener(() => {
    console.log('Gemini Auto PPT Generator installed');
});

// Prepare download - add to queue
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'prepareDownload') {
        const tabId = sender.tab?.id || null;
        console.log('[BG] Preparing download:', message.filename);
        console.log('[BG] Tab ID:', tabId);
        downloadQueue.push({
            filename: message.filename,
            tabId: tabId,
            pageNumber: message.pageNumber
        });
        console.log('[BG] Queue length:', downloadQueue.length);
        sendResponse({ success: true });
        return true;
    }
    return true;
});

// Intercept downloads and rename them
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    console.log('[BG] onDeterminingFilename triggered');
    console.log('[BG] Download URL:', downloadItem.url);
    console.log('[BG] Queue length:', downloadQueue.length);

    // Only process blob URLs (from Gemini image downloads)
    if (downloadItem.url.startsWith('blob:') && downloadQueue.length > 0) {
        const downloadInfo = downloadQueue.shift();
        console.log('[BG] Renaming download to:', downloadInfo.filename);
        
        // Suggest custom filename with path
        suggest({
            filename: downloadInfo.filename,
            conflictAction: 'uniquify'
        });

        // Store download info for tracking
        activeDownloads.set(downloadItem.id, {
            tabId: downloadInfo.tabId,
            filename: downloadInfo.filename,
            pageNumber: downloadInfo.pageNumber
        });

        // Notify content script that download started
        if (downloadInfo.tabId) {
            console.log('[BG] Download started, ID:', downloadItem.id, 'for tab:', downloadInfo.tabId);
            chrome.tabs.sendMessage(downloadInfo.tabId, {
                action: 'downloadStarted',
                downloadId: downloadItem.id,
                filename: downloadInfo.filename,
                pageNumber: downloadInfo.pageNumber
            }).catch(err => {
                console.error('[BG] Could not notify tab:', err);
            });
        }
    } else {
        // Use default filename for non-blob downloads
        suggest();
    }
});

// Monitor download state changes - this is the key improvement!
chrome.downloads.onChanged.addListener((downloadDelta) => {
    const downloadId = downloadDelta.id;
    const downloadInfo = activeDownloads.get(downloadId);

    if (!downloadInfo) {
        // Not our download, ignore
        return;
    }

    // Check if download completed
    if (downloadDelta.state && downloadDelta.state.current === 'complete') {
        console.log('[BG] Download completed:', downloadId, 'for page:', downloadInfo.pageNumber);
        
        // Notify content script
        if (downloadInfo.tabId) {
            chrome.tabs.sendMessage(downloadInfo.tabId, {
                action: 'downloadComplete',
                downloadId: downloadId,
                filename: downloadInfo.filename,
                pageNumber: downloadInfo.pageNumber
            }).catch(err => {
                console.error('[BG] Could not notify tab of completion:', err);
            });
        }

        // Clean up
        activeDownloads.delete(downloadId);
    } 
    // Check if download failed
    else if (downloadDelta.state && downloadDelta.state.current === 'interrupted') {
        console.error('[BG] Download interrupted:', downloadId);
        
        // Notify content script
        if (downloadInfo.tabId) {
            chrome.tabs.sendMessage(downloadInfo.tabId, {
                action: 'downloadFailed',
                downloadId: downloadId,
                pageNumber: downloadInfo.pageNumber
            }).catch(err => {
                console.error('[BG] Could not notify tab of failure:', err);
            });
        }

        // Clean up
        activeDownloads.delete(downloadId);
    }
});
