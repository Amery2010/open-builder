# 更新日志

## [2.2.0] - 2024-02-25

### 新增功能

- ✨ **设置管理系统** - 完整的 AI 配置管理
  - 图形化设置界面
  - 快速预设配置（OpenAI、DeepSeek、Ollama）
  - 本地存储设置
  - 设置验证和引导
  - 高级设置（Temperature、Max Tokens）

- ✨ **优化的预览界面**
  - 纯预览视图（移除只读代码区域）
  - 显示导航栏
  - 显示 Console 按钮
  - 视窗大小模拟（桌面/平板/手机）
  - 移除分栏模式

- ✨ **改进的代码编辑器**
  - 左侧文件树导航
  - 隐藏顶部文件标签
  - 全屏代码编辑区域
  - 更清晰的布局

### 改进

- 🎨 重构了 CodeViewer 组件
  - 简化了视图模式（只保留预览和代码）
  - 优化了布局结构
  - 改进了文件树显示

- 🎨 更新了 ChatInterface 组件
  - 添加设置按钮
  - 设置验证提示
  - 未配置时的引导

- 🎨 更新了 App.tsx
  - 从设置读取 AI 配置
  - 不再使用环境变量
  - 设置变更时自动重建生成器

### 破坏性变更

- ⚠️ **环境变量不再使用**
  - 移除了对 `VITE_OPENAI_API_KEY` 的读取
  - 移除了对 `VITE_OPENAI_API_URL` 的读取
  - 移除了对 `VITE_OPENAI_MODEL` 的读取
  - 所有配置现在从设置面板读取

- ⚠️ **视图模式变更**
  - 移除了 "分栏" 模式
  - 只保留 "预览" 和 "代码" 模式

### 新增文件

- `src/lib/settings.ts` - 设置管理逻辑
- `src/components/SettingsDialog.tsx` - 设置对话框
- `docs/v2.2.0-更新说明.md` - 详细更新说明

### 文档

- 📖 新增 [v2.2.0 更新说明](./docs/v2.2.0-更新说明.md)
  - 详细的功能介绍
  - 使用指南
  - 迁移指南
  - 技术实现说明

### 迁移指南

从 v2.1.0 升级：

1. 打开设置面板
2. 填写 API Key 和配置
3. 保存设置
4. 开始使用

不再需要 `.env.local` 文件。

---

## [2.1.0] - 2024-02-25

### 新增功能

- ✨ **多文件支持** - AI 现在可以创建和修改项目中的所有文件
  - 完整的文件树展示
  - 支持文件夹结构
  - 可折叠的文件树
  - 文件选择和切换
  - 实时文件同步

- ✨ **Tool Call 可视化** - 在聊天界面中实时显示 AI 的工具调用
  - Tool Call 卡片组件
  - Tool Result 卡片组件
  - 工具图标和颜色编码
  - 可展开/收起的详细信息
  - 成功/失败状态显示

- ✨ **改进的聊天界面**
  - 欢迎屏幕和快速开始按钮
  - 更好的消息布局
  - 实时生成状态显示
  - 消息自动滚动

- ✨ **文件树管理**
  - 层级文件夹显示
  - 折叠/展开功能
  - 当前文件高亮
  - 文件统计信息

### 改进

- 🎨 更新了 ChatInterface 组件
  - 支持显示完整的消息历史
  - 渲染 Tool Call 和 Tool Result
  - 添加了消息类型判断
  - 优化了 UI 布局

- 🎨 重构了 CodeViewer 组件
  - 支持多文件管理
  - 文件树导航
  - 文件选择和切换
  - 与 Sandpack 深度集成

- 🎨 更新了 App.tsx
  - 移除了单一 code 状态
  - 添加了 currentFile 状态
  - 添加了 messages 状态
  - 实现了文件变更处理

### 文档

- 📖 新增[新功能说明](./docs/新功能说明.md)
  - 详细的功能介绍
  - 使用场景示例
  - 技术实现说明

### 技术细节

- 实现了文件树构建算法
- 添加了 Tool Call 和 Tool Result 的类型化组件
- 优化了消息渲染性能
- 改进了状态管理逻辑

---

## [2.0.0] - 2024-02-25

### 重大变更

- 🔄 从 Gemini API 迁移到 OpenAI 兼容格式
- 🏗️ 完全重构为 Tool Call 工作流架构
- 📁 实现内存文件系统管理

### 新增功能

- ✨ 完整的 Tool Call 循环引擎
- ✨ 支持多种 AI 服务（OpenAI、DeepSeek、Ollama 等）
- ✨ 流式输出支持
- ✨ 5 个内置文件操作工具
- ✨ 事件驱动架构
- ✨ 对话历史管理
- ✨ 实时文件变更通知

### 核心模块

- `src/lib/web-app-generator.ts` - Tool Call 核心引擎
- `src/lib/openai-client.ts` - OpenAI 兼容客户端
- `src/vite-env.d.ts` - TypeScript 类型定义

### 工具系统

实现了以下文件操作工具：

1. **list_files** - 列出所有项目文件
2. **read_file** - 读取文件内容
3. **write_file** - 创建或覆盖文件
4. **patch_file** - 精确修改文件（支持多个 patch）
5. **delete_file** - 删除文件

### 文档

新增完整文档体系：

- 📖 [快速开始指南](./docs/快速开始.md)
- ⚙️ [配置指南](./docs/配置指南.md)
- 💡 [使用示例](./docs/使用示例.md)
- 🏗️ [架构文档](./docs/AI%20Tool%20Call%20Web%20App%20Generator%20—%20完整%20TypeScript%20实现.md)
- 📐 [系统架构与实现原理](./docs/利用%20AI%20Tool%20Call%20生成%20Web%20APP%20的系统架构与实现原理.md)
- 📝 [项目总结](./docs/项目总结.md)

### 配置

- 新增 `.env.example` 配置模板
- 支持通过环境变量配置 API
- 支持自定义 API 端点和模型

### 改进

- 🚀 性能优化：支持并行工具调用
- 💰 成本优化：使用 patch_file 减少 Token 消耗
- 🎨 更好的类型安全：完整的 TypeScript 类型定义
- 🔧 更灵活的扩展性：支持自定义工具和提示词

### 移除

- ❌ 移除 `@google/genai` 依赖
- ❌ 移除 `src/lib/gemini.ts`

### 技术栈

- React 19.2.4
- TypeScript 5.9.3
- Vite 7.3.1
- Tailwind CSS 4.2.1
- Sandpack 2.20.0

### 兼容性

支持以下 AI 服务：

- OpenAI (GPT-4o, GPT-4-Turbo, GPT-3.5-Turbo)
- DeepSeek (deepseek-chat)
- Azure OpenAI
- 本地 Ollama (Llama2, CodeLlama, Mistral 等)
- 任何 OpenAI 兼容的 API 服务

### 破坏性变更

- 环境变量从 `GEMINI_API_KEY` 改为 `VITE_OPENAI_API_KEY`
- API 调用方式完全改变，不再兼容旧版本
- 需要重新配置 `.env.local` 文件

### 迁移指南

从 1.x 迁移到 2.0：

1. 删除旧的环境变量配置
2. 复制 `.env.example` 到 `.env.local`
3. 配置新的 OpenAI 兼容 API
4. 重新安装依赖：`npm install`
5. 启动开发服务器：`npm run dev`

详细迁移步骤请参考[快速开始指南](./docs/快速开始.md)。

---

## [1.0.0] - 2024-01-XX

### 初始版本

- 基于 Gemini API 的简单代码生成
- 单次 API 调用
- 基础的代码查看和预览功能
