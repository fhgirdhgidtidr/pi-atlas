import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { gzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL = 'https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt';
export const SOURCE_SHA256 = 'ef0a513ee398d5dbe1ed6994c222e03a16fcfe91f5de685691953d35961798e5';
const gzipAsync = promisify(gzip);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateManifest(manifest) {
  const { totalDigits, chunkSize, chunks, decimalsSha256 } = manifest;
  if (!Number.isSafeInteger(totalDigits) || totalDigits < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000_000) throw new Error('Invalid dataset sizes.');
  if (!/^[a-f0-9]{64}$/.test(decimalsSha256)) throw new Error('Missing source-file checksum.');
  if (!Array.isArray(chunks) || chunks.length !== Math.ceil(totalDigits / chunkSize)) throw new Error('Incorrect chunk count.');
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (chunk.index !== index || chunk.file !== `${String(index).padStart(3, '0')}.bin` || chunk.startPosition !== index * chunkSize + 1 || chunk.digitCount !== Math.min(chunkSize, totalDigits - index * chunkSize) || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error(`Invalid metadata for digit chunk ${index}.`);
  }
}

function verifyRaw(bytes, metadata) {
  if (bytes.length !== metadata.digitCount) throw new Error(`Incorrect length for chunk ${metadata.index}.`);
  if (/[^0-9]/.test(bytes.toString('latin1'))) throw new Error(`Non-decimal byte in chunk ${metadata.index}.`);
  if (sha256(bytes) !== metadata.sha256) throw new Error(`User-file checksum mismatch for chunk ${metadata.index}.`);
}

function compressedMetadata(metadata, compressed) {
  return { ...metadata, compressedSha256: sha256(compressed), compressedBytes: compressed.length };
}

/** A strict streamed response parser; at most concurrency+1 raw chunks are retained. */
export async function prepareFromResponse({ response, manifest, outputDirectory, concurrency = 4, onProgress = () => {} }) {
  validateManifest(manifest);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Compression concurrency must be between 1 and 4.');
  const expectedRange = `bytes 2-${manifest.totalDigits + 1}/${manifest.totalDigits + 2}`;
  if (response.status !== 206 || response.headers.get('content-range') !== expectedRange) {
    await response.body?.cancel();
    throw new Error(`Mirror must return HTTP 206 with Content-Range ${expectedRange}.`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) !== manifest.totalDigits) {
    await response.body?.cancel();
    throw new Error('Mirror Content-Length differs from the supplied dataset.');
  }
  if (!response.body) throw new Error('Mirror returned no digit stream.');
  await mkdir(outputDirectory, { recursive: true });
  const sourceHash = createHash('sha256');
  const active = new Set();
  const chunks = new Array(manifest.chunks.length);
  let firstError;
  let totalRead = 0;
  let index = 0;
  let written = 0;
  let offset = 0;
  let pending = Buffer.allocUnsafe(manifest.chunks[0].digitCount);

  async function queue(raw, chunkIndex) {
    if (firstError) throw firstError;
    const metadata = manifest.chunks[chunkIndex];
    verifyRaw(raw, metadata);
    let task;
    task = (async () => {
      const compressed = await gzipAsync(raw, { level: 6 });
      // Validate the generated file before publishing any artifact containing it.
      if (!gunzipSync(compressed, { maxOutputLength: metadata.digitCount }).equals(raw)) throw new Error(`Gzip verification failed for chunk ${chunkIndex}.`);
      await writeFile(join(outputDirectory, metadata.file), compressed);
      chunks[chunkIndex] = compressedMetadata(metadata, compressed);
      written++;
      onProgress({ written, totalChunks: chunks.length });
    })().catch(error => { firstError ??= error; }).finally(() => active.delete(task));
    active.add(task);
    if (active.size >= concurrency) await Promise.race(active);
    if (firstError) throw firstError;
  }

  try {
    for await (const input of response.body) {
      const incoming = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
      if (totalRead + incoming.length > manifest.totalDigits) throw new Error('Mirror stream exceeds the supplied dataset length.');
      sourceHash.update(incoming);
      totalRead += incoming.length;
      let cursor = 0;
      while (cursor < incoming.length) {
        const length = Math.min(pending.length - offset, incoming.length - cursor);
        incoming.copy(pending, offset, cursor, cursor + length);
        offset += length;
        cursor += length;
        if (offset === pending.length) {
          await queue(pending, index++);
          offset = 0;
          pending = index < chunks.length ? Buffer.allocUnsafe(manifest.chunks[index].digitCount) : null;
        }
      }
      if (firstError) throw firstError;
    }
    await Promise.all(active);
    if (firstError) throw firstError;
    if (totalRead !== manifest.totalDigits || index !== chunks.length || offset !== 0) throw new Error('Mirror stream ended before all supplied digits were received.');
    if (sourceHash.digest('hex') !== manifest.decimalsSha256) throw new Error('Full source-file SHA-256 differs from the supplied 1b.txt.');
    return { chunks, totalCompressedBytes: chunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0) };
  } catch (error) {
    await Promise.all(active);
    throw error;
  }
}

/** Reuse only complete local datasets whose raw chunks and full ordered hash match. */
export async function verifyExisting({ manifest, outputDirectory, onProgress = () => {} }) {
  validateManifest(manifest);
  let names;
  try { names = new Set(await readdir(outputDirectory)); } catch { return null; }
  if (!manifest.chunks.every(chunk => names.has(chunk.file))) return null;
  const sourceHash = createHash('sha256');
  const chunks = [];
  try {
    for (const metadata of manifest.chunks) {
      const filename = join(outputDirectory, metadata.file);
      if ((await stat(filename)).size > metadata.digitCount + 65_536) return null;
      const compressed = await readFile(filename);
      const raw = gunzipSync(compressed, { maxOutputLength: metadata.digitCount });
      verifyRaw(raw, metadata);
      sourceHash.update(raw);
      chunks.push(compressedMetadata(metadata, compressed));
      onProgress({ written: chunks.length, totalChunks: manifest.chunks.length });
    }
    if (sourceHash.digest('hex') !== manifest.decimalsSha256) return null;
    return { chunks, totalCompressedBytes: chunks.reduce((sum, chunk) => sum + chunk.compressedBytes, 0) };
  } catch { return null; }
}

export async function main() {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputDirectory = join(project, 'site/digits');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  if (manifest.totalDigits !== 1_000_000_000 || manifest.chunkSize !== 1_000_000 || manifest.chunks.length !== 1000 || manifest.decimalsSha256 !== SOURCE_SHA256) throw new Error('Expected the exact user-supplied billion-digit dataset.');
  const onProgress = ({ written, totalChunks }) => {
    if (written % 50 === 0 || written === totalChunks) console.log(`Verified ${written} of ${totalChunks} million-digit chunks.`);
  };
  let result = await verifyExisting({ manifest, outputDirectory, onProgress });
  let preparedFrom = 'existing-verified-chunks';
  if (!result) {
    preparedFrom = 'verified-mirror-build';
    console.log('Fetching the billion-digit mirror; all bytes must match the supplied 1b.txt checksums.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    timeout.unref?.();
    try {
      const response = await fetch(SOURCE_URL, { headers: { Range: 'bytes=2-1000000001', 'Accept-Encoding': 'identity' }, redirect: 'manual', signal: controller.signal });
      result = await prepareFromResponse({ response, manifest, outputDirectory, onProgress });
    } finally { controller.abort(); clearTimeout(timeout); }
  }
  const output = {
    ...manifest,
    chunks: result.chunks,
    totalCompressedBytes: result.totalCompressedBytes,
    buildSource: { preparedFrom, url: SOURCE_URL, byteRange: '2-1000000001', verifiedSourceSha256: SOURCE_SHA256, verification: 'All raw chunk hashes and the complete ordered source hash must match the user-supplied 1b.txt before publication.' },
  };
  await writeFile(manifestPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Ready for GitHub Pages: 1,000,000,000 verified digits, ${result.totalCompressedBytes} compressed bytes.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
