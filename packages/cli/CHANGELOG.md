# CLI release notes

## 0.1.0 — 2026-11-08

Initial local-install release of the Open Builder headless tools. The desktop application keeps its existing version.

- Initialize native React/TypeScript/Vite or static HTML/CSS/JavaScript projects in new directories.
- Add bundled Linear, Stripe, or Notion visual references without replacing existing design files.
- Check project source and semantic tokens, with explicit scan omissions and unperformed checks.
- Run existing build, typecheck, lint, or test scripts through installed npm/pnpm, with redacted diagnostics, timeout, cancellation, and process cleanup.
- Expose the same operations through local stdio MCP in a fixed workspace. Script verification requires an explicit startup capability and the host's approval policy.
- Distribute a separate portable workflow Skill archive generated from the eight existing application Skills.

No automatic dependency installation, model orchestration, browser preview, remote MCP, deployment, or public registry publishing is included. macOS and Linux container runtime checks passed locally; Windows runtime and authenticated Claude Code model acceptance remain pending. See the repository's `docs/headless-acceptance.md` for the evidence and limits.

### 中文说明

首个本地可安装版本，提供原生模板初始化、设计文件新增、静态检查、固定项目脚本验证及本地 stdio MCP。主 Skill 独立打包，参考内容从现有八个 Skill 生成。桌面应用版本保持原有契约。

不自动安装依赖、不覆盖设计文件、不提供模型编排、浏览器预览、远程 MCP 或部署。macOS 与 Linux 容器已完成本地运行验收；Windows 实测及 Claude Code 登录后的模型驱动验收仍待完成。实际证据与限制见仓库验收记录。
