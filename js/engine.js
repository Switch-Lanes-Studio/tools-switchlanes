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

// Run one cluster against a dataset. Returns matched keywords + aggregates.
export function runCluster(cluster, dataset) {
  const compiled = compileCluster(cluster);
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

// Run a whole project (many clusters) against a dataset.
export function runProject(clusters, dataset) {
  return clusters.map((c) => runCluster(c, dataset));
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
