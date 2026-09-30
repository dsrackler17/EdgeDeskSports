#!/usr/bin/env node
/* ===========================================================================
   THE P&L LEDGER → Supabase (supabase/model_pnl.sql, model_pnl_analytics.sql).

   The committed ledger (record/pnl/ledger_<season>.json, tools/record/
   pnl_ledger.js) stays the page's source. This is the durable, queryable
   copy: every row goes through model_pnl_upsert(), which inserts a new
   recommendation, updates a settlement that moved (logging a correction when
   the row had already settled) and leaves the rest alone — so running it
   twice writes nothing twice. A row the database refuses (a recommendation
   that would be rewritten) is printed and the rest still land.

   Without SB_URL / SB_SERVICE_ROLE (EDGD_SB_URL / EDGD_SB_SERVICE) it logs
   and exits 0: the page never depends on this.

     node tools/record/pnl_sync.js [--season 2026] [--dry-run] [--chunk 200]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PGR = require(path.join(ROOT, 'tools', 'lib', 'pgrest.js'));

function seasonOf(ms) { const d = new Date(ms); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

/* the ledger rows as the table takes them (page-only words dropped) */
function tableRows(L) {
  return ((L && L.rows) || []).map((x) => {
    const r = Object.assign({}, x);
    ['pnl_note', 'pnl_eligible', 'first_recorded_at', 'source_missing', 'entry_book_name', 'prop_category_label', 'odds_captured_basis', 'result_detail', 'model_gap_points', 'stage'].forEach((k) => { delete r[k]; });
    return r;
  });
}
async function sync(o) {
  const L = o.ledger || JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'pnl', 'ledger_' + o.season + '.json'), 'utf8'));
  const rows = tableRows(L);
  const out = { rows: rows.length, inserted: 0, updated: 0, unchanged: 0, refused: [] };
  const size = o.chunk || 200;
  for (let i = 0; i < rows.length; i += size) {
    const res = await o.db.rpc('public', 'model_pnl_upsert', { p_rows: rows.slice(i, i + size) });
    if (res && typeof res === 'object') {
      out.inserted += res.inserted || 0; out.updated += res.updated || 0; out.unchanged += res.unchanged || 0;
      (res.refused || []).forEach((x) => out.refused.push(x));
    }
  }
  try { await o.db.rpc('public', 'model_pnl_refresh', {}); out.refreshed = true; } catch (e) { out.refreshed = false; out.refresh_error = String(e.message || e).slice(0, 160); }
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('season', seasonOf(Date.now())));
  const f = path.join(ROOT, 'record', 'pnl', 'ledger_' + season + '.json');
  if (!fs.existsSync(f)) { console.log('[pnl sync] no ledger for ' + season + ' (' + path.relative(ROOT, f) + '): nothing to send'); return 0; }
  if (a.indexOf('--dry-run') >= 0) {
    const r = await sync({ season, chunk: Number(arg('chunk', 200)), db: { rpc: async () => ({ inserted: 0, updated: 0, unchanged: 0, refused: [] }) } });
    console.log('[pnl sync] dry run, nothing written — would send ' + r.rows + ' rows (credentials ' + (PGR.config() ? 'present' : 'absent') + ')');
    return 0;
  }
  const cfg = PGR.config();
  if (!cfg) { console.log('[pnl sync] SB_URL / SB_SERVICE_ROLE are not set: nothing written (the page reads record/pnl/)'); return 0; }
  try {
    const r = await sync({ season, chunk: Number(arg('chunk', 200)), db: PGR.client(cfg) });
    console.log('[pnl sync] ' + season + ': ' + r.rows + ' rows · inserted ' + r.inserted + ' · updated ' + r.updated + ' · unchanged ' + r.unchanged + ' · refused ' + r.refused.length + (r.refreshed ? ' · daily series refreshed' : ' · daily series not refreshed (' + (r.refresh_error || '') + ')'));
    r.refused.slice(0, 20).forEach((x) => console.log('  ✗ ' + x.recommendation_id + ': ' + x.error));
    return 0;
  } catch (e) {
    console.log('[pnl sync] ' + String(e.message || e).slice(0, 300) + ' — apply supabase/model_pnl.sql and model_pnl_analytics.sql');
    return 0;
  }
}

module.exports = { sync, tableRows };
if (require.main === module) main().then((c) => process.exit(c || 0));
