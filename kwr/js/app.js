// app.js — UI state, rendering, persistence. Ties parser + engine to the DOM.
import { parseGkp, monthLabel, MONTH_LABELS } from './parser.js';
import { runProject, uncovered, seasonality } from './engine.js';
import { sampleDatasets, sampleClusters } from './sample.js';

const AUTOSAVE_KEY = 'kct.autosave.v1';
const PALETTE = ['#4f8cff', '#36c08e', '#ffb454', '#ff5c6c', '#b072ff', '#26c6da', '#f06292', '#9ccc65', '#ffca28', '#8d6e63'];

let state = blankState();
let results = [];           // computed cluster results for the active dataset
let charts = { bar: null, trend: null };
let detailKey = null;       // which cluster id (or '__uncovered__') is shown in the table

function blankState() {
  return { name: '', datasets: [], activeDatasetId: null, clusters: [] };
}
function uid() {
  return 'id_' + Math.random().toString(36).slice(2, 9);
}
const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n || 0).toLocaleString('en-US');

function activeDataset() {
  return state.datasets.find((d) => d.id === state.activeDatasetId) || null;
}

// ---------- Recompute + render pipeline ----------
function recompute() {
  const ds = activeDataset();
  results = ds ? runProject(state.clusters, ds) : [];
  render();
  autosave();
}

function render() {
  renderDatasets();
  renderClusters();
  renderActiveBar();
  renderDashboard();
  $('#projectName').value = state.name;
}

// ---------- Datasets ----------
function renderDatasets() {
  const host = $('#datasetList');
  host.innerHTML = '';
  if (!state.datasets.length) {
    host.innerHTML = '<p class="hint">No data yet.</p>';
    return;
  }
  for (const d of state.datasets) {
    const el = document.createElement('div');
    el.className = 'dataset-item' + (d.id === state.activeDatasetId ? ' active' : '');
    const range = d.months.length ? `${monthLabel(d.months[0])} – ${monthLabel(d.months[d.months.length - 1])}` : 'no monthly data';
    el.innerHTML = `
      <div class="row1">
        <span class="name" title="Click to view">${escapeHtml(d.label || d.fileName)}</span>
        <button class="icon-btn" data-del="${d.id}" title="Remove">✕</button>
      </div>
      <div class="meta">${fmt(d.keywords.length)} keywords · ${range}</div>
      <div class="controls">
        <input class="tag" data-label="${d.id}" value="${escapeHtml(d.label || '')}" placeholder="Label (e.g. NL market)" />
        <select data-role="${d.id}">
          ${['market', 'competitor', 'brand'].map((r) => `<option value="${r}" ${d.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>`;
    el.querySelector('.name').onclick = () => { state.activeDatasetId = d.id; recompute(); };
    el.querySelector('[data-del]').onclick = () => removeDataset(d.id);
    el.querySelector('[data-label]').onchange = (e) => { d.label = e.target.value; recompute(); };
    el.querySelector('[data-role]').onchange = (e) => { d.role = e.target.value; recompute(); };
    host.appendChild(el);
  }
}

function removeDataset(id) {
  state.datasets = state.datasets.filter((d) => d.id !== id);
  if (state.activeDatasetId === id) state.activeDatasetId = state.datasets[0]?.id || null;
  recompute();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseGkp(buf, file.name);
      state.datasets.push({
        id: uid(),
        fileName: file.name,
        label: file.name.replace(/\.[^.]+$/, ''),
        role: 'market',
        months: parsed.months,
        keywords: parsed.keywords,
      });
      state.activeDatasetId = state.datasets[state.datasets.length - 1].id;
      toast(`Loaded ${fmt(parsed.keywords.length)} keywords from ${file.name}`);
    } catch (e) {
      toast(e.message, true);
    }
  }
  recompute();
}

// ---------- Clusters ----------
function renderClusters() {
  const host = $('#clusterList');
  host.innerHTML = '';
  if (!state.clusters.length) {
    host.innerHTML = '<p class="hint">No categories yet.</p>';
    return;
  }
  const byId = Object.fromEntries(results.map((r) => [r.cluster.id, r]));
  for (const c of state.clusters) {
    const r = byId[c.id];
    const el = document.createElement('div');
    el.className = 'cluster-item' + (r && r.errors.length ? ' err' : '');
    el.innerHTML = `
      <div class="row1">
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="stat">${r ? fmt(r.totalVolume) : '–'}</span>
      </div>
      <div class="rulesummary">${ruleSummary(c)}</div>
      <div class="row1" style="margin-top:6px">
        <span class="meta" style="color:var(--muted);font-size:11px">${r ? fmt(r.count) + ' keywords' : ''}</span>
        <span class="actions">
          <button class="btn tiny" data-edit="${c.id}">Edit</button>
          <button class="btn tiny" data-view="${c.id}">View</button>
          <button class="icon-btn" data-delc="${c.id}">✕</button>
        </span>
      </div>
      ${r && r.errors.length ? `<div class="meta" style="color:var(--danger)">regex error: ${escapeHtml(r.errors[0])}</div>` : ''}`;
    el.querySelector('[data-edit]').onclick = () => openClusterDialog(c.id);
    el.querySelector('[data-view]').onclick = () => { detailKey = c.id; renderDashboard(); };
    el.querySelector('[data-delc]').onclick = () => {
      state.clusters = state.clusters.filter((x) => x.id !== c.id);
      recompute();
    };
    host.appendChild(el);
  }
}

function ruleSummary(c) {
  const inc = (c.includes || []).map(ruleText).filter(Boolean).join(' AND ');
  const exc = (c.excludes || []).map(ruleText).filter(Boolean).join(', ');
  let s = inc ? `contains: ${escapeHtml(inc)}` : '<em>no include rules</em>';
  if (exc) s += ` · excl: ${escapeHtml(exc)}`;
  return s;
}
function ruleText(rule) {
  if (rule.mode === 'regex') return `/${rule.pattern}/`;
  return (rule.terms || []).join('|');
}

// ---------- Cluster editor dialog ----------
let editingClusterId = null;
function openClusterDialog(id) {
  editingClusterId = id;
  const c = id ? state.clusters.find((x) => x.id === id) : { name: '', includes: [{ mode: 'words', terms: [] }], excludes: [] };
  $('#clusterDialogTitle').textContent = id ? 'Edit category' : 'New category';
  $('#clusterNameInput').value = c.name || '';
  renderRuleRows('include', c.includes && c.includes.length ? c.includes : [{ mode: 'words', terms: [] }]);
  renderRuleRows('exclude', c.excludes || []);
  $('#clusterDialog').showModal();
}

function renderRuleRows(kind, rules) {
  const host = kind === 'include' ? $('#includeRules') : $('#excludeRules');
  host.innerHTML = '';
  rules.forEach((rule) => host.appendChild(ruleRow(rule)));
}
function ruleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule';
  const value = rule.mode === 'regex' ? rule.pattern || '' : (rule.terms || []).join(', ');
  row.innerHTML = `
    <input class="terms" value="${escapeHtml(value)}" placeholder="word1, word2 …" />
    <select class="mode">
      <option value="words" ${rule.mode !== 'regex' ? 'selected' : ''}>words</option>
      <option value="regex" ${rule.mode === 'regex' ? 'selected' : ''}>regex</option>
    </select>
    <button type="button" class="icon-btn" title="remove">✕</button>`;
  row.querySelector('.icon-btn').onclick = () => row.remove();
  return row;
}
function collectRules(kind) {
  const host = kind === 'include' ? $('#includeRules') : $('#excludeRules');
  const out = [];
  host.querySelectorAll('.rule').forEach((row) => {
    const mode = row.querySelector('.mode').value;
    const raw = row.querySelector('.terms').value.trim();
    if (!raw) return;
    if (mode === 'regex') out.push({ mode: 'regex', pattern: raw });
    else out.push({ mode: 'words', terms: raw.split(/[,|]/).map((t) => t.trim()).filter(Boolean) });
  });
  return out;
}

function saveClusterFromDialog() {
  const name = $('#clusterNameInput').value.trim() || 'Untitled category';
  const includes = collectRules('include');
  const excludes = collectRules('exclude');
  if (editingClusterId) {
    const c = state.clusters.find((x) => x.id === editingClusterId);
    Object.assign(c, { name, includes, excludes });
  } else {
    state.clusters.push({ id: uid(), name, includes, excludes });
  }
  recompute();
}

// ---------- Dashboard ----------
function renderActiveBar() {
  const ds = activeDataset();
  $('#activeDatasetBar').innerHTML = ds
    ? `Viewing <strong>${escapeHtml(ds.label || ds.fileName)}</strong> · ${fmt(ds.keywords.length)} keywords`
    : '';
}

function renderDashboard() {
  const ds = activeDataset();
  const hasData = !!ds;
  $('#emptyState').hidden = hasData;
  $('#dashboard').hidden = !hasData;
  if (!hasData) return;

  renderSummaryCards(ds);
  renderBarChart();
  renderTrendChart();
  renderDetail(ds);
}

function renderSummaryCards(ds) {
  const totalCovered = results.reduce((s, r) => s + r.totalVolume, 0);
  const unc = uncovered(results, ds);
  const totalVolume = ds.keywords.reduce((s, k) => s + k.avgMonthly, 0);
  const cards = [
    { label: 'Keywords', value: fmt(ds.keywords.length) },
    { label: 'Total monthly searches', value: fmt(totalVolume) },
    { label: 'Categories', value: String(state.clusters.length) },
    { label: 'Covered volume', value: fmt(totalCovered), sub: totalVolume ? Math.round((totalCovered / totalVolume) * 100) + '% of total' : '' },
    { label: 'Uncovered keywords', value: fmt(unc.count), sub: fmt(unc.volume) + ' searches' },
  ];
  $('#summaryCards').innerHTML = cards.map((c) =>
    `<div class="scard"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}</div>`
  ).join('');
}

function renderBarChart() {
  const ctx = $('#barChart');
  const sorted = [...results].sort((a, b) => b.totalVolume - a.totalVolume);
  const data = {
    labels: sorted.map((r) => r.cluster.name),
    datasets: [{
      label: 'Avg. monthly searches',
      data: sorted.map((r) => r.totalVolume),
      backgroundColor: sorted.map((_, i) => PALETTE[i % PALETTE.length]),
    }],
  };
  charts.bar?.destroy();
  charts.bar = new Chart(ctx, {
    type: 'bar',
    data,
    options: { responsive: true, plugins: { legend: { display: false } }, scales: chartScales() },
  });
}

function renderTrendChart() {
  const ds = activeDataset();
  const labels = ds.months.map(monthLabel);
  const datasets = results.map((r, i) => ({
    label: r.cluster.name,
    data: r.monthlyTotals,
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: PALETTE[i % PALETTE.length],
    tension: 0.25,
    pointRadius: 0,
    borderWidth: 2,
  }));
  charts.trend?.destroy();
  charts.trend = new Chart($('#trendChart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#9aa3b2', boxWidth: 12 } } },
      scales: chartScales(true),
    },
  });
}

function chartScales(time) {
  const grid = { color: 'rgba(255,255,255,0.06)' };
  const ticks = { color: '#9aa3b2', maxRotation: time ? 60 : 0, autoSkip: true };
  return { x: { grid, ticks }, y: { grid, ticks, beginAtZero: true } };
}

function renderDetail(ds) {
  // Build the selector (categories + uncovered).
  const sel = $('#detailSelect');
  const opts = results.map((r) => `<option value="${r.cluster.id}">${escapeHtml(r.cluster.name)} (${fmt(r.count)})</option>`);
  opts.push(`<option value="__uncovered__">Uncovered keywords</option>`);
  sel.innerHTML = opts.join('');
  if (!detailKey || (detailKey !== '__uncovered__' && !results.some((r) => r.cluster.id === detailKey))) {
    detailKey = results[0]?.cluster.id || '__uncovered__';
  }
  sel.value = detailKey;

  let rows, title;
  if (detailKey === '__uncovered__') {
    const unc = uncovered(results, ds);
    rows = unc.rows; title = `Uncovered keywords — ${fmt(unc.volume)} searches`;
  } else {
    const r = results.find((x) => x.cluster.id === detailKey);
    rows = r ? r.matched : [];
    title = r ? `${r.cluster.name} — ${fmt(r.totalVolume)} searches` : 'Keywords';
  }
  $('#detailTitle').textContent = title;

  const thead = $('#detailTable thead');
  const tbody = $('#detailTable tbody');
  thead.innerHTML = `<tr>
    <th>Keyword</th><th class="num">Avg. monthly</th>
    <th class="num">3-mo change</th><th class="num">YoY change</th><th>Competition</th>
  </tr>`;
  tbody.innerHTML = rows.slice(0, 1000).map((k) => `<tr>
    <td>${escapeHtml(k.keyword)}</td>
    <td class="num">${fmt(k.avgMonthly)}</td>
    <td class="num ${changeClass(k.threeMonth)}">${escapeHtml(k.threeMonth)}</td>
    <td class="num ${changeClass(k.yoy)}">${escapeHtml(k.yoy)}</td>
    <td>${escapeHtml(k.competition)}</td>
  </tr>`).join('') || `<tr><td colspan="5" style="color:var(--muted)">No keywords.</td></tr>`;

  if (rows.length > 1000) {
    tbody.innerHTML += `<tr><td colspan="5" style="color:var(--muted)">Showing first 1000 of ${fmt(rows.length)}. Export for the full list.</td></tr>`;
  }
}
function changeClass(v) {
  if (!v) return '';
  if (v.startsWith('-')) return 'neg';
  if (/^\+?\d/.test(v) && !/^0%?$/.test(v)) return 'pos';
  return '';
}

// ---------- Export ----------
function currentDetailRows() {
  const ds = activeDataset();
  if (detailKey === '__uncovered__') return uncovered(results, ds).rows;
  const r = results.find((x) => x.cluster.id === detailKey);
  return r ? r.matched : [];
}
function exportRows(format) {
  const rows = currentDetailRows();
  const aoa = [['Keyword', 'Avg. monthly searches', 'Three month change', 'YoY change', 'Competition']];
  rows.forEach((k) => aoa.push([k.keyword, k.avgMonthly, k.threeMonth, k.yoy, k.competition]));
  const name = (detailKey === '__uncovered__' ? 'uncovered' : (results.find((r) => r.cluster.id === detailKey)?.cluster.name || 'keywords')).replace(/[^\w-]+/g, '_');
  if (format === 'xlsx') {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Keywords');
    XLSX.writeFile(wb, `${name}.xlsx`);
  } else {
    const csv = aoa.map((r) => r.map(csvCell).join(',')).join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${name}.csv`);
  }
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Project save / load / autosave ----------
function projectJson() {
  return JSON.stringify({ version: 1, name: state.name, datasets: state.datasets, activeDatasetId: state.activeDatasetId, clusters: state.clusters });
}
function saveProject() {
  const name = (state.name || 'project').replace(/[^\w-]+/g, '_');
  downloadBlob(new Blob([projectJson()], { type: 'application/json' }), `${name}.json`);
  toast('Project saved');
}
function loadProjectFromObject(obj) {
  state = {
    name: obj.name || '',
    datasets: (obj.datasets || []).map((d) => ({ role: 'market', ...d })),
    activeDatasetId: obj.activeDatasetId || (obj.datasets && obj.datasets[0] && obj.datasets[0].id) || null,
    clusters: obj.clusters || [],
  };
  detailKey = null;
  recompute();
}
async function loadProjectFile(file) {
  try {
    const text = await file.text();
    loadProjectFromObject(JSON.parse(text));
    toast('Project loaded');
  } catch (e) {
    toast('Could not read project file: ' + e.message, true);
  }
}
function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, projectJson());
    setSaveState('Saved locally');
  } catch (e) {
    // Likely quota exceeded with very large datasets — persist config only.
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ version: 1, name: state.name, datasets: [], activeDatasetId: null, clusters: state.clusters, _configOnly: true }));
      setSaveState('Rules saved (data too large for autosave — use Save project)');
    } catch (_) {
      setSaveState('Autosave off (storage full)');
    }
  }
}
function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (obj._configOnly) { state.clusters = obj.clusters || []; state.name = obj.name || ''; return false; }
    loadProjectFromObject(obj);
    return state.datasets.length > 0;
  } catch (_) { return false; }
}
function setSaveState(s) { $('#saveState').textContent = s; }

// ---------- helpers ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- Wire up events ----------
function init() {
  $('#addDataBtn').onclick = () => $('#dataFileInput').click();
  $('#dataFileInput').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  $('#addClusterBtn').onclick = () => openClusterDialog(null);
  $('#loadSampleBtn').onclick = loadSample;

  $('#projectName').oninput = (e) => { state.name = e.target.value; autosave(); };
  $('#newProjectBtn').onclick = () => { if (confirm('Start a new project? Unsaved data will be cleared.')) { state = blankState(); detailKey = null; recompute(); } };
  $('#saveProjectBtn').onclick = saveProject;
  $('#loadProjectBtn').onclick = () => $('#projectFileInput').click();
  $('#projectFileInput').onchange = (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ''; };

  $('#detailSelect').onchange = (e) => { detailKey = e.target.value; renderDetail(activeDataset()); };
  $('#exportCsvBtn').onclick = () => exportRows('csv');
  $('#exportXlsxBtn').onclick = () => exportRows('xlsx');

  // Cluster dialog
  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.onclick = () => {
      const host = btn.dataset.add === 'include' ? $('#includeRules') : $('#excludeRules');
      host.appendChild(ruleRow({ mode: 'words', terms: [] }));
    };
  });
  $('#clusterForm').onsubmit = (e) => { saveClusterFromDialog(); };
  $('#clusterCancelBtn').onclick = () => $('#clusterDialog').close();

  // Drag & drop onto the data panel.
  const dz = document.body;
  dz.addEventListener('dragover', (e) => { e.preventDefault(); });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  if (location.search.includes('demo')) {
    loadSample();
  } else {
    restoreAutosave();
    recompute();
  }
}

function loadSample() {
  state = {
    name: 'Sample — Huwelijksreis',
    datasets: sampleDatasets(),
    activeDatasetId: null,
    clusters: sampleClusters(),
  };
  state.activeDatasetId = state.datasets[0].id;
  detailKey = null;
  recompute();
  toast('Sample data loaded');
}

init();
