#!/usr/bin/env node
/* ===========================================================================
   THE P&L LEDGER → Supabase (supabase/model_pnl.sql, model_pnl_states.sql,
   model_pnl_analytics.sql, model_pnl_verified.sql, model_pnl_quotes.sql,
   model_pnl_verified_views.sql).

   The committed ledger (record/pnl/ledger_<season>.json, tools/record/
   pnl_ledger.js) stays the page's source. This is the durable, queryable
   copy: every row goes through model_pnl_upsert(), which inserts a new
   recommendation, updates a settlement that moved (logging a correction when
   the row had already settled) and leaves the rest alone — so running it
   twice writes nothing twice. A row the database refuses (a recommendation
   that would be rewritten) is printed and the rest still land. Then every
   row's pending reason (and an INVALID verdict the build made) goes through
   model_pnl_reasons(), which touches only the rows whose reason moved; the
   table derives each row's one state itself (model_pnl_states.sql).

   Every stored quote a locked price cites goes first, through
   model_pnl_quotes_put() (append-only evidence). Last, THE DATABASE MUST SAY
   WHAT THE PAGE SAYS: verified_pnl_summary() against the kernel's card over the
   same ledger, both strategies, and verified_pnl_integrity() at 0.

   Without SB_URL / SB_SERVICE_ROLE (EDGD_SB_URL / EDGD_SB_SERVICE) it logs
   and exits 0: the page never depends on this. With them it never fails
   quietly: a missing schema exits 3, a database that disagrees with the page
   exits 4, each with a GitHub annotation and a line in the run summary.

     node tools/record/pnl_sync.js [--season 2026] [--dry-run] [--chunk 200]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PGR = require(path.join(ROOT, 'tools', 'lib', 'pgrest.js'));
const PL = require('./price_lock.js');
const PNL = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));

function seasonOf(ms) { const d = new Date(ms); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

/* the ledger rows as the table takes them (page-only words dropped) */
function tableRows(L) {
  return ((L && L.rows) || []).map((x) => {
    const r = Object.assign({}, x);
    ['pnl_note', 'pnl_eligible', 'first_recorded_at', 'source_missing', 'entry_book_name', 'prop_category_label', 'odds_captured_basis', 'result_detail', 'model_gap_points', 'stage'].forEach((k) => { delete r[k]; });
    return r;
  });
}
/* the build's pending reasons and INVALID verdicts, one small row each */
function reasonRows(L) {
  return ((L && L.rows) || []).map((x) => ({ recommendation_id: x.recommendation_id, pending_reason: x.pending_reason || null,
    record_state: x.record_state || null, state_reason: x.record_state === 'INVALID' ? x.state_reason || null : null }));
}
/* the stored quotes the ledger's locked prices cite (price_ref), from the
   committed quote ledgers, for model_pnl_quotes */
function citedQuotes(L, root, season) {
  const refs = ((L && L.rows) || []).filter((x) => x.price_source === 'snapshot' && x.price_ref && x.price_ref.quote_id)
    .map((x) => ({ source: x.price_ref.source, quote_id: x.price_ref.quote_id }));
  return PL.evidence(root || ROOT, season, refs);
}
/* the database is missing a function or table this sync needs */
function schemaMissing(e) {
  const m = String((e && e.message) || e || '');
  return (e && (e.code === 'PGRST202' || e.code === '42883' || e.code === '42P01' || e.code === 'PGRST205')) || /PGRST202|PGRST205|Could not find the function|does not exist/.test(m);
}

async function sync(o) {
  const L = o.ledger || JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'pnl', 'ledger_' + o.season + '.json'), 'utf8'));
  const rows = tableRows(L);
  const out = { rows: rows.length, inserted: 0, updated: 0, price_locked: 0, unchanged: 0, refused: [] };
  const size = o.chunk || 200;
  /* the evidence first: every stored quote a locked price cites, so the rows that cite it can be checked against it */
  const ev = citedQuotes(L, o.root, o.season || L.season);
  out.quotes = { cited: ev.rows.length + ev.missing.length, sent: ev.rows.length, inserted: 0, unchanged: 0, refused: [], not_found: ev.missing };
  for (let i = 0; i < ev.rows.length; i += size) {
    const res = await o.db.rpc('public', 'model_pnl_quotes_put', { p_rows: ev.rows.slice(i, i + size) });
    if (res && typeof res === 'object') { out.quotes.inserted += res.inserted || 0; out.quotes.unchanged += res.unchanged || 0; (res.refused || []).forEach((x) => out.quotes.refused.push(x)); }
  }
  for (let i = 0; i < rows.length; i += size) {
    const res = await o.db.rpc('public', 'model_pnl_upsert', { p_rows: rows.slice(i, i + size) });
    if (res && typeof res === 'object') {
      out.inserted += res.inserted || 0; out.updated += res.updated || 0; out.unchanged += res.unchanged || 0; out.price_locked += res.price_locked || 0;
      (res.refused || []).forEach((x) => out.refused.push(x));
    }
  }
  /* why pending, from the build; a database without model_pnl_states.sql says so and the rest stands */
  out.reasons_updated = 0;
  try {
    const why = reasonRows(L);
    for (let i = 0; i < why.length; i += size) {
      const res = await o.db.rpc('public', 'model_pnl_reasons', { p_rows: why.slice(i, i + size) });
      out.reasons_updated += (res && res.updated) || 0;
    }
    out.reasons = true;
  } catch (e) { out.reasons = false; out.reasons_error = String(e.message || e).slice(0, 160); }
  try { await o.db.rpc('public', 'model_pnl_refresh', {}); out.refreshed = true; } catch (e) { out.refreshed = false; out.refresh_error = String(e.message || e).slice(0, 160); }
  out.parity = await parity(o.db, L);
  return out;
}

/* THE DATABASE MUST SAY WHAT THE PAGE SAYS. The page's card is the kernel's
   (lib/edgedesk_pnl.js verifiedCard) over the committed ledger; the database's
   is verified_pnl_summary() over the rows just sent. Both strategies, every
   headline number, and every integrity check at 0. */
const PARITY_FIELDS = [['graded_decisions', 'graded'], ['total_verified_bets', 'n'], ['record_only_decisions', 'record_only'], ['wins', 'wins'], ['losses', 'losses'],
  ['pushes', 'pushes'], ['net_units', 'net_units'], ['units_risked', 'risked_units'], ['roi_percent', 'roi_pct']];
/* one season's games (March through February, as seasonOf counts them): the
   table keeps every season, the ledger is one */
function seasonWindow(season) {
  const y = Number(season);
  if (!Number.isFinite(y)) return null;
  return { from: y + '-03-01', to: new Date(Date.UTC(y + 1, 2, 0)).toISOString().slice(0, 10) };
}
async function parity(db, L) {
  const W = seasonWindow(L && L.season);
  const inWindow = (x) => { if (!W) return true; const d = String(x.game_date || '').slice(0, 10); return !!d && d >= W.from && d <= W.to; };
  const rows = ((L && L.rows) || []).filter((x) => (x.evaluation_mode === 'LIVE' || x.evaluation_mode === 'LIVE_RECONSTRUCTED') && inWindow(x));
  const out = { ok: true, diffs: [], integrity: [], window: W };
  for (const mode of ['staked', 'flat']) {
    const c = PNL.verifiedCard(rows, mode);
    const res = await db.rpc('public', 'verified_pnl_summary', W ? { p_mode: mode, p_from: W.from, p_to: W.to } : { p_mode: mode });
    const s = Array.isArray(res) ? res[0] : res;
    PARITY_FIELDS.forEach(([dk, kk]) => {
      const a = s ? s[dk] : undefined, b = c[kk];
      const same = (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);
      if (!same) { out.ok = false; out.diffs.push({ mode, field: dk, database: a === undefined ? null : a, page: b }); }
    });
  }
  const I = await db.rpc('public', 'verified_pnl_integrity', {});
  (Array.isArray(I) ? I : []).forEach((x) => { if (x.severity === 'error' && Number(x.failures) > 0) { out.ok = false; out.integrity.push({ check: x.check_key, label: x.label, failures: Number(x.failures) }); } });
  return out;
}

/* a GitHub Actions annotation and a line in the run's summary, so a database
   that is not doing its job is seen, not buried in a green log */
function shout(level, msg) {
  console.log('::' + level + ' title=Record P&L database::' + msg.replace(/\r?\n/g, ' '));
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { fs.appendFileSync(f, '### Record P&L database\n\n' + (level === 'error' ? '**Not in sync.** ' : '') + msg + '\n\n'); } catch (_) { /* no summary file */ } }
}
const APPLY = 'apply supabase/model_pnl.sql, model_pnl_states.sql, model_pnl_analytics.sql, model_pnl_verified.sql, model_pnl_quotes.sql and model_pnl_verified_views.sql, in that order (the "Deploy Record P&L schema" workflow does it)';
/* exit codes: 0 in sync (or no credentials: the page never depends on this), 3 the schema is missing, 4 the database disagrees with the page */
const EXIT = { OK: 0, SCHEMA: 3, PARITY: 4 };

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('season', seasonOf(Date.now())));
  const f = path.join(ROOT, 'record', 'pnl', 'ledger_' + season + '.json');
  if (!fs.existsSync(f)) { console.log('[pnl sync] no ledger for ' + season + ' (' + path.relative(ROOT, f) + '): nothing to send'); return EXIT.OK; }
  if (a.indexOf('--dry-run') >= 0) {
    const L = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ev = citedQuotes(L, ROOT, season);
    console.log('[pnl sync] dry run, nothing written — would send ' + tableRows(L).length + ' rows and ' + ev.rows.length + ' cited quotes'
      + (ev.missing.length ? ' (' + ev.missing.length + ' cited quotes NOT FOUND in the committed quote ledgers)' : '') + ' (credentials ' + (PGR.config() ? 'present' : 'absent') + ')');
    return ev.missing.length ? EXIT.PARITY : EXIT.OK;
  }
  const cfg = PGR.config();
  if (!cfg) { console.log('[pnl sync] SB_URL / SB_SERVICE_ROLE are not set: nothing written (the page reads record/pnl/)'); return EXIT.OK; }
  let r;
  try {
    r = await sync({ season, chunk: Number(arg('chunk', 200)), db: PGR.client(cfg) });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    if (schemaMissing(e)) { shout('error', 'The Verified P&L schema is not in the database (' + msg + '). Nothing was copied — ' + APPLY + '.'); return EXIT.SCHEMA; }
    shout('error', 'The sync failed: ' + msg);
    return EXIT.PARITY;
  }
  console.log('[pnl sync] ' + season + ': ' + r.rows + ' rows · inserted ' + r.inserted + ' · updated ' + r.updated + ' · prices locked ' + r.price_locked + ' · unchanged ' + r.unchanged + ' · refused ' + r.refused.length
    + ' · cited quotes ' + r.quotes.sent + ' (new ' + r.quotes.inserted + ', refused ' + r.quotes.refused.length + ', not found ' + r.quotes.not_found.length + ')'
    + (r.reasons ? ' · pending reasons moved on ' + r.reasons_updated : ' · pending reasons not sent (' + (r.reasons_error || '') + ' — apply supabase/model_pnl_states.sql)')
    + (r.refreshed ? ' · daily series refreshed' : ' · daily series not refreshed (' + (r.refresh_error || '') + ')'));
  r.refused.slice(0, 20).forEach((x) => console.log('  ✗ ' + x.recommendation_id + ': ' + x.error));
  r.quotes.refused.slice(0, 10).forEach((x) => console.log('  ✗ quote ' + x.quote_id + ': ' + x.error));
  r.quotes.not_found.slice(0, 10).forEach((x) => console.log('  ✗ quote ' + x.source + ' ' + x.quote_id + ': cited by a locked price, not in the committed quote ledger'));
  /* a database still on the pre-Verified-P&L trigger refuses every price lock and every default stake */
  const oldSchema = r.refused.some((x) => /stake_valid|is part of the recommendation and is frozen|stake_source|price_source/.test(x.error));
  if (oldSchema) shout('error', 'The database refuses price locks: it is on the pre-Verified-P&L trigger — ' + APPLY + '.');
  const P = r.parity;
  P.diffs.forEach((d) => console.log('  ✗ ' + d.mode + ' ' + d.field + ': database ' + JSON.stringify(d.database) + ' · page ' + JSON.stringify(d.page)));
  P.integrity.forEach((d) => console.log('  ✗ integrity ' + d.check + ' (' + d.label + '): ' + d.failures));
  const bad = !P.ok || r.refused.length || r.quotes.refused.length || r.quotes.not_found.length;
  if (bad) {
    shout('error', 'The database does not match the Record page: ' + P.diffs.length + ' headline difference' + (P.diffs.length === 1 ? '' : 's') + ', ' + P.integrity.length + ' failed integrity check'
      + (P.integrity.length === 1 ? '' : 's') + ', ' + r.refused.length + ' refused row' + (r.refused.length === 1 ? '' : 's') + ', ' + (r.quotes.refused.length + r.quotes.not_found.length) + ' cited quote problem'
      + (r.quotes.refused.length + r.quotes.not_found.length === 1 ? '' : 's') + '. See the log above.');
    return oldSchema ? EXIT.SCHEMA : EXIT.PARITY;
  }
  console.log('[pnl sync] the database matches the page: verified_pnl_summary = the Record card (staked and flat), every integrity check 0');
  return EXIT.OK;
}

module.exports = { sync, parity, seasonWindow, tableRows, reasonRows, citedQuotes, schemaMissing, EXIT };
if (require.main === module) main().then((c) => process.exit(c || 0));
