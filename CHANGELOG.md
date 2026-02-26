# Changelog

本文件记录 Open Builder 的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.0.0] - 2026-02-26

### 新增

- 完整的 AI Tool Call 循环引擎（`WebAppGenerator`），支持最多 30 轮工具调用
- 内置 8 个文件系统工具：`init_project`、`manage_dependencies`、`list_files`、`read_files`、`write_file`、`patch_file`、`delete_file`、`search_in_files`
- 基于 Sandpack 的浏览器内实时代码预览，支持 20+ 项目模板
- 多会话管理：创建、切换、删除对话，历史记录通过 localforage 持久化
- 图片输入支持（多模态），可上传截图或设计稿
- 流式输出支持，实时展示 AI 生成过程
- Extended Thinking / Reasoning 支持（DeepSeek-R1、Claude 3.7 等）
- 联网搜索集成（Tavily API），支持 `web_search` 和 `web_reader` 工具
- Jina Reader 作为网页读取的自动降级备用方案
- 工具调用可视化卡片（`ToolCallCard`），展示每次工具调用的状态和结果
- 一键下载项目为 ZIP 文件
- 移动端响应式布局，移动端支持内嵌预览
- 设置对话框：API Key、API URL、模型名称、Tavily 配置
- 所有配置保存在浏览器 localStorage，不上传服务器

### 技术栈

- React 19 + TypeScript 5
- Vite 7 + Tailwind CSS v4
- shadcn/ui + Radix UI
- Zustand 5 状态管理

## [0.1.0] - 2026-02-24

### 新增

- 项目初始化，基于 Vite + React TypeScript 模板
- 基础 `WebAppGenerator` 类，实现 OpenAI Tool Call 循环
- `ChatInterface` 聊天界面组件
- `CodeViewer` 代码查看器（编辑器 + Sandpack 预览）
- `SettingsDialog` 设置对话框
- 支持 OpenAI 兼容 API（OpenAI、DeepSeek 等）
- 基础文件操作工具：`write_file`、`read_files`、`list_files`、`delete_file`

[1.0.0]: https://github.com/Amery2010/open-builder/compare/v0.3.0...v1.0.0
[0.1.0]: https://github.com/Amery2010/open-builder/releases/tag/v0.1.0
