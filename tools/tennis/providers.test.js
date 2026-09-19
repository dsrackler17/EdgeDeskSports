#!/usr/bin/env node
/* ===========================================================================
   Tests for the tennis PROVIDER CONTRACTS.

   The point of the provider layer is that replacing the non-commercial
   historical archive with a licensed feed is a configuration change rather
   than a rewrite. These hold that promise:

     every adapter declares its kind, its source key, its credentials and — the
       part that matters — what it does NOT carry
     the normalised shapes are validated, so an adapter that returns the wrong
       thing is caught rather than propagated
     the cursor reaches BACK by an overlap window, or corrections never arrive
     a cold start does not silently re-read all of history
     source priority decides a conflict, and the loser is KEPT
     a "no material change" is a no-op, so a feed that rewrites its timestamps
       does not cost a full recompute
     NO adapter may delete
     the unimplemented licensed adapter fails loudly and blocks nothing

   Run: node tools/tennis/providers.test.js
   =========================================================================== */
'use strict';
const P = require('./providers/index.js');
const ARCHIVE = require('./providers/historical_archive.js');
const ESPN = require('./providers/espn_results.js');
const ODDS = require('./providers/edgedesk_odds.js');
const WX = require('./providers/open_meteo_weather.js');
const LICENSED = require('./providers/licensed_feed.js');
const M = require('../../lib/tennis_model.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  chk(name, a === b, 'got ' + a + ', want ' + b);
}

const ALL = { historical_archive: ARCHIVE, espn_results: ESPN, edgedesk_odds: ODDS,
              open_meteo_weather: WX, licensed_feed: LICENSED };

/* ── 1. EVERY ADAPTER DECLARES ITSELF ─────────────────────────────────── */
Object.keys(ALL).forEach((n) => {
  const a = ALL[n];
  chk(n + ' declares a kind', !!a.kind);
  chk(n + ' declares a source key', !!a.source_key);
  chk(n + ' declares a priority', typeof a.priority === 'number');
  chk(n + ' declares its capabilities', a.capabilities && typeof a.capabilities === 'object');
  chk(n + ' can describe itself', typeof a.describe === 'function' && !!a.describe().name);
  chk(n + ' says what it does NOT carry', () => {
    const d = a.describe();
    return Array.isArray(d.not_carried) || d.implemented === false || !!d.blocking;
  });
  chk(n + ' may never delete', a.deletionPolicy && a.deletionPolicy.mayDelete === false);
  chk(n + ' explains why it may never delete', /not evidence/.test(a.deletionPolicy.reason));
});

/* the non-commercial source is labelled at the adapter, not just in SQL */
chk('the archive adapter states its non-commercial licence', /CC BY-NC-SA/.test(ARCHIVE.licence_note));
chk('and says it must be replaced before a paid surface ships', /before any paid tennis surface/.test(ARCHIVE.licence_note));
eq('the archive does not claim to carry doubles', ARCHIVE.capabilities.doubles, false);
eq('the archive does not claim an exact start time', ARCHIVE.capabilities.exact_start_time, false);
eq('but it does carry pre-match features', ARCHIVE.capabilities.pre_match_features, true);
eq('the scoreboard does not claim pre-match ratings', ESPN.capabilities.pre_match_features, false);
eq('the weather adapter does not claim a live score', WX.capabilities.live_score, false);

/* ── 2. SHAPE VALIDATION ──────────────────────────────────────────────── */
const goodOdds = { source_key: 'odds_api', match_ref: 'espn:1', sportsbook: 'dk',
  market_type: 'match_winner', selection: 'A', captured_at: new Date().toISOString() };
chk('a complete odds row validates', ODDS.validate(goodOdds).ok);
const badOdds = Object.assign({}, goodOdds); delete badOdds.captured_at;
chk('an incomplete odds row does not', !ODDS.validate(badOdds).ok);
chk('and names exactly what is missing', ODDS.validate(badOdds).missing.indexOf('captured_at') >= 0);
chk('an unknown key is reported rather than silently accepted',
    ODDS.validate(Object.assign({ nonsense: 1 }, goodOdds)).unknown.indexOf('nonsense') >= 0);
chk('unmapped and raw_ref are always allowed',
    ODDS.validate(Object.assign({ unmapped: [], raw_ref: {} }, goodOdds)).unknown.length === 0);

/* ── 3. THE CURSOR AND ITS OVERLAP ────────────────────────────────────── */
const now = new Date('2026-09-19T12:00:00Z');
const w = P.nextWindow('live_results', new Date('2026-09-19T00:00:00Z'), now);
chk('the window reaches BACK by the overlap', w.from < new Date('2026-09-19T00:00:00Z'));
eq('the results overlap is 48 hours', w.overlap_hours, 48);
eq('rankings reach back further, because they are republished', P.DEFAULT_OVERLAP_HOURS.rankings, 24 * 8);
chk('an odds window is short, because a price is a moment', P.DEFAULT_OVERLAP_HOURS.odds <= 12);
const cold = P.nextWindow('live_results', null, now);
chk('a cold start is flagged rather than guessed at', cold.cold_start === true);
eq('and it does not invent a start date', cold.from, null);

/* ── 4. CONFLICT: PRIORITY DECIDES, THE LOSER IS KEPT ─────────────────── */
chk('a licensed feed outranks the archive', P.priorityOf('licensed_feed') > P.priorityOf('archive'));
chk('the scoreboard outranks the archive for live things', P.priorityOf('espn') > P.priorityOf('archive'));
chk('an unknown source ranks below everything registered', P.priorityOf('mystery') < P.priorityOf('archive'));
const c = P.resolveConflict({ source_key: 'archive', score: '6-1 6-2' },
                            { source_key: 'espn', score: '6-1 6-3' }, ['score']);
eq('the higher-priority source wins', c.winner.source_key, 'espn');
chk('and the disagreement is recorded, not discarded', !!c.conflict);
chk('with both observations in the payload',
    c.conflict.payload.a.values.score === '6-1 6-2' && c.conflict.payload.b.values.score === '6-1 6-3');
eq('and it is filed as a source conflict', c.conflict.issue_type, 'source_conflict');
const same = P.resolveConflict({ source_key: 'espn', score: '6-1', source_updated_at: '2026-01-02T00:00:00Z' },
                               { source_key: 'espn', score: '6-2', source_updated_at: '2026-01-03T00:00:00Z' }, ['score']);
eq('at equal priority the newer observation wins', same.winner.score, '6-2');
eq('no disagreement means no conflict row',
   P.resolveConflict({ source_key: 'a', score: '6-1' }, { source_key: 'b', score: '6-1' }, ['score']).conflict, null);

/* ── 5. MATERIAL CHANGE ───────────────────────────────────────────────── */
chk('a changed score is material', P.materiallyChanged({ score: '6-1' }, { score: '6-2' }).changed);
chk('a changed winner is material', P.materiallyChanged({ winner_source_id: '1' }, { winner_source_id: '2' }).changed);
chk('an identical record is a no-op', !P.materiallyChanged({ score: '6-1' }, { score: '6-1' }).changed);
chk('a field the incoming record does not carry is not a change',
    !P.materiallyChanged({ score: '6-1' }, {}).changed);
chk('a first sighting IS a change', P.materiallyChanged(null, { score: '6-1' }).changed);
chk('and the changed fields are named', P.materiallyChanged({ score: '6-1' }, { score: '6-2' }).fields[0] === 'score');

/* ── 6. THE ARCHIVE ADAPTER NORMALISES ────────────────────────────────── */
(async function () {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-prov-'));
  const f = path.join(dir, 'a.csv');
  fs.writeFileSync(f,
    'tourney_id,tourney_name,surface,tourney_date,match_num,winner_id,winner_name,loser_id,loser_name,score,round,tour,best_of,match_uid\n' +
    '2023-1,"Queen\'s Club, London",Grass,2023-06-19,1,100,A Player,200,B Player,6-4 7-6(3),F,ATP,3,ATP_2023-1_1_100_200\n');
  const rows = [];
  for await (const r of ARCHIVE.read({ file: f })) rows.push(r);
  eq('one source row becomes one normalised match', rows.length, 1);
  eq('a quoted venue name with a comma survives', rows[0].tourney_name, "Queen's Club, London");
  eq('the surface is normalised', rows[0].surface, 'grass');
  eq('the tour is normalised', rows[0].tour, 'ATP');
  eq('a tiebreak score is carried whole', rows[0].score, '6-4 7-6(3)');
  eq('the adapter exposes no provider field names', Object.keys(rows[0]).filter(k => /^w_|^l_|1stIn/.test(k)), []);
  chk('the source row id is kept as provenance only', rows[0].raw_ref && rows[0].raw_ref.match_uid);
  fs.rmSync(dir, { recursive: true, force: true });

  /* ── 7. THE WEATHER ADAPTER ─────────────────────────────────────────── */
  const url = WX.url({ latitude: 48.8, longitude: 2.3, start_date: '2024-05-26', end_date: '2024-06-09', timezone: 'Europe/Paris' });
  chk('the weather URL names the venue and the window', /latitude=48.8/.test(url) && /start_date=2024-05-26/.test(url));
  chk('and asks for daily reanalysis', /daily=/.test(url));
  const wx = WX.normalise({ daily: { time: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    temperature_2m_mean: [70, 72, 68, 71, 69, 70, 71], precipitation_sum: [0, 0.1, 0, 0, 0, 0, 0] } },
    { venue_id: 'v', tournament_id: 't', start_date: '2024-05-26', end_date: '2024-06-01', resolution_confidence: 'high' });
  eq('weather is a tournament-week profile, always', wx.temporal_precision, 'tournament_week');
  eq('seven covered days is usable', wx.quality, 'usable');
  eq('a two-day window is not', WX.normalise({ daily: { time: ['a', 'b'] } },
     { venue_id: 'v', start_date: 'x', resolution_confidence: 'high' }).quality, 'unusable');
  eq('an empty payload is unusable and names what was missing',
     WX.normalise({}, { venue_id: 'v', start_date: 'x' }).unmapped[0], 'daily');
  chk('the free weather tier is declared non-commercial', /NON-COMMERCIAL/i.test(WX.describe().licence));
  eq('and the commercial credential is named for later', WX.commercial_credential, 'OPEN_METEO_API_KEY');
  chk('indoor venues are excluded by design', WX.describe().not_carried.some(x => /indoor/i.test(x)));

  /* ── 8. THE LICENSED SLOT BLOCKS NOTHING ────────────────────────────── */
  eq('the licensed adapter is not implemented', LICENSED.implemented, false);
  eq('and is not ready without its credentials', LICENSED.ready({}), false);
  eq('which it names', LICENSED.missingCredentials({}).sort(), ['TENNIS_FEED_API_KEY', 'TENNIS_FEED_BASE_URL']);
  eq('and it is ready once they exist',
     LICENSED.ready({ TENNIS_FEED_API_KEY: 'k', TENNIS_FEED_BASE_URL: 'u' }), true);
  chk('it outranks the archive, so it wins a disagreement the day it arrives',
      LICENSED.priority > ARCHIVE.priority);
  let threw = null;
  try { await LICENSED.fixtures(); } catch (e) { threw = e; }
  chk('calling it fails loudly', !!threw);
  chk('with instructions rather than a stack trace', /not implemented/.test(threw.message) && /tennis.source_licenses/.test(threw.message));
  chk('and it states plainly that it blocks nothing', /^nothing\b/i.test(LICENSED.describe().blocking));
  chk('no other tennis module imports it', () => {
    const fs2 = require('fs'), path2 = require('path');
    const dir2 = path2.join(__dirname);
    /* the test files are allowed to name it; no PIPELINE file may */
    const files = fs2.readdirSync(dir2).filter(x => /\.js$/.test(x) && !/\.test\.js$/.test(x));
    return files.every(x => fs2.readFileSync(path2.join(dir2, x), 'utf8').indexOf('licensed_feed') < 0);
  });

  /* ── 9. THE ODDS ADAPTER DE-VIGS ONLY A REAL PAIR ───────────────────── */
  const t = new Date().toISOString();
  const pair = [
    { match_ref: 'm1', sportsbook: 'dk', market_type: 'match_winner', line: null, captured_at: t, implied_prob: 0.55 },
    { match_ref: 'm1', sportsbook: 'dk', market_type: 'match_winner', line: null, captured_at: t, implied_prob: 0.50 }
  ];
  ODDS.devig(pair);
  chk('a two-way market is de-vigged', pair[0].no_vig_prob != null);
  chk('and normalises to one', Math.abs(pair[0].no_vig_prob + pair[1].no_vig_prob - 1) < 1e-9);
  const lone = [{ match_ref: 'm2', sportsbook: 'dk', market_type: 'match_winner', line: null, captured_at: t, implied_prob: 0.55 }];
  ODDS.devig(lone);
  eq('a one-sided quote is never de-vigged', lone[0].no_vig_prob, null);

  if (fail) {
    console.log('FAIL | tennis providers | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach(x => console.log('     | ' + x));
    process.exit(1);
  }
  console.log('PASS | tennis providers | ' + pass + ' assertions');
})();
