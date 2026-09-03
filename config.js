export const R2_BASE = "https://pub-2a711106493b40bfb7f30c3e6af0e26e.r2.dev";

export const STATION_PREFIX = "optimized_data/partitioned_by_station";

export const FC_PREFIX_CANDIDATES = [
  "optimized_data/partitioned_by_fire_centre",
];

export const FC_MANIFEST_PREFIX = "fc_chart_manifests";

export const STATION_CONFIG_URL = `${R2_BASE}/stations.json`;

export const DUCKDB_CDN =
  "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

export const YEAR_MIN = 2000;

export const STATION_PARTITION_MAX = 12;

export const POOL_SIZE = 4;

export const PROBE_CONCURRENCY = 24;

export const SQL_CACHE_MAX = 96;

export const MATERIALIZE_BYTES_MAX = 700 * 1024 * 1024;

export const LOCALIZE_BYTES_MAX = 64 * 1024 * 1024;

export const LOCALIZE_CONCURRENCY = 4;

export const LOCAL_FILES_MAX = 8;

export const MEMORY_LIMIT = "3GB";

export const DEFER_MATERIALIZE = false;

export const ROWS_PER_FILE_GUESS = 50 * 8784;

export const PRESAMPLE_MIN = 60000;

export const PRESAMPLE_ROWS = 60000;

export const PRESAMPLE_SEED = 77;

export const PREVIEW_ROWS = 1000000;
