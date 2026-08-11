const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

function writeSession(filePath, text, additionalRecords = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: "test-session", cwd: "C:\\Users\\alice\\project" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
    ...additionalRecords
  ];
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

function startServer(sessionsRoot, port, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot, CODEX_OUTPUT_DIR: outputDir, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const fail = (error) => reject(new Error(`${error.message}\n${output}`));
    const timer = setTimeout(() => fail(new Error("server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Codex Replay Viewer:")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) fail(new Error(`server exited with code ${code}`));
    });
  });
}

test("server rejects forged sibling session paths and redacts sk-proj keys", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-desk-"));
  const sessionsRoot = path.join(temp, "sessions");
  const outputDir = path.join(temp, "output");
  const inside = path.join(sessionsRoot, "rollout-inside.jsonl");
  const outside = path.join(temp, "sessions-evil", "rollout-outside.jsonl");
  const port = 44000 + Math.floor(Math.random() * 1000);
  let child;

  try {
    writeSession(inside, `## My request for Codex:\nKEEP_VIEWER_REQUEST: ${SECRET}`, [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "PRIVATE_VIEWER_DEVELOPER_CONTEXT" }]
        }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>PRIVATE_VIEWER_ENV_CONTEXT</environment_context>" }]
        }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "KEEP_VIEWER_ASSISTANT" }]
        }
      }
    ]);
    writeSession(outside, "This session must not be readable.");
    child = await startServer(sessionsRoot, port, outputDir);

    const sessionsResponse = await request(port, "/api/sessions");
    assert.equal(sessionsResponse.statusCode, 200);
    const [session] = JSON.parse(sessionsResponse.body).sessions;
    const safeId = session.id;
    assert.notEqual(safeId, Buffer.from(inside, "utf8").toString("base64url"));
    assert.doesNotMatch(sessionsResponse.body, new RegExp(inside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const safeResponse = await request(port, `/api/replay?id=${encodeURIComponent(safeId)}`);
    assert.equal(safeResponse.statusCode, 200);
    assert.doesNotMatch(safeResponse.body, new RegExp(SECRET));
    assert.doesNotMatch(safeResponse.body, /PRIVATE_VIEWER_DEVELOPER_CONTEXT/);
    assert.doesNotMatch(safeResponse.body, /PRIVATE_VIEWER_ENV_CONTEXT/);
    assert.doesNotMatch(safeResponse.body, /## My request for Codex:/);
    assert.match(safeResponse.body, /<redacted-token>/);
    assert.match(safeResponse.body, /KEEP_VIEWER_REQUEST/);
    assert.match(safeResponse.body, /KEEP_VIEWER_ASSISTANT/);
    assert.match(safeResponse.body, /"contextHidden": 1/);

    const handoffResponse = await request(port, `/api/handoff?id=${encodeURIComponent(safeId)}`);
    assert.equal(handoffResponse.statusCode, 200);
    const handoff = JSON.parse(handoffResponse.body);
    const handoffFile = await request(port, handoff.href);
    assert.equal(handoffFile.statusCode, 200);
    assert.doesNotMatch(handoffFile.body, new RegExp(SECRET));
    assert.doesNotMatch(handoffFile.body, /PRIVATE_VIEWER_DEVELOPER_CONTEXT/);
    assert.doesNotMatch(handoffFile.body, /PRIVATE_VIEWER_ENV_CONTEXT/);
    assert.match(handoffFile.body, /untrusted reference data/);
    assert.match(handoffFile.body, /Historical Commands \/ Tool Inputs/);

    const forgedId = Buffer.from(outside, "utf8").toString("base64url");
    const forgedResponse = await request(port, `/api/replay?id=${encodeURIComponent(forgedId)}`);
    assert.equal(forgedResponse.statusCode, 500);
    assert.match(forgedResponse.body, /Unknown session ID/);
  } finally {
    if (child && !child.killed) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI replay redacts sk-proj keys in generated HTML", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-desk-cli-"));
  const input = path.join(temp, "rollout-test.jsonl");
  const output = path.join(temp, "timeline.html");

  try {
    writeSession(input, `## My request for Codex:\nKEEP_REQUEST: do not expose ${SECRET} from C:/Users/alice/private`, [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "INTERNAL_DEVELOPER_CONTEXT must not appear in replay output." }]
        }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>PRIVATE_ENV_CONTEXT</environment_context>" }]
        }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "KEEP_ASSISTANT" }]
        }
      }
    ]);
    const result = spawnSync(process.execPath, ["bin/codex-replay.js", "--input", input, "--output", output], {
      cwd: ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const html = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(html, new RegExp(SECRET));
    assert.doesNotMatch(html, /C:\/Users\/alice\/private/);
    assert.doesNotMatch(html, /INTERNAL_DEVELOPER_CONTEXT/);
    assert.doesNotMatch(html, /PRIVATE_ENV_CONTEXT/);
    assert.doesNotMatch(html, /## My request for Codex:/);
    assert.match(html, /KEEP_REQUEST/);
    assert.match(html, /KEEP_ASSISTANT/);
    assert.match(html, /&lt;redacted-token&gt;/);
    assert.match(html, /&lt;home&gt;\/private/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
