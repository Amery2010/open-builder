# 贡献指南

感谢你对 AI Web App Generator 项目的关注！我们欢迎任何形式的贡献。

## 如何贡献

### 报告 Bug

如果你发现了 Bug，请创建一个 Issue，包含以下信息：

- Bug 的详细描述
- 复现步骤
- 预期行为
- 实际行为
- 环境信息（操作系统、Node.js 版本、使用的 AI 服务等）
- 相关的错误日志或截图

### 提出新功能

如果你有新功能的想法，请创建一个 Issue，描述：

- 功能的用途和价值
- 预期的使用方式
- 可能的实现方案

### 提交代码

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的修改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建一个 Pull Request

## 开发指南

### 环境准备

```bash
# 克隆仓库
git clone <repository-url>
cd ai-app-gen

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 添加你的 API Key

# 启动开发服务器
npm run dev
```

### 项目结构

```
src/
├── lib/                    # 核心库
│   ├── web-app-generator.ts   # Tool Call 引擎
│   ├── openai-client.ts       # OpenAI 客户端
│   └── utils.ts               # 工具函数
├── components/             # React 组件
│   ├── ChatInterface.tsx      # 聊天界面
│   └── CodeViewer.tsx         # 代码查看器
├── constants/              # 常量定义
│   └── template.ts            # 项目模板
├── App.tsx                 # 主应用
└── main.tsx                # 入口文件
```

### 代码规范

- 使用 TypeScript
- 遵循 ESLint 规则
- 使用有意义的变量和函数名
- 添加必要的注释
- 保持代码简洁清晰

### 提交规范

使用语义化的提交信息：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式调整
- `refactor:` 代码重构
- `test:` 测试相关
- `chore:` 构建/工具相关

示例：

```
feat: 添加文件导出功能
fix: 修复流式输出中断问题
docs: 更新配置指南
```

### 测试

在提交 PR 前，请确保：

- [ ] 代码通过类型检查 (`npm run lint`)
- [ ] 代码可以正常构建 (`npm run build`)
- [ ] 功能在浏览器中正常工作
- [ ] 没有引入新的 TypeScript 错误
- [ ] 更新了相关文档

### 添加新功能

#### 1. 添加新的工具

在 `src/lib/web-app-generator.ts` 中：

```typescript
// 1. 添加工具定义
const NEW_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "my_new_tool",
    description: "工具描述",
    parameters: {
      type: "object",
      properties: {
        param1: { type: "string", description: "参数说明" }
      },
      required: ["param1"]
    }
  }
};

// 2. 添加到工具列表
const BUILTIN_TOOLS = [..., NEW_TOOL];

// 3. 实现工具逻辑
private async executeTool(toolCall: ToolCall) {
  // ...
  case "my_new_tool":
    result = this.toolMyNewTool(args.param1);
    break;
  // ...
}

// 4. 实现具体方法
private toolMyNewTool(param1: string): string {
  // 实现逻辑
  return "结果";
}
```

#### 2. 添加新的 AI 服务支持

在 `src/lib/openai-client.ts` 中添加预设配置：

```typescript
export const AI_PRESETS = {
  openai: {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
  },
  deepseek: {
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
  },
  // 添加新的预设
  myservice: {
    apiUrl: "https://api.myservice.com/v1/chat/completions",
    model: "my-model",
  },
};
```

#### 3. 添加新的组件

在 `src/components/` 目录下创建新组件：

```typescript
// MyComponent.tsx
import React from "react";

interface MyComponentProps {
  // 定义 props
}

export function MyComponent({ }: MyComponentProps) {
  return (
    <div>
      {/* 组件内容 */}
    </div>
  );
}
```

### 文档

如果你的贡献涉及用户可见的功能，请更新相关文档：

- `README.md` - 项目概述
- `docs/快速开始.md` - 快速开始指南
- `docs/配置指南.md` - 配置说明
- `docs/使用示例.md` - 使用示例
- `CHANGELOG.md` - 更新日志

### Pull Request 检查清单

提交 PR 前，请确认：

- [ ] 代码遵循项目的代码规范
- [ ] 通过了所有类型检查
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 在 CHANGELOG.md 中记录了变更
- [ ] PR 描述清晰，说明了改动的目的和内容
- [ ] 如果是新功能，提供了使用示例

## 开发技巧

### 调试 Tool Call

在浏览器控制台中查看详细日志：

```typescript
const generator = createOpenAIGenerator(config, {
  onToolCall: (name, id) => {
    console.log(`[Tool Call] ${name} (${id})`);
  },
  onToolResult: (name, args, result) => {
    console.log(`[Tool Result] ${name}`, { args, result });
  },
});
```

### 测试不同的 AI 模型

快速切换模型进行测试：

```typescript
// 在 .env.local 中
VITE_OPENAI_MODEL=gpt-4o        # 测试 OpenAI
# VITE_OPENAI_MODEL=deepseek-chat  # 测试 DeepSeek
# VITE_OPENAI_MODEL=codellama      # 测试 Ollama
```

### 性能分析

使用浏览器的 Performance 工具分析性能瓶颈。

## 社区

- 提问和讨论：使用 GitHub Issues
- 分享使用经验：创建 Discussions
- 报告安全问题：请私下联系维护者

## 行为准则

- 尊重所有贡献者
- 保持友好和专业
- 接受建设性的批评
- 关注对项目最有利的事情

## 许可证

通过贡献代码，你同意你的贡献将在 MIT 许可证下发布。

---

再次感谢你的贡献！🎉
