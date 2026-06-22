# Codex Handoff Desk

English | [中文](#中文)

Find long Codex sessions, select the useful slice, and generate a compact Markdown handoff that a fresh Codex conversation can continue from.

This project is for the moment when a long agent task gets stuck, compacted, split across windows, or too large to inspect manually.

## Core Idea

Raw Codex session JSONL is useful but hard to hand off. Codex Handoff Desk turns it into:

- human-readable session titles instead of rollout file names;
- selectable timeline cards for user, assistant, tool, and error events;
- type filters, for example user-only or error-only handoffs;
- compact Markdown task cards for new Codex chats;
- privacy-risk counts before sharing logs publicly;
- optional HTML replay export for evidence review.

The main output is not the HTML replay. The main output is:

```text
output/handoff-*.md
```

Paste that Markdown into a new Codex conversation to continue the task.

## Quick Start

```powershell
git clone https://github.com/latencyong-design/codex-handoff-desk.git
cd codex-handoff-desk
npm run viewer
```

Open:

```text
http://127.0.0.1:4317/
```

No npm dependencies are required. Node.js 18+ is enough.

## Workflow

1. Pick a Codex session from the left sidebar.
2. Use text search and event-type filters.
3. Select the timeline cards that matter.
4. Click `Generate Handoff`.
5. Paste the generated Markdown into a new Codex chat.

If nothing is selected, the viewer uses recent meaningful context from the session.

## CLI

The visual viewer is the primary workflow. A small CLI is also included for static HTML replay export:

```powershell
npm run latest
node .\bin\codex-replay.js --input "C:\path\to\rollout.jsonl"
node .\bin\codex-replay.js --output ".\output\my-replay.html" --limit 220
```

## Privacy Boundary

Codex Handoff Desk redacts common local home paths, token-like strings, emails, and private-looking hosts. It also reports raw privacy-risk counts.

It is not a complete secret scanner. Review generated handoffs before posting them publicly.

## Status

Early local-first prototype. Issues and small PRs are welcome, especially around:

- better Codex JSONL compatibility;
- better handoff summarization;
- safer redaction rules;
- UI improvements;
- macOS/Linux validation.

---

## 中文

查找很长的 Codex 对话，筛选真正有用的片段，然后生成一份新的 Codex 对话可以继续读取的 Markdown 接手卡。

这个项目解决的是：长任务卡住、上下文丢失、窗口太多、自动压缩后难以继续的问题。

## 核心思路

Codex 原始 JSONL 很有价值，但不适合直接发给新对话或其他人接手。Codex Handoff Desk 会把它变成：

- 可读的对话标题，而不是 rollout 文件名；
- 可勾选的 user / assistant / tool / error 时间线卡片；
- 快速类型筛选，例如只导出用户内容、只查看错误；
- 适合发给新 Codex 的 Markdown 接手卡；
- 分享前的隐私风险计数；
- 可选的 HTML replay，用于证据复盘。

最重要的输出不是 HTML，而是：

```text
output/handoff-*.md
```

把这个 Markdown 粘贴到新的 Codex 对话，就可以继续任务。

## 快速开始

```powershell
git clone https://github.com/latencyong-design/codex-handoff-desk.git
cd codex-handoff-desk
npm run viewer
```

打开：

```text
http://127.0.0.1:4317/
```

项目没有 npm 依赖，只需要 Node.js 18+。

## 使用流程

1. 左侧选择一个 Codex session。
2. 用关键词和事件类型筛选。
3. 勾选真正需要交接的 timeline 卡片。
4. 点击 `Generate Handoff / 生成接手卡`。
5. 把生成的 Markdown 发给新的 Codex 对话。

如果没有勾选任何卡片，工具会使用最近的有效上下文生成 handoff。

## 命令行

可视化 viewer 是主要入口。项目也保留了一个小 CLI，用于导出静态 HTML replay：

```powershell
npm run latest
node .\bin\codex-replay.js --input "C:\path\to\rollout.jsonl"
node .\bin\codex-replay.js --output ".\output\my-replay.html" --limit 220
```

## 隐私边界

工具会脱敏常见本地 home 路径、token-like 字符串、邮箱和内部主机名，并显示原始日志里的隐私风险计数。

它不是完整的 secret scanner。公开分享前仍然需要人工检查生成的 handoff。

## 项目状态

早期本地优先原型。欢迎 issue 和小 PR，尤其是：

- 更好的 Codex JSONL 兼容；
- 更好的 handoff 摘要；
- 更安全的脱敏规则；
- UI 优化；
- macOS / Linux 验证。
