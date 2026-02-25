# AI Web App Generator

<div align="center">

**基于 AI Tool Call 的 Web 应用生成器**

通过对话方式生成完整的 React Web 应用

[快速开始](./docs/快速开始.md) · [配置指南](./docs/配置指南.md) · [使用示例](./docs/使用示例.md) · [架构文档](./docs/)

</div>

---

## 演示

```
用户: 创建一个待办事项应用
AI: 好的，我来创建...
    📄 创建 src/App.tsx ✓
    📄 创建 src/index.css ✓
    ✅ 完成！

用户: 添加暗黑模式切换
AI: 正在修改...
    ✏️ 修改 src/App.tsx ✓
    ✅ 已添加暗黑模式！
```

## 特性

- 🤖 支持 OpenAI 兼容的 AI 模型（OpenAI、DeepSeek、Ollama 等）
- 🔧 基于 Tool Call 机制的智能代码生成
- 📁 完整的多文件项目管理
- 🌳 可视化文件树导航
- 🔄 实时预览和代码编辑
- 💬 对话式交互，支持迭代修改
- 🎨 Tool Call 可视化展示
- 📊 实时显示 AI 操作过程
- 🚀 支持流式输出，实时查看生成过程

## 架构说明

本项目实现了完整的 AI Tool Call 工作流：

```
用户输入 → AI 分析 → Tool Call 循环 → 文件操作 → 实时预览
```

核心组件：

- `WebAppGenerator`: Tool Call 引擎，处理 AI 对话和工具调用循环
- `OpenAI Client`: OpenAI 兼容的 API 客户端
- `ChatInterface`: 对话界面组件
- `CodeViewer`: 代码查看和编辑组件

详细实现原理请参考 [docs](./docs) 目录下的文档。

## 快速开始

### 前置要求

- Node.js 18+
- 现代浏览器（Chrome、Firefox、Safari、Edge）

### 安装

```bash
npm install
```

### 运行

```bash
npm run dev
```

访问 http://localhost:5173

### 首次使用

1. 点击聊天界面右上角的设置按钮 ⚙️
2. 选择预设配置或手动填写：
   - API Key
   - API URL
   - 模型名称
3. 保存设置
4. 开始使用！

**注意：** 不需要配置 `.env.local` 文件，所有设置在界面中完成。

## 使用示例

在聊天界面输入你的需求，例如：

- "创建一个待办事项应用"
- "添加暗黑模式切换功能"
- "给每个待办项添加优先级标签"
- "添加本地存储功能"

AI 会通过 Tool Call 机制自动：

1. 创建和修改文件
2. 组织项目结构
3. 实现完整功能
4. 实时更新预览

## 技术栈

- React 19 + TypeScript
- Vite
- Tailwind CSS
- OpenAI Compatible API
- Monaco Editor

## 项目结构

```
src/
├── lib/
│   ├── web-app-generator.ts  # Tool Call 核心引擎
│   ├── openai-client.ts      # OpenAI 兼容客户端
│   └── utils.ts              # 工具函数
├── components/
│   ├── ChatInterface.tsx     # 对话界面
│   └── CodeViewer.tsx        # 代码查看器
├── constants/
│   └── template.ts           # 项目模板
└── App.tsx                   # 主应用
```

## 文档

- [AI Tool Call 完整实现](./docs/AI%20Tool%20Call%20Web%20App%20Generator%20—%20完整%20TypeScript%20实现.md)
- [系统架构与实现原理](./docs/利用%20AI%20Tool%20Call%20生成%20Web%20APP%20的系统架构与实现原理.md)

## License

MIT
