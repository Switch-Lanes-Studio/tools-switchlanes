// sample.js — built-in demo data mirroring the original "Huwelijksreis" sheet,
// so the tool can be explored with one click before any real upload.

function months() {
  const out = [];
  for (let y = 2019; y <= 2022; y++) for (let m = 0; m < 12; m++) out.push({ y, m });
  out.push({ y: 2023, m: 0 });
  return out;
}

// Deterministic pseudo-random monthly series around an average, with mild
// summer seasonality, so trends/charts look realistic without being random.
function series(avg, mlist, seed) {
  let s = seed;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  return mlist.map((m) => {
    const season = 1 + 0.25 * Math.sin(((m.m - 2) / 12) * 2 * Math.PI);
    const noise = 0.8 + rnd() * 0.4;
    return Math.max(0, Math.round((avg * season * noise) / 10) * 10);
  });
}

function makeDataset(label, role, rows) {
  const mlist = months();
  return {
    id: 'sample_' + label.replace(/\W+/g, '_').toLowerCase(),
    fileName: label + '.csv',
    label,
    role,
    months: mlist,
    keywords: rows.map(([kw, avg, three, yoy], i) => ({
      keyword: kw,
      lower: kw.toLowerCase(),
      avgMonthly: avg,
      threeMonth: three || '0%',
      yoy: yoy || '0%',
      competition: ['Low', 'Medium', 'High'][i % 3],
      monthly: series(avg, mlist, (i + 1) * 137 + avg),
    })),
  };
}

const MARKET = [
  ['honeymoon', 1300, '-23%', '0%'], ['huwelijksreis', 880, '0%', '0%'], ['huwelijkreis', 880, '0%', '0%'],
  ['huwelijksreis bestemmingen', 210, '0%', '22%'], ['huwelijksreisbestemmingen', 210, '0%', '22%'],
  ['huwelijksreis europa', 90, '40%', '-22%'], ['huwelijksreis malediven', 70, '-25%', '-40%'],
  ['huwelijksreis bali', 50, '75%', '40%'], ['huwelijksreis bestemming', 50, '67%', '400%'],
  ['huwelijksreis top 10', 50, '0%', '-89%'], ['huwelijksreis griekenland', 50, '0%', '0%'],
  ['tui huwelijksreis', 40, '0%', '0%'], ['goedkope huwelijksreis', 30, '-50%', '-33%'],
  ['huwelijksreis italie', 30, '100%', '33%'], ['huwelijksreis blind getrouwd', 30, '0%', '0%'],
  ['betaalbare huwelijksreis', 20, '50%', '-25%'], ['honeymoon bestemmingen', 20, '29%', '350%'],
  ['huwelijksreis hawaii', 20, '100%', '0%'], ['huwelijksreis mauritius', 20, '100%', '100%'],
  ['huwelijksreis mexico', 20, '50%', '50%'], ['huwelijksreis thailand', 20, '100%', '300%'],
  ['huwelijksreis frankrijk', 10, '0%', '0%'], ['huwelijksreis zuid frankrijk', 10, '0%', '0%'],
  ['huwelijksreis spanje', 10, '0%', '0%'], ['huwelijksreis parijs', 10, '0%', '0%'],
  ['goedkope honeymoon', 10, '0%', '0%'], ['luxe huwelijksreis', 10, '0%', '-50%'],
  ['huwelijksreis zuid italie', 10, '-100%', '-100%'], ['huwelijksreis toscane', 10, '0%', '0%'],
];

const COMPETITORS = [
  ['tui', 110, '20%', '0%'], ['tui huwelijksreis', 40, '0%', '0%'], ['tui honeymoon', 20, '0%', '0%'],
  ['neckermann reizen', 90, '10%', '-10%'], ['neckermann', 70, '0%', '0%'],
  ['sunweb', 60, '5%', '0%'], ['corendon', 50, '-5%', '0%'],
];

export function sampleDatasets() {
  return [makeDataset('NL market', 'market', MARKET), makeDataset('Competitors', 'competitor', COMPETITORS)];
}

export function sampleClusters() {
  return [
    { id: 'c_honeymoon', name: 'Huwelijksreizen', parentId: null, includes: [{ mode: 'words', terms: ['reis', 'honey'] }], excludes: [{ mode: 'words', terms: ['hout', 'rond', 'ikea', 'stoel', 'teak'] }] },
    { id: 'c_bali', name: 'Bali', parentId: 'c_honeymoon', includes: [{ mode: 'words', terms: ['bali'] }], excludes: [] },
    { id: 'c_italie', name: 'Italië', parentId: 'c_honeymoon', includes: [{ mode: 'words', terms: ['italie', 'toscane'] }], excludes: [] },
    { id: 'c_goedkoop', name: 'Goedkope', parentId: 'c_honeymoon', includes: [{ mode: 'words', terms: ['goedkope', 'betaalbare', 'budget'] }], excludes: [] },
    { id: 'c_tui', name: 'TUI', parentId: 'c_honeymoon', includes: [{ mode: 'words', terms: ['tui'] }], excludes: [] },
  ];
}
