/* ===================================================================
   Схема-дашборд — холст с нодами
   =================================================================== */

const COLORS = ["#6366f1", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899"];

const DEFAULT_W = 220;
const DEFAULT_ROOT_W = 250;
const DEFAULT_MIN_H = 68;
const MAX_AUTO_W = 560;
const MIN_SCALE = 0.01;
const MAX_SCALE = 2.5;

const state = {
  nodes: new Map(),          // id -> node data
  zones: new Map(),          // id -> zone data
  links: new Map(),          // id -> {id, from_id, to_id}
  users: [],                 // all accounts, for attaching members
  view: { x: 0, y: 0, scale: 1 },
  selection: new Set(),      // multi-selected node ids
  selectedId: null,          // primary selected node (drives the editor)
  selectedZoneId: null,
  saveTimers: new Map(),
  zoneSaveTimers: new Map(),
  mode: "select",            // "select" | "zone" | "link"
  search: "",
};

// DOM refs
const wrap = document.getElementById("canvas-wrap");
const canvas = document.getElementById("canvas");
const nodesLayer = document.getElementById("nodes-layer");
const zonesLayer = document.getElementById("zones-layer");
const edgesSvg = document.getElementById("edges");
const zoomBadge = document.getElementById("zoom-badge");
const toast = document.getElementById("toast");
const selectBoxEl = document.getElementById("select-box");
const zoneDraftEl = document.getElementById("zone-draft");
const multiToolbar = document.getElementById("multi-toolbar");
const multiCount = document.getElementById("multi-count");
const searchInput = document.getElementById("search-input");
const zoneModeBtn = document.getElementById("zone-mode-btn");
const linkModeBtn = document.getElementById("link-mode-btn");

const editor = document.getElementById("editor");
const editTitle = document.getElementById("edit-title");
const editContent = document.getElementById("edit-content");
const editorMeta = document.getElementById("editor-meta");
const paletteEl = document.getElementById("palette");
const editColor = document.getElementById("edit-color");
const editWidth = document.getElementById("edit-width");
const editHeight = document.getElementById("edit-height");
const memberSelect = document.getElementById("member-select");
const membersEl = document.getElementById("members");
const filesEl = document.getElementById("files");
const fileInput = document.getElementById("file-input");

const zoneEditor = document.getElementById("zone-editor");
const zoneTitleInput = document.getElementById("zone-title");
const zoneColorInput = document.getElementById("zone-color");
const zoneEditorMeta = document.getElementById("zone-editor-meta");

/* ------------------------- Helpers ------------------------- */
// Is the colour light enough to need dark text on it?
function isLightColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}
function initials(name) {
  return (name || "?").trim().slice(0, 2);
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
// Plain text with **bold** markers -> safely escaped HTML with <b>.
function renderContentHtml(content) {
  return escapeHtml(content).replace(/\*\*([^\n*][^*]*?)\*\*/g, "<b>$1</b>");
}
function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " Б";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / 1024 / 1024).toFixed(1) + " МБ";
}

// Measure title text so wide titles stretch the tile automatically.
const measureCanvas = document.createElement("canvas");
const measureCtx = measureCanvas.getContext("2d");
function measureTitleWidth(title) {
  measureCtx.font = "650 15px Inter, 'Segoe UI', system-ui, sans-serif";
  return measureCtx.measureText(title || "").width;
}
function nodeWidth(n) {
  if (n.width) return n.width;
  const base = n.is_root ? DEFAULT_ROOT_W : DEFAULT_W;
  const needed = measureTitleWidth(n.title) + 56; // padding + badge/plus clearance
  return Math.max(base, Math.min(MAX_AUTO_W, needed));
}

/* ------------------------- API ------------------------- */
async function api(method, url, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = "/login"; return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

/* ------------------------- Toast ------------------------- */
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

/* ------------------------- View transform ------------------------- */
function applyView() {
  const { x, y, scale } = state.view;
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  zoomBadge.textContent = Math.round(scale * 1000) / 10 + "%";
}

// screen coords -> canvas (world) coords
function toWorld(clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.scale,
    y: (clientY - rect.top - state.view.y) / state.view.scale,
  };
}

/* ------------------------- Rendering: nodes ------------------------- */
function renderNode(n) {
  let el = document.getElementById("node-" + n.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "node";
    el.id = "node-" + n.id;
    el.dataset.id = n.id;

    const badge = document.createElement("div");
    badge.className = "node-badge";
    const title = document.createElement("div");
    title.className = "node-title";
    const body = document.createElement("div");
    body.className = "node-body";
    const members = document.createElement("div");
    members.className = "node-members";
    const plus = document.createElement("button");
    plus.className = "node-plus";
    plus.textContent = "+";
    plus.title = "Добавить дочернюю ноду";
    const resize = document.createElement("div");
    resize.className = "node-resize";
    resize.title = "Растянуть";

    el.append(badge, title, body, members, plus, resize);
    nodesLayer.appendChild(el);

    attachNodeHandlers(el, plus, resize, title);
  }

  el.classList.toggle("root", n.is_root);
  el.classList.toggle("light", isLightColor(n.color));
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  el.style.setProperty("--node-color", n.color);
  el.style.width = nodeWidth(n) + "px";
  // Height is a *minimum*: the node still grows to fit its text.
  el.style.minHeight = (n.height || DEFAULT_MIN_H) + "px";

  const nodeMembersEl = el.querySelector(".node-members");
  nodeMembersEl.innerHTML = "";
  (n.members || []).forEach((u) => {
    const a = document.createElement("span");
    a.className = "avatar";
    a.textContent = initials(u.username);
    a.title = u.username;
    nodeMembersEl.appendChild(a);
  });

  el.querySelector(".node-badge").textContent = n.is_root ? "МАТЕРИНСКАЯ" : "";
  el.querySelector(".node-badge").style.display = n.is_root ? "inline-block" : "none";
  el.querySelector(".node-title").textContent = n.title || "Без названия";
  el.querySelector(".node-body").innerHTML = renderContentHtml(n.content || "");

  refreshOneSelectionClass(el, n.id);
}

function refreshOneSelectionClass(el, id) {
  el.classList.toggle("selected", state.selection.has(id) && state.selection.size === 1);
  el.classList.toggle("multi-selected", state.selection.has(id) && state.selection.size > 1);
}

function nodeCenter(n) {
  const el = document.getElementById("node-" + n.id);
  const w = el ? el.offsetWidth : nodeWidth(n);
  const h = el ? el.offsetHeight : (n.height || DEFAULT_MIN_H);
  return { x: n.x + w / 2, y: n.y + h / 2 };
}
function nodeRect(n) {
  const c = nodeCenter(n);
  const el = document.getElementById("node-" + n.id);
  const w = el ? el.offsetWidth : nodeWidth(n);
  const h = el ? el.offsetHeight : (n.height || DEFAULT_MIN_H);
  return { cx: c.x, cy: c.y, halfW: w / 2, halfH: h / 2 };
}

// Point where the straight line from (cx,cy) toward (tx,ty) exits the rectangle.
function borderPoint(cx, cy, halfW, halfH, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(scaleX, scaleY);
  return { x: cx + dx * s, y: cy + dy * s };
}

function drawEdge(a, b, color, isLink, linkId) {
  const ra = nodeRect(a), rb = nodeRect(b);
  const start = borderPoint(ra.cx, ra.cy, ra.halfW, ra.halfH, rb.cx, rb.cy);
  const end = borderPoint(rb.cx, rb.cy, rb.halfW, rb.halfH, ra.cx, ra.cy);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", isLink ? "edge edge-link" : "edge");
  path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-opacity", isLink ? "0.7" : "0.55");
  if (isLink) {
    path.setAttribute("stroke-dasharray", "6 4");
    path.style.pointerEvents = "stroke";
    path.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("Удалить связь между нодами?")) deleteLink(linkId);
    });
  }
  edgesSvg.appendChild(path);
}

function renderEdges() {
  edgesSvg.innerHTML = "";
  for (const n of state.nodes.values()) {
    if (n.parent_id == null) continue;
    const parent = state.nodes.get(n.parent_id);
    if (!parent) continue;
    drawEdge(parent, n, n.color, false);
  }
  for (const l of state.links.values()) {
    const a = state.nodes.get(l.from_id), b = state.nodes.get(l.to_id);
    if (!a || !b) continue;
    drawEdge(a, b, "#9aa0be", true, l.id);
  }
}

function renderAll() {
  for (const n of state.nodes.values()) renderNode(n);
  renderEdges();
}

/* ------------------------- Rendering: zones ------------------------- */
function renderZone(z) {
  let el = document.getElementById("zone-" + z.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "zone";
    el.id = "zone-" + z.id;
    el.dataset.id = z.id;
    const header = document.createElement("div");
    header.className = "zone-header";
    const label = document.createElement("span");
    label.className = "zone-label";
    header.appendChild(label);
    const resize = document.createElement("div");
    resize.className = "zone-resize";
    resize.title = "Растянуть зону";
    el.append(header, resize);
    zonesLayer.appendChild(el);
    attachZoneHandlers(el, header, resize);
  }
  el.classList.toggle("selected", state.selectedZoneId === z.id);
  el.style.left = z.x + "px";
  el.style.top = z.y + "px";
  el.style.width = z.width + "px";
  el.style.height = z.height + "px";
  el.style.setProperty("--zone-color", z.color);
  el.querySelector(".zone-label").textContent = z.title || "Зона";
}
function renderZones() {
  for (const z of state.zones.values()) renderZone(z);
}

function zoneContainsPoint(z, x, y) {
  return x >= z.x && x <= z.x + z.width && y >= z.y && y <= z.y + z.height;
}
function assignZoneForNode(n) {
  const r = nodeRect(n);
  let found = null;
  for (const z of state.zones.values()) {
    if (zoneContainsPoint(z, r.cx, r.cy)) { found = z.id; break; }
  }
  n.zone_id = found;
}
function reassignAllZones() {
  for (const n of state.nodes.values()) {
    const before = n.zone_id;
    assignZoneForNode(n);
    if (n.zone_id !== before) scheduleSave(n.id, { zone_id: n.zone_id });
  }
}

/* ------------------------- Node interactions ------------------------- */
let linkFrom = null;

function attachNodeHandlers(el, plus, resize, titleEl) {
  let drag = null;
  let rs = null;

  // --- resize via corner handle
  resize.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const id = Number(el.dataset.id);
    selectOnly(id);
    rs = { startX: e.clientX, startY: e.clientY, origW: el.offsetWidth, origH: el.offsetHeight };
    resize.setPointerCapture(e.pointerId);
    el.classList.add("resizing");
  });
  resize.addEventListener("pointermove", (e) => {
    if (!rs) return;
    const id = Number(el.dataset.id);
    const n = state.nodes.get(id);
    const dw = (e.clientX - rs.startX) / state.view.scale;
    const dh = (e.clientY - rs.startY) / state.view.scale;
    n.width = Math.round(Math.max(120, Math.min(2000, rs.origW + dw)));
    n.height = Math.round(Math.max(60, Math.min(2000, rs.origH + dh)));
    el.style.width = n.width + "px";
    el.style.minHeight = n.height + "px";
    renderEdges();
  });
  resize.addEventListener("pointerup", (e) => {
    if (!rs) return;
    const id = Number(el.dataset.id);
    const n = state.nodes.get(id);
    el.classList.remove("resizing");
    resize.releasePointerCapture(e.pointerId);
    rs = null;
    if (state.selectedId === id) fillSizeInputs(n);
    scheduleSave(id, { width: n.width, height: n.height });
  });

  // --- click straight on the title: select + jump into rename mode
  titleEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  titleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = Number(el.dataset.id);
    selectOnly(id);
    openEditor();
    requestAnimationFrame(() => { editTitle.focus(); editTitle.select(); });
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.target === plus || e.target === resize) return;
    e.stopPropagation();
    const id = Number(el.dataset.id);

    if (state.mode === "link") {
      handleLinkClick(id);
      return;
    }

    if (e.shiftKey) {
      toggleSelect(id);
    } else if (!state.selection.has(id)) {
      selectOnly(id);
    }

    const dragIds = state.selection.has(id) && state.selection.size > 1 ? [...state.selection] : [id];
    const origins = new Map(dragIds.map((nid) => {
      const nn = state.nodes.get(nid);
      return [nid, { x: nn.x, y: nn.y }];
    }));
    drag = { startX: e.clientX, startY: e.clientY, ids: dragIds, origins, moved: false, shift: e.shiftKey };
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / state.view.scale;
    const dy = (e.clientY - drag.startY) / state.view.scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    drag.ids.forEach((nid) => {
      const nn = state.nodes.get(nid);
      const orig = drag.origins.get(nid);
      nn.x = orig.x + dx;
      nn.y = orig.y + dy;
      const nel = document.getElementById("node-" + nid);
      if (nel) { nel.style.left = nn.x + "px"; nel.style.top = nn.y + "px"; }
    });
    renderEdges();
  });

  el.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const id = Number(el.dataset.id);
    el.classList.remove("dragging");
    el.releasePointerCapture(e.pointerId);
    if (drag.moved) {
      drag.ids.forEach((nid) => {
        const nn = state.nodes.get(nid);
        assignZoneForNode(nn);
        renderNode(nn);
        scheduleSave(nid, { x: nn.x, y: nn.y, zone_id: nn.zone_id });
      });
      renderEdges();
    } else if (!drag.shift) {
      selectOnly(id);
      openEditor();
    }
    drag = null;
  });

  plus.addEventListener("click", (e) => {
    e.stopPropagation();
    createChild(Number(el.dataset.id));
  });
}

function handleLinkClick(id) {
  if (linkFrom == null) {
    linkFrom = id;
    document.getElementById("node-" + id)?.classList.add("link-source");
    showToast("Выберите вторую ноду для связи");
  } else if (linkFrom === id) {
    document.getElementById("node-" + id)?.classList.remove("link-source");
    linkFrom = null;
  } else {
    const from = linkFrom;
    document.getElementById("node-" + from)?.classList.remove("link-source");
    linkFrom = null;
    createLink(from, id);
    setMode("select");
  }
}
async function createLink(fromId, toId) {
  try {
    const data = await api("POST", "/api/links", { from_id: fromId, to_id: toId });
    state.links.set(data.link.id, data.link);
    renderEdges();
    showToast("Ноды связаны");
  } catch (err) { showToast(err.message); }
}
async function deleteLink(id) {
  try {
    await api("DELETE", `/api/links/${id}`);
    state.links.delete(id);
    renderEdges();
    showToast("Связь удалена");
  } catch (err) { showToast(err.message); }
}

/* ------------------------- Selection ------------------------- */
function refreshSelectionClasses() {
  document.querySelectorAll(".node.selected, .node.multi-selected").forEach((el) => {
    el.classList.remove("selected", "multi-selected");
  });
  state.selection.forEach((id) => {
    const el = document.getElementById("node-" + id);
    if (!el) return;
    el.classList.add(state.selection.size > 1 ? "multi-selected" : "selected");
  });
}
function updateMultiToolbar() {
  const n = state.selection.size;
  multiToolbar.hidden = n <= 1;
  if (n > 1) multiCount.textContent = `Выделено нод: ${n}`;
}
function selectOnly(id) {
  state.selection.clear();
  state.selection.add(id);
  state.selectedId = id;
  refreshSelectionClasses();
  updateMultiToolbar();
  if (state.selectedZoneId != null) closeZoneEditor();
  if (editor.classList.contains("open")) fillEditor(id);
}
function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);

  if (state.selection.size === 1) {
    state.selectedId = [...state.selection][0];
  } else if (!state.selection.has(state.selectedId)) {
    state.selectedId = null;
  }
  refreshSelectionClasses();
  updateMultiToolbar();
  if (state.selection.size === 1 && editor.classList.contains("open")) {
    fillEditor(state.selectedId);
  } else if (state.selection.size !== 1) {
    closeEditor();
  }
}
function clearSelection() {
  state.selection.clear();
  state.selectedId = null;
  refreshSelectionClasses();
  updateMultiToolbar();
  closeEditor();
}

/* ------------------------- Editor ------------------------- */
function fillEditor(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  editTitle.value = n.title;
  editContent.value = n.content;
  editorMeta.textContent = n.is_root ? "Материнская нода • ID " + n.id : "ID " + n.id;
  const rootCount = [...state.nodes.values()].filter((x) => x.is_root).length;
  document.getElementById("delete-node").style.display = (n.is_root && rootCount <= 1) ? "none" : "block";
  [...paletteEl.children].forEach((s) => s.classList.toggle("active", s.dataset.color === n.color));
  editColor.value = n.color;
  fillSizeInputs(n);
  fillMembers(n);
  fillFiles(n);
}

function fillSizeInputs(n) {
  editWidth.value = Math.round(nodeWidth(n));
  editHeight.value = n.height ? Math.round(n.height) : "";
}

function fillFiles(n) {
  filesEl.innerHTML = "";
  (n.files || []).forEach((f) => {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    const link = document.createElement("a");
    link.href = f.url;
    link.textContent = f.filename;
    link.target = "_blank";
    link.rel = "noopener";
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatSize(f.size);
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "Удалить файл";
    rm.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/files/${f.id}`);
        n.files = (n.files || []).filter((x) => x.id !== f.id);
        fillFiles(n);
        showToast("Файл удалён");
      } catch (err) { showToast(err.message); }
    });
    chip.append(link, size, rm);
    filesEl.appendChild(chip);
  });
}

fileInput.addEventListener("change", async () => {
  if (state.selectedId == null || !fileInput.files.length) return;
  const n = state.nodes.get(state.selectedId);
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  try {
    const res = await fetch(`/api/nodes/${n.id}/files`, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка загрузки");
    n.files = [...(n.files || []), data.file];
    fillFiles(n);
    showToast("Файл прикреплён");
  } catch (err) {
    showToast(err.message);
  }
  fileInput.value = "";
});

function fillMembers(n) {
  const assigned = new Set((n.members || []).map((u) => u.id));
  membersEl.innerHTML = "";
  (n.members || []).forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "member-chip";
    const a = document.createElement("span");
    a.className = "avatar";
    a.textContent = initials(u.username);
    const name = document.createElement("span");
    name.textContent = u.username;
    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.title = "Убрать";
    rm.addEventListener("click", () => {
      n.members = n.members.filter((m) => m.id !== u.id);
      renderNode(n);
      renderEdges();
      fillMembers(n);
      scheduleSave(n.id, { members: n.members.map((m) => m.id) });
    });
    chip.append(a, name, rm);
    membersEl.appendChild(chip);
  });
  // dropdown lists only users not yet attached
  memberSelect.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "+ добавить пользователя…";
  memberSelect.appendChild(ph);
  state.users.filter((u) => !assigned.has(u.id)).forEach((u) => {
    const o = document.createElement("option");
    o.value = u.id;
    o.textContent = u.username;
    memberSelect.appendChild(o);
  });
}

memberSelect.addEventListener("change", () => {
  if (state.selectedId == null || !memberSelect.value) return;
  const n = state.nodes.get(state.selectedId);
  const u = state.users.find((x) => x.id === Number(memberSelect.value));
  if (!u) return;
  n.members = [...(n.members || []), u];
  renderNode(n);
  renderEdges();
  fillMembers(n);
  scheduleSave(n.id, { members: n.members.map((m) => m.id) });
  showToast(u.username + " добавлен");
});

function applyColor(c) {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  n.color = c;
  renderNode(n);
  renderEdges();
  [...paletteEl.children].forEach((x) => x.classList.toggle("active", x.dataset.color === c));
  editColor.value = c;
  scheduleSave(n.id, { color: c });
}
editColor.addEventListener("input", () => applyColor(editColor.value));

function applySizeFromInputs() {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  const w = parseFloat(editWidth.value);
  const h = parseFloat(editHeight.value);
  n.width = isFinite(w) ? Math.max(120, Math.min(2000, w)) : null;
  n.height = isFinite(h) ? Math.max(60, Math.min(2000, h)) : null;
  renderNode(n);
  renderEdges();
  scheduleSave(n.id, { width: n.width, height: n.height });
}
editWidth.addEventListener("change", applySizeFromInputs);
editHeight.addEventListener("change", applySizeFromInputs);
document.getElementById("reset-size").addEventListener("click", () => {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  n.width = null;
  n.height = null;
  renderNode(n);
  renderEdges();
  fillSizeInputs(n);
  scheduleSave(n.id, { width: null, height: null });
});

function openEditor() {
  if (state.selectedId == null) return;
  fillEditor(state.selectedId);
  editor.classList.add("open");
}
function closeEditor() { editor.classList.remove("open"); }

function buildPalette() {
  COLORS.forEach((c) => {
    const s = document.createElement("div");
    s.className = "swatch";
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener("click", () => applyColor(c));
    paletteEl.appendChild(s);
  });
}

editTitle.addEventListener("focus", () => editTitle.select());
editTitle.addEventListener("input", () => {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  n.title = editTitle.value;
  renderNode(n);
  renderEdges();
  scheduleSave(n.id, { title: n.title });
});
editContent.addEventListener("input", () => {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  n.content = editContent.value;
  renderNode(n);
  renderEdges();
  scheduleSave(n.id, { content: n.content });
});
editContent.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    document.getElementById("fmt-bold").click();
  }
});
document.getElementById("fmt-bold").addEventListener("click", () => {
  if (state.selectedId == null) return;
  const start = editContent.selectionStart, end = editContent.selectionEnd;
  const val = editContent.value;
  const selected = val.slice(start, end);
  let newVal, newStart, newEnd;
  if (selected.startsWith("**") && selected.endsWith("**") && selected.length >= 4) {
    const inner = selected.slice(2, -2);
    newVal = val.slice(0, start) + inner + val.slice(end);
    newStart = start; newEnd = start + inner.length;
  } else {
    newVal = val.slice(0, start) + "**" + selected + "**" + val.slice(end);
    newStart = start + 2; newEnd = end + 2;
  }
  editContent.value = newVal;
  editContent.focus();
  editContent.setSelectionRange(newStart, newEnd);
  const n = state.nodes.get(state.selectedId);
  n.content = newVal;
  renderNode(n);
  renderEdges();
  scheduleSave(n.id, { content: n.content });
});
document.getElementById("close-editor").addEventListener("click", closeEditor);

/* ------------------------- Save (debounced) ------------------------- */
function scheduleSave(id, patch) {
  const pending = state.saveTimers.get(id) || { patch: {}, timer: null };
  Object.assign(pending.patch, patch);
  clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    const body = pending.patch;
    state.saveTimers.delete(id);
    try {
      await api("PUT", `/api/nodes/${id}`, body);
    } catch (err) {
      showToast("Ошибка сохранения");
    }
  }, 450);
  state.saveTimers.set(id, pending);
}
function scheduleSaveZone(id, patch) {
  const pending = state.zoneSaveTimers.get(id) || { patch: {}, timer: null };
  Object.assign(pending.patch, patch);
  clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    const body = pending.patch;
    state.zoneSaveTimers.delete(id);
    try {
      await api("PUT", `/api/zones/${id}`, body);
    } catch (err) {
      showToast("Ошибка сохранения зоны");
    }
  }, 450);
  state.zoneSaveTimers.set(id, pending);
}

/* ------------------------- Create / delete: nodes ------------------------- */
function computeChildSpawnPos(parent) {
  const pw = nodeWidth(parent);
  const gap = pw / 2 + 130;
  const siblingCount = [...state.nodes.values()].filter((n) => n.parent_id === parent.id).length;
  const rung = Math.ceil((siblingCount + 1) / 2);
  const dir = siblingCount % 2 === 0 ? -1 : 1;
  return { x: parent.x + gap, y: parent.y + dir * rung * 80 };
}

async function createChild(parentId) {
  const parent = state.nodes.get(parentId);
  const pos = computeChildSpawnPos(parent);
  try {
    const data = await api("POST", "/api/nodes", {
      parent_id: parentId,
      title: "Новая нода",
      content: "",
      x: pos.x,
      y: pos.y,
      color: parent.color,
    });
    const n = data.node;
    state.nodes.set(n.id, n);
    assignZoneForNode(n);
    renderNode(n);
    renderEdges();
    selectOnly(n.id);
    openEditor();
    editTitle.focus();
    editTitle.select();
    showToast("Нода создана");
  } catch (err) {
    showToast(err.message);
  }
}

async function createRoot() {
  const rect = wrap.getBoundingClientRect();
  const center = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  try {
    const data = await api("POST", "/api/nodes", {
      parent_id: null,
      is_root: true,
      title: "Новая материнская нода",
      content: "",
      x: center.x - DEFAULT_ROOT_W / 2,
      y: center.y,
      color: "#8b5cf6",
    });
    const n = data.node;
    state.nodes.set(n.id, n);
    renderNode(n);
    renderEdges();
    selectOnly(n.id);
    openEditor();
    editTitle.focus();
    editTitle.select();
    showToast("Материнская нода создана");
  } catch (err) {
    showToast(err.message);
  }
}
document.getElementById("add-root-btn").addEventListener("click", createRoot);

document.getElementById("add-child").addEventListener("click", () => {
  if (state.selectedId != null) createChild(state.selectedId);
});

document.getElementById("delete-node").addEventListener("click", async () => {
  if (state.selectedId == null) return;
  const n = state.nodes.get(state.selectedId);
  if (!confirm(`Удалить ноду «${n.title}» и все дочерние?`)) return;
  try {
    await api("DELETE", `/api/nodes/${n.id}`);
    const toRemove = collectDescendants(n.id);
    toRemove.forEach((id) => {
      state.nodes.delete(id);
      document.getElementById("node-" + id)?.remove();
    });
    state.selection.delete(n.id);
    state.selectedId = null;
    closeEditor();
    renderEdges();
    showToast("Удалено");
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById("export-branch").addEventListener("click", () => {
  if (state.selectedId != null) exportBranch(state.selectedId);
});
async function exportBranch(id) {
  try {
    const res = await fetch(`/api/nodes/${id}/export`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка экспорта");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `node-${id}-branch.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Ветка экспортирована");
  } catch (err) {
    showToast(err.message);
  }
}

function collectDescendants(id) {
  const result = [id];
  for (const n of state.nodes.values()) {
    if (n.parent_id === id) result.push(...collectDescendants(n.id));
  }
  return result;
}

/* ------------------------- Multi-select toolbar ------------------------- */
document.getElementById("multi-delete").addEventListener("click", async () => {
  // Only ask the server to delete top-level selected nodes — deleting a
  // parent already cascades to any selected descendants.
  const ids = [...state.selection].filter((id) => {
    const n = state.nodes.get(id);
    return !n || !state.selection.has(n.parent_id);
  });
  if (!ids.length) return;
  if (!confirm(`Удалить ${ids.length} нод (и их дочерние)?`)) return;
  for (const id of ids) {
    try {
      await api("DELETE", `/api/nodes/${id}`);
      collectDescendants(id).forEach((did) => {
        state.nodes.delete(did);
        document.getElementById("node-" + did)?.remove();
      });
    } catch (err) {
      showToast(err.message);
    }
  }
  clearSelection();
  renderEdges();
});
document.getElementById("multi-clear").addEventListener("click", clearSelection);

/* ------------------------- Zone interactions ------------------------- */
function attachZoneHandlers(el, header, resize) {
  let mv = null;
  let rs = null;

  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    selectZone(Number(el.dataset.id));
  });

  header.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const id = Number(el.dataset.id);
    selectZone(id);
    const z = state.zones.get(id);
    const memberIds = [...state.nodes.values()].filter((n) => n.zone_id === id).map((n) => n.id);
    mv = {
      startX: e.clientX, startY: e.clientY, origX: z.x, origY: z.y,
      members: memberIds.map((nid) => ({ id: nid, x: state.nodes.get(nid).x, y: state.nodes.get(nid).y })),
    };
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener("pointermove", (e) => {
    if (!mv) return;
    const id = Number(el.dataset.id);
    const z = state.zones.get(id);
    const dx = (e.clientX - mv.startX) / state.view.scale;
    const dy = (e.clientY - mv.startY) / state.view.scale;
    z.x = mv.origX + dx;
    z.y = mv.origY + dy;
    el.style.left = z.x + "px";
    el.style.top = z.y + "px";
    mv.members.forEach((m) => {
      const n = state.nodes.get(m.id);
      if (!n) return;
      n.x = m.x + dx;
      n.y = m.y + dy;
      const nel = document.getElementById("node-" + n.id);
      if (nel) { nel.style.left = n.x + "px"; nel.style.top = n.y + "px"; }
    });
    renderEdges();
  });
  header.addEventListener("pointerup", (e) => {
    if (!mv) return;
    const id = Number(el.dataset.id);
    const z = state.zones.get(id);
    header.releasePointerCapture(e.pointerId);
    scheduleSaveZone(id, { x: z.x, y: z.y });
    mv.members.forEach((m) => {
      const n = state.nodes.get(m.id);
      if (n) scheduleSave(n.id, { x: n.x, y: n.y });
    });
    mv = null;
  });

  resize.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const id = Number(el.dataset.id);
    selectZone(id);
    const z = state.zones.get(id);
    rs = { startX: e.clientX, startY: e.clientY, origW: z.width, origH: z.height };
    resize.setPointerCapture(e.pointerId);
  });
  resize.addEventListener("pointermove", (e) => {
    if (!rs) return;
    const id = Number(el.dataset.id);
    const z = state.zones.get(id);
    const dw = (e.clientX - rs.startX) / state.view.scale;
    const dh = (e.clientY - rs.startY) / state.view.scale;
    z.width = Math.max(80, rs.origW + dw);
    z.height = Math.max(80, rs.origH + dh);
    el.style.width = z.width + "px";
    el.style.height = z.height + "px";
  });
  resize.addEventListener("pointerup", (e) => {
    if (!rs) return;
    const id = Number(el.dataset.id);
    const z = state.zones.get(id);
    resize.releasePointerCapture(e.pointerId);
    reassignAllZones();
    renderAll();
    scheduleSaveZone(id, { width: z.width, height: z.height });
    rs = null;
  });
}

function selectZone(id) {
  clearSelection();
  state.selectedZoneId = id;
  document.querySelectorAll(".zone.selected").forEach((el) => el.classList.remove("selected"));
  document.getElementById("zone-" + id)?.classList.add("selected");
  openZoneEditor();
}
function openZoneEditor() {
  const z = state.zones.get(state.selectedZoneId);
  if (!z) return;
  zoneTitleInput.value = z.title;
  zoneColorInput.value = z.color;
  zoneEditorMeta.textContent = "ID зоны " + z.id;
  zoneEditor.classList.add("open");
}
function closeZoneEditor() {
  zoneEditor.classList.remove("open");
  if (state.selectedZoneId != null) {
    document.getElementById("zone-" + state.selectedZoneId)?.classList.remove("selected");
  }
  state.selectedZoneId = null;
}
document.getElementById("close-zone-editor").addEventListener("click", closeZoneEditor);
zoneTitleInput.addEventListener("input", () => {
  if (state.selectedZoneId == null) return;
  const z = state.zones.get(state.selectedZoneId);
  z.title = zoneTitleInput.value;
  renderZone(z);
  scheduleSaveZone(z.id, { title: z.title });
});
zoneColorInput.addEventListener("input", () => {
  if (state.selectedZoneId == null) return;
  const z = state.zones.get(state.selectedZoneId);
  z.color = zoneColorInput.value;
  renderZone(z);
  scheduleSaveZone(z.id, { color: z.color });
});
document.getElementById("delete-zone").addEventListener("click", async () => {
  if (state.selectedZoneId == null) return;
  const z = state.zones.get(state.selectedZoneId);
  if (!confirm(`Удалить зону «${z.title}»? Ноды внутри останутся на месте.`)) return;
  try {
    await api("DELETE", `/api/zones/${z.id}`);
    state.zones.delete(z.id);
    document.getElementById("zone-" + z.id)?.remove();
    state.nodes.forEach((n) => { if (n.zone_id === z.id) n.zone_id = null; });
    closeZoneEditor();
    showToast("Зона удалена");
  } catch (err) {
    showToast(err.message);
  }
});

/* ------------------------- Mode toggle: zone-draw / link ------------------------- */
function setMode(mode) {
  state.mode = mode;
  zoneModeBtn.classList.toggle("active", mode === "zone");
  linkModeBtn.classList.toggle("active", mode === "link");
  wrap.classList.toggle("mode-zone", mode === "zone");
  wrap.classList.toggle("mode-link", mode === "link");
  if (mode !== "link" && linkFrom != null) {
    document.getElementById("node-" + linkFrom)?.classList.remove("link-source");
    linkFrom = null;
  }
}
zoneModeBtn.addEventListener("click", () => setMode(state.mode === "zone" ? "select" : "zone"));
linkModeBtn.addEventListener("click", () => setMode(state.mode === "link" ? "select" : "link"));

/* ------------------------- Pan / rubber-band select / zone draw ------------------------- */
function positionOverlayBox(el, sx, sy, ex, ey) {
  const rect = wrap.getBoundingClientRect();
  el.style.left = (Math.min(sx, ex) - rect.left) + "px";
  el.style.top = (Math.min(sy, ey) - rect.top) + "px";
  el.style.width = Math.abs(ex - sx) + "px";
  el.style.height = Math.abs(ey - sy) + "px";
  el.hidden = false;
}

function applyRubberSelection(sx, sy, ex, ey) {
  selectBoxEl.hidden = true;
  const a = toWorld(sx, sy), b = toWorld(ex, ey);
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  if (maxX - minX < 4 && maxY - minY < 4) return;
  for (const n of state.nodes.values()) {
    const r = nodeRect(n);
    const overlap = r.cx - r.halfW < maxX && r.cx + r.halfW > minX &&
                     r.cy - r.halfH < maxY && r.cy + r.halfH > minY;
    if (overlap) state.selection.add(n.id);
  }
  state.selectedId = state.selection.size === 1 ? [...state.selection][0] : null;
  refreshSelectionClasses();
  updateMultiToolbar();
}

async function finishZoneDraw(sx, sy, ex, ey) {
  zoneDraftEl.hidden = true;
  const a = toWorld(sx, sy), b = toWorld(ex, ey);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const width = Math.max(80, Math.abs(b.x - a.x));
  const height = Math.max(80, Math.abs(b.y - a.y));
  try {
    const data = await api("POST", "/api/zones", { title: "Зона", x, y, width, height, color: "#6366f1" });
    state.zones.set(data.zone.id, data.zone);
    renderZone(data.zone);
    reassignAllZones();
    renderAll();
    setMode("select");
    showToast("Зона создана");
  } catch (err) {
    showToast(err.message);
    setMode("select");
  }
}

let action = null; // { mode: 'pan' | 'select' | 'zone-draw', ... }
wrap.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".node") || e.target.closest(".zone")) return;
  if (e.shiftKey) {
    action = { mode: "select", startX: e.clientX, startY: e.clientY };
    positionOverlayBox(selectBoxEl, e.clientX, e.clientY, e.clientX, e.clientY);
  } else if (state.mode === "zone") {
    action = { mode: "zone-draw", startX: e.clientX, startY: e.clientY };
    positionOverlayBox(zoneDraftEl, e.clientX, e.clientY, e.clientX, e.clientY);
  } else {
    action = { mode: "pan", startX: e.clientX, startY: e.clientY, origX: state.view.x, origY: state.view.y };
    wrap.classList.add("panning");
    clearSelection();
    if (state.selectedZoneId != null) closeZoneEditor();
  }
});
window.addEventListener("pointermove", (e) => {
  if (!action) return;
  if (action.mode === "pan") {
    state.view.x = action.origX + (e.clientX - action.startX);
    state.view.y = action.origY + (e.clientY - action.startY);
    applyView();
  } else if (action.mode === "select") {
    positionOverlayBox(selectBoxEl, action.startX, action.startY, e.clientX, e.clientY);
  } else if (action.mode === "zone-draw") {
    positionOverlayBox(zoneDraftEl, action.startX, action.startY, e.clientX, e.clientY);
  }
});
window.addEventListener("pointerup", (e) => {
  if (!action) return;
  if (action.mode === "pan") {
    wrap.classList.remove("panning");
  } else if (action.mode === "select") {
    applyRubberSelection(action.startX, action.startY, e.clientX, e.clientY);
  } else if (action.mode === "zone-draw") {
    finishZoneDraw(action.startX, action.startY, e.clientX, e.clientY);
  }
  action = null;
});

wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const delta = -e.deltaY * 0.0015;
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.view.scale * (1 + delta)));
  // zoom toward cursor
  const wx = (mx - state.view.x) / state.view.scale;
  const wy = (my - state.view.y) / state.view.scale;
  state.view.scale = newScale;
  state.view.x = mx - wx * newScale;
  state.view.y = my - wy * newScale;
  applyView();
}, { passive: false });

/* ------------------------- Fit / center ------------------------- */
function fitView() {
  if (state.nodes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    const el = document.getElementById("node-" + n.id);
    maxX = Math.max(maxX, n.x + (el ? el.offsetWidth : nodeWidth(n)));
    maxY = Math.max(maxY, n.y + (el ? el.offsetHeight : (n.height || 90)));
  }
  const rect = wrap.getBoundingClientRect();
  const pad = 80;
  const scale = Math.min(1.2,
    (rect.width - pad * 2) / (maxX - minX || 1),
    (rect.height - pad * 2) / (maxY - minY || 1));
  state.view.scale = Math.max(MIN_SCALE, scale);
  state.view.x = (rect.width - (maxX - minX) * state.view.scale) / 2 - minX * state.view.scale;
  state.view.y = (rect.height - (maxY - minY) * state.view.scale) / 2 - minY * state.view.scale;
  applyView();
}
document.getElementById("fit-btn").addEventListener("click", fitView);

function centerOnNode(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  const rect = wrap.getBoundingClientRect();
  const c = nodeCenter(n);
  state.view.x = rect.width / 2 - c.x * state.view.scale;
  state.view.y = rect.height / 2 - c.y * state.view.scale;
  applyView();
  selectOnly(id);
}

/* ------------------------- Search ------------------------- */
function applySearchHighlight() {
  const q = state.search;
  for (const n of state.nodes.values()) {
    const el = document.getElementById("node-" + n.id);
    if (!el) continue;
    const match = !!q && ((n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q));
    el.classList.toggle("search-match", match);
    el.classList.toggle("search-dim", !!q && !match);
  }
}
searchInput.addEventListener("input", () => {
  state.search = searchInput.value.trim().toLowerCase();
  applySearchHighlight();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !state.search) return;
  const q = state.search;
  const match = [...state.nodes.values()].find((n) =>
    (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q));
  if (match) centerOnNode(match.id);
});

/* ------------------------- Logout ------------------------- */
document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  window.location.href = "/login";
});

/* ------------------------- Keyboard ------------------------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeEditor();
    closeZoneEditor();
    if (state.mode !== "select") setMode("select");
  }
});

/* ------------------------- Init ------------------------- */
async function init() {
  buildPalette();
  applyView();
  try {
    const [data, usersData, zonesData, linksData] = await Promise.all([
      api("GET", "/api/nodes"),
      api("GET", "/api/users"),
      api("GET", "/api/zones"),
      api("GET", "/api/links"),
    ]);
    state.users = usersData.users || [];
    (zonesData.zones || []).forEach((z) => state.zones.set(z.id, z));
    (data.nodes || []).forEach((n) => state.nodes.set(n.id, n));
    (linksData.links || []).forEach((l) => state.links.set(l.id, l));
    renderZones();
    renderAll();
    fitView();
  } catch (err) {
    showToast("Не удалось загрузить: " + err.message);
  }
}
init();
