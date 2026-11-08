/** Search decimal digits in ordered chunks without joining the dataset in memory. */
export function validateSequence(sequence) {
  if (typeof sequence !== 'string' || !/^\d{1,100}$/.test(sequence)) {
    throw new Error('Enter between 1 and 100 digits (0–9).');
  }
  return sequence;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError');
}

/**
 * Positions are 1-based after the decimal point. `start` is a zero-based index.
 * `scanned` is the exclusive absolute digit offset, suitable for depth progress.
 */
export async function searchDigits({
  sequence, limit, start = 0, chunkSize = 1_000_000, getChunk,
  onProgress = () => {}, signal, context = 24,
}) {
  validateSequence(sequence);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Choose a valid search depth.');
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid starting position.');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size.');
  checkCancelled(signal);

  async function read(index) {
    checkCancelled(signal);
    const data = await getChunk(index, signal);
    checkCancelled(signal);
    if (typeof data !== 'string' || data.length < Math.min(chunkSize, limit - index * chunkSize)) {
      throw new Error('A digit file is incomplete. Please retry the search.');
    }
    return data;
  }

  async function range(from, to) {
    let value = '';
    for (let index = Math.floor(from / chunkSize); index * chunkSize < to; index++) {
      const digits = await read(index);
      value += digits.slice(Math.max(0, from - index * chunkSize), Math.min(chunkSize, to - index * chunkSize));
    }
    return value;
  }

  let tail = '';
  for (let index = Math.floor(start / chunkSize); index * chunkSize < limit; index++) {
    const offset = index * chunkSize;
    const digits = (await read(index)).slice(0, limit - offset);
    const combined = tail + digits;
    const base = offset - tail.length;
    const match = combined.indexOf(sequence, Math.max(0, start - base));
    if (match !== -1) {
      const position = base + match;
      const scanned = position + sequence.length;
      onProgress({ scanned, limit });
      const from = Math.max(0, position - context);
      const to = Math.min(limit, position + sequence.length + context);
      const surrounding = await range(from, to);
      checkCancelled(signal);
      return {
        found: true, position: position + 1, sequence, scanned,
        before: surrounding.slice(0, position - from),
        after: surrounding.slice(position - from + sequence.length),
      };
    }
    tail = sequence.length > 1 ? combined.slice(-(sequence.length - 1)) : '';
    onProgress({ scanned: Math.min(limit, offset + digits.length), limit });
    checkCancelled(signal);
  }
  return { found: false, position: null, sequence, before: '', after: '', scanned: limit };
}
