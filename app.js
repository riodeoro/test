const DATA_BASE = (window.WX_DATA_BASE || "./data").replace(/\/+$/, "") + "/";

const BUCKET_BASE = DATA_BASE;
const CONFIG_BASE = DATA_BASE;

const CHART_WINDOWS = [24, 48, 72, 168, 336, 720, 1440, 2160, 4380];

const MOBILE_QUERY = window.matchMedia("(max-width: 768px)");
const isMobile = () => MOBILE_QUERY.matches;

function resolveChartWindow(hours) {
  for (const w of CHART_WINDOWS) if (w >= hours) return w;
  return null;
}

function safeFc(fcName) {
  return fcName.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

const memCache = new Map();

async function fetchJson(filename) {
  if (memCache.has(filename)) return memCache.get(filename);
  try {
    const res = await fetch(BUCKET_BASE + filename, { cache: "default" });
    if (!res.ok) return null;
    const data = await res.json();
    memCache.set(filename, data);
    return data;
  } catch (e) {
    console.warn("fetchJson failed", filename, e);
    return null;
  }
}

async function fetchText(filename) {
  if (memCache.has(filename)) return memCache.get(filename);
  try {
    const res = await fetch(BUCKET_BASE + filename, { cache: "default" });
    if (!res.ok) return null;
    const data = await res.text();
    memCache.set(filename, data);
    return data;
  } catch (e) {
    return null;
  }
}

function peekCharts(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  if (w === null) return null;
  const hit = memCache.get(`${safeFc(fc)}_${w}h_${suffix}.json`);
  return hit && typeof hit.then !== "function" ? hit : null;
}

function loadCharts(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  if (w === null) return Promise.resolve(null);
  return fetchJson(`${safeFc(fc)}_${w}h_${suffix}.json`);
}

function loadText(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  if (w === null) return Promise.resolve(null);
  return fetchText(`${safeFc(fc)}_${w}h_${suffix}.txt`);
}

async function extractDateRange(fc, hours) {
  for (const suffix of ["data", "rh", "wind", "temp", "rn1", "power"]) {
    const c = await loadCharts(fc, hours, suffix);
    if (!c) continue;
    if (c._date_min && c._date_max) return [c._date_min, c._date_max];
  }
  return [null, null];
}

function el(tag, className, html) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function deepClone(obj) {
  if (typeof structuredClone === "function") {
    try { return structuredClone(obj); } catch (e) {}
  }
  return JSON.parse(JSON.stringify(obj));
}

const TYPED_ARRAY_CTORS = {
  f8: Float64Array,
  f4: Float32Array,
  i4: Int32Array,
  u4: Uint32Array,
  i2: Int16Array,
  u2: Uint16Array,
  i1: Int8Array,
  u1: Uint8Array,
};

function decodeArray(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return null;
  if (typeof v.bdata !== "string" || typeof v.dtype !== "string") return null;
  if (v.shape !== undefined && String(v.shape).indexOf(",") >= 0) return null;
  const Ctor = TYPED_ARRAY_CTORS[v.dtype];
  if (!Ctor) return null;
  try {
    const bin = atob(v.bdata);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) return null;
    return Array.from(new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT));
  } catch (e) {
    return null;
  }
}

function isHeatmap(tr) {
  return !!tr && (tr.type === "heatmap" || tr.type === "heatmapgl");
}

function hoverStation(s) {
  if (typeof s !== "string") return null;
  const m = /^<b>(.*?)<\/b>/.exec(s);
  return m ? m[1].trim() : null;
}

function traceStationLabels(tr) {
  if (!tr || isHeatmap(tr)) return null;
  const txt = decodeArray(tr.text) || decodeArray(tr.hovertext);
  if (!txt || !txt.length) return null;
  const labels = txt.map(hoverStation);
  return labels.some(Boolean) ? labels : null;
}

function heatmapStationRows(tr) {
  const y = decodeArray(tr.y);
  if (!y || !y.length) return null;
  return y.every(v => typeof v === "string") ? y : null;
}

function heatmapDefaultRows(tr) {
  if (!tr || !tr.meta || typeof tr.meta !== "object") return null;
  const rows = tr.meta.default_rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.every(v => typeof v === "string") ? rows : null;
}

function figureStations(data) {
  const found = new Set();
  for (const tr of data || []) {
    if (isHeatmap(tr)) {
      const rows = heatmapStationRows(tr);
      if (rows) for (const s of rows) found.add(s);
      continue;
    }
    const labels = traceStationLabels(tr);
    if (labels) for (const s of labels) if (s) found.add(s);
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function pointArray(v, n) {
  if (v === undefined || v === null) return { skip: true };
  if (Array.isArray(v)) {
    return v.length === n ? { arr: v } : { abort: true };
  }
  if (typeof v === "object") {
    if (typeof v.bdata !== "string") return { skip: true };
    const arr = decodeArray(v);
    if (!arr || arr.length !== n) return { abort: true };
    return { arr: arr };
  }
  return { skip: true };
}

function filterPointTrace(tr, sel) {
  const labels = traceStationLabels(tr);
  if (!labels) return tr;
  const n = labels.length;
  const keep = labels.map(s => !!s && sel.has(s));
  if (keep.every(Boolean)) return tr;

  const take = (arr) => arr.filter((_v, i) => keep[i]);
  const out = Object.assign({}, tr);

  for (const key of ["x", "y", "z", "text", "hovertext", "customdata", "ids"]) {
    const res = pointArray(tr[key], n);
    if (res.abort) return tr;
    if (res.arr) out[key] = take(res.arr);
  }

  if (tr.marker && typeof tr.marker === "object") {
    const marker = Object.assign({}, tr.marker);
    for (const key of ["color", "size", "opacity", "symbol"]) {
      const res = pointArray(marker[key], n);
      if (res.abort) return tr;
      if (res.arr) marker[key] = take(res.arr);
    }
    if (marker.line && typeof marker.line === "object") {
      const line = Object.assign({}, marker.line);
      for (const key of ["color", "width"]) {
        const res = pointArray(line[key], n);
        if (res.abort) return tr;
        if (res.arr) line[key] = take(res.arr);
      }
      marker.line = line;
    }
    out.marker = marker;
  }
  return out;
}

function filterHeatmapTrace(tr, sel) {
  const rows = heatmapStationRows(tr);
  if (!rows) return { trace: tr, rows: null };
  const keep = rows.map(s => sel.has(s));
  const kept = rows.filter((_v, i) => keep[i]);
  if (kept.length === rows.length) return { trace: tr, rows: kept };

  const out = Object.assign({}, tr, { y: kept });
  for (const key of ["z", "text", "hovertext", "customdata"]) {
    const v = tr[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.length !== rows.length) return { trace: tr, rows: null };
    out[key] = v.filter((_v, i) => keep[i]);
  }
  return { trace: out, rows: kept };
}

function axisLayoutKey(ref, kind) {
  const id = typeof ref === "string" && ref ? ref : kind;
  return (kind === "x" ? "xaxis" : "yaxis") + id.slice(1);
}

function applyStationFilter(fig, sel) {
  const data = (fig && fig.data) || [];
  const layout = (fig && fig.layout) || {};
  const active = sel && sel.size ? sel : null;
  const hasDefaults = data.some(tr => isHeatmap(tr) && heatmapDefaultRows(tr));
  if (!active && !hasDefaults) return { data: data, layout: layout };

  const outData = [];
  const axisPatch = {};

  for (const tr of data) {
    if (isHeatmap(tr)) {
      const rows = heatmapStationRows(tr);
      const defaults = heatmapDefaultRows(tr);
      if (!rows || (!active && !defaults)) {
        outData.push(tr);
        continue;
      }
      const keepSet = active || new Set(defaults);
      const res = filterHeatmapTrace(tr, keepSet);
      if (!res.rows) {
        outData.push(tr);
        continue;
      }
      const ykey = axisLayoutKey(tr.yaxis, "y");
      const xkey = axisLayoutKey(tr.xaxis, "x");
      if (!res.rows.length) {
        axisPatch[ykey] = Object.assign({}, layout[ykey], { visible: false });
        axisPatch[xkey] = Object.assign({}, layout[xkey], { visible: false });
        continue;
      }
      outData.push(res.trace);
      if (layout[ykey] && Array.isArray(layout[ykey].categoryarray)) {
        axisPatch[ykey] = Object.assign({}, layout[ykey], { categoryarray: res.rows });
      }
      continue;
    }
    outData.push(active ? filterPointTrace(tr, active) : tr);
  }

  const outLayout = Object.keys(axisPatch).length
    ? Object.assign({}, layout, axisPatch)
    : layout;

  return { data: outData, layout: outLayout };
}

function ensureStationFilterStyles() {
  if (document.getElementById("wx-stnf-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-stnf-styles";
  st.textContent = [
    ".wx-stnf{position:relative;display:flex;justify-content:flex-end;align-items:center;",
    "z-index:1100;}",
    ".wx-stnf-inline{height:18px;margin:0 0 -4px 0;}",
    ".wx-stnf-float{position:absolute;top:14px;right:8px;}",
    ".wx-stnf-btn{font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "color:var(--text-muted);background:transparent;border:none;border-radius:0;",
    "padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;",
    "max-width:100%;line-height:1.4;}",
    ".wx-stnf-btn:hover{color:var(--text);}",
    ".wx-stnf-btn.on{color:var(--text);}",
    ".wx-stnf-btn > span:first-child{overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;max-width:190px;}",
    ".wx-stnf-btn .caret{font-size:8px;opacity:.6;flex:0 0 auto;}",
    ".wx-stnf-menu{position:absolute;top:calc(100% + 5px);right:0;width:220px;z-index:1100;",
    "background:var(--surface);border:1px solid var(--line);border-radius:4px;",
    "box-shadow:0 2px 6px rgba(0,0,0,.05);padding:5px;display:none;}",
    ".wx-stnf-menu.open{display:block;}",
    ".wx-stnf-menu .wx-stnf-search{width:100%;box-sizing:border-box;font-family:inherit;",
    "font-size:12px;line-height:1.4;color:var(--text);background:transparent;",
    "border:none;border-bottom:1px solid var(--line);border-radius:0;",
    "padding:4px 6px 5px 6px;margin:0;}",
    ".wx-stnf-menu .wx-stnf-search::placeholder{color:var(--text-muted);}",
    ".wx-stnf-menu .wx-stnf-search:focus{outline:none;",
    "border-bottom-color:var(--text-muted);}",
    ".wx-stnf-list{max-height:210px;overflow-y:auto;margin-top:3px;}",
    ".wx-stnf-opt{padding:5px 6px;border-radius:3px;font-size:12px;font-weight:400;",
    "color:var(--text-muted);cursor:pointer;white-space:nowrap;overflow:hidden;",
    "text-overflow:ellipsis;}",
    ".wx-stnf-opt:hover{background:#fafaf9;color:var(--text);}",
    ".wx-stnf-opt.sel{color:var(--text);font-weight:500;background:#f3f2ef;}",
    ".wx-stnf-sep{height:1px;background:var(--line);margin:4px 2px;}",
    ".wx-stnf-none{padding:6px;font-size:12px;color:var(--text-muted);}",
    "@media (max-width:768px){.wx-stnf-menu{width:210px;}",
    ".wx-stnf-menu .wx-stnf-search{font-size:16px;}.wx-stnf-opt{padding:8px 6px;}",
    ".wx-stnf-btn > span:first-child{max-width:130px;}}",
  ].join("");
  document.head.appendChild(st);
}

function captureView(plotDiv) {
  const full = plotDiv && plotDiv._fullLayout;
  if (!full) return null;

  const skip = new Set();
  for (const tr of plotDiv.data || []) {
    if (!isHeatmap(tr)) continue;
    skip.add(axisLayoutKey(tr.xaxis, "x"));
    skip.add(axisLayoutKey(tr.yaxis, "y"));
  }

  const view = {};
  for (const key of Object.keys(full)) {
    if (/^[xy]axis\d*$/.test(key)) {
      const ax = full[key];
      if (!ax || skip.has(key) || ax.type === "category") continue;
      if (!Array.isArray(ax.range)) continue;
      view[key] = { range: ax.range.slice(), autorange: false };
    } else if (/^scene\d*$/.test(key)) {
      const sc = full[key];
      if (!sc) continue;
      const patch = {};
      if (sc.camera) patch.camera = deepClone(sc.camera);
      for (const ak of ["xaxis", "yaxis", "zaxis"]) {
        const a = sc[ak];
        if (a && Array.isArray(a.range) && a.type !== "category") {
          patch[ak] = { range: a.range.slice(), autorange: false };
        }
      }
      if (Object.keys(patch).length) view[key] = patch;
    }
  }
  return Object.keys(view).length ? view : null;
}

function mergeView(layout, view) {
  if (!view) return layout;
  const out = Object.assign({}, layout);
  for (const key of Object.keys(view)) {
    const patch = view[key];
    if (/^scene\d*$/.test(key)) {
      const scene = Object.assign({}, out[key]);
      for (const pk of Object.keys(patch)) {
        scene[pk] = (pk === "xaxis" || pk === "yaxis" || pk === "zaxis")
          ? Object.assign({}, scene[pk], patch[pk])
          : patch[pk];
      }
      out[key] = scene;
    } else {
      out[key] = Object.assign({}, out[key], patch);
    }
  }
  return out;
}

function stationFilterControl(stations, onChange, floating) {
  ensureStationFilterStyles();

  const selected = new Set();
  const wrap = el("div", "wx-stnf " + (floating ? "wx-stnf-float" : "wx-stnf-inline"));
  const btn = el("button", "wx-stnf-btn");
  btn.type = "button";
  const btnText = el("span");
  const caret = el("span", "caret", "\u25BE");
  btn.appendChild(btnText);
  btn.appendChild(caret);

  const menu = el("div", "wx-stnf-menu");
  const search = el("input", "wx-stnf-search");
  search.type = "text";
  search.placeholder = "Filter stations";

  const allOpt = el("div", "wx-stnf-opt sel", "All stations");

  const sep = el("div", "wx-stnf-sep");
  const list = el("div", "wx-stnf-list");
  const empty = el("div", "wx-stnf-none", "No match");
  empty.style.display = "none";

  const rows = [];
  for (const name of stations) {
    const opt = el("div", "wx-stnf-opt");
    opt.textContent = name;
    list.appendChild(opt);
    rows.push({ opt: opt, name: name });
  }
  list.appendChild(empty);

  let open = false;

  const sync = () => {
    const n = selected.size;
    btnText.textContent = n === 0
      ? "All stations"
      : (n === 1 ? Array.from(selected)[0] : `${n} stations`);
    btn.className = "wx-stnf-btn" + (n ? " on" : "");
    allOpt.className = "wx-stnf-opt" + (n ? "" : " sel");
    for (const r of rows) {
      r.opt.className = "wx-stnf-opt" + (selected.has(r.name) ? " sel" : "");
    }
  };

  const emit = () => {
    sync();
    onChange(selected.size ? new Set(selected) : null);
  };

  const outside = (ev) => {
    if (!wrap.contains(ev.target)) setOpen(false);
  };

  const onKey = (ev) => {
    if (ev.key === "Escape") setOpen(false);
  };

  function setOpen(next) {
    if (open === next) return;
    open = next;
    menu.className = "wx-stnf-menu" + (open ? " open" : "");
    caret.textContent = open ? "\u25B4" : "\u25BE";
    if (open) {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onKey, true);
      search.focus();
    } else {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    }
  }

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(!open);
  });

  allOpt.addEventListener("click", () => {
    if (!selected.size) return;
    selected.clear();
    emit();
  });

  for (const r of rows) {
    r.opt.addEventListener("click", () => {
      if (selected.has(r.name)) selected.delete(r.name);
      else selected.add(r.name);
      emit();
    });
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const hit = !q || r.name.toLowerCase().indexOf(q) >= 0;
      r.opt.style.display = hit ? "block" : "none";
      if (hit) shown++;
    }
    empty.style.display = shown ? "none" : "block";
  });

  menu.appendChild(search);
  menu.appendChild(allOpt);
  menu.appendChild(sep);
  menu.appendChild(list);
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  wrap._wxClear = () => {
    if (!selected.size) return false;
    selected.clear();
    emit();
    return true;
  };
  sync();
  return wrap;
}

function usedAxisIds(data) {
  const ids = new Set();
  for (const tr of data || []) {
    if (tr.scene) ids.add(tr.scene);
    else if (tr.type === "scatter3d" || tr.type === "surface" || tr.type === "mesh3d") ids.add("scene");
    else ids.add(tr.xaxis || "x");
  }
  return ids;
}

function collectPanels(layout, used) {
  const panels = [];
  const filter = used && used.size ? used : null;
  for (const key of Object.keys(layout)) {
    if (/^xaxis\d*$/.test(key)) {
      const ax = layout[key];
      if (!ax || !Array.isArray(ax.domain)) continue;
      const idx = key === "xaxis" ? "" : key.slice(5);
      let ykey = "yaxis" + idx;
      if (typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor)) {
        ykey = "yaxis" + ax.anchor.slice(1);
      }
      const ay = layout[ykey];
      if (!ay || !Array.isArray(ay.domain)) continue;
      if (ax.visible === false || ay.visible === false) continue;
      if (filter && !filter.has("x" + idx)) continue;
      panels.push({
        type: "xy",
        xkey: key,
        ykey: ykey,
        axisId: "x" + idx,
        x0: ax.domain[0], x1: ax.domain[1],
        y0: ay.domain[0], y1: ay.domain[1],
      });
    } else if (/^scene\d*$/.test(key)) {
      const sc = layout[key];
      if (!sc || !sc.domain || !Array.isArray(sc.domain.x) || !Array.isArray(sc.domain.y)) continue;
      if (filter && !filter.has(key)) continue;
      panels.push({
        type: "scene",
        skey: key,
        axisId: key,
        x0: sc.domain.x[0], x1: sc.domain.x[1],
        y0: sc.domain.y[0], y1: sc.domain.y[1],
      });
    }
  }
  return panels;
}

function columnStarts(panels) {
  const starts = [];
  for (const p of panels) {
    if (!starts.some(v => Math.abs(v - p.x0) < 0.01)) starts.push(p.x0);
  }
  starts.sort((a, b) => a - b);
  return starts;
}

function legendEntryCount(data) {
  let n = 0;
  for (const tr of data || []) {
    if (tr.showlegend === false) continue;
    if (!tr.name) continue;
    if (tr.type === "heatmap" || tr.type === "heatmapgl") continue;
    n++;
  }
  return n;
}

function colorbarTraces(data) {
  const out = [];
  for (const tr of data || []) {
    if (tr.showscale === true || (tr.colorbar && tr.showscale !== false)) out.push(tr);
  }
  return out;
}

function remapPoint(x, y, from, to) {
  const fx = (from.x1 - from.x0) || 1;
  const fy = (from.y1 - from.y0) || 1;
  return [
    to.x0 + ((x - from.x0) / fx) * (to.x1 - to.x0),
    to.y0 + ((y - from.y0) / fy) * (to.y1 - to.y0),
  ];
}

function panelIndexForPoint(boxes, x, y) {
  const pad = 0.05;
  let above = -1;
  let aboveGap = Infinity;
  let inside = -1;
  let insideDist = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x < b.x0 - pad || x > b.x1 + pad) continue;
    if (y >= b.y1 - 0.001) {
      const gap = y - b.y1;
      if (gap < aboveGap) { aboveGap = gap; above = i; }
    } else if (y >= b.y0 - pad) {
      const d = Math.abs(y - (b.y0 + b.y1) / 2);
      if (d < insideDist) { insideDist = d; inside = i; }
    }
  }
  if (above >= 0 && aboveGap <= 0.12) return above;
  if (inside >= 0) return inside;
  return above;
}

function tuneFonts(layout, panelCount) {
  layout.font = Object.assign({}, layout.font, { size: 11 });

  if (layout.title) {
    const t = typeof layout.title === "string" ? { text: layout.title } : Object.assign({}, layout.title);
    t.font = Object.assign({}, t.font, { size: 12 });
    t.x = 0;
    t.xanchor = "left";
    t.xref = "paper";
    t.y = 1;
    t.yanchor = "top";
    t.yref = "container";
    t.pad = { t: 6, l: 0, r: 0, b: 0 };
    t.automargin = true;
    layout.title = t;
  }

  for (const key of Object.keys(layout)) {
    if (!/^[xy]axis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax) continue;
    const size = (ax.tickfont && ax.tickfont.size) || 10;
    ax.tickfont = Object.assign({}, ax.tickfont, { size: Math.min(size, 9) });
    if (panelCount <= 6) ax.automargin = true;
    if (ax.title) {
      const at = typeof ax.title === "string" ? { text: ax.title } : Object.assign({}, ax.title);
      at.font = Object.assign({}, at.font, { size: 10 });
      if (key.charAt(0) === "x") at.standoff = 14;
      ax.title = at;
    }
  }

  if (Array.isArray(layout.annotations)) {
    for (const a of layout.annotations) {
      const size = (a.font && a.font.size) || 11;
      a.font = Object.assign({}, a.font, { size: Math.min(size, 12) });
    }
  }
}

function applyLegend(layout) {
  const legend = Object.assign({}, layout.legend);
  legend.orientation = "h";
  legend.x = 0;
  legend.xanchor = "left";
  legend.y = 1;
  legend.yanchor = "bottom";
  legend.font = Object.assign({}, legend.font, { size: 9 });
  legend.entrywidth = 0.5;
  legend.entrywidthmode = "fraction";
  legend.tracegroupgap = 3;
  layout.legend = legend;
}

function applyColorbars(fig, panels, bottomPanel, plotAreaPx) {
  let needsRoom = false;
  const offset = Math.min(0.35, 66 / Math.max(plotAreaPx, 120));
  for (const tr of colorbarTraces(fig.data)) {
    const axisId = tr.xaxis || "x";
    const panel = panels.find(p => p.axisId === axisId) || bottomPanel;
    const old = tr.colorbar || {};
    const titleText = typeof old.title === "string" ? old.title : (old.title && old.title.text) || "";
    const bar = {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      len: 0.75,
      thickness: 10,
      tickfont: { size: 8 },
      outlinewidth: 0,
    };
    if (old.tickformat) bar.tickformat = old.tickformat;
    if (old.tickvals) bar.tickvals = old.tickvals;
    if (titleText) bar.title = { text: titleText, side: "top", font: { size: 9 } };

    const atBottom = panel && bottomPanel && panel.axisId === bottomPanel.axisId;
    if (!panel || atBottom) {
      bar.y = (panel ? panel.y0 : 0) - offset;
      bar.yanchor = "top";
      needsRoom = true;
    } else {
      bar.y = panel.y1 + 0.015;
      bar.yanchor = "bottom";
    }
    tr.colorbar = bar;
  }
  return needsRoom;
}

function buildMobileFigure(figDict, opts) {
  const fig = deepClone(figDict);
  const layout = fig.layout || (fig.layout = {});
  const origHeight = opts.height || layout.height || 420;
  const origMargin = Object.assign({ l: 50, r: 50, t: 60, b: 60 }, layout.margin);

  delete layout.width;
  layout.autosize = true;
  layout.dragmode = false;
  for (const key of Object.keys(layout)) {
    if (/^scene\d*$/.test(key) && layout[key]) layout[key].dragmode = false;
  }

  const panels = collectPanels(layout, usedAxisIds(fig.data));
  const cols = columnStarts(panels);
  const canReflow = panels.length > 1 && cols.length > 1;

  const entries = layout.showlegend === false ? 0 : legendEntryCount(fig.data);
  const legendRows = entries > 0 ? Math.min(4, Math.ceil(entries / 2)) : 0;
  if (legendRows) applyLegend(layout);

  tuneFonts(layout, panels.length || 1);

  const titleText = layout.title && layout.title.text ? String(layout.title.text) : "";
  const titleLines = titleText
    ? Math.min(3, Math.max(1, Math.ceil(titleText.replace(/<[^>]*>/g, "").length / 42)))
    : 0;
  const titlePx = titleLines ? 10 + titleLines * 16 : 0;
  const legendPx = legendRows ? legendRows * 15 + 10 : 0;
  const subplotTitlePx = (canReflow && Array.isArray(layout.annotations) && layout.annotations.length) ? 16 : 0;
  const marginTop = Math.max(14, titlePx + legendPx + subplotTitlePx);
  const marginLeft = Math.max(38, Math.min(origMargin.l, 52));
  const marginRight = 12;
  let marginBottom = 56;

  let height;
  let ordered = panels;
  let bottomPanel = null;

  if (canReflow) {
    ordered = panels.slice().sort((a, b) => {
      const ca = cols.findIndex(v => Math.abs(v - a.x0) < 0.01);
      const cb = cols.findIndex(v => Math.abs(v - b.x0) < 0.01);
      if (ca !== cb) return ca - cb;
      return b.y0 - a.y0;
    });

    const boxes = ordered.map(p => ({ x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 }));
    const plotArea = Math.max(80, origHeight - origMargin.t - origMargin.b);
    const baseCell = Math.max.apply(null, ordered.map(p => plotArea * (p.y1 - p.y0)));
    const n = ordered.length;

    let cellPx;
    let gapPx;
    if (baseCell < 140) {
      cellPx = n > 10 ? 44 : Math.max(48, Math.min(baseCell, 62));
      gapPx = n > 10 ? 10 : 14;
    } else {
      cellPx = n >= 3 ? 320 : Math.max(300, Math.min(baseCell, 420));
      const rotated = ordered.slice(0, -1).some(p => {
        const ax = p.type === "xy" ? layout[p.xkey] : null;
        return !!(ax && ax.tickangle);
      });
      gapPx = rotated ? 120 : 90;
    }

    const plotPx = n * cellPx + (n - 1) * gapPx;
    const step = (cellPx + gapPx) / plotPx;
    const cellFrac = cellPx / plotPx;

    ordered.forEach((p, i) => {
      p.newY1 = 1 - i * step;
      p.newY0 = p.newY1 - cellFrac;
      p.newX0 = 0;
      p.newX1 = 1;
    });

    if (Array.isArray(layout.annotations)) {
      for (const a of layout.annotations) {
        if (a.xref !== "paper" || a.yref !== "paper") continue;
        if (typeof a.x !== "number" || typeof a.y !== "number") continue;
        const idx = panelIndexForPoint(boxes, a.x, a.y);
        if (idx < 0) continue;
        const p = ordered[idx];
        const to = { x0: p.newX0, x1: p.newX1, y0: p.newY0, y1: p.newY1 };
        const pt = remapPoint(a.x, a.y, boxes[idx], to);
        a.x = pt[0];
        a.y = pt[1];
      }
    }

    if (Array.isArray(layout.shapes)) {
      for (const s of layout.shapes) {
        if (s.xref !== "paper" || s.yref !== "paper") continue;
        const sx0 = Math.min(s.x0, s.x1);
        const sx1 = Math.max(s.x0, s.x1);
        const sy0 = Math.min(s.y0, s.y1);
        const sy1 = Math.max(s.y0, s.y1);
        const hits = [];
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          const cx = (b.x0 + b.x1) / 2;
          const cy = (b.y0 + b.y1) / 2;
          if (cx >= sx0 && cx <= sx1 && cy >= sy0 && cy <= sy1) hits.push(ordered[i]);
        }
        if (!hits.length) continue;
        s.x0 = 0;
        s.x1 = 1;
        s.y0 = Math.max(0, Math.min.apply(null, hits.map(p => p.newY0)) - 0.004);
        s.y1 = Math.min(1, Math.max.apply(null, hits.map(p => p.newY1)) + 0.004);
      }
    }

    for (const p of ordered) {
      if (p.type === "xy") {
        layout[p.xkey].domain = [p.newX0, p.newX1];
        layout[p.ykey].domain = [p.newY0, p.newY1];
      } else {
        layout[p.skey].domain = { x: [p.newX0, p.newX1], y: [p.newY0, p.newY1] };
      }
      p.x0 = p.newX0;
      p.x1 = p.newX1;
      p.y0 = p.newY0;
      p.y1 = p.newY1;
    }

    height = plotPx + marginTop + marginBottom;
    bottomPanel = ordered[ordered.length - 1];
  } else {
    height = Math.round(Math.max(origHeight, 300) * 1.15);
    if (panels.length === 1) {
      const p = panels[0];
      const box = { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 };
      if (box.x0 > 0.001 || box.x1 < 0.999 || box.y0 > 0.001 || box.y1 < 0.999) {
        const to = { x0: 0, x1: 1, y0: 0, y1: 1 };
        if (Array.isArray(layout.annotations)) {
          for (const a of layout.annotations) {
            if (a.xref !== "paper" || a.yref !== "paper") continue;
            if (typeof a.x !== "number" || typeof a.y !== "number") continue;
            const pt = remapPoint(a.x, a.y, box, to);
            a.x = pt[0];
            a.y = pt[1];
          }
        }
        if (Array.isArray(layout.shapes)) {
          for (const sh of layout.shapes) {
            if (sh.xref !== "paper" || sh.yref !== "paper") continue;
            const p0 = remapPoint(sh.x0, sh.y0, box, to);
            const p1 = remapPoint(sh.x1, sh.y1, box, to);
            sh.x0 = p0[0]; sh.y0 = p0[1];
            sh.x1 = p1[0]; sh.y1 = p1[1];
          }
        }
        if (p.type === "xy") {
          layout[p.xkey].domain = [0, 1];
          layout[p.ykey].domain = [0, 1];
        } else {
          layout[p.skey].domain = { x: [0, 1], y: [0, 1] };
        }
        p.x0 = 0; p.x1 = 1; p.y0 = 0; p.y1 = 1;
      }
    }
    bottomPanel = panels.length
      ? panels.reduce((a, b) => (a.y0 <= b.y0 ? a : b))
      : null;
  }

  const plotAreaPx = Math.max(120, height - marginTop - marginBottom);
  if (applyColorbars(fig, ordered, bottomPanel, plotAreaPx)) {
    marginBottom += 84;
    height += 84;
  }

  layout.margin = { l: marginLeft, r: marginRight, t: marginTop, b: marginBottom };
  layout.height = Math.round(height);

  return fig;
}

function traceHidden(tr) {
  return !!tr && (tr.visible === false || tr.visible === "legendonly");
}

function legendStationSet(data) {
  const found = new Set();
  let labeled = 0;
  let hidden = 0;
  for (const tr of data || []) {
    if (isHeatmap(tr)) continue;
    const labels = traceStationLabels(tr);
    if (!labels) continue;
    labeled++;
    if (traceHidden(tr)) {
      hidden++;
      continue;
    }
    for (const s of labels) if (s) found.add(s);
  }
  if (!labeled || !hidden) return null;
  return found;
}

function sameRows(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function prepareScorecards(filtered) {
  const data = [];
  const layout = Object.assign({}, (filtered && filtered.layout) || {});
  const cards = [];
  ((filtered && filtered.data) || []).forEach((tr, i) => {
    if (!isHeatmap(tr) || !heatmapStationRows(tr)) {
      data.push(tr);
      return;
    }
    data.push(deepClone(tr));
    const ykey = axisLayoutKey(tr.yaxis, "y");
    const ax = layout[ykey];
    let catKey = null;
    if (ax && Array.isArray(ax.categoryarray)) {
      layout[ykey] = deepClone(ax);
      catKey = ykey + ".categoryarray";
    }
    cards.push({ index: i, trace: deepClone(tr), catKey: catKey });
  });
  return { data: data, layout: layout, cards: cards };
}

function pointStats(data) {
  const stats = new Map();
  let usable = false;
  for (const tr of data || []) {
    if (isHeatmap(tr) || traceHidden(tr)) continue;
    const labels = traceStationLabels(tr);
    if (!labels) continue;
    const rates = decodeArray(tr.customdata);
    if (!rates || rates.length !== labels.length) continue;
    usable = true;
    const flagged = !!(tr.meta && tr.meta.scorecard_flag);
    for (let i = 0; i < labels.length; i++) {
      const stn = labels[i];
      const v = Number(rates[i]);
      if (!stn || !isFinite(v)) continue;
      let s = stats.get(stn);
      if (!s) {
        s = { peak_pos: 0, peak_neg: 0, flag_count: 0, total: 0 };
        stats.set(stn, s);
      }
      s.total++;
      if (flagged) s.flag_count++;
      if (v > s.peak_pos) s.peak_pos = v;
      if (v < s.peak_neg) s.peak_neg = v;
    }
  }
  return usable ? stats : null;
}

function metricValue(stat, kind) {
  if (kind === "peak_pos") return stat.peak_pos;
  if (kind === "peak_neg") return stat.peak_neg;
  if (kind === "flag_count") return stat.flag_count;
  return 0;
}

function metricText(value, kind) {
  if (!value) return "";
  if (kind === "flag_count") return String(Math.round(value));
  const n = Math.round(value);
  return kind === "peak_pos" && n > 0 ? "+" + n : String(n);
}

function rebuildScorecard(src, stats, rows) {
  const kinds = src && src.meta && src.meta.metric_kinds;
  if (!Array.isArray(kinds) || !kinds.length) return null;
  if (src.hovertext !== undefined || src.customdata !== undefined) return null;

  const keep = rows.filter(stn => stats.has(stn));
  keep.sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    const ma = Math.max(Math.abs(sa.peak_pos), Math.abs(sa.peak_neg));
    const mb = Math.max(Math.abs(sb.peak_pos), Math.abs(sb.peak_neg));
    if (mb !== ma) return mb - ma;
    if (sb.flag_count !== sa.flag_count) return sb.flag_count - sa.flag_count;
    if (sb.total !== sa.total) return sb.total - sa.total;
    return a.localeCompare(b);
  });

  const z = [];
  const text = [];
  for (const stn of keep) {
    const s = stats.get(stn);
    const zRow = [];
    const tRow = [];
    for (const kind of kinds) {
      const v = metricValue(s, kind);
      zRow.push(Math.abs(v));
      tRow.push(metricText(v, kind));
    }
    z.push(zRow);
    text.push(tRow);
  }
  return { rows: keep, z: z, text: text };
}

function sameCells(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (Array.isArray(ra) !== Array.isArray(rb)) return false;
    if (Array.isArray(ra)) {
      if (ra.length !== rb.length) return false;
      for (let j = 0; j < ra.length; j++) if (String(ra[j]) !== String(rb[j])) return false;
    } else if (String(ra) !== String(rb)) {
      return false;
    }
  }
  return true;
}

function scorecardUpdates(cards, current) {
  const sel = legendStationSet(current);
  const stats = sel ? pointStats(current) : null;
  const jobs = [];
  const layoutPatch = {};
  for (const card of cards || []) {
    const src = card.trace;
    const rows = heatmapStationRows(src);
    if (!rows) continue;

    let next = stats ? rebuildScorecard(src, stats, rows) : null;
    if (!next) {
      const res = sel ? filterHeatmapTrace(src, sel) : { trace: src, rows: rows };
      if (!res.rows) continue;
      next = {
        rows: res.rows,
        z: res.trace.z,
        text: res.trace.text,
        source: res.trace,
      };
    }

    const cur = current && current[card.index];
    if (cur && sameRows(heatmapStationRows(cur), next.rows) && sameCells(cur.text, next.text)) {
      continue;
    }

    const upd = { y: [next.rows.slice()] };
    if (next.z !== undefined) upd.z = [deepClone(next.z)];
    if (next.text !== undefined) upd.text = [deepClone(next.text)];
    if (next.source) {
      for (const key of ["hovertext", "customdata"]) {
        if (next.source[key] !== undefined) upd[key] = [deepClone(next.source[key])];
      }
    }
    jobs.push({ index: card.index, update: upd });
    if (card.catKey) layoutPatch[card.catKey] = next.rows.slice();
  }
  return { jobs: jobs, layout: layoutPatch };
}

const FIT_ROW_MAX_PX = 60;
const FIT_CBAR_MIN_PX = 70;
const FIT_CBAR_MAX_PX = 240;

function fitRowAxis(pd) {
  const fl = pd._fullLayout;
  if (!fl || !fl.yaxis || fl.yaxis2) return;
  const ya = fl.yaxis;
  const len = ya._length;
  if (!len || len < 60) return;

  let n = 0;
  if (ya.type === "category") {
    n = (ya._categories && ya._categories.length) || 0;
  } else if (Array.isArray(ya.tickvals)) {
    n = ya.tickvals.length;
  }
  if (!n || n > 60) return;

  const reversed = Array.isArray(ya.range) && ya.range[0] > ya.range[1];
  const key = n + "|" + Math.round(len) + "|" + (reversed ? 1 : 0);
  if (pd._wxRowFit === key) return;
  pd._wxRowFit = key;

  const slots = Math.max(n, len / FIT_ROW_MAX_PX);
  const pad = (slots - n) / 2;
  const lo = -0.5 - pad;
  const hi = n - 0.5 + pad;
  try {
    Plotly.relayout(pd, { "yaxis.range": reversed ? [hi, lo] : [lo, hi] });
  } catch (e) {}
}

function fitColorbars(pd) {
  const fl = pd._fullLayout;
  if (!fl) return;
  const ya = fl.yaxis;
  const len = (ya && ya._length) || fl.height;
  if (!len) return;

  const idx = [];
  (pd.data || []).forEach((tr, i) => {
    if (tr && tr.colorbar) idx.push(i);
  });
  if (!idx.length) return;

  const target = Math.round(Math.max(
    FIT_CBAR_MIN_PX,
    Math.min(len * 0.92, FIT_CBAR_MAX_PX)
  ));
  const key = target + "|" + idx.join(",");
  if (pd._wxCbarFit === key) return;
  pd._wxCbarFit = key;

  try {
    Plotly.restyle(pd, {
      "colorbar.lenmode": "pixels",
      "colorbar.len": target,
      "colorbar.y": 0.5,
      "colorbar.yanchor": "middle",
    }, idx);
  } catch (e) {}
}

const TICK_OVERHANG_PAD = 8;

function settleAngledTicks(pd) {
  if (pd._wxTickFix) return;
  const fl = pd._fullLayout;
  if (!fl || !fl.xaxis) return;
  const xa = fl.xaxis;
  if (xa.type !== "category" || !xa.tickangle) return;
  pd._wxTickFix = true;
  if (xa.automargin === "bottom") return;
  const size = fl._size || {};
  const r = Math.max(
    (fl.margin && fl.margin.r) || 0,
    (size.r || 0) + TICK_OVERHANG_PAD
  );
  try {
    Plotly.relayout(pd, { "xaxis.automargin": "bottom", "margin.r": r });
  } catch (e) {}
}

function fitPlot(pd) {
  if (!pd || !pd._wxDrawn || !pd._fullLayout || !pd.clientWidth) return;
  fitRowAxis(pd);
  fitColorbars(pd);
}

function graph(figDict, opts = {}) {
  const wrap = el("div", "wx-graph");
  const plotDiv = el("div", "wx-plot");
  plotDiv.style.width = "100%";
  wrap.appendChild(plotDiv);
  wrap._wxPlotDiv = plotDiv;

  let fitTimer = 0;
  const scheduleFit = () => {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = 0;
      fitPlot(plotDiv);
    }, 140);
  };
  wrap._wxFit = scheduleFit;

  wrap._wxResize = () => {
    if (!plotDiv._wxDrawn || !plotDiv._fullLayout) return;
    if (plotDiv.isConnected && plotDiv.clientWidth) {
      try { Plotly.Plots.resize(plotDiv); } catch (e) {}
      scheduleFit();
    }
  };
  if (!figDict) {
    wrap.appendChild(el("div", "unavailable", "Chart data unavailable."));
    return wrap;
  }

  let fig = figDict;
  let layout;

  if (isMobile()) {
    try {
      fig = buildMobileFigure(figDict, opts);
      layout = fig.layout;
    } catch (e) {
      fig = figDict;
      layout = null;
    }
  }

  if (!layout) {
    layout = Object.assign({}, figDict.layout || {});
    delete layout.width;
    layout.autosize = true;
    layout.height = opts.height || layout.height || 420;
    fig = figDict;
  }

  const height = layout.height;
  plotDiv.style.height = height + "px";

  const mobile = isMobile();
  const config = {
    responsive: true,
    displaylogo: false,
    displayModeBar: (mobile || opts.noModeBar) ? false : "hover",
  };
  if (mobile) {
    config.scrollZoom = false;
    config.doubleClick = false;
    config.showAxisDragHandles = false;
    config.showAxisRangeEntryBoxes = false;
    config.editable = false;
  }

  wrap._wxConfig = config;

  let selected = null;
  let mounted = false;
  let listening = false;
  let cards = [];
  let syncing = false;

  const syncScorecards = () => {
    if (syncing || !cards.length || !plotDiv.data) return;
    const res = scorecardUpdates(cards, plotDiv.data);
    if (!res.jobs.length) return;
    syncing = true;
    try {
      for (const job of res.jobs) Plotly.restyle(plotDiv, job.update, [job.index]);
      if (Object.keys(res.layout).length) Plotly.relayout(plotDiv, res.layout);
    } catch (e) {
      console.warn("scorecard sync failed", e);
    }
    requestAnimationFrame(() => { syncing = false; });
  };

  const draw = () => {
    const filtered = applyStationFilter({ data: fig.data || [], layout: layout }, selected);
    const prepared = prepareScorecards(filtered);
    cards = prepared.cards;
    if (mounted) {
      const next = mergeView(prepared.layout, captureView(plotDiv));
      Plotly.react(plotDiv, prepared.data, next, config)
        .then(() => {
          Plotly.Plots.resize(plotDiv);
          fitPlot(plotDiv);
        });
    } else {
      Plotly.newPlot(plotDiv, prepared.data, prepared.layout, config)
        .then(() => {
          mounted = true;
          plotDiv._wxDrawn = true;
          settleAngledTicks(plotDiv);
          if (!listening && typeof plotDiv.on === "function") {
            listening = true;
            plotDiv.on("plotly_restyle", syncScorecards);
          }
          Plotly.Plots.resize(plotDiv);
          fitPlot(plotDiv);
        });
    }
  };

  if (opts.stationFilter) {
    const stations = figureStations(fig.data);
    if (stations.length > 1) {
      const control = stationFilterControl(stations, (sel) => {
        selected = sel;
        if (!mounted) return;
        try {
          draw();
        } catch (e) {
          console.warn("station filter failed", e);
        }
      }, !mobile);
      if (mobile) {
        wrap.insertBefore(control, plotDiv);
      } else {
        wrap.style.position = "relative";
        wrap.appendChild(control);
      }
    }
  }

  const mount = () => {
    if (!plotDiv.isConnected || plotDiv.clientWidth === 0) {
      requestAnimationFrame(mount);
      return;
    }
    try {
      draw();
    } catch (e) {
      plotDiv.appendChild(el("div", "unavailable", "Chart failed to render."));
    }
  };
  requestAnimationFrame(mount);

  watchResize(plotDiv, () => {
    if (!plotDiv._wxDrawn || !plotDiv._fullLayout) return;
    if (!plotDiv.clientWidth) return;
    try { Plotly.Plots.resize(plotDiv); } catch (e) {}
    scheduleFit();
  });

  return wrap;
}

const CARD_ANIM_MS = 340;
const CARD_EASE = "cubic-bezier(.4,0,.2,1)";

const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M9.7 6.3 13.5 2.5M10.3 2.5h3.2v3.2M6.3 9.7 2.5 13.5M5.7 13.5H2.5v-3.2"/></svg>';

const COLLAPSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M13.5 2.5 9.7 6.3M9.7 3.1v3.2h3.2M2.5 13.5 6.3 9.7M6.3 12.9V9.7H3.1"/></svg>';

function ensureCardExpandStyles() {
  if (document.getElementById("wx-cardexpand-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-cardexpand-styles";
  const ease = "cubic-bezier(.4,0,.2,1)";
  st.textContent = [
    ".wx-expandable{position:relative;overflow:hidden;box-sizing:border-box;",
    "display:flex;flex-direction:column;",
    "transition:width .34s " + ease + ",height .34s " + ease + ",margin .34s " + ease + ",",
    "padding .34s " + ease + ",border-width .34s " + ease + ",border-color .2s ease,",
    "box-shadow .24s ease,opacity .22s ease;}",
    ".wx-expandable > .wx-graph{flex:1 1 auto;min-height:0;}",
    ".wx-expandable > .wx-graph > .wx-plot{height:100%!important;}",
    ".wx-expandable.wx-expanded{border-color:#dcd9d4;box-shadow:0 6px 22px rgba(0,0,0,.07);}",
    ".wx-card-collapsed{opacity:0;overflow:hidden;pointer-events:none;",
    "padding-left:0;padding-right:0;border-left-width:0;border-right-width:0;}",
    ".wx-expand-btn{position:absolute;top:8px;right:8px;z-index:30;width:26px;height:26px;",
    "padding:0;display:flex;align-items:center;justify-content:center;",
    "border:1px solid transparent;border-radius:6px;background:transparent;",
    "color:var(--text-muted,#8a857d);cursor:pointer;opacity:0;",
    "transition:opacity .15s ease,background-color .15s ease,border-color .15s ease,color .15s ease;}",
    ".wx-expandable:hover .wx-expand-btn,.wx-insight-shell:hover .wx-expand-btn,",
    ".wx-expand-btn:focus-visible{opacity:1;}",
    ".wx-expanded > .wx-expand-btn{opacity:1;}",
    ".wx-expand-btn:hover{background:#f3f2ef;border-color:var(--line,#e8e6e3);",
    "color:var(--text,#26231f);}",
    ".wx-expand-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;",
    "stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;}",
    ".wx-expandable .js-plotly-plot .modebar{transform:translateX(-30px)!important;}",
    ".wx-expandable .wx-stnf-float{right:40px;}",
    "@media (max-width:768px){.wx-expand-btn{display:none;}}",
    "@media (prefers-reduced-motion:reduce){.wx-expandable,.wx-expand-btn,",
    ".wx-expandable > .wx-graph > .wx-plot{transition:none!important;}}",
  ].join("");
  document.head.appendChild(st);
}

function findGraphWrap(node) {
  if (!node) return null;
  if (node.classList && node.classList.contains("wx-graph")) return node;
  return node.querySelector ? node.querySelector(".wx-graph") : null;
}

function siblingCard(c) {
  const row = c.parentNode;
  if (!row || !row.classList || !row.classList.contains("wx-chart-row")) return null;
  for (const node of row.children) {
    if (node !== c && node.classList && node.classList.contains("wx-card")) return node;
  }
  return null;
}

function siblingGraphResize(sib) {
  if (!sib) return () => {};
  const gw = sib.querySelector(".wx-graph");
  if (gw && typeof gw._wxResize === "function") return gw._wxResize;
  const pd = sib.querySelector(".wx-plot");
  return () => {
    if (pd && pd.clientWidth) {
      try { Plotly.Plots.resize(pd); } catch (e) {}
    }
  };
}

function setExpandButton(btn, on) {
  btn.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
  const label = on ? "Collapse" : "Expand";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-expanded", on ? "true" : "false");
}

function expandButton(onToggle) {
  const btn = el("button", "wx-expand-btn");
  btn.type = "button";
  setExpandButton(btn, false);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onToggle();
  });
  return btn;
}

function makeCardExpandable(c, child) {
  const graphWrap = findGraphWrap(child);
  if (!graphWrap) return;
  ensureCardExpandStyles();
  c.classList.add("wx-expandable");

  const plotDiv = graphWrap._wxPlotDiv || graphWrap.querySelector(".wx-plot");
  const resize = graphWrap._wxResize || (() => {
    if (plotDiv && plotDiv.clientWidth) {
      try { Plotly.Plots.resize(plotDiv); } catch (e) {}
    }
  });

  let baseH = 0;
  let rowGap = 16;
  let expanded = false;
  let timer = 0;
  let quiet = false;
  let plain = false;

  const seedHeight = () => {
    if (c.style.height) return;
    const h = Math.round(c.getBoundingClientRect().height);
    if (!h) {
      requestAnimationFrame(seedHeight);
      return;
    }
    baseH = h;
    c.style.height = h + "px";
    resize();
  };
  requestAnimationFrame(seedHeight);

  const rowOf = () => {
    const r = c.parentNode;
    return (r && r.classList && r.classList.contains("wx-chart-row")) ? r : null;
  };

  const targetHeight = (widens) => {
    const base = baseH || Math.round(c.getBoundingClientRect().height) || 452;
    if (widens) return base;
    return Math.min(4000, Math.max(Math.round(base * 1.6), base + 180));
  };

  const chromeSize = () => {
    const cr = c.getBoundingClientRect();
    const pr = plotDiv ? plotDiv.getBoundingClientRect() : null;
    if (!pr || !pr.width || !pr.height) return null;
    return [cr.width - pr.width, cr.height - pr.height];
  };

  const growWith = (from, chrome, finalW, finalH) => {
    if (!plotDiv || !chrome) return false;
    const fw = Math.round(finalW - chrome[0]);
    const fh = Math.round(finalH - chrome[1]);
    if (!(fw > 40) || !(fh > 40)) return false;
    if (from && Math.abs(fw - from[0]) < 2 && Math.abs(fh - from[1]) < 2) return false;
    try {
      Plotly.relayout(plotDiv, { autosize: false, width: fw, height: fh });
    } catch (e) {
      return false;
    }
    if (!from) return true;
    plotDiv.style.transition = "none";
    plotDiv.style.transformOrigin = "top left";
    plotDiv.style.transform =
      "scale(" + (from[0] / fw) + "," + (from[1] / fh) + ")";
    void plotDiv.offsetWidth;
    plotDiv.style.transition = "transform " + CARD_ANIM_MS + "ms " + CARD_EASE;
    plotDiv.style.transform = "scale(1,1)";
    return true;
  };

  const settle = () => {
    if (!plotDiv) return;
    plotDiv.style.transition = "";
    plotDiv.style.transform = "";
    plotDiv.style.transformOrigin = "";
    try {
      if (plotDiv.layout) {
        delete plotDiv.layout.width;
        delete plotDiv.layout.height;
      }
      Plotly.relayout(plotDiv, { autosize: true });
    } catch (e) {}
    resize();
  };

  const apply = (on) => {
    if (on === expanded) return;
    if (!baseH) baseH = Math.round(c.getBoundingClientRect().height) || 452;
    expanded = on;
    setExpandButton(btn, on);

    const from = !quiet && !plain && plotDiv && plotDiv.clientWidth
      ? [plotDiv.clientWidth, plotDiv.clientHeight]
      : null;
    const chrome = quiet ? null : chromeSize();

    c.classList.toggle("wx-expanded", on);

    const row = rowOf();
    const sib = row ? siblingCard(c) : null;
    let finalW = c.getBoundingClientRect().width;

    if (row && sib) {
      const rowW = row.clientWidth;
      const startC = c.getBoundingClientRect().width;
      const startS = sib.getBoundingClientRect().width;
      const startM = getComputedStyle(sib).marginLeft;
      if (on) rowGap = parseFloat(startM) || rowGap;
      c.style.flex = "0 0 auto";
      sib.style.flex = "0 0 auto";
      c.style.width = startC + "px";
      sib.style.width = startS + "px";
      sib.style.marginLeft = startM;
      void row.offsetWidth;
      if (on) {
        finalW = rowW;
        c.style.width = rowW + "px";
        sib.style.width = "0px";
        sib.style.marginLeft = "0px";
        sib.classList.add("wx-card-collapsed");
      } else {
        const half = Math.max(0, Math.round((rowW - rowGap) / 2));
        finalW = half;
        c.style.width = half + "px";
        sib.style.width = half + "px";
        sib.style.marginLeft = rowGap + "px";
        sib.classList.remove("wx-card-collapsed");
      }
    }

    const finalH = on ? targetHeight(!!(row && sib)) : baseH;
    c.style.height = finalH + "px";
    growWith(from, chrome, finalW, finalH);

    if (timer) clearTimeout(timer);
    const done = () => {
      timer = 0;
      if (!expanded && sib) {
        c.style.width = "";
        c.style.flex = "";
        sib.style.width = "";
        sib.style.flex = "";
        sib.style.marginLeft = "";
      }
      settle();
      if (sib) siblingGraphResize(sib)();
    };
    if (quiet) done();
    else timer = setTimeout(done, CARD_ANIM_MS + 40);
  };

  c._wxNoAnim = (fn) => {
    const prev = c.style.transition;
    c.style.transition = "none";
    quiet = true;
    try {
      fn();
    } finally {
      void c.offsetWidth;
      c.style.transition = prev;
      quiet = false;
    }
  };

  c._wxRebase = (h) => {
    if (!(h > 0)) return;
    baseH = Math.round(h);
    if (!expanded) {
      c.style.height = baseH + "px";
      return;
    }
    const r = rowOf();
    c.style.height = targetHeight(!!(r && siblingCard(c))) + "px";
    resize();
  };

  c._wxExpand = (on, noScale) => {
    plain = !!noScale;
    try {
      apply(!!on);
    } finally {
      plain = false;
    }
  };

  c._wxIsExpanded = () => expanded;

  const btn = expandButton(() => apply(!expanded));
  c.appendChild(btn);

  watchResize(c, () => {
    if (!expanded) return;
    const row = rowOf();
    if (row) c.style.width = row.clientWidth + "px";
    resize();
  });
}

function card(child, extraStyle, opts) {
  const c = el("div", "wx-card");
  if (extraStyle) Object.assign(c.style, extraStyle);
  c.appendChild(child);
  const fixed = !!(opts && opts.expandable === false);
  if (!isMobile() && !fixed) makeCardExpandable(c, child);
  return c;
}

function row(left, right) {
  const r = el("div", "wx-chart-row");
  r.appendChild(card(left));
  r.appendChild(card(right));
  return r;
}

const BOX_CARD_HEIGHT = 340;
const ROW_CARD_SCALE = 0.88;

function boxHeight() {
  return isMobile() ? undefined : BOX_CARD_HEIGHT;
}

function boxCard(fig) {
  return card(graph(fig, { height: boxHeight() }), null, { expandable: false });
}

function rowGraph(fig, opts) {
  const o = Object.assign({}, opts);
  if (!isMobile() && !o.height) {
    const natural = (fig && fig.layout && fig.layout.height) || 420;
    o.height = Math.round(natural * ROW_CARD_SCALE);
  }
  return graph(fig, o);
}

function unavailable() {
  return el("div", "unavailable", "Chart data unavailable.");
}

function stripTitle(figDict) {
  if (!figDict || !figDict.layout) return figDict;
  const fig = deepClone(figDict);
  delete fig.layout.title;
  const margin = fig.layout.margin || {};
  const top = typeof margin.t === "number" ? Math.min(margin.t, 40) : 40;
  fig.layout.margin = Object.assign({}, margin, { t: top });
  return fig;
}

function annotateEmptyPanels(figDict, message, subtitle) {
  if (!figDict || !figDict.layout || !Array.isArray(figDict.data)) return figDict;

  const used = usedAxisIds(figDict.data);
  const fig = deepClone(figDict);
  const layout = fig.layout;
  const notes = [];
  const fillers = [];

  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax || !Array.isArray(ax.domain)) continue;
    const idx = key === "xaxis" ? "" : key.slice(5);
    const axisId = "x" + idx;
    if (used.has(axisId)) continue;

    let ykey = "yaxis" + idx;
    if (typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor)) {
      ykey = "yaxis" + ax.anchor.slice(1);
    }
    const ay = layout[ykey];
    if (!ay || !Array.isArray(ay.domain)) continue;

    const blank = {
      showgrid: false, zeroline: false, showline: false,
      showticklabels: false, ticks: "", title: { text: "" },
    };
    Object.assign(ax, blank);
    Object.assign(ay, blank);

    const cx = (ax.domain[0] + ax.domain[1]) / 2;
    const cy = (ay.domain[0] + ay.domain[1]) / 2;

    notes.push({
      text: message,
      xref: "paper", yref: "paper",
      x: cx, y: subtitle ? cy + 0.03 : cy,
      xanchor: "center", yanchor: "middle",
      showarrow: false,
      font: { size: 12, color: "#94a3b8" },
    });
    if (subtitle) {
      notes.push({
        text: subtitle,
        xref: "paper", yref: "paper",
        x: cx, y: cy - 0.05,
        xanchor: "center", yanchor: "middle",
        showarrow: false,
        font: { size: 10.5, color: "#b4bcc8" },
      });
    }

    fillers.push({
      type: "scatter", mode: "markers", x: [], y: [],
      xaxis: axisId, yaxis: "y" + (ykey === "yaxis" ? "" : ykey.slice(5)),
      showlegend: false, hoverinfo: "skip",
    });
  }

  if (!notes.length) return figDict;

  layout.annotations = (layout.annotations || []).concat(notes);
  fig.data = fig.data.concat(fillers);
  return fig;
}

function ensureGridToggleStyles() {
  if (document.getElementById("wx-gridtoggle-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridtoggle-styles";
  st.textContent = [
    ".wx-grid-toggle{display:flex;align-items:center;justify-content:flex-end;",
    "gap:14px;min-height:26px;margin:4px 0 2px 0;padding:0 40px 0 6px;",
    "user-select:none;}",
    ".wx-grid-toggle .wx-stnf{flex:0 0 auto;margin:0;height:auto;}",
    ".wx-grid-seg{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;}",
    ".wx-grid-seg button{font-family:inherit;font-size:11px;font-weight:500;",
    "letter-spacing:.01em;line-height:1.4;color:var(--text-muted,#8a857d);",
    "background:transparent;border:1px solid transparent;border-radius:999px;",
    "padding:2px 9px;margin:0;cursor:pointer;",
    "transition:color .12s ease,border-color .12s ease,background-color .12s ease;}",
    ".wx-grid-seg button:hover{color:var(--text,#26231f);",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-grid-seg button.on{color:var(--text,#26231f);background:#f3f2ef;",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-grid-toggle label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;",
    "font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "text-transform:none;color:var(--text-muted,#8a857d);background:transparent;",
    "border:1px solid transparent;border-radius:999px;padding:2px 8px 2px 6px;",
    "transition:color .12s ease,border-color .12s ease;}",
    ".wx-grid-toggle label:hover{color:var(--text,#26231f);border-color:var(--line,#e8e6e3);}",
    ".wx-grid-toggle label.on{color:var(--text,#26231f);}",
    ".wx-grid-toggle input[type=\"checkbox\"]{cursor:pointer;width:12px;height:12px;margin:0;",
    "accent-color:var(--accent,#2563eb);}",
    "@media (max-width:768px){.wx-grid-toggle{min-height:0;margin:2px 0;",
    "padding:0 6px;}}",
  ].join("");
  document.head.appendChild(st);
}

function gridAxisStations(fig) {
  const map = new Map();
  for (const tr of (fig && fig.data) || []) {
    const ht = tr && tr.hovertemplate;
    if (typeof ht !== "string") continue;
    const m = /^<b>(.*?)<\/b>/.exec(ht);
    if (!m) continue;
    const id = tr.xaxis || "x";
    if (!map.has(id)) map.set(id, m[1].trim());
  }
  return map;
}

function isAlertTrace(tr) {
  if (!tr) return false;
  if (tr.meta && tr.meta.band_hover) return true;
  return tr.mode === "markers" && !tr.hovertemplate;
}

function gridStationNames(fig) {
  const anns = (fig && fig.layout && fig.layout.annotations) || [];
  const names = [];
  const seen = new Set();
  for (const a of anns) {
    if (!a || typeof a.text !== "string") continue;
    const t = a.text.replace(/<[^>]*>/g, "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    names.push(t);
  }
  return names;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stationRanges(text, names) {
  const ordered = names.slice().sort((a, b) => b.length - a.length);
  const re = new RegExp("(?:" + ordered.map(escapeRegex).join("|") + ")", "g");
  const ranges = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    const prev = from > 0 ? text.charAt(from - 1) : " ";
    const next = to < text.length ? text.charAt(to) : " ";
    if (/[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(next)) continue;
    ranges.push({ start: from, end: to, name: m[0] });
  }

  const exact = new Set(names);
  let offset = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && colon <= 44) {
      const label = line.slice(0, colon).trim();
      if (label && label === label.toUpperCase()) {
        const from = offset + line.indexOf(label);
        const to = from + label.length;
        const covered = ranges.some(r => r.start < to && r.end > from);
        if (!covered) {
          let hit = exact.has(label) ? label : null;
          if (!hit) hit = ordered.find(n => n.indexOf(label) === 0 || label.indexOf(n) === 0);
          if (hit) ranges.push({ start: from, end: to, name: hit });
        }
      }
    }
    offset += line.length + 1;
  }

  ranges.sort((a, b) => a.start - b.start);
  const out = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    out.push(r);
    lastEnd = r.end;
  }
  return out;
}

function applyStationRanges(block, ranges, onPick) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.nodeValue.length;
    nodes.push({ node: node, start: pos, end: pos + len });
    pos += len;
  }

  const groups = new Map();

  for (const item of nodes) {
    const hits = [];
    ranges.forEach((r, id) => {
      const s = Math.max(r.start, item.start);
      const e = Math.min(r.end, item.end);
      if (e > s) hits.push({ s: s - item.start, e: e - item.start, id: id, name: r.name });
    });
    if (!hits.length) continue;
    hits.sort((a, b) => a.s - b.s);

    const text = item.node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const hit of hits) {
      if (hit.s > last) frag.appendChild(document.createTextNode(text.slice(last, hit.s)));
      const span = el("span", "wx-stn-link");
      span.textContent = text.slice(hit.s, hit.e);
      span.dataset.station = hit.name;
      span.title = "Open " + hit.name + " chart";
      span.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onPick(hit.name);
      });
      frag.appendChild(span);
      if (!groups.has(hit.id)) groups.set(hit.id, []);
      groups.get(hit.id).push(span);
      last = hit.e;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (item.node.parentNode) item.node.parentNode.replaceChild(frag, item.node);
  }

  for (const spans of groups.values()) {
    const set = (on) => {
      for (const s of spans) s.classList.toggle("wx-stn-hot", on);
    };
    for (const span of spans) {
      span.addEventListener("mouseenter", () => set(true));
      span.addEventListener("mouseleave", () => set(false));
    }
  }
}

function linkifyStations(root, names, onPick) {
  if (!root || !names || !names.length) return;
  let blocks = root.querySelectorAll ? root.querySelectorAll("code") : null;
  if (!blocks || !blocks.length) blocks = [root];
  for (const block of blocks) {
    const text = block.textContent || "";
    if (!text) continue;
    const ranges = stationRanges(text, names);
    if (ranges.length) applyStationRanges(block, ranges, onPick);
  }
}

function ensureInsightStyles() {
  if (document.getElementById("wx-insight-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-insight-styles";
  st.textContent = [
    ".wx-insight-shell{position:relative;margin-bottom:16px;}",
    ".wx-insight-shell > .wx-ov-wrap{max-height:180px;",
    "transition:max-height .34s cubic-bezier(.4,0,.2,1);}",
    ".wx-insight-shell > .wx-expand-btn{right:16px;background:var(--surface,#fff);",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-stn-link{cursor:pointer;border-bottom:1px dotted currentColor;}",
    ".wx-stn-link.wx-stn-hot{background:#dbeafe;}",
    "@media (max-width:768px){.wx-insight-shell{margin-bottom:10px;}}",
  ].join("");
  document.head.appendChild(st);
}

function makeBoxExpandable(shell, target) {
  ensureCardExpandStyles();
  const baseMax = Math.round(parseFloat(getComputedStyle(target).maxHeight)) || 180;
  let expanded = false;
  let timer = 0;

  const btn = expandButton(() => {
    expanded = !expanded;
    setExpandButton(btn, expanded);
    shell.classList.toggle("wx-expanded", expanded);
    if (timer) clearTimeout(timer);
    if (expanded) {
      const cap = Math.max(baseMax + 160, Math.round((window.innerHeight || 900) * 0.7));
      target.style.maxHeight = Math.min(target.scrollHeight + 4, cap) + "px";
    } else {
      target.style.maxHeight = baseMax + "px";
      timer = setTimeout(() => {
        timer = 0;
        if (!expanded) target.style.maxHeight = "";
      }, CARD_ANIM_MS + 40);
    }
  });
  shell.appendChild(btn);

  let tries = 0;
  const checkFit = () => {
    if (!shell.isConnected) {
      if (tries++ < 180) requestAnimationFrame(checkFit);
      return;
    }
    btn.style.display = target.scrollHeight > target.clientHeight + 4 ? "" : "none";
  };
  requestAnimationFrame(checkFit);
}

const GRID_H_SPACING = 0.012;
const GRID_V_SPACING_NUM = 0.3;
const GRID_V_SPACING_MIN = 0.006;
const GRID_ROW_PX = 54;
const GRID_PAD_PX = 40;
const GRID_ZONE_PAD_Y = 0.005;
const GRID_ZONE_EDGE_LEFT = 0.02;
const GRID_ZONE_EDGE_RIGHT = 0.01;
const GRID_HOVER_TEXT = "#26231f";
const GRID_Y_PAD = 0.05;
const GRID_COL_RE = /<\/b><br>([A-Za-z0-9_]+):/;
const DETAIL_COL_RE = /^([A-Za-z0-9_]+)/;

function gridColumnName(fig) {
  for (const tr of (fig && fig.data) || []) {
    const ht = tr && tr.hovertemplate;
    if (typeof ht !== "string") continue;
    const m = GRID_COL_RE.exec(ht);
    if (m) return m[1];
  }
  return null;
}

function detailColumnName(dpd) {
  for (const tr of (dpd && dpd.data) || []) {
    if (!tr || (tr.yaxis || "y") !== "y" || tr.mode === "markers") continue;
    const ht = tr.hovertemplate;
    if (typeof ht !== "string" || ht.indexOf(":") < 1) continue;
    const m = DETAIL_COL_RE.exec(ht);
    if (m) return m[1];
  }
  return null;
}

function stackYRange(fig, placed, base) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const tr of (fig && fig.data) || []) {
    if (!placed.has(tr.xaxis || "x") || isAlertTrace(tr)) continue;
    const y = decodeArray(tr.y) || (Array.isArray(tr.y) ? tr.y : null);
    if (!y) continue;
    for (let i = 0; i < y.length; i++) {
      const v = Number(y[i]);
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi >= lo) {
    const span = hi - lo;
    const pad = span > 0 ? span * GRID_Y_PAD : Math.max(Math.abs(hi) * GRID_Y_PAD, 1);
    lo -= pad;
    hi += pad;
  } else if (!base) {
    return null;
  } else {
    lo = Infinity;
    hi = -Infinity;
  }
  if (base) {
    const b0 = Number(base[0]);
    const b1 = Number(base[1]);
    if (isFinite(b0) && isFinite(b1)) {
      lo = Math.min(lo, Math.min(b0, b1));
      hi = Math.max(hi, Math.max(b0, b1));
    }
  }
  return isFinite(lo) && isFinite(hi) && hi > lo ? [lo, hi] : null;
}

function gridCells(fig) {
  const layout = (fig && fig.layout) || {};
  const stations = gridAxisStations(fig);
  const out = [];
  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax || !Array.isArray(ax.domain) || ax.visible === false) continue;
    const idx = key === "xaxis" ? "" : key.slice(5);
    const id = "x" + idx;
    const station = stations.get(id);
    if (!station) continue;
    const anchor =
      typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor) ? ax.anchor : "y" + idx;
    const ykey = "yaxis" + anchor.slice(1);
    const ay = layout[ykey];
    if (!ay || !Array.isArray(ay.domain)) continue;
    out.push({
      id: id,
      xkey: key,
      ykey: ykey,
      station: station,
      x0: ax.domain[0],
      x1: ax.domain[1],
      y0: ay.domain[0],
      y1: ay.domain[1],
      matches: typeof ax.matches === "string" ? ax.matches : null,
    });
  }
  return out;
}

function gridZoneKey(cell) {
  return cell.matches || cell.id;
}

function gridZoneFills(fig, cells) {
  const shapes = ((fig.layout && fig.layout.shapes) || []).filter(
    (s) => s && String(s.xref) === "paper" && String(s.yref) === "paper"
  );
  const boxes = new Map();
  for (const cell of cells) {
    const key = gridZoneKey(cell);
    const box = boxes.get(key);
    if (!box) {
      boxes.set(key, { x0: cell.x0, x1: cell.x1, y0: cell.y0, y1: cell.y1 });
      continue;
    }
    box.y0 = Math.min(box.y0, cell.y0);
    box.y1 = Math.max(box.y1, cell.y1);
  }
  const out = new Map();
  for (const [key, box] of boxes) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const hit = shapes.find(
      (s) =>
        Math.min(s.x0, s.x1) <= cx &&
        cx <= Math.max(s.x0, s.x1) &&
        Math.min(s.y0, s.y1) <= cy &&
        cy <= Math.max(s.y0, s.y1)
    );
    if (hit && hit.fillcolor) out.set(key, hit.fillcolor);
  }
  return out;
}

function packGrid(cells, selected, stack, align) {
  const wanted = selected && selected.size
    ? cells.filter((c) => selected.has(c.station))
    : cells;
  const use = wanted.length ? wanted : cells;

  const order = [];
  const byCol = new Map();

  if (stack) {
    order.push({ key: "0", x0: 0 });
    byCol.set("0", use.slice().sort((a, b) => a.x0 - b.x0 || b.y0 - a.y0));
  } else {
    for (const cell of use) {
      const key = cell.x0.toFixed(4);
      if (!byCol.has(key)) {
        byCol.set(key, []);
        order.push({ key: key, x0: cell.x0 });
      }
      byCol.get(key).push(cell);
    }
    order.sort((a, b) => a.x0 - b.x0);
  }

  const cols = order.length;
  const spread = align && align[1] > align[0];
  const width = spread ? align[1] - align[0] : (1 - GRID_H_SPACING * (cols - 1)) / cols;
  let rows = 0;
  for (const col of order) rows = Math.max(rows, byCol.get(col.key).length);
  const gap = Math.max(GRID_V_SPACING_MIN, GRID_V_SPACING_NUM / Math.max(rows, 1));
  const height = (1 - gap * (rows - 1)) / rows;

  const colX = spread ? () => align[0] : (j) => j * (width + GRID_H_SPACING);
  const placed = new Map();
  const list = [];

  order.forEach((col, j) => {
    const items = stack
      ? byCol.get(col.key)
      : byCol.get(col.key).slice().sort((a, b) => b.y0 - a.y0);
    items.forEach((cell, i) => {
      const y1 = 1 - i * (height + gap);
      const spot = {
        cell: cell,
        col: j,
        x0: colX(j),
        x1: colX(j) + width,
        y0: Math.max(0, y1 - height),
        y1: y1,
      };
      placed.set(cell.id, spot);
      list.push(spot);
    });
  });

  return {
    placed: placed,
    list: list,
    cols: cols,
    rows: rows,
    width: width,
    colX: colX,
  };
}

function gridRowPx(fig, cells) {
  const total = (fig.layout && fig.layout.height) || 0;
  const rows = new Set(cells.map((c) => c.y0.toFixed(4))).size;
  if (!total || !rows) return GRID_ROW_PX;
  const px = (total - GRID_PAD_PX) / rows;
  return px > 8 ? px : GRID_ROW_PX;
}

function buildGridFigure(fig, cells, fills, rowPx, selected, link, ranges) {
  const stack = !!(selected && selected.size);
  const align = stack && link && link.align ? link.align : null;
  const layout = deepClone(fig.layout || {});
  const pack = packGrid(cells, selected, stack, align);
  const placed = pack.placed;

  for (const cell of cells) {
    const ax = layout[cell.xkey];
    const ay = layout[cell.ykey];
    const spot = placed.get(cell.id);
    if (!ax || !ay || !spot) continue;
    ax.visible = true;
    ay.visible = true;
    ax.domain = [spot.x0, spot.x1];
    ay.domain = [spot.y0, spot.y1];
  }

  if (stack) {
    for (const key of Object.keys(layout)) {
      if (!/^xaxis\d*$/.test(key)) continue;
      const ax = layout[key];
      if (!ax) continue;
      const idx = key === "xaxis" ? "" : key.slice(5);
      if (placed.has("x" + idx)) continue;
      const anchor =
        typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor) ? ax.anchor : "y" + idx;
      delete layout["yaxis" + anchor.slice(1)];
      delete layout[key];
    }
  } else {
    for (const cell of cells) {
      if (placed.has(cell.id)) continue;
      if (layout[cell.xkey]) layout[cell.xkey].visible = false;
      if (layout[cell.ykey]) layout[cell.ykey].visible = false;
    }
  }

  const groups = [];
  if (stack) {
    if (pack.list.length) groups.push(pack.list.map((spot) => spot.cell));
  } else {
    const zones = new Map();
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!zones.has(key)) zones.set(key, []);
      zones.get(key).push(spot.cell);
    }
    for (const list of zones.values()) groups.push(list);
  }

  let anchorKey = null;
  for (const list of groups) {
    list.sort((a, b) => placed.get(b.id).y1 - placed.get(a.id).y1);
    const anchor = list[0];
    delete layout[anchor.xkey].matches;
    anchorKey = anchor.xkey;
    for (const cell of list.slice(1)) layout[cell.xkey].matches = anchor.id;
    if (!ranges) continue;
    let r = null;
    for (const cell of list) {
      const hit = ranges.get(cell.station);
      if (hit) {
        r = hit;
        break;
      }
    }
    if (!r) continue;
    for (const cell of list) {
      const ax = layout[cell.xkey];
      if (!ax) continue;
      ax.range = [r[0], r[1]];
      ax.autorange = false;
    }
  }

  const byStation = new Map();
  for (const cell of cells) byStation.set(cell.station, cell);

  if (Array.isArray(layout.annotations)) {
    const kept = [];
    for (const a of layout.annotations) {
      const cell = a && typeof a.text === "string"
        ? byStation.get(a.text.replace(/<[^>]*>/g, "").trim())
        : null;
      if (!cell) {
        kept.push(a);
        continue;
      }
      const spot = placed.get(cell.id);
      if (!spot) {
        if (stack) continue;
        a.visible = false;
        kept.push(a);
        continue;
      }
      a.visible = true;
      a.y = spot.y1 - 0.002;
      if (!a.xref || a.xref === "paper") a.x = (spot.x0 + spot.x1) / 2;
      kept.push(a);
    }
    layout.annotations = kept;
  }

  const bands = [];
  if (stack) {
    let run = null;
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!run || run.key !== key) {
        run = { key: key, spots: [] };
        bands.push(run);
      }
      run.spots.push(spot);
    }
  } else {
    const byZone = new Map();
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!byZone.has(key)) byZone.set(key, { key: key, spots: [] });
      byZone.get(key).spots.push(spot);
    }
    for (const band of byZone.values()) bands.push(band);
  }

  const shapes = [];
  for (const band of bands) {
    const fill = fills.get(band.key);
    if (!fill) continue;
    const j = band.spots[0].col;
    const x0 = pack.colX(j);
    const x1 = x0 + pack.width;
    const left = j > 0
      ? (pack.colX(j - 1) + pack.width + x0) / 2
      : Math.max(0, x0 - GRID_ZONE_EDGE_LEFT);
    const right = j < pack.cols - 1
      ? (x1 + pack.colX(j + 1)) / 2
      : Math.min(1, x1 + GRID_ZONE_EDGE_RIGHT);
    let top = -Infinity;
    let bottom = Infinity;
    for (const spot of band.spots) {
      top = Math.max(top, spot.y1);
      bottom = Math.min(bottom, spot.y0);
    }
    shapes.push({
      type: "rect",
      xref: "paper",
      yref: "paper",
      x0: left,
      x1: right,
      y0: Math.max(0, bottom - GRID_ZONE_PAD_Y),
      y1: Math.min(1, top + GRID_ZONE_PAD_Y),
      fillcolor: fill,
      line: { width: 0 },
      layer: "below",
    });
  }

  for (const s of (fig.layout && fig.layout.shapes) || []) {
    const xref = s && s.xref ? String(s.xref) : "";
    if (!xref || xref === "paper" || xref.charAt(0) !== "x") continue;
    if (!placed.has(xref.split(" ")[0])) continue;
    shapes.push(deepClone(s));
  }
  layout.shapes = shapes;

  const data = [];
  for (const tr of fig.data || []) {
    const on = placed.has(tr.xaxis || "x");
    if (stack && !on) continue;
    const out = Object.assign({}, tr);
    out.visible = on ? true : false;
    data.push(out);
  }

  if (stack) {
    layout.hovermode = "x unified";
    layout.hoverlabel = Object.assign({}, layout.hoverlabel, {
      bgcolor: "white",
      bordercolor: "#e8e6e3",
      align: "left",
      font: Object.assign({ size: 11 }, (layout.hoverlabel || {}).font, {
        color: GRID_HOVER_TEXT,
      }),
    });
    if (link && link.range && anchorKey && layout[anchorKey]) {
      layout[anchorKey].range = link.range.slice();
      layout[anchorKey].autorange = false;
    }
  }

  let yRange = null;
  if (stack) {
    yRange = stackYRange(fig, placed, link && link.yRange ? link.yRange : null);
    if (yRange) {
      for (const cell of cells) {
        const ay = placed.has(cell.id) ? layout[cell.ykey] : null;
        if (!ay) continue;
        ay.range = yRange.slice();
        ay.autorange = false;
      }
    }
  }

  delete layout.width;
  layout.autosize = true;
  layout.height = Math.round(pack.rows * rowPx + GRID_PAD_PX);

  return { data: data, layout: layout, yRange: yRange };
}

function stationGrid(c, views) {
  const list = (views && views.length ? views : [{ key: "station_grid" }])
    .filter((v) => c && c[v.key]);
  if (!list.length) return el("div");

  let fig = c[list[0].key];
  const h = (fig.layout && fig.layout.height) || 400;
  const wrap = el("div", "station-grid");

  const known = new Set();
  for (const v of list) {
    for (const name of gridStationNames(c[v.key])) known.add(name);
  }
  wrap._wxStations = Array.from(known);
  wrap._wxAxisStations = new Map();

  let cells = [];
  let fills = null;
  let rowPx = 0;
  let gridCol = null;
  let baseSlots = null;
  let pendingRanges = null;

  const useFigure = (key) => {
    fig = c[key];
    captureStationAnnotations(fig, wrap._wxStations);
    wrap._wxAxisStations.clear();
    for (const [id, name] of gridAxisStations(fig)) {
      wrap._wxAxisStations.set(id, name);
    }
    cells = gridCells(fig);
    fills = gridZoneFills(fig, cells);
    rowPx = gridRowPx(fig, cells);
    gridCol = gridColumnName(fig);
    if (!baseSlots) {
      baseSlots = new Map();
      for (const cell of cells) {
        baseSlots.set(cell.station, [cell.x0, cell.x1, cell.y0, cell.y1]);
      }
      return;
    }
    for (const cell of cells) {
      const slot = baseSlots.get(cell.station);
      if (!slot) continue;
      cell.x0 = slot[0];
      cell.x1 = slot[1];
      cell.y0 = slot[2];
      cell.y1 = slot[3];
    }
  };
  useFigure(list[0].key);

  const g = graph(fig, { height: h, noModeBar: true });

  let selected = null;
  let autoExpanded = false;
  wrap._wxStacked = false;

  const linkGeom = () => {
    const pd = g._wxPlotDiv;
    const dpd = panelPlot(wrap._wxPanel);
    if (!pd || !dpd || !pd._fullLayout || !dpd._fullLayout) return null;
    const gs = pd._fullLayout._size;
    const ds = dpd._fullLayout._size;
    const dxa = dpd._fullLayout.xaxis;
    if (!gs || !ds || !dxa || !(gs.w > 0) || !(ds.w > 0)) return null;
    const gr = pd.getBoundingClientRect();
    const dr = dpd.getBoundingClientRect();
    if (!gr.width || !dr.width) return null;
    const x0 = (dr.left + ds.l - gr.left - gs.l) / gs.w;
    const x1 = (dr.left + ds.l + ds.w - gr.left - gs.l) / gs.w;
    if (!(x1 > x0)) return null;
    const dcol = detailColumnName(dpd);
    const shared =
      gridCol && dcol && dcol.toLowerCase() === gridCol.toLowerCase();
    return {
      align: [Math.max(0, Math.min(1, x0)), Math.max(0, Math.min(1, x1))],
      range: Array.isArray(dxa.range) ? dxa.range.slice() : null,
      yRange: shared ? axisRange(dpd._fullLayout, "yaxis") : null,
    };
  };

  const captureRanges = () => {
    const pd = g._wxPlotDiv;
    const fl = pd && pd._fullLayout;
    if (!fl) return null;
    const out = new Map();
    for (const cell of cells) {
      const xa = fl[cell.xkey];
      if (!xa || xa.visible === false) continue;
      if (!Array.isArray(xa.range) || xa.range.length !== 2) continue;
      out.set(cell.station, [xa.range[0], xa.range[1]]);
    }
    return out.size ? out : null;
  };

  const render = () => {
    if (!cells.length) return true;
    const pd = g._wxPlotDiv;
    if (!pd || !pd.data || !pd.isConnected) return false;

    const useRanges = pendingRanges;
    pendingRanges = null;

    const filtered = !!(selected && selected.size);
    wrap._wxStacked = filtered;
    if (!filtered) {
      if (typeof wrap._wxSpikeOff === "function") wrap._wxSpikeOff();
      const open = panelPlot(wrap._wxPanel);
      if (open) dropHover(open);
      if (open && wrap._wxYPushed) {
        wrap._wxYPushed = false;
        try {
          Plotly.relayout(open, { "yaxis.autorange": true });
        } catch (e) {
          void e;
        }
      }
    }
    const link = filtered ? linkGeom() : null;
    let next;
    try {
      next = buildGridFigure(
        fig, cells, fills, rowPx, selected, link, useRanges
      );
    } catch (e) {
      console.warn("station grid filter failed", e);
      return true;
    }
    if (isMobile()) {
      try {
        next = buildMobileFigure(next, { height: next.layout.height });
      } catch (e) {
        void e;
      }
    }

    const natural = next.layout.height;
    const chrome = Math.max(
      0,
      Math.round(wrap.getBoundingClientRect().height - pd.getBoundingClientRect().height)
    );

    const canExpand = typeof wrap._wxExpand === "function";
    const isOpen = () => !!(wrap._wxIsExpanded && wrap._wxIsExpanded());

    const collapsing = canExpand && !filtered && autoExpanded;
    const applyHeight = () => {
      if (collapsing) {
        autoExpanded = false;
        wrap._wxExpand(false);
      }
      if (typeof wrap._wxRebase === "function") wrap._wxRebase(natural + chrome);
    };

    if (collapsing && typeof wrap._wxNoAnim === "function") wrap._wxNoAnim(applyHeight);
    else applyHeight();

    if (canExpand && isOpen()) {
      delete next.layout.height;
      next.layout.autosize = true;
    } else {
      pd.style.height = natural + "px";
    }

    try {
      Plotly.react(pd, next.data, next.layout, g._wxConfig);
    } catch (e) {
      console.warn("station grid redraw failed", e);
      return true;
    }

    if (link && link.yRange && next.yRange) {
      const dpd = panelPlot(wrap._wxPanel);
      if (dpd) {
        wrap._wxYPushed = true;
        pushRange(dpd, "yaxis", next.yRange);
      }
    }

    if (canExpand && filtered && !isOpen()) {
      autoExpanded = true;
      wrap._wxExpand(true, true);
    } else if (typeof g._wxFit === "function") {
      g._wxFit();
    }
    return true;
  };

  const apply = () => {
    const tryApply = () => {
      if (!render()) requestAnimationFrame(tryApply);
    };
    tryApply();
  };

  wrap._wxRefresh = () => {
    if (selected && selected.size) apply();
  };

  const names = Array.from(new Set(Array.from(wrap._wxAxisStations.values()))).sort(
    (a, b) => a.localeCompare(b)
  );

  let bar = null;
  if (names.length > 1 || list.length > 1) {
    ensureGridToggleStyles();
    bar = el("div", "wx-grid-toggle");
  }

  if (bar && list.length > 1) {
    const seg = el("div", "wx-grid-seg");
    const buttons = [];
    let active = list[0].key;
    for (const v of list) {
      const btn = el("button", v.key === active ? "on" : null, v.label || v.key);
      btn.type = "button";
      buttons.push({ btn: btn, key: v.key });
      btn.addEventListener("click", () => {
        if (v.key === active) return;
        pendingRanges = captureRanges();
        active = v.key;
        for (const b of buttons) b.btn.className = b.key === active ? "on" : "";
        useFigure(active);
        apply();
      });
      seg.appendChild(btn);
    }
    bar.appendChild(seg);
  }

  if (bar && names.length > 1) {
    const ctl = stationFilterControl(names, (sel) => {
      selected = sel;
      apply();
    }, false);
    wrap._wxClearFilter = () =>
      typeof ctl._wxClear === "function" ? ctl._wxClear() : false;
    bar.appendChild(ctl);
  }

  if (bar) wrap.appendChild(bar);

  wrap.appendChild(g);
  wrap._wxGridPlot = g._wxPlotDiv;
  wrap._wxGraphWrap = g;
  if (!isMobile()) makeCardExpandable(wrap, g);
  wireGridStationClicks(wrap);

  return wrap;
}

async function insightBanner(fc, hours, tab, panel) {
  const source = INSIGHT_SOURCES.find((s) => s[0] === tab);
  const [text, palette] = await Promise.all([
    loadText(fc, hours, `insights_${tab}`),
    loadCharts(fc, hours, `insights_${tab}`),
  ]);

  const findings = source ? parseFindings(text || "", source) : [];
  if (!findings.length) {
    return el("div", "insight-empty", "No alerts");
  }

  const colors = colorMap(palette);
  for (const f of findings) {
    f.color = colors.get(colorKey(f.section, f.station)) || null;
  }
  applySeverity(findings);

  ensureOverviewStyles();
  ensureInsightStyles();

  const shell = el("div", "wx-insight-shell");
  const wrap = overviewTable(findings, panel, TAB_COLUMNS);
  shell.appendChild(wrap);
  makeBoxExpandable(shell, wrap);
  return shell;
}

const OVERVIEW_TAB = "tab-overview";

const INSIGHT_SOURCES = [
  ["rh", "tab-rh", "RH"],
  ["wind", "tab-wind", "Wind"],
  ["temp", "tab-temp", "Temp"],
  ["rn1", "tab-rn1", "Precip"],
  ["power", "tab-power", "Power"],
];

const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const BRACKET_STAMP_RE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g;

const TIME_BRACKET_RE =
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d|ongoing|since|last |until |from /i;

const STAMP_FUTURE_SLACK_MS = 30 * 24 * 3600 * 1000;

const FINDING_LABEL_MAX = 44;

function bracketStamp(when) {
  if (!when) return null;
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  let best = null;
  let m;
  BRACKET_STAMP_RE.lastIndex = 0;
  while ((m = BRACKET_STAMP_RE.exec(when)) !== null) {
    const mon = MONTH_INDEX[m[1]];
    if (mon === undefined) continue;
    const day = Number(m[2]);
    const hh = m[3] ? Number(m[3]) : 0;
    const mm = m[4] ? Number(m[4]) : 0;
    let ms = Date.UTC(year, mon, day, hh, mm);
    if (ms > now + STAMP_FUTURE_SLACK_MS) ms = Date.UTC(year - 1, mon, day, hh, mm);
    if (best === null || ms > best) best = ms;
  }
  return best;
}

function stripInsightWrapper(text) {
  let out = String(text || "");
  if (out.startsWith("<!-- hash:")) {
    const nl = out.indexOf("\n");
    out = nl >= 0 ? out.slice(nl + 1) : "";
  }
  out = out.trim();
  if (out.startsWith("```")) {
    out = out.slice(3);
    if (out.endsWith("```")) out = out.slice(0, -3);
  }
  return out.trim();
}

function parseFindings(text, source) {
  const out = [];
  let section = "";
  for (const raw of stripInsightWrapper(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    const label = colon > 0 ? line.slice(0, colon).trim() : "";
    const isFinding =
      !!label &&
      colon <= FINDING_LABEL_MAX &&
      label === label.toUpperCase() &&
      /[A-Z0-9]/.test(label);
    if (!isFinding) {
      section = line.trim();
      continue;
    }
    let detail = line.slice(colon + 1).trim();
    let when = "";
    const bracket = /\s*\[([^\]]+)\]$/.exec(detail);
    if (bracket && TIME_BRACKET_RE.test(bracket[1])) {
      when = bracket[1].trim();
      detail = detail.slice(0, bracket.index).trim();
    }
    if (!detail) continue;
    out.push({
      station: label,
      section: section,
      detail: detail,
      when: when,
      ongoing: /ongoing/i.test(when),
      at: bracketStamp(when),
      tab: source[1],
      area: source[2],
    });
  }
  return out;
}

function colorKey(section, station) {
  return String(section || "") + "\u0000" + String(station || "");
}

function colorMap(records) {
  const map = new Map();
  if (!Array.isArray(records)) return map;
  for (const r of records) {
    if (!r || !r.color) continue;
    map.set(colorKey(r.section, r.station), String(r.color));
  }
  return map;
}

async function collectFindings(fc, hours) {
  const [texts, palettes] = await Promise.all([
    Promise.all(
      INSIGHT_SOURCES.map((s) => loadText(fc, hours, `insights_${s[0]}`))
    ),
    Promise.all(
      INSIGHT_SOURCES.map((s) => loadCharts(fc, hours, `insights_${s[0]}`))
    ),
  ]);
  const out = [];
  texts.forEach((text, i) => {
    if (!text) return;
    const palette = colorMap(palettes[i]);
    for (const f of parseFindings(text, INSIGHT_SOURCES[i])) {
      f.color = palette.get(colorKey(f.section, f.station)) || null;
      out.push(f);
    }
  });
  return applySeverity(out);
}

const SEVERITY_CATEGORY_STEP = 100;
const SEVERITY_DURATION_WEIGHT = 12;
const SEVERITY_MAGNITUDE_WEIGHT = 12;
const SEVERITY_FREQUENCY_WEIGHT = 8;
const SEVERITY_ONGOING_BONUS = 4;
const SEVERITY_DRY_PERSIST_BONUS = 4;

const SEVERITY_MAX_MODIFIER =
  SEVERITY_DURATION_WEIGHT +
  SEVERITY_MAGNITUDE_WEIGHT +
  SEVERITY_FREQUENCY_WEIGHT +
  SEVERITY_ONGOING_BONUS +
  SEVERITY_DRY_PERSIST_BONUS;

const SEVERITY_RANK_FLOOR = 26;

const SEVERITY_DEFAULT_RANK = 25;

const SEVERITY_AREA_DEFAULT_RANK = {
  Power: 3,
  RH: 22,
  Wind: 24,
  Temp: 23,
  Precip: 21,
  Data: 22,
};

const SEV_RE = {
  readings: /^(\d+)\s+reading/i,
  events: /^(\d+)\s+event/i,
  shifts: /^(\d+)\s+shift/i,
  hours: /^(\d+)\s+hour/i,
  uncorrelated: /^(\d+)\s+uncorrelated/i,
  parenReadings: /\((\d+)\s+reading/i,
  parenDays: /\((\d+)\s+day/i,
  pctOfDays: /\((\d+(?:\.\d+)?)\s*%\s+of\s+days/i,
  rhMax: /max\s+(-?\d+(?:\.\d+)?)\s*%/i,
  rhPeak: /peak\s+\u0394\s*([+-]?\d+(?:\.\d+)?)\s*%\/h/i,
  tempPeak: /peak\s+([+-]?\d+(?:\.\d+)?)\s*\u00b0C\/h/i,
  peakKmh: /peak\s+(-?\d+(?:\.\d+)?)\s*km\/h/i,
  leadKmh: /^(-?\d+(?:\.\d+)?)\s*km\/h/i,
  leadPct: /^(-?\d+(?:\.\d+)?)\s*%/i,
  leadMmh: /^(-?\d+(?:\.\d+)?)\s*mm\/h/i,
  leadTemp: /^(-?\d+(?:\.\d+)?)\s*\u00b0C/i,
  parenTemp: /\((-?\d+(?:\.\d+)?)\s*\u00b0C\)/i,
  ratio: /(\d+(?:\.\d+)?)\s*\u00d7\s*typical/i,
  share: /up to\s+(\d+(?:\.\d+)?)\s*%/i,
  rainMm: /Rn_1\s*\((-?\d+(?:\.\d+)?)\s*mm\)/i,
  forHours: /for\s+(\d+(?:\.\d+)?)\s*h\b/i,
  zeroWindHours: /zero wind\s+(\d+(?:\.\d+)?)\s*h\b/i,
  silentHours: /silent\s+(\d+(?:\.\d+)?)\s*h\s+straight/i,
  dirShifts: /(\d+)\s+shifts/i,
  neighbourZero: /(\d+)\s+of\s+(\d+)\s+neighbour/i,
  silentZero: /silent\s+(\d+)\s+of\s+(\d+)\s+neighbour/i,
  vbatMin: /min\s+(-?\d+(?:\.\d+)?)\s*V/i,
  vbatDrop: /dropped\s+(-?\d+(?:\.\d+)?)\s*V/i,
  noCharge: /no charge\s+(\d+)/i,
  dryPersist: /zero\s+Rn_1/i,
};

const SEVERITY_CATEGORIES = [
  ["Power", "LOW BATTERY VOLTAGE", 1, { mag: { re: SEV_RE.vbatMin, invert: true } }],
  ["Power", "NO DAYTIME CHARGING", 2, { freq: { re: SEV_RE.noCharge } }],
  ["Power", "BATTERY VOLTAGE DECLINING", 3, { mag: { re: SEV_RE.vbatDrop } }],
  ["Data", "LOW DATA COVERAGE", 3, { mag: { re: SEV_RE.leadPct, invert: true } }],
  ["RH", "RH READ 0%", 4, { freq: { re: SEV_RE.readings } }],
  ["RH", "RH EXCEEDED 100%", 5, {
    freq: { re: SEV_RE.readings },
    mag: { re: SEV_RE.rhMax },
  }],
  ["Wind", "SUSTAINED WIND EXCEEDED GUST (WSPD > MX_SPD)", 6, {
    freq: { re: SEV_RE.readings },
    mag: { re: SEV_RE.peakKmh },
  }],
  ["Precip", "SILENT RAIN GAUGES (\u22656 CONSECUTIVE NEIGHBOUR RAIN HOURS)", 7, {
    dur: { re: SEV_RE.silentHours },
    freq: { re: SEV_RE.neighbourZero },
  }],
  ["Precip", "SILENT RAIN GAUGES (SILENT \u226560% OF NEIGHBOUR RAIN HOURS)", 8, {
    freq: { re: SEV_RE.silentZero },
  }],
  ["Precip", "PRECIPITATION (RN_1) RECORDED WHILE RH WAS BELOW 10%", 8, {
    freq: { re: SEV_RE.hours },
    mag: { re: SEV_RE.rainMm },
  }],
  ["Precip", "PRECIPITATION (RN_1) RECORDED WHILE RH WAS 10\u201325%", 9, {
    freq: { re: SEV_RE.hours },
    mag: { re: SEV_RE.rainMm },
  }],
  ["Wind", "PERSISTENT STATES", 10, {
    dur: { re: SEV_RE.zeroWindHours },
    freq: { re: SEV_RE.dirShifts },
  }],
  ["RH", "RH CHANGED \u226520%/H, DECOUPLED FROM TEMPERATURE AND WIND", 11, {
    freq: { re: SEV_RE.shifts },
    mag: { re: SEV_RE.rhPeak, abs: true },
  }],
  ["RH", "RH CHANGED >50%/H", 12, {
    freq: { re: SEV_RE.events },
    mag: { re: SEV_RE.rhPeak, abs: true },
  }],
  ["Temp", "TEMPERATURE CHANGED >5\u00b0C/H, UNCORRELATED WITH RH", 13, {
    freq: { re: SEV_RE.uncorrelated },
    mag: { re: SEV_RE.tempPeak, abs: true },
  }],
  ["RH", "PERSISTENT STATES", 14, {
    dur: { re: SEV_RE.forHours },
    dry: SEV_RE.dryPersist,
  }],
  ["Temp", "PERSISTENT STATES", 15, { dur: { re: SEV_RE.forHours } }],
  ["Wind", "DAILY DIRECTION CONCENTRATION", 16, {
    mag: { re: SEV_RE.share },
    freq: { re: SEV_RE.parenDays },
  }],
  ["Wind", "DIRECTION BIAS OVER 14-DAY WINDOW", 17, {
    mag: { re: SEV_RE.ratio },
    freq: { re: SEV_RE.pctOfDays },
  }],
  ["Wind", "GUSTS EXCEEDED 80 KM/H", 18, {
    mag: { re: SEV_RE.leadKmh },
    freq: { re: SEV_RE.parenReadings },
  }],
  ["Wind", "SUSTAINED WIND EXCEEDED 60 KM/H", 19, {
    mag: { re: SEV_RE.leadKmh },
    freq: { re: SEV_RE.parenReadings },
  }],
  ["Temp", "TEMPERATURE EXCEEDED 35\u00b0C", 20, {
    mag: { re: SEV_RE.leadTemp, abs: true },
  }],
  ["Temp", "TEMPERATURE DROPPED BELOW -35\u00b0C", 20, {
    mag: { re: SEV_RE.leadTemp, abs: true },
  }],
  ["Precip", "HIGH PRECIPITATION", 21, { mag: { re: SEV_RE.leadMmh } }],
  ["RH", "RH DROPPED AS LOW AS", 22, { mag: { re: SEV_RE.leadPct, invert: true } }],
  ["Data", "UNCONFIGURED SENSORS", 22, {}],
  ["Temp", "EXTREME VALUES", 23, { mag: { re: SEV_RE.parenTemp, abs: true } }],
  ["Wind", "WIND SPEED OUTLIERS", 24, { mag: { re: SEV_RE.leadKmh } }],
  ["Wind", "GUST OUTLIERS", 24, { mag: { re: SEV_RE.leadKmh } }],
];

function severityKey(area, section) {
  return String(area || "") + "\u0000" + String(section || "");
}

const SEVERITY_RANKS = new Map();
const SEVERITY_RULES = new Map();

for (const [area, section, rank, rules] of SEVERITY_CATEGORIES) {
  const key = severityKey(area, section);
  SEVERITY_RANKS.set(key, rank);
  SEVERITY_RULES.set(key, rules || {});
}

function severityRankGap() {
  const ranks = Array.from(new Set(Array.from(SEVERITY_RANKS.values()))).sort(
    (a, b) => a - b
  );
  let gap = Infinity;
  for (let i = 1; i < ranks.length; i++) {
    gap = Math.min(gap, ranks[i] - ranks[i - 1]);
  }
  return ranks.length > 1 ? gap : Infinity;
}

function severityScaleOk() {
  return severityRankGap() * SEVERITY_CATEGORY_STEP > SEVERITY_MAX_MODIFIER;
}

if (!severityScaleOk()) {
  console.warn("severity modifiers can reorder categories");
}

function severityRank(area, section) {
  const hit = SEVERITY_RANKS.get(severityKey(area, section));
  if (hit !== undefined) return hit;
  const fallback = SEVERITY_AREA_DEFAULT_RANK[area];
  return fallback === undefined ? SEVERITY_DEFAULT_RANK : fallback;
}

function severityBase(area, section) {
  return (SEVERITY_RANK_FLOOR - severityRank(area, section)) * SEVERITY_CATEGORY_STEP;
}

function readMetric(text, rule) {
  if (!rule || !rule.re) return null;
  const m = rule.re.exec(text);
  if (!m) return null;
  const v = Number(m[rule.index || 1]);
  if (!isFinite(v)) return null;
  if (rule.abs) return Math.abs(v);
  return rule.invert ? -v : v;
}

function bracketSpanHours(when) {
  if (!when) return null;
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  let lo = null;
  let hi = null;
  let m;
  BRACKET_STAMP_RE.lastIndex = 0;
  while ((m = BRACKET_STAMP_RE.exec(when)) !== null) {
    const mon = MONTH_INDEX[m[1]];
    if (mon === undefined) continue;
    const day = Number(m[2]);
    const hh = m[3] ? Number(m[3]) : 0;
    const mm = m[4] ? Number(m[4]) : 0;
    let ms = Date.UTC(year, mon, day, hh, mm);
    if (ms > now + STAMP_FUTURE_SLACK_MS) ms = Date.UTC(year - 1, mon, day, hh, mm);
    if (lo === null || ms < lo) lo = ms;
    if (hi === null || ms > hi) hi = ms;
  }
  if (lo === null || hi === null || hi <= lo) return null;
  return (hi - lo) / 3600000;
}

function severityMetrics(f) {
  const rules = SEVERITY_RULES.get(severityKey(f.area, f.section)) || {};
  const detail = String(f.detail || "");
  const out = {
    dur: readMetric(detail, rules.dur),
    mag: readMetric(detail, rules.mag),
    freq: readMetric(detail, rules.freq),
    dry: !!(rules.dry && rules.dry.test(detail)),
  };
  if (out.dur === null) out.dur = bracketSpanHours(f.when);
  return out;
}

const SEVERITY_METRIC_KEYS = ["dur", "mag", "freq"];

function severityUnit(v, range) {
  if (v === null || !range) return 0;
  const lo = range[0];
  const hi = range[1];
  if (!(hi > lo)) return 0;
  return (v - lo) / (hi - lo);
}

function applySeverity(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = severityKey(f.area, f.section);
    const metrics = severityMetrics(f);
    f._severityMetrics = metrics;
    let g = groups.get(key);
    if (!g) {
      g = { dur: null, mag: null, freq: null };
      groups.set(key, g);
    }
    for (const k of SEVERITY_METRIC_KEYS) {
      const v = metrics[k];
      if (v === null || !isFinite(v)) continue;
      if (!g[k]) g[k] = [v, v];
      else {
        g[k][0] = Math.min(g[k][0], v);
        g[k][1] = Math.max(g[k][1], v);
      }
    }
  }

  for (const f of findings) {
    const g = groups.get(severityKey(f.area, f.section)) || {};
    const m = f._severityMetrics;
    let score = severityBase(f.area, f.section);
    score += SEVERITY_DURATION_WEIGHT * severityUnit(m.dur, g.dur);
    score += SEVERITY_MAGNITUDE_WEIGHT * severityUnit(m.mag, g.mag);
    score += SEVERITY_FREQUENCY_WEIGHT * severityUnit(m.freq, g.freq);
    if (f.ongoing) score += SEVERITY_ONGOING_BONUS;
    if (m.dry) score += SEVERITY_DRY_PERSIST_BONUS;
    f.severity = score;
  }

  return findings;
}

function ovSeverity(f) {
  return typeof f.severity === "number" && isFinite(f.severity) ? f.severity : 0;
}

function ensureOverviewStyles() {
  if (document.getElementById("wx-overview-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-overview-styles";
  st.textContent = [
    ".wx-ov-shell{display:flex;flex-direction:column;min-height:320px;}",
    ".wx-ov-chart{flex:0 0 auto;background:var(--surface);overflow:hidden;",
    "border:1px solid var(--line);border-radius:10px;padding:12px;",
    "box-shadow:0 1px 3px rgba(0,0,0,.04);margin-bottom:10px;",
    "transition:height " + PANEL_ANIM_MS + "ms cubic-bezier(.4,0,.2,1);}",
    "@media (prefers-reduced-motion:reduce){.wx-ov-chart{transition:none;}}",
    ".wx-ov-wrap{flex:0 1 auto;min-height:0;overflow:auto;",
    "background:var(--surface);border:1px solid var(--line);",
    "border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.04);}",
    ".wx-ov-table{width:100%;border-collapse:separate;border-spacing:0;}",
    ".wx-ov-table th{position:sticky;top:0;z-index:1;padding:7px 12px;",
    "text-align:left;font-size:9px;font-weight:600;letter-spacing:.06em;",
    "text-transform:uppercase;color:var(--text-muted);background:#fcfcfb;",
    "white-space:nowrap;cursor:pointer;user-select:none;",
    "border-bottom:1px solid var(--line);}",
    ".wx-ov-table th:hover{color:var(--text);}",
    ".wx-ov-table th .a{margin-left:5px;color:var(--accent);}",
    ".wx-ov-table td{padding:5px 12px;vertical-align:top;",
    "border-top:1px solid #f5f4f2;}",
    ".wx-ov-table td:first-child,.wx-ov-table th:first-child{",
    "border-left:3px solid transparent;}",
    ".wx-ov-table tbody tr:first-child td{border-top:none;}",
    ".wx-ov-row{cursor:pointer;}",
    ".wx-ov-row:hover td{background:#fafaf9;}",
    ".wx-ov-row.sel td{background:#f5f8ff;}",
    ".wx-ov-sensor{font-size:10px;font-weight:600;letter-spacing:.04em;",
    "text-transform:uppercase;color:var(--text-muted);white-space:nowrap;}",
    ".wx-ov-name{font-size:11px;font-weight:600;letter-spacing:-.01em;",
    "color:var(--text);white-space:nowrap;}",
    ".wx-ov-type{font-size:10px;letter-spacing:.03em;color:#a9a49c;}",
    ".wx-ov-detail{font-size:12px;color:var(--text);line-height:1.35;}",
    ".wx-ov-when{font-size:10px;color:var(--text-muted);white-space:nowrap;}",
    "@media (max-width:768px){.wx-ov-chart{padding:8px;}",
    ".wx-ov-table th,.wx-ov-table td{padding:5px 8px;}}",
  ].join("");
  document.head.appendChild(st);
}

function ovText(tag, className, txt) {
  const n = el(tag, className);
  n.textContent = txt == null ? "" : String(txt);
  return n;
}

const ONGOING_SUFFIX_RE = /,\s*ongoing\s*$/i;

const EXTREME_SECTION = "EXTREME VALUES";

const EXTREME_PREFIX_RE = /^(Highest|Lowest)\b/;

const OVERVIEW_COLUMNS = ["Sensor", "Station", "Alert", "Type", "Time"];

const TAB_COLUMNS = ["Station", "Alert", "Type", "Time"];

const OVERVIEW_CELLS = {
  Sensor: (f) => ovText("td", "wx-ov-sensor", f.area),
  Station: (f) => ovText("td", "wx-ov-name", f.station),
  Alert: (f) => ovText("td", "wx-ov-detail", ovDetail(f)),
  Type: (f) => ovText("td", "wx-ov-type", f.section),
  Time: (f) => ovText("td", "wx-ov-when", ovWhen(f)),
};

const OVERVIEW_PLOT_MAX = 420;

const PANEL_ANIM_MS = 120;

const PANEL_CHROME = 96;

const OVERVIEW_SORTS = {
  Sensor: (a, b) => ovAreaRank(a) - ovAreaRank(b),
  Station: (a, b) => a.station.localeCompare(b.station),
  Type: (a, b) => String(a.section || "").localeCompare(String(b.section || "")),
  Alert: (a, b) => ovDetail(a).localeCompare(ovDetail(b)),
  Time: (a, b) => ovStamp(a) - ovStamp(b),
};

const OVERVIEW_BLANK = {
  Type: (f) => !f.section,
  Time: (f) => f.at === null || f.at === undefined,
};

const AREA_RANK = new Map(INSIGHT_SOURCES.map((s, i) => [s[2], i]));

function ovAreaRank(f) {
  const i = AREA_RANK.get(f.area);
  return i === undefined ? AREA_RANK.size : i;
}

function ovStamp(f) {
  return f.at === null || f.at === undefined ? 0 : f.at;
}

function ovWhen(f) {
  return String(f.when || "").replace(ONGOING_SUFFIX_RE, "").trim();
}

function ovDetail(f) {
  const text = String(f.detail || "");
  if (f.section === EXTREME_SECTION && EXTREME_PREFIX_RE.test(text)) {
    return text.replace(EXTREME_PREFIX_RE, "$1 in window");
  }
  return text;
}

function chartPanel() {
  const panel = el("div", "wx-ov-chart");
  panel.style.display = "none";
  return panel;
}

function tabPanel(grid) {
  const panel = chartPanel();
  if (grid) {
    grid._wxPanel = panel;
    panel._wxGrid = grid;
  }
  return panel;
}

function resetOverviewChart(panel) {
  if (typeof panel._wxRowWatch === "function") {
    try { panel._wxRowWatch(); } catch (e) {}
  }
  panel._wxRowWatch = null;
  if (typeof panel._wxCleanup === "function") {
    try { panel._wxCleanup(); } catch (e) {}
  } else {
    for (const pd of panel.querySelectorAll(".wx-detail-plot")) {
      try { Plotly.purge(pd); } catch (e) {}
    }
  }
  panel._wxCleanup = null;
  panel._wxStation = null;
  panel._wxTab = null;
  if (panel._wxRow) {
    panel._wxRow.classList.remove("sel");
    panel._wxRow = null;
  }
  panel.innerHTML = "";
}

function closeOverviewChart(panel) {
  resetOverviewChart(panel);
  panel.style.display = "none";
  panel.style.height = "";
  const grid = panel._wxGrid;
  if (!grid) return;
  if (typeof grid._wxClearFilter === "function" && grid._wxClearFilter()) return;
  if (typeof grid._wxRefresh === "function") grid._wxRefresh();
}

function overviewPlotCap(panel) {
  const shell = panel.parentNode;
  if (!shell || !shell.classList.contains("wx-ov-shell")) {
    return OVERVIEW_PLOT_MAX;
  }
  const room = shell.clientHeight;
  if (!room) return OVERVIEW_PLOT_MAX;
  return Math.max(220, Math.min(OVERVIEW_PLOT_MAX, Math.round(room * 0.55)));
}

const PANEL_MARGIN = 12;

function stickyOffset() {
  const nav = document.getElementById("wx-nav");
  if (!nav) return 0;
  const pos = getComputedStyle(nav).position;
  if (pos !== "sticky" && pos !== "fixed") return 0;
  return Math.round(nav.getBoundingClientRect().height);
}

function showPanel(panel) {
  const rect = panel.getBoundingClientRect();
  const room = window.innerHeight || 0;
  const guard = stickyOffset() + PANEL_MARGIN;
  if (rect.top >= guard && rect.bottom <= room) return;
  const top = rect.top + window.scrollY - guard;
  try {
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  } catch (e) {
    window.scrollTo(0, Math.max(0, top));
  }
}

function revealRow(row) {
  const wrap = row.closest ? row.closest(".wx-ov-wrap") : null;
  if (!wrap) return;
  const head = wrap.querySelector("thead");
  const box = wrap.getBoundingClientRect();
  const seen = row.getBoundingClientRect();
  const top = box.top + (head ? head.getBoundingClientRect().height : 0);
  if (seen.top < top) wrap.scrollTop -= top - seen.top;
  else if (seen.bottom > box.bottom) wrap.scrollTop += seen.bottom - box.bottom;
}

function watchRowVisible(panel, row) {
  if (typeof ResizeObserver !== "function") return;
  let raf = 0;
  const run = () => {
    raf = 0;
    if (panel._wxRow !== row || !row.isConnected) return;
    revealRow(row);
  };
  const obs = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(run);
  });
  try {
    obs.observe(panel);
  } catch (e) {
    return;
  }
  panel._wxRowWatch = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { obs.disconnect(); } catch (e) {}
  };
}

function openStationChart(panel, station, tabId) {
  if (!panel || !station) return;
  if (panel.style.display !== "none" && panel._wxStation === station) {
    closeOverviewChart(panel);
    return;
  }
  openOverviewChart(panel, { station: station, tab: tabId || null }, null);
}

function toggleOverviewChart(panel, f, row) {
  if (panel.style.display !== "none" && panel._wxRow === row) {
    closeOverviewChart(panel);
    return;
  }
  openOverviewChart(panel, f, row);
}

function openOverviewChart(panel, f, row) {
  ensureOverviewStyles();
  ensureDetailStyles();
  const wasOpen = panel.style.display !== "none";
  resetOverviewChart(panel);
  panel.style.display = "";
  panel._wxRow = row || null;
  panel._wxStation = f.station || null;
  panel._wxTab = f.tab || null;
  if (row) row.classList.add("sel");

  if (!wasOpen) {
    panel.style.height = "0px";
    requestAnimationFrame(() => {
      if (panel._wxRow !== row) return;
      panel.style.height = overviewPlotCap(panel) + PANEL_CHROME + "px";
    });
    setTimeout(() => {
      if (panel._wxRow === row) panel.style.height = "";
    }, PANEL_ANIM_MS + 40);
  }

  const head = el("div", "wx-detail-head");
  const title = el("span", "t");
  title.textContent = f.station;
  const close = el("button", null, "Close");
  close.type = "button";
  close.addEventListener("click", () => closeOverviewChart(panel));
  head.appendChild(title);
  head.appendChild(close);

  const body = el("div", "wx-detail-body");
  const loading = el("div", "al-loading");
  loading.appendChild(el("div", "spinner"));
  loading.appendChild(el("span", null, "Loading\u2026"));
  body.appendChild(loading);

  panel.appendChild(head);
  panel.appendChild(body);
  if (row) {
    watchRowVisible(panel, row);
    requestAnimationFrame(() => {
      if (panel._wxRow === row) revealRow(row);
    });
  } else {
    requestAnimationFrame(() => {
      if (panel._wxRow === null) showPanel(panel);
    });
  }

  const opts = detailOpts(f.station, f.tab);
  opts.maxHeight = () => overviewPlotCap(panel);
  detailModule()
    .then((m) => m.mount(panel, opts))
    .then(() => {
      wirePanelHover(panel);
      if (panel._wxGrid && typeof panel._wxGrid._wxRefresh === "function") {
        requestAnimationFrame(() => panel._wxGrid._wxRefresh());
      }
      if (panel._wxRow !== (row || null)) return;
      requestAnimationFrame(() => {
        if (panel._wxRow !== (row || null)) return;
        if (row) revealRow(row);
        else showPanel(panel);
      });
    })
    .catch((e) => {
      console.warn("detail module failed", e);
      if (!panel.isConnected) return;
      body.innerHTML = "";
      body.appendChild(
        el("div", "wx-detail-msg", "Could not load the station chart.")
      );
    });
}

const RGBA_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i;

function solid(color) {
  const raw = String(color || "");
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const m = RGBA_RE.exec(raw);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : null;
}

function overviewRow(f, panel, columns) {
  const row = el("tr", "wx-ov-row");
  for (const name of columns) {
    const build = OVERVIEW_CELLS[name];
    if (!build) continue;
    const cell = build(f);
    if (name === "Sensor") row._wxSensor = cell;
    if (name === "Type") row._wxType = cell;
    if (!row.firstChild) {
      const bar = solid(f.color);
      if (bar) cell.style.borderLeftColor = bar;
    }
    row.appendChild(cell);
  }
  row.title = "Show " + f.station;
  row._wxStation = f.station || null;
  row._wxFinding = f;
  row.addEventListener("click", () => toggleOverviewChart(panel, f, row));
  row.addEventListener("pointerenter", () => prefetchDetail(f.station, f.tab));
  row.addEventListener("pointerleave", cancelPrefetch);
  return row;
}

function groupRank(entries) {
  const area = new Map();
  const section = new Map();
  for (const e of entries) {
    const sev = ovSeverity(e.f);
    const a = String(e.f.area || "");
    const k = a + "\u0000" + String(e.f.section || "");
    if (!area.has(a) || area.get(a) < sev) area.set(a, sev);
    if (!section.has(k) || section.get(k) < sev) section.set(k, sev);
  }
  return { area: area, section: section };
}

function sortRows(entries, column, dir) {
  const flat = dir && column !== "Sensor" && column !== "Type";
  if (flat) {
    const cmp = OVERVIEW_SORTS[column];
    const blank = OVERVIEW_BLANK[column];
    if (cmp) {
      return entries.slice().sort((a, b) => {
        if (blank) {
          const ab = blank(a.f);
          const bb = blank(b.f);
          if (ab !== bb) return ab ? 1 : -1;
        }
        return dir * cmp(a.f, b.f) || a.i - b.i;
      });
    }
  }

  const rank = groupRank(entries);
  return entries.slice().sort((a, b) => {
    const aArea = String(a.f.area || "");
    const bArea = String(b.f.area || "");
    if (aArea !== bArea) {
      if (column === "Sensor") return dir * (ovAreaRank(a.f) - ovAreaRank(b.f));
      return (
        rank.area.get(bArea) - rank.area.get(aArea) || aArea.localeCompare(bArea)
      );
    }
    const aSec = String(a.f.section || "");
    const bSec = String(b.f.section || "");
    if (aSec !== bSec) {
      if (!aSec || !bSec) return aSec ? -1 : 1;
      if (column === "Type") return dir * aSec.localeCompare(bSec);
      const aKey = aArea + "\u0000" + aSec;
      const bKey = bArea + "\u0000" + bSec;
      return (
        rank.section.get(bKey) - rank.section.get(aKey) || aSec.localeCompare(bSec)
      );
    }
    return ovSeverity(b.f) - ovSeverity(a.f) || a.i - b.i;
  });
}

function overviewTable(findings, panel, columns) {
  const wrap = el("div", "wx-ov-wrap");
  const table = el("table", "wx-ov-table");
  const thead = el("thead");
  const headRow = el("tr");
  const tbody = el("tbody");

  const entries = findings.map((f, i) => ({
    f: f,
    i: i,
    row: overviewRow(f, panel, columns),
  }));
  for (const e of entries) tbody.appendChild(e.row);

  let column = null;
  let dir = 0;
  const cells = new Map();

  const apply = () => {
    for (const [name, cell] of cells) {
      const mark = cell.querySelector(".a");
      if (mark) mark.remove();
      if (name !== column || !dir) continue;
      const arrow = el("span", "a");
      arrow.textContent = dir > 0 ? "\u2191" : "\u2193";
      cell.appendChild(arrow);
    }
    const ordered = sortRows(entries, column, dir);
    let area = null;
    let section = null;
    for (const e of ordered) {
      tbody.appendChild(e.row);
      const a = String(e.f.area || "");
      const s = String(e.f.section || "");
      if (e.row._wxSensor) {
        e.row._wxSensor.textContent = a && a === area ? "" : a;
      }
      if (e.row._wxType) {
        e.row._wxType.textContent = s && s === section && a === area ? "" : s;
      }
      area = a;
      section = s;
    }
    wrap.scrollTop = 0;
  };

  for (const label of columns) {
    const cell = ovText("th", null, label);
    cells.set(label, cell);
    cell.addEventListener("click", () => {
      if (column !== label) {
        column = label;
        dir = 1;
      } else if (dir === 1) {
        dir = -1;
      } else {
        column = null;
        dir = 0;
      }
      apply();
    });
    headRow.appendChild(cell);
  }

  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  apply();
  return wrap;
}

function sizeOverviewShell() {
  const shell = $main.querySelector(".wx-ov-shell");
  if (!shell) return;
  const top = shell.getBoundingClientRect().top;
  const avail = window.innerHeight - top - 16;
  shell.style.height = Math.max(320, Math.round(avail)) + "px";
}



async function buildOverview(fc, hours) {
  ensureOverviewStyles();
  const box = el("div");

  let findings = [];
  try {
    findings = await collectFindings(fc, hours);
  } catch (e) {
    console.warn("overview failed", e);
    findings = [];
  }

  if (!findings.length) {
    box.appendChild(
      el("div", "insight-empty", "No findings for this fire centre in this window.")
    );
    return box;
  }

  const shell = el("div", "wx-ov-shell");
  const panel = chartPanel();
  shell.appendChild(panel);
  shell.appendChild(overviewTable(findings, panel, OVERVIEW_COLUMNS));
  box.appendChild(shell);
  requestAnimationFrame(sizeOverviewShell);

  if (!isMobile()) {
    warmDetail(true);
    const first = findings[0];
    if (first) {
      detailModule()
        .then((m) => m.prefetch(detailOpts(first.station, first.tab)))
        .catch(() => {});
    }
  }

  return box;
}

async function buildRh(fc, hours) {
  const c = await loadCharts(fc, hours, "rh");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c);
  const panel = tabPanel(grid);
  box.appendChild(await insightBanner(fc, hours, "rh", panel));
  box.appendChild(panel);
  box.appendChild(grid);
  box.appendChild(boxCard(c.rh_distribution));
  box.appendChild(row(
    rowGraph(c.rh_volcano, { stationFilter: true }),
    rowGraph(c.rh100_scatter)
  ));
  return box;
}

async function buildWind(fc, hours) {
  const c = await loadCharts(fc, hours, "wind");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, [
    { key: "station_grid", label: "Wspd" },
    { key: "station_grid_mx", label: "Mx Spd" },
  ]);
  const panel = tabPanel(grid);
  box.appendChild(await insightBanner(fc, hours, "wind", panel));
  box.appendChild(panel);
  box.appendChild(grid);
  box.appendChild(row(
    graph(c.wind_distribution, { height: boxHeight() }),
    graph(c.mx_distribution, { height: boxHeight() })
  ));
  box.appendChild(row(rowGraph(c.wind_stall_heatmap), rowGraph(c.dir_coverage_heatmap)));
  return box;
}

async function buildTemp(fc, hours) {
  const c = await loadCharts(fc, hours, "temp");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c);
  const panel = tabPanel(grid);
  box.appendChild(await insightBanner(fc, hours, "temp", panel));
  box.appendChild(panel);
  box.appendChild(grid);
  box.appendChild(boxCard(c.temp_distribution));
  box.appendChild(row(
    rowGraph(c.temp_volcano, { stationFilter: true }),
    rowGraph(c.constant_temp_gantt)
  ));
  return box;
}

async function buildRn1(fc, hours) {
  const c = await loadCharts(fc, hours, "rn1");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c);
  const panel = tabPanel(grid);
  box.appendChild(await insightBanner(fc, hours, "rn1", panel));
  box.appendChild(panel);
  box.appendChild(grid);
  box.appendChild(boxCard(c.rn1_distribution));
  box.appendChild(row(
    rowGraph(c.precip_diagnostic_dashboard, { stationFilter: true }),
    rowGraph(c.precip_silent_sensor)
  ));
  return box;
}

async function buildPower(fc, hours) {
  const c = await loadCharts(fc, hours, "power");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c);
  const panel = tabPanel(grid);
  box.appendChild(await insightBanner(fc, hours, "power", panel));
  box.appendChild(panel);
  box.appendChild(grid);
  box.appendChild(boxCard(stripTitle(c.power_distribution)));
  box.appendChild(row(
    rowGraph(annotateEmptyPanels(c.power_diagnostic_dashboard,
                                 "No daytime no-charge events detected")),
    rowGraph(c.vbat_heatmap)
  ));
  return box;
}

let _detailModule = null;

function detailModule() {
  if (!_detailModule) {
    _detailModule = import("./detail.js");
    _detailModule.catch(() => { _detailModule = null; });
  }
  return _detailModule;
}

let _warmedEngine = false;
let _warmScheduled = false;

function warmDetail(engine) {
  detailModule()
    .then((m) => {
      m.warmConfig();
      if (engine && !_warmedEngine) {
        _warmedEngine = true;
        m.warmEngine();
      }
    })
    .catch(() => {});
}

function scheduleWarm() {
  if (_warmScheduled) return;
  _warmScheduled = true;
  const run = () => warmDetail(!isMobile());
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
}

const TAB_SUFFIX = {
  "tab-overview": "data",
  "tab-rh": "rh",
  "tab-wind": "wind",
  "tab-temp": "temp",
  "tab-rn1": "rn1",
  "tab-power": "power",
};

function detailOpts(station, tabId) {
  const fc = state.fc;
  const hours = state.hours;
  const tab = tabId || state.activeTab;
  return {
    station: station,
    tab: tab,
    hours: hours,
    fc: fc,
    tabSuffix: TAB_SUFFIX[tab] || null,
    range: state.range,
    getChart: (suffix) => loadCharts(fc, hours, suffix),
    peekChart: (suffix) => peekCharts(fc, hours, suffix),
  };
}

let _prefetchTimer = 0;

function prefetchDetail(station, tabId) {
  if (!station || !state.fc) return;
  warmDetail(true);
  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  _prefetchTimer = setTimeout(() => {
    _prefetchTimer = 0;
    detailModule()
      .then((m) => m.prefetch(detailOpts(station, tabId)))
      .catch(() => {});
  }, 120);
}

function cancelPrefetch() {
  if (!_prefetchTimer) return;
  clearTimeout(_prefetchTimer);
  _prefetchTimer = 0;
}

function ensureDetailStyles() {
  if (document.getElementById("wx-detail-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-detail-styles";
  st.textContent = [
    ".wx-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;}",
    ".wx-detail-head .t{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;",
    "letter-spacing:-.015em;overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;}",
    ".wx-detail-head button{flex:0 0 auto;font-size:12px;padding:4px 11px;}",
    ".wx-detail-body{min-height:0;}",
    ".wx-detail-controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:4px;}",
    ".wx-detail-control{display:flex;flex-direction:column;gap:2px;min-width:150px;}",
    ".wx-detail-control label{font-size:9px;letter-spacing:.06em;}",
    ".wx-detail-select{font-family:inherit;font-size:12px;font-weight:500;",
    "color:var(--text,#26231f);background:var(--surface,#fff);",
    "border:1px solid var(--line,#e8e6e3);border-radius:7px;padding:4px 8px;",
    "min-height:28px;box-sizing:border-box;cursor:pointer;}",
    ".wx-detail-select:hover{border-color:#d9d6d1;}",
    ".wx-detail-msg{padding:40px 8px;font-size:13px;line-height:1.6;",
    "color:var(--text-muted,#8a857d);text-align:center;}",
    "@media (max-width:768px){.wx-detail-control{min-width:0;flex:1 1 100%;}",
    ".wx-detail-select{min-height:44px;font-size:16px;}",
    ".wx-detail-head button{min-height:40px;}}",
  ].join("");
  document.head.appendChild(st);
}

function wireGridAlertClicks(wrap) {
  const axisStations = wrap._wxAxisStations;
  if (!axisStations || !axisStations.size) return;
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxAlertWired) return;
  pd._wxAlertWired = true;

  const stationAt = (ev) => {
    const pts = (ev && ev.points) || [];
    for (const pt of pts) {
      if (!pt || !pt.data || !isAlertTrace(pt.data)) continue;
      const name = axisStations.get(pt.data.xaxis || "x");
      if (name) return name;
    }
    return null;
  };

  pd.on("plotly_click", (ev) => {
    const name = stationAt(ev);
    if (name) openStationChart(wrap._wxPanel, name, state.activeTab);
  });
  pd.on("plotly_hover", (ev) => {
    const name = stationAt(ev);
    pd.style.cursor = name ? "pointer" : "";
    if (name) prefetchDetail(name, state.activeTab);
  });
  pd.on("plotly_unhover", () => {
    pd.style.cursor = "";
  });
}

function ensureGridSpikeStyles() {
  if (document.getElementById("wx-gridspike-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridspike-styles";
  st.textContent = [
    ".wx-graph{position:relative;}",
    ".wx-grid-spike{position:absolute;left:0;top:0;width:0;height:0;",
    "border-left:1px dotted #6b7280;pointer-events:none;",
    "opacity:0;z-index:4;}",
    ".wx-grid-spike.on{opacity:.9;}",
  ].join("");
  document.head.appendChild(st);
}

function fullXAxis(fl, id) {
  const key = !id || id === "x" ? "xaxis" : "xaxis" + id.slice(1);
  return fl[key] || null;
}

function anchoredYAxis(fl, xa) {
  const anchor =
    typeof xa.anchor === "string" && xa.anchor.charAt(0) === "y" ? xa.anchor : "y";
  return fl[anchor === "y" ? "yaxis" : "yaxis" + anchor.slice(1)] || null;
}

function axisValue(xa, v) {
  if (!xa) return null;
  try {
    const c = typeof xa.d2c === "function" ? xa.d2c(v) : Number(v);
    return isFinite(c) ? c : null;
  } catch (e) {
    return null;
  }
}

function hoverAxis(pd, pt) {
  const fl = pd && pd._fullLayout;
  if (!fl || !pt) return null;
  if (pt.xaxis && typeof pt.xaxis._offset === "number") return pt.xaxis;
  return fullXAxis(fl, (pt.data && pt.data.xaxis) || "x");
}

function gridSpikeSpan(pd, xa, xval) {
  const fl = pd && pd._fullLayout;
  if (!fl || !xa || typeof xa._offset !== "number") return null;

  const group = xa.matches || xa._id;
  let top = Infinity;
  let bottom = -Infinity;

  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = fl[key];
    if (!ax || ax.visible === false) continue;
    if ((ax.matches || ax._id) !== group) continue;
    const ya = anchoredYAxis(fl, ax);
    if (!ya || typeof ya._offset !== "number" || !ya._length) continue;
    top = Math.min(top, ya._offset);
    bottom = Math.max(bottom, ya._offset + ya._length);
  }

  if (!(bottom > top)) {
    const ya = anchoredYAxis(fl, xa);
    if (!ya || typeof ya._offset !== "number" || !ya._length) return null;
    top = ya._offset;
    bottom = ya._offset + ya._length;
  }

  let px;
  try {
    px = xa.c2p(xval);
  } catch (e) {
    return null;
  }
  if (!isFinite(px)) return null;
  return { x: xa._offset + px, top: top, height: bottom - top };
}

const HOVER_ECHO_MS = 120;

const HOVER_HOLD_MS = 160;

let _hoverEchoTarget = null;
let _hoverEchoAt = 0;

function hoverEcho(gd) {
  return _hoverEchoTarget === gd && Date.now() - _hoverEchoAt < HOVER_ECHO_MS;
}

function pushHover(gd, xval, subplot) {
  if (!gd || !window.Plotly || !Plotly.Fx || typeof Plotly.Fx.hover !== "function") {
    return;
  }
  _hoverEchoTarget = gd;
  _hoverEchoAt = Date.now();
  try {
    Plotly.Fx.hover(gd, { xval: xval }, subplot, true);
  } catch (e) {
    void e;
  }
}

function dropHover(gd) {
  if (!gd || !window.Plotly || !Plotly.Fx || typeof Plotly.Fx.unhover !== "function") {
    return;
  }
  _hoverEchoTarget = gd;
  _hoverEchoAt = Date.now();
  try {
    Plotly.Fx.unhover(gd);
  } catch (e) {
    void e;
  }
}

function panelPlot(panel) {
  if (!panel || panel.style.display === "none") return null;
  const pd = panel.querySelector(".wx-detail-plot");
  return pd && pd._fullLayout && typeof pd.on === "function" ? pd : null;
}

function gridAxisForStation(wrap, station) {
  const map = wrap && wrap._wxAxisStations;
  if (!map || !station) return null;
  for (const [id, name] of map) {
    if (name === station) return id;
  }
  return null;
}

function gridTopAxis(pd) {
  const fl = pd && pd._fullLayout;
  if (!fl) return null;
  let best = null;
  let top = Infinity;
  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const xa = fl[key];
    if (!xa || xa.visible === false || typeof xa._offset !== "number") continue;
    const ya = anchoredYAxis(fl, xa);
    if (!ya || typeof ya._offset !== "number") continue;
    if (ya._offset < top) {
      top = ya._offset;
      best = xa;
    }
  }
  return best;
}

function gridHoverAt(wrap, station, xval) {
  const pd = wrap && wrap._wxGridPlot;
  const fl = pd && pd._fullLayout;
  if (!fl) return;
  const id = gridAxisForStation(wrap, station);
  let xa = id ? fullXAxis(fl, id) : null;
  if (!xa || xa.visible === false || typeof xa._offset !== "number") {
    xa = gridTopAxis(pd);
  }
  if (!xa) return;
  if (typeof wrap._wxSpikeAt === "function") wrap._wxSpikeAt(xa, xval);
  const ya = anchoredYAxis(fl, xa);
  if (ya && ya._id) pushHover(pd, xval, xa._id + ya._id);
}

function gridHoverOff(wrap) {
  if (typeof wrap._wxSpikeOff === "function") wrap._wxSpikeOff();
  if (wrap && wrap._wxGridPlot) dropHover(wrap._wxGridPlot);
}

function wirePanelHover(panel) {
  const wrap = panel && panel._wxGrid;
  const dpd = panelPlot(panel);
  if (!wrap || !dpd || dpd._wxLinkWired) return;
  dpd._wxLinkWired = true;

  let timer = 0;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };

  dpd.on("plotly_hover", (ev) => {
    cancel();
    if (!wrap._wxStacked || hoverEcho(dpd)) return;
    const pt = ev && ev.points && ev.points[0];
    if (!pt) return;
    const xval = axisValue(hoverAxis(dpd, pt), pt.x);
    if (xval === null) return;
    gridHoverAt(wrap, panel._wxStation, xval);
  });
  dpd.on("plotly_unhover", () => {
    cancel();
    if (!wrap._wxStacked || hoverEcho(dpd)) return;
    timer = setTimeout(() => {
      timer = 0;
      gridHoverOff(wrap);
    }, HOVER_HOLD_MS);
  });

  wirePanelRangeSync(panel, dpd);
}

const RANGE_ECHO_MS = 250;

const RANGE_SYNC_MS = 80;

const RANGE_KEY_RE = /^xaxis\d*\.(range|autorange)/;

let _rangeEchoTarget = null;
let _rangeEchoAt = 0;

function rangeEcho(gd) {
  return _rangeEchoTarget === gd && Date.now() - _rangeEchoAt < RANGE_ECHO_MS;
}

function isRangeEvent(e) {
  if (!e) return false;
  for (const key of Object.keys(e)) {
    if (RANGE_KEY_RE.test(key)) return true;
  }
  return false;
}

function anchorXAxisKey(fl) {
  if (!fl) return null;
  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const xa = fl[key];
    if (!xa || xa.visible === false || typeof xa._offset !== "number") continue;
    if (!xa.matches) return key;
  }
  return null;
}

function axisRange(fl, key) {
  const xa = fl && fl[key];
  const r = xa && xa.range;
  return Array.isArray(r) && r.length === 2 ? [r[0], r[1]] : null;
}

function rangeValue(xa, v) {
  try {
    const n = typeof xa.r2l === "function" ? xa.r2l(v) : Number(v);
    return isFinite(n) ? n : NaN;
  } catch (e) {
    return NaN;
  }
}

function rangeMatches(xa, a, b) {
  if (!xa || !a || !b) return false;
  const a0 = rangeValue(xa, a[0]);
  const a1 = rangeValue(xa, a[1]);
  const b0 = rangeValue(xa, b[0]);
  const b1 = rangeValue(xa, b[1]);
  if (!isFinite(a0) || !isFinite(a1) || !isFinite(b0) || !isFinite(b1)) return false;
  const span = Math.abs(a1 - a0) || 1;
  const tol = span * 1e-4;
  return Math.abs(a0 - b0) < tol && Math.abs(a1 - b1) < tol;
}

function eventRange(e, key) {
  if (!e) return null;
  const whole = e[key + ".range"];
  if (Array.isArray(whole) && whole.length === 2) return [whole[0], whole[1]];
  const lo = e[key + ".range[0]"];
  const hi = e[key + ".range[1]"];
  if (lo !== undefined && hi !== undefined) return [lo, hi];
  for (const k of Object.keys(e)) {
    const m = /^(xaxis\d*)\.range\[0\]$/.exec(k);
    if (!m) continue;
    const top = e[m[1] + ".range[1]"];
    if (top !== undefined) return [e[k], top];
  }
  for (const k of Object.keys(e)) {
    if (!/^xaxis\d*\.range$/.test(k)) continue;
    const v = e[k];
    if (Array.isArray(v) && v.length === 2) return [v[0], v[1]];
  }
  return null;
}

function pushRange(gd, key, range, done) {
  const finish = () => {
    if (typeof done === "function") done();
  };
  if (!gd || !range || !window.Plotly || typeof Plotly.relayout !== "function") {
    finish();
    return;
  }
  _rangeEchoTarget = gd;
  _rangeEchoAt = Date.now();
  const patch = {};
  patch[key + ".autorange"] = false;
  patch[key + ".range"] = [range[0], range[1]];
  try {
    const p = Plotly.relayout(gd, patch);
    if (p && typeof p.then === "function") {
      p.then(
        () => {
          if (_rangeEchoTarget === gd) _rangeEchoAt = Date.now();
          finish();
        },
        finish
      );
    } else {
      finish();
    }
  } catch (e) {
    void e;
    finish();
  }
}

function wireRangeSync(gd, srcKeyOf, dstOf) {
  if (!gd || typeof gd.on !== "function") return;
  let queued = null;
  let busy = false;
  let timer = 0;

  const flush = () => {
    if (busy || !queued) return;
    const range = queued;
    queued = null;
    const dst = dstOf();
    if (!dst) return;
    const cur = axisRange(dst.gd._fullLayout, dst.key);
    if (rangeMatches(dst.gd._fullLayout[dst.key], range, cur)) return;
    busy = true;
    pushRange(dst.gd, dst.key, range, () => {
      busy = false;
      flush();
    });
  };

  const queue = (range) => {
    if (!range) return;
    queued = range;
    flush();
  };

  gd.on("plotly_relayouting", (e) => {
    if (rangeEcho(gd)) return;
    const key = srcKeyOf();
    if (!key) return;
    queue(eventRange(e, key));
  });

  gd.on("plotly_relayout", (e) => {
    if (rangeEcho(gd) || !isRangeEvent(e)) return;
    const key = srcKeyOf();
    if (!key) return;
    queue(axisRange(gd._fullLayout, key) || eventRange(e, key));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const settled = srcKeyOf();
      if (settled) queue(axisRange(gd._fullLayout, settled));
    }, RANGE_SYNC_MS);
  });
}

function wireGridRangeSync(wrap) {
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxRangeWired) return;
  pd._wxRangeWired = true;
  wireRangeSync(
    pd,
    () => (wrap._wxStacked ? anchorXAxisKey(pd._fullLayout) : null),
    () => {
      if (!wrap._wxStacked) return null;
      const dpd = panelPlot(wrap._wxPanel);
      return dpd ? { gd: dpd, key: "xaxis" } : null;
    }
  );
}

function wirePanelRangeSync(panel, dpd) {
  const wrap = panel && panel._wxGrid;
  if (!wrap || !dpd) return;
  wireRangeSync(
    dpd,
    () => (wrap._wxStacked ? "xaxis" : null),
    () => {
      const pd = wrap._wxStacked ? wrap._wxGridPlot : null;
      const key = pd ? anchorXAxisKey(pd._fullLayout) : null;
      return key ? { gd: pd, key: key } : null;
    }
  );
}

function wireGridSpike(wrap) {
  const pd = wrap._wxGridPlot;
  const host = wrap._wxGraphWrap;
  if (!pd || !host || typeof pd.on !== "function" || pd._wxSpikeWired) return;
  pd._wxSpikeWired = true;

  ensureGridSpikeStyles();
  const line = el("div", "wx-grid-spike");
  host.appendChild(line);

  let timer = 0;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };

  const hide = () => {
    cancel();
    line.className = "wx-grid-spike";
  };

  const place = (xa, xval) => {
    const span = gridSpikeSpan(pd, xa, xval);
    if (!span) {
      hide();
      return false;
    }
    const base = pd.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    line.style.left = Math.round(base.left - box.left + span.x) + "px";
    line.style.top = Math.round(base.top - box.top + span.top) + "px";
    line.style.height = Math.round(span.height) + "px";
    line.className = "wx-grid-spike on";
    return true;
  };

  wrap._wxSpikeAt = place;
  wrap._wxSpikeOff = hide;

  pd.on("plotly_hover", (ev) => {
    cancel();
    const pt = ev && ev.points && ev.points[0];
    const xa = hoverAxis(pd, pt);
    const xval = pt ? axisValue(xa, pt.x) : null;
    if (!xa || xval === null) {
      hide();
      return;
    }
    place(xa, xval);
    if (!wrap._wxStacked || hoverEcho(pd)) return;
    const dpd = panelPlot(wrap._wxPanel);
    if (dpd) pushHover(dpd, xval, "xy");
  });
  pd.on("plotly_unhover", () => {
    cancel();
    const echo = hoverEcho(pd);
    const linked = wrap._wxStacked && !echo;
    timer = setTimeout(() => {
      timer = 0;
      line.className = "wx-grid-spike";
      if (!linked) return;
      const dpd = panelPlot(wrap._wxPanel);
      if (dpd) dropHover(dpd);
    }, HOVER_HOLD_MS);
  });
  pd.on("plotly_relayout", hide);
  pd.addEventListener("mouseleave", hide);
}

function captureStationAnnotations(fig, names) {
  const anns = (fig && fig.layout && fig.layout.annotations) || [];
  if (!anns.length || !names || !names.length) return;
  const known = new Set(names);
  for (const a of anns) {
    if (!a || typeof a.text !== "string") continue;
    if (!known.has(a.text.replace(/<[^>]*>/g, "").trim())) continue;
    a.captureevents = true;
  }
}

function annotationStation(ev, known) {
  const a = ev && ev.annotation;
  if (!a || typeof a.text !== "string") return null;
  const name = a.text.replace(/<[^>]*>/g, "").trim();
  return known.has(name) ? name : null;
}

function markStationCursors(pd, known) {
  if (!pd || !pd.querySelectorAll) return false;
  const nodes = pd.querySelectorAll(".annotation text");
  if (!nodes.length) return false;
  for (const n of nodes) {
    const name = (n.textContent || "").trim();
    if (!known.has(name)) continue;
    n.style.cursor = "pointer";
    if (n._wxHoverWired) continue;
    n._wxHoverWired = true;
    n.addEventListener("mouseenter", () => {
      prefetchDetail(name, state.activeTab);
    });
  }
  return true;
}

function wireGridStationClicks(wrap) {
  const known = new Set(wrap._wxStations || []);
  let tries = 0;

  const poll = () => {
    const pd = wrap._wxGridPlot;
    if (pd && typeof pd.on === "function") {
      if (!pd._wxGridWired) {
        pd._wxGridWired = true;
        if (known.size) {
          pd.on("plotly_clickannotation", (ev) => {
            const name = annotationStation(ev, known);
            if (name) openStationChart(wrap._wxPanel, name, state.activeTab);
          });
          pd.on("plotly_hoverannotation", (ev) => {
            const name = annotationStation(ev, known);
            if (name) prefetchDetail(name, state.activeTab);
          });
          pd.on("plotly_afterplot", () => markStationCursors(pd, known));
          markStationCursors(pd, known);
        }
      }
      wireGridAlertClicks(wrap);
      wireGridSpike(wrap);
      wireGridRangeSync(wrap);
      return;
    }
    if (tries++ < 180) requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

const TABS = [
  { id: OVERVIEW_TAB, label: "Overview", build: buildOverview },
  { id: "tab-rh",    label: "RH",    build: buildRh },
  { id: "tab-wind",  label: "Wind",  build: buildWind },
  { id: "tab-temp",  label: "Temp",  build: buildTemp },
  { id: "tab-rn1",   label: "Precip", build: buildRn1 },
  { id: "tab-power", label: "Power", build: buildPower },
];

const state = { fc: null, hours: 72, activeTab: OVERVIEW_TAB, range: null };

const $main = document.getElementById("al-main-content");
const $footer = document.getElementById("al-timing-diag");
const $fcSelect = document.getElementById("al-fc-select");
const $rangeSelect = document.getElementById("al-range-select");
const $connError = document.getElementById("conn-error");

function showConnError(e) {
  if (!$connError) return;
  $connError.textContent =
    "Could not load the fire centre list from " + CONFIG_BASE +
    " (" + ((e && e.message) || e) + ").";
  $connError.style.display = "block";
}

function clearConnError() {
  if (!$connError) return;
  $connError.textContent = "";
  $connError.style.display = "none";
}

function showLoading() {
  $main.innerHTML = "";
  const l = el("div", "al-loading");
  l.appendChild(el("div", "spinner"));
  l.appendChild(el("span", null, "Loading\u2026"));
  $main.appendChild(l);
}

const tabCache = new Map();

function tabCacheKey(tabId) {
  return `${state.fc}|${state.hours}|${tabId}`;
}

const _resizeHooks = new Set();

let _resizeTimer = 0;

function hookCached(node) {
  for (const cached of tabCache.values()) {
    if (cached === node || (cached.contains && cached.contains(node))) return true;
  }
  return false;
}

function keepRowVisible() {
  const panel = $main.querySelector(".wx-ov-chart");
  if (panel && panel._wxRow && panel._wxRow.isConnected) {
    revealRow(panel._wxRow);
  }
}

function runResizeHooks() {
  for (const hook of Array.from(_resizeHooks)) {
    if (hook.node.isConnected) {
      try {
        hook.run();
      } catch (e) {
        void e;
      }
    } else if (!hookCached(hook.node)) {
      _resizeHooks.delete(hook);
    }
  }
  sizeOverviewShell();
  keepRowVisible();
}

function watchResize(node, run) {
  _resizeHooks.add({ node: node, run: run });
}

window.addEventListener("resize", () => {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    _resizeTimer = 0;
    runResizeHooks();
  }, 140);
});

function resizePlots(node) {
  if (!node || !node.querySelectorAll) return;
  for (const pd of node.querySelectorAll(".wx-plot")) {
    if (!pd._wxDrawn || !pd._fullLayout) continue;
    const w = pd.clientWidth;
    if (!w || pd._wxWidth === w) continue;
    pd._wxWidth = w;
    try { Plotly.Plots.resize(pd); } catch (e) {}
    fitPlot(pd);
  }
}

function captureOpenDetail() {
  const panel = $main.querySelector(".wx-ov-chart");
  if (!panel || panel.style.display === "none" || !panel._wxStation) return null;
  return { station: panel._wxStation, tab: panel._wxTab || null };
}

function restoreOpenDetail(saved) {
  if (!saved || !saved.station) return;
  const panel = $main.querySelector(".wx-ov-chart");
  if (!panel) return;
  let row = null;
  for (const r of $main.querySelectorAll(".wx-ov-row")) {
    if (r._wxStation !== saved.station) continue;
    if (!row) row = r;
    if (saved.tab && r._wxFinding && r._wxFinding.tab === saved.tab) {
      row = r;
      break;
    }
  }
  const f = row && row._wxFinding
    ? row._wxFinding
    : { station: saved.station, tab: saved.tab };
  openOverviewChart(panel, f, row);
}

const TAB_PREFETCH_DELAY_MS = 400;
const TAB_PREBUILD_DELAY_MS = 700;
const TAB_PREBUILD_SETTLE_MS = 6000;
const TAB_PREBUILD_GAP_MS = 120;

const tabBuilds = new Map();

let _tabWarmToken = 0;
let _prebuildHost = null;

function prebuildHost() {
  if (_prebuildHost && _prebuildHost.isConnected) return _prebuildHost;
  const host = el("div", "wx-prebuild");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;top:0;left:-100000px;pointer-events:none;z-index:-1;";
  document.body.appendChild(host);
  _prebuildHost = host;
  return host;
}

function plotsSettled(root, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      let pending = 0;
      for (const p of root.querySelectorAll(".wx-plot")) {
        if (!p._wxDrawn) pending++;
      }
      if (!pending || performance.now() - t0 > timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 120);
    };
    setTimeout(check, 120);
  });
}

async function prebuildTab(tab, token, stale) {
  const key = tabCacheKey(tab.id);
  if (tabCache.has(key) || tabBuilds.has(key)) return;
  const host = prebuildHost();
  host.style.width = ($main.clientWidth || window.innerWidth) + "px";
  const slot = el("div", "tab-content");
  host.appendChild(slot);

  const job = tab.build(state.fc, state.hours);
  tabBuilds.set(key, job);

  let content = null;
  try {
    content = await job;
  } catch (e) {
    content = null;
  }
  tabBuilds.delete(key);

  if (content && !stale(token)) {
    slot.appendChild(content);
    await plotsSettled(slot, TAB_PREBUILD_SETTLE_MS);
  }
  if (content && content.parentNode === slot) {
    slot.removeChild(content);
    if (!stale(token) && !tabCache.has(key)) tabCache.set(key, content);
  }
  if (slot.parentNode === host) host.removeChild(slot);
}

function warmTabPayloads() {
  const fc = state.fc;
  const hours = state.hours;
  if (!fc) return;
  const token = ++_tabWarmToken;
  const queue = [];
  for (const t of TABS) {
    if (t.id === OVERVIEW_TAB || t.id === state.activeTab) continue;
    queue.push(t);
  }
  if (!queue.length) return;

  const stale = (tk) =>
    tk !== _tabWarmToken || state.fc !== fc || state.hours !== hours;

  const idle = (fn) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout: 3000 });
    } else {
      setTimeout(fn, TAB_PREBUILD_GAP_MS);
    }
  };

  const build = () => {
    if (stale(token)) return;
    const tab = queue.shift();
    if (!tab) return;
    prebuildTab(tab, token, stale)
      .catch(() => null)
      .then(() => {
        if (!stale(token)) idle(build);
      });
  };

  const fetchOnly = () => {
    if (stale(token)) return;
    const tab = queue.shift();
    if (!tab) return;
    const suffix = TAB_SUFFIX[tab.id];
    if (!suffix) {
      fetchOnly();
      return;
    }
    Promise.all([
      loadCharts(fc, hours, suffix),
      loadText(fc, hours, `insights_${suffix}`),
      loadCharts(fc, hours, `insights_${suffix}`),
    ])
      .catch(() => null)
      .then(() => {
        if (!stale(token)) idle(fetchOnly);
      });
  };

  if (isMobile()) {
    setTimeout(fetchOnly, TAB_PREFETCH_DELAY_MS);
  } else {
    setTimeout(build, TAB_PREBUILD_DELAY_MS);
  }
}

async function renderTab(tabId) {
  const tab = TABS.find(t => t.id === tabId) || TABS[0];
  state.activeTab = tab.id;

  $main.innerHTML = "";

  const tabsBar = el("div", "al-tabs");
  for (const t of TABS) {
    const btn = el("div", "al-tab" + (t.id === tab.id ? " active" : ""), t.label);
    btn.addEventListener("click", () => renderTab(t.id));
    tabsBar.appendChild(btn);
  }
  $main.appendChild(tabsBar);

  const body = el("div", "tab-content");
  $main.appendChild(body);

  const key = tabCacheKey(tab.id);
  const cached = tabCache.get(key);
  if (cached) {
    body.appendChild(cached);
    requestAnimationFrame(() => {
      resizePlots(cached);
      sizeOverviewShell();
    });
    scheduleWarm();
    warmTabPayloads();
    return;
  }

  const loading = el("div", "al-loading");
  loading.appendChild(el("div", "spinner"));
  loading.appendChild(el("span", null, "Loading\u2026"));
  body.appendChild(loading);

  const pending = tabBuilds.get(key);
  const content = pending
    ? await pending
    : await tab.build(state.fc, state.hours);
  tabCache.set(key, content);
  body.innerHTML = "";
  body.appendChild(content);
  requestAnimationFrame(() => {
    resizePlots(content);
    sizeOverviewShell();
  });
  scheduleWarm();
  warmTabPayloads();
}

let runToken = 0;

async function runAnalysis() {
  const fc = $fcSelect.value;
  const hours = parseInt($rangeSelect.value, 10);
  if (!fc) {
    $main.innerHTML = "";
    $footer.textContent = "";
    return;
  }
  const sameFc = state.fc === fc;
  const changed = state.fc !== fc || state.hours !== hours;
  const reopen = sameFc && changed ? captureOpenDetail() : null;
  state.fc = fc;
  state.hours = hours;
  if (changed) state.range = null;
  if (changed) {
    memCache.clear();
    tabCache.clear();
    cancelPrefetch();
  }

  const token = ++runToken;
  $footer.textContent = "";
  showLoading();

  await renderTab(state.activeTab || OVERVIEW_TAB);
  if (token !== runToken) return;

  if (reopen) restoreOpenDetail(reopen);

  const [dmin, dmax] = await extractDateRange(fc, hours);
  if (token !== runToken) return;
  state.range = dmin && dmax ? [dmin, dmax] : null;

  $footer.textContent = (dmin && dmax)
    ? `Data range:  ${dmin}  →  ${dmax}`
    : `FC: ${fc}  |  Window: ${hours}h`;
}

async function populateDropdown() {
  try {
    const res = await fetch(CONFIG_BASE + "fire_centres.json", { cache: "default" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const centres = await res.json();
    if (!Array.isArray(centres) || !centres.length) throw new Error("no fire centres");
    clearConnError();
    centres.sort((a, b) => a.localeCompare(b));
    $fcSelect.innerHTML = '<option value="" selected disabled hidden>Select Centre…</option>' +
      centres.map(c => `<option value="${c.replace(/"/g, "&quot;")}">${c}</option>`).join("");
  } catch (e) {
    showConnError(e);
    $fcSelect.innerHTML = '<option value="">- unavailable -</option>';
  }
}

function handleBreakpointChange() {
  tabCache.clear();
  if (state.fc) renderTab(state.activeTab || OVERVIEW_TAB);
}

if (typeof MOBILE_QUERY.addEventListener === "function") {
  MOBILE_QUERY.addEventListener("change", handleBreakpointChange);
} else if (typeof MOBILE_QUERY.addListener === "function") {
  MOBILE_QUERY.addListener(handleBreakpointChange);
}

function closeOpenPanels(root) {
  if (!root || !root.querySelectorAll) return;
  for (const panel of root.querySelectorAll(".wx-ov-chart")) {
    if (panel.style.display !== "none") closeOverviewChart(panel);
  }
}

const $brand = document.querySelector("#wx-nav .brand");
if ($brand) {
  $brand.style.cursor = "pointer";
  $brand.addEventListener("click", () => {
    if (!state.fc) return;
    Promise.resolve(renderTab(OVERVIEW_TAB)).then(() => closeOpenPanels($main));
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  });
}

$fcSelect.addEventListener("change", runAnalysis);
$rangeSelect.addEventListener("change", runAnalysis);
populateDropdown();
