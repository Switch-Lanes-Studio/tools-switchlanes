// parser.js — robust Google Keyword Planner export parser.
//
// Real GKP exports are awkward: they are usually UTF-16LE, tab-delimited, and
// the first two or three lines are metadata ("Keyword Stats ...", a blank line)
// before the real header row. This module decodes the bytes correctly, finds
// the true header, identifies the monthly "Searches: Mon YYYY" columns, and
// returns a clean, predictable dataset the rest of the app can rely on.

const MONTHS = {
  jan: 0, feb: 1, mar: 2, mrt: 2, apr: 3, may: 4, mei: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11,
};

// Native GKP metric columns we carry straight through (not recomputed).
const KNOWN_FIELDS = {
  keyword: ['keyword'],
  avgMonthly: ['avg. monthly searches', 'avg monthly searches', 'gem. maandelijkse zoekopdrachten'],
  threeMonth: ['three month change', 'three-month change'],
  yoy: ['yoy change', 'year over year change'],
  competition: ['competition'],
};

// Decode an uploaded file's bytes into a string, honouring a UTF-16 BOM.
function decodeBytes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  // Strip a UTF-8 BOM if present, then decode as UTF-8.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// Pick the delimiter by counting candidates on the densest early line.
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 15).join('\n');
  const tabs = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  const semis = (sample.match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

// Find the row index that actually contains the header (the one with "Keyword").
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cells = rows[i].map((c) => String(c || '').trim().toLowerCase());
    if (cells.includes('keyword')) return i;
  }
  return 0;
}

function matchField(header) {
  const h = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(KNOWN_FIELDS)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

// "Searches: Jan 2019" / "Searches: mei 2021" -> { y: 2019, m: 0, label }
function matchMonthColumn(header) {
  const h = header.trim().toLowerCase();
  const m = h.match(/searches:\s*([a-z]{3,4})\.?\s*(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3)];
  if (mon === undefined) return null;
  return { y: parseInt(m[2], 10), m: mon };
}

function toNumber(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!s || s === '-') return 0;
  // GKP sometimes gives bucketed ranges like "1K - 10K"; take the low bound.
  const range = s.match(/^([\d.,]+)\s*[-–]\s*[\d.,]+/);
  const pick = range ? range[1] : s;
  const n = parseFloat(pick.replace(/\s/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Public API: parse raw bytes (ArrayBuffer) into a structured dataset.
export function parseGkp(arrayBuffer, fileName) {
  const text = decodeBytes(arrayBuffer);
  const delimiter = detectDelimiter(text);
  const parsed = Papa.parse(text, {
    delimiter,
    skipEmptyLines: 'greedy',
  });
  const rows = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => String(c || '').trim() !== ''));
  if (!rows.length) throw new Error(`${fileName}: no rows found.`);

  const headerIdx = findHeaderRow(rows);
  const header = rows[headerIdx].map((c) => String(c || '').trim());

  // Map columns: known metric fields + monthly time-series columns.
  const fieldCols = {};
  const monthCols = []; // { col, y, m }
  header.forEach((h, col) => {
    const f = matchField(h);
    if (f && fieldCols[f] === undefined) fieldCols[f] = col;
    const mc = matchMonthColumn(h);
    if (mc) monthCols.push({ col, y: mc.y, m: mc.m });
  });

  if (fieldCols.keyword === undefined) {
    throw new Error(`${fileName}: could not find a "Keyword" column.`);
  }

  monthCols.sort((a, b) => a.y - b.y || a.m - b.m);
  const months = monthCols.map((mc) => ({ y: mc.y, m: mc.m }));

  const keywords = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const kw = String(row[fieldCols.keyword] || '').trim();
    if (!kw) continue;
    const monthly = monthCols.map((mc) => toNumber(row[mc.col]));
    keywords.push({
      keyword: kw,
      lower: kw.toLowerCase(),
      avgMonthly: fieldCols.avgMonthly !== undefined ? toNumber(row[fieldCols.avgMonthly]) : 0,
      threeMonth: fieldCols.threeMonth !== undefined ? String(row[fieldCols.threeMonth] || '').trim() : '',
      yoy: fieldCols.yoy !== undefined ? String(row[fieldCols.yoy] || '').trim() : '',
      competition: fieldCols.competition !== undefined ? String(row[fieldCols.competition] || '').trim() : '',
      monthly,
    });
  }

  if (!keywords.length) throw new Error(`${fileName}: header found but no keyword rows.`);

  return {
    fileName,
    months,            // ordered [{y, m}]
    hasAvgColumn: fieldCols.avgMonthly !== undefined,
    keywords,
  };
}

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(m) {
  return `${MONTH_LABELS[m.m]} ${m.y}`;
}
