// suggest.js — propose categories from an uploaded dataset, fully in-browser.
//
// Two kinds of proposal, both grounded in SEO/GEO best practice:
//  • Themes  — recurring modifier terms (destinations, topics) ranked by volume.
//  • Strategic groups — search-intent buckets (transactional/commercial) and a
//    GEO "Questions" group, so clusters map to content types and AI answers.
//
// Each keyword is expected to carry `.intent` (see intent.js). Everything is a
// pure function over the dataset — no network, no keys.

import { isQuestion, Q_WORDS, INTENT_SUGGEST_TERMS, INTENT_META } from './intent.js';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'in', 'on', 'of', 'at', 'by', 'is', 'are', 'best', 'top', 'vs', 'my', 'your',
  'de', 'het', 'een', 'en', 'of', 'voor', 'met', 'naar', 'in', 'op', 'van', 'te', 'aan', 'bij', 'om', 'dat', 'die', 'der', 'den', 'als', 'is', 'zijn', 'beste', 'goede',
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'pour', 'avec', 'en', 'sur', 'au', 'aux', 'et', 'ou', 'dans', 'par', 'meilleur', 'meilleure',
]);

function tokenize(s) {
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}
function isStop(t) {
  return t.length < 3 || STOP.has(t) || /^\d+$/.test(t);
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function existingTermSet(clusters) {
  const set = new Set();
  for (const c of clusters || []) {
    for (const r of c.includes || []) {
      if (r.mode === 'regex') continue;
      for (const t of r.terms || []) set.add(String(t).toLowerCase().trim());
    }
  }
  return set;
}
function existingNameSet(clusters) {
  return new Set((clusters || []).map((c) => (c.name || '').toLowerCase()));
}
// Dominant intent of a {intent: volume} tally.
function topIntent(tally) {
  let best = 'other', max = -1;
  for (const k of Object.keys(tally)) if (tally[k] > max) { max = tally[k]; best = k; }
  return best;
}

function themeCandidates(dataset, existing, minKeywords, headRatio, maxSuggestions) {
  const kws = dataset.keywords;
  const totalCount = kws.length;
  const stats = new Map();
  for (const k of kws) {
    const seen = new Set();
    for (const tok of tokenize(k.lower)) {
      if (isStop(tok) || seen.has(tok)) continue;
      seen.add(tok);
      let s = stats.get(tok);
      if (!s) { s = { token: tok, vol: 0, count: 0, examples: [], intents: {} }; stats.set(tok, s); }
      s.vol += k.avgMonthly;
      s.count += 1;
      s.intents[k.intent || 'other'] = (s.intents[k.intent || 'other'] || 0) + k.avgMonthly;
      if (s.examples.length < 12) s.examples.push({ keyword: k.keyword, vol: k.avgMonthly });
    }
  }
  // Fold plural/derived forms into a shorter prefix form.
  const tokens = [...stats.values()].sort((a, b) => a.token.length - b.token.length);
  const merged = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (merged.has(a.token) || a.token.length < 4) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const b = tokens[j];
      if (merged.has(b.token)) continue;
      if (b.token.startsWith(a.token) && b.token.length - a.token.length <= 3 && /(s|en|e|n)$/.test(b.token)) {
        a.vol += b.vol; a.count += b.count; a.examples.push(...b.examples);
        for (const k of Object.keys(b.intents)) a.intents[k] = (a.intents[k] || 0) + b.intents[k];
        merged.add(b.token);
      }
    }
  }
  const out = [];
  for (const s of stats.values()) {
    if (merged.has(s.token)) continue;
    if (s.count < minKeywords) continue;
    if (existing.has(s.token)) continue;
    if (s.count / totalCount > headRatio) continue; // head term — defines the whole set
    s.examples.sort((a, b) => b.vol - a.vol);
    out.push({
      type: 'theme',
      name: capitalize(s.token),
      term: s.token,
      include: { mode: 'words', terms: [s.token] },
      count: s.count,
      volume: s.vol,
      intent: topIntent(s.intents),
      examples: s.examples.slice(0, 3).map((e) => e.keyword),
    });
  }
  out.sort((a, b) => b.volume - a.volume || b.count - a.count);
  return out.slice(0, maxSuggestions);
}

function strategicCandidates(dataset, existingNames, minKeywords) {
  const out = [];
  const add = (pred) => {
    const matched = dataset.keywords.filter(pred);
    const volume = matched.reduce((s, k) => s + k.avgMonthly, 0);
    matched.sort((a, b) => b.avgMonthly - a.avgMonthly);
    return { count: matched.length, volume, examples: matched.slice(0, 3).map((k) => k.keyword) };
  };

  // GEO: question keywords.
  const q = add((k) => isQuestion(k.lower));
  if (q.count >= minKeywords && q.volume > 0 && !existingNames.has('questions (geo)')) {
    out.push({
      type: 'question', name: 'Questions (GEO)', intent: 'informational',
      include: { mode: 'regex', pattern: `\\b(${[...Q_WORDS].join('|')})\\b` },
      ...q,
    });
  }
  // Intent buckets (transactional, commercial).
  for (const key of ['transactional', 'commercial']) {
    const meta = INTENT_META[key];
    const name = `${meta.label} intent`;
    if (existingNames.has(name.toLowerCase())) continue;
    const r = add((k) => k.intent === key);
    if (r.count >= minKeywords && r.volume > 0) {
      out.push({ type: 'intent', name, intent: key, include: { mode: 'words', terms: INTENT_SUGGEST_TERMS[key] }, ...r });
    }
  }
  out.sort((a, b) => b.volume - a.volume);
  return out;
}

export function suggestCategories(dataset, existingClusters = [], opts = {}) {
  const totalCount = dataset.keywords.length;
  if (!totalCount) return [];
  const minKeywords = opts.minKeywords ?? (totalCount >= 200 ? 3 : totalCount >= 50 ? 2 : 1);
  const headRatio = opts.headRatio ?? 0.6;
  const maxSuggestions = opts.maxSuggestions ?? 25;
  const existingTerms = existingTermSet(existingClusters);
  const existingNames = existingNameSet(existingClusters);

  const strategic = strategicCandidates(dataset, existingNames, minKeywords);
  const themes = themeCandidates(dataset, existingTerms, minKeywords, headRatio, maxSuggestions);
  return [...strategic, ...themes];
}
