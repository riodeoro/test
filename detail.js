import { YEAR_MIN } from "./config.js";
import {
  ALL_SENSOR_COLS,
  STATION_DETAIL_MAX,
  loadStationConfig,
  stationSource,
  stationSeries,
  dispUnit,
} from "./data.js";
import { ready } from "./duck.js";
import { buildStationDetail, isoStamp } from "./charts.js";

const ATTR_TAB = {
  Rh: "rh",
  Wspd: "wind",
  Dir: "wind",
  Temp: "temp",
  Rn_1: "rn1",
  Vbat: "power",
};

const DIR_CONC_RE = /^Direction concentration/;

const PLOT_PREF = {
  "tab-rh": ["Rh", "Temp"],
  "tab-wind": ["Wspd", "Mx_Spd"],
  "tab-temp": ["Temp", "Rh"],
  "tab-rn1": ["Rn_1", "Rh"],
  "tab-power": ["Vbat", "Vslr"],
};

const SERIES_CACHE_MAX = 8;
const ALERT_CACHE_MAX = 24;

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  displayModeBar: "hover",
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
};

const MOBILE = () => window.matchMedia("(max-width: 768px)").matches;

let _configPromise = null;
let _config = null;
let _enginePromise = null;

export function warmConfig() {
  if (_configPromise) return _configPromise;
  _configPromise = loadStationConfig()
    .then((rows) => {
      _config = rows;
      return rows;
    })
    .catch(() => {
      _config = null;
      return null;
    });
  return _configPromise;
}

export function warmEngine() {
  if (!_enginePromise) _enginePromise = ready().catch(() => null);
  return _enginePromise;
}

function normName(s) {
  return String(s == null ? "" : s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function candidateNames(station) {
  const out = [station];
  const rows = _config;
  if (!rows || !rows.length) return out;

  const target = normName(station);
  if (!target) return out;

  const names = [];
  const seen = new Set();
  for (const r of rows) {
    const n = r.station_name;
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }

  const exact = names.find((n) => n === station);
  if (exact && !out.includes(exact)) out.push(exact);

  const norm = names.find((n) => normName(n) === target);
  if (norm && !out.includes(norm)) out.push(norm);

  const prefix = names
    .filter((n) => {
      const v = normName(n);
      return v.indexOf(target) === 0 || target.indexOf(v) === 0;
    })
    .sort((a, b) => a.length - b.length)[0];
  if (prefix && !out.includes(prefix)) out.push(prefix);

  return out;
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
    return Array.from(
      new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT)
    );
  } catch (e) {
    void e;
    return null;
  }
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function parseStamp(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const m = STAMP_RE.exec(String(v));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

const HOVER_STATION_RE = /^<b>(.*?)<\/b>/;

function axisIdsForStation(fig, station) {
  const ids = new Set();
  for (const tr of (fig && fig.data) || []) {
    const ht = tr && tr.hovertemplate;
    if (typeof ht !== "string") continue;
    const m = HOVER_STATION_RE.exec(ht);
    if (m && m[1].trim() === station) ids.add(tr.xaxis || "x");
  }
  return ids;
}

function bandHoverText(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("<br>");
  const rest = parts[0].indexOf("<b>") === 0 ? parts.slice(1) : parts;
  const out = rest.join("<br>").trim();
  return out || null;
}

function extractAlerts(fig, station) {
  const empty = { points: [], bands: [] };
  if (!fig || !Array.isArray(fig.data)) return empty;

  const ids = axisIdsForStation(fig, station);
  if (!ids.size) return empty;

  const points = [];

  const labels = new Map();

  for (const tr of fig.data) {
    if (!tr || !ids.has(tr.xaxis || "x")) continue;

    if (tr.meta && tr.meta.band_hover) {
      const xs = decodeArray(tr.x) || [];
      let first = NaN;
      for (const v of xs) {
        const t = parseStamp(v);
        if (Number.isFinite(t)) {
          first = t;
          break;
        }
      }
      const label = bandHoverText(tr.text);
      if (Number.isFinite(first) && label) labels.set(first, label);
      continue;
    }

    if (tr.mode !== "markers") continue;
    const xs = decodeArray(tr.x) || [];
    const ys = decodeArray(tr.y) || [];
    const text = decodeArray(tr.text) || [];
    const rawColor = tr.marker && tr.marker.color;
    const colors = decodeArray(rawColor);
    const flat = typeof rawColor === "string" ? rawColor : null;
    for (let i = 0; i < xs.length; i++) {
      const t = parseStamp(xs[i]);
      const y = Number(ys[i]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      points.push({
        t,
        y,
        color: (colors && colors[i]) || flat || null,
        text: text[i] == null ? "" : String(text[i]),
      });
    }
  }
  points.sort((a, b) => a.t - b.t);

  const bands = [];
  for (const s of (fig.layout && fig.layout.shapes) || []) {
    if (!s || s.type !== "rect") continue;
    if (!ids.has(typeof s.xref === "string" ? s.xref : "")) continue;
    const x0 = parseStamp(s.x0);
    const x1 = parseStamp(s.x1);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    bands.push({
      x0: Math.min(x0, x1),
      x1: Math.max(x0, x1),
      fillcolor: s.fillcolor || null,
      label: labels.get(x0) || null,
    });
  }

  return { points, bands };
}

const _alertCache = new Map();

function lruGet(map, key) {
  if (!map.has(key)) return null;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

function lruSet(map, key, value, cap) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= cap) map.delete(map.keys().next().value);
  map.set(key, value);
}

function isDirConc(b) {
  return !!(b && b.label && DIR_CONC_RE.test(b.label));
}

function ownedAlerts(col, a) {
  if (!a) return a;
  const bands = a.bands || [];
  if (col === "Dir") return { points: [], bands: bands.filter(isDirConc) };
  if (col === "Wspd") {
    return { points: a.points || [], bands: bands.filter((b) => !isDirConc(b)) };
  }
  return a;
}

function alertsFor(opts, col) {
  const suffix = ATTR_TAB[col] || null;
  if (!suffix || typeof opts.getChart !== "function") {
    return Promise.resolve(null);
  }
  const key = [opts.fc, opts.hours, suffix, opts.station].join("|");
  let p = lruGet(_alertCache, key);
  if (!p) {
    p = Promise.resolve()
      .then(() => opts.getChart(suffix))
      .then((c) =>
        c && c.station_grid ? extractAlerts(c.station_grid, opts.station) : null
      )
      .catch(() => null);
    lruSet(_alertCache, key, p, ALERT_CACHE_MAX);
  }
  return p.then((a) => ownedAlerts(col, a));
}

function primeAlerts(opts) {
  for (const c of PLOT_PREF[opts.tab] || []) alertsFor(opts, c);
}

async function windowBounds(opts) {
  if (Array.isArray(opts.range) && opts.range.length === 2) {
    const lo = parseStamp(opts.range[0]);
    const hi = parseStamp(opts.range[1]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
  }
  if (opts.tabSuffix && typeof opts.getChart === "function") {
    let c = null;
    try {
      c = await opts.getChart(opts.tabSuffix);
    } catch (e) {
      void e;
      c = null;
    }
    if (c) {
      const lo = parseStamp(c._date_min);
      const hi = parseStamp(c._date_max);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
    }
  }
  const end = Date.now();
  const span = Math.max(1, Number(opts.hours) || 168) * 3600 * 1000;
  return [end - span, end];
}

function yearsFor(startMs, endMs) {
  const lo = new Date(startMs).getUTCFullYear();
  const hi = new Date(endMs).getUTCFullYear();
  const out = [];
  for (let y = Math.max(YEAR_MIN, lo); y <= hi; y++) out.push(y);
  return out.length ? out : [hi];
}

const _seriesCache = new Map();

async function openSource(station, years) {
  await warmEngine();
  await warmConfig();
  let lastName = station;
  for (const name of candidateNames(station)) {
    lastName = name;
    let src = null;
    try {
      src = await stationSource(name, years, [name]);
    } catch (e) {
      void e;
      src = null;
    }
    if (src) return { source: src, name };
  }
  const err = new Error("no stored data for " + lastName);
  err.code = "NO_DATA";
  throw err;
}

function load(opts) {
  const key = [opts.station, opts.fc, opts.hours].join("|");

  const hit = lruGet(_seriesCache, key);
  if (hit) return hit;

  const p = (async () => {
    const [startMs, endMs] = await windowBounds(opts);
    const years = yearsFor(startMs, endMs);
    const { source, name } = await openSource(opts.station, years);

    const want = source.columns.filter((c) => ALL_SENSOR_COLS.includes(c));
    if (!want.length) {
      const err = new Error("no sensor columns");
      err.code = "NO_COLUMNS";
      throw err;
    }

    const series = await stationSeries(source, name, want, STATION_DETAIL_MAX, [
      startMs,
      endMs,
    ]);
    if (!series || !series.n) {
      const err = new Error("no rows");
      err.code = "NO_ROWS";
      throw err;
    }
    return { series, name, startMs, endMs, cols: want };
  })();

  p.catch(() => {
    if (_seriesCache.get(key) === p) _seriesCache.delete(key);
  });
  lruSet(_seriesCache, key, p, SERIES_CACHE_MAX);
  return p;
}

export function prefetch(opts) {
  if (!opts || !opts.station) return;
  warmEngine();
  primeAlerts(opts);
  load(opts).catch(() => {});
}

function wantsDir(opts, cols) {
  return opts.tab === "tab-wind" && cols.includes("Dir");
}

async function dirBands(opts) {
  let a = null;
  try {
    a = await alertsFor(opts, "Dir");
  } catch (e) {
    void e;
    a = null;
  }
  return !!(a && a.bands && a.bands.length);
}

async function preferredCols(opts, cols) {
  const pref = PLOT_PREF[opts.tab] || [];
  if (!wantsDir(opts, cols)) return pref;
  const suffix = ATTR_TAB.Dir;
  const cached =
    typeof opts.peekChart === "function" ? opts.peekChart(suffix) : true;
  if (!cached) return pref;
  return (await dirBands(opts)) ? ["Dir", "Wspd"] : pref;
}

function pickPlotCols(pref, cols) {
  const have = (c) => c && cols.includes(c);
  let primary = pref.find(have) || null;
  let secondary = pref.filter(have).find((c) => c !== primary) || null;
  if (!primary) primary = cols[0] || null;
  if (secondary === primary) secondary = null;
  return { primary, secondary };
}

function orderedCols(cols) {
  const rank = new Map(ALL_SENSOR_COLS.map((c, i) => [c, i]));
  return cols
    .slice()
    .sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
}

function detailHeight(modal, plot) {
  const vh = window.innerHeight || 800;
  const cap = Math.max(300, vh - (MOBILE() ? 16 : 56));
  const chrome = modal ? modal.offsetHeight - (plot ? plot.offsetHeight : 0) : 0;
  const avail = cap - Math.max(0, chrome) - 12;
  return Math.round(Math.max(320, Math.min(760, avail)));
}

function focusWindow(fig, startMs, endMs, view) {
  const ax = fig.layout && fig.layout.xaxis;
  if (!ax) return fig;
  const span = view || [startMs, endMs];
  ax.range = [isoStamp(span[0]), isoStamp(span[1])];
  ax.autorange = false;
  ax.rangeslider = Object.assign({}, ax.rangeslider, {
    autorange: false,
    range: [isoStamp(startMs), isoStamp(endMs)],
  });
  return fig;
}

function currentView(plot) {
  const ax = plot && plot.layout && plot.layout.xaxis;
  const r = ax && ax.range;
  if (!r || r.length !== 2) return null;
  const lo = parseStamp(r[0]);
  const hi = parseStamp(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function message(body, text) {
  body.innerHTML = "";
  body.appendChild(node("div", "wx-detail-msg", text));
}

export async function mount(host, opts) {
  const body = host.querySelector(".wx-detail-body");
  const title = host.querySelector(".wx-detail-head .t");
  if (!body) return;

  primeAlerts(opts);

  let payload;
  try {
    payload = await load(opts);
  } catch (e) {
    if (!host.isConnected) return;
    if (e && e.code === "NO_DATA")
      message(
        body,
        `No stored data found for ${opts.station}. The alert view and the ` +
          `stored data may be using different station names.`
      );
    else if (e && e.code === "NO_ROWS")
      message(
        body,
        `No observations on record for ${opts.station} in this window.`
      );
    else if (e && e.code === "NO_COLUMNS")
      message(body, `No plottable sensors on record for ${opts.station}.`);
    else {
      console.warn("station detail failed", e);
      message(body, "Could not read the station data.");
    }
    return;
  }
  if (!host.isConnected) return;

  const cols = orderedCols(payload.cols);
  const pref = await preferredCols(opts, cols);
  if (!host.isConnected) return;
  const picked = pickPlotCols(pref, cols);
  let primary = picked.primary;
  let secondary = picked.secondary;

  body.innerHTML = "";
  if (title) title.textContent = payload.name;

  const controls = node("div", "wx-detail-controls");

  const mkSelect = (labelText, value, allowNone) => {
    const wrap = node("div", "wx-detail-control");
    const lab = node("label", null, labelText);
    const sel = document.createElement("select");
    sel.className = "wx-detail-select";
    if (allowNone) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "None";
      sel.appendChild(o);
    }
    for (const c of cols) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = dispUnit(c);
      sel.appendChild(o);
    }
    sel.value = value || "";
    wrap.appendChild(lab);
    wrap.appendChild(sel);
    controls.appendChild(wrap);
    return sel;
  };

  const selPrimary = mkSelect("Attribute", primary, false);
  const selSecondary = mkSelect("Compare with", secondary, true);

  const plot = node("div", "wx-detail-plot");
  plot.style.width = "100%";

  body.appendChild(controls);
  body.appendChild(plot);

  const modal = host.querySelector(".wx-detail-modal");
  const capHeight = () => {
    const v =
      typeof opts.maxHeight === "function" ? opts.maxHeight() : opts.maxHeight;
    return Number(v) || 0;
  };
  const heightFor = () => {
    const h = detailHeight(modal, plot);
    const cap = capHeight();
    return cap ? Math.min(h, cap) : h;
  };

  let alertsPrimary = null;
  let alertsSecondary = null;

  let drawn = false;
  let wired = false;
  let showAlerts = true;

  const toggleAlerts = () => {
    showAlerts = !showAlerts;
    draw();
    return false;
  };

  const wire = () => {
    if (wired || typeof plot.on !== "function") return;
    wired = true;
    plot.on("plotly_legendclick", toggleAlerts);
    plot.on("plotly_legenddoubleclick", toggleAlerts);
  };

  const draw = () => {
    if (!plot.isConnected) return;
    const fig = buildStationDetail(
      payload.series,
      primary,
      secondary || null,
      alertsPrimary,
      alertsSecondary,
      showAlerts
    );
    focusWindow(
      fig,
      payload.startMs,
      payload.endMs,
      drawn ? currentView(plot) : null
    );
    fig.layout.height = heightFor();
    if (drawn) {
      Plotly.react(plot, fig.data, fig.layout, PLOT_CONFIG);
    } else {
      drawn = true;
      const p = Plotly.newPlot(plot, fig.data, fig.layout, PLOT_CONFIG);
      if (p && p.then) p.then(wire, () => {});
      else wire();
    }
  };

  let seq = 0;
  const syncAlerts = async (paintFirst) => {
    const token = ++seq;
    const wantPrimary = primary;
    const wantSecondary = secondary || null;
    const pending = Promise.all([
      alertsFor(opts, wantPrimary),
      wantSecondary ? alertsFor(opts, wantSecondary) : Promise.resolve(null),
    ]);
    if (paintFirst) {
      alertsPrimary = null;
      alertsSecondary = null;
      draw();
    }
    const [a, b] = await pending;
    if (token !== seq || !plot.isConnected) return;
    alertsPrimary = a;
    alertsSecondary = b;
    draw();
  };

  await syncAlerts(true);
  if (!plot.isConnected) return;

  let touched = false;

  if (wantsDir(opts, cols) && primary !== "Dir") {
    dirBands(opts).then((hit) => {
      if (!hit || touched || !plot.isConnected) return;
      primary = "Dir";
      secondary = "Wspd";
      selPrimary.value = primary;
      selSecondary.value = secondary;
      syncAlerts(true);
    });
  }

  selPrimary.addEventListener("change", () => {
    touched = true;
    primary = selPrimary.value;
    if (secondary === primary) {
      secondary = "";
      selSecondary.value = "";
    }
    syncAlerts(true);
  });
  selSecondary.addEventListener("change", () => {
    touched = true;
    secondary = selSecondary.value || null;
    if (secondary === primary) {
      secondary = null;
      selSecondary.value = "";
    }
    syncAlerts(true);
  });

  let resizeTimer = 0;
  let lastWidth = 0;

  const applySize = () => {
    if (!plot.isConnected) return;
    const w = Math.round(plot.clientWidth || 0);
    if (!w) return;
    lastWidth = w;
    const h = heightFor();
    const curW = Math.round((plot.layout && plot.layout.width) || 0);
    const curH = Math.round((plot.layout && plot.layout.height) || 0);
    if (Math.abs(curW - w) < 2 && Math.abs(curH - h) < 2) return;
    try {
      const p = Plotly.relayout(plot, { width: w, height: h });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      void e;
    }
  };

  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = 0;
      applySize();
    }, 140);
  };

  window.addEventListener("resize", onResize);

  let observer = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => {
      const w = Math.round(plot.clientWidth || 0);
      if (!w || w === lastWidth) return;
      onResize();
    });
    try {
      observer.observe(plot);
    } catch (e) {
      void e;
      observer = null;
    }
  }

  host._wxCleanup = () => {
    window.removeEventListener("resize", onResize);
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        void e;
      }
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    try {
      Plotly.purge(plot);
    } catch (e) {
      void e;
    }
  };
}

export function clearCache() {
  _seriesCache.clear();
  _alertCache.clear();
}
