import {
  R2_BASE,
  STATION_PREFIX,
  FC_PREFIX_CANDIDATES,
  STATION_CONFIG_URL,
  YEAR_MIN,
  PROBE_CONCURRENCY,
  MATERIALIZE_BYTES_MAX,
  DEFER_MATERIALIZE,
  LOCALIZE_BYTES_MAX,
  LOCALIZE_CONCURRENCY,
  LOCAL_FILES_MAX,
  ROWS_PER_FILE_GUESS,
  PRESAMPLE_MIN,
  PRESAMPLE_ROWS,
  PREVIEW_ROWS,
} from "./config.js";
import {
  qCached,
  qTable,
  exec,
  registerFile,
  dropFile,
  resetDb,
  lit,
  ident,
  num,
  str,
  pack,
} from "./duck.js";

const PERF =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("perf");

async function timed(label, fn) {
  if (!PERF) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`[wx] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
  }
}

export const FWI_COLS = ["FFMC", "ISI", "FWI", "DC", "DMC", "BUI"];

export const ALL_SENSOR_COLS = [
  "Rh", "Wspd", "Dir", "Rn_1", "Mx_Spd", "Temp", "Vbat", "Vslr", "Ibat",
  "PrecipOP2", "PrecipPC2", "SM1", "SM2", "SM3", "ST1", "ST2", "ST3", "PYR",
].concat(FWI_COLS);

export const ALL_COLS = ["STATION_NAME", "DATE_TIME_PARSED", "YEAR"].concat(
  ALL_SENSOR_COLS
);

export const COL_FALLBACK = {
  Temp: ["HOURLY_TEMPERATURE"],
  Rh: ["HOURLY_RELATIVE_HUMIDITY"],
  Wspd: ["HOURLY_WIND_SPEED"],
  Dir: ["HOURLY_WIND_DIRECTION"],
  Mx_Spd: ["HOURLY_WIND_GUST"],
  Rn_1: ["HOURLY_PRECIPITATION"],
  FFMC: ["HOURLY_FINE_FUEL_MOISTURE", "FINE_FUEL_MOISTURE_CODE"],
  ISI: ["HOURLY_INITIAL_SPREAD_INDEX", "INITIAL_SPREAD_INDEX"],
  FWI: ["HOURLY_FIRE_WEATHER_INDEX", "FIRE_WEATHER_INDEX"],
  DC: ["DROUGHT_CODE"],
  DMC: ["DUFF_MOISTURE_CODE"],
  BUI: ["BUILDUP_INDEX"],
};

export const COL_LABELS = {
  HOURLY_FINE_FUEL_MOISTURE: "FFMC",
  FINE_FUEL_MOISTURE_CODE: "FFMC",
  HOURLY_INITIAL_SPREAD_INDEX: "ISI",
  INITIAL_SPREAD_INDEX: "ISI",
  HOURLY_FIRE_WEATHER_INDEX: "FWI",
  FIRE_WEATHER_INDEX: "FWI",
  DUFF_MOISTURE_CODE: "DMC",
  DROUGHT_CODE: "DC",
  BUILDUP_INDEX: "BUI",
};

export const COL_UNITS = {
  Temp: "\u00b0C", Rh: "%", Wspd: "km/h", Mx_Spd: "km/h", Dir: "\u00b0",
  Rn_1: "mm", PrecipOP2: "mm", PrecipPC2: "mm",
  SM1: "%", SM2: "%", SM3: "%",
  ST1: "\u00b0C", ST2: "\u00b0C", ST3: "\u00b0C",
  Vbat: "V", Vslr: "V", Ibat: "A", PYR: "W/m\u00b2",
};

export const CIRCULAR_COLS = new Set(["Dir"]);

export const SID_COL = "sid";
export const HASH_COL = "_h";
export const MATCH_COL = "all_conditions_met";
export const HOUR_COL = "Hour";
export const MONTH_COL = "Month";
export const DOY_COL = "DOY";

export const LINE_CAP = 2000;
export const LINE_STRATA = 48;
export const DENSITY_BINS = 90;
export const TABLE_PAGE_SIZE = 15;
export const STATION_DETAIL_MAX = 60000;

export const INTEGER_COLS = new Set(["Hour", "Month", "DOY", "YEAR"]);

export const MATERIALIZED_MAX = 2;

export const EXTRA_LABELS = {
  [HOUR_COL]: "Hour of day",
  [MONTH_COL]: "Month",
  [DOY_COL]: "Day of year",
  YEAR: "Year",
  STATION_NAME: "Station",
  DATE_TIME_PARSED: "Time",
};

export function disp(col) {
  return COL_LABELS[col] || col;
}

export function dispUnit(col) {
  const base = disp(col);
  const u = COL_UNITS[base];
  return u ? `${base} (${u})` : base;
}

export function xLabel(col) {
  if (EXTRA_LABELS[col]) return EXTRA_LABELS[col];
  return dispUnit(col);
}

export function safeName(s) {
  return String(s == null ? "" : s).trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

export function numExpr(col) {
  if (col === "DATE_TIME_PARSED") return 'epoch("DATE_TIME_PARSED")';
  if (col === "STATION_NAME") return `"${SID_COL}"`;
  return '"' + col + '"';
}

const _headCache = new Map();
const _sizeCache = new Map();

async function exists(url) {
  if (_headCache.has(url)) return _headCache.get(url);
  const p = fetch(url, { method: "HEAD", cache: "force-cache" })
    .then((r) => {
      if (r.ok) {
        const len = Number(r.headers.get("Content-Length") || 0);
        if (len > 0) _sizeCache.set(url, len);
      }
      return r.ok;
    })
    .catch(() => false);
  _headCache.set(url, p);
  const ok = await p;
  _headCache.set(url, Promise.resolve(ok));
  return ok;
}

const _localFiles = new Map();
let _localSeq = 0;

async function evictLocalFiles() {
  while (_localFiles.size > LOCAL_FILES_MAX) {
    const oldest = _localFiles.keys().next().value;
    const name = _localFiles.get(oldest);
    _localFiles.delete(oldest);
    forgetSourcesUsing(name);
    await dropFile(name);
  }
}

export async function resetEngine() {
  _sourceCache.clear();
  _sourceFiles.clear();
  _tables.clear();
  _localFiles.clear();
  await resetDb();
}

export async function dropLocalFiles() {
  const names = Array.from(_localFiles.values());
  _localFiles.clear();
  for (const n of names) forgetSourcesUsing(n);
  for (const n of names) await dropFile(n);
}

async function localize(urls) {
  return mapLimit(urls, LOCALIZE_CONCURRENCY, async (u) => {
    const hit = _localFiles.get(u);
    if (hit) {
      _localFiles.delete(u);
      _localFiles.set(u, hit);
      return hit;
    }
    const known = _sizeCache.get(u);
    if (known !== undefined && known > LOCALIZE_BYTES_MAX) return u;
    try {
      const res = await fetch(u, { credentials: "omit" });
      if (!res.ok) return u;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > LOCALIZE_BYTES_MAX) return u;
      const name = `wx_${++_localSeq}.parquet`;
      await registerFile(name, buf);
      _localFiles.set(u, name);
      await evictLocalFiles();
      return name;
    } catch (e) {
      void e;
      return u;
    }
  });
}

async function retry(fn, attempts, waitMs) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
  throw last;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(
    async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

export function stationUrl(station, year) {
  return `${R2_BASE}/${STATION_PREFIX}/${safeName(station)}/${year}.parquet`;
}

export function fcUrl(prefix, fc, year) {
  return `${R2_BASE}/${prefix}/${safeName(fc)}/${year}.parquet`;
}

let _fcPrefix = null;

function yearRange() {
  const now = new Date().getUTCFullYear();
  const out = [];
  for (let y = now; y >= YEAR_MIN; y--) out.push(y);
  return out;
}

export async function loadStationConfig() {
  const resp = await fetch(STATION_CONFIG_URL, {
    credentials: "omit",
    cache: "no-cache",
  });
  if (!resp.ok)
    throw new Error(`station configuration request failed (${resp.status})`);
  const payload = await resp.json();
  const raw = Array.isArray(payload) ? payload : payload.rows || [];
  const rows = [];
  for (const record of raw) {
    if (!record || typeof record !== "object") continue;
    const upper = {};
    for (const key of Object.keys(record))
      upper[key.trim().toUpperCase()] = record[key];
    const en = upper.ENABLED;
    const enabled =
      en === undefined || en === null
        ? true
        : String(en).trim().toUpperCase() === "TRUE";
    rows.push({
      fire_centre: String(upper.FIRE_CENTRE == null ? "" : upper.FIRE_CENTRE).trim(),
      station_name: String(upper.STATION_NAME == null ? "" : upper.STATION_NAME).trim(),
      enabled,
    });
  }
  return rows.filter((r) => r.station_name);
}

export function fireCentres(config) {
  return Array.from(
    new Set(config.map((r) => r.fire_centre).filter(Boolean))
  ).sort();
}

export function enabledStations(config, fc) {
  return config
    .filter((r) => r.fire_centre === fc && r.enabled)
    .map((r) => r.station_name);
}

export async function yearsForFc(fc, stations) {
  const years = yearRange();
  const prefixes = _fcPrefix ? [_fcPrefix] : FC_PREFIX_CANDIDATES;
  for (const prefix of prefixes) {
    const hits = await mapLimit(years, PROBE_CONCURRENCY, async (y) =>
      (await exists(fcUrl(prefix, fc, y))) ? y : null
    );
    const found = hits.filter((y) => y !== null);
    if (found.length) {
      _fcPrefix = prefix;
      return { prefix, years: found };
    }
  }
  const probeStations = (stations || []).slice(0, 6);
  const jobs = [];
  for (const s of probeStations) for (const y of years) jobs.push([s, y]);
  const hits = await mapLimit(jobs, PROBE_CONCURRENCY, async ([s, y]) =>
    (await exists(stationUrl(s, y))) ? y : null
  );
  const found = Array.from(new Set(hits.filter((y) => y !== null))).sort(
    (a, b) => b - a
  );
  return { prefix: null, years: found };
}

export function fcPrefix() {
  return _fcPrefix || FC_PREFIX_CANDIDATES[0];
}

export async function fcUrlsFor(fc, years) {
  const prefix = fcPrefix();
  const hits = await mapLimit(years, PROBE_CONCURRENCY, async (y) =>
    (await exists(fcUrl(prefix, fc, y))) ? fcUrl(prefix, fc, y) : null
  );
  return hits.filter(Boolean);
}

export async function stationUrlsFor(stations, years) {
  const jobs = [];
  for (const s of stations) for (const y of years) jobs.push([s, y]);
  const hits = await mapLimit(jobs, PROBE_CONCURRENCY, async ([s, y]) =>
    (await exists(stationUrl(s, y))) ? stationUrl(s, y) : null
  );
  return hits.filter(Boolean);
}

function readParquet(urls) {
  if (urls.length === 1) return `read_parquet(${lit(urls[0])})`;
  const parts = urls.map((u) => `SELECT * FROM read_parquet(${lit(u)})`);
  return `(${parts.join(" UNION ALL BY NAME ")})`;
}

function canonicalMap() {
  const canonical = {};
  for (const c of ALL_SENSOR_COLS) {
    canonical[c] = c;
    for (const fb of COL_FALLBACK[c] || []) canonical[fb] = c;
  }
  return canonical;
}

async function readMeta(urls) {
  const sub = urls
    .map(
      (u, i) =>
        `SELECT ${i} AS f, path_in_schema AS c, num_values AS nv, ` +
        `COALESCE(stats_null_count, 0) AS nn FROM parquet_metadata(${lit(u)})`
    )
    .join(" UNION ALL ");
  const res = pack(
    await qTable(
      `SELECT c, COUNT(DISTINCT f) AS files, SUM(nv) AS total, ` +
        `SUM(nv) - SUM(nn) AS present FROM (${sub}) GROUP BY 1`
    )
  );
  if (!res.n) throw new Error("no parquet metadata");
  const names = str(res, "c");
  const files = num(res, "files");
  const total = num(res, "total");
  const present = num(res, "present");
  const canonical = canonicalMap();
  const cols = new Set();
  const live = new Set();
  let rows = 0;
  let uniform = true;
  for (let i = 0; i < res.n; i++) {
    const raw = names[i];
    cols.add(raw);
    if (total[i] > rows) rows = total[i];
    if (files[i] !== urls.length) uniform = false;
    const canon = canonical[raw];
    if (canon && present[i] > 0) live.add(canon);
  }
  return { cols, live, rows, uniform };
}

async function describeMeta(urls) {
  const desc = pack(
    await qTable(`DESCRIBE SELECT * FROM ${readParquet(urls)}`)
  );
  return {
    cols: new Set(str(desc, "column_name")),
    live: null,
    rows: urls.length * ROWS_PER_FILE_GUESS,
    uniform: false,
  };
}

function columnSelects(srcCols) {
  const out = [];
  for (const c of ALL_COLS) {
    if (c === "YEAR") continue;
    let name = null;
    if (srcCols.has(c)) name = c;
    else {
      for (const fb of COL_FALLBACK[c] || []) {
        if (srcCols.has(fb)) {
          name = fb;
          break;
        }
      }
    }
    if (!name) continue;
    if (c === "DATE_TIME_PARSED")
      out.push([c, `CAST(s."${name}" AS TIMESTAMP)`]);
    else out.push([c, `s."${name}"`]);
  }
  return out;
}

async function liveSensors(meta, urls, candidates) {
  if (meta.live) return candidates.filter((c) => meta.live.has(c));
  if (!candidates.length) return [];
  const expr = candidates.map((c) => `count("${c}") AS "${c}"`).join(", ");
  const res = pack(
    await qTable(`SELECT ${expr} FROM ${readParquet(urls)}`)
  );
  return candidates.filter((c) => Number(res.cols[c][0] || 0) > 0);
}

const _sourceCache = new Map();

const _sourceFiles = new Map();

function forgetSourcesUsing(name) {
  for (const [key, files] of _sourceFiles) {
    if (files.indexOf(name) < 0) continue;
    _sourceFiles.delete(key);
    _sourceCache.delete(key);
  }
}
const _tables = new Map();
let _tableSeq = 0;

function unlink(source) {
  if (!source) return;
  source.rel = source.proj;
  source.materialized = false;
  source.materializing = null;
  source.table = null;
}

export function materializeSource(source) {
  if (!source || !source.canMaterialize || source.materialized)
    return Promise.resolve(source);
  if (source.materializing) return source.materializing;
  const p = (async () => {
    const name = `obs_${++_tableSeq}`;
    try {
      await exec(
        `CREATE OR REPLACE TABLE ${ident(name)} AS SELECT * FROM ${source.proj}`
      );
      const cnt = pack(await qTable(`SELECT count(*) AS n FROM ${ident(name)}`));
      source.rows = Number(cnt.cols.n[0] || 0);
      source.rel = ident(name);
      source.table = name;
      source.materialized = true;
      _tables.set(name, source);
      await evictTables();
    } catch (e) {
      void e;
      await dropTable(name);
      source.rel = source.proj;
      source.materialized = false;
      source.canMaterialize = false;
    }
    return source;
  })();
  source.materializing = p;
  return p;
}

async function dropTable(name) {
  try {
    await exec(`DROP TABLE IF EXISTS ${ident(name)}`);
  } catch (e) {
    void e;
  }
}

async function evictTables() {
  while (_tables.size > MATERIALIZED_MAX) {
    const oldest = _tables.keys().next().value;
    unlink(_tables.get(oldest));
    _tables.delete(oldest);
    await dropTable(oldest);
  }
}

export async function dropSources() {
  _sourceCache.clear();
  _sourceFiles.clear();
  const names = Array.from(_tables.keys());
  for (const n of names) unlink(_tables.get(n));
  _tables.clear();
  for (const t of names) await dropTable(t);
}

export async function buildSource(urls, stationList, allowMaterialize) {
  const key =
    urls.join("|") +
    "::" +
    stationList.join(",") +
    "::" +
    (allowMaterialize ? "m" : "r");
  if (_sourceCache.has(key)) return _sourceCache.get(key);

  const p = (async () => {
    const files = await timed("files:fetch", () => localize(urls));

    _sourceFiles.set(
      key,
      files.filter((f) => f.indexOf("://") < 0)
    );

    let meta = null;
    try {
      meta = await timed("meta:read", () => retry(() => readMeta(files), 3, 250));
    } catch (e) {
      meta = null;
    }
    if (!meta)
      meta = await timed("meta:describe", () =>
        retry(() => describeMeta(files), 2, 250)
      );

    const src = readParquet(files);
    const selects = columnSelects(meta.cols);
    const yearExpr = meta.cols.has("YEAR")
      ? 'CAST(s."YEAR" AS SMALLINT)'
      : 'CAST(EXTRACT(year FROM CAST(s."DATE_TIME_PARSED" AS TIMESTAMP)) AS SMALLINT)';
    selects.push(["YEAR", yearExpr]);
    const rawCols = selects.map((s) => s[0]);
    const candidates = ALL_SENSOR_COLS.filter((c) => rawCols.includes(c));
    const sensors = await timed("meta:sensors", () =>
      liveSensors(meta, files, candidates)
    );

    const keep = selects.filter(
      ([name]) =>
        name === "STATION_NAME" ||
        name === "DATE_TIME_PARSED" ||
        name === "YEAR" ||
        sensors.includes(name)
    );
    const selectSql = keep
      .map(([name, expr]) => `${expr} AS "${name}"`)
      .join(", ");
    const base = `(SELECT ${selectSql} FROM ${src} s)`;

    const stnRel =
      `(VALUES ${stationList
        .map((n, i) => `(${lit(n)}, ${i})`)
        .join(", ")}) AS _s(_name, _sid)`;

    const sel = [
      `CAST(_s._sid AS USMALLINT) AS "${SID_COL}"`,
      'b."DATE_TIME_PARSED"',
      'b."YEAR"',
    ]
      .concat(sensors.map((c) => `CAST(b."${c}" AS FLOAT) AS "${c}"`))
      .concat([
        `CAST(EXTRACT(hour FROM b."DATE_TIME_PARSED") AS UTINYINT) AS "${HOUR_COL}"`,
        `CAST(EXTRACT(month FROM b."DATE_TIME_PARSED") AS UTINYINT) AS "${MONTH_COL}"`,
        `CAST(EXTRACT(doy FROM b."DATE_TIME_PARSED") AS USMALLINT) AS "${DOY_COL}"`,
        `hash(CAST(_s._sid AS BIGINT) * 100000000000 + ` +
          `CAST(epoch(b."DATE_TIME_PARSED") AS BIGINT)) AS "${HASH_COL}"`,
      ]);
    const proj =
      `(SELECT ${sel.join(", ")} FROM ${base} b ` +
      `JOIN ${stnRel} ON _s._name = b."STATION_NAME")`;

    const columns = ["DATE_TIME_PARSED", "YEAR"].concat(sensors);
    const liveCols = sensors
      .concat(["YEAR"])
      .concat([HOUR_COL, MONTH_COL, DOY_COL]);

    const perRow = 24 + 4 * sensors.length;
    const est = meta.rows * perRow * 1.4;

    const source = {
      urls,
      files,
      columns,
      liveCols,
      stations: stationList,
      rows: meta.rows,
      rel: proj,
      proj,
      materialized: false,
      materializing: null,
      canMaterialize: false,
    };

    source.canMaterialize =
      !!allowMaterialize && est > 0 && est <= MATERIALIZE_BYTES_MAX;
    if (source.canMaterialize && !DEFER_MATERIALIZE)
      await timed("materialize", () => materializeSource(source));
    if (PERF)
      console.log(
        `[wx] source: files=${urls.length} rows=${source.rows} ` +
          `sensors=${sensors.length} est=${(est / 1048576).toFixed(0)}MB ` +
          `uniform=${meta.uniform} materialized=${source.materialized}`
      );
    return source;
  })();

  _sourceCache.set(key, p);
  try {
    return await p;
  } catch (e) {
    _sourceCache.delete(key);
    _sourceFiles.delete(key);
    throw e;
  }
}

export async function resolveSource(fc, years, stations) {
  const sorted = stations.slice().sort();
  const urls = await timed("urls:probe", () => fcUrlsFor(fc, years));
  if (urls.length) return buildSource(urls, sorted, true);
  const all = await timed("urls:probe-station", () =>
    stationUrlsFor(stations, years)
  );
  if (all.length) return buildSource(all, sorted, true);
  return null;
}

export async function stationSource(station, years, stations) {
  const list = (stations || []).slice().sort();
  if (!list.length) return null;
  const urls = await stationUrlsFor([station], years);
  if (!urls.length) return null;
  return buildSource(urls, list, false);
}

export function projected(source, where) {
  return where ? `(SELECT * FROM ${source.rel} WHERE ${where})` : source.rel;
}

export function stationsInRanges(stations, ranges) {
  const out = [];
  for (let i = 0; i < stations.length; i++) {
    for (const [lo, hi] of ranges || []) {
      if (lo <= i && i <= hi) {
        out.push(stations[i]);
        break;
      }
    }
  }
  return out;
}

export function compileWhere(clauses, liveCols, stations) {
  const parts = [];
  for (const c of clauses || []) {
    const col = c.col;
    const ranges = c.ranges;
    if (!col || (!(ranges && ranges.length) && c.names == null)) continue;
    if (col === "STATION_NAME") {
      let names = c.names;
      if (names == null) names = stationsInRanges(stations, ranges);
      const ids = names
        .map((nm) => stations.indexOf(nm))
        .filter((i) => i >= 0);
      if (!ids.length) parts.push("FALSE");
      else parts.push(`("${SID_COL}" IN (${ids.join(", ")}))`);
      continue;
    }
    if (!liveCols.has(col) && col !== "DATE_TIME_PARSED") continue;
    const e = numExpr(col);
    const ors = (ranges || [])
      .map(([lo, hi]) => `(${e} >= ${Number(lo)} AND ${e} <= ${Number(hi)})`)
      .join(" OR ");
    if (ors) parts.push(`(${ors})`);
  }
  return parts.length ? parts.join(" AND ") : null;
}

export function notNullSql(cols) {
  const seen = [];
  for (const c of cols || [])
    if (c && c !== "STATION_NAME" && !seen.includes(c)) seen.push(c);
  return seen.length ? seen.map((c) => `"${c}" IS NOT NULL`).join(" AND ") : null;
}

export function andSql(...preds) {
  const live = preds.filter(Boolean);
  return live.length ? live.map((p) => `(${p})`).join(" AND ") : null;
}

function binExprs(col, loRef, hiRef, cap) {
  const span = `(${hiRef} - ${loRef})`;
  const isInt = INTEGER_COLS.has(col);
  const cond = isInt
    ? `${span} > 0 AND CAST(round(${span}) AS INTEGER) + 1 <= ${cap}`
    : "FALSE";
  const origin = `CASE WHEN ${cond} THEN ${loRef} - 0.5 ELSE ${loRef} END`;
  const step = `CASE WHEN ${cond} THEN 1.0 ELSE CASE WHEN ${span} > 0 THEN ${span} / ${cap}.0 ELSE 1.0 END END`;
  const count = `CASE WHEN ${cond} THEN CAST(round(${span}) AS INTEGER) + 1 ELSE CASE WHEN ${span} > 0 THEN ${cap} ELSE 1 END END`;
  return { origin, step, count };
}

export async function density(source, xcol, ycol, where, cap, matchWhere) {
  cap = cap || DENSITY_BINS;
  const xe = numExpr(xcol);
  const ye = numExpr(ycol);
  const rel = projected(source, where);
  const xb = binExprs(xcol, "e.lox", "e.hix", cap);
  const yb = binExprs(ycol, "e.loy", "e.hiy", cap);
  const hint = source.materialized ? "" : " MATERIALIZED";
  const msel = matchWhere ? `, CAST((${matchWhere}) AS BOOLEAN) AS m` : "";
  const magg = matchWhere ? `, count(*) FILTER (WHERE f.m) AS sn` : "";
  const sql =
    `WITH f AS${hint} (SELECT CAST(${xe} AS DOUBLE) AS x, CAST(${ye} AS DOUBLE) AS y${msel} FROM ${rel} ` +
    `WHERE ${xe} IS NOT NULL AND ${ye} IS NOT NULL), ` +
    `e AS (SELECT min(x) AS lox, max(x) AS hix, min(y) AS loy, max(y) AS hiy FROM f), ` +
    `b AS (SELECT e.lox, e.hix, e.loy, e.hiy, ` +
    `${xb.origin} AS x0, ${xb.step} AS xs, ${xb.count} AS nx, ` +
    `${yb.origin} AS y0, ${yb.step} AS ys, ${yb.count} AS ny FROM e) ` +
    `SELECT b.x0, b.xs, b.nx, b.y0, b.ys, b.ny, ` +
    `least(CAST(floor((f.x - b.x0) / b.xs) AS INTEGER), b.nx - 1) AS xb, ` +
    `least(CAST(floor((f.y - b.y0) / b.ys) AS INTEGER), b.ny - 1) AS yb, ` +
    `count(*) AS n${magg} FROM f CROSS JOIN b GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`;
  const res = await qCached(sql);
  if (!res.n) return null;
  return {
    xb: num(res, "xb"),
    yb: num(res, "yb"),
    n: num(res, "n"),
    sel: matchWhere ? num(res, "sn") : null,
    x0: Number(res.cols.x0[0]),
    xs: Number(res.cols.xs[0]),
    nx: Number(res.cols.nx[0]),
    y0: Number(res.cols.y0[0]),
    ys: Number(res.cols.ys[0]),
    ny: Number(res.cols.ny[0]),
  };
}

export async function previewSample(source, cols, where, rows) {
  const want = [];
  for (const c of cols || [])
    if (
      c &&
      !want.includes(c) &&
      (source.columns.includes(c) ||
        [HOUR_COL, MONTH_COL, DOY_COL, "YEAR", "DATE_TIME_PARSED"].includes(c))
    )
      want.push(c);
  if (want.length < 2) return null;
  const cap = Math.floor(rows || PREVIEW_ROWS);
  const rel = projected(source, where);
  const sel = want
    .map((c) => `CAST(${numExpr(c)} AS DOUBLE) AS "${c}"`)
    .join(", ");
  const stride =
    source.rows > cap ? Math.max(2, Math.ceil(source.rows / cap)) : 1;
  const gate = stride > 1 ? `(_h % ${stride}) = 0 AND ` : "";
  const notNull = want.map((c) => `"${c}" IS NOT NULL`).join(" AND ");
  const sql =
    `WITH s AS (SELECT ${sel}, "${HASH_COL}" AS _h FROM ${rel} AS _q) ` +
    `SELECT ${want.map((c) => `"${c}"`).join(", ")} FROM s ` +
    `WHERE ${gate}${notNull} LIMIT ${cap}`;
  const res = await qCached(sql);
  if (!res.n) return null;
  const data = {};
  for (const c of want) data[c] = num(res, c);
  return { data, n: res.n, cols: want };
}

export async function lineSample(
  source,
  dims,
  where,
  colourCol,
  cap,
  bins,
  extraCols
) {
  cap = cap || LINE_CAP;
  bins = bins || LINE_STRATA;
  const usable = (dims || []).filter(
    (d) =>
      source.columns.includes(d) ||
      [HOUR_COL, MONTH_COL, DOY_COL, "YEAR", "STATION_NAME"].includes(d)
  );
  if (!usable.length) return null;
  const want = [];
  for (const d of usable) if (!want.includes(d)) want.push(d);
  if (colourCol && !want.includes(colourCol)) want.push(colourCol);
  for (const c of extraCols || []) if (c && !want.includes(c)) want.push(c);

  const rel = projected(source, where);
  const collist = want
    .map((c) => `CAST(${numExpr(c)} AS DOUBLE) AS "${c}"`)
    .join(", ");
  const stride =
    source.rows > PRESAMPLE_MIN
      ? Math.max(2, Math.ceil(source.rows / PRESAMPLE_ROWS))
      : 1;
  const sampleWhere = stride > 1 ? ` WHERE (_h % ${stride}) = 0` : "";

  const numeric = usable.filter((d) => d !== "STATION_NAME");
  const extSel = numeric
    .map((d, i) => `min("${d}") AS lo${i}, max("${d}") AS hi${i}`)
    .join(", ");

  const ranks = [];
  usable.forEach((d, i) => {
    if (d === "STATION_NAME") {
      ranks.push(
        `row_number() OVER (PARTITION BY "STATION_NAME" ORDER BY _h) AS _r${i}`
      );
      return;
    }
    const j = numeric.indexOf(d);
    const step = `((e.hi${j} - e.lo${j}) / ${bins}.0)`;
    const key = `CASE WHEN e.hi${j} > e.lo${j} THEN least(CAST(floor(("${d}" - e.lo${j}) / ${step}) AS INTEGER), ${
      bins - 1
    }) ELSE 0 END`;
    ranks.push(`row_number() OVER (PARTITION BY ${key} ORDER BY _h) AS _r${i}`);
  });
  const rcols = ranks.map((r) => r.split(" AS ").pop());
  const best = rcols.length === 1 ? rcols[0] : `least(${rcols.join(", ")})`;
  const extOut = numeric
    .map((d, i) => `q.lo${i} AS "lo_${i}", q.hi${i} AS "hi_${i}"`)
    .join(", ");
  const orderBy = best.replace(/(_r\d+)/g, "q.$1");

  const scanHint = stride > 1 ? "" : " MATERIALIZED";
  const sql =
    `WITH s AS${scanHint} (SELECT ${collist}, "${HASH_COL}" AS _h FROM ${rel} AS _q), ` +
    `p AS (SELECT * FROM s${sampleWhere}), ` +
    `e AS (SELECT ${extSel || "1 AS dummy"} FROM s) ` +
    `SELECT ${want.map((c) => `q."${c}"`).join(", ")}` +
    `${extOut ? ", " + extOut : ""} ` +
    `FROM (SELECT p.*, e.*, ${ranks.join(", ")} FROM p CROSS JOIN e) q ` +
    `ORDER BY ${orderBy}, q._h LIMIT ${Math.floor(cap)}`;

  const res = await qCached(sql);
  if (!res.n) return null;
  const data = {};
  for (const c of want) data[c] = num(res, c);
  const extents = {};
  numeric.forEach((d, i) => {
    const lo = Number(res.cols[`lo_${i}`][0]);
    const hi = Number(res.cols[`hi_${i}`][0]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) extents[d] = [lo, hi];
  });
  return { data, extents, dims: usable, n: res.n };
}

const SUMMARY_SORT = {
  STATION_NAME: `"${SID_COL}"`,
  n: "n",
  first_t: "first_t_ms",
  last_t: "last_t_ms",
  x_avg: "x_avg",
  y_avg: "y_avg",
};

export async function stationSummary(
  source,
  where,
  xcol,
  ycol,
  sortBy,
  offset,
  limit
) {
  const sel = [
    `"${SID_COL}"`,
    "count(*) AS n",
    'min("DATE_TIME_PARSED") AS first_t',
    'max("DATE_TIME_PARSED") AS last_t',
  ];
  const avgKeys = [];
  for (const [key, col] of [
    ["x_avg", xcol],
    ["y_avg", ycol],
  ]) {
    if (col && col !== "DATE_TIME_PARSED") {
      sel.push(`avg(CAST(${numExpr(col)} AS DOUBLE)) AS ${key}`);
      avgKeys.push(key);
    }
  }
  const terms = [];
  for (const sb of sortBy || []) {
    const expr = SUMMARY_SORT[sb.column_id];
    if (expr && (avgKeys.includes(sb.column_id) || !sb.column_id.endsWith("_avg")))
      terms.push(`${expr} ${sb.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`);
  }
  const order =
    "ORDER BY " + (terms.length ? terms.join(", ") : `n DESC, "${SID_COL}"`);
  const outSel = [
    `"${SID_COL}"`,
    "n",
    'CAST(epoch_ms(first_t) AS DOUBLE) AS first_t_ms',
    'CAST(epoch_ms(last_t) AS DOUBLE) AS last_t_ms',
  ].concat(avgKeys);
  const sql =
    `WITH g AS (SELECT ${sel.join(", ")} FROM ${projected(source, where)} ` +
    `GROUP BY "${SID_COL}") ` +
    `SELECT ${outSel.join(", ")}, count(*) OVER () AS _total FROM g ` +
    `${order} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}`;
  const res = await qCached(sql);
  const rows = [];
  const sid = num(res, SID_COL);
  const n = num(res, "n");
  const f = num(res, "first_t_ms");
  const l = num(res, "last_t_ms");
  const xa = avgKeys.includes("x_avg") ? num(res, "x_avg") : null;
  const ya = avgKeys.includes("y_avg") ? num(res, "y_avg") : null;
  for (let i = 0; i < res.n; i++) {
    rows.push({
      STATION_NAME: source.stations[sid[i]] || "",
      n: n[i],
      first_t: f[i],
      last_t: l[i],
      x_avg: xa ? xa[i] : null,
      y_avg: ya ? ya[i] : null,
    });
  }
  const total = res.n ? Number(res.cols._total[0]) : 0;
  return { rows, total, avgKeys };
}

function tsLiteral(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export async function stationSeries(source, station, cols, limit, range) {
  limit = limit || STATION_DETAIL_MAX;
  const sid = source.stations.indexOf(station);
  if (sid < 0) return { n: 0, t: new Float64Array(0), cols: [] };
  const allowed = new Set(
    source.columns.concat([HOUR_COL, MONTH_COL, DOY_COL])
  );
  const want = [];
  for (const c of cols || [])
    if (c && allowed.has(c) && !want.includes(c)) want.push(c);
  const preds = [`"${SID_COL}" = ${sid}`];
  if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    preds.push(`"DATE_TIME_PARSED" >= TIMESTAMP '${tsLiteral(range[0])}'`);
    preds.push(`"DATE_TIME_PARSED" <= TIMESTAMP '${tsLiteral(range[1])}'`);
  }
  const rel = projected(source, preds.join(" AND "));
  const sel = ['CAST(epoch_ms("DATE_TIME_PARSED") AS DOUBLE) AS t_ms'].concat(
    want.map((c) => `CAST("${c}" AS DOUBLE) AS "${c}"`)
  );
  const sql =
    `SELECT ${sel.join(", ")} FROM ${rel} ORDER BY "DATE_TIME_PARSED" ` +
    `LIMIT ${Math.floor(limit)}`;
  const res = await qCached(sql);
  const out = { n: res.n, t: num(res, "t_ms") };
  for (const c of want) out[c] = num(res, c);
  out.cols = want;
  return out;
}
