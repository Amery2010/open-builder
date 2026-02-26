# 贡献指南

感谢你对 Open Builder 的关注！我们欢迎任何形式的贡献，包括 Bug 报告、功能建议、文档改进和代码提交。

---

## 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
- [开发环境搭建](#开发环境搭建)
- [项目结构](#项目结构)
- [提交规范](#提交规范)
- [Pull Request 流程](#pull-request-流程)
- [代码风格](#代码风格)

---

## 行为准则

参与本项目即表示你同意遵守以下基本准则：

- 尊重所有参与者，保持友善和建设性的沟通
- 接受建设性批评，专注于对项目最有利的方向
- 不发布任何歧视性、骚扰性或不当内容

---

## 如何贡献

### 报告 Bug

1. 先搜索 [Issues](https://github.com/your-username/open-builder/issues) 确认问题未被报告过
2. 创建新 Issue，使用 **Bug Report** 模板
3. 提供以下信息：
   - 操作系统和浏览器版本
   - 复现步骤（越详细越好）
   - 期望行为 vs 实际行为
   - 相关截图或错误日志

### 提交功能建议

1. 先搜索 Issues 确认建议未被提出过
2. 创建新 Issue，使用 **Feature Request** 模板
3. 清晰描述功能的使用场景和预期效果

### 贡献代码

1. Fork 本仓库
2. 基于 `main` 分支创建你的特性分支
3. 完成开发并确保测试通过
4. 提交 Pull Request

---

## 开发环境搭建

### 前置要求

- Node.js 18+（推荐使用 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- Git

### 本地运行

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/your-username/open-builder.git
cd open-builder

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run dev
```

访问 `http://localhost:5173`，在设置中填入你的 API Key 即可开始调试。

### 可用命令

```bash
npm run dev      # 启动开发服务器（热重载）
npm run build    # 构建生产版本
npm run preview  # 预览生产构建
npm run lint     # TypeScript 类型检查
```

---

## 项目结构

在开始贡献之前，建议先了解项目的核心模块：

```
src/
├── lib/generator.ts      # 核心引擎：WebAppGenerator（Tool Call 循环）
├── lib/tavily.ts         # 联网搜索工具
├── lib/settings.ts       # 设置持久化
├── store/conversation.ts # Zustand 会话状态管理
├── hooks/useGenerator.ts # 连接引擎与 UI 的 Hook
└── components/           # UI 组件
```

**修改核心引擎**（`generator.ts`）时请格外谨慎，它直接影响 AI 工具调用的稳定性。

---

## 提交规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范：

```
<类型>(<范围>): <简短描述>

[可选的详细描述]

[可选的关联 Issue]
```

### 提交类型

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（不新增功能，不修复 Bug） |
| `perf` | 性能优化 |
| `chore` | 构建流程或辅助工具变更 |

### 示例

```bash
feat(generator): 添加 search_in_files 工具支持正则搜索
fix(chat): 修复移动端消息列表滚动异常
docs: 更新 README 中的模型配置说明
refactor(store): 将会话持久化逻辑迁移到 Zustand middleware
```

---

## Pull Request 流程

1. **创建分支**

   ```bash
   git checkout -b feat/your-feature-name
   # 或
   git checkout -b fix/issue-123
   ```

2. **开发与提交**

   保持每个提交专注于单一变更，遵循提交规范。

3. **确保代码质量**

   ```bash
   npm run lint   # 确保无 TypeScript 错误
   npm run build  # 确保构建成功
   ```

4. **推送并创建 PR**

   ```bash
   git push origin feat/your-feature-name
   ```

   在 GitHub 上创建 Pull Request，填写：
   - 变更的简要描述
   - 关联的 Issue（如有）
   - 测试方法

5. **等待 Review**

   维护者会尽快 Review 你的 PR。请耐心等待，并根据反馈进行修改。

### PR 注意事项

- 保持 PR 聚焦，一个 PR 只做一件事
- 确保 PR 基于最新的 `main` 分支（如有冲突请先 rebase）
- 不要在 PR 中包含与功能无关的格式化改动

---

## 代码风格

- 使用 TypeScript，避免使用 `any`（必要时加注释说明原因）
- 组件使用函数式写法，优先使用 React Hooks
- 文件命名：组件使用 PascalCase，工具函数使用 camelCase
- 保持代码简洁，避免过度抽象
- 新增工具时，在 `generator.ts` 的 `BUILTIN_TOOLS` 数组中添加定义，并在 `executeTool` 的 switch 中添加处理逻辑

---

## 需要帮助？

如果你在贡献过程中遇到任何问题，欢迎：

- 在相关 Issue 下留言
- 创建新 Issue 描述你的问题

再次感谢你的贡献！
