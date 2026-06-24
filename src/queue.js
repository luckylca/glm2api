import { acquireToken, getPoolInfo, getTotalCapacity } from './auth.js';

const MAX_QUEUE_SIZE = 100;
const queue = [];

const OVERLOAD_LOG_COOLDOWN = 60_000; // 1 min between overload logs to avoid spam
let lastOverloadLog = 0;

export function enqueueRequest(preferVision, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let entry = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (entry) {
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
      }
      if (settled) return;
      settled = true;
      console.error(`⚠️ OVERLOAD: request timed out after ${timeoutMs}ms waiting for token (queue=${queue.length})`);
      reject(new Error('Request timed out waiting for available token'));
    }, timeoutMs);

    const resolveSlot = (slot) => {
      if (settled) {
        // Defensive cleanup if a stale queue entry is ever dispatched.
        slot?.release?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(slot);
    };

    const rejectQueued = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    // Try immediate acquire first
    const slot = acquireToken(preferVision);
    if (slot) {
      resolveSlot(slot);
      return;
    }

    // ⚠️ OVERLOAD: no token available, request must queue
    const now = Date.now();
    if (now - lastOverloadLog > OVERLOAD_LOG_COOLDOWN) {
      lastOverloadLog = now;
      const pool = getPoolInfo();
      const active = pool.reduce((s, t) => s + t.activeRequests, 0);
      const cap = getTotalCapacity();
      console.error(`⚠️ OVERLOAD: queue=${queue.length + 1}/${MAX_QUEUE_SIZE} active=${active}/${cap} — all tokens at capacity, consider adding more tokens (GLM_TOKENS) or increasing MAX_CONCURRENT_PER_TOKEN`);
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      console.error(`🚨 OVERLOAD CRITICAL: queue FULL (${MAX_QUEUE_SIZE}), request rejected — immediate expansion needed`);
      rejectQueued(new Error('Too many queued requests, try again later'));
      return;
    }

    entry = { preferVision, resolve: resolveSlot, reject: rejectQueued, createdAt: Date.now() };
    queue.push(entry);
  });
}

// Call when a token is released — try to dispatch queued request
export function dispatchQueued() {
  while (queue.length > 0) {
    const next = queue[0];
    const slot = acquireToken(next.preferVision);
    if (!slot) break; // No token available yet
    queue.shift();
    next.resolve(slot);
  }
}

export function getQueueInfo() {
  return { queued: queue.length, maxQueueSize: MAX_QUEUE_SIZE };
}
