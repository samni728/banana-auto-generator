# Blob:null 问题诊断与解决方案

## 问题现象

从用户截图看到：
- 下载显示完成：6.4 MB, 5.7 MB
- **但URL显示为 `blob:null`**
- 文件无法打开

## 根本原因

`blob:null` = Blob URL的origin丢失 = 文件数据损坏

**为什么**：Content script的 `click()` 导致跨上下文访问，blob URL失效。

## 解决方案：在页面上下文中提取数据

```javascript
// content.js - 注入脚本到页面上下文
function extractImageData(pageNumber) {
    return new Promise((resolve, reject) => {
        // 监听来自页面的消息
        const messageHandler = (event) => {
            if (event.data.type === 'IMAGE_DATA') {
                window.removeEventListener('message', messageHandler);
                resolve(event.data.data);
            }
        };
        window.addEventListener('message', messageHandler);
        
        // 注入脚本到页面上下文
        const script = document.createElement('script');
        script.textContent = `
        (async function() {
            const imgs = Array.from(document.querySelectorAll('img'))
                .filter(i => i.src.startsWith('blob:') && i.width > 300);
            const img = imgs[imgs.length - 1];
            
            const response = await fetch(img.src);
            const blob = await response.blob();
            
            const reader = new FileReader();
            reader.onloadend = () => {
                window.postMessage({
                    type: 'IMAGE_DATA',
                    data: reader.result
                }, '*');
            };
            reader.readAsDataURL(blob);
        })();
        `;
        document.head.appendChild(script);
        script.remove();
        
        setTimeout(() => reject(new Error('Timeout')), 30000);
    });
}
```

## 为什么这样可以工作

1. ✅ 脚本在**页面上下文**中执行，有正确的origin
2. ✅ `fetch(blob:...)` 可以访问完整数据
3. ✅ 转换为Base64后不依赖blob URL
4. ✅ 通过postMessage传递给content script
5. ✅ 下载的是完整图片数据，不是损坏的blob:null
