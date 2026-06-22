const state = {
  sessions: [],
  activeId: "",
  replay: null,
  filter: "",
  typeFilters: new Set(["user", "assistant", "tool-call", "error"]),
  selectedEvents: new Set()
};

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  latestBtn: document.getElementById("latestBtn"),
  exportBtn: document.getElementById("exportBtn"),
  handoffBtn: document.getElementById("handoffBtn"),
  selectVisibleBtn: document.getElementById("selectVisibleBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  typeFilterInputs: Array.from(document.querySelectorAll(".typeFilterInput")),
  filterInput: document.getElementById("filterInput"),
  sessionList: document.getElementById("sessionList"),
  sessionsMeta: document.getElementById("sessionsMeta"),
  sessionTitle: document.getElementById("sessionTitle"),
  sessionSubtitle: document.getElementById("sessionSubtitle"),
  timeline: document.getElementById("timeline"),
  metricEvents: document.getElementById("metricEvents"),
  metricUsers: document.getElementById("metricUsers"),
  metricTools: document.getElementById("metricTools"),
  metricErrors: document.getElementById("metricErrors"),
  riskPaths: document.getElementById("riskPaths"),
  riskTokens: document.getElementById("riskTokens"),
  riskEmails: document.getElementById("riskEmails"),
  riskHosts: document.getElementById("riskHosts"),
  metaShortId: document.getElementById("metaShortId"),
  metaStarted: document.getElementById("metaStarted"),
  metaModel: document.getElementById("metaModel"),
  metaCwd: document.getElementById("metaCwd"),
  metaSource: document.getElementById("metaSource"),
  metaUpdated: document.getElementById("metaUpdated"),
  handoffStatus: document.getElementById("handoffStatus"),
  exportStatus: document.getElementById("exportStatus")
};

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderSessions() {
  els.sessionList.innerHTML = state.sessions.map((session) => `
    <button class="session-item ${session.id === state.activeId ? "active" : ""}" data-id="${escapeHtml(session.id)}" type="button">
      <strong>${escapeHtml(session.title || session.name)}</strong>
      <span>Last active / 最后活跃: ${escapeHtml(fmtDate(session.mtime))}</span>
      <span>ID ${escapeHtml(session.shortId || "-")} · ${escapeHtml(fmtBytes(session.size))}</span>
    </button>
  `).join("");

  for (const button of els.sessionList.querySelectorAll(".session-item")) {
    button.addEventListener("click", () => loadReplay(button.dataset.id));
  }
}

function renderReplay() {
  const replay = state.replay;
  if (!replay) return;
  const counts = replay.counts || {};
  const risks = replay.risks || {};
  const meta = replay.meta || {};
  els.metricEvents.textContent = replay.totalEvents || replay.events?.length || 0;
  els.metricUsers.textContent = counts.user || 0;
  els.metricTools.textContent = counts.toolCalls || 0;
  els.metricErrors.textContent = counts.errors || 0;
  els.riskPaths.textContent = risks.localPaths || 0;
  els.riskTokens.textContent = risks.tokens || 0;
  els.riskEmails.textContent = risks.emails || 0;
  els.riskHosts.textContent = risks.hosts || 0;
  els.metaShortId.textContent = meta.shortId || "-";
  els.metaStarted.textContent = meta.startedAt || "-";
  els.metaModel.textContent = meta.model || "-";
  els.metaCwd.textContent = meta.cwd || "-";
  els.metaSource.textContent = meta.source || "-";
  els.metaUpdated.textContent = fmtDate(meta.lastWrite);
  els.sessionTitle.textContent = meta.title || "Codex session";
  els.sessionSubtitle.textContent = `Short ID ${meta.shortId || "-"} · Last active / 最后活跃 ${fmtDate(meta.lastWrite)}${replay.hiddenEvents ? ` · ${replay.hiddenEvents} hidden events` : ""}`;
  els.exportBtn.disabled = !state.activeId;
  els.handoffBtn.disabled = !state.activeId;
  els.selectVisibleBtn.disabled = !state.activeId;
  els.clearSelectionBtn.disabled = !state.activeId || state.selectedEvents.size === 0;
  if (state.activeId && !els.handoffStatus.innerHTML.includes("<a ")) {
    els.handoffStatus.textContent = state.selectedEvents.size
      ? `${state.selectedEvents.size} selected events will be used for the Markdown handoff.`
      : "No timeline cards selected. Handoff will use recent meaningful context. 未选择卡片时会使用最近有效上下文。";
  }

  const q = state.filter.trim().toLowerCase();
  const events = (replay.events || []).filter((event) => {
    if (["user", "assistant", "tool-call", "error"].includes(event.kind) && !state.typeFilters.has(event.kind)) {
      return false;
    }
    if (!q) return true;
    return `${event.kind} ${event.title} ${event.text} ${event.meta}`.toLowerCase().includes(q);
  });
  state.visibleEventIndexes = events.filter((event) => event.index > 0).map((event) => event.index);

  if (!events.length) {
    els.timeline.innerHTML = `<div class="empty">No timeline events match the current filter. 没有匹配当前筛选条件的事件。</div>`;
    return;
  }

  els.timeline.innerHTML = events.map((event) => `
    <article class="event ${escapeHtml(event.kind)}">
      <div class="dot"></div>
      <div class="event-card">
        <header>
          <label class="event-select">
            ${event.index > 0 ? `<input type="checkbox" data-event-index="${event.index}" ${state.selectedEvents.has(event.index) ? "checked" : ""} />` : ""}
            <strong>${escapeHtml(event.title)}</strong>
          </label>
          <small>${escapeHtml(event.time || `#${event.index}`)}</small>
        </header>
        ${event.meta ? `<div class="meta">${escapeHtml(event.meta)}</div>` : ""}
        <pre>${escapeHtml(event.text)}</pre>
      </div>
    </article>
  `).join("");

  for (const input of els.timeline.querySelectorAll("input[data-event-index]")) {
    input.addEventListener("change", () => {
      const index = Number(input.dataset.eventIndex);
      if (input.checked) state.selectedEvents.add(index);
      else state.selectedEvents.delete(index);
      renderReplay();
    });
  }
}

async function loadSessions(openLatest = true) {
  els.sessionsMeta.textContent = "Loading sessions... / 正在加载对话...";
  const data = await fetchJson("/api/sessions");
  state.sessions = data.sessions || [];
  els.sessionsMeta.textContent = `${state.sessions.length} conversations, sorted by last active time / ${state.sessions.length} 个对话，按最后活跃排序`;
  renderSessions();
  if (openLatest && state.sessions[0]) {
    await loadReplay(state.sessions[0].id);
  }
}

async function loadReplay(id) {
  state.activeId = id;
  state.selectedEvents.clear();
  els.handoffStatus.textContent = "No timeline cards selected. Handoff will use recent meaningful context. 未选择卡片时会使用最近有效上下文。";
  renderSessions();
  els.timeline.innerHTML = `<div class="empty">Loading replay... / 正在加载回放...</div>`;
  state.replay = await fetchJson(`/api/replay?id=${encodeURIComponent(id)}`);
  renderReplay();
}

async function exportCurrent() {
  if (!state.activeId) return;
  els.exportBtn.disabled = true;
  els.exportStatus.textContent = "Exporting static HTML... / 正在导出静态 HTML...";
  try {
    const data = await fetchJson(`/api/export?id=${encodeURIComponent(state.activeId)}`);
    els.exportStatus.innerHTML = `Exported / 已导出: <a href="${escapeHtml(data.href)}" target="_blank" rel="noreferrer">${escapeHtml(data.output)}</a>`;
  } catch (error) {
    els.exportStatus.textContent = `Export failed / 导出失败: ${error.message}`;
  } finally {
    els.exportBtn.disabled = false;
  }
}

async function generateHandoff() {
  if (!state.activeId) return;
  els.handoffBtn.disabled = true;
  const selected = [...state.selectedEvents].sort((a, b) => a - b);
  els.handoffStatus.textContent = selected.length
    ? `Generating Markdown handoff from ${selected.length} selected events... / 正在从 ${selected.length} 个选中事件生成接手卡...`
    : "Generating Markdown handoff from recent meaningful context... / 正在从最近有效上下文生成接手卡...";
  try {
    const params = new URLSearchParams({ id: state.activeId });
    if (selected.length) params.set("events", selected.join(","));
    const data = await fetchJson(`/api/handoff?${params.toString()}`);
    els.handoffStatus.innerHTML = `Generated / 已生成: <a href="${escapeHtml(data.href)}" target="_blank" rel="noreferrer">${escapeHtml(data.output)}</a>`;
  } catch (error) {
    els.handoffStatus.textContent = `Handoff failed / 接手卡生成失败: ${error.message}`;
  } finally {
    els.handoffBtn.disabled = false;
  }
}

function selectVisible() {
  for (const index of state.visibleEventIndexes || []) {
    state.selectedEvents.add(index);
  }
  renderReplay();
}

function clearSelection() {
  state.selectedEvents.clear();
  renderReplay();
}

els.refreshBtn.addEventListener("click", () => loadSessions(false));
els.latestBtn.addEventListener("click", () => {
  if (state.sessions[0]) loadReplay(state.sessions[0].id);
});
els.exportBtn.addEventListener("click", exportCurrent);
els.handoffBtn.addEventListener("click", generateHandoff);
els.selectVisibleBtn.addEventListener("click", selectVisible);
els.clearSelectionBtn.addEventListener("click", clearSelection);
els.filterInput.addEventListener("input", () => {
  state.filter = els.filterInput.value;
  renderReplay();
});
for (const input of els.typeFilterInputs) {
  input.addEventListener("change", () => {
    if (input.checked) state.typeFilters.add(input.value);
    else state.typeFilters.delete(input.value);
    renderReplay();
  });
}

loadSessions(true).catch((error) => {
  els.sessionsMeta.textContent = `Failed to load sessions / 加载失败: ${error.message}`;
  els.timeline.innerHTML = `<div class="empty">Failed to load viewer data. Viewer 数据加载失败。</div>`;
});
