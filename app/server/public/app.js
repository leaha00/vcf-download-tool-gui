const state = {
  releases: [],
  selectedVersion: null,
  binaries: [],
  visibleBinaries: [],
  selectedIds: new Set(),
  sortKey: null,
  sortDir: 1,
  searchQuery: '',
  jobs: [],
  liveStatusByBinaryId: {},
};

const $ = (id) => document.getElementById(id);

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${isError ? 'error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 5000);
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- App version ----------
// Fetched independently from the CLI version below - this one must always
// be instant, so it can't be allowed to wait on a slow/stuck CLI spawn.
async function loadVersion() {
  try {
    const { version } = await api('/version');
    $('app-version').textContent = `v${version}`;
  } catch (err) {
    $('app-version').textContent = '';
  }
}

// Separate, can be slow (spawns the CLI) or fail outright if it's not
// mounted - neither should hold up anything else on the page.
async function loadCliVersion() {
  try {
    const { cliVersion } = await api('/cli-version');
    $('cli-version').textContent = cliVersion ? `CLI ${cliVersion}` : '';
  } catch (err) {
    $('cli-version').textContent = '';
  }
}

// ---------- Storage ----------
async function loadStorage() {
  try {
    const data = await api('/storage');
    const wrap = $('storage-bar-wrap');
    if (data.unavailable) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    $('storage-bar-fill').style.width = `${data.usedPercent}%`;
    $('storage-bar-fill').classList.toggle('progress-bar-fill-warn', data.usedPercent >= 85);
    $('storage-bar-label').textContent = `${formatSize(data.usedBytes)} / ${formatSize(data.totalBytes)} (${data.usedPercent}%)`;
    wrap.title = `Depot store: ${formatSize(data.freeBytes)} free`;
  } catch (err) {
    $('storage-bar-wrap').classList.add('hidden');
  }
}

// ---------- Upload CLI ----------
async function refreshUploadCliStatus() {
  try {
    const status = await api('/cli/status');
    $('upload-cli-status').textContent = status.installed
      ? `Installed — updated ${new Date(status.installedAt).toLocaleString()}`
      : 'No CLI installed yet — upload the tar.gz you downloaded from the Broadcom portal.';
  } catch (err) {
    $('upload-cli-status').textContent = '';
  }
}

$('upload-cli-btn').addEventListener('click', () => {
  $('upload-cli-modal').classList.remove('hidden');
  refreshUploadCliStatus();
});
$('upload-cli-close-btn').addEventListener('click', () => $('upload-cli-modal').classList.add('hidden'));

$('upload-cli-submit-btn').addEventListener('click', () => {
  const input = $('upload-cli-input');
  const file = input.files[0];
  if (!file) {
    toast('Choose a tar.gz file first.', true);
    return;
  }

  const formData = new FormData();
  formData.append('archive', file);

  const progressWrap = $('upload-cli-progress-wrap');
  const progressFill = $('upload-cli-progress-fill');
  const progressLabel = $('upload-cli-progress-label');
  progressWrap.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Uploading…';
  $('upload-cli-submit-btn').disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/cli/install');
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const percent = Math.round((e.loaded / e.total) * 100);
    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = percent < 100 ? `Uploading… ${percent}%` : 'Extracting and validating…';
  });
  xhr.onload = () => {
    $('upload-cli-submit-btn').disabled = false;
    progressWrap.classList.add('hidden');
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch (err) {
      // ignore - fall through to generic error text below
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      toast('CLI installed.');
      input.value = '';
      refreshUploadCliStatus();
      loadCliVersion();
    } else {
      toast(data.error || `Upload failed (${xhr.status})`, true);
    }
  };
  xhr.onerror = () => {
    $('upload-cli-submit-btn').disabled = false;
    progressWrap.classList.add('hidden');
    toast('Upload failed - connection error.', true);
  };
  xhr.send(formData);
});

// ---------- Colors ----------
const COLOR_STORAGE_KEY = 'vcf-gui-colors';
const COLOR_FIELDS = [
  { key: 'bg', varName: '--bg', inputId: 'color-bg-input', default: '#000000' },
  { key: 'panel', varName: '--panel', inputId: 'color-panel-input', default: '#121212' },
  { key: 'border', varName: '--border', inputId: 'color-border-input', default: '#2c343d' },
  { key: 'text', varName: '--text', inputId: 'color-text-input', default: '#e7ecf1' },
  { key: 'textDim', varName: '--text-dim', inputId: 'color-textdim-input', default: '#9aa7b4' },
  { key: 'accent', varName: '--accent', inputId: 'color-accent-input', default: '#9b51e0' },
  { key: 'danger', varName: '--danger', inputId: 'color-danger-input', default: '#c0392b' },
];

function loadStoredColors() {
  try {
    return JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function applyColors(colors) {
  const root = document.documentElement;
  COLOR_FIELDS.forEach(({ key, varName }) => {
    if (colors[key]) root.style.setProperty(varName, colors[key]);
  });
  if (colors.accent) root.style.setProperty('--accent-dim', `${colors.accent}22`);
}

function setStoredColor(key, value) {
  const colors = { ...loadStoredColors(), [key]: value };
  localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(colors));
  applyColors(colors);
}

function initColorInputs() {
  const stored = loadStoredColors();
  COLOR_FIELDS.forEach(({ key, inputId, default: def }) => {
    $(inputId).value = stored[key] || def;
  });
}

COLOR_FIELDS.forEach(({ key, inputId }) => {
  $(inputId).addEventListener('input', (e) => setStoredColor(key, e.target.value));
});

$('color-reset-btn').addEventListener('click', () => {
  localStorage.removeItem(COLOR_STORAGE_KEY);
  const root = document.documentElement;
  COLOR_FIELDS.forEach(({ varName }) => root.style.removeProperty(varName));
  root.style.removeProperty('--accent-dim');
  initColorInputs();
  toast('Colors reset to default.');
});

// ---------- Token / settings ----------
async function refreshTokenStatus() {
  const status = await api('/token');
  $('token-status').textContent = status.saved
    ? `Saved (${status.preview}) — updated ${new Date(status.savedAt).toLocaleString()}`
    : 'No activation code saved yet.';
}

async function refreshDepotIdStatus() {
  const status = await api('/depot-id');
  $('depot-id-status').textContent = status.set
    ? `Current ID: ${status.id}`
    : 'No software depot ID set yet — generate one or paste an existing one below.';
}

function openSettings() {
  $('settings-modal').classList.remove('hidden');
  refreshTokenStatus().catch((err) => toast(err.message, true));
  refreshDepotIdStatus().catch((err) => toast(err.message, true));
  initColorInputs();
}

$('settings-btn').addEventListener('click', openSettings);
$('settings-close-btn').addEventListener('click', () => $('settings-modal').classList.add('hidden'));

$('token-save-btn').addEventListener('click', async () => {
  const token = $('token-input').value;
  try {
    await api('/token', { method: 'POST', body: JSON.stringify({ token }) });
    $('token-input').value = '';
    toast('Activation code saved.');
    await refreshTokenStatus();
    loadReleases(true);
  } catch (err) {
    toast(err.message, true);
  }
});

$('token-clear-btn').addEventListener('click', async () => {
  try {
    await api('/token', { method: 'DELETE' });
    toast('Activation code cleared.');
    await refreshTokenStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

$('depot-id-save-btn').addEventListener('click', async () => {
  const id = $('depot-id-input').value.trim();
  if (!id) {
    toast('Enter a software depot ID first.', true);
    return;
  }
  try {
    await api('/depot-id', { method: 'POST', body: JSON.stringify({ id }) });
    $('depot-id-input').value = '';
    toast('Software depot ID saved.');
    await refreshDepotIdStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

$('depot-id-generate-btn').addEventListener('click', async () => {
  try {
    const result = await api('/depot-id/generate', { method: 'POST' });
    toast('New software depot ID generated — register it on the Broadcom portal.');
    await refreshDepotIdStatus();
    if (result.registerUrl) {
      $('depot-id-status').innerHTML += `<br/><a href="${result.registerUrl}" target="_blank" rel="noopener">Register this ID on the Broadcom portal</a>`;
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Releases ----------
async function loadReleases(forceRefresh = false) {
  const list = $('releases-list');
  list.innerHTML = '<div class="hint">Scanning depot for releases…</div>';
  try {
    const data = await api(`/releases${forceRefresh ? '?refresh=true' : ''}`);
    state.releases = data.releases;
    renderReleases();
    $('releases-meta').textContent = `Last scanned ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cached ? ' (cached)' : ''}`;
  } catch (err) {
    list.innerHTML = `<div class="hint">Could not load releases: ${escapeHtml(err.message)}</div>`;
  }
}

function renderReleases() {
  const list = $('releases-list');
  list.innerHTML = '';
  if (state.releases.length === 0) {
    list.innerHTML = '<div class="hint">No releases found.</div>';
    return;
  }

  for (const group of state.releases) {
    const groupEl = document.createElement('div');
    groupEl.className = 'release-group';

    const header = document.createElement('div');
    header.className = 'release-group-header';
    header.innerHTML = `<span><span class="caret">▸</span> ${escapeHtml(group.label)}</span><span class="meta">${group.versions.length}</span>`;
    header.addEventListener('click', () => groupEl.classList.toggle('open'));
    groupEl.appendChild(header);

    const versionsEl = document.createElement('div');
    versionsEl.className = 'release-versions';
    for (const v of group.versions) {
      const item = document.createElement('div');
      item.className = 'release-version-item';
      item.dataset.version = v.vcfVersion;
      item.innerHTML = `<span>${escapeHtml(v.vcfVersion)}</span><span class="date">${escapeHtml(v.releaseDate || '')}</span>`;
      item.addEventListener('click', () => selectVersion(v.vcfVersion, item));
      versionsEl.appendChild(item);
    }
    groupEl.appendChild(versionsEl);

    // Auto-expand the newest release family.
    if (group === state.releases[0]) groupEl.classList.add('open');

    list.appendChild(groupEl);
  }
}

function selectVersion(version, el) {
  document.querySelectorAll('.release-version-item.active').forEach((n) => n.classList.remove('active'));
  if (el) el.classList.add('active');
  state.selectedVersion = version;
  $('current-version').textContent = version;
  $('manual-version').value = version;
  loadBinaries();
}

$('refresh-releases-btn').addEventListener('click', () => loadReleases(true));

$('manual-load-btn').addEventListener('click', () => {
  const v = $('manual-version').value.trim();
  if (!v) {
    toast('Enter a VCF version first, e.g. 9.1.0.0100', true);
    return;
  }
  selectVersion(v, null);
});
$('manual-version').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('manual-load-btn').click();
});

// ---------- Binaries ----------
$('sku-select').addEventListener('change', () => state.selectedVersion && loadBinaries());
$('type-select').addEventListener('change', () => state.selectedVersion && loadBinaries());
$('search-input').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderBinaries();
});

async function loadBinaries() {
  const tbody = $('binaries-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="hint">Loading…</td></tr>';
  state.selectedIds.clear();
  updateSelectionUi();

  try {
    const params = new URLSearchParams({
      version: state.selectedVersion,
      sku: $('sku-select').value,
      type: $('type-select').value,
    });
    const data = await api(`/binaries?${params}`);
    state.binaries = data.binaries;
    applySort();
    renderBinaries();
    if (data.fellBackToFamily) {
      toast(`No binaries pinned to exactly ${state.selectedVersion}; showing the full ${data.queriedVersion}.x family instead.`);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="hint">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderBinaries() {
  const tbody = $('binaries-tbody');
  tbody.innerHTML = '';

  if (state.binaries.length === 0) {
    state.visibleBinaries = [];
    tbody.innerHTML = '<tr><td colspan="7" class="hint">No binaries found for this version/filter combination.</td></tr>';
    updateSelectionUi();
    return;
  }

  const query = state.searchQuery.trim().toLowerCase();
  const visible = query
    ? state.binaries.filter((b) => (b.component_full_name || '').toLowerCase().includes(query))
    : state.binaries;
  state.visibleBinaries = visible;

  if (visible.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="hint">No binaries match your search.</td></tr>';
    updateSelectionUi();
    return;
  }

  for (const b of visible) {
    const tr = document.createElement('tr');
    const live = state.liveStatusByBinaryId[b.id];
    if ((live && live.status === 'done') || (!live && b.downloaded)) tr.classList.add('row-downloaded');

    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${escapeHtml(b.id)}" ${state.selectedIds.has(b.id) ? 'checked' : ''} /></td>
      <td>${escapeHtml(b.component_full_name || '')}</td>
      <td>${escapeHtml(b.version || '')}</td>
      <td>${escapeHtml(b.type || '')}</td>
      <td>${escapeHtml(b.release_date || '')}</td>
      <td>${escapeHtml(b.size || '')}</td>
      <td>${downloadedCellHtml(b, live)}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedIds.add(cb.dataset.id);
      else state.selectedIds.delete(cb.dataset.id);
      updateSelectionUi();
    });
  });

  updateSelectionUi();
}

function downloadedCellHtml(b, live) {
  if (live) {
    if (live.status === 'pending') return '<span class="pending-badge">Pending</span>';
    if (live.status === 'downloading') {
      return `<div class="progress-cell"><div class="progress-bar"><div class="progress-bar-fill" style="width:${live.percent}%"></div></div><span class="progress-bar-label">${live.percent}%</span></div>`;
    }
    if (live.status === 'done') return '<span class="downloaded-badge">✓ Downloaded</span>';
    if (live.status === 'failed' || live.status === 'cancelled') {
      return `<span class="failed-badge">${live.status === 'failed' ? 'Failed' : 'Cancelled'}</span>`;
    }
  }
  return b.downloaded ? '<span class="downloaded-badge">✓ Downloaded</span>' : '';
}

// ---------- Sorting ----------
function parseDate(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((str || '').trim());
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
}

const SORT_ACCESSORS = {
  component_full_name: (b) => (b.component_full_name || '').toLowerCase(),
  release_date: (b) => parseDate(b.release_date),
  size: (b) => parseSize(b.size),
  downloaded: (b) => (b.downloaded ? 1 : 0),
};

function applySort() {
  if (!state.sortKey) return;
  const accessor = SORT_ACCESSORS[state.sortKey];
  const dir = state.sortDir;
  state.binaries.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    return typeof av === 'string' ? av.localeCompare(bv) * dir : (av - bv) * dir;
  });
}

function updateSortIndicators() {
  for (const key of Object.keys(SORT_ACCESSORS)) {
    const indicator = document.querySelector(`#sort-${key} .sort-indicator`);
    indicator.textContent = key === state.sortKey ? (state.sortDir === 1 ? '▲' : '▼') : '';
  }
}

function setSort(key) {
  if (state.sortKey === key) {
    state.sortDir *= -1;
  } else {
    state.sortKey = key;
    state.sortDir = 1;
  }
  applySort();
  renderBinaries();
  updateSortIndicators();
}

for (const key of Object.keys(SORT_ACCESSORS)) {
  $(`sort-${key}`).addEventListener('click', () => setSort(key));
}

$('select-all').addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.row-check').forEach((cb) => {
    cb.checked = checked;
    if (checked) state.selectedIds.add(cb.dataset.id);
    else state.selectedIds.delete(cb.dataset.id);
  });
  updateSelectionUi();
});

function parseSize(str) {
  const m = /^([\d.]+)\s*(KiB|MiB|GiB|TiB|B)$/i.exec((str || '').trim());
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[m[2]];
  return val * mult;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function updateSelectionUi() {
  const selected = state.binaries.filter((b) => state.selectedIds.has(b.id));
  const count = selected.length;
  const totalBytes = selected.reduce((sum, b) => sum + parseSize(b.size), 0);
  const downloadedCount = selected.filter((b) => b.downloaded).length;

  $('selection-summary').textContent = count > 0 ? `${count} selected — ${formatSize(totalBytes)}` : '';
  $('download-btn').disabled = count === 0;
  $('delete-btn').disabled = downloadedCount === 0;
  $('delete-btn').textContent = downloadedCount > 0 ? `Delete selected (${downloadedCount})` : 'Delete selected';

  const visibleSelected = state.visibleBinaries.filter((b) => state.selectedIds.has(b.id)).length;
  $('select-all').checked = state.visibleBinaries.length > 0 && visibleSelected === state.visibleBinaries.length;
}

// ---------- Downloads: jobs, history, live per-row status ----------
let jobPollTimer = null;

async function refreshJobs() {
  try {
    const data = await api('/downloads');
    state.jobs = data.jobs;
    updateLiveStatusMap();
    renderBinaries();
    if (!$('downloads-modal').classList.contains('hidden')) renderDownloadsList();

    const anyRunning = state.jobs.some((j) => j.status === 'running');
    if (anyRunning) loadStorage();
    if (anyRunning && !jobPollTimer) {
      jobPollTimer = setInterval(refreshJobs, 3000);
    } else if (!anyRunning && jobPollTimer) {
      clearInterval(jobPollTimer);
      jobPollTimer = null;
    }
  } catch (err) {
    // Silent - a failed poll shouldn't spam toasts every few seconds.
  }
}

function updateLiveStatusMap() {
  const map = {};
  for (const job of state.jobs) {
    if (job.status !== 'running') continue;
    for (const b of job.binaries) {
      map[b.id] = { status: b.status, percent: b.percent };
    }
  }
  state.liveStatusByBinaryId = map;
}

function jobSummaryLabel(job) {
  const names = job.binaries.map((b) => b.fullName || b.component).join(', ');
  return job.binaries.length === 1 ? names : `${job.binaries.length} binaries (${names})`;
}

function renderDownloadsList() {
  const list = $('downloads-list');
  if (state.jobs.length === 0) {
    list.innerHTML = '<div class="hint">No downloads yet.</div>';
    return;
  }

  list.innerHTML = '';
  for (const job of state.jobs) {
    const row = document.createElement('div');
    row.className = 'download-job';
    const started = new Date(job.startedAt).toLocaleString();
    const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleString() : null;
    row.innerHTML = `
      <div class="download-job-header">
        <span class="job-status-badge job-status-${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
        <span class="meta">${escapeHtml(started)}${finished ? ` — ${escapeHtml(finished)}` : ''}</span>
      </div>
      <div class="download-job-binaries">${escapeHtml(jobSummaryLabel(job))}</div>
    `;
    if (job.status === 'running') {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-ghost btn-small';
      viewBtn.textContent = 'View live log';
      viewBtn.addEventListener('click', () => {
        $('downloads-modal').classList.add('hidden');
        openDownloadLog(job.id);
      });
      row.appendChild(viewBtn);
    }
    list.appendChild(row);
  }
}

$('downloads-btn').addEventListener('click', () => {
  $('downloads-modal').classList.remove('hidden');
  renderDownloadsList();
  refreshJobs();
});
$('downloads-close-btn').addEventListener('click', () => $('downloads-modal').classList.add('hidden'));

// ---------- Download ----------
function openDownloadLog(jobId) {
  $('download-modal').classList.remove('hidden');
  $('download-log').textContent = '';
  if (jobId) streamDownload(jobId);
}

$('download-btn').addEventListener('click', async () => {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  const binaries = state.binaries.filter((b) => state.selectedIds.has(b.id));

  openDownloadLog(null);

  try {
    const { jobId } = await api('/download', { method: 'POST', body: JSON.stringify({ ids, binaries }) });
    streamDownload(jobId);
    refreshJobs();
  } catch (err) {
    appendLog(`Error: ${err.message}`);
  }
});

$('delete-btn').addEventListener('click', async () => {
  const ids = state.binaries.filter((b) => state.selectedIds.has(b.id) && b.downloaded).map((b) => b.id);
  if (ids.length === 0) return;

  const confirmed = window.confirm(
    `Delete ${ids.length} downloaded binar${ids.length === 1 ? 'y' : 'ies'} from the depot store? This removes the files on disk and can't be undone.`
  );
  if (!confirmed) return;

  try {
    await api('/delete', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`Deleted ${ids.length} binar${ids.length === 1 ? 'y' : 'ies'} from the depot store.`);
    await loadBinaries();
  } catch (err) {
    toast(err.message, true);
  }
});

function appendLog(line) {
  const log = $('download-log');
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function streamDownload(jobId) {
  const es = new EventSource(`/api/download/${jobId}/stream`);
  es.onmessage = (e) => appendLog(e.data);
  es.addEventListener('done', (e) => {
    appendLog(`--- finished (exit code ${e.data}) ---`);
    es.close();
  });
  es.onerror = () => {
    appendLog('--- connection lost ---');
    es.close();
  };
}

$('download-close-btn').addEventListener('click', () => $('download-modal').classList.add('hidden'));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Init ----------
loadVersion();
loadCliVersion();
loadReleases();
refreshTokenStatus().catch(() => {});
refreshJobs();
loadStorage();
setInterval(loadStorage, 30000);
