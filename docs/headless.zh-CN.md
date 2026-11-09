# Skills、CLI 与本地 MCP

[English](headless.md)

无界面工具以目标项目的真实目录为准。宿主 Agent 负责规划、修改代码、安装依赖和可选的浏览器验证。CLI 与 MCP 共用项目操作实现，本身不调用模型。

## 构建与安装

使用 Node.js 24.x 和仓库指定的 pnpm：

```bash
pnpm install
pnpm skills:pack
pnpm headless:pack
npm install -g ./artifacts/headless/open-builder-cli-0.1.0.tgz
open-builder --help
```

本地 tarball 包含运行代码、许可证与三套设计资源，无需发布到 npm。也可以在独立目录安装 tarball，再执行 `node node_modules/@open-builder/cli/dist/main.js`。

原生模板支持 `react-ts` 和 `static`，独立于图形应用的 Sandpack 模板。静态项目没有构建脚本时，验证会明确返回不适用。初始化的目标目录必须不存在，父目录必须已存在。

```bash
open-builder init ./demo --template react-ts --design notion
# 由宿主在 ./demo 中用 npm 或 pnpm 安装依赖。
open-builder check ./demo --json
open-builder verify ./demo --task typecheck --json
open-builder verify ./demo --task build --json
```

`linear`、`stripe`、`notion` 是非官方视觉参考，不包含品牌资产。`design apply ./existing --id linear` 只新增 DESIGN.md 与 tokens.css；任一目标存在时不会覆盖。已有项目需要宿主将 tokens.css 接入实际样式入口；已知模板的初始化会自动接入。

## 安装 Skill

解压 `artifacts/skills/open-builder-workflow-0.1.0.zip`，将其中的 `open-builder-workflow` 目录复制到目标项目的 `.agents/skills/`（Codex）或 `.claude/skills/`（Claude Code）。两个宿主使用相同内容。启动新会话，在 Codex 显式调用 `$open-builder-workflow`，在 Claude Code 调用 `/open-builder-workflow`。

Skill 支持仅宿主工具、已发现的 CLI、已发现的 MCP 三条路径。参考文件从现有八个应用 Skill 生成，sources.json 记录版本和来源摘要；修改原文后重新打包，不编辑生成文件。打包会检查元信息和相对引用。

## 配置本地 MCP

使用已安装产物，而不是仓库源文件。三平台通用的启动方式是 `node` 加已安装 `dist/main.js` 的绝对路径。

Codex 在受信任项目中使用 `.codex/config.toml`：

```toml
[mcp_servers.open_builder]
command = "node"
args = ["/absolute/install/node_modules/@open-builder/cli/dist/main.js", "mcp", "--stdio", "--root", "/absolute/workspace"]
tool_timeout_sec = 360
```

Claude Code 使用项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "open_builder": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/install/node_modules/@open-builder/cli/dist/main.js",
        "mcp",
        "--stdio",
        "--root",
        "/absolute/workspace"
      ]
    }
  }
}
```

替换示例路径。Windows 使用原生绝对路径并转义 JSON/TOML 中的反斜杠，或使用正斜杠。需要执行项目脚本时，在服务器 args 中添加 `--allow-project-scripts`；工具参数不能启用该能力。宿主工具超时应大于任务超时，默认任务超时为 300 秒。安装不会修改全局宿主配置。

暴露验证工具不等于获得宿主批准，宿主仍可能提示批准或拒绝调用。不交互运行时，操作者需要为受信任项目配置宿主策略，参见 [Codex MCP 设置](https://developers.openai.com/codex/mcp)和 [Claude Code MCP 权限](https://code.claude.com/docs/en/mcp)。服务器不会修改宿主策略。

默认工具提供模板列表、设计系统列表、初始化、设计文件新增和静态检查。项目路径相对于启动时固定的工作区。可选验证工具只执行已有 build/typecheck/lint/test 脚本，不安装依赖。不提供通用 Shell、部署、远程 HTTP 或模型编排。

## 验证证据与任务行为

`packageManager` 用于选择 npm 或 pnpm；验证使用已安装的可执行程序，不下载声明中指定的包管理器版本。项目需要特定版本时，由宿主在验证前自行安装和配置。

健康检查属于静态启发式检查，报告列出扫描遗漏和未运行项。Token 合法、静态接入迹象、浏览器实际加载及视觉符合是不同证据；工具不读取环境变量秘密值。脚本以 `CI=1` 运行，是受信任的本机代码，工具不提供操作系统沙箱。npm/pnpm 的声明和锁文件冲突会被拒绝；不调度 monorepo 根目录，应指定具体应用目录。

验证进程退出后停止执行计时，清理有独立期限。取消和超时会清理 POSIX 验证进程组，Windows 则清理验证 Job Object。自行创建新会话或进程组的 POSIX 后代（例如 detached 进程）不在该清理范围内，需由宿主管理。验证脚本必须结束运行，且不得遗留脱离进程组的后台进程。

一次性命令支持 `--json`，stdout 只输出最终结果，诊断进入 stderr。MCP 的 stdout 只承载协议消息，并返回相同的结构化业务数据。退出码为：0 成功、1 检查发现问题或任务失败、2 参数/配置错误或不支持、124 超时、130 取消。检查发现问题属于正常工具数据；参数、权限和操作异常属于工具错误。

## 开发检查与验收

```bash
pnpm headless:build
pnpm headless:typecheck
pnpm headless:test
pnpm headless:smoke
pnpm skills:pack
```

smoke 测试会在仓库外安装 tarball，创建并修改 React 应用，由测试宿主显式安装依赖，执行真实类型检查与构建，保留用户文件，并调用安装后的 MCP。证据写入 `artifacts/headless/smoke-<platform>.json`。三平台工作流覆盖 Node、进程生命周期、CLI/MCP 与独立安装产物；本机 macOS 成功不代表 Linux/Windows 已通过。

真实宿主单独验收：两个宿主均须发现并调用安装后的 Skill，创建新应用，修改已有应用并保留 USER_NOTES.md，配置后实际调用 MCP，修复预设的脚本失败，并准确报告已运行检查。没有浏览器证据时必须说明“未进行视觉验证”。记录宿主版本、系统、产物版本和结果；模拟客户端不能替代模型驱动的宿主证据。当前记录见[验收记录](headless-acceptance.md)。
