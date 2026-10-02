import { R2_BASE } from "./config.js";
import { safeName, disp } from "./data.js";
import { isoStamp } from "./charts.js";

export const NORMALS_PREFIX = "normals";
export const RAIN_COL = "Rn_1";
export const MIN_YEARS = 3;
export const HOURLY_MAX_HOURS = 336;

const FORMAT_VERSION = 2;
const CACHE_MAX = 16;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_POINTS = 800;
const RAIN_MAX_MISSING = 0.2;
const FEB29 = 60;
const CUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

const BAND_FILLS = [
  "rgba(229, 231, 235, 0.5)",
  "rgba(191, 219, 254, 0.5)",
  "rgba(209, 250, 229, 0.5)",
  "rgba(254, 249, 195, 0.5)",
  "rgba(253, 230, 138, 0.5)",
  "rgba(252, 165, 165, 0.5)",
];
const INVERTED = new Set(["Rh", "Rn_1", "SM1", "SM2", "SM3"]);
const LINE_ON_BANDS = "#26231f";
const YEAR_COLOR = "#4b5563";
const YEAR_GAP_FACTOR = 3;
const YEAR_GAP_MIN_MS = 2 * HOUR_MS;

const STAT = { lo: 0, p10: 1, p25: 2, p50: 3, p75: 4, p90: 5, hi: 6 };
const EDGES = ["lo", "p10", "p25", "p50", "p75", "p90", "hi"];

function emptyBand() {
  const out = { x: [] };
  for (const k of EDGES) out[k] = [];
  return out;
}

const _cache = new Map();

function lruGet(key) {
  if (!_cache.has(key)) return undefined;
  const v = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, v);
  return v;
}

function lruSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  else if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, value);
}

export function normalsUrl(station) {
  return `${R2_BASE}/${NORMALS_PREFIX}/${safeName(station)}.json`;
}

export function loadNormals(station) {
  if (!station) return Promise.resolve(null);
  const key = safeName(station);
  const hit = lruGet(key);
  if (hit) return hit;
  const p = fetch(normalsUrl(station), { credentials: "omit" })
    .then((res) => (res.ok ? res.json() : null))
    .then((n) => (n && n.v === FORMAT_VERSION && n.attrs ? n : null))
    .catch(() => null);
  lruSet(key, p);
  return p;
}

export function supports(normals, col) {
  if (!normals || !col) return false;
  if (col === RAIN_COL) return !!(normals.rain && normals.rain.n >= MIN_YEARS);
  const a = normals.attrs && normals.attrs[col];
  return !!(a && a.n >= MIN_YEARS && Array.isArray(a.d));
}

export function anySupported(normals, cols) {
  return (cols || []).some((c) => supports(normals, c));
}

export function pastYears(normals, cols, endMs) {
  const endYear = new Date(endMs).getUTCFullYear();
  const found = new Set();
  for (const col of cols || []) {
    if (!supports(normals, col)) continue;
    if (col === RAIN_COL) {
      for (const y of normals.rain.years) found.add(y);
      continue;
    }
    const a = normals.attrs[col];
    if (Array.isArray(a.yrs)) for (const y of a.yrs) found.add(y);
    else for (let y = a.y[0]; y <= a.y[1]; y++) found.add(y);
  }
  return Array.from(found).filter((y) => y < endYear).sort((a, b) => b - a);
}

export function shiftYears(ms, k) {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + k);
  return d.getTime();
}

function doy366(ms) {
  const d = new Date(ms);
  return CUM_DAYS[d.getUTCMonth()] + d.getUTCDate();
}

function slot(arr, i) {
  const v = arr ? arr[i] : null;
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

function mix(a, b, f) {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

function hourlyIndex(centres, ms) {
  const doy = doy366(ms) + new Date(ms).getUTCHours() / 24;
  let i0 = centres.length - 1;
  for (let i = 0; i < centres.length - 1; i++) {
    if (doy < centres[i + 1]) {
      i0 = i;
      break;
    }
  }
  const last = i0 === centres.length - 1;
  const i1 = last ? 0 : i0 + 1;
  const span = last ? 366 - centres[i0] + centres[0] : centres[i1] - centres[i0];
  const f = Math.min(1, Math.max(0, (doy - centres[i0]) / span));
  return { i0, i1, f };
}

function gridTimes(startMs, endMs) {
  const first = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  const step = Math.max(HOUR_MS, Math.ceil((endMs - first) / MAX_POINTS / HOUR_MS) * HOUR_MS);
  const out = [];
  for (let t = first; t <= endMs; t += step) out.push(t);
  return out;
}

function hourlyBand(attr, centres, startMs, endMs) {
  const out = emptyBand();
  for (const t of gridTimes(startMs, endMs)) {
    const { i0, i1, f } = hourlyIndex(centres, t);
    const h = new Date(t).getUTCHours();
    out.x.push(t);
    for (const k of Object.keys(STAT)) {
      const arr = attr.h[STAT[k]];
      out[k].push(mix(slot(arr, i0 * 24 + h), slot(arr, i1 * 24 + h), f));
    }
  }
  return out;
}

function dailyBand(attr, startMs, endMs) {
  const out = emptyBand();
  for (const t of gridTimes(startMs, endMs)) {
    const noon = Math.floor((t - DAY_MS / 2) / DAY_MS) * DAY_MS + DAY_MS / 2;
    const f = (t - noon) / DAY_MS;
    const i0 = doy366(noon) - 1;
    const i1 = doy366(noon + DAY_MS) - 1;
    out.x.push(t);
    for (const k of Object.keys(STAT)) {
      const arr = attr.d[STAT[k]];
      out[k].push(mix(slot(arr, i0), slot(arr, i1), f));
    }
  }
  return out;
}

export function bandFor(normals, col, startMs, endMs) {
  if (!supports(normals, col) || col === RAIN_COL) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const attr = normals.attrs[col];
  const hours = (endMs - startMs) / HOUR_MS;
  const centres = normals.hourly_centres;
  const hourly = hours <= HOURLY_MAX_HOURS && Array.isArray(attr.h) && Array.isArray(centres);
  const band = hourly ? hourlyBand(attr, centres, startMs, endMs) : dailyBand(attr, startMs, endMs);
  if (!band.p50.some((v) => v !== null)) return null;
  band.kind = hourly ? "hourly" : "daily";
  band.n = attr.n;
  band.years = attr.y;
  return band;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function rainBandFor(normals, startMs, endMs) {
  if (!supports(normals, RAIN_COL)) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const rain = normals.rain;
  const byYear = new Map(rain.years.map((y, i) => [y, rain.daily[i]]));
  const endYear = new Date(endMs).getUTCFullYear();

  const segments = [];
  for (let d = Math.floor(startMs / DAY_MS) * DAY_MS; d < endMs; d += DAY_MS) {
    const a = Math.max(d, startMs);
    const b = Math.min(d + DAY_MS, endMs);
    if (b > a) segments.push({ day: d, end: b, frac: (b - a) / DAY_MS });
  }
  if (!segments.length) return null;

  const curves = [];
  const used = [];
  for (const year of rain.years) {
    const k = endYear - year;
    if (k < 1) continue;
    let total = 0;
    let missing = 0;
    const curve = [0];
    for (const s of segments) {
      const date = new Date(s.day);
      const daily = byYear.get(date.getUTCFullYear() - k);
      const i = doy366(s.day) - 1;
      let v = daily ? slot(daily, i) : null;
      if (v === null && i === FEB29 - 1 && daily) v = 0;
      if (v === null) missing += 1;
      else total += v * s.frac;
      curve.push(total);
    }
    if (missing > segments.length * RAIN_MAX_MISSING) continue;
    curves.push(curve);
    used.push(year);
  }
  if (used.length < MIN_YEARS) return null;

  const out = emptyBand();
  const bounds = [startMs].concat(segments.map((s) => s.end));
  let j = 0;
  for (const t of gridTimes(startMs, endMs)) {
    while (j < bounds.length - 2 && t > bounds[j + 1]) j++;
    const f = (t - bounds[j]) / (bounds[j + 1] - bounds[j]);
    const vals = curves.map((c) => c[j] + (c[j + 1] - c[j]) * f).sort((a, b) => a - b);
    out.x.push(t);
    out.lo.push(vals[0]);
    out.p10.push(quantile(vals, 0.1));
    out.p25.push(quantile(vals, 0.25));
    out.p50.push(quantile(vals, 0.5));
    out.p75.push(quantile(vals, 0.75));
    out.p90.push(quantile(vals, 0.9));
    out.hi.push(vals[vals.length - 1]);
  }
  out.kind = "rain";
  out.n = used.length;
  out.years = [used[0], used[used.length - 1]];
  return out;
}

export function cumulativeSeries(series, col) {
  const src = series && series[col];
  if (!src) return series;
  const out = Object.assign({}, series);
  const cum = new Float64Array(series.n);
  let total = 0;
  for (let i = 0; i < series.n; i++) {
    const v = src[i];
    if (Number.isFinite(v)) {
      total += Math.max(0, v);
      cum[i] = total;
    } else {
      cum[i] = NaN;
    }
  }
  out[col] = cum;
  return out;
}

function nearestIndex(t, target) {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(t[lo - 1] - target) <= Math.abs(t[lo] - target)) return lo - 1;
  return lo;
}

export function remapAlerts(alerts, series, col) {
  if (!alerts || !alerts.points || !alerts.points.length) return alerts;
  const t = series.t;
  const v = series[col];
  if (!t || !v || !series.n) return alerts;
  const points = [];
  for (const p of alerts.points) {
    const i = nearestIndex(t, p.t);
    const y = v[i];
    if (Number.isFinite(y)) points.push(Object.assign({}, p, { y }));
  }
  return Object.assign({}, alerts, { points });
}

function axisKey(yaxis) {
  return yaxis === "y" ? "yaxis" : "yaxis" + yaxis.slice(1);
}

function fmt(v) {
  return v === null ? null : Math.round(v * 10) / 10;
}

function under(x, y, yaxis, extra) {
  return Object.assign(
    {
      type: "scatter",
      mode: "lines",
      x,
      y,
      xaxis: "x",
      yaxis,
      showlegend: false,
      connectgaps: false,
      line: { width: 0 },
    },
    extra
  );
}

function pairs(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = [a[i], b[i]];
  return out;
}

const PAIR = "%{customdata[0]:.1f} \u2013 %{customdata[1]:.1f}<extra></extra>";

function bandTraces(band, yaxis, col) {
  const x = band.x.map(isoStamp);
  const fills = INVERTED.has(col) ? BAND_FILLS.slice().reverse() : BAND_FILLS;
  const ys = {};
  for (const edge of EDGES) ys[edge] = band[edge].map(fmt);
  const hover = {
    p90: { customdata: pairs(ys.lo, ys.hi), hovertemplate: "Range: " + PAIR },
    p75: { customdata: pairs(ys.p10, ys.p90), hovertemplate: "P10\u2013P90: " + PAIR },
    p50: { customdata: pairs(ys.p25, ys.p75), hovertemplate: "P25\u2013P75: " + PAIR },
    p25: {
      customdata: ys.p50,
      hovertemplate: "Median: %{customdata:.1f}<extra></extra>",
    },
  };
  const out = [];
  for (let i = EDGES.length - 1; i >= 0; i--) {
    const edge = EDGES[i];
    const extra = hover[edge] ? Object.assign({}, hover[edge]) : { hoverinfo: "skip" };
    if (i < EDGES.length - 1) {
      extra.fill = "tonexty";
      extra.fillcolor = fills[i];
    }
    out.push(under(x, ys[edge], yaxis, extra));
  }
  return out;
}

function lineOnBands(fig, col, yaxis) {
  const name = disp(col);
  for (const tr of fig.data) {
    if (!tr || (tr.yaxis || "y") !== yaxis || tr.name !== name) continue;
    if (tr.fill) tr.fill = "none";
    if (tr.line) tr.line = Object.assign({}, tr.line, { color: LINE_ON_BANDS });
    if (tr.marker) tr.marker = Object.assign({}, tr.marker, { color: LINE_ON_BANDS });
  }
}

function gapLimit(times) {
  const steps = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) steps.push(d);
  }
  if (!steps.length) return Infinity;
  steps.sort((a, b) => a - b);
  const mid = steps.length >> 1;
  const median = steps.length % 2 ? steps[mid] : (steps[mid - 1] + steps[mid]) / 2;
  return Math.max(YEAR_GAP_FACTOR * median, YEAR_GAP_MIN_MS);
}

function yearTraces(pick, col, yaxis) {
  const series = pick && pick.series;
  const v = series && series[col];
  if (!v || !series.n) return [];
  const times = [];
  const vals = [];
  for (let i = 0; i < series.n; i++) {
    if (!Number.isFinite(v[i])) continue;
    times.push(series.t[i]);
    vals.push(fmt(v[i]));
  }
  if (!times.length) return [];
  const limit = gapLimit(times);
  const x = [];
  const y = [];
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > limit) {
      x.push(isoStamp(times[i - 1] + 1000));
      y.push(null);
    }
    x.push(isoStamp(times[i]));
    y.push(vals[i]);
  }
  return [
    under(x, y, yaxis, {
      mode: times.length === 1 ? "lines+markers" : "lines",
      marker: { color: YEAR_COLOR, size: 3 },
      line: { color: YEAR_COLOR, width: 1.4, dash: "dot" },
      hovertemplate: `${pick.year}: %{y:.1f}<extra></extra>`,
    }),
  ];
}

export function applyNormals(fig, normals, col, yaxis, startMs, endMs, pick) {
  if (!fig || !fig.layout || !Array.isArray(fig.data) || !col) return false;
  if (!fig.layout[axisKey(yaxis)]) return false;
  const band = col === RAIN_COL
    ? rainBandFor(normals, startMs, endMs)
    : bandFor(normals, col, startMs, endMs);
  if (!band) return false;
  fig.data = bandTraces(band, yaxis, col).concat(yearTraces(pick, col, yaxis), fig.data);
  lineOnBands(fig, col, yaxis);
  return true;
}
