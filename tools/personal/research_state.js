#!/usr/bin/env node
/* ============================================================================
   THE PERSONAL-RESEARCH JOB — the slate's research state, the research-
   condition alerts, the journal's close and grade, and the affiliate ledger's
   reconcile, in one pass.

     node tools/personal/research_state.js --network        # the scheduled run
     node tools/personal/research_state.js --network --dry  # compute, write nothing
     node tools/personal/research_state.js --only states|alerts|grade|affiliates

   1  THE STATE. Boots the REAL football module headlessly (tools/articles/
      research_host.js — the same host the article generator uses) and asks it
      for window.fbResearchStates(): one edgedesk_research_state/1 object per
      upcoming game, built by the board's own readers. Nothing here computes a
      projection, a line, a probability or a reliability score. The board reads
      the captured market through a READ-ONLY sbFetch this job supplies: GET
      only, on the capture tables only, under the service role. Without the
      service role it reads the committed market snapshot, as the article
      generator does, and says so.
   2  THE SHARED TABLE. Each state is upserted into public.game_research_state.
      A game that has kicked off is NEVER rewritten: its last pregame state is
      the close the journal is graded against. The history row is appended by
      the database's own trigger, only when the state hash changes.
   3  ALERTS. For every game whose state changed, the readers watching it (and
      readers who asked for league-wide threshold alerts) get the changes they
      asked for, worded by lib/edgedesk_personal.js. A (reader, dedupe key)
      unique constraint absorbs a repeat, a per-(reader, game, kind) cooldown
      stops flapping, and no reader gets more than 25 alerts from one run.
   4  THE JOURNAL. Wagered entries whose game has kicked off get the close
      (the last market EdgeDesk held before kickoff, from the state history;
      the committed record's consensus close when the history has none), CLV,
      and — once record/football/<league>_<season>.json carries the final —
      the result. Process and result are separate columns.
   5  AFFILIATES. public.affiliate_reconcile() replays the Stripe ledger
      idempotently, where supabase/affiliates.sql is installed.

   It spends no odds-provider credit: it reads captured quotes only.

   ENVIRONMENT (GitHub Actions secrets; never a browser)
     SB_URL / SUPABASE_URL                       the project URL
     SB_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY the service role
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const HOST = require(path.join(ROOT, 'tools', 'articles', 'research_host.js'));
const EDP = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const DRY = !!arg('dry', false);
const NETWORK = !!arg('network', false);
const ONLY = arg('only', null);
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.log(...a); };
const want = (k) => !ONLY || ONLY === true || String(ONLY).split(',').indexOf(k) >= 0;

const SB_URL = (process.env.SB_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const HAVE_DB = !!(SB_URL && SB_KEY);

/* ------------------------------------------------------------ the database
   One adapter, four calls. The CLI's talks to PostgREST with the service
   role; tools/personal/research_state.test.js hands in the repo's in-memory
   PostgREST stand-in (tools/lib/fake_pgrest.js) so every write this job makes
   is exercised without a project. */
function hdr(extra) {
  return Object.assign({ apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' }, extra || {});
}
async function dbGet(q, profile) {
  const r = await fetch(SB_URL + '/rest/v1/' + q, { headers: hdr(profile ? { 'accept-profile': profile } : null) });
  if (!r.ok) { const e = new Error('db ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
  return r.json();
}
async function dbPost(table, rows, prefer, onConflict) {
  if (DRY) return true;
  const r = await fetch(SB_URL + '/rest/v1/' + table + (onConflict ? '?on_conflict=' + onConflict : ''), {
    method: 'POST', headers: hdr({ prefer: prefer || 'return=minimal' }), body: JSON.stringify(rows) });
  if (!r.ok) { const e = new Error('write ' + table + ' ' + r.status + ' ' + (await r.text()).slice(0, 300)); e.status = r.status; throw e; }
  return true;
}
async function dbPatch(table, query, row) {
  if (DRY) return true;
  const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query, { method: 'PATCH', headers: hdr({ prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error('patch ' + table + ' ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return true;
}
async function dbRpc(fn, args) {
  if (DRY) return null;
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: hdr(), body: JSON.stringify(args || {}) });
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw new Error('rpc ' + fn + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
const HTTP_DB = { get: dbGet, post: dbPost, patch: dbPatch, rpc: dbRpc };
let DB = HTTP_DB;
function inList(keys) { return 'in.(' + keys.map((k) => '"' + String(k).replace(/"/g, '') + '"').join(',') + ')'; }
function chunks(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

/* The board's own reader, read-only. The football module calls sbFetch/sbGet
   for exactly these: captured quotes (signals), per-book quotes, and the cfb
   schema's lines and games. Anything else — any write, any other table — is
   refused, so the service role cannot reach further than the page can. */
const READ_ALLOW = [/^signals\?/, /^book_quotes\?/, /^lines\?/, /^games\?/];
function makeReader(notes) {
  function sbFetch(q, extra) {
    q = String(q || '');
    const profile = extra && extra['accept-profile'];
    if (!HAVE_DB) return Promise.reject(Object.assign(new Error('db 401'), { status: 401 }));
    if (!READ_ALLOW.some((rx) => rx.test(q)) || (profile && profile !== 'cfb')) {
      notes.refused_reads.push(q.slice(0, 60));
      return Promise.reject(Object.assign(new Error('db 403'), { status: 403 }));
    }
    notes.reads++;
    return HTTP_DB.get(q, profile || null);
  }
  return { sbFetch: sbFetch, sbGet: (q) => sbFetch(q, null) };
}

/* ------------------------------------------------------------ 1. states */
async function buildStates() {
  const notes = { reads: 0, refused_reads: [] };
  const reader = makeReader(notes);
  const host = await HOST.open({ network: NETWORK, quiet: QUIET, globals: reader });
  const win = host.win;
  /* the optional joins the loaders end in (weather, starters, reliability
     artifacts) settle in the background; give them the same grace the
     research host gives the P4 load */
  for (let i = 0; i < 60 && !(win.FB.at && win.FB.p4 && (win.FB.p4.loadedAt || win.FB.p4.engineErr)); i++) await new Promise((r) => setTimeout(r, 1000));
  ['lib/research_core.js', 'lib/research_eval.js', 'lib/game_research.js', 'lib/research_priority.js', 'lib/edgedesk_personal.js'].forEach((f) => {
    win.module = undefined;
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  });
  if (typeof win.fbResearchStates !== 'function') throw new Error('app.html does not export window.fbResearchStates');
  const res = win.fbResearchStates();
  const now = Date.now();
  /* re-normalised by THIS process's copy of the library, so the hash the
     database stores is the hash every other reader computes */
  const states = res.states.map((s) => EDP.normalizeState(JSON.parse(JSON.stringify(s)))).filter(Boolean)
    .filter((s) => { const k = Date.parse(s.kickoff_at); return isFinite(k) && k > now; });
  log('  states: ' + states.length + ' upcoming (' + res.states.length + ' on the boards) · layer ' + (res.layer_ready ? 'ready' : 'NOT READY')
    + ' · NFL ' + (res.nfl_loaded ? 'loaded' : 'not loaded') + ' · CFB ' + (res.cfb_loaded ? 'loaded' : 'not loaded'));
  log('  market: ' + (HAVE_DB ? notes.reads + ' live reads of the capture tables' : 'no database credentials — the committed market snapshot (' + host.notes.market_snapshots + ' games) stands in'));
  return { states, notes, host, res };
}

async function writeStates(states) {
  const prev = {};
  for (const part of chunks(states.map((s) => s.game_key), 80)) {
    const rows = await DB.get('game_research_state?select=game_key,state,state_hash,kickoff_at&game_key=' + inList(part));
    rows.forEach((r) => { prev[r.game_key] = r; });
  }
  const changed = [];
  const rows = [];
  states.forEach((s) => {
    const p = prev[s.game_key];
    /* a game already under way keeps its last pregame state */
    if (p && p.kickoff_at && Date.parse(p.kickoff_at) <= Date.now()) return;
    if (p && p.state_hash !== s.state_hash) changed.push({ prev: p.state, cur: s });
    rows.push(EDP.stateRow(s));
  });
  for (const part of chunks(rows, 50)) await DB.post('game_research_state', part, 'return=minimal,resolution=merge-duplicates', 'game_key');
  log('  wrote ' + rows.length + ' states · ' + changed.length + ' changed since the last run' + (DRY ? ' (dry: nothing written)' : ''));
  return changed;
}

/* ------------------------------------------------------------ 3. alerts */
async function sendAlerts(changed) {
  if (!changed.length) { log('  alerts: no state changed'); return { created: 0 }; }
  const keys = changed.map((c) => c.cur.game_key);
  const watchers = [];
  for (const part of chunks(keys, 80)) (await DB.get('watchlist_games?select=user_id,game_key&game_key=' + inList(part))).forEach((w) => watchers.push(w));
  const leagueUsers = await DB.get('alert_preferences?select=*&scope=eq.leagues&enabled=is.true').catch(() => []);
  const userIds = [...new Set(watchers.map((w) => w.user_id).concat(leagueUsers.map((u) => u.user_id)))];
  const prefs = {}, leagues = {};
  for (const part of chunks(userIds, 80)) {
    if (!part.length) continue;
    (await DB.get('alert_preferences?select=*&user_id=' + inList(part))).forEach((p) => { prefs[p.user_id] = p; });
    (await DB.get('user_preferences?select=user_id,leagues&user_id=' + inList(part))).forEach((p) => { leagues[p.user_id] = p.leagues || []; });
  }
  const recent = [];
  for (const part of chunks(userIds, 60)) {
    if (!part.length) continue;
    const since = new Date(Date.now() - EDP.COOLDOWN_HOURS * 36e5).toISOString();
    (await DB.get('user_alerts?select=user_id,game_key,kind,created_at&created_at=gte.' + encodeURIComponent(since) + '&user_id=' + inList(part))).forEach((a) => recent.push(a));
  }
  const watchedBy = {};
  watchers.forEach((w) => { (watchedBy[w.game_key] = watchedBy[w.game_key] || new Set()).add(w.user_id); });
  const out = [], perUser = {}, stamp = new Date().toISOString();
  changed.forEach(({ prev, cur }) => {
    const audience = new Set(watchedBy[cur.game_key] || []);
    leagueUsers.forEach((u) => { const lg = leagues[u.user_id] || []; if (!lg.length || lg.indexOf(cur.sport) >= 0) audience.add(u.user_id); });
    audience.forEach((uid) => {
      const watched = !!(watchedBy[cur.game_key] && watchedBy[cur.game_key].has(uid));
      let list = EDP.alertsFor(prev, cur, prefs[uid] || null, { watched });
      list = EDP.cooled(list, recent.filter((r) => r.user_id === uid), Date.now());
      list.forEach((a) => {
        perUser[uid] = (perUser[uid] || 0) + 1;
        if (perUser[uid] > 25) return;
        out.push(Object.assign({ user_id: uid, created_at: stamp }, a));
      });
    });
  });
  for (const part of chunks(out, 100)) await DB.post('user_alerts', part, 'return=minimal,resolution=ignore-duplicates', 'user_id,dedupe_key');
  log('  alerts: ' + out.length + ' for ' + Object.keys(perUser).length + ' reader(s)' + (DRY ? ' (dry)' : ''));
  return { created: out.length, sample: out.slice(0, 3) };
}

/* ------------------------------------------------------------ 4. journal */
const RECORDS = {};
function recordGame(sport, season, gid) {
  const key = sport + '_' + season;
  if (!(key in RECORDS)) {
    try { RECORDS[key] = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', key + '.json'), 'utf8')); }
    catch (_) { RECORDS[key] = null; }
  }
  const j = RECORDS[key];
  if (!j || !j.games) return null;
  const games = Array.isArray(j.games) ? j.games : Object.values(j.games);
  return games.find((g) => g && String(g.game_id) === String(gid)) || null;
}
async function gradeJournal() {
  const nowIso = new Date().toISOString();
  const rows = await DB.get('research_journal?select=*&decision=eq.wagered&graded_at=is.null&kickoff_at=lt.' + encodeURIComponent(nowIso) + '&order=kickoff_at.asc&limit=500');
  let closed = 0, graded = 0;
  const hist = {};
  for (const e of rows) {
    const [sport, gid] = String(e.game_key).split('|');
    if (!(e.game_key in hist)) {
      hist[e.game_key] = await DB.get('game_research_history?select=state,computed_at&game_key=eq.' + encodeURIComponent(e.game_key)
        + '&order=computed_at.desc&limit=300').catch(() => []);
    }
    let close = EDP.closeFromHistory(hist[e.game_key], e.kickoff_at);
    const season = e.kickoff_at ? new Date(e.kickoff_at).getUTCFullYear() - (new Date(e.kickoff_at).getUTCMonth() < 2 ? 1 : 0) : null;
    const rec = season ? recordGame(sport, season, gid) : null;
    if (!close && rec && rec.close && typeof rec.close.home_line === 'number')
      close = { home_line: rec.close.home_line, total: typeof rec.close.total === 'number' ? rec.close.total : null, ml_home: null, ml_away: null,
        captured_at: null, source: 'record/football · ' + (rec.close.source || 'consensus') + (rec.close.book ? ' · ' + rec.close.book : ''), fair_home_line: null };
    const final = rec && rec.final && typeof rec.final.home_score === 'number' ? rec.final : null;
    const g = EDP.gradeEntry(e, close, final);
    const patch = {};
    if (close && e.close_captured_at == null && e.close_source == null) {
      Object.assign(patch, { close_home_line: close.home_line, close_total: close.total, close_ml_home: close.ml_home, close_ml_away: close.ml_away,
        close_captured_at: close.captured_at, close_source: close.source, close_fair_home_line: close.fair_home_line,
        clv_points: g.clv_points, clv_price: g.clv_price, beat_close: g.beat_close,
        market_moved_toward_edgedesk: g.market_moved_toward_edgedesk, fair_moved_toward_market: g.fair_moved_toward_market });
      closed++;
    }
    const staleDays = (Date.now() - Date.parse(e.kickoff_at)) / 864e5;
    if (g.result || staleDays > 10) {
      Object.assign(patch, { result: g.result, home_score: final ? final.home_score : null, away_score: final ? final.away_score : null,
        graded_at: nowIso, grade_note: (g.result ? null : 'no final score on file ten days after kickoff') || (g.note.length ? g.note.join('; ') : null) });
      graded++;
    }
    if (Object.keys(patch).length) await DB.patch('research_journal', 'entry_id=eq.' + encodeURIComponent(e.entry_id), patch);
  }
  log('  journal: ' + rows.length + ' open wager(s) past kickoff · ' + closed + ' closed · ' + graded + ' graded' + (DRY ? ' (dry)' : ''));
  return { open: rows.length, closed, graded };
}

/* ------------------------------------------------------------ main */
async function main() {
  const summary = { at: new Date().toISOString(), dry: DRY, database: HAVE_DB };
  log('EdgeDesk personal research job' + (DRY ? ' (dry run)' : ''));
  if (!HAVE_DB && !DRY) {
    console.log('  no SB_URL / SB_SERVICE_ROLE: nothing can be written. Run with --dry to compute only.');
    process.exit(2);
  }
  let changed = [];
  if (want('states') || want('alerts')) {
    const b = await buildStates();
    summary.states = b.states.length;
    summary.research_grade = b.states.filter((s) => s.research_grade).length;
    if (HAVE_DB) changed = await writeStates(b.states);
    else log('  (dry, no database) first research-grade game: ' + ((b.states.find((s) => s.research_grade) || {}).game_key || 'none'));
    summary.changed = changed.length;
    if (want('alerts') && HAVE_DB) summary.alerts = (await sendAlerts(changed)).created;
  }
  if (want('grade') && HAVE_DB) summary.journal = await gradeJournal();
  if (want('affiliates') && HAVE_DB) {
    const r = await DB.rpc('affiliate_reconcile', { p_days: 45 }).catch((e) => ({ error: String(e.message).slice(0, 160) }));
    summary.affiliates = r;
    log('  affiliates: ' + (r && r.missing ? 'supabase/affiliates.sql is not installed — skipped' : JSON.stringify(r)));
  }
  console.log(JSON.stringify(summary));
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error('research_state: ' + (e && e.stack || e)); process.exit(1); });
/* the three database steps, for a caller that already holds the states */
async function runWith(opts) {
  DB = opts.db || HTTP_DB;
  const out = {};
  if (opts.states) {
    const states = opts.states.map((x) => EDP.normalizeState(x)).filter(Boolean);
    const changed = await writeStates(states);
    out.changed = changed.length;
    out.alerts = (await sendAlerts(changed)).created;
  }
  if (opts.grade) out.journal = await gradeJournal();
  DB = HTTP_DB;
  return out;
}
module.exports = { makeReader, READ_ALLOW, runWith, recordGame };
