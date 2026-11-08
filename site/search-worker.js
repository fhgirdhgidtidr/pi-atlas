import { searchDigits, validateSequence } from './search-core.js';

const CHUNK_SIZE = 1_000_000;
const MAX_DIGITS = 1_000_000_000;
const CACHE_NAME = 'pi-atlas-digits-v1';
const MEMORY_CHUNKS = 8;
const memory = new Map();
const cached = new Set();
let active = null;
let cachePromise;

function abortError() { return new DOMException('Search cancelled.', 'AbortError'); }
function check(signal) { if (signal?.aborted) throw abortError(); }
function pause(milliseconds, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, milliseconds);
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}
function fileUrl(index) { return new URL(`./digits/${String(index).padStart(3, '0')}.bin`, import.meta.url).href; }

async function getCache() {
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        if (!self.caches) return null;
        const cache = await caches.open(CACHE_NAME);
        for (const request of await cache.keys()) cached.add(request.url);
        return cache;
      } catch { return null; }
    })();
  }
  return cachePromise;
}

async function decode(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let plain = bytes;
  // Inspect magic bytes: some servers transparently decode gzip responses.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unpack the digit files. Please use a current browser.');
    }
    plain = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  const digits = new TextDecoder().decode(plain);
  if (digits.length !== CHUNK_SIZE || /[^0-9]/.test(digits)) {
    throw new Error('A digit file could not be verified. Please retry the search.');
  }
  return digits;
}

function remember(index, digits) {
  memory.delete(index);
  memory.set(index, digits);
  while (memory.size > MEMORY_CHUNKS) memory.delete(memory.keys().next().value);
}

async function getChunk(index, signal) {
  check(signal);
  if (memory.has(index)) {
    const digits = memory.get(index);
    remember(index, digits);
    return digits;
  }
  const url = fileUrl(index);
  const cache = await getCache();
  check(signal);
  let response = null;
  if (cache) {
    try { response = await cache.match(url); } catch { /* Disk caching is optional. */ }
  }
  check(signal);
  if (response) {
    try {
      const digits = await decode(response);
      check(signal);
      remember(index, digits);
      return digits;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      try { await cache.delete(url); } catch { /* Continue with a fresh download. */ }
      cached.delete(url);
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { signal, cache: 'force-cache' });
      if (response.ok || ![429,500,502,503,504].includes(response.status) || attempt === 2) break;
      await response.body?.cancel();
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) throw abortError();
      if (attempt === 2) throw new Error('The digit download was interrupted. Check your connection and retry.');
    }
    await pause(250 * (attempt + 1), signal);
  }
  if (!response.ok) throw new Error('A digit file is unavailable. Please retry in a moment.');
  const diskCopy = cache ? response.clone() : null;
  const digits = await decode(response);
  check(signal);
  remember(index, digits);
  if (cache && diskCopy) {
    try { await cache.put(url, diskCopy); cached.add(url); } catch { /* Quota or private mode: keep searching. */ }
  }
  check(signal);
  return digits;
}

function send(job, type, detail = {}) {
  if (active === job && !job.controller.signal.aborted) {
    self.postMessage({ type, id: job.id, elapsed: performance.now() - job.began, cachedChunks: cached.size, ...detail });
  }
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'status') {
    await getCache();
    self.postMessage({ type: 'status', cachedChunks: cached.size, maxDigits: MAX_DIGITS, chunkSize: CHUNK_SIZE });
    return;
  }
  if (data?.type === 'cancel') {
    if (active && (data.id === undefined || active.id === data.id)) {
      const job = active;
      job.controller.abort();
      active = null;
      self.postMessage({ type: 'cancelled', id: job.id, cachedChunks: cached.size });
    }
    return;
  }
  if (data?.type !== 'search') return;
  active?.controller.abort();
  const job = { id: data.id, controller: new AbortController(), began: performance.now() };
  active = job;
  try {
    validateSequence(data.sequence);
    if (!Number.isSafeInteger(data.limit) || data.limit < 1 || data.limit > MAX_DIGITS) {
      throw new Error('Choose a search depth of up to 1 billion digits.');
    }
    const result = await searchDigits({
      sequence: data.sequence, limit: data.limit, start: data.start ?? 0,
      chunkSize: CHUNK_SIZE, getChunk, signal: job.controller.signal,
      onProgress: progress => send(job, 'progress', progress),
    });
    send(job, 'result', { ...result, limit: data.limit });
  } catch (error) {
    if (error.name !== 'AbortError') send(job, 'error', { message: error.message || 'The search could not finish. Please retry.' });
  } finally {
    if (active === job) active = null;
  }
};
