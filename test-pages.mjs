import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = dirname(fileURLToPath(import.meta.url));
const site = join(root, 'site');
const base = 'https://example.github.io/pi-atlas/';
const manifest = JSON.parse(await readFile(join(site, 'digits/manifest.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.totalDigits, 1_000_000_000);
assert.equal(manifest.chunkCount, 1000);

const html = await readFile(join(site, 'index.html'), 'utf8');
const localReferences = [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
  .map(match => match[1]).filter(reference => !/^(?:https?:|data:|#)/.test(reference));
for (const reference of localReferences) {
  assert(!reference.startsWith('/'), `Project-site asset must be relative: ${reference}`);
  const url = new URL(reference, base);
  assert(url.pathname.startsWith('/pi-atlas/'), `Asset escaped the project prefix: ${url}`);
  const relative = url.pathname.slice('/pi-atlas/'.length);
  await stat(relative ? join(site, relative) : join(site, 'index.html'));
}
assert.equal((await readdir(join(site, 'digits'))).filter(name => /^\d{3}\.bin$/.test(name)).length, 1000);
await stat(join(site, '.nojekyll'));

const fixtures = {};
for (const index of [0, 999]) {
  const metadata = manifest.chunks[index];
  const compressed = await readFile(join(site, 'digits', metadata.file));
  assert.equal(sha256(compressed), metadata.compressedSha256);
  const digits = gunzipSync(compressed);
  assert.equal(digits.length, 1_000_000);
  assert.equal(sha256(digits), metadata.sha256);
  fixtures[index] = digits.toString('ascii');
}

let workerSource = await readFile(join(site, 'search-worker.js'), 'utf8');
workerSource = workerSource.replace("'./search-core.js'", JSON.stringify(pathToFileURL(join(site, 'search-core.js')).href));
workerSource = workerSource.replaceAll('import.meta.url', JSON.stringify(new URL('search-worker.js', base).href));
const bridge = `
import {parentPort} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
globalThis.self = globalThis;
globalThis.postMessage = message => parentPort.postMessage(message);
globalThis.fetch = async (input, options = {}) => {
  if(options.signal?.aborted) throw new DOMException('Aborted','AbortError');
  const url = new URL(input);
  if(!/^\\/pi-atlas\\/digits\\/\\d{3}\\.bin$/.test(url.pathname)) throw new Error('Digit URL escaped project prefix: '+url);
  parentPort.postMessage({type:'requested',url:url.href});
  const filename = url.pathname.split('/').at(-1);
  const bytes = await readFile(${JSON.stringify(join(site,'digits'))}+'/'+filename);
  return new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}});
};
${workerSource}
parentPort.on('message', data => globalThis.onmessage({data}));
`;
const worker = new Worker(new URL('data:text/javascript;base64,'+Buffer.from(bridge).toString('base64')));
const requests = [];
worker.on('message', data => { if(data.type === 'requested') requests.push(data.url); });
function request(data, expectedType) {
  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Worker timed out.')); }, 10_000);
    const cleanup = () => { clearTimeout(timeout); worker.off('message', listener); worker.off('error', failure); };
    const failure = error => { cleanup(); reject(error); };
    const listener = message => {
      if(message.type === 'error' && message.id === data.id) { cleanup(); reject(new Error(message.message)); }
      else if(message.type === expectedType && (data.id === undefined || data.id === message.id)) { cleanup(); resolveResult(message); }
    };
    worker.on('message', listener); worker.on('error', failure); worker.postMessage(data);
  });
}
try {
  const status = await request({type:'status'}, 'status');
  assert.equal(status.maxDigits, 1_000_000_000);
  const first = await request({type:'search',id:1,sequence:'1415926535',limit:1_000_000_000,start:0}, 'result');
  assert.equal(first.position,1);
  assert.equal(first.before,'');
  assert.equal(first.sequence,'1415926535');
  const tail = fixtures[999].slice(-30);
  const last = await request({type:'search',id:2,sequence:tail,limit:1_000_000_000,start:999_000_000}, 'result');
  assert.equal(last.position,999_999_971);
  assert.equal(last.after,'');
  assert.equal(last.scanned,1_000_000_000);
  assert(requests.some(url => url.endsWith('/pi-atlas/digits/000.bin')));
  assert(requests.some(url => url.endsWith('/pi-atlas/digits/999.bin')));
} finally { await worker.terminate(); }

let total = 0;
for(const entry of await readdir(join(site,'digits'))) total += (await stat(join(site,'digits',entry))).size;
assert(total < 1_000_000_000);
console.log(`Pages integration passed: relative project assets, 1000 chunks, first/final hashes and gzip, real worker positions 1 and 999,999,971. Static digit files: ${total} bytes.`);
