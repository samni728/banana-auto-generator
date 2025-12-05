## Chrome 中 Gemini 大图下载技术分析

### 一、整体目标

在 Chrome 扩展中，实现对 Gemini「Create Image（nano banana）」生成的图片进行**批量原图下载**，并按用户指定的子目录和文件名（如 `testppt5/page1.png`、`page2.png`…）保存到本地，同时：

- 不触发 Gemini 对脚本点击的安全拦截（`event.isTrusted` 检查）；
- 不依赖页面自身的下载按钮逻辑；
- 在生成流程结束后一次性完成所有图片的下载，保证稳定性和顺序正确。

---

### 二、架构与角色划分

扩展整体分为三层：

- **Popup（`popup.html` / `popup.js`）**
  - 收集用户输入的提示词列表和子目录名。
  - 向当前 Gemini 标签页注入指令：`startGeneration`。

- **Content Script（`content.js`，运行在 Gemini 页）**
  - 自动化生图流程：进入 nano banana 模式、提交提示词、等待每张图生成完成。
  - 在所有图片生成完毕后，扫描页面 DOM 中的图片 `<img>`，提取预览图 URL。
  - 将预览 URL 转换为原图 URL（`=s0` 高清化），并把 `{ url, filename }` 发给后台。

- **Background Service Worker（`background.js`）**
  - 作为下载代理，拥有 `downloads` 权限。
  - 接收 `downloadDirectly` 消息，调用 `chrome.downloads.download` 静默下载文件。

这种架构的核心思想是：**页面只负责“看”和“算出 URL”，后台负责“下”，两者权限清晰分离。**

---

### 三、详细流程：从生图到批量高清下载

#### 1. 启动任务（Popup → Content）

1. 用户在 popup 中输入：
   - 子目录名：例如 `testppt5`；
   - 多行提示词：一行一个。
2. Popup 将数据发送给当前 Gemini 页的 content script：

```js
chrome.tabs.sendMessage(tabId, {
  action: "startGeneration",
  prompts,          // 提示词数组
  saveDirectory,    // 子目录名
});
```

#### 2. 进入 Create Image（nano banana）模式

在 `content.js` 中：

1. 先尝试直接找到生图输入框：

```js
const input = document.querySelector(
  'div[contenteditable="true"][role="textbox"][data-placeholder*="Describe your image"]'
);
if (input) return; // 已经是 nano banana 模式
```

2. 如果没有，说明当前不在生图模式：
   - 枚举页面上的 `button`，查找 `textContent` 中包含 `Create Image` 的按钮；
   - 点击后 `sleep(1000)`，等待模式切换完成。

#### 3. 第一阶段：循环生成 N 张图片（只生成，不下载）

对 `currentPrompts` 循环：

1. 每轮更新进度到 popup：

```js
chrome.runtime.sendMessage({
  action: "updateProgress",
  current: currentIndex,
  total: currentPrompts.length,
});
```

2. **提交提示词**：
   - 定位主输入框：`div[contenteditable="true"][role="textbox"]`；
   - 设置 `textContent = prompt`，派发 `input` 事件；
   - 查找发送按钮：
     - 优先找 `aria-label="Send"` 或文本包含 `Send` 的按钮；
     - 其次找 `button[data-testid="send-button"]`；
   - 若找到按钮则点击，否则 fallback 为模拟回车键。

3. **等待当前图片生成完成**：

```js
async function waitForGeneration(targetCount) {
  let attempts = 0;
  while (attempts < 180) { // 最多等约 90 秒
    if (shouldStop) throw new Error("用户停止");

    const downloadBtns = document.querySelectorAll(
      'button[aria-label*="Download full size"]'
    );

    if (downloadBtns.length >= targetCount) {
      console.log(
        `[Page ${targetCount}] 生成确认 (检测到 ${downloadBtns.length} 个下载按钮)`
      );
      return;
    }

    await sleep(500);
    attempts++;
  }
  throw new Error(`生成第 ${targetCount} 张图片超时`);
}
```

这里“Download full size image”按钮仅被用作「生成完成」的信号，**并不会被脚本点击**。

4. 每张生成完成后 `sleep(1500)`，保证 `<img>` 元素已经渲染到 DOM。

#### 4. 第二阶段：批量提取图片并高清下载

所有提示词处理完后执行 `downloadAllGeneratedImages()`。

##### 4.1 扫描页面并筛选有效大图

```js
const allImages = Array.from(document.querySelectorAll("img"));
const validImages = allImages.filter((img) => {
  const src = img.src || "";
  if (!src) return false;
  if (src.includes("nano-banana")) return false;  // 排除香蕉图标
  if (src.includes("profile_photo")) return false; // 排除头像
  return img.naturalWidth > 200;                  // 过滤小图标
});
```

若无有效图则直接返回。

##### 4.2 取本次生成对应的 N 张图

- 已知当前任务有 `N = currentPrompts.length` 个提示词；
- Gemini 对话是**追加模式**，最新的图片出现在最下方；
- 因此可以简单地取“所有大图中的最后 N 张”：

```js
const count = currentPrompts.length;
const targetImages = validImages.slice(-count);
```

随后按顺序将它们映射为 `page1..pageN`。

##### 4.3 预览 URL → 高清 URL：`=s0` 规则

每张图的原始 `src` 一般类似：

- `https://lh3.googleusercontent.com/...=s1024-rj`
- 或 `https://lh3.googleusercontent.com/...=w400-h400`

这是 Google 图片服务的缩略图地址。通过统一规则，将尾部尺寸部分替换为 `=s0`：

```js
let finalUrl = img.src;
if (finalUrl.includes("googleusercontent.com") && finalUrl.includes("=")) {
  const baseUrl = finalUrl.split("=")[0];
  finalUrl = `${baseUrl}=s0`; // 请求原图尺寸
  console.log(`[Batch] Page ${pageNum}: URL 已升级为高清版 (=s0)`);
} else {
  console.log(
    `[Batch] Page ${pageNum}: 使用原始 URL (可能是 blob 或已是原图)`
  );
}
```

> `=s0` 是 Google 图片服务广泛使用的一种“原图”参数：  
> `=wXXX-hXXX` / `=s1024-rj` 之类用于控制缩略尺寸，`=s0` 则表示 source / original size，返回接近原始清晰度的图片。

##### 4.4 调用后台进行静默下载

为每一张图构造目标文件名：

```js
const filename = saveDirectory
  ? `${saveDirectory}/page${pageNum}.png`
  : `page${pageNum}.png`;
```

将 `{ url: finalUrl, filename }` 发送给后台：

```js
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
      console.error(`[Batch] Page ${pageNum} 下载失败`, res && res.error);
    }
    resolve();
  }
);
```

每张之间 `sleep(800)`，避免瞬间并发大量下载。

---

### 四、后台下载逻辑：`background.js`

后台脚本非常简洁，只保留一个下载通道：

```js
// background.js - 最终版（纯净特权下载）

chrome.runtime.onInstalled.addListener(() => {
  console.log("Gemini Auto PPT Generator installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 核心功能：接收 URL 并使用扩展特权直接下载
  if (message.action === "downloadDirectly") {
    console.log(`[BG] API Downloading: ${message.filename}`);

    chrome.downloads.download(
      {
        url: message.url,        // 已在 content.js 中高清化
        filename: message.filename, // 例如 testppt5/page1.png
        conflictAction: "uniquify",
        saveAs: false,           // 静默下载，不弹出另存为对话框
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(
            `[BG] Error: ${chrome.runtime.lastError.message}`
          );
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

    // 保持异步通道
    return true;
  }
});
```

后台不再维护任何下载队列或 `onDeterminingFilename` 逻辑，因为我们已经在 content script 里直接生成了最终文件名。

---

### 五、为什么必须这样做：Chrome 与 Gemini 的安全机制

#### 1. 页面内“模拟点击下载”为何会失败？

在页面上下文（包括 content script 注入的代码）中，直接对 `Download full size image` 按钮执行：

```js
button.click();
// 或
button.dispatchEvent(new MouseEvent('click', { ... }));
```

会遇到两层问题：

1. **`event.isTrusted` 检查（由 Gemini 页面脚本实现）**
   - 真正的用户点击由浏览器生成，`event.isTrusted === true`。
   - 程序构造的事件无论如何都是 `false`。
   - Gemini 可以通过这个字段区分“真实用户点击”和“脚本代点”，对后者直接不做任何事情，甚至不发网络请求。

2. **用户手势限制（由浏览器内核实现）**
   - 某些敏感操作（弹窗、下载、剪贴板等）需要“用户手势”（user gesture），例如点击或按键事件的直接调用栈中必须有浏览器标记的手势。
   - 脚本模拟事件往往不具备这种手势标记，即便页面代码愿意，浏览器也可能阻止后续的下载行为。

结果就是：**从第二张图开始，脚本“代点”下载按钮会越来越容易被视为“恶意自动化”，导致 full size 下载完全不触发。**

#### 2. 扩展后台为何可以稳定下载？

Chrome 扩展的后台脚本拥有独立的权限模型：

- 只要在 `manifest.json` 中声明了 `downloads` 权限，并由用户确认安装；
- 后台可以随时调用：

```js
chrome.downloads.download({
  url,
  filename,
  saveAs: false,
});
```

这类调用不依赖页面的任何事件，也不需要 `event.isTrusted`：

- **页面世界**的限制（Gemini 自己的 JS、防连点逻辑、CSP）不会影响扩展后台发起的下载；
- **扩展世界**被认为是“用户明确授权”的组件，可以提供更高权限的批量自动化能力。

因此，通过「content script 只负责算出 URL + filename，后台负责真正下载」，就可以：

- 避开页面级别的所有交互限制；
- 在后台可靠地批量下载原图。

#### 3. 为什么要选择“全部生成完再批量下载”？

主要是稳定性与可维护性的权衡：

- 生图过程中 DOM 会频繁变动，边生成边下载容易：
  - 读到上一轮还没刷新的 `<img>`；
  - 被滚动 / 重排影响，导致选错或漏选图片。
- 将流程拆成两个阶段：
  1. **只负责把 N 张图都生成好**；  
  2. **在静态页面上统一扫描 DOM、计算高清 URL，并发起下载**；

可以保证：

- 下载顺序与提示词顺序严格一致；
- 一旦下载逻辑需要调整（比如筛选条件），只改第二阶段即可，不影响生图流程。

---

### 六、结论与优势

通过上述方案，我们在 Chrome 中实现了对 Gemini 生图原图的稳定批量下载，关键点在于：

1. **完全放弃模拟点击 Download 按钮**，不再与 `event.isTrusted` 和用户手势限制对抗；
2. **利用 Google 图片服务的尺寸参数协议（`=s0`）将预览 URL 升级为原图 URL**；
3. **充分利用扩展后台的特权 API（`chrome.downloads.download`）**，实现静默批量下载；
4. **采用“全部生成完 → 批量处理”的两阶段架构**，使逻辑清晰、行为可预期，易于维护。

这套设计在实际测试中可以：

- 精确下载每一张对应的生图；
- 将文件名映射为 `子目录/pageX.png`；
- 文件体积和清晰度均达到 Gemini 手动点击「Download full size image」时的原图水平。


