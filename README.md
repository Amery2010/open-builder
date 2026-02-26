<div align="center">

# Open Builder

**基于 AI 的 Web 应用生成器 —— 用自然语言描述，即刻生成可运行的完整项目**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-7.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.x-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)

[快速开始](#快速开始) · [功能特性](#功能特性) · [技术架构](#技术架构) · [贡献指南](CONTRIBUTING.md)

</div>

---

## 简介

Open Builder 是一个完全运行在浏览器中的 AI 驱动 Web 应用生成器。你只需用自然语言描述想要构建的应用，AI 就会通过工具调用（Tool Call）循环，在内存文件系统中自动创建、修改、删除文件，并通过 [Sandpack](https://sandpack.codesandbox.io/) 实时预览运行结果。

整个过程无需后端服务器，所有计算均在浏览器端完成。你的 API Key 仅保存在本地浏览器存储中，不会上传到任何服务器。

> 兼容任何 OpenAI Chat Completions 格式的 API，包括 OpenAI、Anthropic Claude、DeepSeek、通义千问等主流模型服务。

---

## 演示

![screenshot](/public/images/screenshot.jpg)

[演示网站](https://builder.u14.app)

---

## 功能特性

### 核心能力

- **自然语言生成代码** — 描述你的想法，AI 自动规划并生成完整项目结构
- **实时预览** — 基于 Sandpack 的浏览器内沙箱，代码变更即时渲染
- **多框架支持** — 支持 React、Vue、Svelte、Angular、SolidJS、Astro 等 20+ 模板
- **智能文件操作** — AI 通过 `patch_file` 精确修改文件，避免不必要的全量重写
- **依赖管理** — AI 可自动修改 `package.json` 并触发依赖重装

### 交互体验

- **多会话管理** — 支持创建、切换、删除多个独立对话，历史记录持久化保存
- **图片输入** — 支持上传截图或设计稿，AI 根据图片生成对应界面
- **流式输出** — 实时展示 AI 思考过程和代码生成进度
- **扩展思考** — 支持 Extended Thinking / Reasoning 模式（DeepSeek-R1、Claude 3.7 等）
- **一键下载** — 将生成的项目打包为 ZIP 文件下载到本地
- **移动端适配** — 响应式布局，移动端可内嵌预览生成的应用

### 联网搜索（可选）

- 集成 [Tavily](https://tavily.com) API，AI 可实时搜索网页获取最新信息
- 支持网页内容读取，自动降级到 [Jina Reader](https://jina.ai/reader/) 作为备用方案

---

## 快速开始

### 前置要求

- Node.js 18+ 或 [Bun](https://bun.sh)
- 任意 OpenAI 兼容 API 的 Key

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/Amery2010/open-builder.git
cd open-builder

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

打开浏览器访问 `http://localhost:5173`，点击右上角设置图标配置你的 API Key 即可开始使用。

### 配置说明

点击界面右上角的设置按钮，填写以下信息：

| 配置项         | 说明                  | 示例                                         |
| -------------- | --------------------- | -------------------------------------------- |
| API Key        | 你的 AI 服务 API 密钥 | `sk-...`                                     |
| API URL        | OpenAI 兼容的接口地址 | `https://api.openai.com/v1/chat/completions` |
| 模型名称       | 使用的模型 ID         | `gpt-5.3-codex`、`deepseek-chat`             |
| Tavily API Key | （可选）联网搜索功能  | `tvly-...`                                   |

> 所有配置均保存在浏览器 `localStorage` 中，不会离开你的设备。

---

## 技术架构

```
open-builder/
├── src/
│   ├── components/
│   │   ├── ChatInterface.tsx      # 主聊天界面
│   │   ├── CodeViewer.tsx         # 代码查看器（编辑器 + 预览）
│   │   ├── SettingsDialog.tsx     # 设置对话框
│   │   └── chat/                  # 聊天子组件
│   │       ├── ChatHeader.tsx     # 顶部栏（会话切换、设置）
│   │       ├── ChatInput.tsx      # 输入框（支持图片上传）
│   │       ├── MessageBubble.tsx  # 消息气泡
│   │       ├── ToolCallCard.tsx   # 工具调用可视化卡片
│   │       ├── MobilePreview.tsx  # 移动端内嵌预览
│   │       └── SessionList.tsx    # 会话列表侧边栏
│   ├── hooks/
│   │   ├── useAppState.ts         # 应用状态聚合
│   │   ├── useGenerator.ts        # AI 生成器 Hook
│   │   ├── useMergedMessages.ts   # 消息合并（合并连续工具调用）
│   │   └── useIsMobile.ts         # 移动端检测
│   ├── lib/
│   │   ├── generator.ts           # 核心：WebAppGenerator 引擎
│   │   ├── tavily.ts              # 联网搜索工具（Tavily + Jina）
│   │   └── client.ts              # API 客户端封装
│   ├── store/
│   │   ├── conversation.ts        # Zustand 会话状态（含持久化）
│   │   └── settings.ts            # Zustand 设置状态（含持久化）
│   └── types/
│       └── index.ts               # 全局类型定义
```

### 核心引擎：WebAppGenerator

[src/lib/generator.ts](src/lib/generator.ts) 是整个项目的核心，实现了完整的 AI Tool Call 循环引擎：

```
用户消息 → AI 规划 → 工具调用 → 执行工具 → 返回结果 → AI 继续/结束
                                    ↓
                              内存文件系统
                                    ↓
                           Sandpack 实时预览
```

内置工具列表：

| 工具                  | 描述                               |
| --------------------- | ---------------------------------- |
| `init_project`        | 初始化 Sandpack 项目模板           |
| `manage_dependencies` | 修改 package.json 管理依赖         |
| `list_files`          | 列出所有项目文件                   |
| `read_files`          | 批量读取文件内容                   |
| `write_file`          | 创建或覆写文件                     |
| `patch_file`          | 精确搜索替换补丁（推荐用于小改动） |
| `delete_file`         | 删除文件                           |
| `search_in_files`     | 正则搜索文件内容                   |
| `web_search`          | 联网搜索（需配置 Tavily）          |
| `web_reader`          | 读取网页内容                       |

### 技术栈

| 类别          | 技术                              |
| ------------- | --------------------------------- |
| 框架          | React 19 + TypeScript 5           |
| 构建工具      | Vite 7                            |
| 样式          | Tailwind CSS v4                   |
| UI 组件       | shadcn/ui + Radix UI              |
| 代码沙箱      | Sandpack (CodeSandbox)            |
| 状态管理      | Zustand 5                         |
| 本地存储      | localforage                       |
| 图标          | Lucide React                      |
| Markdown 渲染 | react-markdown + rehype-highlight |

---

## 支持的模型

Open Builder 兼容所有 OpenAI Chat Completions 格式的 API：

| 服务商   | 推荐模型                             | API URL                                                              |
| -------- | ------------------------------------ | -------------------------------------------------------------------- |
| OpenAI   | `gpt-5.3-codex`、`gpt-5.2`           | `https://api.openai.com/v1/chat/completions`                         |
| DeepSeek | `deepseek-chat`、`deepseek-reasoner` | `https://api.deepseek.com/v1/chat/completions`                       |
| 通义千问 | `qwen-max`、`qwen-coder-plus`        | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| 月之暗面 | `moonshot-v1-128k`                   | `https://api.moonshot.cn/v1/chat/completions`                        |
| 智谱 AI  | `glm-4`                              | `https://open.bigmodel.cn/api/paas/v4/chat/completions`              |

> 推荐使用支持 Function Calling 的强力模型以获得最佳效果。

---

## 部署

### 构建生产版本

```bash
npm run build
# 产物输出到 dist/ 目录
```

### 部署到 GitHub Pages

本项目配置了 GitHub Actions，推送版本 tag 即可自动构建并部署：

```bash
git tag v1.0.0
git push origin v1.0.0
```

详见 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)。

### 部署到 Vercel / Netlify

直接导入仓库，构建命令 `npm run build`，输出目录 `dist`，无需任何额外配置。

---

## 贡献

欢迎提交 Issue 和 Pull Request！请先阅读 [贡献指南](CONTRIBUTING.md)。

---

## 许可证

[GPLv3 License](LICENSE) © 2026 Open Builder Contributors
