# Gemini Auto PPT Generator

一个Chrome浏览器插件，用于在Gemini上自动批量生成和下载图片，非常适合制作PPT演示文稿。

## 功能特点

- 📝 **批量输入提示词**：在文本框中粘贴多行提示词，每行一个
- 📁 **自定义保存子文件夹**：可以指定子文件夹名称，如 `ppt-slides`，文件会保存到下载文件夹的子目录中
- 🤖 **自动生成**：插件会自动逐个提交提示词到Gemini生成图片
- ⏳ **智能等待**：自动检测图片生成完成状态
- 💾 **自动下载**：生成完成后自动下载并命名为 `page1.png`, `page2.png`, `page3.png`...
- 📊 **进度显示**：实时显示生成进度和状态
- 🎨 **现代UI**：美观的渐变设计界面

## 安装方法

1. 下载或克隆此项目到本地
2. 打开Chrome浏览器，访问 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择 `gemini-auto-ppt-generator` 文件夹
6. 插件安装完成！

## 使用方法

1. 访问 [Gemini](https://gemini.google.com) 并登录
2. 点击"生成图片"进入图片生成模式
3. 点击浏览器工具栏中的插件图标
4. **（可选）** 在"保存子文件夹"输入框中输入文件夹名称，如 `ppt-slides`
   - 留空：文件保存到 `下载文件夹/page1.png`
   - 填写 `ppt-slides`：文件保存到 `下载文件夹/ppt-slides/page1.png`
   - 支持多级目录，如 `my-project/images`
5. 在提示词文本框中粘贴你的提示词（每行一个）
6. 点击"🚀 开始生成"按钮
7. 插件会自动：
   - 提交第一个提示词
   - 等待图片生成完成
   - 自动下载并命名为 `page1.png`
   - 继续处理下一个提示词
   - 重复直到所有提示词处理完成

## 关于保存路径

⚠️ **重要说明**：

由于Chrome扩展的安全限制，**不支持指定绝对路径**（如 `/Users/samni/Desktop/test`）。

插件只能在浏览器的**默认下载文件夹**内创建子文件夹。

**正确的使用方式**：
- ✅ 输入 `ppt-slides` → 保存到 `下载文件夹/ppt-slides/`
- ✅ 输入 `my-project/images` → 保存到 `下载文件夹/my-project/images/`
- ✅ 留空 → 保存到 `下载文件夹/`
- ❌ 输入 `/Users/samni/Desktop/test` → **不支持**

**如何更改Chrome默认下载文件夹**：
1. 打开Chrome设置 (`chrome://settings/`)
2. 搜索"下载内容"
3. 点击"更改"按钮选择新的默认下载位置
4. 设置为你想要的目录（如 `/Users/samni/Desktop/test`）
5. 然后在插件中留空或输入子文件夹名称即可

## 提示词示例

```
Create a stunning, cinematic title slide for a presentation about AI...
Create a slide with a split screen layout showing comparison...
Create a minimalist slide with key statistics...
Create a conclusion slide with call to action...
```

## 注意事项

- ⚠️ 必须在Gemini的图片生成页面使用
- ⚠️ 确保已登录Gemini账号
- ⚠️ 生成过程中请不要关闭或切换标签页
- ⚠️ 每张图片生成时间约30-60秒，请耐心等待
- ⚠️ 子文件夹会在浏览器默认下载文件夹内自动创建
- ⚠️ 不支持绝对路径，只支持相对路径（子文件夹名称）

## 技术栈

- Manifest V3
- Vanilla JavaScript
- Chrome Extension APIs
- Content Scripts
- Background Service Worker

## 文件结构

```
gemini-auto-ppt-generator/
├── manifest.json       # 插件配置文件
├── popup.html         # 弹出窗口UI
├── popup.js           # 弹出窗口逻辑
├── content.js         # 内容脚本（核心自动化逻辑）
├── background.js      # 后台服务工作线程
├── icon16.png         # 16x16 图标
├── icon48.png         # 48x48 图标
├── icon128.png        # 128x128 图标
└── README.md          # 说明文档
```

## 工作原理

1. **Popup界面**：用户输入提示词和可选的子文件夹名称，然后启动任务
2. **Content Script**：在Gemini页面上运行，负责：
   - 找到输入框并填入提示词
   - 提交生成请求
   - 监测生成状态（检测"Thinking"状态消失）
   - 找到并点击下载按钮
   - 将子文件夹信息传递给后台脚本
3. **Background Worker**：处理下载重命名和子文件夹路径
4. **进度同步**：通过Chrome消息API在各组件间同步状态

## 故障排除

**问题：插件无法启动**
- 确保在 `gemini.google.com` 页面使用
- 刷新Gemini页面后重试

**问题：下载失败**
- 检查浏览器下载权限
- 确保下载文件夹有写入权限

**问题：生成超时**
- 单张图片最长等待时间为2分钟
- 如果Gemini服务繁忙，可能需要稍后重试

**问题：输入绝对路径不生效**
- Chrome扩展不支持绝对路径
- 请修改Chrome的默认下载文件夹，然后在插件中只输入子文件夹名称
- 或者直接留空，下载后手动移动文件

**问题：找不到下载的文件**
- 检查Chrome的下载设置：`chrome://settings/downloads`
- 查看"位置"显示的默认下载文件夹
- 文件会保存在该文件夹的子目录中

## 许可证

MIT License

## 作者

Created for automating Gemini image generation workflows.
