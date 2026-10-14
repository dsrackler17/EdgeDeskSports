'use strict';
/* ===========================================================================
   The data pack's tables, hash-verified, with their provenance.

   read(table, spec) checks the file's SHA-256 against sources/inventory.json
   (delivered_sha256) and its row count, then reads the requested columns. A
   mismatch throws: source releases change and a changed file needs an
   explicit version review, never a silent reload.

   PROVENANCE collects, for every table read in this run: file, rows, hash,
   source release (URL, tag, release-asset hash, release update time, pack
   retrieval time) and observed_at (the date this repository imported the
   pack). known_at stays null: first publication is not in the pack.
   =========================================================================== */
const fs = require('fs');
const crypto = require('crypto');
const C = require('../config');
const T = require('./table');

let MAN = null;
function manifests() {
  if (!MAN) {
    const imp = C.PATHS.packFile('IMPORT.json');
    MAN = {
      inventory: JSON.parse(fs.readFileSync(C.PATHS.packFile('sources/inventory.json'), 'utf8')),
      assets: JSON.parse(fs.readFileSync(C.PATHS.packFile('sources/source_assets.json'), 'utf8')),
      import: fs.existsSync(imp) ? JSON.parse(fs.readFileSync(imp, 'utf8')) : { imported_at: null },
    };
  }
  return MAN;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const PROVENANCE = [];
const VERIFIED = new Map();

function verify(table) {
  if (VERIFIED.has(table)) return VERIFIED.get(table);
  const m = manifests();
  const row = m.inventory.find((r) => r.table === table);
  if (!row) throw new Error('table not in the pack inventory: ' + table);
  const got = sha256(C.PATHS.data(table));
  if (got !== row.delivered_sha256) {
    throw new Error(`HASH MISMATCH for ${table}: inventory ${row.delivered_sha256}, file ${got}. Stop: the pack changed and needs an explicit version review.`);
  }
  const asset = row.source_asset ? m.assets.find((a) => a.asset === row.source_asset && a.tag === row.source_tag) : null;
  const p = {
    table, file: 'datapack/ncaam_v1/' + row.file, rows: row.rows, sha256: got,
    source: asset
      ? { url: asset.url, release_tag: asset.tag, release_asset_sha256: asset.download_sha256, published_updated_at: asset.published_updated_at, retrieved_at: asset.retrieved_at }
      : { derived_by: 'data pack (measured, lagged, bridge or audit table built by the pack author)', url: null },
    observed_at: m.import.imported_at || null,
    known_at: null,
  };
  VERIFIED.set(table, p); PROVENANCE.push(p);
  return p;
}

async function read(table, spec) {
  verify(table);
  const t = await T.readTable(C.PATHS.data(table), spec);
  const want = manifests().inventory.find((r) => r.table === table).rows;
  if (t.n !== want) throw new Error(`${table}: read ${t.n} rows, inventory says ${want}`);
  return t;
}

module.exports = { read, verify, PROVENANCE, manifests, sha256 };
