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
  binariesLoading: false,
  binariesError: null,
  loadSeq: 0,
};

function anyJobRunning() {
  return state.jobs.some((j) => j.status === 'running');
}

const $ = (id) => document.getElementById(id);

// ---------- Content-pane view switching (Browse / Downloads / Settings) ----------
// These three panes live in the content column as siblings, not overlays -
// only one is ever visible at a time. Leaving Settings stops its stats poll.
const VIEWS = { browse: 'browse-view', downloads: 'downloads-view', settings: 'settings-view', logs: 'logs-view' };

function switchView(view) {
  Object.entries(VIEWS).forEach(([key, id]) => $(id).classList.toggle('hidden', key !== view));
  $('downloads-nav-btn').classList.toggle('active', view === 'downloads');
  $('settings-nav-btn').classList.toggle('active', view === 'settings');
  $('logs-nav-btn').classList.toggle('active', view === 'logs');
  if (view !== 'settings') stopSettingsPolling();
}

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

// ---------- Resource Usage (this container's own CPU/mem/disk) ----------
function setStatBar(prefix, percent, detailText) {
  const percentEl = $(`stat-${prefix}-percent`);
  const fillEl = $(`stat-${prefix}-fill`);
  const detailEl = $(`stat-${prefix}-detail`);

  if (percent == null) {
    percentEl.textContent = '–';
    fillEl.style.width = '0%';
    fillEl.classList.remove('progress-bar-fill-warn');
  } else {
    percentEl.textContent = `${percent}%`;
    fillEl.style.width = `${Math.min(percent, 100)}%`;
    fillEl.classList.toggle('progress-bar-fill-warn', percent >= 85);
  }
  detailEl.textContent = detailText;
}

async function loadSystemStats() {
  let stats;
  try {
    stats = await api('/system-stats');
  } catch (err) {
    return;
  }

  const cpu = stats.cpu;
  setStatBar('cpu', cpu ? cpu.percent : null, !cpu
    ? 'unavailable'
    : cpu.limitCores
      ? `of ${cpu.limitCores} core${cpu.limitCores === 1 ? '' : 's'} limit`
      : 'of host cores (no limit set)');

  const mem = stats.memory;
  setStatBar('mem', mem ? mem.usedPercent : null, !mem
    ? 'unavailable'
    : mem.limitBytes
      ? `${formatSize(mem.usedBytes)} / ${formatSize(mem.limitBytes)}`
      : `${formatSize(mem.usedBytes)} (no limit set)`);

  // Two disk cards side by side - depot store and the data volume
  // (token/CLI/job history). Indexed by position; either can be missing.
  const disks = stats.disk || [];
  [0, 1].forEach((i) => {
    const disk = disks[i];
    $(`stat-disk${i}-label`).textContent = disk && disk.label ? disk.label : (i === 0 ? 'Depot' : 'Data');
    setStatBar(`disk${i}`, disk ? disk.usedPercent : null,
      disk ? `${formatSize(disk.usedBytes)} / ${formatSize(disk.totalBytes)}` : 'unavailable');
  });
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

// ---------- Scheduled refresh ----------
function updateScheduleDaysVisibility() {
  $('schedule-days-wrap').classList.toggle('hidden', $('schedule-mode-input').value !== 'weekly');
}

async function refreshScheduleStatus() {
  const data = await api('/schedule');
  $('schedule-enabled-input').checked = !!data.enabled;
  $('schedule-mode-input').value = data.mode || 'daily';
  $('schedule-time-input').value = data.time || '03:00';
  document.querySelectorAll('.schedule-day-input').forEach((cb) => {
    cb.checked = (data.days || []).includes(Number(cb.value));
  });
  updateScheduleDaysVisibility();

  $('schedule-server-time').textContent = data.serverTime
    ? `${new Date(data.serverTime).toLocaleString()}, ${data.serverTimeZone || 'unknown timezone'}`
    : '–';
  $('schedule-status').textContent = data.lastRunAt
    ? `Last scheduled scan: ${new Date(data.lastRunAt).toLocaleString()}`
    : 'No scheduled scan has run yet.';
}

$('schedule-mode-input').addEventListener('change', updateScheduleDaysVisibility);

$('schedule-save-btn').addEventListener('click', async () => {
  const enabled = $('schedule-enabled-input').checked;
  const mode = $('schedule-mode-input').value;
  const time = $('schedule-time-input').value;
  const days = [...document.querySelectorAll('.schedule-day-input:checked')].map((cb) => Number(cb.value));

  try {
    await api('/schedule', { method: 'POST', body: JSON.stringify({ enabled, mode, time, days }) });
    toast('Schedule saved.');
    await refreshScheduleStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

// Only refreshes the Resource Usage cards - never touches Colors/Token/
// Depot ID fields, so it's safe to keep running while the user is mid-edit
// on anything else in this view. Polling only runs while the view is
// showing, not in the background.
let systemStatsInterval = null;

function stopSettingsPolling() {
  clearInterval(systemStatsInterval);
  systemStatsInterval = null;
}

$('settings-nav-btn').addEventListener('click', () => {
  switchView('settings');
  refreshUploadCliStatus();
  refreshTokenStatus().catch((err) => toast(err.message, true));
  refreshDepotIdStatus().catch((err) => toast(err.message, true));
  refreshScheduleStatus().catch((err) => toast(err.message, true));
  initColorInputs();
  loadSystemStats();
  clearInterval(systemStatsInterval);
  systemStatsInterval = setInterval(loadSystemStats, 5000);
});

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

function renderVersionItem(v) {
  const item = document.createElement('div');
  item.className = 'release-version-item';
  item.dataset.version = v.vcfVersion;
  item.innerHTML = `<span>${escapeHtml(v.vcfVersion)}</span><span class="date">${escapeHtml(v.releaseDate || '')}</span>`;
  item.addEventListener('click', () => selectVersion(v.vcfVersion, item));
  return item;
}

// Bucket groups are usually a.b.c with several a.b.c.d builds inside
// (rendered as their own collapsible sub-group), except the legacy 5.x line
// where the depot only exposes the bare a.b version itself with nothing
// further to drill into - those render as a plain leaf right under the
// family instead of a pointless single-child expand step.
function renderBucketGroup(group) {
  if (group.versions.length === 1 && group.versions[0].vcfVersion === group.bucket) {
    return renderVersionItem(group.versions[0]);
  }

  const groupEl = document.createElement('div');
  groupEl.className = 'release-group';

  const header = document.createElement('div');
  header.className = 'release-group-header';
  header.innerHTML = `<span><span class="caret">▸</span> ${escapeHtml(group.label)}</span><span class="meta">${group.versions.length}</span>`;
  header.addEventListener('click', () => groupEl.classList.toggle('open'));
  groupEl.appendChild(header);

  const versionsEl = document.createElement('div');
  versionsEl.className = 'release-versions';
  for (const v of group.versions) versionsEl.appendChild(renderVersionItem(v));
  groupEl.appendChild(versionsEl);

  return groupEl;
}

function renderReleases() {
  const list = $('releases-list');
  list.innerHTML = '';
  if (state.releases.length === 0) {
    list.innerHTML = '<div class="hint">No releases found.</div>';
    return;
  }

  for (const family of state.releases) {
    const familyEl = document.createElement('div');
    familyEl.className = 'release-family';

    const totalVersions = family.groups.reduce((n, g) => n + g.versions.length, 0);
    const header = document.createElement('div');
    header.className = 'release-family-header';
    header.innerHTML = `<span><span class="caret">▸</span> ${escapeHtml(family.label)}</span><span class="meta">${totalVersions}</span>`;
    header.addEventListener('click', () => familyEl.classList.toggle('open'));
    familyEl.appendChild(header);

    const groupsEl = document.createElement('div');
    groupsEl.className = 'release-family-groups';
    for (const group of family.groups) groupsEl.appendChild(renderBucketGroup(group));
    familyEl.appendChild(groupsEl);

    list.appendChild(familyEl);
  }
}

function selectVersion(version, el) {
  document.querySelectorAll('.release-version-item.active').forEach((n) => n.classList.remove('active'));
  if (el) el.classList.add('active');
  state.selectedVersion = version;
  $('current-version').textContent = version;
  switchView('browse');
  loadBinaries();
}

$('refresh-releases-btn').addEventListener('click', () => loadReleases(true));
$('releases-nav-header').addEventListener('click', () => switchView('browse'));

// ---------- Binaries ----------
$('sku-select').addEventListener('change', () => state.selectedVersion && loadBinaries());
$('type-select').addEventListener('change', () => state.selectedVersion && loadBinaries());
$('search-input').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderBinaries();
});

async function loadBinaries() {
  const mySeq = ++state.loadSeq;
  state.binariesLoading = true;
  state.binariesError = null;
  state.binaries = [];
  state.selectedIds.clear();
  renderBinaries();
  updateSelectionUi();

  try {
    const params = new URLSearchParams({
      version: state.selectedVersion,
      sku: $('sku-select').value,
      type: $('type-select').value,
    });
    const data = await api(`/binaries?${params}`);
    if (mySeq !== state.loadSeq) return; // a newer load started while this was in flight
    state.binaries = data.binaries;
    applySort();
    if (data.fellBackToFamily) {
      toast(`No binaries pinned to exactly ${state.selectedVersion}; showing the full ${data.queriedVersion}.x family instead.`);
    }
  } catch (err) {
    if (mySeq !== state.loadSeq) return;
    state.binariesError = err.message;
  } finally {
    if (mySeq === state.loadSeq) {
      state.binariesLoading = false;
      renderBinaries();
    }
  }
}

function renderBinariesPlaceholder(text) {
  $('binaries-tbody').innerHTML = `<tr><td colspan="7" class="hint">${escapeHtml(text)}</td></tr>`;
  state.visibleBinaries = [];
  updateSelectionUi();
}

function renderBinaries() {
  const tbody = $('binaries-tbody');

  // The job poll calls this every few seconds while a download runs. Never
  // let it overwrite an in-flight load with a misleading "nothing here" -
  // a `binaries list` queues behind a running download on the single CLI
  // lock (see server cliRunner.js), so the request is still coming.
  if (state.binariesLoading) {
    renderBinariesPlaceholder(
      anyJobRunning()
        ? 'Waiting for the current download to finish before this release can be listed…'
        : 'Loading…'
    );
    return;
  }
  if (state.binariesError) {
    renderBinariesPlaceholder(state.binariesError);
    return;
  }
  if (!state.selectedVersion) {
    renderBinariesPlaceholder('Pick a version from the left to list its binaries.');
    return;
  }

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
    if (!$('downloads-view').classList.contains('hidden')) renderDownloadsList();

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

function jobBinaryStatusHtml(b) {
  const percent = Math.max(0, Math.min(100, b.percent || 0));
  switch (b.status) {
    case 'downloading':
      return `<div class="progress-cell"><div class="progress-bar"><div class="progress-bar-fill" style="width:${percent}%"></div></div><span class="progress-bar-label">${percent}%</span></div>`;
    case 'done':
      return '<span class="downloaded-badge">✓ Downloaded</span>';
    case 'failed':
      return '<span class="failed-badge">Failed</span>';
    case 'cancelled':
      return '<span class="failed-badge">Cancelled</span>';
    default:
      return '<span class="pending-badge">Pending</span>';
  }
}

// Per-binary breakdown, so a running job's progress is visible here without
// having to open the release table (which can't be listed at all while the
// download holds the CLI lock).
function renderJobBinaries(job) {
  return (job.binaries || [])
    .map(
      (b) => `
      <div class="job-binary-row">
        <span class="job-binary-name">${escapeHtml(b.fullName || b.component)}${b.version ? ` <span class="meta">${escapeHtml(b.version)}</span>` : ''}</span>
        <span class="job-binary-status">${jobBinaryStatusHtml(b)}</span>
      </div>`
    )
    .join('');
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
      <div class="download-job-binaries">${renderJobBinaries(job)}</div>
    `;
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-ghost btn-small';
    viewBtn.textContent = 'View log';
    viewBtn.addEventListener('click', () => openDownloadLog(job.id));
    row.appendChild(viewBtn);
    list.appendChild(row);
  }
}

$('downloads-nav-btn').addEventListener('click', () => {
  switchView('downloads');
  renderDownloadsList();
  refreshJobs();
});

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
  const toDelete = state.binaries.filter((b) => state.selectedIds.has(b.id) && b.downloaded);
  if (toDelete.length === 0) return;

  const confirmed = window.confirm(
    `Delete ${toDelete.length} downloaded binar${toDelete.length === 1 ? 'y' : 'ies'} from the depot store? This removes the files on disk and can't be undone.`
  );
  if (!confirmed) return;

  try {
    const result = await api('/delete', {
      method: 'POST',
      body: JSON.stringify({
        binaries: toDelete.map((b) => ({ component: b.component, version: b.version, type: b.type })),
      }),
    });
    // Update in place rather than re-running loadBinaries(): a fresh
    // `binaries list` would queue behind any in-progress download on the
    // CLI lock, and the server has already invalidated its depot index.
    for (const b of toDelete) b.downloaded = false;
    state.selectedIds.clear();
    applySort();
    renderBinaries();
    updateSelectionUi();

    const fileCount = (result.removed || []).length;
    toast(
      fileCount > 0
        ? `Deleted ${fileCount} file${fileCount === 1 ? '' : 's'} from the depot store.`
        : 'Nothing left on disk for the selected binaries.'
    );
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

// ---------- Logs: the CLI's own log directory (cli/log), not our per-job
// download logs above ----------
let selectedLogName = null;

async function loadCliLogs() {
  const list = $('logs-list');
  try {
    const data = await api('/cli-logs');
    if (!data.exists || data.entries.length === 0) {
      list.innerHTML = '<div class="hint">No CLI logs yet — they appear here once the CLI has run at least once.</div>';
      return;
    }

    list.innerHTML = '';
    for (const entry of data.entries) {
      const row = document.createElement('div');
      row.className = 'download-job';
      const viewable = !entry.isDir && entry.kind !== 'other';
      row.innerHTML = `
        <div class="download-job-header">
          <span class="job-status-badge job-status-${entry.kind === 'text' ? 'running' : 'complete'}">${entry.kind === 'text' ? 'current' : entry.kind === 'archive' ? 'archived' : 'other'}</span>
          <span class="meta">${escapeHtml(new Date(entry.mtimeMs).toLocaleString())} — ${formatSize(entry.size)}</span>
        </div>
        <div class="download-job-binaries">${escapeHtml(entry.name)}</div>
      `;
      if (viewable) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-ghost btn-small';
        viewBtn.textContent = 'View';
        viewBtn.addEventListener('click', () => viewCliLog(entry.name));
        row.appendChild(viewBtn);
      }
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div class="hint">Failed to load logs: ${escapeHtml(err.message)}</div>`;
  }
}

function logContentBanner(text) {
  const banner = $('log-content-banner');
  if (!text) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
}

async function viewCliLog(name, { full = false } = {}) {
  selectedLogName = name;
  $('log-content-wrap').classList.remove('hidden');
  $('log-content-name').textContent = name;
  $('log-content-meta').textContent = 'Loading…';
  $('log-content').textContent = '';
  logContentBanner(null);
  $('log-load-full-btn').classList.add('hidden');

  try {
    const data = await api(`/cli-logs/${encodeURIComponent(name)}${full ? '?full=true' : ''}`);
    if (data.unsupported) {
      $('log-content-meta').textContent = formatSize(data.size);
      logContentBanner('Preview not available for this file type.');
      return;
    }

    $('log-content-meta').textContent = data.totalBytes !== undefined ? formatSize(data.totalBytes) : '';
    $('log-content').textContent = data.content;

    if (data.multipleEntries) {
      logContentBanner('This archive contains multiple files — showing their concatenated content.');
    } else if (data.truncated) {
      logContentBanner(
        data.kind === 'text' ? 'Showing the end of the file only.' : 'Content truncated — the archive is larger than the preview limit.'
      );
    }

    if (data.kind === 'text' && data.truncated && !full) {
      $('log-load-full-btn').classList.remove('hidden');
    }
  } catch (err) {
    $('log-content-meta').textContent = '';
    logContentBanner(`Failed to load: ${err.message}`);
  }
}

$('logs-nav-btn').addEventListener('click', () => {
  switchView('logs');
  loadCliLogs();
});

$('refresh-logs-btn').addEventListener('click', () => loadCliLogs());

$('log-load-full-btn').addEventListener('click', () => {
  if (selectedLogName) viewCliLog(selectedLogName, { full: true });
});

// ---------- Init ----------
loadVersion();
loadCliVersion();
loadReleases();
refreshTokenStatus().catch(() => {});
refreshJobs();
loadStorage();
setInterval(loadStorage, 30000);
