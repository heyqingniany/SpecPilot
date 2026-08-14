# SpecPilot MVP

面向工程师的本地优先 AI 技术文档桌面阅读器原型，使用 Tauri + React + PDF.js。

## 已实现

- 本地选择或拖放 PDF
- 连续多页渲染与滚轮跨页浏览
- 上一页/下一页、页码跳转、PageUp/PageDown 与方向键翻页
- 50%–300% 缩放、Ctrl+滚轮缩放、适合宽度/页面
- 缩略图侧栏、精确到搜索词的全文查找与上下项导航、文字选择/复制、页面旋转
- 打印、另存 PDF 副本、全屏阅读
- “智能找手册”：可先用当前 AI 模型识别准确型号、厂商与官方域名，再由本地后端搜索候选、检查型号匹配度并验证 PDF 文件内容；未配置 AI 时也能直接按型号检索
- 搜索结果标明匹配分数、官方域名和 PDF 验证状态，可一键下载、导入阅读器并保存；联网检索设有阶段与总超时，不会拖住应用退出或本地 PDF 功能
- 本地文档库：自动保存打开或下载的 PDF，并缓存型号、厂商、全文索引、推荐问题和 AI 对话；支持按文件名、型号或厂商查找、快速恢复及删除
- 右侧“网页备用”原生浏览区保留为补充：Bing / 百度 / Google / DuckDuckGo 可选搜索、地址导航、后退、前进、刷新，并在点击 PDF 后自动导入左侧阅读器
- 长文档性能优化：只保留视口附近页面的 Canvas 与文字层，离屏立即释放；滚动页码定位不再逐页扫描，AI 状态更新不会重绘整份 PDF
- PDF Base64、索引缓存序列化/恢复和 SQLite 读写均移至后台；AI 推荐问题延迟到空闲时启动，离开“网页备用”会销毁对应 WebView2
- 统一网络设置：留空使用系统代理，也可为在线手册、模型 API 和网址 PDF 下载显式配置 HTTP / SOCKS5 代理并测试连通性
- 模型、Base URL、代理和搜索引擎会自动恢复；可选择把各服务商 API Key 保存到 Windows 凭据管理器，并随时一键清除，不在 SQLite、普通设置文件或项目中保存明文
- 也可从 HTTP/HTTPS PDF 直链下载并打开（校验 PDF 文件头，最大 100 MB）
- 逐页文字与归一化 bounding box 提取
- 轻量关键词检索与结构化来源
- 来源点击跳页、高亮与 ViewerController 抽象
- 桌面优先、移动端可用的双栏界面

AI 问答支持 DeepSeek、OpenAI、OpenRouter、硅基流动以及任意 OpenAI Chat Completions 兼容接口：先生成中英文检索词，在本地 PDF 索引中找出证据，再让模型返回结构化回答、来源和阅读器动作。用户可选择仅在当前会话使用 API Key，或由 Windows 凭据管理器安全保存并在下次启动时自动恢复。

导入 PDF 后，右侧会立即显示基于文件名和本地技术术语生成的推荐问题；配置模型后，推荐会自动升级为结合文档关键段落生成的 3–5 个具体问题。

## Windows 安装

直接运行：

`src-tauri/target/release/bundle/nsis/SpecPilot_0.7.2_x64-setup.exe`

## 开发运行

```bash
npm install
npm run dev
```

桌面调试：

```bash
npm run desktop:dev
```

生产构建：

```bash
npm run build
npm run desktop:build
```
