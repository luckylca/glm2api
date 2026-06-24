// Performance metrics collector — sliding window + timeseries storage
// Provides RPM, TTFB P50/P90, Token speed, Session hit rate, per-model breakdown

const WINDOW_SIZES = [60, 300, 900]; // 1min, 5min, 15min in seconds

// Per-request data point (kept in sliding windows)
class RequestRecord {
  constructor(time, model, duration, status, ttfb, tokens) {
    this.time = time;
    this.model = model;
    this.duration = duration;
    this.status = status;
    this.ttfb = ttfb;
    this.tokens = tokens;
  }
}

const requestBuffer = []; // all recent records (capped at 5000)
const BUFFER_CAP = 5000;

// Session hit/miss counters (sliding window)
const sessionEvents = []; // { time, hit: bool }
const SESSION_CAP = 2000;

// Timeseries snapshots (1 per minute, 72h = 4320 points)
const TIMESERIES_CAP = 4320;
const timeseries = []; // { ts, rpm, ttfbP50, ttfbP90, tokenSpeed, sessionHitRate, errorRate, perModel: {} }
let lastSnapshotTime = 0;

// Overload counter
let overloadCount = 0;
let overloadRejectCount = 0;

// --- Recording functions ---

export function recordRequest(model, duration, status) {
  const now = Date.now();
  requestBuffer.push(new RequestRecord(now, model, duration, status, null, null));
  if (requestBuffer.length > BUFFER_CAP) requestBuffer.splice(0, requestBuffer.length - BUFFER_CAP);
}

export function recordTTFB(model, ttfb) {
  // Attach TTFB to the most recent record for this model
  for (let i = requestBuffer.length - 1; i >= 0; i--) {
    if (requestBuffer[i].model === model && requestBuffer[i].ttfb === null) {
      requestBuffer[i].ttfb = ttfb;
      return;
    }
  }
}

export function recordTokenSpeed(model, tokens, duration) {
  // Attach token count to the most recent record for this model
  for (let i = requestBuffer.length - 1; i >= 0; i--) {
    if (requestBuffer[i].model === model && requestBuffer[i].tokens === null) {
      requestBuffer[i].tokens = tokens;
      break;
    }
  }
}

export function recordSessionHit(hit) {
  const now = Date.now();
  sessionEvents.push({ time: now, hit });
  if (sessionEvents.length > SESSION_CAP) sessionEvents.splice(0, sessionEvents.length - SESSION_CAP);
}

export function recordOverload(rejected = false) {
  overloadCount++;
  if (rejected) overloadRejectCount++;
}

// --- Computation helpers ---

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  // Nearest-rank method: the p-th percentile is the value at rank
  // ceil(p/100 * n), 1-indexed. Corrects the previous ceil-1 formula which
  // biased low for small samples (e.g. n=1 returned index -1 -> clamped).
  const idx = Math.min(Math.ceil((p / 100) * sorted.length), sorted.length) - 1;
  return sorted[idx];
}

function getWindowRecords(windowSec) {
  const cutoff = Date.now() - windowSec * 1000;
  return requestBuffer.filter(r => r.time >= cutoff);
}

function getSessionHitRate(windowSec) {
  const cutoff = Date.now() - windowSec * 1000;
  const events = sessionEvents.filter(e => e.time >= cutoff);
  if (events.length === 0) return null; // no data, not 100%
  const hits = events.filter(e => e.hit).length;
  return Math.round((hits / events.length) * 100);
}

function computeModelMetrics(records) {
  const byModel = {};
  for (const r of records) {
    if (!byModel[r.model]) byModel[r.model] = { requests: [], ttfbs: [], tokenSpeeds: [], errors: 0 };
    const m = byModel[r.model];
    m.requests.push(r);
    if (r.ttfb !== null) m.ttfbs.push(r.ttfb);
    if (r.tokens !== null && r.duration > 0) m.tokenSpeeds.push(r.tokens / (r.duration / 1000));
    if (r.status >= 400) m.errors++;
  }

  const result = {};
  for (const [model, m] of Object.entries(byModel)) {
    const ttfbs = m.ttfbs.sort((a, b) => a - b);
    result[model] = {
      rpm: Math.round(m.requests.length / 5), // 5min window → per minute
      ttfbP50: ttfbs.length ? Math.round(percentile(ttfbs, 50)) : 0,
      ttfbP90: ttfbs.length ? Math.round(percentile(ttfbs, 90)) : 0,
      tokenSpeed: m.tokenSpeeds.length ? Math.round(m.tokenSpeeds.reduce((a, b) => a + b, 0) / m.tokenSpeeds.length) : 0,
      errors: m.errors,
      requests: m.requests.length,
    };
  }
  return result;
}

// --- Public query functions ---

export function getMetrics() {
  const records5m = getWindowRecords(300);
  const ttfbs = records5m.filter(r => r.ttfb !== null).map(r => r.ttfb).sort((a, b) => a - b);
  const tokenSpeeds = records5m.filter(r => r.tokens !== null && r.duration > 0).map(r => r.tokens / (r.duration / 1000));
  const errors = records5m.filter(r => r.status >= 400).length;

  return {
    rpm: Math.round(records5m.length / 5),
    ttfbP50: ttfbs.length ? Math.round(percentile(ttfbs, 50)) : 0,
    ttfbP90: ttfbs.length ? Math.round(percentile(ttfbs, 90)) : 0,
    tokenSpeed: tokenSpeeds.length ? Math.round(tokenSpeeds.reduce((a, b) => a + b, 0) / tokenSpeeds.length) : 0,
    sessionHitRate: getSessionHitRate(300),
    errorRate: records5m.length ? Math.round((errors / records5m.length) * 100) : 0,
    overloadCount,
    overloadRejectCount,
    perModel: computeModelMetrics(records5m),
    uptime: process.uptime(),
  };
}

// --- Timeseries ---

export function maybeSnapshot() {
  const now = Date.now();
  // Snapshot every 60 seconds
  if (now - lastSnapshotTime < 60000) return;
  lastSnapshotTime = now;

  const m = getMetrics();
  timeseries.push({
    ts: now,
    rpm: m.rpm,
    ttfbP50: m.ttfbP50,
    ttfbP90: m.ttfbP90,
    tokenSpeed: m.tokenSpeed,
    sessionHitRate: m.sessionHitRate,
    errorRate: m.errorRate,
    perModel: m.perModel,
  });
  if (timeseries.length > TIMESERIES_CAP) timeseries.splice(0, timeseries.length - TIMESERIES_CAP);
}

export function getTimeseries(range = '6h') {
  const rangeMs = parseRange(range);
  const cutoff = Date.now() - rangeMs;
  return timeseries.filter(p => p.ts >= cutoff);
}

function parseRange(range) {
  const map = { '1h': 3600000, '3h': 10800000, '6h': 21600000, '12h': 43200000, '24h': 86400000, '48h': 172800000, '72h': 259200000 };
  return map[range] || map['6h'];
}

// Start snapshot timer
const snapshotInterval = setInterval(maybeSnapshot, 30000); // check every 30s, snapshot every 60s
snapshotInterval.unref?.(); // don't keep process alive for this
