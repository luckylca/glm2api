import { getAccessToken, generateDeviceId } from './chat.js';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PER_TOKEN || '2', 10);
const DEAD_THRESHOLD = parseInt(process.env.TOKEN_DEAD_THRESHOLD || '5', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '600', 10) * 1000;

// Token pool: each entry has a refreshToken → current accessToken
const pool = [];
let nextId = 1;

export function getPoolInfo() {
  return pool.map(t => ({
    id: t.id,
    token: t.refreshToken.slice(0, 12) + '...',
    fullToken: t.refreshToken,
    email: null,
    dead: t.dead,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    maxConcurrent: t.maxConcurrent,
    visionCapable: t.visionCapable ?? false,
    lastUsed: t.lastUsed,
  }));
}

export function getTotalCapacity() {
  return pool.reduce((sum, t) => sum + (t.dead ? 0 : t.maxConcurrent), 0);
}

export function getAliveTokens() {
  return pool.filter(t => !t.dead);
}

export function acquireToken() {
  let best = null;
  for (const t of pool) {
    if (t.dead) continue;
    if (!t.accessToken) continue;
    if (t.activeRequests >= t.maxConcurrent) continue;
    if (best == null || t.activeRequests < best.activeRequests) {
      best = t;
    }
  }
  if (!best) return null;

  best.activeRequests++;
  best.lastUsed = Date.now();

  let released = false;
  return {
    token: best.accessToken,
    deviceId: best.deviceId,
    poolEntry: best,
    release: () => {
      if (released) return;
      released = true;
      best.activeRequests = Math.max(0, best.activeRequests - 1);
      best.lastUsed = Date.now();
    },
  };
}

export function reportTokenError(token) {
  for (const t of pool) {
    if (t.accessToken === token) {
      t.errorCount++;
      if (t.errorCount >= DEAD_THRESHOLD) {
        t.dead = true;
        console.warn(`Token ${t.refreshToken.slice(0, 12)}... marked DEAD`);
      }
      return;
    }
  }
}

export function reportTokenSuccess(token) {
  for (const t of pool) {
    if (t.accessToken === token) {
      t.errorCount = 0;
      return;
    }
  }
}

export function markTokenDead(token) {
  for (const t of pool) {
    if (t.accessToken === token) {
      t.dead = true;
      return;
    }
  }
}

export async function addTokenToPool(refreshToken) {
  const trimmed = refreshToken.trim();
  try {
    const { accessToken, deviceId } = await getAccessToken(trimmed);
    const entry = {
      id: nextId++,
      refreshToken: trimmed,
      accessToken,
      deviceId,
      activeRequests: 0,
      maxConcurrent: MAX_CONCURRENT,
      errorCount: 0,
      dead: false,
      lastUsed: Date.now(),
      visionCapable: true,
    };
    pool.push(entry);
    console.log(`Token added: ${trimmed.slice(0, 12)}...`);
    return { dead: false };
  } catch (err) {
    console.error(`Failed to add token ${trimmed.slice(0, 12)}...:`, err.message);
    throw err;
  }
}

export function deleteTokenFromPool(id) {
  const idx = pool.findIndex(t => t.id === id);
  if (idx === -1) return { success: false, message: 'Token not found' };
  pool.splice(idx, 1);
  return { success: true };
}

export async function initTokenPool() {
  const tokensStr = (process.env.REFRESH_TOKEN || '').trim();
  if (!tokensStr) {
    console.warn('No REFRESH_TOKEN configured — add REFRESH_TOKEN to .env');
    return;
  }

  const tokens = tokensStr.split(',').map(t => t.trim()).filter(Boolean);
  console.log(`Token pool: ${tokens.length} refresh token(s), max ${MAX_CONCURRENT} concurrent each`);

  for (const token of tokens) {
    try {
      await addTokenToPool(token);
    } catch (err) {
      console.error(`Failed to init token ${token.slice(0, 12)}...:`, err.message);
    }
  }

  const alive = pool.filter(t => !t.dead).length;
  console.log(`Pool ready: ${alive}/${pool.length} tokens alive`);
}

export function startHealthCheck() {
  setInterval(async () => {
    for (const t of pool) {
      if (t.dead) continue;
      try {
        const { accessToken, deviceId } = await getAccessToken(t.refreshToken);
        t.accessToken = accessToken;
        t.deviceId = deviceId;
        t.errorCount = 0;
      } catch (err) {
        console.error(`Health check failed for ${t.refreshToken.slice(0, 12)}...:`, err.message);
        t.errorCount++;
        if (t.errorCount >= DEAD_THRESHOLD) t.dead = true;
      }
    }
  }, HEALTH_CHECK_INTERVAL);
}

// Thread-local token for request logging
let currentRequestToken = null;
export function setRequestToken(token) { currentRequestToken = token; }
export function getRequestToken() { return currentRequestToken; }

// Legacy compat — GLM's pickToken returns just a string
export function pickToken() {
  const slot = acquireToken();
  if (!slot) throw new Error('No tokens available');
  return slot.token;
}
