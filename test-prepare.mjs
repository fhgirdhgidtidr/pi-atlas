import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { prepareFromResponse, verifyExisting } from './scripts/prepare-pages.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = Buffer.from('14159265358979323846264338327950');
function metadata(bytes = raw) {
  const chunkSize = 8;
  return {
    totalDigits: bytes.length, chunkSize, decimalsSha256: hash(bytes),
    chunks: Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) => {
      const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      return { index, file: `${String(index).padStart(3, '0')}.bin`, startPosition: index * chunkSize + 1, digitCount: chunk.length, sha256: hash(chunk) };
    }),
  };
}
function response(bytes = raw, { status = 206, range = `bytes 2-${raw.length + 1}/${raw.length + 2}`, cancel } = {}) {
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 3);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel,
  });
  return new Response(stream, { status, headers: { 'Content-Range': range } });
}
async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-pages-prepare-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('streamed digits cross arbitrary response boundaries, validate, gzip, and reuse', async () => {
  await withDirectory(async outputDirectory => {
    const manifest = metadata();
    const progress = [];
    const result = await prepareFromResponse({ response: response(), manifest, outputDirectory, onProgress: event => progress.push(event.written) });
    assert.equal(result.chunks.length, 4);
    assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3, 4]);
    let compressedBytes = 0;
    for (const chunk of result.chunks) {
      const compressed = await readFile(join(outputDirectory, chunk.file));
      compressedBytes += compressed.length;
      assert.equal(hash(compressed), chunk.compressedSha256);
      assert.deepEqual(gunzipSync(compressed), raw.subarray(chunk.index * 8, (chunk.index + 1) * 8));
    }
    assert.equal(result.totalCompressedBytes, compressedBytes);
    assert.deepEqual(await verifyExisting({ manifest, outputDirectory }), result);
    await writeFile(join(outputDirectory, '003.bin'), Buffer.from('broken'));
    assert.equal(await verifyExisting({ manifest, outputDirectory }), null);
  });
});

test('HTTP 200 and incorrect ranges are rejected before digit processing', async () => {
  await withDirectory(async outputDirectory => {
    let cancelled = false;
    await assert.rejects(prepareFromResponse({ response: response(raw, { status: 200, cancel: () => { cancelled = true; } }), manifest: metadata(), outputDirectory }), /HTTP 206/);
    assert(cancelled);
    await assert.rejects(prepareFromResponse({ response: response(raw, { range: 'bytes 0-31/34' }), manifest: metadata(), outputDirectory }), /Content-Range/);
  });
});

test('truncated and oversized streams cannot be published', async () => {
  await withDirectory(async outputDirectory => {
    await assert.rejects(prepareFromResponse({ response: response(raw.subarray(0, -1)), manifest: metadata(), outputDirectory }), /ended before/);
    await assert.rejects(prepareFromResponse({ response: response(Buffer.concat([raw, Buffer.from('9')])), manifest: metadata(), outputDirectory }), /exceeds/);
  });
});

test('raw chunk and complete source checksums are both enforced', async () => {
  await withDirectory(async outputDirectory => {
    const badChunk = metadata(); badChunk.chunks[0].sha256 = '0'.repeat(64);
    await assert.rejects(prepareFromResponse({ response: response(), manifest: badChunk, outputDirectory }), /checksum mismatch/);
    const badSource = metadata(); badSource.decimalsSha256 = '0'.repeat(64);
    await assert.rejects(prepareFromResponse({ response: response(), manifest: badSource, outputDirectory }), /Full source-file SHA-256/);
  });
});

test('non-digit bytes are rejected even if fixture hashes match them', async () => {
  await withDirectory(async outputDirectory => {
    const invalid = Buffer.from(raw); invalid[9] = 0xb1;
    await assert.rejects(prepareFromResponse({ response: response(invalid), manifest: metadata(invalid), outputDirectory }), /Non-decimal/);
  });
});
