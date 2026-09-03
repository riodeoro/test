import {
  DUCKDB_CDN,
  POOL_SIZE,
  SQL_CACHE_MAX,
  MEMORY_LIMIT,
} from "./config.js";

let _duckdb = null;
let _db = null;
let _pool = [];
let _rr = 0;
let _boot = null;
let _threads = 1;
let _fatal = false;

function note(e) {
  const m = String((e && e.message) || e || "");
  if (
    m.indexOf("database has been invalidated") >= 0 ||
    m.indexOf("FATAL Error") >= 0 ||
    m.indexOf("INTERNAL Error") >= 0
  )
    _fatal = true;
  return e;
}

export function fatal() {
  return _fatal;
}

export function lit(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export function litList(values) {
  return "(" + values.map(lit).join(", ") + ")";
}

export function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function threaded() {
  return _threads > 1;
}

async function boot() {
  _duckdb = await import(DUCKDB_CDN);
  const bundles = _duckdb.getJsDelivrBundles();
  const bundle = await _duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: "text/javascript",
    })
  );
  const worker = new Worker(workerUrl);
  _db = new _duckdb.AsyncDuckDB(new _duckdb.VoidLogger(), worker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const coi =
    !!bundle.pthreadWorker &&
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated === true;
  _threads = coi
    ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8))
    : 1;

  try {
    await _db.open({
      path: ":memory:",
      query: { castBigIntToDouble: true, castDecimalToDouble: true },
    });
  } catch (e) {
    void e;
    await _db.open({ path: ":memory:" });
  }

  const size = coi ? POOL_SIZE : 2;
  const conns = await Promise.all(
    new Array(size).fill(0).map(() => _db.connect())
  );
  const stmts = [
    "SET TimeZone='UTC'",
    `SET threads=${_threads}`,
    `SET memory_limit='${MEMORY_LIMIT}'`,
    "SET enable_http_metadata_cache=true",
    "SET enable_object_cache=true",
    "SET reliable_head_requests=true",
    "SET http_keep_alive=true",
    "SET http_retries=5",
    "SET http_retry_wait_ms=150",
    "SET http_retry_backoff=2",
    "SET http_timeout=60000",
    "SET disabled_optimizers='statistics_propagation'",
    "SET preserve_insertion_order=false",
    "SET default_null_order='nulls_last'",
  ];
  await Promise.all(
    conns.map(async (c) => {
      for (const stmt of stmts) {
        try {
          await c.query(stmt);
        } catch (err) {
          void err;
        }
      }
    })
  );
  _pool = conns;
  return _pool;
}

export function ready() {
  if (!_boot) _boot = boot();
  return _boot;
}

export async function registerFile(name, bytes) {
  await ready();
  await _db.registerFileBuffer(name, bytes);
}

export async function dropFile(name) {
  await ready();
  try {
    await _db.dropFile(name);
  } catch (e) {
    void e;
  }
}

const _cache = new Map();

function cacheGet(key) {
  if (!_cache.has(key)) return undefined;
  const v = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  else if (_cache.size >= SQL_CACHE_MAX)
    _cache.delete(_cache.keys().next().value);
  _cache.set(key, value);
}

export function dropCache() {
  _cache.clear();
}

export async function qTable(sql) {
  await ready();
  const con = _pool[_rr++ % _pool.length];
  try {
    return await con.query(sql);
  } catch (e) {
    throw note(e);
  }
}

export async function exec(sql) {
  await ready();
  try {
    return await _pool[0].query(sql);
  } catch (e) {
    throw note(e);
  }
}

export async function resetDb() {
  const db = _db;
  _boot = null;
  _db = null;
  _pool = [];
  _rr = 0;
  _threads = 1;
  _fatal = false;
  _cache.clear();
  try {
    if (db) await db.terminate();
  } catch (e) {
    void e;
  }
  return ready();
}

export async function cancelAll() {
  if (!_pool.length) return;
  await Promise.all(
    _pool.map(async (c) => {
      try {
        await c.cancelSent();
      } catch (e) {
        void e;
      }
    })
  );
}

export async function qCached(sql) {
  const hit = cacheGet(sql);
  if (hit !== undefined) return hit;
  const pending = qTable(sql).then((t) => {
    const out = pack(t);
    cacheSet(sql, out);
    return out;
  });
  cacheSet(sql, pending);
  try {
    const res = await pending;
    cacheSet(sql, res);
    return res;
  } catch (e) {
    _cache.delete(sql);
    throw e;
  }
}

export function pack(table) {
  const names = table.schema.fields.map((f) => f.name);
  const n = table.numRows;
  const cols = {};
  for (const name of names) {
    const vec = table.getChild(name);
    if (vec && vec.nullCount === 0) {
      let fast = null;
      try {
        fast = vec.toArray();
      } catch (e) {
        fast = null;
      }
      if (fast && ArrayBuffer.isView(fast) && fast.length === n) {
        cols[name] = fast;
        continue;
      }
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = vec.get(i);
      out[i] = v === undefined ? null : v;
    }
    cols[name] = out;
  }
  return { names, n, cols };
}

export function num(res, name) {
  const src = res.cols[name];
  if (src instanceof Float64Array && src.length === res.n) return src;
  const out = new Float64Array(res.n);
  if (!src) {
    out.fill(NaN);
    return out;
  }
  for (let i = 0; i < res.n; i++) {
    const v = src[i];
    out[i] = v === null || v === undefined ? NaN : Number(v);
  }
  return out;
}

export function str(res, name) {
  const src = res.cols[name] || [];
  const out = new Array(res.n);
  for (let i = 0; i < res.n; i++) {
    const v = src[i];
    out[i] = v === null || v === undefined ? null : String(v);
  }
  return out;
}

export function scalar(res, name, row) {
  const c = res.cols[name];
  if (!c || !c.length) return null;
  const v = c[row || 0];
  return v === undefined ? null : v;
}
