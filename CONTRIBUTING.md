# Contributing

English | 中文

Small, focused PRs are welcome.

Good first contributions:

- add sanitized Codex JSONL fixtures;
- improve redaction rules;
- improve handoff Markdown structure;
- test viewer behavior on macOS/Linux;
- improve bilingual UI copy.

Before opening a PR:

```powershell
node --check .\server.js
node --check .\viewer\app.js
node --check .\bin\codex-replay.js
```

Do not commit real Codex session logs, generated handoff files, local paths, tokens, or private project data.

---

欢迎小而清晰的 PR。

适合入门的贡献：

- 添加脱敏后的 Codex JSONL fixture；
- 改进脱敏规则；
- 改进 handoff Markdown 结构；
- 测试 macOS / Linux；
- 优化中英双语 UI 文案。

发 PR 前请运行：

```powershell
node --check .\server.js
node --check .\viewer\app.js
node --check .\bin\codex-replay.js
```

不要提交真实 Codex session 日志、生成的 handoff、本地路径、token 或私有项目数据。
