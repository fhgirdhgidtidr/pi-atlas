const $ = selector => document.querySelector(selector);
const number = value => new Intl.NumberFormat('en-US').format(value);
const depthName = value => value === 1_000_000_000 ? '1 billion' : `${number(value / 1_000_000)} million`;
const form = $('#search-form');
const input = $('#digits');
const depth = $('#depth');
const output = $('#result');
const beginning = $('#beginning');
const progress = $('#search-progress');
let worker;
let jobId = 0;
let activeJob = null;
let lastMatch = null;
let busy = false;
let cachedChunks = 0;
let workerFailed = false;

function makeWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
  workerFailed = false;
  worker.onmessage = event => handleMessage(event.data);
  worker.onerror = () => {
    workerFailed = true;
    if (busy) showError('The search engine could not start. Refresh the page and try again.');
    else setError('The search engine could not start. Try your search again to restart it.');
  };
  worker.postMessage({ type: 'status' });
}

function updateCache(value) {
  cachedChunks = value;
  $('#cache-status').textContent = value ? `${number(value * 1_000_000)} DIGITS CACHED` : 'DIGITS ON DEMAND';
}

function setBusy(value) {
  busy = value;
  $('.search-panel').classList.toggle('is-searching', value);
  $('#search-button').disabled = value;
  $('#search-button span').textContent = value ? 'Searching…' : 'Find in π';
  input.disabled = value;
  depth.disabled = value;
  $('#clear-cache').disabled = value;
  document.querySelectorAll('[data-example], #surprise-button').forEach(button => button.disabled = value);
  progress.hidden = !value;
  form.setAttribute('aria-busy', String(value));
}

function setError(message = '') {
  $('#input-error').textContent = message;
  $('#input-error').hidden = !message;
  input.setAttribute('aria-invalid', String(Boolean(message)));
}

function renderCount() {
  const length = input.value.replace(/\s/g, '').length;
  $('#input-count').textContent = `${length} / 100`;
}

function startSearch(start = 0, previous = null) {
  const sequence = input.value.replace(/\s/g, '');
  if (!sequence) { setError('Enter a sequence of digits to begin.'); input.focus(); return; }
  if (!/^\d+$/.test(sequence)) { setError('Use digits 0–9 only. Leading zeros are welcome.'); input.focus(); return; }
  if (sequence.length > 100) { setError('Keep your sequence to 100 digits or fewer.'); input.focus(); return; }
  if (workerFailed) makeWorker();
  input.value = sequence;
  renderCount();
  setError();
  if (!previous) lastMatch = null;
  activeJob = { id: ++jobId, sequence, limit: Number(depth.value), start, previous };
  setBusy(true);
  output.hidden = true;
  beginning.hidden = true;
  $('#progress-fill').style.width = '0%';
  $('#progress-percent').textContent = '0%';
  $('#progress-label').textContent = 'Following the digits…';
  $('#progress-count').textContent = start ? `Continuing after position ${number(start)}` : 'Preparing the first digits…';
  worker.postMessage({ type: 'search', ...activeJob, previous: undefined });
}

function timeLabel(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`; }

function showError(message) {
  const failedJob = activeJob ? { ...activeJob } : null;
  setBusy(false);
  output.hidden = false;
  output.replaceChildren();
  const section = document.createElement('div');
  section.className = 'no-match';
  const tag = document.createElement('div'); tag.className = 'result-tag warning-tag'; tag.textContent = 'A SMALL INTERRUPTION';
  const heading = document.createElement('h2'); heading.textContent = 'Let’s try that again.';
  const description = document.createElement('p'); description.textContent = message;
  const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry search ↗';
  retry.onclick = () => {
    if (failedJob) { input.value = failedJob.sequence; depth.value = String(failedJob.limit); }
    startSearch(failedJob?.start || 0, failedJob?.previous || null);
  };
  section.append(tag, heading, description, retry); output.append(section);
}

function handleMessage(data) {
  if (data.type === 'status') { updateCache(data.cachedChunks); return; }
  if (!activeJob || data.id !== activeJob.id) return;
  if (data.cachedChunks !== undefined) updateCache(data.cachedChunks);
  if (data.type === 'progress') {
    const searched = Math.max(0, data.scanned - activeJob.start);
    const total = Math.max(1, activeJob.limit - activeJob.start);
    const percent = Math.min(100, Math.floor(searched / total * 100));
    $('#progress-fill').style.width = `${percent}%`;
    $('#progress-percent').textContent = `${percent}%`;
    $('#progress-count').textContent = `${number(data.scanned)} of ${number(activeJob.limit)} digits explored`;
    $('#progress-label').textContent = data.scanned ? 'Looking a little deeper…' : 'Following the digits…';
  } else if (data.type === 'result') {
    setBusy(false);
    renderResult(data);
  } else if (data.type === 'cancelled') {
    setBusy(false);
    if (activeJob.previous) renderResult(activeJob.previous);
    else { output.hidden = false; output.innerHTML = '<p class="cancelled-note">Search stopped. Your downloaded digits are ready for next time.</p>'; beginning.hidden = false; }
  } else if (data.type === 'error') showError(data.message);
}

function renderResult(data) {
  output.hidden = false;
  beginning.hidden = true;
  output.replaceChildren();
  const job = activeJob;
  if (!data.found) {
    const section = document.createElement('div'); section.className = 'no-match';
    const tag = document.createElement('div'); tag.className = 'result-tag warning-tag'; tag.textContent = job.start ? 'NO MORE MATCHES IN THIS WINDOW' : 'NOT IN THIS WINDOW';
    const heading = document.createElement('h2'); heading.textContent = 'There’s still more pi out there.';
    const description = document.createElement('p');
    description.textContent = `“${job.sequence}” ${job.start ? `has no further occurrence after position ${number(job.start)}` : 'was not found'} in the first ${depthName(job.limit)} decimal digits. This doesn’t mean it never appears in pi.`;
    const meta = document.createElement('p'); meta.className = 'result-meta'; meta.textContent = `Search completed in ${timeLabel(data.elapsed)}`;
    section.append(tag, heading, description, meta);
    if (job.limit < 1_000_000_000) {
      const deeper = document.createElement('button'); deeper.className = 'secondary-button'; deeper.textContent = 'Search all 1 billion digits ↗';
      deeper.onclick = () => { depth.value = '1000000000'; startSearch(); }; section.append(deeper);
    }
    if (job.previous) {
      const back = document.createElement('button'); back.className = 'secondary-button'; back.style.marginLeft = '8px'; back.textContent = 'Back to last match';
      back.onclick = () => renderResult(job.previous); section.append(back);
    }
    output.append(section); return;
  }
  lastMatch = { ...data, sequence: job.sequence, searchedLimit: job.limit };
  const top = document.createElement('div'); top.className = 'result-top';
  const tag = document.createElement('div'); tag.className = 'result-tag'; tag.textContent = job.start && data !== job.previous ? 'ANOTHER LITTLE DISCOVERY' : 'YOUR DIGITS, FOUND';
  const meta = document.createElement('span'); meta.className = 'result-meta'; meta.textContent = `${number(data.scanned)} digits explored · ${timeLabel(data.elapsed)}`;
  top.append(tag, meta);
  const main = document.createElement('div'); main.className = 'result-main';
  const address = document.createElement('div');
  const label = document.createElement('p'); label.className = 'position-label'; label.textContent = job.start && data !== job.previous ? 'Next occurrence starts at decimal position' : 'First occurrence starts at decimal position';
  // Returning to an earlier match retains its own first/next label.
  if (data.isNext !== undefined) label.textContent = data.isNext ? 'Next occurrence starts at decimal position' : 'First occurrence starts at decimal position';
  else lastMatch.isNext = Boolean(job.start);
  const position = document.createElement('h2'); position.className = 'position-number'; position.textContent = number(data.position);
  address.append(label, position);
  const actions = document.createElement('div'); actions.className = 'result-actions';
  const copy = document.createElement('button'); copy.className = 'secondary-button'; copy.textContent = 'Copy result';
  copy.onclick = async () => {
    const text = `${job.sequence} appears in pi at decimal position ${number(data.position)}. ${data.before}[${job.sequence}]${data.after}`;
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied ✓'; setTimeout(() => copy.textContent = 'Copy result', 1800); }
    catch { copy.textContent = 'Copy unavailable'; }
  };
  const next = document.createElement('button'); next.className = 'secondary-button'; next.textContent = 'Find next →';
  next.onclick = () => { input.value = lastMatch.sequence; depth.value = String(lastMatch.searchedLimit); startSearch(lastMatch.position, lastMatch); };
  actions.append(copy, next); main.append(address, actions);
  const context = document.createElement('div'); context.className = 'result-context';
  const contextTop = document.createElement('div'); contextTop.className = 'context-top';
  const a = document.createElement('span'); a.textContent = 'A LITTLE CONTEXT';
  const b = document.createElement('span'); b.textContent = `DIGITS ${number(data.position - data.before.length)} – ${number(data.position + job.sequence.length + data.after.length - 1)}`;
  contextTop.append(a, b);
  const digits = document.createElement('div'); digits.className = 'context-digits';
  const mark = document.createElement('mark'); mark.textContent = job.sequence;
  digits.append(document.createTextNode(data.before), mark, document.createTextNode(data.after));
  const note = document.createElement('p'); note.className = 'context-note'; note.textContent = 'Your exact sequence is highlighted.';
  context.append(contextTop, digits, note);
  const foot = document.createElement('p'); foot.className = 'result-note'; foot.textContent = 'Positions count from the first digit after the decimal point. The “3.” is not included.';
  output.append(top, main, context, foot);
}

form.addEventListener('submit', event => { event.preventDefault(); if (!busy) startSearch(); });
input.addEventListener('input', () => { setError(); renderCount(); });
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.example; startSearch(); }));
$('#surprise-button').addEventListener('click', () => {
  const values = new Uint32Array(1); crypto.getRandomValues(values);
  input.value = String(values[0] % 1_000_000).padStart(6, '0'); startSearch();
});
$('#cancel-button').addEventListener('click', () => worker.postMessage({ type: 'cancel', id: activeJob?.id }));
const dialog = $('#about-dialog');
$('.about-button').addEventListener('click', () => { $('#cache-message').textContent = ''; dialog.showModal(); });
$('#close-about').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
$('#clear-cache').addEventListener('click', async () => {
  if (busy) return;
  try { if ('caches' in globalThis) await caches.delete('pi-atlas-digits-v1'); makeWorker(); updateCache(0); $('#cache-message').textContent = 'Downloaded digits cleared. They’ll load again when needed.'; }
  catch { $('#cache-message').textContent = 'The browser couldn’t clear its cache. Try your browser’s site settings.'; }
});
try { makeWorker(); } catch { setError('A current browser with background worker support is needed to search.'); $('#search-button').disabled = true; }
