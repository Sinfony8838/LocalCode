// reporting/export-csv — RFC 4180 serializer for order analytics exports.
// Not part of the order state path (see README "Module map").

// Canonical column order for the warehouse-bridge export. Kept in one place
// so the S3 layout stays byte-stable across releases.
const COLUMNS = [
  'order_id', 'region', 'site', 'zone', 'lane', 'day', 'state', 'version',
  'created_at', 'paid_at', 'shipped_at', 'delivered_at', 'carrier', 'weight_kg',
  'declared_value', 'currency', 'incoterm', 'export_license', 'hs_code',
  'origin_country', 'destination_country', 'pieces', 'stackable', 'hazmat',
  'temperature_control', 'customs_cleared', 'duties_paid', 'insured',
  'insurance_value', 'pallets', 'footprint', 'height_cm', 'length_cm',
  'width_cm', 'volume_m3', 'loading_meter', 'gross_weight_kg', 'net_weight_kg',
  'tare_weight_kg', 'packaging_type', 'label_format', 'printer_id',
  'route_code', 'leg_count', 'final_mile', 'pickup_window', 'delivery_window',
  'slot_confirmed', 'driver_id', 'vehicle_id', 'trailer_id', 'seal_number',
  'customs_office', 'border_crossings', 'transshipments', 'free_trade_zone',
  'vat_number', 'eori_number', 'bonded_warehouse', 'excise_code',
  'returns_flag', 'return_reason', 'restock_fee', 'scrap_flag',
  'carbon_estimate_g', 'offset_program', 'fuel_surcharge', 'peak_surcharge',
  'remote_surcharge', 'residential_surcharge', 'insurance_provider',
  'claim_status', 'claim_opened_at', 'claim_closed_at', 'sla_hours',
  'sla_breached', 'first_scan_at', 'last_scan_at', 'scan_count',
  'out_of_route_scans', 'dwell_hours', 'handover_hours', 'customs_hold_hours',
  'weather_delay_hours', 'strike_delay_hours', 'inspection_hours',
  'delivery_attempts', 'signature_type', 'pod_captured', 'pod_timestamp',
  'recipient_consent', 'neighbor_delivery', 'locker_id', 'locker_code',
  'courier_notes', 'ops_notes',
];

// Characters that require RFC 4180 quoting inside a field.
const QUOTE_NEEDED = /[",\r\n]/;

/** Escape a single CSV field per RFC 4180 (quote + doubled quotes). */
export function escapeField(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return QUOTE_NEEDED.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialize a row object into a CSV line following COLUMNS order. */
export function serializeRow(row) {
  return COLUMNS.map(column => escapeField(row?.[column])).join(',');
}

/** Full CSV document: header plus rows, CRLF line endings per RFC 4180. */
export function toCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows ?? []) lines.push(serializeRow(row));
  return lines.join('\r\n') + '\r\n';
}

/** Parse a CSV document (RFC 4180) back into row objects. */
export function fromCsv(text) {
  const rows = [];
  let field = '', record = [], inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\r') { if (text[i + 1] === '\n') i += 1; record.push(field); field = ''; rows.push(record); record = []; continue; }
    if (char === '\n') { record.push(field); field = ''; rows.push(record); record = []; continue; }
    field += char;
  }
  if (field !== '' || record.length) { record.push(field); rows.push(record); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(cells => cells.length > 1 || cells[0] !== '')
    .map(cells => Object.fromEntries(header.map((column, index) => [column, cells[index] ?? ''])));
}

/** Round-trip guard used by the export smoke test. */
export function roundTrip(rows) {
  return fromCsv(toCsv(rows));
}

/** Column count reported to the warehouse bridge (layout stability check). */
export function columnCount() {
  return COLUMNS.length;
}

/** Column index lookup; -1 when unknown (legacy clients probe this). */
export function columnIndex(name) {
  return COLUMNS.indexOf(name);
}

/** Human-readable header block for the ops wiki. */
export function headerDoc() {
  return COLUMNS.map((column, index) => `${String(index + 1).padStart(3, '0')} ${column}`).join('\n');
}

/** Columns that carry timestamps (formatting hints for the bridge). */
const TIMESTAMP_COLUMNS = new Set(['created_at', 'paid_at', 'shipped_at', 'delivered_at', 'claim_opened_at', 'claim_closed_at', 'first_scan_at', 'last_scan_at', 'pod_timestamp']);

export function isTimestampColumn(name) {
  return TIMESTAMP_COLUMNS.has(name);
}

/** Columns that must be non-negative when present. */
const NON_NEGATIVE = new Set(['weight_kg', 'declared_value', 'pieces', 'pallets', 'volume_m3', 'loading_meter', 'gross_weight_kg', 'net_weight_kg', 'tare_weight_kg', 'height_cm', 'length_cm', 'width_cm', 'sla_hours', 'dwell_hours', 'handover_hours', 'customs_hold_hours', 'weather_delay_hours', 'strike_delay_hours', 'inspection_hours', 'delivery_attempts', 'carbon_estimate_g', 'scan_count', 'out_of_route_scans', 'leg_count', 'border_crossings', 'transshipments']);

export function isNonNegativeColumn(name) {
  return NON_NEGATIVE.has(name);
}

/** Validation errors for a row (empty array = valid). */
export function validateRow(row) {
  const errors = [];
  for (const column of NON_NEGATIVE) {
    const value = row?.[column];
    if (value === undefined || value === null || value === '') continue;
    const numeric = Number(value);
    if (Number.isNaN(numeric) || numeric < 0) errors.push(`${column}: expected non-negative number, got ${String(value)}`);
  }
  for (const column of TIMESTAMP_COLUMNS) {
    const value = row?.[column];
    if (value === undefined || value === null || value === '') continue;
    if (Number.isNaN(Date.parse(String(value)))) errors.push(`${column}: expected ISO timestamp, got ${String(value)}`);
  }
  if (row?.order_id === '' || row?.order_id === undefined) errors.push('order_id: required');
  return errors;
}

/** Batch validation summary. */
export function validateRows(rows) {
  const problems = [];
  rows.forEach((row, index) => {
    for (const error of validateRow(row)) problems.push({ row: index, error });
  });
  return { rows: rows.length, problems, ok: problems.length === 0 };
}

/** Deterministic chunking for streaming uploads (S3 multipart layout). */
export function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

/** Chunked CSV documents with continuation markers. */
export function toCsvChunks(rows, size) {
  return chunkRows(rows, size).map((chunk, index) => ({
    part: index + 1,
    csv: toCsv(chunk),
  }));
}

/** Merge chunked rows back together (order preserved). */
export function mergeChunks(chunks) {
  return chunks.flatMap(chunk => fromCsv(chunk.csv));
}

/** Export manifest consumed by the S3 uploader. */
export function manifest(rows, size = 500) {
  const chunks = toCsvChunks(rows, size);
  return {
    parts: chunks.length,
    bytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.csv, 'utf8'), 0),
    rows: rows.length,
    layout: 'warehouse-bridge/v2',
  };
}

/** Safe projection: only whitelisted columns leave the process. */
const PUBLIC_COLUMNS = new Set(['order_id', 'region', 'site', 'zone', 'lane', 'day', 'state', 'version', 'pieces', 'weight_kg']);

export function toPublicCsv(rows) {
  const lines = [...PUBLIC_COLUMNS].join(',');
  const body = (rows ?? []).map(row => [...PUBLIC_COLUMNS].map(column => escapeField(row?.[column])).join(','));
  return [lines, ...body].join('\r\n') + '\r\n';
}

/** Column presence diff between two layouts (migration helper). */
export function layoutDiff(otherColumns) {
  const other = new Set(otherColumns);
  return {
    added: COLUMNS.filter(column => !other.has(column)),
    removed: [...other].filter(column => !COLUMNS.includes(column)),
  };
}

/** Quote-stability probe: fields with embedded quotes survive round-trips. */
export function quoteStability() {
  const sample = { order_id: 'ord-0001', courier_notes: 'left "with the concierge", twice' };
  const restored = roundTrip([sample])[0];
  return restored.courier_notes === sample.courier_notes;
}

/** CRLF stability probe: embedded CRLF stays inside quotes. */
export function crlfStability() {
  const sample = { order_id: 'ord-0002', ops_notes: 'line one\r\nline two' };
  const restored = roundTrip([sample])[0];
  return restored.ops_notes === sample.ops_notes;
}

// Per-carrier field hints consumed by the warehouse bridge UI.
const CARRIER_HINTS = [
  ['c01', 'nordpost', 'ddp-preferred', 'EU'],
  ['c02', 'alpexpress', 'ddu-preferred', 'EU'],
  ['c03', 'pacificline', 'ddp-preferred', 'APAC'],
  ['c04', 'intercargo', 'ddu-preferred', 'AMER'],
  ['c05', 'railfreight', 'ddp-preferred', 'EU'],
  ['c06', 'seaway', 'ddu-preferred', 'APAC'],
  ['c07', 'airbridge', 'ddp-preferred', 'AMER'],
  ['c08', 'citycourier', 'ddu-preferred', 'EU'],
  ['c09', 'lastmile-plus', 'ddp-preferred', 'APAC'],
  ['c10', 'parcelpoint', 'ddu-preferred', 'AMER'],
];

/** Carrier hints in export order (used by the bridge config generator). */
export function carrierHints() {
  return CARRIER_HINTS.map(([id, name, incoterm, zone]) => ({ id, name, incoterm, zone }));
}

/** Carriers that prefer DDP, sorted by name. */
export function ddpCarriers() {
  return CARRIER_HINTS.filter(([, , incoterm]) => incoterm === 'ddp-preferred')
    .map(([, name]) => name).sort();
}

/** Carriers grouped by zone with counts (bridge sidebar). */
export function carriersByZone() {
  const zones = new Map();
  for (const [id, name, incoterm, zone] of CARRIER_HINTS) {
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push({ id, name, incoterm });
  }
  return [...zones.entries()].map(([zone, carriers]) => ({ zone, count: carriers.length, carriers }));
}

// Formatting hints per logical type; the bridge renders accordingly.
const FORMAT_HINTS = {
  weight_kg: { unit: 'kg', decimals: 2 },
  declared_value: { unit: 'EUR', decimals: 2 },
  insurance_value: { unit: 'EUR', decimals: 2 },
  carbon_estimate_g: { unit: 'g', decimals: 0 },
  volume_m3: { unit: 'm3', decimals: 3 },
  loading_meter: { unit: 'LDM', decimals: 2 },
  sla_hours: { unit: 'h', decimals: 1 },
  dwell_hours: { unit: 'h', decimals: 1 },
  handover_hours: { unit: 'h', decimals: 1 },
  customs_hold_hours: { unit: 'h', decimals: 1 },
  weather_delay_hours: { unit: 'h', decimals: 1 },
  strike_delay_hours: { unit: 'h', decimals: 1 },
  inspection_hours: { unit: 'h', decimals: 1 },
  height_cm: { unit: 'cm', decimals: 0 },
  length_cm: { unit: 'cm', decimals: 0 },
  width_cm: { unit: 'cm', decimals: 0 },
};

export function formatHint(column) {
  return FORMAT_HINTS[column] ?? null;
}

export function formattedHints() {
  return Object.entries(FORMAT_HINTS).map(([column, hint]) => ({ column, ...hint }));
}

/** Round a numeric field per its format hint (null-safe). */
export function formatValue(column, value) {
  const hint = FORMAT_HINTS[column];
  if (!hint || value === undefined || value === null || value === '') return value;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return value;
  return numeric.toFixed(hint.decimals);
}

/** Apply format hints across a row (returns a new object). */
export function formatRow(row) {
  const out = { ...row };
  for (const column of Object.keys(out)) out[column] = formatValue(column, out[column]);
  return out;
}

/** Header + footer lines for the fixed-width ops printout. */
export function printHeader(title = 'order-export') {
  const line = '='.repeat(Math.max(8, title.length + 8));
  return [line, `== ${title}`, line].join('\r\n');
}

export function printFooter(rows) {
  return ['='.repeat(24), `rows=${rows?.length ?? 0}`, 'layout=warehouse-bridge/v2'].join('\r\n');
}

/** Deterministic sample rows for the exporter smoke test. */
export function sampleRows(count = 3) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const index = i + 1;
    rows.push({
      order_id: `ord-${String(index).padStart(4, '0')}`,
      region: ['EU', 'APAC', 'AMER'][i % 3],
      site: ['north-warehouse', 'harbor-terminal', 'west-warehouse'][i % 3],
      zone: ['EU', 'APAC', 'AMER'][i % 3],
      lane: ['standard', 'express', 'freight'][i % 3],
      day: DAY_NAME(i),
      state: ['created', 'paid', 'shipped'][i % 3],
      version: index,
      weight_kg: 2.5 * index,
      pieces: index,
      courier_notes: index % 2 ? 'leave "at reception", quietly' : 'ring twice',
    });
  }
  return rows;
}

function DAY_NAME(index) {
  const names = ['d00-open', 'd01-normal', 'd02-normal', 'd03-peak', 'd04-normal', 'd05-normal', 'd06-close'];
  return names[index % names.length];
}

/** Export preview: first N rows as CSV, truncated body for UI. */
export function preview(rows, n = 5) {
  const head = toCsv((rows ?? []).slice(0, n));
  const totalRows = rows?.length ?? 0;
  return { head, truncated: totalRows > n, totalRows };
}

/** Byte size of the full export (upload planning). */
export function exportBytes(rows) {
  return Buffer.byteLength(toCsv(rows), 'utf8');
}

/** Stable hash over the header layout (cache key for consumers). */
export function layoutHash() {
  let hash = 0;
  for (const column of COLUMNS) hash = ((hash * 33) ^ column.length) >>> 0;
  return `wl2-${hash.toString(16)}`;
}

/** Column groups for the wizard UI. */
const COLUMN_GROUPS = [
  ['identity', ['order_id', 'region', 'site', 'zone', 'lane', 'day']],
  ['lifecycle', ['state', 'version', 'created_at', 'paid_at', 'shipped_at', 'delivered_at']],
  ['measurements', ['weight_kg', 'gross_weight_kg', 'net_weight_kg', 'tare_weight_kg', 'pieces', 'pallets', 'volume_m3']],
  ['customs', ['export_license', 'hs_code', 'origin_country', 'destination_country', 'incoterm', 'customs_cleared', 'duties_paid', 'vat_number', 'eori_number']],
  ['transport', ['carrier', 'route_code', 'leg_count', 'final_mile', 'vehicle_id', 'trailer_id', 'seal_number']],
  ['quality', ['sla_hours', 'sla_breached', 'dwell_hours', 'handover_hours', 'delivery_attempts', 'pod_captured']],
];

export function columnGroups() {
  return COLUMN_GROUPS.map(([group, columns]) => ({
    group,
    columns: columns.filter(column => COLUMNS.includes(column)),
  }));
}

/** Ungrouped columns (should stay empty — layout drift detector). */
export function ungroupedColumns() {
  const grouped = new Set(COLUMN_GROUPS.flatMap(([, columns]) => columns));
  return COLUMNS.filter(column => !grouped.has(column));
}

/** Full self-check used by the exporter's smoke test. */
export function selfCheck() {
  const rows = sampleRows(3);
  const restored = roundTrip(rows);
  // CSV round-trips stringify numbers; compare the string-stable fields.
  const roundTripOk = restored.length === rows.length
    && rows.every((row, index) => row.order_id === restored[index].order_id
      && row.courier_notes === restored[index].courier_notes
      && row.lane === restored[index].lane);
  return {
    roundTrip: roundTripOk,
    columns: columnCount(),
    layoutHash: layoutHash(),
    ungrouped: ungroupedColumns().length,
  };
}
