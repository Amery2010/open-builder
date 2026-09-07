<div align="center">

# Open Builder

**基于 AI 的 Web 应用生成器 —— 用自然语言描述，即刻生成可运行的完整项目**

[![License](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.x-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)

[部署指南](#部署) · [快速开始](#快速开始) · [功能特性](#功能特性) · [技术架构](#技术架构) · [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)

[English](README.md) | 简体中文

</div>

---

## 简介

Open Builder 是一个桌面优先、同时提供浏览器界面的 AI Web 应用生成器。你只需用自然语言描述想要构建的应用，AI 就会通过工具调用（Tool Call）循环，在内存文件系统中自动创建、修改、删除文件，并通过 [Sandpack](https://sandpack.codesandbox.io/) 实时预览运行结果。

Open Builder 本身不依赖托管的应用后端。Web 端会直接连接你配置的模型服务和已批准的远程工具；服务商配置与 API Key 保存在浏览器本地存储中，并且只在相应已配置服务需要时发送。

Tauri 桌面版（macOS / Windows / Linux）提供 stdio MCP 等本机运行能力；Web 与实验性移动版明确不提供本机进程和 Skill 脚本执行。

> 内置 OpenAI Responses、Anthropic、Google 原生适配器，同时支持 Ollama 等 OpenAI 兼容接口。

---

## 演示

![screenshot](public/images/screenshot.jpg)

[演示网站](https://builder.u14.app)

---

## 功能特性

### 核心能力

- **自然语言生成代码** — 描述你的想法，AI 自动规划并生成完整项目结构
- **实时预览** — 基于 Sandpack 的浏览器内沙箱，代码变更即时渲染
- **多框架支持** — 支持 React、Vue、Svelte、Angular、SolidJS、Astro 等 20+ 模板，并由 Open Builder 维护依赖配置及经过验证的 Sandpack/Nodebox 运行时锁定
- **智能文件操作** — AI 通过 `patch_file` 精确修改文件，避免不必要的全量重写
- **依赖管理** — AI 可自动修改 `package.json` 并触发依赖重装
- **构建加速工具** — 通过专用工具安装 shadcn 组件、将截图转换为组件、应用设计规范，并管理类型安全的环境变量 schema
- **项目规范** — 可读取根目录的 `AGENTS.md`、`CLAUDE.md` 和 `DESIGN.md` 作为生成参考，同时将其视为不能覆盖工具与安全策略的不可信项目数据
- **项目快照** — 支持查看快照历史、命名快照、查看变更、导出 patch 并回滚到历史版本
- **项目健康检查** — `/health` 可检查结构、依赖、运行日志、可访问性与响应式风险；隔离的自动 QA 只执行受限项目检查，不访问 MCP 或预览控制台
- **上下文压缩** — 通过 `/compact` 或命令面板总结长对话，降低 Token 消耗
- **Plan Mode** — 支持先探索代码并提交方案，用户批准后再写入文件；`ask_user_question` 既可批量确认独立问题，也可逐题进行依赖式压力访谈
- **Design 模式** — 以项目为单位在编程 / 计划 / 设计间切换，生成带真实导航、共享模拟数据、页面与场景控制的完整多页面产品原型，并提供精选或自定义设计系统与显式设计自检
- **子代理协作** — 内置代码浏览、代码审查、依赖建议、Bug 调查、UI 审查等只读子代理
- **内置搜索** — 支持启用模型内置的搜索服务
- **桌面 API 代理** — Tauri 可转发经允许的 HTTP/HTTPS 模型请求，处理浏览器 CORS 限制；静态 Web 部署仍依赖服务商允许跨域访问
- **桌面本地 CLI 运行时** — 可主动选择通过隔离运行的 Codex、Claude、Pi 或 Antigravity CLI 执行完整生成流程，同时保持 API 为默认模式；Codex 可生成图片或以参考图编辑图片，Antigravity 可生成图片但不支持参考图编辑，不支持媒体的服务商不会收到该工具
- **托管项目图片** — 将随项目导入的图片，以及显式加入项目的生成图片保存在内容寻址的本地存储中，同时为源码 import、CSS URL、public URL、预览、ZIP 导出、快照和 Starter 副本保留各自的项目路径；删除所有者后会保守保留去重 Blob，直到执行“清除全部数据”，避免其他标签页正在导入的图片丢失

### 交互体验

- **多会话管理** — 会话列表侧边栏支持创建、切换、删除，历史记录持久化保存
- **会话整理** — 支持会话搜索、置顶、归档、复制与智能重命名
- **项目起始库** — 可搜索、编辑、更新并复用经过安全处理的本地项目副本及托管项目图片；保存前会确定性分析技术栈、排除敏感路径、脱敏高置信明文凭据，并要求显式确认
- **智能会话命名** — 根据对话内容自动生成会话标题，无需手动命名
- **Slash 指令** — 输入框支持 `/new`、`/fork`、`/clear`、`/reset`、`/compact`、`/health`、`/review`、`/continue`、`/retry`
- **命令面板与快捷键** — 可通过 `Cmd/Ctrl+K` 打开命令面板，并使用键盘新建会话、打开设置、聚焦输入框或停止生成
- **图片与文件输入** — 支持上传截图、文本文件或 PDF；新的本地图片默认以可配置的 `0.85` 质量压缩一次，支持 PDF 的模型会收到原生 PDF 文件输入，本地不抽取 PDF 文本
- **技能系统** — 开启的 Skill 只提供 metadata 供 AI 自动发现；仅在调用 `read_skill` 或为下一条消息选择 Skill 时加载全文，选择结果会传给子代理并在发送后清空。同一轮 Agent 加载的 Skill 会合并为一张可展开列表。8 个内置 Skill 为 `debug-web-app`、`build-tailwind-ui`、`build-accessible-ui`、`write-safe-typescript`、`art-direct-web`、`design-product-ui`、`review-code` 与 `simplify-code`；旧内置 ID 会自动迁移，导入 Skill 默认关闭自动发现
- **自定义指令** — 高级设置可安全追加最多 32,000 个字符，覆盖 Chat、Plan、重试与子代理，但不能授予工具或改变模式限制；自动 QA、智能标题与上下文压缩不会携带它
- **本地设置** — 服务商配置、API Key 与自定义指令会持久化到浏览器本地存储
- **存储治理** — 可查看包含导入设计系统与保留项目图片 Blob 在内的本地数据占用，并安全清理归档会话、空会话、旧快照或全部本地存储域
- **流式输出** — 实时展示 AI 思考过程和代码生成进度
- **扩展思考** — 支持 Extended Thinking / Reasoning 模式（DeepSeek-R1、Claude 4.6 等）
- **一键下载** — 将生成的项目打包为 ZIP 文件下载到本地
- **工作区工具** — 支持代码/预览切换、使用 Material Icon Theme 图标浏览并搜索和管理文件、Sandpack 控制台，以及桌面/平板/手机预览宽度、自适应和缩放
- **交互式设计修改** — 在受支持的 Sandpack 预览中点选带稳定 `data-ob-id` 的元素，将清洗后的选择上下文交给下一条请求，并通过带快照的保存修改规范语义 Token
- **设计审查与桌面导出** — 在 Web 或桌面端上传最多三张截图进行按需只读审查，或在桌面端将规范项目文件导出到全新的不覆盖目录
- **自适应布局** — 桌面端使用横向可调分栏，平板端使用工作区在上、对话在下的纵向可调分栏，手机端使用对话优先并内嵌预览的布局
- **语言与主题** — 提供英文、简体中文界面，以及跟随系统、浅色和深色主题

### 指令与快捷键

| 指令        | 行为                               |
| ----------- | ---------------------------------- |
| `/new`      | 新建会话                           |
| `/fork`     | 复制当前会话与项目                 |
| `/clear`    | 清除对话上下文，但保留当前项目文件 |
| `/reset`    | 经确认后重置当前会话和项目         |
| `/compact`  | 压缩当前对话上下文                 |
| `/health`   | 执行项目健康检查                   |
| `/review`   | 让 AI 审查当前项目                 |
| `/continue` | 继续被中断或尚未完成的任务         |
| `/retry`    | 重试最近一次生成                   |

| 快捷键       | 操作                           |
| ------------ | ------------------------------ |
| `Cmd/Ctrl+K` | 打开或关闭命令面板             |
| `Cmd/Ctrl+N` | 新建会话                       |
| `Cmd/Ctrl+,` | 打开设置                       |
| `Cmd/Ctrl+/` | 聚焦对话输入框                 |
| `Esc`        | 优先关闭命令面板，否则停止生成 |

### Design 模式

Design 模式的产物仍位于当前会话的普通项目文件树和 Sandpack 预览中，不创建独立 Artifact 存储。“编程”只调整界面文案，内部继续使用 `"auto"` 兼容值。模式、自动判断结果、待选设计系统与已应用设计系统均按项目记忆；从 Design 进入 Plan 后，批准方案会返回 Design。

- 新视觉项目默认使用 `vite-react-ts`；新建完整产品原型使用专用的 `vite-react-ts-prototype` starter，内置 React Router `HashRouter`、可重置的共享模拟数据和适合静态交付的运行方式。已有项目与导入项目继续使用当前 Design 流程。
- 完整原型将经过校验的产品大纲保存在根级 `design-project.json`。该文件统一管理稳定的页面、布局、共享 UI、流程、场景与构建进度 ID；`DESIGN.md` 和 `tokens.css` 继续管理视觉契约。
- 预览工作区增加可折叠页面树，以及页面和场景选择器。跨页面导航保留共享模拟数据的修改；切换场景或点击**重置数据**会恢复原型初始数据。
- Design 生成的每一批任务都绑定当前蓝图修订、目标页面和共享文件范围。已完成页面与流程写入蓝图检查点，后续可用 `/continue` 恢复而不重复构建已记录内容。
- 内置目录包含 12 套精选的非官方视觉参考，并为每套提供独立的满幅 640×480 WebP 预览：Linear、Stripe、Claude、GitHub、IBM、Figma、Notion、Shopify、Apple、Spotify、The Verge 与 WeChat。已有项目选择不同系统后会立即启动 AI 应用流程；空项目则把该选择作为下一次 Design 请求的视觉参考。
- 选择器保持**自动**时，会在下一次 Design 生成前执行一次隔离、无工具的模型判断；候选包括内置、导入、自定义系统以及明确的**不采用**。通过校验的结果会按项目保持，直到用户手动改选或重新判断；无效结果会在下一次请求时重试。
- 自定义系统需要名称和三类始终可见的规则输入。当前 API 或本地 CLI 模型在没有项目文件和工具的环境中编译规则；只有严格 JSON、CSS、语义 Token 与完整包校验全部通过后才会保存并选中。自定义和导入系统共用满幅通用 WebP 占位图。
- 导入系统采用最小 `manifest.json + DESIGN.md + tokens.css` 契约。ZIP 与目录导入在确认前展示摘要，并以有界、纯文本规则进行校验；同 ID 内容不会静默覆盖。
- 点选能力首版支持 `static`、`vite`、`vite-react` 和 `vite-react-ts`。不受支持或 `code-only` 的项目仍可使用 Design 提示词与文件工具，但界面会明确说明点选或 Token 实时预览为何不可用。
- 只有根级 `DESIGN.md` 的旧项目继续作为只读视觉参考，除非用户显式升级为带 Token 的设计系统。

| 能力                          | Web                              | 桌面端                                   |
| ----------------------------- | -------------------------------- | ---------------------------------------- |
| 生成、实时预览、点选修改      | 完整核心闭环                     | 完整核心闭环                             |
| 设计系统导入                  | ZIP 或浏览器目录选择器           | ZIP 或本地目录                           |
| 项目导出                      | ZIP                              | ZIP 或全新唯一命名目录；不提供双向同步   |
| 模型运行                      | API 或允许浏览器 CORS 的远程端点 | API、Tauri 代理或受支持的本地 CLI 运行时 |
| 视觉审查                      | 用户手动上传截图                 | 用户手动上传截图                         |
| 本地进程 / stdio / Skill 脚本 | 静态 Web 部署不支持              | 遵循现有桌面能力检测与批准限制           |

Design Review 与自动 QA 明确分离。受限审查运行只能列出、读取和搜索项目文件，并提交最多 8 条结构化问题；它不能写文件、调用 MCP 或联网工具、加载 Skill 或执行脚本。完整原型的证据绑定项目 generation、蓝图修订、页面、场景和视口；声明的目标会在临时预览 iframe 中串行采集，未采集目标显示为未审查，项目发生变化后旧证据显示为已过期。手动审查只有在用户勾选问题并点击**应用所选修复**后，才会进入正常 Design 修改流程。符合条件的 Design 生成完成后，自动审查可以针对确定性问题、P0/P1 视觉问题及非 P3 的系统一致性问题执行一次有界修复，并再做一次复核。只有证据与会话仍为当前状态时才会修复；等待、失败、不可用或被新状态取代的任务会明确显示，也不会被描述为审查无问题。

### MCP 与平台能力（可选）

- 可配置使用 Streamable HTTP 或 SSE 的远程 HTTPS MCP 服务，并支持静态 Header、OAuth 授权码与 OAuth 客户端凭据；桌面版还支持 stdio 服务。
- 支持从 JSON 导入服务定义、分别启停服务与工具，并在工具定义发生漂移后重新审查能力。
- Plan Mode 与子代理只能使用显式批准可在对应模式运行的只读 MCP 工具。
- 内置托管的 **Agnes AI** 项在 Web、桌面端和实验性移动端均使用固定官方地址。填写本地 API Key 后，可分别批准 `generate_image`、`create_video` 与 `get_video_status`；Web 请求仍受浏览器 CORS 限制。
- Agnes 图片生成支持纯文本、当前消息单图，以及合计最多五张当前消息图片/公开 HTTPS 参考图。文生视频会在来源对话激活时更新同一个对话占位符；生成媒体仅保留远程 HTTPS URL，不写入项目文件。自动轮询仅存在于当前会话，应用重启后不会恢复；仍可使用 `get_video_status` 手动刷新。
- Agnes 工具可用于 Chat 与 Design，不用于 Plan、自动 QA 或 Design Review。只有 `generate_image` 可另行授权给子代理；视频创建和状态查询始终不向子代理开放。

| 运行环境     | 远程 HTTPS MCP | stdio MCP | Skill 脚本                |
| ------------ | -------------- | --------- | ------------------------- |
| Web          | 支持           | 不支持    | 不支持                    |
| 桌面端       | 支持           | 支持      | 开发者开关 + 每次调用批准 |
| 实验性移动端 | 支持           | 不支持    | 不支持                    |

### 联网搜索

- [Firecrawl](https://www.firecrawl.dev) 是新安装和重置设置的默认引擎，可在按 IP 限额下免 Key 搜索和读取网页；填写可选 API Key 后可提高限额
- 支持使用服务商凭据配置 [Tavily](https://tavily.com) 和 [Exa](https://exa.ai)；受支持的模型服务商也可使用内置搜索
- 配置的网页读取服务无法返回页面时，会自动降级到 [Jina Reader](https://jina.ai/reader/)

---

## 快速开始

### 前置要求

- Node.js 24 LTS
- pnpm 11
- 受支持的模型服务地址，以及该服务需要时使用的 API Key

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/Amery2010/open-builder.git
cd open-builder

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

打开浏览器访问 `http://localhost:5173`，点击右上角设置图标配置你的 API Key 即可开始使用。

### 桌面/移动应用（Tauri）

需要额外安装 [Rust](https://www.rust-lang.org/tools/install) 和 Tauri 的[平台依赖](https://tauri.app/start/prerequisites/)。

```bash
# 桌面端开发
pnpm tauri:dev

# 桌面端构建
pnpm tauri:build

# iOS 开发/构建
pnpm tauri ios init # 仅首次初始化
pnpm tauri:ios:dev
pnpm tauri:ios:build

# Android 开发/构建
pnpm tauri android init # 仅首次初始化
pnpm tauri:android:dev
pnpm tauri:android:build
```

### 本地 CLI 运行时（桌面端）

桌面版可以把已安装的 Codex、Claude、Pi 与 Antigravity CLI 作为完整代理运行时。API 仍是默认运行方式。每个服务商都必须先通过可执行文件、版本、结构化协议、模型选择与隔离能力检测，之后才会接收用户内容。认证状态单独表达：CLI 能提供的登录状态会在检测时验证；只有真实推理才能确认的自定义网关凭据或模型路由会显示为**可发送，待首次验证**。模型选择由能力目录驱动：完整目录可以明确拒绝不支持的选择；不完整或过期（partial/stale）目录会保留当前选择并标记为“未验证”及发出提示，不会静默替换。Open Builder 不会在运行方式或服务商之间静默降级。

请安装并配置一个受支持的 CLI：

- **Codex：**安装官方 Codex CLI，再运行 `codex login`。Open Builder 使用稳定的 [`codex exec --json`](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 协议，并启用 `--ignore-user-config` 与 `--ignore-rules`；随后仅导入经过校验的机器级当前 [`model_provider`](https://developers.openai.com/codex/config-advanced/) 定义及其引用的环境凭据。推理强度会按所选模型实际报告的能力校验，因此 CLI 宣布支持时可使用 `max`、`ultra` 等值；自定义服务商无法验证的能力会保留为“未验证”。自定义服务商还必须声明顶层 `model`；`env_http_headers` 项为可选项，仅在它引用的环境变量存在时生效。项目规则、hooks、插件、无关 MCP 服务、静态服务商密钥和凭据辅助命令仍被隔离。详见官方 [最新模型指南](https://developers.openai.com/api/docs/guides/latest-model)。
- **Claude：**安装官方 Claude Code CLI 并完成账号登录流程（也可运行 `claude auth status` 查看状态）。Open Builder 要求官方文档中的 [`stream-json` 与隔离参数](https://code.claude.com/docs/en/cli-usage)，以受限模式运行，不加载用户／项目设置源，使用私有系统提示文件、严格 MCP 配置，且只开放 Open Builder 工具桥。Claude 的安全模式会连同其他自定义项一起停用本次运行显式注入的 MCP 桥，因此这里不会启用。经过校验的 Claude 网关可提供 endpoint、显式凭据和模型路由环境，但不会加载其余用户设置。Open Builder 会自动对该网关执行有界的只读 `GET /v1/models`，接受官方 [Anthropic 模型列表格式](https://platform.claude.com/docs/en/api/beta/models/list)及兼容网关格式，并按网关顺序展示全部合法 ID，包括 GPT 与 Gemini 模型；不要求开启 Claude Code 的可选[网关目录发现](https://code.claude.com/docs/en/llm-gateway-connect)。本地 alias 与精确 gateway ID 会分别保留。
- **使用 Node.js 22.19 或更高版本安装 Pi：**Open Builder 当前支持 Pi `>=0.84.4 <0.85.0`；运行 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4` 安装当前固定版本。Pi 也提供官方安装器 `curl -fsSL https://pi.dev/install.sh | sh`，但请确认其安装结果仍处于支持范围。启动 `pi` 后，在 Pi 内运行 `/login` 配置模型服务商。详见 [Pi 快速开始](https://pi.dev/docs/latest/quickstart)。
- **Windows 上的 Pi 独立程序：**从 [Pi release](https://github.com/earendil-works/pi/releases/tag/v0.84.4) 下载官方 `pi-windows-x64.zip` 或 `pi-windows-arm64.zip` 及 `SHA256SUMS`，解压；若程序不在 `PATH`，可通过**选择程序**指定 `pi.exe`。
- **Antigravity：**安装现代 Google Antigravity CLI 并完成账号登录流程。只有当 `agy` 宣布支持官方[流式 headless 协议](https://antigravity.google/docs/cli/headless/)的 `--input-format stream-json`、`--output-format stream-json` 与 `--agent` 参数时，Open Builder 才会接入；可用 `agy models` 查看模型。应用支持官方的 [`modelProvider: "gemini"`](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key) 模式、`GEMINI_API_KEY`，以及可选且经过校验的 `GOOGLE_GEMINI_BASE_URL`。结构化 headless 输入界面从 Antigravity CLI 1.1.15 起提供，请升级旧版本。应用不会回退到纯文本协议。

启动桌面版，打开 **设置 → 模型 → 运行方式 → 本地 CLI**，选择 CLI 服务商，并确认状态为**已安装并可用**或**可发送，待首次验证**。后者表示设置页检测不会发起模型调用；第一条真实消息才会验证凭据或网关，并可能消耗额度。Open Builder 会扫描 `PATH` 与常见安装位置；**选择程序**只会把验证过的可执行文件覆盖路径保存到原生 app data。模型和推理强度偏好按服务商分别保存，并由所选 CLI 提供；普通检测使用短时缓存，**重新检测**会强制读取最新目录。如果目录不完整或已过期（partial/stale），当前保存的模型和推理强度仍可作为**未验证**选项使用，未知的推理强度会隐藏，界面会提示而不会清空偏好。Codex、Claude、Pi 与 Antigravity 之间切换时绝不会复用对方的 session；安装、启动配置、模型、推理强度或协议发生变化时会新建对应服务商的 session。

本地 CLI 的 Chat 运行中，Codex 会收到支持可选 opaque 参考图 ID 的 `generate_image`，Antigravity 只会收到文生图能力，Claude 与 Pi 不会收到该工具。生成结果会先保留在对话中；只有代理为已初始化项目调用 `import_generated_image` 后，Host 才会在请求的安全路径创建托管项目图片模块。这些媒体工具不向 Plan 及其他受限 profile 开放。

本地 CLI 不等于离线模型。提示词、附件、联网搜索活动和工具结果通常仍会发送给该 CLI 配置的模型服务商，并可能消耗订阅或 API 额度。对于 Codex、Claude 与 Antigravity，Open Builder 只读取当前所选配置所需的官方服务商字段，并把其引用的凭据直接交给对应 CLI 子进程；凭据值不会被持久化、显示、记录到日志，也不会进入命令参数或临时配置。Antigravity 的账号登录仍由操作系统安全凭据存储管理；Open Builder 不会猜测或复制 Gemini 凭据文件，只会按 Open Builder 对话把 Agy 的原生会话／缓存状态保存在哈希命名的 app-private HOME 中，utility 运行仍使用一次性 HOME。Pi 将 OAuth 与 API Key 保存在 `~/.pi/agent/auth.json`，创建时仅当前用户可读；Open Builder 会从 Pi 子进程环境中剥离模型服务商 API Key，只依赖 OAuth／auth 文件。在发送用户内容前，应用还会拒绝 `models.json` 中的内联凭据、环境变量凭据和命令解析凭据；凭据来源探测不会解析或执行这些值。请改用 Pi 的 `/login` 流程保存该服务商凭据。普通 Pi 默认将按 cwd 组织的 JSONL session 保存到 `~/.pi/agent/sessions/`，但 Open Builder 会改用 app-private session 目录，并只在本地对话中保留按服务商隔离的 opaque session ID。详见官方[服务商](https://pi.dev/docs/latest/providers)与 [session](https://pi.dev/docs/latest/sessions)说明。

项目仍保存在 Open Builder 的内存虚拟文件系统中。每个服务商使用稳定的 app-private 空白 scratch 目录，只能通过当次运行的带认证 loopback 工具桥访问项目。附件使用不可猜测 ID，不暴露宿主文件路径；在发送用户内容前，应用会禁用或拒绝用户级 Skills、Agents、MCP 服务、规则、项目指令文件、hooks、扩展、原生 shell／文件系统工具、浏览器执行和原生写入。Antigravity 还会收到每轮私有 Agent、MCP 配置和权限策略；只允许 Open Builder MCP 工具（明确选择模型内置搜索时，额外只允许只读 URL 访问）。

Headless 本地 CLI 不会打开自己的权限弹窗。Open Builder 只把当次运行的精确工具清单投影给服务商，使工具调用能够抵达现有 Host 授权流程；该投影本身不会授予项目访问权。服务商侧的 approval 或 permission 拒绝会立即终止运行，并在聊天中显示服务商、失败阶段、安全的修复建议和可复制诊断 ID；聊天错误绝不会展示服务商 stderr 或凭据。

Pi 工具结果可以携带文本和图片。带文本的 resource 与图片 resource 会无损转换；Pi 无法消费的 PDF、音频和其他二进制 resource 会返回明确的工具错误，不会再静默退化成文件名或摘要。需要 Pi 检查这类附件时，请先转换为文本或图片。

联网搜索选择**模型内置**时，兼容的本地 CLI 只有在所选适配器验证对应能力后才会使用自身原生搜索。Pi 没有原生联网搜索工具，因此 Open Builder 会在 turn 开始前阻断，并要求改选 Tavily、Firecrawl、Exa 或停用；绝不会静默改换搜索引擎。这些显式搜索服务使用 Open Builder broker 提供的工具，同时关闭 CLI 原生或扩展提供的搜索。若状态显示未安装、需要配置、版本不支持或隔离失败，可使用**重新检测**、**选择程序**、**恢复自动检测**或复制界面提供的配置命令。Web 与移动端会明确阻断本地 CLI，并要求切换回 API。

DeepSeek Harness 支持目前明确延后，且未来只走 ACP。截至本文档快照，可安装的 [npm `latest`](https://www.npmjs.com/package/@deepseek-ai/dsh) 是 `0.1.1-rc.2`，与 Open Builder 接入相关的 CLI 界面只有一次性 headless runner；ACP 在固定版本的[官方 ACP adapter 源码](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/acp/acp/README.md)中仍仅为 alpha／源码形态。只有官方 npm 发布不带 alpha、beta 或 RC 预发布后缀、并内含 `dsh --profile acp` 的稳定版本，才会将其加入服务商目录与设置界面；仅源码 profile、headless 输出与独立 SDK 协议都不满足接入门槛。

### 配置说明

点击界面右上角的设置按钮，填写以下信息：

| 配置项       | 说明                                      | 示例                                |
| ------------ | ----------------------------------------- | ----------------------------------- |
| API 类型     | 服务商协议适配器                          | OpenAI、Anthropic、Google、兼容接口 |
| API Key      | 服务商需要时使用的凭据                    | `sk-...`                            |
| API Base URL | 服务商域名或基础路径                      | `https://api.openai.com`            |
| 模型名称     | 模型 ID；受支持的服务商可动态读取模型列表 | `gpt-5.6-sol`、`deepseek-chat`      |
| 联网搜索     | 免 Key Firecrawl，或其他服务商凭据        | `fc-...`、`tvly-...` 或 Exa Key     |
| 图片搜索     | 可选的 Pixabay 或 Unsplash 凭据           | 对应服务商 API Key                  |
| 自定义指令   | 高级设置中的可复用指令                    | 最多 32,000 个字符                  |
| 图片压缩     | 新的本地图片存储前只压缩一次              | 默认启用；质量 `0.85`               |

> 设置和 API Key 都保存在浏览器本地存储中。自定义指令会在 Chat、Plan、重试与子代理工作时发送给当前模型服务商，且不能扩大工具权限；请勿在其中填写凭据或其他秘密。请将当前浏览器配置文件和设备视为凭据安全边界的一部分。

MCP 服务与 Skills 可从对话工具栏管理。Skills 管理页开关只控制 metadata 自动发现；在工具栏选择 Skill 会为下一次请求加载完整正文，并在发送后清空。只有原生运行时报告具备对应能力时，界面才会显示桌面专属选项。

Agnes API Key 在 MCP 面板中默认以掩码显示，只保存在本地应用数据中，可通过面板移除，并会从导出内容和诊断输出中清除。“检查配置”只验证本地完整性，不会请求 Agnes。

---

## 技术架构

### 核心引擎：WebAppGenerator

[src/lib/ai/generator.ts](src/lib/ai/generator.ts) 是整个项目的核心，实现了完整的 AI Tool Call 循环引擎：

```
                         ┌─ API Backend → AI SDK
用户消息 → Generator ───┤
                         └─ Local CLI Backend → Tauri Agent Manager
                                                  ↓
                                      Loopback MCP 工具桥
                                                  ↓
                                      共享工具执行器与策略
                                                  ↓
                                         内存虚拟文件系统
                                                  ↓
                                         Sandpack 实时预览
```

内置工具列表：

| 工具                             | 描述                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `init_project`                   | 初始化 Sandpack 项目模板                                           |
| `manage_dependencies`            | 修改 package.json 管理依赖                                         |
| `list_files`                     | 列出所有项目文件                                                   |
| `read_files`                     | 批量读取文件内容                                                   |
| `write_file`                     | 创建或覆写文件                                                     |
| `patch_file`                     | 精确搜索替换补丁（推荐用于小改动）                                 |
| `delete_file`                    | 删除文件                                                           |
| `rename_file` / `move_file`      | 重命名或移动文件，并自动更新相对路径引用                           |
| `search_in_files`                | 全局搜索文件内容                                                   |
| `get_console_logs`               | 读取 Sandpack 预览控制台输出                                       |
| `compact_context`                | 压缩长对话上下文                                                   |
| `ask_user_question`              | 批量询问 1-4 个独立问题，或按决策依赖逐题进行压力访谈              |
| `exit_plan_mode`                 | 提交实施方案并等待用户批准                                         |
| `dispatch_subagent`              | 调用只读子代理进行探索、审查或诊断                                 |
| `project_health_check`           | 检查项目结构、依赖文件、环境变量、控制台日志、可访问性和响应式风险 |
| `web_search`                     | 联网搜索（支持模型内置、Tavily、Firecrawl、Exa）                   |
| `web_reader`                     | 读取网页内容                                                       |
| `image_search`                   | 图片搜索（支持 Pixabay、Unsplash）                                 |
| `search_npm_packages`            | NPM 包搜索                                                         |
| `get_npm_package_detail`         | 获取 NPM 包的详细信息                                              |
| `install_component`              | 安装经允许的 shadcn registry 组件及其依赖                          |
| `screenshot_to_code`             | 根据提供的 UI 图片生成并写入组件                                   |
| `apply_design_style`             | 为项目写入选定的设计规范                                           |
| `apply_design_system`            | 将显式选择的 Design 模式系统契约应用到已初始化项目                 |
| `submit_design_review`           | 提交只读 Design Review 配置产生的有界结构化结果                    |
| `list_skills` / `read_skill`     | 发现已启用的 Skill metadata，并按需加载全文与资源清单              |
| `execute_skill_script`           | 仅在桌面端运行已激活技能的脚本                                     |
| `read_env_schema` / `manage_env` | 安全读取与管理环境变量文件                                         |

启用的 MCP 工具会在服务发现并获批后动态注入，并根据当前平台以及 Chat、Plan、Design、自动 QA、Design Review 或子代理运行策略进行过滤。`apply_design_style` 继续作为 Auto 模式的兼容路径；Design 模式使用 `apply_design_system`。

内置 Agnes MCP 适配器直接提供 `generate_image`、`create_video` 和 `get_video_status`，不会创建远程 MCP 传输会话。图片与视频结果会在对话中直接显示为媒体占位符，并在远程 URL 可用后原位替换。

受支持的本地 CLI Chat 运行会加入服务商原生 `generate_image`；已初始化项目还会加入 `import_generated_image`，通过托管项目图片边界接纳生成结果，不会把 CLI 原生 scratch 文件当作项目文件。

### 技术栈

| 类别          | 技术                              |
| ------------- | --------------------------------- |
| 框架          | React 19 + TypeScript 6           |
| 构建工具      | Vite 8                            |
| 样式          | Tailwind CSS v4                   |
| UI 组件       | shadcn/ui + Radix UI              |
| 代码沙箱      | Sandpack (CodeSandbox)            |
| 状态管理      | Zustand 5                         |
| 本地存储      | localforage                       |
| 图标          | Lucide React                      |
| Markdown 渲染 | react-markdown + rehype-highlight |
| 桌面/移动端   | Tauri 2                           |

---

## 支持的 API 协议

Open Builder 会根据 API 类型选择对应的 AI SDK 原生适配器，并可从受支持的服务端点动态读取模型列表。

| API 类型        | 协议/适配器             | 默认 Base URL                               | 典型用途              |
| --------------- | ----------------------- | ------------------------------------------- | --------------------- |
| OpenAI 兼容接口 | OpenAI 兼容 Chat API    | `http://localhost:11434`                    | Ollama 与其他兼容网关 |
| OpenAI          | Responses API           | `https://api.openai.com`                    | OpenAI                |
| Anthropic       | Messages API            | `https://api.anthropic.com`                 | Anthropic             |
| Google          | Generative Language API | `https://generativelanguage.googleapis.com` | Google Gemini         |

> 推荐使用支持 Function Calling 的强力模型以获得最佳效果。

---

## 部署

静态 Web 部署不包含 Tauri API 代理、stdio MCP 或 Skill 脚本执行能力。浏览器直接访问的模型和搜索服务必须通过 CORS 允许当前部署来源。

### 构建生产版本

```bash
pnpm build
# 产物输出到 dist/ 目录
```

### Docker / GitHub Container Registry

轻量容器镜像使用非 root 的 Nginx Alpine 运行时提供 Web 构建产物：

```bash
docker run --rm -p 8080:8080 ghcr.io/amery2010/open-builder:latest
```

打开 `http://localhost:8080`。镜像支持 `linux/amd64` 和 `linux/arm64`，且不会包含服务商凭据、API 代理、stdio MCP、本地 CLI 或 Skill 脚本运行时；浏览器直接访问的模型和搜索服务仍须通过 CORS 允许当前部署来源。

推送 `v1.8.0` 这样的语义化版本标签后，GitHub Actions 会先执行完整前端门禁和容器冒烟检查，再向 `ghcr.io/amery2010/open-builder` 发布 `1.8.0`、`1.8`、`1` 与 `latest` 标签。预发布版本只发布完整的预发布标签。GitHub 首次创建容器包时默认设为私有，因此仓库所有者需要在首次成功发布后将可见性一次性调整为公开。

详见 [.github/workflows/release.yml](.github/workflows/release.yml)。

### 部署到 GitHub Pages

GitHub Actions 会在 `main` 更新或手动触发时构建并部署 Pages。工作流会自动设置 Vite 仓库子路径，并包含静态 MCP OAuth 回调入口。`v*` tag 会在各自质量门禁通过后创建桌面版 draft release 并发布容器镜像，但不会部署 Pages。

详见 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)。

### 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAmery2010%2Fopen-builder)

或手动部署：导入 GitHub 仓库，框架预设选择 `Vite`，构建命令 `pnpm run build`，输出目录 `dist`，无需额外配置。

### 部署到 Cloudflare Worker

[![Deploy to Cloudflare Worker](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Amery2010/open-builder)

或手动部署：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Worker → Connect to Git
2. 选择 `open-builder` 仓库，构建配置如下：

| 配置项       | 值               |
| ------------ | ---------------- |
| 构建命令     | `pnpm run build` |
| 输出目录     | `dist`           |
| Node.js 版本 | `24`             |

### 部署到 Netlify

直接导入仓库，构建命令 `pnpm run build`，输出目录 `dist`，无需任何额外配置。

---

## 贡献

欢迎提交 Issue 和 Pull Request！请先阅读 [贡献指南](CONTRIBUTING.md)。

---

## 许可证

[GPLv3 License](LICENSE) © 2026 Open Builder Contributors
