#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const DEFAULT_LIMIT = 180;
const OUTPUT_DIR = path.join(process.cwd(), "output");
const DEFAULT_OUTPUT = path.join(OUTPUT_DIR, "timeline.html");

function parseArgs(argv) {
  const args = {
    latest: false,
    input: "",
    output: DEFAULT_OUTPUT,
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
    limit: DEFAULT_LIMIT,
    includeToolOutput: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--latest") args.latest = true;
    else if (arg === "--input") args.input = argv[++i] || "";
    else if (arg === "--output") args.output = path.resolve(argv[++i] || DEFAULT_OUTPUT);
    else if (arg === "--sessions-root") args.sessionsRoot = path.resolve(argv[++i] || args.sessionsRoot);
    else if (arg === "--limit") args.limit = Math.max(20, Number(argv[++i]) || DEFAULT_LIMIT);
    else if (arg === "--include-tool-output") args.includeToolOutput = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) args.latest = true;
  return args;
}

function printHelp() {
  console.log(`Codex Replay

Usage:
  node ./bin/codex-replay.js --latest
  node ./bin/codex-replay.js --input C:\\path\\to\\rollout.jsonl

Options:
  --latest                     Use the newest rollout-*.jsonl under ~/.codex/sessions
  --input <path>               Input JSONL file
  --output <path>              Output HTML path, default output/timeline.html
  --sessions-root <path>       Sessions root, default ~/.codex/sessions
  --limit <n>                  Max timeline events to render, default ${DEFAULT_LIMIT}
  --include-tool-output        Include non-error tool output snippets
`);
}

function walkJsonlFiles(root) {
  const stack = [root];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Ignore files that disappear while scanning.
        }
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function latestSession(root) {
  const [latest] = walkJsonlFiles(root);
  if (!latest) throw new Error(`No rollout-*.jsonl files found under ${root}`);
  return latest.path;
}

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content != null) return textFromContent(content.content);
    if (typeof content.output === "string") return content.output;
  }
  return "";
}

function oneLine(text, limit = 160) {
  const clean = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function redact(text) {
  let out = String(text ?? "");
  const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(new RegExp(home, "gi"), "<home>");
  out = out.replace(/C:\\+Users\\+[^\\\s`"']+/gi, "<home>");
  out = out.replace(/\/Users\/[^\/\s`"']+/g, "<home>");
  out = out.replace(/\/home\/[^\/\s`"']+/g, "<home>");
  out = out.replace(/\b(?:ghp|github_pat|sk|xoxb|xoxp|hf)[_-][A-Za-z0-9_=-]{16,}\b/g, "<redacted-token>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer <redacted-token>");
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>");
  out = out.replace(/\b(?:[A-Za-z0-9-]+\.)*(?:internal|corp|lan|local|invalid|example)\b(?:\.[A-Za-z0-9-]+)*/gi, "<redacted-host>");
  return out;
}

function eventTime(record, payload) {
  return payload?.timestamp || payload?.started_at || payload?.completed_at || record.timestamp || "";
}

function classifyToolOutput(text) {
  if (/(error|exception|failed|fatal|traceback|denied|unauthorized|not recognized|cannot find|context_length_exceeded|compact)/i.test(text)) {
    return "error";
  }
  return "tool-output";
}

function eventTitle(kind, payload = {}) {
  if (kind === "task-started") return "Task started";
  if (kind === "task-complete") return "Task complete";
  if (kind === "tool-call") return `Tool call: ${payload.name || "tool"}`;
  if (kind === "tool-output") return "Tool output";
  if (kind === "error") return "Error-like output";
  if (kind === "assistant") return "Assistant";
  if (kind === "user") return "User";
  if (kind === "developer") return "Developer";
  if (kind === "final") return "Final answer";
  return kind;
}

function addEvent(events, event) {
  if (!event.text && !event.title) return;
  events.push({
    index: events.length + 1,
    time: event.time || "",
    kind: event.kind,
    title: event.title || eventTitle(event.kind, event),
    text: redact(event.text || ""),
    meta: redact(event.meta || "")
  });
}

async function parseSession(inputPath, options) {
  const events = [];
  const meta = {
    id: "",
    timestamp: "",
    cwd: "",
    model: "",
    originator: "",
    source: inputPath,
    lastWrite: fs.statSync(inputPath).mtime,
    size: fs.statSync(inputPath).size
  };
  const counts = {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    errors: 0,
    lifecycle: 0
  };

  const stream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload || {};

    if (record.type === "session_meta") {
      meta.id = payload.id || record.id || meta.id;
      meta.timestamp = payload.timestamp || record.timestamp || meta.timestamp;
      meta.cwd = payload.cwd || record.cwd || meta.cwd;
      meta.model = payload.model || record.model || meta.model;
      meta.originator = payload.originator || record.originator || meta.originator;
      continue;
    }

    if (record.type === "turn_context") {
      meta.cwd = payload.cwd || record.cwd || meta.cwd;
      continue;
    }

    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        counts.lifecycle += 1;
        addEvent(events, {
          kind: "task-started",
          time: eventTime(record, payload),
          text: `Turn ${payload.turn_id || "(unknown)"} started.`
        });
      } else if (payload.type === "task_complete") {
        counts.lifecycle += 1;
        addEvent(events, {
          kind: "task-complete",
          time: eventTime(record, payload),
          text: `Turn ${payload.turn_id || "(unknown)"} completed${payload.duration_ms ? ` in ${Math.round(payload.duration_ms / 1000)}s` : ""}.`
        });
      } else if (payload.type === "agent_message" && payload.phase === "final_answer") {
        addEvent(events, {
          kind: "final",
          time: eventTime(record, payload),
          text: oneLine(payload.message || payload.text || "", 1200)
        });
      }
      continue;
    }

    if (record.type !== "response_item") continue;
    if (payload.type === "reasoning") continue;

    if (payload.type === "message") {
      const role = payload.role || "message";
      if (!["user", "assistant", "developer"].includes(role)) continue;
      const text = textFromContent(payload.content);
      if (!text.trim()) continue;
      counts[role] = (counts[role] || 0) + 1;
      addEvent(events, {
        kind: role,
        time: eventTime(record, payload),
        text: oneLine(text, role === "assistant" ? 2200 : 1600)
      });
      continue;
    }

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      counts.toolCalls += 1;
      const rawArgs = payload.arguments ?? payload.input ?? "";
      const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      addEvent(events, {
        kind: "tool-call",
        time: eventTime(record, payload),
        title: `Tool call: ${payload.name || payload.type}`,
        text: oneLine(args, 900),
        meta: payload.call_id || payload.id || ""
      });
      continue;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const text = textFromContent(payload.output ?? payload.content);
      const kind = classifyToolOutput(text);
      if (kind === "error") counts.errors += 1;
      if (kind === "error" || options.includeToolOutput) {
        addEvent(events, {
          kind,
          time: eventTime(record, payload),
          text: oneLine(text, kind === "error" ? 1400 : 700),
          meta: payload.call_id || payload.id || ""
        });
      }
    }
  }

  return { meta, counts, events };
}

function compactEvents(events, limit) {
  if (events.length <= limit) return { skipped: 0, events };
  const keepHead = Math.min(20, Math.floor(limit * 0.2));
  const keepTail = limit - keepHead;
  return {
    skipped: events.length - limit,
    events: [
      ...events.slice(0, keepHead),
      {
        index: 0,
        time: "",
        kind: "gap",
        title: "Timeline compacted",
        text: `${events.length - limit} middle events hidden. Re-run with --limit ${events.length} to render everything.`,
        meta: ""
      },
      ...events.slice(-keepTail)
    ]
  };
}

function renderHtml(result, options, inputPath) {
  const { meta, counts } = result;
  const compacted = compactEvents(result.events, options.limit);
  const safeMeta = {
    id: redact(meta.id || "(no id)"),
    timestamp: redact(meta.timestamp || ""),
    cwd: redact(meta.cwd || ""),
    model: redact(meta.model || ""),
    originator: redact(meta.originator || ""),
    source: redact(inputPath),
    generated: new Date().toISOString(),
    lastWrite: meta.lastWrite.toISOString(),
    sizeMb: (meta.size / 1024 / 1024).toFixed(2)
  };

  const cards = compacted.events.map((event) => `
    <article class="event ${escapeHtml(event.kind)}">
      <div class="rail"><span></span></div>
      <div class="card">
        <header>
          <strong>${escapeHtml(event.title)}</strong>
          <small>${escapeHtml(event.time || `#${event.index || ""}`)}</small>
        </header>
        ${event.meta ? `<p class="meta">${escapeHtml(event.meta)}</p>` : ""}
        <pre>${escapeHtml(event.text)}</pre>
      </div>
    </article>
  `).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Replay</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --ink: #1d2430;
      --muted: #657084;
      --line: #d8d4c8;
      --card: #ffffff;
      --user: #2d6cdf;
      --assistant: #10845f;
      --tool: #9a5a00;
      --error: #c33b3b;
      --final: #6f42c1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .hero { display: grid; grid-template-columns: 1.35fr .9fr; gap: 24px; align-items: start; margin-bottom: 28px; }
    h1 { margin: 0 0 10px; font-size: clamp(32px, 4vw, 56px); line-height: .98; letter-spacing: 0; }
    .subtitle { margin: 0; color: var(--muted); max-width: 760px; font-size: 16px; }
    .panel, .card {
      background: var(--card);
      border: 1px solid rgba(29, 36, 48, .1);
      border-radius: 8px;
      box-shadow: 0 10px 26px rgba(32, 28, 20, .06);
    }
    .panel { padding: 18px; }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .stat { padding: 12px; border: 1px solid rgba(29,36,48,.08); border-radius: 6px; background: #fbfaf7; }
    .stat b { display: block; font-size: 24px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .meta-grid { display: grid; grid-template-columns: 140px 1fr; gap: 7px 12px; margin-top: 18px; font-size: 13px; }
    .meta-grid dt { color: var(--muted); }
    .meta-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .notice { margin: 18px 0 0; padding: 12px 14px; border-left: 4px solid var(--tool); background: #fff7e8; color: #5b3b00; border-radius: 6px; }
    .timeline { margin-top: 24px; }
    .event { display: grid; grid-template-columns: 28px 1fr; gap: 12px; }
    .rail { display: flex; justify-content: center; position: relative; }
    .rail:before { content: ""; position: absolute; top: 0; bottom: 0; width: 2px; background: var(--line); }
    .rail span { width: 14px; height: 14px; margin-top: 22px; border-radius: 50%; background: var(--muted); border: 3px solid var(--bg); z-index: 1; }
    .event.user .rail span { background: var(--user); }
    .event.assistant .rail span { background: var(--assistant); }
    .event.final .rail span { background: var(--final); }
    .event.tool-call .rail span, .event.tool-output .rail span { background: var(--tool); }
    .event.error .rail span { background: var(--error); }
    .event.gap .rail span { background: #6b7280; }
    .card { margin: 0 0 14px; padding: 16px; overflow: hidden; }
    .card header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 10px; }
    .card strong { font-size: 15px; }
    .card small { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; white-space: nowrap; }
    .card .meta { margin: -2px 0 10px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12.5px;
    }
    .event.error .card { border-color: rgba(195,59,59,.3); background: #fffafa; }
    .event.gap .card { background: #f0eee8; color: #4b5563; }
    footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 1120px); padding-top: 20px; }
      .hero { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .meta-grid { grid-template-columns: 1fr; gap: 2px; }
      .card header { display: block; }
      .card small { display: block; margin-top: 4px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>Codex Replay</h1>
        <p class="subtitle">A sanitized timeline generated from a local Codex session JSONL. Review before sharing publicly.</p>
        <div class="notice">Privacy boundary: common local paths, token-like strings, emails, and private-looking hosts were redacted. This is not a complete secret scanner.</div>
      </div>
      <aside class="panel">
        <div class="stats">
          <div class="stat"><b>${counts.user}</b><span>User turns</span></div>
          <div class="stat"><b>${counts.assistant}</b><span>Assistant turns</span></div>
          <div class="stat"><b>${counts.toolCalls}</b><span>Tool calls</span></div>
          <div class="stat"><b>${counts.errors}</b><span>Error-like outputs</span></div>
        </div>
        <dl class="meta-grid">
          <dt>Session</dt><dd>${escapeHtml(safeMeta.id)}</dd>
          <dt>Model</dt><dd>${escapeHtml(safeMeta.model || "(unknown)")}</dd>
          <dt>CWD</dt><dd>${escapeHtml(safeMeta.cwd || "(unknown)")}</dd>
          <dt>Source</dt><dd>${escapeHtml(safeMeta.source)}</dd>
          <dt>Last write</dt><dd>${escapeHtml(safeMeta.lastWrite)}</dd>
          <dt>Size</dt><dd>${escapeHtml(safeMeta.sizeMb)} MB</dd>
        </dl>
      </aside>
    </section>
    <section class="timeline">
      ${cards}
    </section>
    <footer>
      Generated ${escapeHtml(safeMeta.generated)}. Rendered ${compacted.events.length} events${compacted.skipped ? `, with ${compacted.skipped} hidden by --limit` : ""}.
    </footer>
  </main>
</body>
</html>
`;
}

async function main() {
  const options = parseArgs(process.argv);
  const inputPath = path.resolve(options.input || latestSession(options.sessionsRoot));
  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const result = await parseSession(inputPath, options);
  const html = renderHtml(result, options, inputPath);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, html, "utf8");
  console.log(`Input: ${inputPath}`);
  console.log(`Output: ${options.output}`);
  console.log(`Events parsed: ${result.events.length}`);
  console.log(`User turns: ${result.counts.user}`);
  console.log(`Assistant turns: ${result.counts.assistant}`);
  console.log(`Tool calls: ${result.counts.toolCalls}`);
  console.log(`Error-like outputs: ${result.counts.errors}`);
}

main().catch((error) => {
  console.error(`codex-replay: ${error.message}`);
  process.exit(1);
});
