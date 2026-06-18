// suggest.js — propose categories from an uploaded dataset, fully in-browser.
//
// Idea: the keywords share a "head" term (e.g. huwelijksreis / honeymoon) that
// defines the whole set. The useful categories are the recurring *modifiers* —
// destinations (bali, italië), intent (goedkope, luxe), brands (tui). We rank
// candidate terms by total search volume so the proposals reflect real demand,
// exactly how the sheet was built by hand.

const STOP = new Set([
  // EN
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'in', 'on', 'of', 'at', 'by', 'is', 'are', 'best', 'top', 'vs', 'my', 'your',
  // NL
  'de', 'het', 'een', 'en', 'of', 'voor', 'met', 'naar', 'in', 'op', 'van', 'te', 'aan', 'bij', 'om', 'dat', 'die', 'der', 'den', 'als', 'is', 'zijn', 'beste', 'goede',
  // FR
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

// Terms already represented by existing categories (so we don't re-suggest them).
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

export function suggestCategories(dataset, existingClusters = [], opts = {}) {
  const kws = dataset.keywords;
  const totalCount = kws.length;
  if (!totalCount) return [];

  // Adaptive minimum support so it works for tiny samples and huge datasets.
  const minKeywords = opts.minKeywords ?? (totalCount >= 200 ? 3 : totalCount >= 50 ? 2 : 1);
  const headRatio = opts.headRatio ?? 0.6;   // terms in >60% of keywords = "head", hidden
  const maxSuggestions = opts.maxSuggestions ?? 25;
  const existing = existingTermSet(existingClusters);

  // Count per token: volume, keyword count, example keywords.
  const stats = new Map();
  for (const k of kws) {
    const seen = new Set();
    for (const tok of tokenize(k.lower)) {
      if (isStop(tok) || seen.has(tok)) continue;
      seen.add(tok);
      let s = stats.get(tok);
      if (!s) { s = { token: tok, vol: 0, count: 0, examples: [] }; stats.set(tok, s); }
      s.vol += k.avgMonthly;
      s.count += 1;
      if (s.examples.length < 12) s.examples.push({ keyword: k.keyword, vol: k.avgMonthly });
    }
  }

  // Fold plural/derived forms into a shorter prefix form (substring matching at
  // engine time then catches both): bestemming ⊂ bestemmingen, etc.
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
        merged.add(b.token);
      }
    }
  }

  // Build, filter, rank.
  const candidates = [];
  for (const s of stats.values()) {
    if (merged.has(s.token)) continue;
    if (s.count < minKeywords) continue;
    if (existing.has(s.token)) continue;
    if (s.count / totalCount > headRatio) continue; // head term — defines the whole set
    s.examples.sort((a, b) => b.vol - a.vol);
    candidates.push({
      name: capitalize(s.token),
      term: s.token,
      count: s.count,
      volume: s.vol,
      examples: s.examples.slice(0, 3).map((e) => e.keyword),
    });
  }
  candidates.sort((a, b) => b.volume - a.volume || b.count - a.count);
  return candidates.slice(0, maxSuggestions);
}
