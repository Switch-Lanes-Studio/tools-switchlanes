// engine.js — the clustering core. Deterministic, pure functions.
//
// Replicates the spreadsheet's Contains / Contains-not logic exactly:
//   A keyword joins a cluster if it matches EVERY "include" rule
//   (AND across rules) and matches NONE of the "exclude" rules.
//   Each rule is an OR-list of terms — the sheet's "(reis|honey)" alternation.
//
// A rule can be a friendly term list (terms: ["reis", "honey"]) OR a raw regex
// (mode: "regex", pattern: "..."). Friendly term lists are the default; regex is
// the advanced escape hatch so no power from the original sheet is lost.

function compileRule(rule) {
  if (!rule) return null;
  if (rule.mode === 'regex') {
    if (!rule.pattern || !rule.pattern.trim()) return null;
    try {
      return new RegExp(rule.pattern, 'i');
    } catch (e) {
      return { error: e.message };
    }
  }
  const terms = (rule.terms || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // escape -> literal contains
  if (!terms.length) return null;
  return new RegExp(`(${terms.join('|')})`, 'i');
}

// Compile a cluster's include/exclude rule sets once, up front.
export function compileCluster(cluster) {
  const includes = (cluster.includes || []).map(compileRule).filter(Boolean);
  const excludes = (cluster.excludes || []).map(compileRule).filter(Boolean);
  const errors = [...includes, ...excludes].filter((r) => r && r.error).map((r) => r.error);
  return {
    includes: includes.filter((r) => r instanceof RegExp),
    excludes: excludes.filter((r) => r instanceof RegExp),
    errors,
  };
}

function matchesCompiled(lower, compiled) {
  for (const inc of compiled.includes) {
    if (!inc.test(lower)) return false; // AND across include rules
  }
  for (const exc of compiled.excludes) {
    if (exc.test(lower)) return false; // exclude on any match
  }
  // A cluster with no include rules matches nothing (avoids "everything" surprises).
  return compiled.includes.length > 0;
}

// Scoped sub-categories: a subtopic inherits its pillar's rules (AND), so a
// keyword joins a subtopic only if it also matches the parent. The child only
// has to specify its own differentiator.
export function effectiveRules(cluster, byId) {
  const includes = [...(cluster.includes || [])];
  const excludes = [...(cluster.excludes || [])];
  const parent = cluster.parentId && byId ? byId[cluster.parentId] : null;
  if (parent) {
    includes.unshift(...(parent.includes || []));
    excludes.unshift(...(parent.excludes || []));
  }
  return { includes, excludes };
}

export function isPillar(cluster, clusters) {
  return !cluster.parentId || !clusters.some((c) => c.id === cluster.parentId);
}

// Run one cluster against a dataset. Returns matched keywords + aggregates.
// `byId` (id -> cluster) enables parent-rule inheritance for subtopics.
export function runCluster(cluster, dataset, byId) {
  const compiled = compileCluster(effectiveRules(cluster, byId));
  const months = dataset.months;
  const matched = [];
  const monthlyTotals = new Array(months.length).fill(0);
  let totalVolume = 0;

  for (const kw of dataset.keywords) {
    if (!matchesCompiled(kw.lower, compiled)) continue;
    matched.push(kw);
    totalVolume += kw.avgMonthly;
    for (let i = 0; i < months.length; i++) monthlyTotals[i] += kw.monthly[i] || 0;
  }

  matched.sort((a, b) => b.avgMonthly - a.avgMonthly);
  return {
    cluster,
    errors: compiled.errors,
    matched,
    count: matched.length,
    totalVolume,
    monthlyTotals,
  };
}

// Run a whole project (many clusters) against a dataset, with parent inheritance.
export function runProject(clusters, dataset) {
  const byId = Object.fromEntries(clusters.map((c) => [c.id, c]));
  return clusters.map((c) => runCluster(c, dataset, byId));
}

// Run a project as a 2-level tree. Returns the flat scoped results, a lookup by
// cluster id, and per-pillar rollups including an "ungrouped" bucket (pillar
// keywords that landed in none of its subtopics — a coverage-gap finder).
export function runProjectTree(clusters, dataset) {
  const byIdCluster = Object.fromEntries(clusters.map((c) => [c.id, c]));
  const flat = clusters.map((c) => runCluster(c, dataset, byIdCluster));
  const byId = {};
  flat.forEach((r) => { byId[r.cluster.id] = r; });
  const months = dataset.months.length;
  const pillars = [];
  for (const c of clusters) {
    if (!isPillar(c, clusters)) continue;
    const pres = byId[c.id];
    const children = clusters.filter((x) => x.parentId === c.id && byIdCluster[x.parentId]).map((x) => byId[x.id]);
    const claimed = new Set();
    for (const ch of children) for (const k of ch.matched) claimed.add(k.lower);
    const rows = pres.matched.filter((k) => !claimed.has(k.lower));
    const monthlyTotals = new Array(months).fill(0);
    let totalVolume = 0;
    for (const k of rows) { totalVolume += k.avgMonthly; for (let i = 0; i < months; i++) monthlyTotals[i] += k.monthly[i] || 0; }
    pillars.push({ cluster: c, result: pres, children, ungrouped: { matched: rows, count: rows.length, totalVolume, monthlyTotals } });
  }
  return { flat, byId, pillars };
}

// Diagnostics: which keywords fell into NO cluster (helps spot gaps/typos).
export function uncovered(results, dataset) {
  const claimed = new Set();
  for (const r of results) for (const kw of r.matched) claimed.add(kw.lower);
  const rows = dataset.keywords.filter((kw) => !claimed.has(kw.lower));
  rows.sort((a, b) => b.avgMonthly - a.avgMonthly);
  const volume = rows.reduce((s, kw) => s + kw.avgMonthly, 0);
  return { rows, volume, count: rows.length };
}

// Seasonality: average each calendar month (0-11) across all years present,
// returning a 12-length array (or nulls where a month has no data).
export function seasonality(monthlyTotals, months) {
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  months.forEach((m, i) => {
    sums[m.m] += monthlyTotals[i];
    counts[m.m] += 1;
  });
  return sums.map((s, i) => (counts[i] ? Math.round(s / counts[i]) : null));
}
