# 关于保存路径的重要说明

## 问题说明

用户反馈输入绝对路径（如 `/Users/samni/Desktop/test`）后文件没有保存到指定位置。

## 原因

**Chrome扩展的安全限制**：Chrome的下载API (`chrome.downloads.download`) 不支持使用绝对路径。`filename` 参数只能接受相对于浏览器默认下载文件夹的相对路径。

## 解决方案

### 方案1：修改Chrome默认下载文件夹（推荐）

1. 打开Chrome设置：`chrome://settings/downloads`
2. 点击"位置"旁边的"更改"按钮
3. 选择你想要的目录（如 `/Users/samni/Desktop/test`）
4. 在插件中留空或输入子文件夹名称

**示例**：
- Chrome默认下载文件夹设置为：`/Users/samni/Desktop/test`
- 插件中输入：`ppt-slides`（或留空）
- 文件保存到：`/Users/samni/Desktop/test/ppt-slides/page1.png`

### 方案2：只使用子文件夹名称

在插件中只输入子文件夹名称（相对路径），不要输入绝对路径：

**正确示例**：
- ✅ `ppt-slides`
- ✅ `my-project/images`
- ✅ 留空（保存到下载文件夹根目录）

**错误示例**：
- ❌ `/Users/samni/Desktop/test`
- ❌ `~/Desktop/test`
- ❌ `C:\Users\...`

## 已实现的改进

1. 更新了UI标签：从"保存目录"改为"保存子文件夹"
2. 更新了占位符文本，明确说明只支持子文件夹名称
3. 更新了README，详细说明了路径限制和正确使用方法
4. 添加了如何修改Chrome默认下载文件夹的说明

## 技术细节

Chrome扩展的 `chrome.downloads.download` API：
```javascript
chrome.downloads.download({
  url: downloadItem.url,
  filename: 'ppt-slides/page1.png',  // ✅ 相对路径
  // filename: '/Users/samni/Desktop/test/page1.png',  // ❌ 绝对路径不支持
  saveAs: false
});
```

文件最终保存位置 = Chrome默认下载文件夹 + filename参数
