const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

function writeSession(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: "test-session", cwd: "C:\\Users\\alice\\project" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }
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

function startServer(sessionsRoot, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, CODEX_SESSIONS_ROOT: sessionsRoot, PORT: String(port) },
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
  const inside = path.join(sessionsRoot, "rollout-inside.jsonl");
  const outside = path.join(temp, "sessions-evil", "rollout-outside.jsonl");
  const port = 44000 + Math.floor(Math.random() * 1000);
  let child;

  try {
    writeSession(inside, `Keep this secret private: ${SECRET}`);
    writeSession(outside, "This session must not be readable.");
    child = await startServer(sessionsRoot, port);

    const safeId = Buffer.from(inside, "utf8").toString("base64url");
    const safeResponse = await request(port, `/api/replay?id=${encodeURIComponent(safeId)}`);
    assert.equal(safeResponse.statusCode, 200);
    assert.doesNotMatch(safeResponse.body, new RegExp(SECRET));
    assert.match(safeResponse.body, /<redacted-token>/);

    const forgedId = Buffer.from(outside, "utf8").toString("base64url");
    const forgedResponse = await request(port, `/api/replay?id=${encodeURIComponent(forgedId)}`);
    assert.equal(forgedResponse.statusCode, 500);
    assert.match(forgedResponse.body, /outside sessions root/);
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
    writeSession(input, `Do not expose ${SECRET}`);
    const result = spawnSync(process.execPath, ["bin/codex-replay.js", "--input", input, "--output", output], {
      cwd: ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const html = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(html, new RegExp(SECRET));
    assert.match(html, /&lt;redacted-token&gt;/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
