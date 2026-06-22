// app.js — UI state, rendering, persistence. Ties parser + engine to the DOM.
import { parseGkp, monthLabel, MONTH_LABELS } from './parser.js';
import { runProjectTree, isPillar, uncovered, seasonality } from './engine.js';
import { sampleDatasets, sampleClusters } from './sample.js';
import { suggestCategories } from './suggest.js';
import { annotateIntents, INTENT_META, INTENT_ACTION, isQuestion } from './intent.js';

const AUTOSAVE_KEY = 'kct.autosave.v1';
const PALETTE = ['#4f8cff', '#36c08e', '#ffb454', '#ff5c6c', '#b072ff', '#26c6da', '#f06292', '#9ccc65', '#ffca28', '#8d6e63'];

let state = blankState();
let results = [];           // flat scoped cluster results for the active dataset
let resultsById = {};       // cluster id -> result
let tree = null;            // { flat, byId, pillars } from runProjectTree
const collapsedPillars = new Set();
let draggingId = null;      // cluster id being dragged (re-parent)
let charts = { bar: null, trend: null };
let detailKey = null;       // cluster id, '__uncovered__', or '__ungrouped__:<pillarId>'
let detailSort = { key: 'avgMonthly', dir: -1 }; // table column sort

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
const CTR_TOP = 0.28;  // est. organic CTR at position #1
const PAID_CTR = 0.05; // est. paid-search CTR (blended)
function annotateAll() {
  if (!state.datasets.length) return;
  annotateIntents(state.datasets);
  const brand = buildBrandSplit(state.datasets);
  for (const d of state.datasets) {
    d.hasMonthly = d.months.length > 0 && d.keywords.some((k) => k.monthly.some((v) => v > 0));
    d.hasCpc = d.keywords.some((k) => k.cpc != null);
    d.hasCompetition = d.keywords.some((k) => k.competitionIndex != null);
    for (const k of d.keywords) {
      const w = (INTENT_ACTION[k.intent] || INTENT_ACTION.other).seoW;
      const comp = k.competitionIndex != null ? k.competitionIndex : 0;
      // Opportunity: demand, weighted by content-fit intent, penalised by competition.
      k.opportunity = Math.round(k.avgMonthly * w * (1 - 0.6 * comp / 100));
      // Click potential (#1 organic) and an estimated monthly paid spend.
      k.clickPotential = Math.round(k.avgMonthly * CTR_TOP);
      k.adSpendEst = k.cpc != null ? k.avgMonthly * PAID_CTR * k.cpc : 0;
      // Branded vs generic.
      const toks = new Set(k.lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      k.branded = [...toks].some((t) => brand.own.has(t)) ? 'own'
        : [...toks].some((t) => brand.comp.has(t)) ? 'competitor' : 'generic';
    }
  }
}
// Distinctive brand tokens, split by your-brand vs competitor (from dataset roles).
function buildBrandSplit(datasets) {
  const tok = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2 && !/^\d+$/.test(t));
  const marketHead = new Set();
  for (const d of datasets.filter((x) => x.role === 'market')) {
    const c = new Map();
    for (const k of d.keywords) for (const t of new Set(tok(k.lower))) c.set(t, (c.get(t) || 0) + 1);
    for (const [t, n] of c) if (n > d.keywords.length * 0.3) marketHead.add(t);
  }
  const collect = (role) => {
    const c = new Map();
    for (const d of datasets.filter((x) => x.role === role)) for (const k of d.keywords) for (const t of new Set(tok(k.lower))) c.set(t, (c.get(t) || 0) + 1);
    const out = new Set();
    for (const [t, n] of c) if (n >= 2 && !marketHead.has(t)) out.add(t);
    return out;
  };
  return { own: collect('brand'), comp: collect('competitor') };
}
// Difficulty band from GKP's 0–100 competition index.
function difficultyBand(idx) {
  if (idx == null) return null;
  if (idx >= 67) return { label: 'High', cls: 'neg' };
  if (idx >= 34) return { label: 'Med', cls: '' };
  return { label: 'Low', cls: 'pos' };
}
function fmtCpc(v) { return v == null ? '—' : '€' + v.toFixed(2); }
function intentChip(intent) {
  const m = INTENT_META[intent] || INTENT_META.other;
  return `<span class="chip" style="--c:${m.color}">${m.label}</span>`;
}
const INTENT_HELP = {
  transactional: 'Ready to act — book, buy, price, cheap',
  commercial: 'Comparing options — best, vs, review, ideas',
  informational: 'Learning — how, what, guide, questions',
  navigational: 'A specific brand or site (from your competitor/brand data)',
  other: 'No clear intent signal in the keyword',
};
function renderIntentLegend() {
  const order = ['transactional', 'commercial', 'informational', 'navigational', 'other'];
  $('#intentLegend').innerHTML = '<span class="legend-label">Intent:</span>' +
    order.map((k) => `<span class="legend-item" title="${escapeHtml(INTENT_HELP[k])}">${intentChip(k)}</span>`).join('');
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
  if (ds) {
    tree = runProjectTree(state.clusters, ds);
    results = tree.flat;
    resultsById = tree.byId;
  } else {
    tree = null; results = []; resultsById = {};
  }
  render();
  autosave();
}
const pillarsList = () => state.clusters.filter((c) => isPillar(c, state.clusters));
const childrenOf = (id) => state.clusters.filter((c) => c.parentId === id && !isPillar(c, state.clusters));

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

  // Top-level drop zone (shown only while dragging) — drop here to un-nest.
  const tlz = document.createElement('div');
  tlz.className = 'top-dropzone';
  tlz.textContent = 'Drop here to make a top-level pillar';
  tlz.addEventListener('dragover', (e) => { if (draggingId) { e.preventDefault(); tlz.classList.add('drop-target'); } });
  tlz.addEventListener('dragleave', () => tlz.classList.remove('drop-target'));
  tlz.addEventListener('drop', (e) => { e.preventDefault(); tlz.classList.remove('drop-target'); reparent(draggingId, null); });
  host.appendChild(tlz);

  for (const p of pillarsList()) {
    host.appendChild(clusterItem(p, false));
    if (collapsedPillars.has(p.id)) continue;
    const kids = childrenOf(p.id);
    if (!kids.length && !(tree && tree.pillars.find((x) => x.cluster.id === p.id))) continue;
    const sub = document.createElement('div');
    sub.className = 'subtree';
    for (const k of kids) sub.appendChild(clusterItem(k, true));
    const pt = tree && tree.pillars.find((x) => x.cluster.id === p.id);
    if (pt && pt.children.length) sub.appendChild(ungroupedRow(p, pt.ungrouped));
    sub.appendChild(addSubRow(p));
    host.appendChild(sub);
  }
}

function clusterItem(c, isSub) {
  const r = resultsById[c.id];
  const el = document.createElement('div');
  el.className = 'cluster-item' + (isSub ? ' sub' : '') + (r && r.errors.length ? ' err' : '') + (selectedClusters.has(c.id) ? ' sel' : '');
  const collapsed = collapsedPillars.has(c.id);
  el.innerHTML = `
    <div class="row1">
      ${!isSub ? `<button class="icon-btn chev" data-toggle="${c.id}">${collapsed ? '▸' : '▾'}</button>` : ''}
      <label class="cl-check"><input type="checkbox" data-sel="${c.id}" ${selectedClusters.has(c.id) ? 'checked' : ''} title="Select to merge" /></label>
      <span class="name">${escapeHtml(c.name)}</span>
      <span class="stat">${r ? fmt(r.totalVolume) : '–'}</span>
    </div>
    <div class="rulesummary">${ruleSummary(c)}</div>
    ${clusterInsight(r)}
    <div class="row1" style="margin-top:6px">
      <span class="meta" style="color:var(--muted);font-size:11px">${r ? fmt(r.count) + ' keywords' : ''}</span>
      <span class="actions">
        ${!isSub ? `<button class="btn tiny ghost" data-suggest="${c.id}" title="Suggest subtopics within this pillar">✨ sub</button>` : ''}
        ${!isSub ? `<button class="btn tiny ghost" data-brief="${c.id}" title="Generate an SEO content brief for this pillar">📄</button>` : ''}
        <button class="btn tiny" data-edit="${c.id}">Edit</button>
        <button class="btn tiny" data-view="${c.id}">View</button>
        <button class="icon-btn" data-delc="${c.id}">✕</button>
      </span>
    </div>
    ${r && r.errors.length ? `<div class="meta" style="color:var(--danger)">regex error: ${escapeHtml(r.errors[0])}</div>` : ''}`;
  if (!isSub) {
    el.querySelector('[data-toggle]').onclick = () => {
      if (collapsed) collapsedPillars.delete(c.id); else collapsedPillars.add(c.id);
      renderClusters();
    };
    el.querySelector('[data-suggest]').onclick = () => openSuggestDialog(c.id);
    el.querySelector('[data-brief]').onclick = () => openBrief(c.id);
  }
  el.querySelector('[data-sel]').onchange = (e) => {
    if (e.target.checked) selectedClusters.add(c.id); else selectedClusters.delete(c.id);
    renderClusters();
  };
  el.querySelector('[data-edit]').onclick = () => openClusterDialog(c.id);
  el.querySelector('[data-view]').onclick = () => { detailKey = c.id; renderDashboard(); };
  el.querySelector('[data-delc]').onclick = () => deleteCluster(c.id);

  // Drag to re-parent.
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    draggingId = c.id; el.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.id);
  });
  el.addEventListener('dragend', () => {
    draggingId = null; el.classList.remove('dragging');
    document.body.classList.remove('dragging-active');
    document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  });
  if (!isSub) {
    el.addEventListener('dragover', (e) => { if (draggingId && draggingId !== c.id) { e.preventDefault(); el.classList.add('drop-target'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop-target'); reparent(draggingId, c.id); });
  }
  return el;
}

function reparent(childId, newParentId) {
  if (!childId) return;
  const child = state.clusters.find((c) => c.id === childId);
  if (!child) return;
  const target = newParentId || null;
  if (target === childId || target === (child.parentId || null)) return;
  if (target) {
    const tp = state.clusters.find((c) => c.id === target);
    if (!tp || !isPillar(tp, state.clusters)) { toast('Subtopics can only be nested under a pillar.', true); return; }
    if (state.clusters.some((c) => c.parentId === childId)) { toast(`“${child.name}” has subtopics, so it can't become a subtopic itself.`, true); return; }
  }
  child.parentId = target;
  recompute();
  toast(target ? `Moved “${child.name}” under “${state.clusters.find((c) => c.id === target).name}”` : `Moved “${child.name}” to top level`);
}

function dominantIntent(r) {
  const t = {};
  for (const k of r.matched) t[k.intent] = (t[k.intent] || 0) + k.avgMonthly;
  let best = 'other', m = -1;
  for (const k in t) if (t[k] > m) { m = t[k]; best = k; }
  return best;
}
function clusterInsight(r) {
  if (!r || !r.count) return '';
  const bits = [`opp ${fmt(r.totalOpportunity)}`, `~${fmt(r.totalClicks)} clicks/mo`];
  if (r.avgCpc != null) bits.push(`CPC ${fmtCpc(r.avgCpc)}`);
  if (r.totalAdSpend > 0) bits.push(`~€${fmt(Math.round(r.totalAdSpend))}/mo ads`);
  if (r.avgCompetition != null) bits.push(`diff. ${difficultyBand(r.avgCompetition).label}`);
  const act = INTENT_ACTION[dominantIntent(r)] || INTENT_ACTION.other;
  return `<div class="cl-insight">${bits.join(' · ')} · <span class="cl-rec" title="SEO: ${escapeHtml(act.seo)}">→ ${escapeHtml(act.ads)}</span></div>`;
}
function ungroupedRow(p, ung) {
  const el = document.createElement('div');
  el.className = 'cluster-item sub ungrouped';
  el.innerHTML = `
    <div class="row1">
      <span class="name" style="font-style:italic;color:var(--muted)">Other (ungrouped)</span>
      <span class="stat" style="color:var(--muted)">${fmt(ung.totalVolume)}</span>
    </div>
    <div class="row1" style="margin-top:4px">
      <span class="meta" style="color:var(--muted);font-size:11px">${fmt(ung.count)} keywords with no subtopic</span>
      <span class="actions"><button class="btn tiny" data-viewung="${p.id}">View</button></span>
    </div>`;
  el.querySelector('[data-viewung]').onclick = () => { detailKey = '__ungrouped__:' + p.id; renderDashboard(); };
  return el;
}

function addSubRow(p) {
  const el = document.createElement('div');
  el.className = 'add-sub-row';
  el.innerHTML = `<button class="btn tiny ghost">+ Subcategory</button>`;
  el.querySelector('button').onclick = () => openClusterDialog(null, p.id);
  return el;
}

function deleteCluster(id) {
  state.clusters = state.clusters.filter((c) => c.id !== id);
  state.clusters.forEach((c) => { if (c.parentId === id) c.parentId = null; }); // orphans -> top level
  selectedClusters.delete(id);
  recompute();
}

function mergeSelectedClusters() {
  const cats = state.clusters.filter((c) => selectedClusters.has(c.id));
  if (cats.length < 2) { toast('Select at least two categories to merge.', true); return; }
  const def = cats[0].name;
  const name = window.prompt(`Merge ${cats.length} categories into one. Name:`, def);
  if (name === null) return;
  const { cluster, approx } = mergeCategories(cats, name.trim() || def);
  // Keep the shared parent if all sources share one, else make it a pillar.
  const parents = new Set(cats.map((c) => c.parentId || null));
  cluster.parentId = parents.size === 1 ? [...parents][0] : null;
  const mergedIds = new Set(cats.map((c) => c.id));
  const firstIdx = state.clusters.findIndex((c) => c.id === cats[0].id);
  state.clusters = state.clusters.filter((c) => !mergedIds.has(c.id));
  // Re-home any subtopics of a merged pillar onto the merged result.
  state.clusters.forEach((c) => { if (mergedIds.has(c.parentId)) c.parentId = cluster.id; });
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
function openClusterDialog(id, presetParentId) {
  editingClusterId = id;
  const c = id ? state.clusters.find((x) => x.id === id) : { name: '', includes: [{ mode: 'words', terms: [] }], excludes: [], parentId: presetParentId || null };
  $('#clusterDialogTitle').textContent = id ? 'Edit category' : (presetParentId ? 'New subcategory' : 'New category');
  $('#clusterNameInput').value = c.name || '';
  renderParentOptions(c);
  renderRuleRows('include', c.includes && c.includes.length ? c.includes : [{ mode: 'words', terms: [] }]);
  renderRuleRows('exclude', c.excludes || []);
  $('#clusterDialog').showModal();
}
function renderParentOptions(c) {
  const sel = $('#clusterParentInput');
  // A category with subtopics must stay top-level (2-level cap).
  const hasKids = c.id && state.clusters.some((x) => x.parentId === c.id);
  const candidates = pillarsList().filter((p) => p.id !== c.id);
  let opts = `<option value="">Top-level (pillar)</option>`;
  for (const p of candidates) opts += `<option value="${p.id}" ${c.parentId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`;
  sel.innerHTML = opts;
  sel.disabled = hasKids;
  if (hasKids) sel.value = '';
  $('#clusterParentHint').textContent = hasKids ? 'This category has subtopics, so it stays a top-level pillar.' : '';
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
  const parentId = $('#clusterParentInput').value || null;
  if (editingClusterId) {
    const c = state.clusters.find((x) => x.id === editingClusterId);
    Object.assign(c, { name, includes, excludes, parentId });
  } else {
    state.clusters.push({ id: uid(), name, includes, excludes, parentId });
  }
  recompute();
}

// ---------- Suggested categories ----------
let suggestions = [];
let suggestParentId = null; // when set, accepted proposals become subtopics of this pillar
function openSuggestDialog(pillarId) {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  suggestParentId = (typeof pillarId === 'string') ? pillarId : null;
  let subDs = ds, existing = state.clusters, subtitle;
  if (suggestParentId) {
    const pr = resultsById[suggestParentId];
    const pc = state.clusters.find((c) => c.id === suggestParentId);
    subDs = { months: ds.months, keywords: pr ? pr.matched : [] };
    existing = childrenOf(suggestParentId); // its existing subtopics, so they aren't re-proposed
    subtitle = `Subtopics within “${escapeHtml(pc ? pc.name : '')}”, from its ${fmt(subDs.keywords.length)} keywords. The pillar's own term is filtered out automatically.`;
  } else {
    subtitle = `Based on ${fmt(ds.keywords.length)} keywords in “${ds.label || ds.fileName}”, ranked by search volume. Tick the ones to add.`;
  }
  suggestions = suggestCategories(subDs, existing);
  const host = $('#suggestList');
  $('#suggestSubtitle').textContent = subtitle;
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
    state.clusters.push({ id: uid(), name: s.name, includes: [s.include], excludes: [], parentId: suggestParentId });
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
  cluster.parentId = suggestParentId;
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
  const unc = uncovered(results, ds);
  const totalVolume = ds.keywords.reduce((s, k) => s + k.avgMonthly, 0);
  const coveredVolume = totalVolume - unc.volume; // union — avoids pillar/subtopic double-counting
  const nP = pillarsList().length;
  const nSub = state.clusters.length - nP;
  const totalClicks = ds.keywords.reduce((s, k) => s + (k.clickPotential || 0), 0);
  // Branded share (if a brand/competitor dataset is tagged).
  let brandedVol = 0;
  for (const k of ds.keywords) if (k.branded && k.branded !== 'generic') brandedVol += k.avgMonthly;
  const cards = [
    { label: 'Keywords', value: fmt(ds.keywords.length) },
    { label: 'Total monthly searches', value: fmt(totalVolume) },
    { label: 'Est. clicks (#1)', value: fmt(totalClicks), sub: 'if you rank top organic' },
    { label: 'Categories', value: String(nP), sub: nSub ? `${nSub} subtopic${nSub === 1 ? '' : 's'}` : 'pillars' },
    { label: 'Covered volume', value: fmt(coveredVolume), sub: totalVolume ? Math.round((coveredVolume / totalVolume) * 100) + '% of total' : '' },
    { label: 'Uncovered keywords', value: fmt(unc.count), sub: fmt(unc.volume) + ' searches' },
  ];
  if (brandedVol > 0) cards.push({ label: 'Branded demand', value: Math.round(brandedVol / totalVolume * 100) + '%', sub: fmt(brandedVol) + ' searches' });
  $('#summaryCards').innerHTML = cards.map((c) =>
    `<div class="scard"><div class="label">${c.label}</div><div class="value">${c.value}</div>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}</div>`
  ).join('');
}

function renderBarChart() {
  const ctx = $('#barChart');
  // Top-level pillars only — subtopics live inside them (avoids double-counting).
  const sorted = pillarsList().map((c) => resultsById[c.id]).filter(Boolean).sort((a, b) => b.totalVolume - a.totalVolume);
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
  const pillarResults = pillarsList().map((c) => resultsById[c.id]).filter(Boolean);
  const datasets = pillarResults.map((r, i) => ({
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

function ungroupedPillar(key) {
  return key && key.startsWith('__ungrouped__:') ? (tree ? tree.pillars.find((p) => p.cluster.id === key.split(':')[1]) : null) : null;
}
function renderDetail(ds) {
  // Build a hierarchical selector: pillar, its subtopics, its ungrouped, … then global uncovered.
  const sel = $('#detailSelect');
  const valid = new Set(['__uncovered__']);
  let opts = '';
  for (const p of pillarsList()) {
    const pr = resultsById[p.id];
    opts += `<option value="${p.id}">${escapeHtml(p.name)} (${fmt(pr ? pr.count : 0)})</option>`;
    valid.add(p.id);
    for (const k of childrenOf(p.id)) {
      const kr = resultsById[k.id];
      opts += `<option value="${k.id}">— ${escapeHtml(k.name)} (${fmt(kr ? kr.count : 0)})</option>`;
      valid.add(k.id);
    }
    const pt = tree && tree.pillars.find((x) => x.cluster.id === p.id);
    if (pt && pt.children.length) {
      opts += `<option value="__ungrouped__:${p.id}">— Other (ungrouped) (${fmt(pt.ungrouped.count)})</option>`;
      valid.add('__ungrouped__:' + p.id);
    }
  }
  opts += `<option value="__uncovered__">Uncovered keywords</option>`;
  sel.innerHTML = opts;
  if (!detailKey || !valid.has(detailKey)) detailKey = pillarsList()[0]?.id || '__uncovered__';
  sel.value = detailKey;

  let rows, title;
  if (detailKey === '__uncovered__') {
    const unc = uncovered(results, ds);
    rows = unc.rows; title = `Uncovered keywords — ${fmt(unc.volume)} searches`;
  } else if (detailKey.startsWith('__ungrouped__:')) {
    const pt = ungroupedPillar(detailKey);
    rows = pt ? pt.ungrouped.matched : [];
    title = pt ? `${pt.cluster.name} · Other (ungrouped) — ${fmt(pt.ungrouped.totalVolume)} searches` : 'Keywords';
  } else {
    const r = resultsById[detailKey];
    rows = r ? r.matched : [];
    title = r ? `${r.cluster.name} — ${fmt(r.totalVolume)} searches` : 'Keywords';
  }
  $('#detailTitle').textContent = title;
  renderPillarBreakdown();

  rows = sortRows(rows);
  const thead = $('#detailTable thead');
  const tbody = $('#detailTable tbody');
  const arrow = (key) => detailSort.key === key ? (detailSort.dir < 0 ? ' ▾' : ' ▴') : '';
  const th = (key, label, cls) => `<th class="${cls || ''} sortable" data-sort="${key}" title="Sort">${label}${arrow(key)}</th>`;
  thead.innerHTML = `<tr>
    ${th('keyword', 'Keyword')}
    ${th('avgMonthly', 'Avg. monthly', 'num')}
    ${th('clickPotential', 'Clicks #1', 'num')}
    ${th('opportunity', 'Opportunity', 'num')}
    <th>Intent</th>
    ${th('cpc', 'CPC', 'num')}
    ${th('competitionIndex', 'Difficulty', 'num')}
    ${th('threeMonth', '3-mo', 'num')}
    ${th('yoy', 'YoY', 'num')}
  </tr>`;
  tbody.innerHTML = rows.slice(0, 1000).map((k) => {
    const d = difficultyBand(k.competitionIndex);
    return `<tr>
      <td>${escapeHtml(k.keyword)}</td>
      <td class="num">${fmt(k.avgMonthly)}</td>
      <td class="num" style="color:var(--muted)">${fmt(k.clickPotential)}</td>
      <td class="num" style="color:var(--accent-2)">${fmt(k.opportunity)}</td>
      <td>${intentChip(k.intent)}</td>
      <td class="num">${fmtCpc(k.cpc)}</td>
      <td class="num">${d ? `<span class="${d.cls}">${d.label}</span> <span style="color:var(--muted)">${k.competitionIndex}</span>` : '—'}</td>
      <td class="num ${changeClass(k.threeMonth)}">${escapeHtml(k.threeMonth)}</td>
      <td class="num ${changeClass(k.yoy)}">${escapeHtml(k.yoy)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" style="color:var(--muted)">No keywords.</td></tr>`;
  if (rows.length > 1000) {
    tbody.innerHTML += `<tr><td colspan="9" style="color:var(--muted)">Showing first 1000 of ${fmt(rows.length)}. Export for the full list.</td></tr>`;
  }
  thead.querySelectorAll('[data-sort]').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.sort;
      if (detailSort.key === key) detailSort.dir *= -1;
      else detailSort = { key, dir: key === 'keyword' ? 1 : -1 };
      renderDetail(activeDataset());
    };
  });
}
function sortRows(rows) {
  const { key, dir } = detailSort;
  const pct = (v) => { const n = parseFloat(String(v).replace('%', '')); return Number.isFinite(n) ? n : -Infinity; };
  const val = (k) => {
    if (key === 'keyword') return k.keyword.toLowerCase();
    if (key === 'threeMonth') return pct(k.threeMonth);
    if (key === 'yoy') return pct(k.yoy);
    const v = k[key];
    return v == null ? -Infinity : v;
  };
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return (x - y) * dir;
  });
}
// Which pillar is "in focus" for the breakdown bar (pillar, its subtopic, or its ungrouped).
function focusedPillarId() {
  if (!detailKey || detailKey === '__uncovered__') return null;
  if (detailKey.startsWith('__ungrouped__:')) return detailKey.split(':')[1];
  const c = state.clusters.find((x) => x.id === detailKey);
  if (!c) return null;
  return c.parentId || c.id;
}
function renderPillarBreakdown() {
  const host = $('#pillarBreakdown');
  const pid = focusedPillarId();
  const pt = pid && tree ? tree.pillars.find((x) => x.cluster.id === pid) : null;
  if (!pt || !pt.children.length) { host.hidden = true; host.innerHTML = ''; return; }
  const segs = pt.children.map((cr, i) => ({ key: cr.cluster.id, name: cr.cluster.name, vol: cr.totalVolume, color: PALETTE[i % PALETTE.length] }));
  segs.push({ key: '__ungrouped__:' + pid, name: 'Other (ungrouped)', vol: pt.ungrouped.totalVolume, color: '#5f6470' });
  const total = segs.reduce((s, x) => s + x.vol, 0) || 1;
  const bar = segs.filter((s) => s.vol > 0)
    .map((s) => `<div class="pb-seg" data-key="${s.key}" title="${escapeHtml(s.name)}: ${fmt(s.vol)}" style="width:${(s.vol / total * 100).toFixed(2)}%;background:${s.color}"></div>`).join('');
  const legend = segs.map((s) => `<span class="pb-leg" data-key="${s.key}"><span class="dot" style="background:${s.color}"></span>${escapeHtml(s.name)} ${fmt(s.vol)}</span>`).join('');
  host.hidden = false;
  host.innerHTML = `<div class="pb-title">${escapeHtml(pt.cluster.name)} · subtopic breakdown</div><div class="pb-bar">${bar}</div><div class="pb-legend">${legend}</div>`;
  host.querySelectorAll('[data-key]').forEach((elx) => { elx.onclick = () => { detailKey = elx.dataset.key; renderDashboard(); }; });
}

// Multi-sheet workbook: an Overview sheet + one sheet per pillar (keywords with
// a Subtopic column) — regenerates the original spreadsheet's tab structure.
function sheetName(name, used) {
  let base = (name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let n = base, i = 2;
  while (used.has(n)) { n = base.slice(0, 26) + ' ' + i; i++; }
  used.add(n); return n;
}
function exportWorkbook() {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const ov = [['Pillar', 'Subtopic', 'Avg. monthly volume', 'Keyword count']];
  for (const p of pillarsList()) {
    const pr = resultsById[p.id];
    ov.push([p.name, '(pillar total)', pr ? pr.totalVolume : 0, pr ? pr.count : 0]);
    for (const k of childrenOf(p.id)) { const kr = resultsById[k.id]; ov.push([p.name, k.name, kr ? kr.totalVolume : 0, kr ? kr.count : 0]); }
    const pt = tree.pillars.find((x) => x.cluster.id === p.id);
    if (pt && pt.children.length) ov.push([p.name, '(ungrouped)', pt.ungrouped.totalVolume, pt.ungrouped.count]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ov), sheetName('Overview', used));
  for (const p of pillarsList()) {
    const pr = resultsById[p.id];
    if (!pr) continue;
    const subMap = new Map();
    for (const k of childrenOf(p.id)) {
      const kr = resultsById[k.id];
      if (!kr) continue;
      for (const kw of kr.matched) { const a = subMap.get(kw.lower) || []; a.push(kr.cluster.name); subMap.set(kw.lower, a); }
    }
    const aoa = [['Keyword', 'Subtopic', 'Avg. monthly searches', 'Opportunity', 'Intent', 'CPC (avg)', 'Competition index', 'Three month change', 'YoY change']];
    for (const k of pr.matched) {
      const subs = subMap.get(k.lower);
      aoa.push([k.keyword, subs ? subs.join(' · ') : '(ungrouped)', k.avgMonthly, k.opportunity, (INTENT_META[k.intent] || INTENT_META.other).label, k.cpc != null ? +k.cpc.toFixed(2) : '', k.competitionIndex ?? '', k.threeMonth, k.yoy]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName(p.name, used));
  }
  const fname = (state.name || ds.label || 'keywords').replace(/[^\w-]+/g, '_');
  XLSX.writeFile(wb, `${fname}_clusters.xlsx`);
  toast(`Exported ${pillarsList().length + 1} sheets`);
}

// ---------- Generic report dialog ----------
let reportCopyText = '';
function openReport(title, subtitle, bodyHtml, copyText) {
  $('#reportTitle').textContent = title;
  $('#reportSubtitle').textContent = subtitle || '';
  $('#reportBody').innerHTML = bodyHtml;
  reportCopyText = copyText || '';
  $('#reportCopyBtn').style.display = copyText ? '' : 'none';
  $('#reportDialog').showModal();
}

// ---------- Ad-group assignment (one keyword → one ad-group) ----------
function termsOf(cluster) {
  const out = [];
  for (const r of cluster.includes || []) if (r.mode !== 'regex') out.push(...(r.terms || []));
  return out;
}
function leafAssignment(ds) {
  const leaves = state.clusters.filter((c) => !state.clusters.some((x) => x.parentId === c.id)); // no children
  const pillarName = (c) => { const p = c.parentId ? state.clusters.find((x) => x.id === c.parentId) : c; return (p || c).name; };
  const claimedBy = new Map();
  for (const leaf of leaves) {
    const r = resultsById[leaf.id];
    if (!r) continue;
    for (const k of r.matched) { const a = claimedBy.get(k.lower) || []; a.push({ leaf, r }); claimedBy.set(k.lower, a); }
  }
  const pillarSets = pillarsList().filter((p) => state.clusters.some((x) => x.parentId === p.id))
    .map((p) => ({ p, set: new Set((resultsById[p.id]?.matched || []).map((k) => k.lower)) }));
  const groups = new Map();
  const ensure = (campaign, adGroup, cluster) => { const key = campaign + '|||' + adGroup; if (!groups.has(key)) groups.set(key, { campaign, adGroup, cluster, keywords: [] }); return groups.get(key); };
  let overlap = 0;
  for (const k of ds.keywords) {
    const cands = claimedBy.get(k.lower);
    if (cands && cands.length) {
      if (cands.length > 1) overlap++;
      cands.sort((a, b) => b.r.totalOpportunity - a.r.totalOpportunity || a.r.count - b.r.count); // best/most-specific
      const leaf = cands[0].leaf;
      ensure(pillarName(leaf), leaf.name, leaf).keywords.push(k);
    } else {
      const pm = pillarSets.find((x) => x.set.has(k.lower));
      if (pm) ensure(pm.p.name, pm.p.name + ' – general', null).keywords.push(k);
    }
  }
  return { groups, overlap };
}
function exportGoogleAds() {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  if (!state.clusters.length) { toast('Create some categories first.', true); return; }
  const { groups, overlap } = leafAssignment(ds);
  const byCampaign = {};
  for (const g of groups.values()) (byCampaign[g.campaign] = byCampaign[g.campaign] || []).push(g);
  const rows = [['Campaign', 'Ad Group', 'Keyword', 'Criterion Type', 'Max CPC']];
  for (const g of groups.values()) {
    for (const k of g.keywords) {
      const cpc = k.bidHigh != null ? k.bidHigh.toFixed(2) : (k.cpc != null ? k.cpc.toFixed(2) : '');
      rows.push([g.campaign, g.adGroup, k.keyword, 'Phrase', cpc]);
      rows.push([g.campaign, g.adGroup, k.keyword, 'Exact', cpc]);
    }
  }
  // Cross-group negatives: each ad-group excludes its siblings' terms.
  for (const g of groups.values()) {
    if (!g.cluster) continue;
    const own = new Set(termsOf(g.cluster));
    const negs = new Set();
    for (const s of byCampaign[g.campaign]) if (s !== g && s.cluster) for (const t of termsOf(s.cluster)) if (!own.has(t)) negs.add(t);
    for (const t of negs) rows.push([g.campaign, g.adGroup, t, 'Negative Phrase', '']);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const fname = (state.name || ds.label || 'google-ads').replace(/[^\w-]+/g, '_');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `${fname}_google-ads.csv`);
  toast(`Exported ${groups.size} ad-groups${overlap ? ` · ${fmt(overlap)} overlapping keywords auto-assigned` : ''}`);
}

// ---------- Near-duplicate detection (SEO consolidation) ----------
function normalizeKw(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean).map((t) => (t.length > 4 ? t.replace(/(en|s)$/, '') : t)).sort().join(' ');
}
function openDuplicates() {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  const map = new Map();
  for (const k of ds.keywords) { const key = normalizeKw(k.keyword); const a = map.get(key) || []; a.push(k); map.set(key, a); }
  const groups = [...map.values()].filter((a) => a.length > 1)
    .map((a) => ({ kws: a.sort((x, y) => y.avgMonthly - x.avgMonthly), vol: a.reduce((s, x) => s + x.avgMonthly, 0) }))
    .sort((a, b) => b.vol - a.vol);
  if (!groups.length) { openReport('Near-duplicate keywords', 'None found — no trivial variants in this dataset.', '<div class="suggest-empty">Nothing to consolidate.</div>', ''); return; }
  const dupKw = groups.reduce((s, g) => s + g.kws.length, 0);
  const body = groups.slice(0, 200).map((g) => `<div class="dup-group">
      <div class="dup-head"><strong>${escapeHtml(g.kws[0].keyword)}</strong> <span class="meta">target page · ${fmt(g.vol)} combined</span></div>
      <div class="dup-vars">${g.kws.map((k) => `${escapeHtml(k.keyword)} <span class="meta">(${fmt(k.avgMonthly)})</span>`).join(' · ')}</div>
    </div>`).join('');
  const copy = groups.map((g) => `# ${g.kws[0].keyword} (${g.vol})\n` + g.kws.map((k) => `- ${k.keyword} (${k.avgMonthly})`).join('\n')).join('\n\n');
  openReport('Near-duplicate keywords', `${groups.length} groups · ${fmt(dupKw)} keywords that likely belong on one page each. Consolidate around the bold term.`, body, copy);
}

// ---------- Modifier explorer (discovery) ----------
const MOD_STOP = new Set(['de', 'het', 'een', 'en', 'of', 'voor', 'met', 'naar', 'in', 'op', 'van', 'te', 'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'le', 'la', 'les', 'des', 'du', 'un', 'une']);
function openModifiers() {
  const ds = activeDataset();
  if (!ds) { toast('Upload a dataset first.', true); return; }
  const tok = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const n = ds.keywords.length;
  const uni = new Map(), bi = new Map();
  const bump = (map, key, k) => { let e = map.get(key); if (!e) { e = { vol: 0, count: 0, ex: '' }; map.set(key, e); } e.vol += k.avgMonthly; e.count++; if (!e.ex || k.avgMonthly > e.exVol) { e.ex = k.keyword; e.exVol = k.avgMonthly; } };
  for (const k of ds.keywords) {
    const ts = tok(k.lower);
    const seen = new Set();
    for (const t of ts) { if (t.length < 3 || MOD_STOP.has(t) || /^\d+$/.test(t) || seen.has(t)) continue; seen.add(t); bump(uni, t, k); }
    for (let i = 0; i < ts.length - 1; i++) { const bg = ts[i] + ' ' + ts[i + 1]; if (ts[i].length < 3 || ts[i + 1].length < 3) continue; bump(bi, bg, k); }
  }
  const rank = (map) => [...map.entries()].filter(([, e]) => e.count >= 2 && e.count < n * 0.6).map(([k, e]) => ({ term: k, ...e })).sort((a, b) => b.vol - a.vol).slice(0, 25);
  const unis = rank(uni), bis = rank(bi);
  const rows = (list) => list.map((m) => `<tr><td>${escapeHtml(m.term)}</td><td class="num">${fmt(m.vol)}</td><td class="num">${fmt(m.count)}</td><td style="color:var(--muted)">${escapeHtml(m.ex)}</td></tr>`).join('');
  const body = `
    <div class="mod-cols">
      <div><div class="suggest-group">Single words</div><table class="kw-table mod-table"><thead><tr><th>Modifier</th><th class="num">Volume</th><th class="num">#</th><th>Example</th></tr></thead><tbody>${rows(unis)}</tbody></table></div>
      <div><div class="suggest-group">Phrases (2-word)</div><table class="kw-table mod-table"><thead><tr><th>Phrase</th><th class="num">Volume</th><th class="num">#</th><th>Example</th></tr></thead><tbody>${rows(bis)}</tbody></table></div>
    </div>`;
  const copy = 'WORDS\n' + unis.map((m) => `${m.term}\t${m.vol}`).join('\n') + '\n\nPHRASES\n' + bis.map((m) => `${m.term}\t${m.vol}`).join('\n');
  openReport('Modifier explorer', `Recurring words & phrases in “${escapeHtml(ds.label || ds.fileName)}”, by search volume. Use these to spot sub-topics and ad-groups.`, body, copy);
}

// ---------- Content brief generator (per pillar) ----------
function openBrief(pillarId) {
  const r = resultsById[pillarId];
  const c = state.clusters.find((x) => x.id === pillarId);
  if (!r || !c) return;
  const act = INTENT_ACTION[dominantIntent(r)] || INTENT_ACTION.other;
  const primary = r.matched[0];
  const questions = r.matched.filter((k) => isQuestion(k.lower)).slice(0, 10);
  const include = [...r.matched].sort((a, b) => (b.opportunity || 0) - (a.opportunity || 0)).slice(0, 15);
  const subs = childrenOf(pillarId).map((k) => k.name);
  const md = [
    `# Content brief: ${c.name}`,
    `**Recommended format:** ${act.seo}`,
    `**Primary keyword:** ${primary ? primary.keyword + ' (' + primary.avgMonthly + '/mo)' : '—'}`,
    `**Total demand:** ${r.totalVolume}/mo across ${r.count} keywords`,
    subs.length ? `**Subtopics to cover:** ${subs.join(', ')}` : '',
    '',
    '## Suggested H2s (from real questions)',
    questions.length ? questions.map((k) => `- ${k.keyword}`).join('\n') : '- (no question keywords found — use the subtopics above as sections)',
    '',
    '## Terms to include (highest opportunity)',
    include.map((k) => `- ${k.keyword} (${k.avgMonthly}/mo)`).join('\n'),
  ].filter((x) => x !== '').join('\n');
  const body = `<pre class="brief">${escapeHtml(md)}</pre>`;
  openReport(`Content brief — ${c.name}`, 'Copy into your doc / CMS. Generated from this pillar’s keywords.', body, md);
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
  if (detailKey && detailKey.startsWith('__ungrouped__:')) { const pt = ungroupedPillar(detailKey); return pt ? pt.ungrouped.matched : []; }
  const r = resultsById[detailKey];
  return r ? r.matched : [];
}
function exportRows(format) {
  const rows = currentDetailRows();
  const aoa = [['Keyword', 'Avg. monthly searches', 'Clicks #1 (est)', 'Opportunity', 'Intent', 'CPC (avg)', 'Competition index', 'Three month change', 'YoY change']];
  rows.forEach((k) => aoa.push([k.keyword, k.avgMonthly, k.clickPotential, k.opportunity, (INTENT_META[k.intent] || INTENT_META.other).label, k.cpc != null ? +k.cpc.toFixed(2) : '', k.competitionIndex ?? '', k.threeMonth, k.yoy]));
  let label = 'keywords';
  if (detailKey === '__uncovered__') label = 'uncovered';
  else if (detailKey && detailKey.startsWith('__ungrouped__:')) label = (ungroupedPillar(detailKey)?.cluster.name || 'pillar') + '_ungrouped';
  else label = resultsById[detailKey]?.cluster.name || 'keywords';
  const name = label.replace(/[^\w-]+/g, '_');
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
  $('#exportAllBtn').onclick = exportWorkbook;
  $('#adsBtn').onclick = exportGoogleAds;
  $('#dupBtn').onclick = openDuplicates;
  $('#modBtn').onclick = openModifiers;
  $('#reportCloseBtn').onclick = () => $('#reportDialog').close();
  $('#reportCopyBtn').onclick = () => { navigator.clipboard?.writeText(reportCopyText); toast('Copied to clipboard'); };

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

  renderIntentLegend();
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
