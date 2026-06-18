// app.js — UI state, rendering, persistence. Ties parser + engine to the DOM.
import { parseGkp, monthLabel, MONTH_LABELS } from './parser.js';
import { runProject, uncovered, seasonality } from './engine.js';
import { sampleDatasets, sampleClusters } from './sample.js';
import { suggestCategories } from './suggest.js';
import { annotateIntents, INTENT_META } from './intent.js';

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
// (Re)tag every keyword with its search intent + flag whether the dataset has
// real month-by-month data. Call when datasets/roles change.
function annotateAll() {
  if (!state.datasets.length) return;
  annotateIntents(state.datasets);
  for (const d of state.datasets) {
    d.hasMonthly = d.months.length > 0 && d.keywords.some((k) => k.monthly.some((v) => v > 0));
  }
}
function intentChip(intent) {
  const m = INTENT_META[intent] || INTENT_META.other;
  return `<span class="chip" style="--c:${m.color}">${m.label}</span>`;
}
const selectedClusters = new Set();
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Build one category that matches a keyword if it matches ANY of the sources
// (union). Clean words-rule for the common case; folds into a single regex only
// when a source uses regex / multiple AND-ed rules (flagged via `approx`).
function mergeCategories(cats, name) {
  const terms = new Set(), exTerms = new Set();
  const regexInc = [], regexExc = [];
  let approx = false;
  for (const c of cats) {
    if ((c.includes || []).length > 1) approx = true;
    for (const r of c.includes || []) {
      if (r.mode === 'regex') { regexInc.push(r.pattern); approx = true; }
      else (r.terms || []).forEach((t) => terms.add(t));
    }
    for (const r of c.excludes || []) {
      if (r.mode === 'regex') regexExc.push(r.pattern);
      else (r.terms || []).forEach((t) => exTerms.add(t));
    }
  }
  let includes;
  if (regexInc.length) {
    const parts = [];
    if (terms.size) parts.push(`(${[...terms].map(escapeRe).join('|')})`);
    parts.push(...regexInc.map((p) => `(?:${p})`));
    includes = [{ mode: 'regex', pattern: parts.join('|') }];
  } else {
    includes = [{ mode: 'words', terms: [...terms] }];
  }
  const excludes = [];
  if (exTerms.size) excludes.push({ mode: 'words', terms: [...exTerms] });
  regexExc.forEach((p) => excludes.push({ mode: 'regex', pattern: p })); // exclude-on-any = OR, safe
  return { cluster: { id: uid(), name, includes, excludes }, approx };
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
    el.querySelector('[data-role]').onchange = (e) => { d.role = e.target.value; annotateAll(); recompute(); };
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
      annotateAll();
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
  // Clean up selection ids that no longer exist.
  for (const id of [...selectedClusters]) if (!state.clusters.some((c) => c.id === id)) selectedClusters.delete(id);

  if (selectedClusters.size) {
    const bar = document.createElement('div');
    bar.className = 'merge-bar';
    bar.innerHTML = `<span>${selectedClusters.size} selected</span>
      <span><button class="btn tiny" id="mergeSelBtn" ${selectedClusters.size < 2 ? 'disabled' : ''}>Merge…</button>
      <button class="btn tiny ghost" id="clearSelBtn">Clear</button></span>`;
    host.appendChild(bar);
    bar.querySelector('#mergeSelBtn').onclick = mergeSelectedClusters;
    bar.querySelector('#clearSelBtn').onclick = () => { selectedClusters.clear(); renderClusters(); };
  }

  const byId = Object.fromEntries(results.map((r) => [r.cluster.id, r]));
  for (const c of state.clusters) {
    const r = byId[c.id];
    const el = document.createElement('div');
    el.className = 'cluster-item' + (r && r.errors.length ? ' err' : '') + (selectedClusters.has(c.id) ? ' sel' : '');
    el.innerHTML = `
      <div class="row1">
        <label class="cl-check"><input type="checkbox" data-sel="${c.id}" ${selectedClusters.has(c.id) ? 'checked' : ''} title="Select to merge" /></label>
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
    el.querySelector('[data-sel]').onchange = (e) => {
      if (e.target.checked) selectedClusters.add(c.id); else selectedClusters.delete(c.id);
      renderClusters();
    };
    el.querySelector('[data-edit]').onclick = () => openClusterDialog(c.id);
    el.querySelector('[data-view]').onclick = () => { detailKey = c.id; renderDashboard(); };
    el.querySelector('[data-delc]').onclick = () => {
      state.clusters = state.clusters.filter((x) => x.id !== c.id);
      selectedClusters.delete(c.id);
      recompute();
    };
    host.appendChild(el);
  }
}

function mergeSelectedClusters() {
  const cats = state.clusters.filter((c) => selectedClusters.has(c.id));
  if (cats.length < 2) { toast('Select at least two categories to merge.', true); return; }
  const def = cats[0].name;
  const name = window.prompt(`Merge ${cats.length} categories into one. Name:`, def);
  if (name === null) return;
  const { cluster, approx } = mergeCategories(cats, name.trim() || def);
  const firstIdx = state.clusters.findIndex((c) => c.id === cats[0].id);
  state.clusters = state.clusters.filter((c) => !selectedClusters.has(c.id));
  state.clusters.splice(Math.max(0, firstIdx), 0, cluster);
  selectedClusters.clear();
  recompute();
  toast(approx ? `Merged ${cats.length} categories (advanced rules were broadened to OR)` : `Merged ${cats.length} categories`);
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

// ---------- Suggested categories ----------
let suggestions = [];
function openSuggestDialog() {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  suggestions = suggestCategories(ds, state.clusters);
  const host = $('#suggestList');
  $('#suggestSubtitle').textContent = `Based on ${fmt(ds.keywords.length)} keywords in “${ds.label || ds.fileName}”, ranked by search volume. Tick the ones to add.`;
  if (!suggestions.length) {
    host.innerHTML = '<div class="suggest-empty">No new categories to suggest — everything is already covered, or the dataset is too small.</div>';
  } else {
    const item = (s, i) => {
      const rule = s.include.mode === 'regex'
        ? 'matches question words'
        : `contains “${escapeHtml(s.include.terms.length > 3 ? s.include.terms.slice(0, 3).join(', ') + '…' : s.include.terms.join(', '))}”`;
      return `<label class="suggest-item">
        <input type="checkbox" data-i="${i}" />
        <span class="body">
          <span class="title-row">
            <span class="nm">${escapeHtml(s.name)} ${intentChip(s.intent)}</span>
            <span class="vol">${fmt(s.volume)} · ${fmt(s.count)} kw</span>
          </span>
          <span class="ex">${rule} — e.g. ${escapeHtml(s.examples.join(', '))}</span>
        </span>
      </label>`;
    };
    const strategic = suggestions.map((s, i) => [s, i]).filter(([s]) => s.type !== 'theme');
    const themes = suggestions.map((s, i) => [s, i]).filter(([s]) => s.type === 'theme');
    let html = '';
    if (strategic.length) html += `<div class="suggest-group">Strategic groups · intent & questions</div>` + strategic.map(([s, i]) => item(s, i)).join('');
    if (themes.length) html += `<div class="suggest-group">Themes · by search volume</div>` + themes.map(([s, i]) => item(s, i)).join('');
    host.innerHTML = html;
  }
  $('#suggestSelectAll').checked = false;
  updateSuggestCount();
  $('#suggestDialog').showModal();
}
function updateSuggestCount() {
  const n = $('#suggestList').querySelectorAll('input[type=checkbox]:checked').length;
  $('#suggestSelectedCount').textContent = n ? `${n} selected` : '';
  $('#suggestAddBtn').textContent = n ? `Add ${n} categor${n === 1 ? 'y' : 'ies'}` : 'Add selected';
}
function addSelectedSuggestions() {
  const checks = $('#suggestList').querySelectorAll('input[type=checkbox]:checked');
  if (!checks.length) { $('#suggestDialog').close(); return; }
  const existingNames = new Set(state.clusters.map((c) => c.name.toLowerCase()));
  let added = 0;
  checks.forEach((cb) => {
    const s = suggestions[Number(cb.dataset.i)];
    if (!s || existingNames.has(s.name.toLowerCase())) return;
    state.clusters.push({ id: uid(), name: s.name, includes: [s.include], excludes: [] });
    existingNames.add(s.name.toLowerCase());
    added++;
  });
  $('#suggestDialog').close();
  recompute();
  toast(`Added ${added} categor${added === 1 ? 'y' : 'ies'}`);
}
function mergeSelectedSuggestions() {
  const checks = $('#suggestList').querySelectorAll('input[type=checkbox]:checked');
  if (checks.length < 2) { toast('Tick at least two proposals to merge them.', true); return; }
  const chosen = [...checks].map((cb) => suggestions[Number(cb.dataset.i)]).filter(Boolean);
  const def = chosen.slice(0, 2).map((s) => s.name).join(' + ');
  const name = window.prompt(`Merge ${chosen.length} proposals into one category. Name:`, def);
  if (name === null) return;
  // Treat each proposal as a one-rule category, then union.
  const cats = chosen.map((s) => ({ name: s.name, includes: [s.include], excludes: [] }));
  const { cluster } = mergeCategories(cats, name.trim() || def);
  const exists = new Set(state.clusters.map((c) => c.name.toLowerCase()));
  if (exists.has(cluster.name.toLowerCase())) cluster.name += ' (merged)';
  state.clusters.push(cluster);
  $('#suggestDialog').close();
  recompute();
  toast(`Merged ${chosen.length} proposals into “${cluster.name}”`);
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
  // Some GKP exports carry only avg. monthly searches (no monthly breakdown).
  const note = $('#trendNote');
  const canvas = $('#trendChart');
  if (!ds.hasMonthly) {
    charts.trend?.destroy();
    charts.trend = null;
    canvas.hidden = true;
    note.hidden = false;
    return;
  }
  canvas.hidden = false;
  note.hidden = true;
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
    <th>Keyword</th><th class="num">Avg. monthly</th><th>Intent</th>
    <th class="num">3-mo change</th><th class="num">YoY change</th><th>Competition</th>
  </tr>`;
  tbody.innerHTML = rows.slice(0, 1000).map((k) => `<tr>
    <td>${escapeHtml(k.keyword)}</td>
    <td class="num">${fmt(k.avgMonthly)}</td>
    <td>${intentChip(k.intent)}</td>
    <td class="num ${changeClass(k.threeMonth)}">${escapeHtml(k.threeMonth)}</td>
    <td class="num ${changeClass(k.yoy)}">${escapeHtml(k.yoy)}</td>
    <td>${escapeHtml(k.competition)}</td>
  </tr>`).join('') || `<tr><td colspan="6" style="color:var(--muted)">No keywords.</td></tr>`;

  if (rows.length > 1000) {
    tbody.innerHTML += `<tr><td colspan="6" style="color:var(--muted)">Showing first 1000 of ${fmt(rows.length)}. Export for the full list.</td></tr>`;
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
  const aoa = [['Keyword', 'Avg. monthly searches', 'Intent', 'Three month change', 'YoY change', 'Competition']];
  rows.forEach((k) => aoa.push([k.keyword, k.avgMonthly, (INTENT_META[k.intent] || INTENT_META.other).label, k.threeMonth, k.yoy, k.competition]));
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
  annotateAll();
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
  $('#suggestBtn').onclick = openSuggestDialog;
  $('#loadSampleBtn').onclick = loadSample;

  $('#suggestCancelBtn').onclick = () => $('#suggestDialog').close();
  $('#suggestAddBtn').onclick = addSelectedSuggestions;
  $('#suggestMergeBtn').onclick = mergeSelectedSuggestions;
  $('#suggestSelectAll').onchange = (e) => {
    $('#suggestList').querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = e.target.checked; });
    updateSuggestCount();
  };
  $('#suggestList').onchange = updateSuggestCount;

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
  annotateAll();
  recompute();
  toast('Sample data loaded');
}

init();
