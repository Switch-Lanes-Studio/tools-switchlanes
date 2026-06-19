// intent.js — rule-based search-intent classification (NL/EN/FR), fully offline.
//
// Best-practice SEO groups keywords by intent so each cluster maps to one
// content type (guide vs comparison vs booking page). We approximate the four
// canonical intents with multilingual signal words + a few phrase patterns.
// GEO adds question detection (AI engines retrieve by the question asked).

const STOP = new Set(['de','het','een','en','of','voor','met','naar','in','op','van','te','the','a','an','and','or','for','with','to','of','le','la','les','des','du','un','une']);

function tokenize(s) {
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

export const Q_WORDS = new Set([
  'how', 'what', 'why', 'when', 'where', 'which', 'who',
  'hoe', 'wat', 'waarom', 'wanneer', 'waar', 'welke', 'wie',
  'comment', 'pourquoi', 'quoi', 'quand', 'quel', 'quelle', 'qui', 'combien', 'ou',
]);

const TRANSACTIONAL = new Set([
  // EN
  'buy', 'order', 'book', 'booking', 'deal', 'deals', 'cheap', 'cheapest', 'price', 'prices', 'cost', 'costs', 'discount', 'coupon', 'hire', 'rent', 'subscribe', 'download', 'quote',
  // NL
  'boeken', 'boek', 'kopen', 'koop', 'prijs', 'prijzen', 'kosten', 'goedkoop', 'goedkope', 'goedkoopste', 'aanbieding', 'aanbiedingen', 'korting', 'reserveren', 'reservering', 'aanbod', 'betaalbare', 'betaalbaar',
  // FR
  'acheter', 'reserver', 'réserver', 'reservation', 'réservation', 'prix', 'commander', 'promo', 'réduction', 'reduction', 'devis',
]);
const TRANS_PHRASES = [/all[- ]?in(clusive)?/, /last ?minute/, /pas cher/, /near me/];

const COMMERCIAL = new Set([
  // EN
  'best', 'top', 'review', 'reviews', 'vs', 'versus', 'comparison', 'compare', 'alternative', 'alternatives', 'ideas', 'examples',
  // NL
  'beste', 'vergelijken', 'vergelijking', 'ervaring', 'ervaringen', 'aanrader', 'ideeen', 'ideeën', 'inspiratie', 'voorbeelden', 'mooiste', 'populairste', 'leukste', 'mooie', 'unieke', 'originele', 'luxe', 'luxueuze',
  // FR
  'meilleur', 'meilleure', 'comparatif', 'avis', 'idées', 'idees', 'exemples',
]);

const INFORMATIONAL = new Set([
  'guide', 'tips', 'meaning', 'tutorial', 'checklist',
  'gids', 'betekenis', 'uitleg', 'planning', 'plannen',
  'conseils', 'signification',
]);

// Curated, compact signal sets used when proposing intent-based categories
// (the full sets above would make an unwieldy rule).
export const INTENT_SUGGEST_TERMS = {
  transactional: ['boeken', 'prijs', 'kosten', 'goedkope', 'betaalbare', 'aanbieding', 'last minute', 'all inclusive', 'book', 'price', 'cheap', 'deal'],
  commercial: ['beste', 'top', 'vergelijken', 'review', 'mooiste', 'ideeen', 'best', 'vs', 'review'],
};

export const INTENT_META = {
  transactional: { label: 'Transactional', color: '#36c08e' },
  commercial: { label: 'Commercial', color: '#4f8cff' },
  informational: { label: 'Informational', color: '#ffb454' },
  navigational: { label: 'Navigational', color: '#b072ff' },
  other: { label: 'Other', color: '#9aa3b2' },
};

// How each intent maps to action + weighting. seoW = value for organic content,
// adsW = value for paid search. Used by the opportunity score and the
// per-cluster "recommended use" hint.
export const INTENT_ACTION = {
  transactional: { seoW: 0.7, adsW: 1.0, seo: 'Landing / product page', ads: 'Core ad-group — bid here' },
  commercial: { seoW: 0.9, adsW: 0.9, seo: 'Comparison / “best” page', ads: 'Strong ad-group' },
  informational: { seoW: 1.0, adsW: 0.3, seo: 'Guide / blog / FAQ', ads: 'Usually skip in paid' },
  navigational: { seoW: 0.3, adsW: 0.6, seo: 'Brand page', ads: 'Brand-defense ad-group' },
  other: { seoW: 0.6, adsW: 0.5, seo: 'Review intent', ads: 'Review before bidding' },
};

export function isQuestion(lower) {
  return tokenize(lower).some((t) => Q_WORDS.has(t));
}

export function classifyIntent(lower, brandTerms) {
  const tokens = tokenize(lower);
  if (brandTerms && brandTerms.size && tokens.some((t) => brandTerms.has(t))) return 'navigational';
  if (tokens.some((t) => TRANSACTIONAL.has(t)) || TRANS_PHRASES.some((r) => r.test(lower))) return 'transactional';
  if (tokens.some((t) => COMMERCIAL.has(t))) return 'commercial';
  if (tokens.some((t) => INFORMATIONAL.has(t)) || tokens.some((t) => Q_WORDS.has(t))) return 'informational';
  return 'other';
}

// Derive "brand" tokens from datasets the user tagged competitor/brand, so
// keywords containing them can be flagged navigational. Excludes the market's
// head terms (present in >30% of a market dataset) to avoid over-labelling.
export function buildBrandTerms(datasets) {
  const brandSets = datasets.filter((d) => d.role === 'competitor' || d.role === 'brand');
  const marketSets = datasets.filter((d) => d.role === 'market');
  const marketHead = new Set();
  for (const md of marketSets) {
    const counts = new Map();
    for (const k of md.keywords) for (const t of new Set(tokenize(k.lower))) counts.set(t, (counts.get(t) || 0) + 1);
    const thresh = md.keywords.length * 0.3;
    for (const [t, c] of counts) if (c > thresh) marketHead.add(t);
  }
  const counts = new Map();
  for (const bd of brandSets) {
    for (const k of bd.keywords) {
      for (const t of new Set(tokenize(k.lower))) {
        if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
  }
  const out = new Set();
  for (const [t, c] of counts) if (c >= 2 && !marketHead.has(t)) out.add(t);
  return out;
}

// Annotate every keyword in every dataset with `.intent` (call when datasets
// or their roles change).
export function annotateIntents(datasets) {
  const brandTerms = buildBrandTerms(datasets);
  for (const d of datasets) for (const k of d.keywords) k.intent = classifyIntent(k.lower, brandTerms);
  return brandTerms;
}
