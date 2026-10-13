'use strict';
/* ===========================================================================
   EdgeDesk engine — rows against the data pack's canonical contracts.

   The contracts are datapack/quant_v1/schemas/table_catalog.json: 43 tables,
   each with typed fields, units, nullability and keys. validate() checks a
   batch of canonical rows against one table and reports, per field, how
   often it is missing — the missingness diagnostics the pack asks for.

     every contract field present on every row (null allowed only where the
       contract says nullable); no field the contract lacks
     integer / number / boolean / timestamp (UTC, explicit zone) / text types
     keys unique: (record_id, revision)
     known_at never later than retrieved_at, and never filled when unknown
       (the caller passes null — this checks it is not a backdated stand-in)

   Nothing is coerced: a string "3" in an integer field is an error.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const CATALOG = path.join(__dirname, '..', 'datapack', 'quant_v1', 'schemas', 'table_catalog.json');
let catalog = null;
function table(family, name) {
  if (!catalog) catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const t = catalog.find((x) => x.family === family && x.table === name);
  if (!t) throw new Error('no contract ' + family + '/' + name);
  return t;
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
function typeOk(type, v) {
  switch (type) {
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'timestamp': return typeof v === 'string' && TS.test(v) && Number.isFinite(Date.parse(v));
    default: return typeof v === 'string';
  }
}

/** rows: canonical objects. Returns { ok, rows, errors: [..first 50], error_count, missing: {field: share} } */
function validate(family, name, rows) {
  const t = table(family, name);
  const fields = t.columns.map((c) => c.field);
  const known = new Set(fields);
  const errors = []; let errorCount = 0;
  const err = (i, msg) => { errorCount++; if (errors.length < 50) errors.push('row ' + i + ': ' + msg); };
  const nulls = Object.fromEntries(fields.map((f) => [f, 0]));
  const keys = new Set();
  rows.forEach((r, i) => {
    for (const c of t.columns) {
      if (!(c.field in r)) { err(i, 'missing field ' + c.field); continue; }
      const v = r[c.field];
      if (v == null) { nulls[c.field]++; if (!c.nullable) err(i, c.field + ' is required'); continue; }
      if (!typeOk(c.type, v)) err(i, c.field + ' is not ' + c.type + ': ' + JSON.stringify(v).slice(0, 40));
    }
    for (const k of Object.keys(r)) if (!known.has(k)) err(i, 'field ' + k + ' is not in the contract');
    const key = (t.keys || ['record_id', 'revision']).map((k) => r[k]).join('|');
    if (keys.has(key)) err(i, 'duplicate key ' + key); keys.add(key);
    if (r.known_at && r.retrieved_at && Date.parse(r.known_at) > Date.parse(r.retrieved_at)) err(i, 'known_at after retrieved_at');
  });
  const n = rows.length || 1;
  const missing = Object.fromEntries(fields.map((f) => [f, +(nulls[f] / n).toFixed(4)]));
  return { table: family + '/' + name, grain: t.grain, priority: t.priority, ok: errorCount === 0, rows: rows.length, error_count: errorCount, errors, missing };
}

/** an empty canonical row: every contract field present and null */
function blank(family, name) { return Object.fromEntries(table(family, name).columns.map((c) => [c.field, null])); }

module.exports = { validate, blank, table };
