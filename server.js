const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 4317);
const HOST = "127.0.0.1";
const ROOT = __dirname;
const VIEWER_DIR = path.join(ROOT, "viewer");
const OUTPUT_DIR = path.join(ROOT, "output");
const SESSIONS_ROOT = process.env.CODEX_SESSIONS_ROOT || path.join(os.homedir(), ".codex", "sessions");
const MAX_EVENTS = 240;

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function idForPath(filePath) {
  return Buffer.from(filePath, "utf8").toString("base64url");
}

function pathForId(id) {
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  const resolved = path.resolve(decoded);
  const root = path.resolve(SESSIONS_ROOT);
  if (!resolved.startsWith(root)) {
    throw new Error("Session path is outside sessions root");
  }
  return resolved;
}

function walkSessions(root) {
  const stack = [root];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
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
          files.push({ path: full, id: idForPath(full), name: entry.name, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore transient files.
        }
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
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

function oneLine(text, limit = 900) {
  const clean = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

function compactTitle(text) {
  return oneLine(String(text || "").replace(/^#+\s*/g, ""), 86) || "Untitled Codex session";
}

function cleanUserText(text) {
  let t = String(text || "").trim();
  const requestMarker = "## My request for Codex:";
  const markerIndex = t.indexOf(requestMarker);
  if (markerIndex >= 0) {
    t = t.slice(markerIndex + requestMarker.length).trim();
  }
  t = t.replace(/<image\b[\s\S]*?<\/image>/gi, "").trim();
  t = t.replace(/^# Files mentioned by the user:[\s\S]*?(?=\n\S|\n*$)/i, "").trim();
  return t || String(text || "").trim();
}

function isNoiseUserText(text) {
  const t = cleanUserText(text);
  if (!t) return true;
  if (t.startsWith("# AGENTS.md instructions")) return true;
  if (t.startsWith("<environment_context>")) return true;
  if (t.startsWith("<developer_context>")) return true;
  if (t.includes("<INSTRUCTIONS>") && t.length > 1200) return true;
  if (t.includes("Default response mode:") && t.includes("Preferred style:") && t.length > 1200) return true;
  return false;
}

function shortSessionId(filePath, fallback = "") {
  const name = path.basename(filePath);
  const match = name.match(/(019[a-z0-9-]{20,})/i);
  return (match ? match[1] : fallback || name).slice(0, 8);
}

function startedFromName(filePath) {
  const match = path.basename(filePath).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${match[1]} ${match[2]}:${match[3]}:${match[4]}`;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(text) {
  let out = String(text ?? "");
  out = out.replace(new RegExp(escapeRegex(os.homedir()), "gi"), "<home>");
  out = out.replace(/C:\\+Users\\+[^\\\s`"']+/gi, "<home>");
  out = out.replace(/[A-Z]:\/Users\/[^\/\s`"']+/gi, "<home>");
  out = out.replace(/\/Users\/[^\/\s`"']+/g, "<home>");
  out = out.replace(/\/home\/[^\/\s`"']+/g, "<home>");
  out = out.replace(/\b(?:ghp|github_pat|sk|xoxb|xoxp|hf)[_-][A-Za-z0-9_=-]{16,}\b/g, "<redacted-token>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer <redacted-token>");
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>");
  out = out.replace(/\b(?:[A-Za-z0-9-]+\.)*(?:internal|corp|lan|local|invalid|example)\b(?:\.[A-Za-z0-9-]+)*/gi, "<redacted-host>");
  return out;
}

function detectRawRisks(line, risks) {
  if (/C:\\+Users\\+|\/Users\/|\/home\//i.test(line)) risks.localPaths += 1;
  if (/\b(?:ghp|github_pat|sk|xoxb|xoxp|hf)[_-][A-Za-z0-9_=-]{16,}\b/.test(line) || /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(line)) risks.tokens += 1;
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(line)) risks.emails += 1;
  if (/\b(?:[A-Za-z0-9-]+\.)*(?:internal|corp|lan|local)\b(?:\.[A-Za-z0-9-]+)*/i.test(line)) risks.hosts += 1;
}

function readFileSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeSession(filePath, stat) {
  const headLength = Math.min(stat.size, 256 * 1024);
  const tailLength = Math.min(stat.size, 2 * 1024 * 1024);
  const head = readFileSlice(filePath, 0, headLength);
  const tail = readFileSlice(filePath, Math.max(0, stat.size - tailLength), tailLength);
  const lines = `${head}\n${tail}`.split(/\r?\n/);
  const summary = {
    title: "",
    lastUser: "",
    lastAssistant: "",
    model: "",
    cwd: "",
    sessionId: "",
    shortId: shortSessionId(filePath),
    startedAt: startedFromName(filePath)
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload || {};
    if (record.type === "session_meta") {
      summary.sessionId = payload.id || record.id || summary.sessionId;
      summary.model = payload.model || record.model || summary.model;
      summary.cwd = redact(payload.cwd || record.cwd || summary.cwd);
      summary.shortId = shortSessionId(filePath, summary.sessionId);
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message") continue;
    const role = payload.role || "";
    const text = textFromContent(payload.content);
    if (role === "user" && !isNoiseUserText(text)) {
      summary.lastUser = cleanUserText(text);
      summary.title = compactTitle(summary.lastUser);
    } else if (role === "assistant" && text.trim()) {
      summary.lastAssistant = text;
      if (!summary.title) summary.title = compactTitle(text);
    }
  }

  if (!summary.title) summary.title = `Codex session ${summary.shortId}`;
  return summary;
}

function classifyOutput(text) {
  return /(error|exception|failed|fatal|traceback|denied|unauthorized|not recognized|cannot find|context_length_exceeded|compact)/i.test(text)
    ? "error"
    : "tool-output";
}

function pushUnique(list, value, limit = 40) {
  const clean = redact(String(value || "").trim());
  if (!clean || list.includes(clean)) return;
  list.push(clean);
  if (list.length > limit) list.shift();
}

function extractPaths(text) {
  const value = String(text || "");
  const matches = [
    ...value.matchAll(/[A-Z]:[\\/][^\s`"')\]}]+/g),
    ...value.matchAll(/(?:~|\/Users\/[^\/\s`"']+|\/home\/[^\/\s`"']+|\/[A-Za-z0-9._-]+)\/[^\s`"')\]}]+/g)
  ];
  return matches.map((match) => match[0]);
}

function extractCommand(rawArgs) {
  if (!rawArgs) return "";
  if (typeof rawArgs === "object") {
    return rawArgs.command || rawArgs.cmd || rawArgs.script || JSON.stringify(rawArgs);
  }
  const text = String(rawArgs);
  try {
    const parsed = JSON.parse(text);
    return parsed.command || parsed.cmd || parsed.script || text;
  } catch {
    return text;
  }
}

function mdEscape(text) {
  return redact(String(text || "").replace(/\r/g, "").trim());
}

function mdBullet(items, fallback = "- None captured.", limit = 420) {
  if (!items.length) return fallback;
  return items.map((item) => `- ${mdEscape(oneLine(item, limit))}`).join("\n");
}

function mdFence(text, lang = "text") {
  const body = mdEscape(text || "").replace(/```/g, "'''");
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

async function collectHandoff(filePath, selectedIndices = []) {
  const selectedSet = new Set(selectedIndices.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0));
  const hasSelection = selectedSet.size > 0;
  let logicalIndex = 0;
  function includeNextEvent() {
    logicalIndex += 1;
    return !hasSelection || selectedSet.has(logicalIndex);
  }

  const stat = fs.statSync(filePath);
  const meta = {
    id: "",
    title: "",
    shortId: shortSessionId(filePath),
    startedAt: startedFromName(filePath),
    lastWrite: stat.mtime.toISOString(),
    model: "",
    cwd: "",
    source: redact(filePath)
  };
  const handoff = {
    currentGoal: "",
    recentUserRequests: [],
    recentAssistantNotes: [],
    files: [],
    commands: [],
    errors: [],
    toolNames: [],
    risks: { localPaths: 0, tokens: 0, emails: 0, hosts: 0 },
    contextHidden: 0
  };

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    detectRawRisks(line, handoff.risks);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload || {};
    if (record.type === "session_meta") {
      meta.id = payload.id || record.id || meta.id;
      meta.shortId = shortSessionId(filePath, meta.id);
      meta.model = payload.model || record.model || meta.model;
      meta.cwd = redact(payload.cwd || record.cwd || meta.cwd);
      continue;
    }
    if (record.type === "turn_context") {
      meta.cwd = redact(payload.cwd || record.cwd || meta.cwd);
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "task_started" || payload.type === "task_complete") {
        includeNextEvent();
      } else if (payload.type === "agent_message" && payload.phase === "final_answer") {
        if (includeNextEvent()) pushUnique(handoff.recentAssistantNotes, payload.message || payload.text || "", 8);
      }
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message") {
      const role = payload.role || "";
      const text = textFromContent(payload.content);
      if (role === "user") {
        if (isNoiseUserText(text)) {
          handoff.contextHidden += 1;
          continue;
        }
        if (!includeNextEvent()) continue;
        const clean = cleanUserText(text);
        for (const p of extractPaths(clean)) pushUnique(handoff.files, p, 80);
        handoff.currentGoal = clean;
        pushUnique(handoff.recentUserRequests, clean, 10);
      } else if (role === "assistant" && text.trim()) {
        if (!includeNextEvent()) continue;
        for (const p of extractPaths(text)) pushUnique(handoff.files, p, 80);
        pushUnique(handoff.recentAssistantNotes, text, 8);
      }
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      if (!includeNextEvent()) continue;
      pushUnique(handoff.toolNames, payload.name || payload.type, 30);
      const cmd = extractCommand(payload.arguments ?? payload.input ?? "");
      if (cmd) pushUnique(handoff.commands, cmd, 50);
      for (const p of extractPaths(cmd)) pushUnique(handoff.files, p, 80);
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const out = textFromContent(payload.output ?? payload.content);
      if (classifyOutput(out) === "error") {
        if (!includeNextEvent()) continue;
        for (const p of extractPaths(out)) pushUnique(handoff.files, p, 80);
        pushUnique(handoff.errors, out, 20);
      }
    }
  }

  meta.title = compactTitle(handoff.currentGoal || handoff.recentAssistantNotes[handoff.recentAssistantNotes.length - 1] || meta.id || path.basename(filePath));
  return { meta, handoff, selection: { enabled: hasSelection, count: selectedSet.size } };
}

function renderHandoffMarkdown(data) {
  const { meta, handoff, selection } = data;
  const continuePrompt = [
    "You are continuing a Codex task from a generated handoff.",
    "",
    `Primary goal: ${mdEscape(oneLine(handoff.currentGoal || meta.title, 1200))}`,
    "",
    "Before making changes:",
    "1. Read this handoff fully.",
    "2. Verify the current workspace state before trusting stale session details.",
    "3. Preserve unrelated user changes.",
    "4. Continue from the listed next-step context rather than restarting from scratch.",
    "",
    "Important context:",
    `- Session short ID: ${meta.shortId}`,
    `- Workspace/CWD: ${meta.cwd || "(unknown)"}`,
    `- Last active: ${meta.lastWrite}`,
    "",
    "Start by stating the current objective and the first concrete next action. Do not replay the old conversation."
  ].join("\n");

  return `# Codex Handoff: ${mdEscape(meta.title)}

> Purpose: paste this file into a new Codex conversation, or share it with another Codex operator, to continue a long or stuck task. This is a compact task card, not a transcript replay.

## Session Identity

- Short ID: \`${mdEscape(meta.shortId)}\`
- Session ID: \`${mdEscape(meta.id || "(unknown)")}\`
- Started: \`${mdEscape(meta.startedAt || "(unknown)")}\`
- Last active: \`${mdEscape(meta.lastWrite)}\`
- Model: \`${mdEscape(meta.model || "(unknown)")}\`
- CWD: \`${mdEscape(meta.cwd || "(unknown)")}\`
- Source JSONL: \`${mdEscape(meta.source)}\`
- Scope: \`${selection.enabled ? `${selection.count} selected timeline events` : "recent meaningful session context"}\`

## Current Goal

${mdFence(handoff.currentGoal || meta.title)}

## User Intent / Selected Requests

${mdBullet(handoff.recentUserRequests, "- No selected user request captured.", 520)}

## Prior Assistant State

${mdBullet(handoff.recentAssistantNotes, "- No selected assistant state captured.", 520)}

## Working Artifacts

${mdBullet(handoff.files, "- No file/path references captured.", 260)}

## Commands / Tool Inputs To Reuse Or Verify

${mdBullet(handoff.commands, "- No command/tool inputs captured.", 360)}

## Blockers / Error-Like Evidence

${mdBullet(handoff.errors, "- No error-like output captured.", 420)}

## Suggested Next Action

- Verify the current workspace state and whether the files/commands above still apply.
- Continue from **Current Goal** and **Prior Assistant State**.
- If this handoff was generated from selected events, trust only the selected scope and ask for more context if needed.
- Avoid changing unrelated files or reverting user edits.

## Privacy Scan

- Local path patterns in raw session: ${handoff.risks.localPaths}
- Token-like patterns in raw session: ${handoff.risks.tokens}
- Email-like patterns in raw session: ${handoff.risks.emails}
- Private-host patterns in raw session: ${handoff.risks.hosts}
- Hidden context wrapper messages: ${handoff.contextHidden}

Review this handoff before public sharing. Redaction is best-effort, not a full secret scanner.

## Continue Prompt

${mdFence(continuePrompt)}
`;
}

async function writeHandoff(filePath, selectedIndices = []) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const data = await collectHandoff(filePath, selectedIndices);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(OUTPUT_DIR, `handoff-${data.meta.shortId}-${stamp}.md`);
  fs.writeFileSync(out, renderHandoffMarkdown(data), "utf8");
  return out;
}

function addEvent(events, counts, event) {
  if (!event.text && !event.title) return;
  const item = {
    index: events.length + 1,
    kind: event.kind,
    title: event.title || event.kind,
    time: event.time || "",
    text: redact(event.text || ""),
    meta: redact(event.meta || "")
  };
  events.push(item);
  if (item.kind === "user") counts.user += 1;
  if (item.kind === "assistant") counts.assistant += 1;
  if (item.kind === "tool-call") counts.toolCalls += 1;
  if (item.kind === "error") counts.errors += 1;
  if (item.kind === "task-started" || item.kind === "task-complete") counts.lifecycle += 1;
}

function eventTime(record, payload) {
  return payload?.timestamp || payload?.started_at || payload?.completed_at || record.timestamp || "";
}

async function parseSession(filePath) {
  const stat = fs.statSync(filePath);
  const meta = {
    id: "",
    model: "",
    cwd: "",
    originator: "",
    source: redact(filePath),
    size: stat.size,
    lastWrite: stat.mtime.toISOString()
  };
  const counts = { user: 0, assistant: 0, toolCalls: 0, errors: 0, lifecycle: 0 };
  counts.contextHidden = 0;
  const risks = { localPaths: 0, tokens: 0, emails: 0, hosts: 0 };
  const events = [];
  let lastMeaningfulUser = "";
  let lastAssistant = "";

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    detectRawRisks(line, risks);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload || {};

    if (record.type === "session_meta") {
      meta.id = payload.id || record.id || meta.id;
      meta.model = payload.model || record.model || meta.model;
      meta.cwd = redact(payload.cwd || record.cwd || meta.cwd);
      meta.originator = payload.originator || record.originator || meta.originator;
      continue;
    }
    if (record.type === "turn_context") {
      meta.cwd = redact(payload.cwd || record.cwd || meta.cwd);
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        addEvent(events, counts, { kind: "task-started", title: "Task started", time: eventTime(record, payload), text: `Turn ${payload.turn_id || "(unknown)"} started.` });
      } else if (payload.type === "task_complete") {
        addEvent(events, counts, { kind: "task-complete", title: "Task complete", time: eventTime(record, payload), text: `Turn ${payload.turn_id || "(unknown)"} completed${payload.duration_ms ? ` in ${Math.round(payload.duration_ms / 1000)}s` : ""}.` });
      } else if (payload.type === "agent_message" && payload.phase === "final_answer") {
        addEvent(events, counts, { kind: "final", title: "Final answer", time: eventTime(record, payload), text: oneLine(payload.message || payload.text || "", 1400) });
      }
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "reasoning") continue;
    if (payload.type === "message") {
      const role = payload.role || "message";
      if (!["user", "assistant"].includes(role)) continue;
      const text = textFromContent(payload.content);
      if (role === "user" && isNoiseUserText(text)) {
        counts.contextHidden += 1;
        continue;
      }
      const displayText = role === "user" ? cleanUserText(text) : text;
      if (role === "user") lastMeaningfulUser = displayText;
      if (role === "assistant") lastAssistant = text;
      addEvent(events, counts, { kind: role, title: role === "user" ? "User" : "Assistant", time: eventTime(record, payload), text: oneLine(displayText, role === "assistant" ? 1800 : 1200) });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const rawArgs = payload.arguments ?? payload.input ?? "";
      const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      addEvent(events, counts, { kind: "tool-call", title: `Tool: ${payload.name || payload.type}`, time: eventTime(record, payload), text: oneLine(args, 800), meta: payload.call_id || payload.id || "" });
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const text = textFromContent(payload.output ?? payload.content);
      const kind = classifyOutput(text);
      if (kind === "error") {
        addEvent(events, counts, { kind: "error", title: "Error-like output", time: eventTime(record, payload), text: oneLine(text, 1200), meta: payload.call_id || payload.id || "" });
      }
    }
  }

  meta.title = compactTitle(lastMeaningfulUser || lastAssistant || meta.id || path.basename(filePath));
  meta.shortId = shortSessionId(filePath, meta.id);
  meta.startedAt = startedFromName(filePath);

  let displayEvents = events;
  let hidden = 0;
  if (events.length > MAX_EVENTS) {
    const head = events.slice(0, 24);
    const tail = events.slice(-(MAX_EVENTS - 25));
    hidden = events.length - head.length - tail.length;
    displayEvents = [
      ...head,
      { index: 0, kind: "gap", title: "Timeline compacted", time: "", text: `${hidden} middle events hidden in viewer. Export HTML can render from the CLI with a higher --limit.`, meta: "" },
      ...tail
    ];
  }

  return { meta, counts, risks, totalEvents: events.length, hiddenEvents: hidden, events: displayEvents };
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const resolved = path.resolve(VIEWER_DIR, file);
  if (!resolved.startsWith(VIEWER_DIR)) return notFound(res);
  fs.readFile(resolved, (error, data) => {
    if (error) return notFound(res);
    const ext = path.extname(resolved);
    const type = ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(data);
  });
}

function exportHtml(filePath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const out = path.join(OUTPUT_DIR, `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "codex-replay.js"), "--input", filePath, "--output", out, "--limit", "360"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(stderr || `export failed with code ${code}`));
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === "/api/sessions") {
      const sessions = walkSessions(SESSIONS_ROOT).slice(0, 36).map((item) => {
        const stat = { size: item.size };
        const summary = summarizeSession(item.path, stat);
        return {
          id: item.id,
          title: summary.title,
          lastUser: redact(oneLine(summary.lastUser, 160)),
          shortId: summary.shortId,
          startedAt: summary.startedAt,
          name: item.name,
          size: item.size,
          mtime: item.mtime,
          path: redact(item.path),
          model: summary.model,
          cwd: summary.cwd
        };
      });
      return json(res, 200, { sessionsRoot: redact(SESSIONS_ROOT), sessions });
    }
    if (url.pathname === "/api/replay") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "missing id" });
      return json(res, 200, await parseSession(pathForId(id)));
    }
    if (url.pathname === "/api/export") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "missing id" });
      const out = await exportHtml(pathForId(id));
      return json(res, 200, { output: redact(out), href: `/output/${encodeURIComponent(path.basename(out))}` });
    }
    if (url.pathname === "/api/handoff") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "missing id" });
      const events = (url.searchParams.get("events") || "")
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0);
      const out = await writeHandoff(pathForId(id), events);
      return json(res, 200, { output: redact(out), href: `/output/${encodeURIComponent(path.basename(out))}` });
    }
    if (url.pathname.startsWith("/output/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.slice("/output/".length)));
      const resolved = path.resolve(OUTPUT_DIR, fileName);
      if (!resolved.startsWith(OUTPUT_DIR)) return notFound(res);
      fs.readFile(resolved, (error, data) => {
        if (error) return notFound(res);
        const type = path.extname(resolved).toLowerCase() === ".md" ? "text/markdown" : "text/html";
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
        res.end(data);
      });
      return;
    }
    return notFound(res);
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/") || req.url.startsWith("/output/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Replay Viewer: http://${HOST}:${PORT}/`);
  console.log(`Sessions root: ${SESSIONS_ROOT}`);
});
