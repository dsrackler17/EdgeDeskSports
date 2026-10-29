#!/usr/bin/env node
/* ============================================================================
   SP+ weekly sync — CollegeFootballData.com -> the append-only Supabase table.
   football/sp_plus/README.md · supabase/cfb_sp_plus.sql

   Once a week (.github/workflows/cfb-sp-plus.yml, plus a manual run) this
   reads SP+ for the season, maps every team through the identity master,
   stores one row per team in public.cfb_sp_ratings (append-only, service role
   only) and records the attempt in public.cfb_sp_sync_runs. The public
   repository receives football/sp_plus/lines.json: the capture's metadata
   and, per game, the DERIVED projected line. It never receives a rating.

   THE WEEK. A capture belongs to the slate's current week
   (football/fbs/slate.json current_week: the earliest schedule week with an
   unstarted game). One capture per week: a later run in the same week does
   nothing (--force takes a new capture, appended beside the first).

   THE OUTCOMES
     OK                 captured, stored, published
     UNCHANGED          CollegeFootballData still serves exactly the previous
                        week's numbers (same payload hash): SP+ has not been
                        updated yet, so nothing is stored or published for the
                        new week; the next scheduled run tries again
     ALREADY_CAPTURED   this week was captured by an earlier run
     FAILED             nothing is published for the week, and the reason is:
                        no key, CFBD answered an error, the payload failed
                        validation, no team mapped, no database credentials, or
                        the migration is not applied. It FAILS CLOSED: the
                        append-only table is the record, so a capture it does
                        not hold is never published.

     node football/sp_plus/sync.js [--write] [--force] [--now ISO]
   env: CFBD_API_KEY (required), CFBD_BASE_URL (optional), SB_URL and
        SB_SERVICE_ROLE (required to store).
   Exit 0 on OK, UNCHANGED and ALREADY_CAPTURED; 1 on FAILED (after writing
   lines.json with --write, so the failure is published too).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./cfbd.js');

const REPO = path.resolve(__dirname, '..', '..');
const LINES = path.join(__dirname, 'lines.json');
const SLATE = path.join(REPO, 'football', 'fbs', 'slate.json');
const SCHEMA = 'edgedesk_cfb_sp_plus_lines_v1';
const ATTRIBUTION = 'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function iso(t) { const v = t instanceof Date ? t.getTime() : Date.parse(t); if (!Number.isFinite(v)) throw new Error('not a time: ' + t); return new Date(v).toISOString(); }
function weekKey(season, seasonType, week) { return season + ':' + (seasonType === 'postseason' ? 1 : 0) + ':' + String(week).padStart(2, '0'); }

/* the slate's current week, or a reason it has none */
function currentWeek(slate) {
  const cw = slate && slate.current_week;
  if (!cw || !Number.isInteger(cw.season) || !Number.isInteger(cw.week)) return { error: 'football/fbs/slate.json has no current week' };
  const seasonType = cw.season_type === 'postseason' ? 'postseason' : 'regular';
  return { season: cw.season, week: cw.week, season_type: seasonType, week_key: weekKey(cw.season, seasonType, cw.week) };
}

function emptyDoc(season) {
  return {
    schema: SCHEMA, generated_at: null, season: season == null ? null : season,
    status: 'NEVER_SYNCED', last_attempt: null, snapshot: null,
    provenance: { rating_tier: 'T3', rating_tier_label: 'Research Model · external (not EdgeDesk’s)', line_tier: 'T2', line_tier_label: 'Computed from a T3 input',
      external: true, edgedesk_model: false, validated_by_edgedesk: false },
    attribution: ATTRIBUTION,
    note: 'Derived values only. No SP+ rating is stored in this repository: the raw weekly ratings live in the append-only table public.cfb_sp_ratings (supabase/cfb_sp_plus.sql).',
    games: {}
  };
}

/* the run row; best effort — a failure to record a FAILED attempt never hides the failure itself */
function runRow(o) {
  const r = { season: o.season, week: o.week == null ? null : o.week, week_key: o.week_key || null, started_at: o.started_at, finished_at: o.finished_at,
    status: o.status, reason: o.reason || null, n_received: o.n_received || 0, n_valid: o.n_valid || 0, n_mapped: o.n_mapped || 0,
    unmapped: o.unmapped || [], rejected: o.rejected || [], payload_sha256: o.payload_sha256 || null, snapshot_id: o.snapshot_id || null };
  r.run_id = C.ids.run(r);
  return r;
}

/* opts: { now, slate, doc, key, base, cfbdFetch, db: {url, key, fetch, sleep}, force, identity, master, dbModule } */
async function run(opts) {
  opts = opts || {};
  const now = iso(opts.now || new Date());
  const slate = opts.slate || readJson(SLATE);
  const cw = currentWeek(slate);
  const doc = JSON.parse(JSON.stringify(opts.doc || readJson(LINES) || emptyDoc(cw.season)));
  const prior = doc.snapshot || null;
  const db = opts.db || {};
  const DB = opts.dbModule || require('../cfb_production/db.js');
  const io = { fetch: db.fetch, sleep: db.sleep, timeoutMs: db.timeoutMs };
  const out = (status, reason, extra) => {
    doc.generated_at = now;
    doc.status = status;
    doc.last_attempt = { at: now, week_key: cw.week_key || null, status, reason: reason || null };
    return Object.assign({ status, reason: reason || null, doc, week: cw }, extra || {});
  };
  const fail = async (reason, extra) => {
    if (db.url && db.key && cw.season) {
      const r = runRow(Object.assign({ season: cw.season, week: cw.week, week_key: cw.week_key, started_at: now, finished_at: iso(new Date(Math.max(Date.now(), Date.parse(now)))), status: 'FAILED', reason }, extra || {}));
      try { await DB.postRows(db.url, db.key, 'cfb_sp_sync_runs', 'run_id', [r], io); } catch (_) { /* the failure below is the record */ }
    }
    return out('FAILED', reason, extra);
  };

  if (cw.error) return out('FAILED', cw.error);
  if (doc.season == null) doc.season = cw.season;
  if (prior && prior.week_key === cw.week_key && !opts.force) {
    return { status: 'ALREADY_CAPTURED', reason: 'week ' + cw.week_key + ' was captured at ' + prior.captured_at, doc: null, week: cw };
  }

  const got = await C.fetchSp({ season: cw.season, key: opts.key, base: opts.base, fetch: opts.cfbdFetch });
  if (!got.ok) return fail(got.error);
  const parsed = C.parseSp(got.body, cw.season);
  const counts = { n_received: parsed.n_received, n_valid: parsed.rows.length, rejected: parsed.rejected };
  if (parsed.refusal) return fail('the SP+ payload was refused: ' + parsed.refusal, counts);
  const hash = C.payloadHash(parsed.rows);
  if (prior && prior.payload_sha256 === hash) {
    if (prior.week_key === cw.week_key) return { status: 'ALREADY_CAPTURED', reason: 'the same numbers are already captured for week ' + cw.week_key, doc: null, week: cw };
    const reason = 'CollegeFootballData still serves the SP+ captured for week ' + prior.week_key + ' (identical numbers): not updated yet for week ' + cw.week_key;
    if (db.url && db.key) {
      const r = runRow(Object.assign({ season: cw.season, week: cw.week, week_key: cw.week_key, started_at: now, finished_at: now, status: 'UNCHANGED', reason, payload_sha256: hash }, counts));
      try { await DB.postRows(db.url, db.key, 'cfb_sp_sync_runs', 'run_id', [r], io); } catch (_) { /* nothing was captured either way */ }
    }
    return out('UNCHANGED', reason);
  }

  const map = C.mapTeams(parsed.rows, { identity: opts.identity, master: opts.master });
  Object.assign(counts, { n_mapped: map.mapped.length, unmapped: map.unmapped, payload_sha256: hash });
  if (!map.mapped.length) return fail('no SP+ team mapped to an EdgeDesk team', counts);
  if (!db.url || !db.key) return fail('no database credentials (SB_URL / SB_SERVICE_ROLE): the append-only table is the record, so nothing is published', counts);

  const snap = { season: cw.season, week: cw.week, week_key: cw.week_key, season_type: cw.season_type, captured_at: now, payload_sha256: hash,
    source: C.SOURCE, source_version: 'cfbd-ratings-sp:' + cw.season + ':' + hash.slice(0, 12) };
  snap.snapshot_id = C.ids.snapshot(snap);
  const rows = map.mapped.map((m) => {
    const r = { snapshot_id: snap.snapshot_id, season: snap.season, week: snap.week, week_key: snap.week_key, season_type: snap.season_type,
      team_id: m.team_id, source_team: m.source_team, sp_overall: m.sp_overall, sp_off: m.sp_off, sp_def: m.sp_def,
      source: snap.source, source_version: snap.source_version, payload_sha256: hash, captured_at: now };
    r.rating_id = C.ids.rating(r);
    return r;
  });
  try {
    await DB.postRows(db.url, db.key, 'cfb_sp_ratings', 'rating_id', rows, io);
    await DB.postRows(db.url, db.key, 'cfb_sp_sync_runs', 'run_id',
      [runRow(Object.assign({ season: cw.season, week: cw.week, week_key: cw.week_key, started_at: now, finished_at: iso(new Date(Math.max(Date.now(), Date.parse(now)))), status: 'OK', snapshot_id: snap.snapshot_id }, counts))], io);
  } catch (e) {
    const LABSYNC = require('../cfb_lab/sync_supabase.js');
    return fail(LABSYNC.tableMissing(e) ? 'the SP+ tables do not exist: apply supabase/cfb_sp_plus.sql' : 'storing the capture failed: ' + String(e && e.message || e).slice(0, 300), counts);
  }

  doc.snapshot = Object.assign({}, snap, { teams_rated: map.mapped.length, n_received: parsed.n_received, n_rejected: parsed.rejected.length,
    rejected: parsed.rejected.map((x) => ({ team: x.team, reason: x.reason })), unmapped: map.unmapped });
  return out('OK', null, { ratings: rows, mapped: map.mapped });
}

function write(doc, file) { fs.writeFileSync(file || LINES, JSON.stringify(doc, null, 1) + '\n'); }

function summary(res) {
  const s = res.doc && res.doc.snapshot;
  const lines = ['### SP+ sync: ' + res.status, '', '- week: ' + (res.week && res.week.week_key || '—')];
  if (res.reason) lines.push('- reason: ' + res.reason);
  if (s && res.status === 'OK') {
    lines.push('- teams rated: ' + s.teams_rated + ' of ' + s.n_received + ' received (' + s.n_rejected + ' rejected)');
    lines.push('- unmapped (logged, never guessed): ' + (s.unmapped.length ? s.unmapped.map((u) => u.source_team + ' — ' + u.reason).join('; ') : 'none'));
  }
  return lines.join('\n') + '\n';
}

module.exports = { run, write, emptyDoc, currentWeek, weekKey, summary, SCHEMA, ATTRIBUTION, LINES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  run({ now: arg('--now', undefined), force: a.includes('--force'), key: process.env.CFBD_API_KEY, base: process.env.CFBD_BASE_URL || undefined,
    db: { url: process.env.SB_URL, key: process.env.SB_SERVICE_ROLE } })
    .then((res) => {
      const text = summary(res);
      process.stdout.write(text);
      if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text); } catch (_) { /* best effort */ } }
      if (a.includes('--write') && res.doc) write(res.doc);
      process.exit(res.status === 'FAILED' ? 1 : 0);
    })
    .catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
