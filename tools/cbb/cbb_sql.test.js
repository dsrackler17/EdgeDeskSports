#!/usr/bin/env node
/* ===========================================================================
   THE GATE AND THE DERIVATION, against a real PostgreSQL.

   The schema file's own report checks that each refusal EXISTS. This checks
   that each one FIRES, which is a different claim and the one that matters.

   It also proves the part with no second source to check it against: team
   seasons are folded out of the game log inside the promote, so if that fold
   is wrong there is nothing to notice the disagreement. Every record below is
   computed by hand from games this test wrote, and compared.

   Run: node tools/cbb/cbb_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../mlb/pg_client.js');
const S = require('./stage.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_cbb_test';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, g === w, { got: g, want: w });

const conn = PG.findServer();
if (!conn) { console.log('SKIP | cbb sql | no reachable PostgreSQL server'); process.exit(0); }
if (!PG.createDatabase(conn, DB)) { console.log('SKIP | cbb sql | could not create the test database'); process.exit(0); }

const db = PG.pgClient(conn, { database: DB });
let code = 0;
try {
  db.sql('create role anon nologin; create role authenticated nologin;');
} catch (_) { /* already there */ }

function game(o) {
  return Object.assign({
    game_id: null, season: 2026, game_date: '2026-04-18', start_time: '2026-04-18T20:00Z',
    start_time_tbd: false, away_team_id: null, home_team_id: null,
    away_name: 'Away', home_name: 'Home', away_abbr: null, home_abbr: null,
    venue: null, venue_city: null, venue_state: null,
    neutral_site: false, conference_game: false,
    status_state: 'post', status_detail: 'Final', completed: true,
    away_score: 1, home_score: 2, innings: 9, away_rank: null, home_rank: null,
    notes: null, seen_by: ['scoreboard'],
  }, o);
}

(async function main() {
  try {
    const r = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
    if (!r.ok) { console.log('FAIL | college_baseball.sql did not apply'); console.error(r.stderr.split('\n').slice(0, 10).join('\n')); throw new Error('apply'); }
    ok('the schema applies to a real PostgreSQL', true);
    ok('…and its own report is all ok', !/CHECK THIS/.test(r.stdout || ''), (r.stdout || '').split('\n').filter((l) => /CHECK THIS/.test(l)).slice(0, 3));

    /* ══ a clean import promotes ═══════════════════════════════════════════ */
    console.log('the gate');
    const teams = [
      { team_id: '1', name: 'Alpha', short_name: 'Alpha', abbreviation: 'ALP', slug: 'alpha',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null,
        first_seen_season: 2026, last_seen_season: 2026 },
      { team_id: '2', name: 'Beta', short_name: 'Beta', abbreviation: 'BET', slug: 'beta',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null,
        first_seen_season: 2026, last_seen_season: 2026 },
    ];
    /* Alpha: beats Beta 5-1 at home, loses 2-3 away, wins 7-0 at a neutral site.
       Hand-computed: 2-1, 14 for, 4 against, home 1-0, away 0-1, neutral 1-0. */
    const games = [
      game({ game_id: 'g1', game_date: '2026-04-01', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha', away_name: 'Beta', home_score: 5, away_score: 1, conference_game: true }),
      game({ game_id: 'g2', game_date: '2026-04-02', home_team_id: '2', away_team_id: '1',
             home_name: 'Beta', away_name: 'Alpha', home_score: 3, away_score: 2, conference_game: true }),
      game({ game_id: 'g3', game_date: '2026-04-03', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha', away_name: 'Beta', home_score: 7, away_score: 0, neutral_site: true }),
      /* a scheduled game, no score — counted as scheduled, never as a result */
      game({ game_id: 'g4', game_date: '2026-05-01', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha', away_name: 'Beta', home_score: null, away_score: null,
             completed: false, status_state: 'pre', status_detail: 'Scheduled' }),
    ];
    let v = await S.stageAndPromote(db, 'imp-1', { season: 2026, from: '2026-04-01', through: '2026-05-01', games, teams, log: () => {} });
    ok('a clean import promotes', v && v.ok === true, v);
    eq('…with every game', Number(db.rows('select count(*) n from cbb.games')[0].n), 4);
    eq('…and the teams', Number(db.rows('select count(*) n from cbb.teams')[0].n), 2);

    /* ══ the derivation, checked against arithmetic done by hand ═══════════ */
    console.log('team seasons, folded out of the game log');
    const a = db.rows("select * from cbb.team_seasons where team_id='1'")[0];
    eq('Alpha played three completed games', Number(a.games), 3);
    eq('…won two', Number(a.wins), 2);
    eq('…lost one', Number(a.losses), 1);
    eq('…scored 14', Number(a.runs_for), 14);
    eq('…allowed 4', Number(a.runs_against), 4);
    eq('…at home, one win', Number(a.home_wins), 1);
    eq('…away, one loss', Number(a.away_losses), 1);
    /* THE NEUTRAL SITE IS NOT A HOME GAME. A club's home record is a real
       thing a reader reasons about, and college baseball plays a lot of
       tournament games on neutral ground. */
    eq('…the neutral-site win is not counted as a home win', Number(a.home_wins), 1);
    eq('…it is counted as neutral', Number(a.neutral_wins), 1);
    eq('…conference record counts only conference games', Number(a.conf_wins), 1);
    eq('…and its conference loss', Number(a.conf_losses), 1);
    eq('the unplayed game is counted as scheduled, not as a result', Number(a.scheduled_games), 1);
    ok('…so it is absent from the record', Number(a.wins) + Number(a.losses) === 3);
    ok('runs per game is the runs over the games', Math.abs(Number(a.runs_per_game) - 14 / 3) < 1e-9, a.runs_per_game);
    ok('pythagorean expectation is computed and sane',
      Number(a.pythag_win_pct) > 0.5 && Number(a.pythag_win_pct) < 1, a.pythag_win_pct);
    const b = db.rows("select * from cbb.team_seasons where team_id='2'")[0];
    eq('Beta is the mirror image: one win', Number(b.wins), 1);
    eq('…two losses', Number(b.losses), 2);
    eq('…scored what Alpha allowed', Number(b.runs_for), 4);
    eq('…allowed what Alpha scored', Number(b.runs_against), 14);

    /* ══ every refusal, fired ══════════════════════════════════════════════ */
    console.log('the refusals');
    const refuse = async (name, rows, wantCode, opts) => {
      const id = 'imp-' + Math.random().toString(36).slice(2, 8);
      const res = await S.stageAndPromote(db, id, Object.assign(
        { season: 2026, from: '2026-04-01', through: '2026-05-01', games: rows, teams: [], log: () => {} }, opts || {}));
      const codes = ((res && res.refusals) || []).map((x) => x.code);
      ok(name, res && res.ok === false && codes.indexOf(wantCode) >= 0, { got: codes, want: wantCode });
      process.exitCode = 0;   /* stage sets a failure code on refusal; that is expected here */
    };
    await refuse('an empty import is refused', [], 'EMPTY_IMPORT');
    await refuse('a duplicated game id is refused',
      [game({ game_id: 'd1' }), game({ game_id: 'd1' })], 'DUPLICATE_GAME_IDS');
    await refuse('a season that is not the date\'s year is refused',
      [game({ game_id: 'd2', season: 2025, game_date: '2026-04-18' })], 'SEASON_DATE_MISMATCH');
    await refuse('a finished game with no score is refused',
      [game({ game_id: 'd3', completed: true, away_score: null, home_score: null, status_detail: 'Final' })],
      'COMPLETED_WITHOUT_SCORE');
    ok('…but a postponed game with no score is allowed through', await (async () => {
      const res = await S.stageAndPromote(db, 'imp-pp', { season: 2026, from: '2026-04-01', through: '2026-05-01',
        games: games.concat([game({ game_id: 'pp', completed: true, away_score: null, home_score: null,
          status_detail: 'Postponed' })]), teams, log: () => {} });
      process.exitCode = 0;
      return res && res.ok === true;
    })());

    /* ══ THE ONE THAT EXISTS BECAUSE OF A MEASUREMENT ══════════════════════
       The source answers 200 with an empty slate when hurried. Promoting that
       would delete a day of games and look like a quiet Tuesday. */
    console.log('the shrinkage refusal — the reason this gate exists');
    const before = Number(db.rows('select count(*) n from cbb.games')[0].n);
    await refuse('an import covering the same span with far fewer games is refused',
      [game({ game_id: 'g1', game_date: '2026-04-01' })], 'IMPORT_SHRANK');
    eq('…and the card a reader can see is untouched',
      Number(db.rows('select count(*) n from cbb.games')[0].n), before);
    const forced = await S.stageAndPromote(db, 'imp-forced', { season: 2026, from: '2026-04-01',
      through: '2026-05-01', games: [game({ game_id: 'g1', game_date: '2026-04-01' })], teams,
      allowShrink: true, log: () => {} });
    ok('…unless a human says in as many words that the loss is real', forced && forced.ok === true, forced);
    eq('…and only then does the card shrink', Number(db.rows('select count(*) n from cbb.games')[0].n), 1);

    /* ══ access ════════════════════════════════════════════════════════════ */
    console.log('access');
    const denied = (sql) => { try { db.sql(`set role anon; ${sql}; reset role;`); db.sql('reset role'); return false; }
                              catch (_) { try { db.sql('reset role'); } catch (__) {} return true; } };
    ok('anon may read the card', (() => { db.sql('set role anon'); const n = db.rows('select count(*) n from cbb.games')[0].n; db.sql('reset role'); return n != null; })());
    ok('anon may NOT write the card', denied("insert into cbb.games (game_id,season,game_date,away_name,home_name) values ('x',2026,'2026-04-18','a','b')"));
    ok('anon may NOT read staging', denied('select count(*) from cbb.stg_games'));
    ok('anon may NOT promote an import', denied("select cbb.promote_cbb_import('x')"));
    ok('anon may NOT rebuild the derived table', denied('select cbb.rebuild_team_seasons()'));
  } catch (e) {
    console.log('FAIL | cbb sql | ' + (e && e.stack || e));
    fail++;
  } finally {
    try { db.close(); } catch (_) {}
    PG.dropDatabase(conn, DB);
  }
  console.log(fail === 0 ? `ALL GREEN ${pass} passed, 0 failed` : `FAILED ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log(`PASS | cbb schema and gate | ${pass} assertions against a real PostgreSQL`);
  process.exit(fail === 0 ? 0 : 1);
})();
