#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — GRADE EVERY PUBLISHED BRIEF AGAINST THE CLOSE AND THE FINAL.

   A publisher brief is a snapshot: the call, the price and the book, frozen
   at a timestamp, shared at brief.html?s=<slug>. This closes the loop on it.
   After kickoff each published selection is looked up again and graded:

     1. read every PUBLIC brief (publisher_briefs, is_public = true) under
        the same anon key the site ships — nothing privileged is touched
     2. for each published price, find the selection's own closing line:
        the engine's closing fair line (signals.closing_sharp_fair) and the
        result the close pipeline graded, through the public_brief_closes
        view (supabase/brief_record.sql) — rows past kickoff only
     3. for a football selection the close pipeline has not graded yet,
        look the final up in the SAME public feeds the settler trusts
        (ESPN, nflverse, cfbfastR) and derive win / loss / push from the
        score, deterministically
     4. write record/grades.json, which record.html, brief.html and the app
        read. The workflow commits it, so every grade is a git commit and
        the record has no edit step.

   THE RULES IT WILL NOT BREAK
   - A closing line is never invented. No signal row, no close: the pick
     says so and waits.
   - A result is never inferred. Two sources that disagree grade nothing.
   - A graded pick is never re-graded. Once written it is history.
   - The price graded is the price that was PUBLISHED, from the snapshot.
     Live odds cannot change a grade after the fact.
   - Zero qualifying bets is a real answer: a NO QUALIFYING BETS brief is
     counted as discipline, never padded and never dropped.
   - No AI anywhere in this file. The arithmetic is the engine's own
     `fair × decimal − 1`, through the shared presentation library.

   Usage
     node tools/record/grade_briefs.js                 # dry run, prints the report
     node tools/record/grade_briefs.js --out record/grades.json
     node tools/record/grade_briefs.js --json          # machine readable
     node tools/record/grade_briefs.js --now 2026-09-08T12:00:00Z

   Exit  0 = ran   1 = could not run (no network, no briefs endpoint)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const S = require(path.join(__dirname, '..', 'collective', 'settle_finals.js'));

const SB_URL = process.env.EDGEDESK_SUPABASE_URL || 'https://iattxbkbufslbauoumga.supabase.co';
/* The public anon key the site already ships in every page. RLS decides
   what it can read: public briefs, and the owner-run close view. */
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
const URL_NFL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const URL_CFB = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;

const VERSION = 1;
const BRIEF_COLS = 'id,share_slug,report_key,report_type,preset,version_no,parent_id,sport,sport_label,event_ids,title,kicker,event_label,when_label,generated_at,price_captured_at,integrity_status,freshness_status,public_payload,created_at';
/* The close view first; the older public_record view as a fallback where
   it happens to carry the columns. Either missing is reported, not guessed. */
const CLOSE_VIEWS = ['public_brief_closes', 'public_record'];
const CLOSE_COLS = 'event_id,sport_key,market,selection,point,home_team,away_team,commence_time,best_dec,best_book,closing_sharp_fair,closed_at,result,graded_at';
/* A pick past kickoff by this much with no signal row is reported as such
   rather than left looking merely late. */
const NO_ROW_AFTER_MS = 6 * 3600 * 1000;

/* ---- pure: picks out of a stored brief --------------------------------- */
function picksFromBrief(row) {
  const pub = (row && row.public_payload) || {};
  const prices = (pub.data_status && Array.isArray(pub.data_status.prices)) ? pub.data_status.prices : [];
  const cards = Array.isArray(pub.cards) ? pub.cards : [];
  const watch = Array.isArray(pub.watch) ? pub.watch : [];
  const ordered = cards.concat(watch);
  return prices.map((p, i) => {
    const f = P.priceFields(p);
    const pc = ordered[i] || null;
    const verdict = p.verdict || (pc && pc.brief && pc.brief.call && pc.brief.call.verdict) || null;
    const kind = p.kind || (i < cards.length ? 'pick' : 'watch');
    return {
      key: P.gradeKey(p),
      rank: p.rank != null ? p.rank : (kind === 'pick' ? i + 1 : i - cards.length + 1),
      kind, verdict,
      event_id: f.event_id, matchup: p.matchup || null,
      market: p.market || P.marketLabel(f.market_key), market_key: f.market_key,
      selection: p.selection || null, selection_raw: f.selection_raw, line: f.line,
      odds: p.odds || (f.odds_am != null ? P.fmtAmerican(f.odds_am) : null), odds_am: f.odds_am,
      book: p.book || null, captured_at: p.captured_at || null,
      commence: p.commence || null, sport_key: p.sport_key || row.sport || null, sport_label: p.sport_label || row.sport_label || null,
      home: p.home || null, away: p.away || null,
    };
  });
}

function briefShell(row) {
  const pub = (row && row.public_payload) || {};
  const sl = pub.slate || null;
  return {
    id: row.id, slug: row.share_slug || null, url: row.share_slug ? 'brief.html?s=' + row.share_slug : null,
    report_key: row.report_key || null, report_type: row.report_type, preset: row.preset, version_no: row.version_no || 1, parent_id: row.parent_id || null,
    sport: row.sport || null, sport_label: row.sport_label || null,
    title: row.title || null, kicker: row.kicker || null, event_label: row.event_label || null, when_label: row.when_label || null,
    generated_at: row.generated_at, price_captured_at: row.price_captured_at || null,
    integrity_status: row.integrity_status || 'OK', freshness_status: row.freshness_status || 'CURRENT',
    no_bet: !!(sl && sl.no_bet), slate_headline: sl ? sl.headline : null, counts: sl ? sl.counts : null,
    still_public: true,
  };
}

/* ---- pure: the close row for one pick ---------------------------------- */
function sameLine(a, b) {
  const x = P.num(a), y = P.num(b);
  if (x == null && y == null) return true;
  if (x == null || y == null) return false;
  return Math.abs(x - y) < 1e-9;
}
function matchClose(pick, closeRows) {
  if (!pick || !pick.event_id) return null;
  const mk = P.marketKeyOf(pick.market_key);
  const sel = P.normTeam(pick.selection_raw);
  const hits = (closeRows || []).filter(r =>
    r && r.event_id === pick.event_id && P.marketKeyOf(r.market) === mk &&
    P.normTeam(r.selection) === sel && sameLine(r.point, pick.point != null ? pick.point : pick.line));
  if (hits.length === 1) return hits[0];
  if (!hits.length) return null;
  /* Several rows for one selection: prefer a graded one, then the latest close. */
  return hits.slice().sort((a, b) => (b.graded_at ? 1 : 0) - (a.graded_at ? 1 : 0) || String(b.closed_at || '').localeCompare(String(a.closed_at || '')))[0];
}

/* ---- pure: grade one pick ---------------------------------------------- */
function gradeOne(pick, closeRow, final, nowMs, opts) {
  opts = opts || {};
  const out = { status: 'pending', grade: null, score: null, note: null };
  if (pick.verdict === 'DATA CHECK FAILED') { out.status = 'not_gradeable'; out.note = 'Published as a failed data check, not a call.'; return out; }
  const kickoff = P.num(Date.parse(pick.commence || (closeRow && closeRow.commence_time) || ''));
  if (kickoff != null && kickoff > nowMs) { out.status = 'pending_kickoff'; return out; }
  if (pick.odds_am == null) { out.status = 'no_odds'; return out; }

  let result = null, resultSource = null;
  const pipeline = closeRow ? P.normResult(closeRow.result) : null;
  let fromScore = null;
  if (final && final.ok) {
    fromScore = P.outcomeFromScore({ market_key: pick.market_key, selection_raw: pick.selection_raw, point: pick.line,
      home: pick.home || (closeRow && closeRow.home_team), away: pick.away || (closeRow && closeRow.away_team),
      home_score: final.home_score, away_score: final.away_score });
    out.score = { home: pick.home || (closeRow && closeRow.home_team) || null, away: pick.away || (closeRow && closeRow.away_team) || null,
      home_score: final.home_score, away_score: final.away_score, source: (final.agreed_by || [final.source]).filter(Boolean).join('+') || null };
  }
  if (pipeline && fromScore && pipeline !== fromScore) {
    out.status = 'contested'; out.note = `close pipeline says ${pipeline}, the final score says ${fromScore}`;
    return out;
  }
  if (pipeline) { result = pipeline; resultSource = 'close pipeline'; }
  else if (fromScore) { result = fromScore; resultSource = 'final score' + (out.score && out.score.source ? ' (' + out.score.source + ')' : ''); }

  if (!closeRow) {
    if (opts.closeSource === 'unavailable') { out.status = 'no_close_source'; }
    else if (kickoff != null && nowMs > kickoff + NO_ROW_AFTER_MS) { out.status = 'no_signal_row'; }
    else out.status = 'pending';
    if (result) {
      /* A final without a close still records the outcome; CLV stays null. */
      out.grade = P.gradePick({ odds_am: pick.odds_am, result, result_source: resultSource });
      out.status = 'awaiting_close';
    }
    return out;
  }
  const g = P.gradePick({
    odds_am: pick.odds_am, close_fair_prob: closeRow.closing_sharp_fair,
    close_best_am: closeRow.best_dec != null ? P.decToAmerican(closeRow.best_dec) : null, close_best_book: closeRow.best_book || null,
    closed_at: closeRow.closed_at || null, result, result_source: resultSource,
  });
  out.grade = g;
  out.status = g.status === 'pending' ? 'awaiting_close' : g.status;
  return out;
}

/* ---- pure: the whole record ------------------------------------------- */
function buildRecord(briefRows, closeRows, finalsByEvent, prev, nowMs, opts) {
  opts = opts || {};
  const nowIso = new Date(nowMs).toISOString();
  const prevBriefs = {};
  ((prev && prev.briefs) || []).forEach(b => { prevBriefs[b.id] = b; });
  const briefs = [];
  const notes = [];
  (briefRows || []).forEach(row => {
    const b = briefShell(row);
    const old = prevBriefs[b.id];
    const oldPicks = {};
    ((old && old.picks) || []).forEach(pk => { oldPicks[pk.key] = pk; });
    b.picks = picksFromBrief(row).map(pick => {
      const was = oldPicks[pick.key];
      /* Immutable once graded. History does not get a second opinion. */
      if (was && was.status === 'graded') return was;
      const close = matchClose(pick, closeRows);
      const final = finalsByEvent ? finalsByEvent[pick.event_id] : null;
      const r = gradeOne(pick, close, final, nowMs, opts);
      const pk = Object.assign({}, pick, { status: r.status, grade: r.grade, score: r.score, note: r.note });
      if (r.status === 'graded') pk.graded_at = nowIso;
      else if (was && was.graded_at) pk.graded_at = was.graded_at;
      return pk;
    });
    b.graded_at = b.picks.reduce((m, pk) => pk.graded_at && (!m || pk.graded_at > m) ? pk.graded_at : m, null);
    briefs.push(b);
  });
  /* A brief that was public and is not any more stays in the record, marked.
     Unpublishing does not delete a grade. */
  const seen = {};
  briefs.forEach(b => { seen[b.id] = 1; });
  ((prev && prev.briefs) || []).forEach(b => { if (!seen[b.id]) briefs.push(Object.assign({}, b, { still_public: false })); });
  briefs.sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  if (opts.closeSource === 'unavailable') notes.push('closing line view unavailable: run supabase/brief_record.sql');
  const rec = {
    version: VERSION,
    generated_at: nowIso,
    source: {
      briefs: 'publisher_briefs (public rows only)',
      close: opts.closeSourceName || null,
      finals: opts.finalsSources || [],
      grader: 'tools/record/grade_briefs.js',
    },
    briefs,
    summary: P.recordSummary(briefs),
    calibration: P.calibration(briefs),
    notes: notes.concat(opts.notes || []),
  };
  return stable(prev, rec);
}
/* Byte-stable when nothing graded changed, so the hourly job does not
   commit a timestamp-only diff. */
function stable(prev, next) {
  if (!prev) return next;
  const strip = r => JSON.stringify(Object.assign({}, r, { generated_at: null, source: null, notes: null }));
  return strip(prev) === strip(next) ? prev : next;
}

/* ---- network ------------------------------------------------------------ */
async function sbGet(q) {
  const res = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: { apikey: ANON, authorization: `Bearer ${ANON}`, accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let msg = text; try { msg = JSON.parse(text).message || text; } catch (_) {}
    const e = new Error(`GET ${q.split('?')[0]} -> ${res.status}: ${String(msg).slice(0, 200)}`);
    e.status = res.status; e.missing = res.status === 404 || /does not exist|42703|42P01|PGRST205/i.test(String(msg));
    throw e;
  }
  return text ? JSON.parse(text) : [];
}
async function sbGetAll(base, pageSize) {
  pageSize = pageSize || 1000;
  const out = [];
  for (let off = 0; off < 20000; off += pageSize) {
    const rows = await sbGet(`${base}&limit=${pageSize}&offset=${off}`);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
async function fetchBriefs() {
  return sbGetAll(`publisher_briefs?select=${BRIEF_COLS}&is_public=eq.true&order=generated_at.desc`);
}
async function fetchCloses(eventIds, notes) {
  const ids = Array.from(new Set(eventIds.filter(Boolean)));
  if (!ids.length) return { rows: [], source: null };
  for (const view of CLOSE_VIEWS) {
    const rows = [];
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40).map(encodeURIComponent).join(',');
        rows.push(...await sbGetAll(`${view}?select=${CLOSE_COLS}&event_id=in.(${chunk})`));
      }
      notes.push({ source: view, rows: rows.length });
      return { rows, source: view };
    } catch (e) {
      notes.push({ source: view, error: String(e.message).slice(0, 160) });
      if (!e.missing) throw e;
    }
  }
  return { rows: [], source: null };
}
function feedKind(sportKey) {
  const k = String(sportKey || '');
  if (k.indexOf('americanfootball_nfl') === 0) return 'nfl';
  if (k.indexOf('americanfootball_ncaaf') === 0) return 'cfb';
  return null;
}
function seasonOf(iso) {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return null;
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
const CACHE = new Map();
async function cached(key, fn) { if (!CACHE.has(key)) CACHE.set(key, await fn()); return CACHE.get(key); }
async function fetchText(url) { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`); return r.text(); }
/* Finals for the football picks that still need a result. The same
   sources, in the same order, as tools/collective/settle_finals.js, and the
   same rule: agreement across sources or nothing. */
async function fetchFinals(picks, notes) {
  const byEvent = {};
  const need = picks.filter(pk => pk.event_id && feedKind(pk.sport_key) && pk.commence && (pk.home || pk.away));
  const groups = {};
  need.forEach(pk => { const k = feedKind(pk.sport_key) + ':' + seasonOf(pk.commence); (groups[k] = groups[k] || []).push(pk); });
  const used = new Set();
  for (const key of Object.keys(groups)) {
    const [kind, season] = key.split(':');
    const dates = Array.from(new Set(groups[key].flatMap(pk => {
      const t = Date.parse(pk.commence); const d0 = S.compactDate(new Date(t).toISOString()); const d1 = S.compactDate(new Date(t - 864e5).toISOString());
      return [d0, d1];
    })));
    const sources = [];
    const espn = [];
    for (const d of dates) {
      try { const j = JSON.parse(await cached('espn:' + kind + ':' + d, () => fetchText(S.espnUrl(kind, d)))); espn.push(...(j.events || []).map(S.normEspn)); }
      catch (e) { notes.push({ source: 'espn', date: d, error: String(e.message).slice(0, 120) }); }
    }
    if (espn.length) sources.push({ name: 'espn', rows: espn });
    try {
      if (kind === 'nfl') { const rows = S.parseCsv(await cached('nfl', () => fetchText(URL_NFL))).filter(r => String(r.season) === String(season)).map(S.normNfl); if (rows.length) sources.push({ name: 'nflverse', rows }); }
      else { const rows = S.parseCsv(await cached('cfb:' + season, () => fetchText(URL_CFB(season)))).map(S.normCfb); if (rows.length) sources.push({ name: 'cfbfastR', rows }); }
    } catch (e) { notes.push({ source: kind === 'nfl' ? 'nflverse' : 'cfbfastR', season, error: String(e.message).slice(0, 120) }); }
    groups[key].forEach(pk => {
      if (byEvent[pk.event_id]) return;
      const f = S.findAcrossSources({ home: pk.home, away: pk.away, kickoff_at: pk.commence }, sources);
      byEvent[pk.event_id] = f;
      if (f.ok) (f.agreed_by || []).forEach(s => used.add(s));
    });
  }
  return { byEvent, sources: Array.from(used) };
}

/* ---- the run ------------------------------------------------------------ */
function parseArgs(argv) {
  const a = { out: null, json: false, now: null, prev: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--json') a.json = true;
    else if (v === '--now') a.now = argv[++i];
    else if (v === '--prev') a.prev = argv[++i];
  }
  return a;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = args.now ? Date.parse(args.now) : Date.now();
  if (!isFinite(nowMs)) throw new Error('--now is not a date');
  const prevPath = args.prev || args.out;
  let prev = null;
  if (prevPath && fs.existsSync(prevPath)) { try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch (_) { prev = null; } }
  const notes = [];
  let briefRows;
  try { briefRows = await fetchBriefs(); }
  catch (e) {
    if (!e.missing) throw e;
    /* The table has not been created yet. An empty record is the truth. */
    notes.push({ source: 'publisher_briefs', error: 'table missing: run supabase/publisher_briefs.sql' });
    briefRows = [];
  }
  const allPicks = briefRows.flatMap(picksFromBrief);
  const due = allPicks.filter(pk => { const t = Date.parse(pk.commence || ''); return !isFinite(t) || t <= nowMs; });
  const closes = await fetchCloses(due.map(pk => pk.event_id), notes);
  const needFinal = due.filter(pk => { const c = matchClose(pk, closes.rows); return !(c && P.normResult(c.result)); });
  const finals = await fetchFinals(needFinal, notes);
  const rec = buildRecord(briefRows, closes.rows, finals.byEvent, prev, nowMs, {
    closeSource: closes.source ? 'ok' : 'unavailable', closeSourceName: closes.source,
    finalsSources: finals.sources, notes: notes.map(n => JSON.stringify(n)),
  });
  const report = { briefs: rec.briefs.length, picks: allPicks.length, graded: rec.summary.calls.graded + rec.summary.research.graded,
    calls: rec.summary.calls, no_bet_briefs: rec.summary.no_bet_briefs, close_source: closes.source, finals: finals.sources, notes, changed: rec !== prev };
  if (args.out) {
    if (rec === prev) console.error('[grade] nothing changed; ' + args.out + ' left as is');
    else { fs.mkdirSync(path.dirname(args.out), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify(rec, null, 1) + '\n'); console.error('[grade] wrote ' + args.out); }
  }
  if (args.json) console.log(JSON.stringify(args.out ? report : rec, null, 2));
  else console.error('[grade] ' + JSON.stringify(report));
  return 0;
}

module.exports = { picksFromBrief, briefShell, matchClose, gradeOne, buildRecord, stable, feedKind, seasonOf, parseArgs, VERSION, CLOSE_VIEWS, CLOSE_COLS };

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error(`[grade] ${e.message}`); process.exit(1); });
}
