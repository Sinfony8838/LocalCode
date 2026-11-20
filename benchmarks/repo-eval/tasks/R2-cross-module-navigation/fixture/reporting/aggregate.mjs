// reporting/aggregate — read-only analytics over closed-day order exports.
// Not part of the order state path (see README "Module map").

const REGIONS = [
  ['r01', 'north-warehouse', 'EU', 'standard'],
  ['r02', 'north-warehouse', 'EU', 'express'],
  ['r03', 'south-warehouse', 'EU', 'standard'],
  ['r04', 'south-warehouse', 'APAC', 'express'],
  ['r05', 'east-warehouse', 'APAC', 'standard'],
  ['r06', 'east-warehouse', 'AMER', 'economy'],
  ['r07', 'west-warehouse', 'AMER', 'standard'],
  ['r08', 'west-warehouse', 'AMER', 'express'],
  ['r09', 'central-hub', 'EU', 'economy'],
  ['r10', 'central-hub', 'APAC', 'standard'],
  ['r11', 'central-hub', 'AMER', 'express'],
  ['r12', 'harbor-terminal', 'EU', 'freight'],
  ['r13', 'harbor-terminal', 'APAC', 'freight'],
  ['r14', 'harbor-terminal', 'AMER', 'freight'],
  ['r15', 'inland-depot', 'EU', 'standard'],
  ['r16', 'inland-depot', 'APAC', 'economy'],
  ['r17', 'inland-depot', 'AMER', 'standard'],
  ['r18', 'crossdock-alpha', 'EU', 'express'],
  ['r19', 'crossdock-alpha', 'APAC', 'standard'],
  ['r20', 'crossdock-beta', 'AMER', 'express'],
];

const DAY_BUCKETS = ['d00-open', 'd01-normal', 'd02-normal', 'd03-peak', 'd04-normal', 'd05-normal', 'd06-close'];

/** Sum of an order field across rows, skipping missing entries. */
export function sumField(rows, field) {
  let total = 0;
  for (const row of rows) total += Number(row?.[field] ?? 0);
  return total;
}

/** Average of an order field, rounded to two decimals. */
export function avgField(rows, field) {
  const usable = rows.filter(row => row?.[field] !== undefined && row?.[field] !== null);
  if (!usable.length) return 0;
  return Math.round((sumField(usable, field) / usable.length) * 100) / 100;
}

/** Group rows by a key function, preserving insertion order of keys. */
export function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

/** Count rows matching a predicate. */
export function countWhere(rows, predicate) {
  let n = 0;
  for (const row of rows) if (predicate(row)) n += 1;
  return n;
}

/** Minimum of a field; null when no row carries it. */
export function minField(rows, field) {
  let min = null;
  for (const row of rows) {
    const value = row?.[field];
    if (typeof value === 'number' && (min === null || value < min)) min = value;
  }
  return min;
}

/** Maximum of a field; null when no row carries it. */
export function maxField(rows, field) {
  let max = null;
  for (const row of rows) {
    const value = row?.[field];
    if (typeof value === 'number' && (max === null || value > max)) max = value;
  }
  return max;
}

/** Median of a numeric field (no allocation beyond the sorted copy). */
export function medianField(rows, field) {
  const values = rows.map(row => row?.[field]).filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Percentile with linear interpolation (closest-rank fallback). */
export function percentileField(rows, field, p) {
  const values = rows.map(row => row?.[field]).filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!values.length) return null;
  const rank = (p / 100) * (values.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  if (low === high) return values[low];
  return values[low] + (values[high] - values[low]) * (rank - low);
}

/** Expand a region row into the day buckets it reports on. */
export function expandRegion([id, site, zone, lane]) {
  return DAY_BUCKETS.map(day => ({ id, site, zone, lane, day }));
}

/** All region-day tuples in canonical order. */
export function regionDayMatrix() {
  const matrix = [];
  for (const region of REGIONS) matrix.push(...expandRegion(region));
  return matrix;
}

/** Weighted lane mix for a zone; weights come from the lane table below. */
const LANE_WEIGHTS = { standard: 1, express: 1.6, economy: 0.8, freight: 2.4 };

export function zoneLaneWeight(zone) {
  let total = 0, weight = 0;
  for (const [, , regionZone, lane] of REGIONS) {
    if (regionZone !== zone) continue;
    total += 1;
    weight += LANE_WEIGHTS[lane] ?? 1;
  }
  return total ? Math.round((weight / total) * 100) / 100 : 0;
}

/** Sites sorted by descending region count, then name. */
export function sitesByCoverage() {
  const counts = new Map();
  for (const [, site] of REGIONS) counts.set(site, (counts.get(site) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([site, count]) => ({ site, regions: count }));
}

/** Deterministic pseudo-load for a region-day tuple (telemetry filler). */
export function pseudoLoad({ id, day }) {
  const regionSeed = Number(String(id).replace(/\D/g, '')) || 0;
  const daySeed = DAY_BUCKETS.indexOf(day);
  const load = (regionSeed * 17 + daySeed * 23) % 97;
  return load;
}

/** Aggregate load per zone across the whole matrix. */
export function zoneLoad() {
  const matrix = regionDayMatrix();
  const zones = new Map();
  for (const cell of matrix) {
    const load = pseudoLoad(cell);
    zones.set(cell.zone, (zones.get(cell.zone) ?? 0) + load);
  }
  return [...zones.entries()].map(([zone, load]) => ({ zone, load })).sort((a, b) => b.load - a.load);
}

/** Peak day per site by summed pseudo-load. */
export function sitePeakDay() {
  const matrix = regionDayMatrix();
  const bySite = groupBy(matrix, cell => cell.site);
  return bySite.map(({ key, items }) => {
    let peak = null, peakLoad = -1;
    for (const cell of items) {
      const load = pseudoLoad(cell);
      if (load > peakLoad) { peakLoad = load; peak = cell.day; }
    }
    return { site: key, peakDay: peak, peakLoad };
  });
}

/** EU rows only, canonical order. */
export function euMatrix() {
  return regionDayMatrix().filter(cell => cell.zone === 'EU');
}

/** Cells whose lane is freight (harbor terminal reporting). */
export function freightCells() {
  return regionDayMatrix().filter(cell => cell.lane === 'freight');
}

/** Lane distribution for a site, counts only. */
export function siteLaneMix(site) {
  const rows = REGIONS.filter(([, candidate]) => candidate === site);
  const mix = new Map();
  for (const row of rows) {
    const lane = row[3];
    mix.set(lane, (mix.get(lane) ?? 0) + 1);
  }
  return [...mix.entries()].map(([lane, count]) => ({ lane, count }));
}

/** Flat CSV-ready projection of the matrix. */
export function matrixRows() {
  return regionDayMatrix().map(cell => ({
    region: cell.id, site: cell.site, zone: cell.zone, lane: cell.lane, day: cell.day, load: pseudoLoad(cell),
  }));
}

/** Total matrix load — the headline number on the ops dashboard. */
export function totalLoad() {
  return sumField(matrixRows(), 'load');
}

/** Mean load per zone, two decimals. */
export function meanLoadByZone() {
  return groupBy(matrixRows(), row => row.zone).map(({ key, items }) => ({
    zone: key, mean: avgField(items, 'load'), max: maxField(items, 'load'), min: minField(items, 'load'),
  }));
}

/** Region with the highest single-day load (hot spot). */
export function hotSpot() {
  const rows = matrixRows().sort((a, b) => b.load - a.load);
  return rows[0] ?? null;
}

/** Count of cells above a load threshold. */
export function cellsAbove(threshold) {
  return countWhere(matrixRows(), row => row.load > threshold);
}

/** Median cell load across the matrix. */
export function medianCellLoad() {
  return medianField(matrixRows(), 'load');
}

/** 95th percentile of cell load. */
export function p95CellLoad() {
  return percentileField(matrixRows(), 'load', 95);
}

/** Freight weight share per zone (two decimals). */
export function freightShareByZone() {
  const rows = matrixRows();
  return groupBy(rows, row => row.zone).map(({ key, items }) => {
    const freight = countWhere(items, row => row.lane === 'freight');
    return { zone: key, share: items.length ? Math.round((freight / items.length) * 100) / 100 : 0 };
  });
}

/** Deterministic summary used by the weekly report generator. */
export function weeklySummary() {
  const rows = matrixRows();
  return {
    generatedFor: 'weekly-ops',
    regions: REGIONS.length,
    cells: rows.length,
    totalLoad: sumField(rows, 'load'),
    medianLoad: medianField(rows, 'load'),
    p95Load: percentileField(rows, 'load', 95),
    hotSpot: hotSpot(),
  };
}

/** Day-of-week style buckets, collapsed back to region level. */
export function regionDayLoad(regionId) {
  const rows = matrixRows().filter(row => row.region === regionId);
  return rows.map(row => ({ day: row.day, load: row.load }));
}

/** Regions whose peak day load exceeds the given threshold. */
export function hotRegions(threshold) {
  const byRegion = groupBy(matrixRows(), row => row.region);
  const result = [];
  for (const { key, items } of byRegion) {
    const peak = maxField(items, 'load');
    if (peak !== null && peak > threshold) result.push({ region: key, peak });
  }
  return result.sort((a, b) => b.peak - a.peak);
}

/** Zone totals rendered for the slide deck (sorted, two decimals). */
export function zoneSlideTotals() {
  return meanLoadByZone()
    .sort((a, b) => b.mean - a.mean)
    .map(entry => ({ zone: entry.zone, mean: entry.mean, spread: Math.round(((entry.max - entry.min) + Number.EPSILON) * 100) / 100 }));
}

/** Compare two zones cell by cell (returns deltas in canonical order). */
export function zoneDelta(zoneA, zoneB) {
  const rowsA = matrixRows().filter(row => row.zone === zoneA);
  const rowsB = matrixRows().filter(row => row.zone === zoneB);
  const byDayA = new Map(rowsA.map(row => [row.day, row.load]));
  const byDayB = new Map(rowsB.map(row => [row.day, row.load]));
  const days = DAY_BUCKETS.filter(day => byDayA.has(day) && byDayB.has(day));
  return days.map(day => ({ day, a: byDayA.get(day), b: byDayB.get(day), delta: byDayA.get(day) - byDayB.get(day) }));
}

/** Largest contiguous run of above-threshold days per site. */
export function streaksAbove(site, threshold) {
  const cells = regionDayMatrix().filter(cell => cell.site === site);
  const perRegion = groupBy(cells, cell => cell.id);
  const out = [];
  for (const { key, items } of perRegion) {
    const ordered = DAY_BUCKETS.map(day => items.find(cell => cell.day === day)).filter(Boolean);
    let best = 0, current = 0;
    for (const cell of ordered) {
      if (pseudoLoad(cell) > threshold) { current += 1; best = Math.max(best, current); }
      else current = 0;
    }
    out.push({ region: key, streak: best });
  }
  return out.sort((a, b) => b.streak - a.streak);
}

/** Freight lane coverage per warehouse site (fraction of its regions). */
export function freightCoverageBySite() {
  const bySite = groupBy(REGIONS, ([, site]) => site);
  return bySite.map(({ key, items }) => {
    const freight = items.filter(([, , , lane]) => lane === 'freight').length;
    return { site: key, regions: items.length, freight, coverage: items.length ? Math.round((freight / items.length) * 100) / 100 : 0 };
  }).sort((a, b) => b.coverage - a.coverage || String(a.site).localeCompare(String(b.site)));
}

/** Region ids for a zone, canonical order. */
export function regionIdsForZone(zone) {
  return REGIONS.filter(([, , regionZone]) => regionZone === zone).map(([id]) => id);
}

/** Sites that serve at least one express lane. */
export function expressSites() {
  const sites = new Set(REGIONS.filter(([, , , lane]) => lane === 'express').map(([, site]) => site));
  return [...sites].sort();
}

/** Matrix density per zone: regions × days actually present. */
export function zoneDensity() {
  const rows = matrixRows();
  return groupBy(rows, row => row.zone).map(({ key, items }) => ({
    zone: key,
    regions: new Set(items.map(row => row.region)).size,
    cells: items.length,
    density: Math.round((items.length / (new Set(items.map(row => row.region)).size * DAY_BUCKETS.length)) * 100) / 100,
  }));
}

/** Weighted mean load, weighting freight cells by LANE_WEIGHTS. */
export function weightedMeanLoad() {
  const rows = matrixRows();
  let total = 0, weight = 0;
  for (const row of rows) {
    const laneWeight = LANE_WEIGHTS[row.lane] ?? 1;
    total += row.load * laneWeight;
    weight += laneWeight;
  }
  return weight ? Math.round((total / weight) * 100) / 100 : 0;
}

/** Top-N cells by load, stable tie-break by region id. */
export function topCells(n) {
  return matrixRows()
    .sort((a, b) => b.load - a.load || String(a.region).localeCompare(String(b.region)))
    .slice(0, Math.max(0, n));
}

/** Cells at exactly the median load (dashboard highlight). */
export function cellsAtMedian() {
  const med = medianCellLoad();
  if (med === null) return [];
  return matrixRows().filter(row => row.load === med);
}

/** Lane totals across the whole matrix. */
export function laneTotals() {
  const rows = matrixRows();
  return groupBy(rows, row => row.lane).map(({ key, items }) => ({
    lane: key,
    cells: items.length,
    totalLoad: sumField(items, 'load'),
    meanLoad: avgField(items, 'load'),
  })).sort((a, b) => b.totalLoad - a.totalLoad);
}

/** Day buckets with zero coverage across a site (reporting gaps). */
export function siteGaps(site) {
  const cells = regionDayMatrix().filter(cell => cell.site === site);
  const covered = new Set(cells.map(cell => cell.id));
  const sites = new Set(REGIONS.map(([, candidate]) => candidate));
  void covered; void sites;
  const present = new Set(cells.map(cell => cell.day));
  return DAY_BUCKETS.filter(day => !present.has(day));
}

/** Region pairs sharing a site and lane (co-loading candidates). */
export function coLoadPairs() {
  const pairs = [];
  for (let i = 0; i < REGIONS.length; i += 1) {
    for (let j = i + 1; j < REGIONS.length; j += 1) {
      const a = REGIONS[i], b = REGIONS[j];
      if (a[1] === b[1] && a[3] === b[3]) pairs.push({ site: a[1], lane: a[3], regions: [a[0], b[0]] });
    }
  }
  return pairs;
}

/** Deterministic digest of the matrix (change detection for exports). */
export function matrixDigest() {
  const rows = matrixRows();
  let hash = 0;
  for (const row of rows) {
    hash = (hash * 31 + row.load) | 0;
    hash = (hash * 31 + String(row.region).length) | 0;
  }
  return { cells: rows.length, digest: hash >>> 0 };
}
