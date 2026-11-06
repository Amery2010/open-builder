# 本地 CLI 实时输出与思考摘要

日期：2026-11-06。

## 输出边界

CLI 产生的正文与思考事件进入统一的 `textDelta` / `reasoningDelta` 通道。应用在收到增量后持续转发，不等待完整回答或进程退出。主聊天继续使用原有逐字播放、结束刷新和思考块交互；播放缓冲的积压不表示 CLI 传输延迟。

工具结果交付、中途补充指令提交和权限版本仍使用现有交付屏障。屏障期间的后续事件按序暂存，交付结束后处理；Stop 或失效运行的事件不会重放到当前消息。

## 协议与摘要策略

| CLI         | 正文协议                                                                                                   | 思考内容                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex       | 优先独立 app-server stdio；明确缺少必要协议能力且旧通道隔离验证通过时，在发出任务前使用 exec JSON 兼容路径 | 请求自动摘要，接收摘要增量；兼容路径接收 reasoning 文本与 summary                                      |
| Claude Code | stream-json 和部分消息事件                                                                                 | 无模型探测确认版本支持后使用 `--thinking-display summarized`；不支持此参数时继续接收原生输出并记录限制 |
| Pi          | RPC message_update                                                                                         | 接收 thinking_delta、thinking_end 和最终消息中的可读 thinking 块                                       |
| Antigravity | stream-json step_update                                                                                    | 接收实际返回的思考事件；没有已验证的正文开关时保持能力未知                                             |

Codex app-server 与 exec 的会话兼容标识独立。协议切换通过现有 bootstrap 建立新原生会话，应用聊天记录与项目状态保留。任务发出后不因失败切换协议重放，避免重复模型请求或 Host 工具副作用。

模型和推理强度沿用已解析的用户选择，摘要显示配置独立处理。CLI 支持思考协议不保证当前模型、服务商或本轮请求返回可读内容；空思考、签名、redacted 内容和 thinking token 统计均不构成思考正文。只显示服务商公开返回的可读内容，不保证完整内部推理。

正文和思考按消息、内容块或步骤分别核对。完整快照只补充尚未交付的尾部，重复快照不重复追加；冲突或回退报告协议错误并保留已有内容。真正的增量片段即使连续相同也会保留。

收到的思考文本进入消息 `thinking` 字段，随会话保存。主聊天生成时展开，结束后收起，用户可以重新展开。标题、压缩等内部辅助调用继续只消费所需结果，不新增聊天输出。

## 能力元数据与诊断

`prepared.outputCapabilities` 是新增的可选字段：

- `transport`：实际选用的 CLI 协议。
- `textGranularity`：`delta`、`message` 或 `unknown`。
- `reasoningText`：协议层的 `supported`、`unsupported` 或 `unknown`。

旧桌面没有这些字段、未来协议值暂不认识时仍可运行，诊断按未知处理。既有 `capabilities.reasoning` 保持推理能力含义，不代表一定返回思考文本。

控制台 `[local-cli] run timing` 在既有准备、握手和总耗时之外，记录：

- `firstTextMs` / `firstReasoningMs`：事件进入前端运行层的首次接收时间，不含逐字播放时间。
- `deliveryBarrierMs` / `barrierBufferedEvents`：工具交付屏障占用时间与缓冲事件数。
- `transport` / `textGranularity` / `reasoningTextSupport` / `protocolFallback`：本轮实际协议能力与降级状态。
- `reasoningReceived`：本轮是否实际收到非空白可读思考内容，与协议支持状态分开记录。

计时使用单调时钟，不记录正文、思考原文、凭据、提示词或工具参数。原有权限、单帧结构校验与进程清理保留；没有新增累计内容、总运行时长或构建体积门槛。

## 验证入口

自动化覆盖分段输出、终态前转发、消息/块/摘要索引归属、最终快照补尾和去重、冲突、空内容、签名及 redacted 内容、工具屏障与指令顺序、停止和过期事件、思考内容保存与恢复。

常规检查：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm security:desktop
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

真实账号验收需显式运行 ignored tests，会向已登录的 CLI 发送少量真实请求。以下命令在 `src-tauri` 下执行：

```sh
OPEN_BUILDER_MANUAL_CLI_PROVIDER=codex \
OPEN_BUILDER_MANUAL_CLI_EXECUTABLE=/Users/amery/.local/bin/codex \
cargo test --lib manual_real_cli_fresh_and_resume -- --ignored --nocapture

OPEN_BUILDER_MANUAL_CLI_PROVIDER=codex \
OPEN_BUILDER_MANUAL_CLI_EXECUTABLE=/Users/amery/.local/bin/codex \
cargo test --lib manual_real_cli_stop_during_output -- --ignored --nocapture
```

其他 provider 值为 `claude`、`pi`、`antigravity`，可执行文件路径按安装位置替换。可选 `OPEN_BUILDER_MANUAL_CLI_MODEL` / `OPEN_BUILDER_MANUAL_CLI_EFFORT`；省略时使用适配器解析的默认选择。

fresh/resume 使用隔离目录、真实 Host bridge 和临时 marker 验证工具调用及会话恢复；Stop 测试在首次可读增量出现时取消，并验证运行返回 aborted。测试结束清理临时目录、桥接和本轮进程。它们属于真实 CLI 后端验收，不能代替真实桌面交互证据。fixture 和单元测试通过也不能证明服务商一定返回思考文本。

## 本轮验收记录

本地检查：前端 Vitest **225 套、1569 项通过**；Rust **332 项通过、5 项显式手动验收测试默认忽略**。类型检查、lint、桌面安全检查、Prettier、Rust fmt、diff 检查、Web 构建和隔离标识的 Tauri debug 应用构建均通过。Web 构建仍有现有 store / project archive 混合导入提示；测试保留既有 jsdom Canvas 与预期错误边界输出，不影响通过。

| CLI / 实测版本      | 真实后端结果                                                                                                              | 思考内容与限制                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex 0.163.0       | app-server 新建、Host 工具、恢复会话通过；两个短任务各收到 8 个正文增量；首字约 10.54 / 10.10 秒，完成约 10.62 / 10.18 秒 | 确定性短任务未出现思考文本；真实桌面分析任务出现非空公开思考摘要。摘要出现与否不能由 token 数量推断 |
| Claude Code 2.1.260 | 默认模型准备路径受现有目录匹配限制；使用映射到同一实际模型的 `opus` 别名后，请求被服务商限流，未完成新建/恢复验收         | `--thinking-display summarized` 的无模型能力探测及正式 fixture 通过；未验证真实非空思考文本         |
| Pi 0.84.4           | 准备阶段报告 auth.json 尚未配置凭据，未发送真实模型请求                                                                   | RPC 思考事件及补尾通过本地 fixture；真实账户未验收                                                  |
| Antigravity 1.5.1   | 首次探测中安装文件由 1.1.23 更新，安装身份复核正确中止；重新探测后被服务端账号资格检查拒绝                                | 未观察到真实思考正文，能力保持 unknown；没有绕过资格检查或重放请求                                  |

Codex 模型和 effort 沿用本机解析结果 `gpt-6-astra / xhigh`。Claude 有效默认模型来自 settings.env 的 `ANTHROPIC_MODEL`（含 `[1M]` 后缀），不在当前已获取目录中；`ANTHROPIC_DEFAULT_OPUS_MODEL` 映射到相同值，因此只在隔离验收中选择 `opus`，没有修改用户配置、底层模型或 effort。该次真实请求仍被限流；不将其记为输出能力验收通过。

真实桌面使用独立标识 `app.u14.builder.validation-20261106-streaming`：首轮正文正常完成、思考摘要可手动展开；退出并重启后正文和思考摘要仍保留。恢复后的第二轮在生成期间出现自动展开的非空摘要；点击 Stop 后返回 idle、思考块收起，重新展开仍能看到停止前已收到的内容。独立后端 Stop 测试在首个正文增量到达后取消，返回 `aborted: true`，本次清理耗时约 6 ms。该时值是一次观测，不是新增性能门槛。

真实 Codex 验收发现并修复了两项 fixture 未充分模拟的差异：`thread/readState/changed` 等纯元数据通知，以及恢复响应后到达的历史 tokenUsage 快照。新增对应正式回归；恢复期只忽略同一已绑定 thread、尚未开始新 turn 的历史统计，正文、思考和跨 thread / turn 校验继续严格执行。

验收进程与本次独立应用已停止；隔离应用数据、缓存、WebKit 存储、临时 fixture 目录和本次测试拥有的原生会话均已清理。保留 debug 验收包作为本地构建产物；没有生成 Docker 镜像，也没有部署、发布或执行 git commit。

主代理负责共享契约、前端诊断、集成和真实验收；两个 Astra 分别实施 Codex 迁移与其他三种 provider 的内容核对，Sol 完成只读协议分析和收口复审，Terra 定位现有验收入口。最终只读复审未发现新的可证阻断问题。Claude、Pi 和 Antigravity 的环境限制按表中结果保留，不能由自动化通过替代。

## 页面刷新后的本地 CLI 重连

2026-11-06 的诊断 ID `4cb0051e-2944-4ad1-927c-fe630ce34edb` 对应 `runAlreadyActive / prepare / none`。原 Codex 任务在页面刷新后仍等待 Host 工具返回，前端运行状态却已重置；再次发送“请继续”因同会话已有任务被拒绝。用户确认发生过 App 刷新，本机原生记录也显示旧任务在两次继续请求前后持续等待。仅移除防重检查会允许多个任务修改同一项目，不能解决连接归属丢失。

本轮重连保留同一桌面后台进程内的原运行。它与向 CLI 的持久会话发送下一轮请求不同：页面重新加载后接管原运行，不重新发送原用户请求，也不重新启动模型轮次。整个桌面进程退出或崩溃后，内存中的事件记录与运行连接不可恢复；现有应用退出清理继续生效。

恢复遵循以下边界：

- 后台保存运行上下文、带序号的事件和工具结果，新页面先检查已有任务，再恢复同一会话、分支及 checkout 身份的运行。检查期间不能把后台状态当作空闲。
- 重放用于恢复正文、思考、工具消息和完成状态，不重新执行已确认完成的工具。后台已经结束、但前端尚未确认收到的终态也需要保留到确认完成。
- 尚未开始的工具可由新页面接管执行。每次执行前领取当前页面的运行租约；旧页面不能继续确认新页面的工具结果。
- 工具已经开始、但断连前没有确认结果时，不能区分“尚未产生副作用”与“已完成但确认丢失”。这种情况安全停止并报告结果未知，不自动重放写文件、MCP、图片或脚本操作。用户需先核对项目及外部操作结果。
- 恢复不会重新授予旧权限会话的一次性许可；技能、Design 合同与当前 Host 工具约束仍须验证。无法安全匹配的上下文应明确中止恢复，已有项目修改保留。
- 用户 Stop、主动切换会话或分支继续表示取消；页面刷新本身允许重连。恢复数据留在 Native 内存，不把权限许可或运行中的临时媒体写入普通会话存储。

页面生命周期回归入口：

```sh
PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test e2e/local-cli-reconnect.spec.ts
PLAYWRIGHT_BROWSER=webkit pnpm exec playwright test e2e/local-cli-reconnect.spec.ts
```

该测试使用真实浏览器重新加载页面，并让测试进程中的模拟桌面后台保持存活；它验证前端接管和呈现，不替代 Rust 工具桥接测试或真实 CLI 账号验收。其修复前失败点为刷新后停止按钮消失，初次运行及刷新前输出均正常。

### 重连验收记录

- Chrome 与 WebKit 各 **6 项通过**：连续两次刷新、接管后 Stop、离线排队工具唯一执行、已完成工具仅重放结果、页面关闭期间产生的终态、未确认副作用安全停止、发现阶段 Stop 后终态退休，以及已送达补充消息唯一恢复。六个用例分别组合这些断言。
- 前端全量 **231 套、1636 项通过**。存储读取与删除也加入保存顺序，覆盖立即 rehydrate、保存确认屏障和旧写不能覆盖清空结果。模拟页面重启的思考持久化测试等待旧实例清空写完成后再恢复磁盘快照，保留原有正文与思考断言。
- Rust 全量 **345 项通过、6 项显式手动测试忽略**；恢复模块 **4 项定向回归通过**。其中真实本机 HTTP Broker 请求跨旧 Channel 失效、新页面接管后完成，旧租约拒绝、同页接管幂等、重复结果去重和失败交付不误记成功都有检查。
- 类型检查、lint、桌面安全检查、格式与 diff 检查通过；Web 构建和 `pnpm exec tauri build --debug --no-bundle` 桌面 debug 构建通过。本轮没有新增构建体积门禁。
- 未向真实模型发送请求，未执行真实账户的桌面刷新验收，也未验证完整桌面进程退出后的连接恢复。浏览器模拟后台与原生 HTTP Broker 分别验证两侧接缝，不能视为真实 Codex 账户验收。

Vitest 保留 jsdom Canvas 未实现提示；构建输出混合静态/动态导入提示。WebKit 的项目归档操作出现 transient storage 警告，本轮的恢复、已确认文件保留与停止断言均通过；这组测试没有据此宣称项目归档功能通过完整验收。“结果未知”用例会故意输出对应错误日志，属于受测分支。

改动包含新的 Native IPC 与运行状态，需重新启动桌面开发进程或重新打包应用加载；只刷新仍使用旧 Native 二进制的窗口不会启用恢复。Sol 负责只读协议与竞态复审，Astra 负责跨层实现，主代理完成浏览器回归、持久化夹具调整、中英文文案、集成验证与本记录。未执行 git commit、部署或发布。

本轮浏览器、Vite 与 fixture 进程已退出，验收端口 5173 无监听；未生成 Docker 镜像。保留本地 debug 构建产物，未启动或替换用户已安装的应用。
