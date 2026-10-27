#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — the trust audit's contracts. docs/cfb-validation/TRUST.md

   Synthetic games for the arithmetic and the time rules (sign convention, a
   final counted only after the game, a quote only before the start and the
   audit's moment, a team's earlier weeks only), then the committed record,
   slate and quote ledger: every upcoming game audited, its terms adding up to
   its margin, its gap the margin minus the line, and nothing written.

   Run: node football/cfb_validation/trust.test.js
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const T = require(path.join(__dirname, 'trust.js'));
const GG = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function section(t) { console.log('\n== ' + t); }
const H = 3600e3;

/* ======================================================================= */
section('1. the season rows: home margins, graded games only, nothing after the moment');
{
  const rec = { games: {
    a: { game_id: 'a', week: 2, kickoff: '2026-09-05T20:00:00Z', home: 'H', away: 'A', home_division: 'fbs', away_division: 'fbs',
      pick: { home_line: -7, model_version: 'v' }, close: { home_line: -3.5 }, final: { home_score: 24, away_score: 20 } },
    b: { game_id: 'b', week: 2, kickoff: '2026-09-05T20:00:00Z', home: 'H2', away: 'F', home_division: 'fbs', away_division: 'fcs',
      pick: { home_line: -30 }, close: { home_line: -35 }, final: { home_score: 50, away_score: 3 } },
    nopick: { game_id: 'c', week: 2, kickoff: '2026-09-05T20:00:00Z', home: 'X', away: 'Y', pick: null, close: { home_line: -1 }, final: { home_score: 1, away_score: 0 } },
    noclose: { game_id: 'd', week: 2, kickoff: '2026-09-05T20:00:00Z', home: 'X', away: 'Y', pick: { home_line: -1 }, close: null, final: { home_score: 1, away_score: 0 } },
    late: { game_id: 'e', week: 3, kickoff: '2026-09-12T20:00:00Z', home: 'X', away: 'Y', home_division: 'fbs', away_division: 'fbs',
      pick: { home_line: -1 }, close: { home_line: -1 }, final: { home_score: 1, away_score: 0 } }
  } };
  const now = Date.parse('2026-09-12T22:00:00Z'); /* 2 h after game e: its final does not count yet */
  const rows = T.seasonRows(rec, now);
  chk('only games with a pick, a close and a final, kicked off ' + T.FINAL_AFTER_HOURS + ' h before the moment', rows.map((x) => x.id).join() === 'a,b', rows.map((x) => x.id));
  const a = rows.find((x) => x.id === 'a');
  chk('a book home line is negated once: home −7 is a +7 home margin', a.model === 7 && a.close === 3.5 && a.actual === 4, a);
  chk('FBS vs FCS is marked', rows.find((x) => x.id === 'b').fbs === false && a.fbs === true);
  chk('…and game e counts once its final is ' + T.FINAL_AFTER_HOURS + ' h old', T.seasonRows(rec, Date.parse('2026-09-13T00:00:00Z')).some((x) => x.id === 'e'));
}

section('2. EdgeDesk against the close');
{
  const rows = [
    { model: 7, close: 3, actual: 10 },   /* EdgeDesk nearer; its side (home) wins */
    { model: 7, close: 3, actual: 0 },    /* close nearer; its side loses */
    { model: 2, close: 2, actual: 5 },    /* a tie on error; no side */
    { model: -4, close: -1, actual: -1 }  /* close nearer; side (away) pushes */
  ];
  const s = T.vsMarket(rows);
  chk('errors are mean absolute misses', s.model_mae === 4 && s.close_mae === 3.25, s);
  chk('who finished nearer, ties apart', s.model_nearer === 1 && s.close_nearer === 2 && s.ties === 1, s);
  chk('EdgeDesk’s side against the close: won, lost, pushed; equal numbers take no side', s.side_vs_close.won === 1 && s.side_vs_close.lost === 1 && s.side_vs_close.push === 1, s.side_vs_close);
  const xs = [-3, -1, 0, 2, 4, 5], ys = xs.map((x) => 0.5 * x);
  const f = T.ols(xs, ys);
  chk('an exact line gives its slope and no error', f.slope === 0.5 && f.se === 0, f);
  chk('too few points measure nothing', T.ols([1, 2], [1, 2]).slope === null);
  chk('a disagreement is informative only when its interval sits above 0',
    T.vsMarket(xs.map((x, i) => ({ model: x, close: 0, actual: ys[i] }))).disagreement_informative === true
    && T.vsMarket([{ model: 1, close: 0, actual: 1 }, { model: 2, close: 0, actual: -3 }, { model: 3, close: 0, actual: 2 }, { model: 4, close: 0, actual: -1 }]).disagreement_informative === false);
  chk('gap buckets: 1.5 opens the second, 7 the last, a negative gap by its size', T.bucketOf(1.49) === 0 && T.bucketOf(1.5) === 1 && T.bucketOf(-6.9) === 3 && T.bucketOf(7) === 4 && T.bucketOf(40) === 4);
  const bg = T.byGap([{ model: 1, close: 0, actual: 0 }, { model: 0, close: 8, actual: 8 }]);
  chk('the record by gap counts each game once, in its own bucket', bg.length === T.GAP_BUCKETS.length && bg[0].n === 1 && bg[4].n === 1 && bg[4].close_nearer === 1 && bg.reduce((a, b) => a + b.n, 0) === 2, bg);
}

section('3. past weeks: a team’s EARLIER misses only');
{
  /* weeks 1–2 build each team's history; week 3 is tested. After week 2: A missed +10 twice,
     C −10 twice, B and D once each way (mean 0). */
  const g = (week, home, away, model, actual) => ({ week, home, away, model, close: model, actual, fbs: true });
  const hist = [g(1, 'A', 'B', 0, 10), g(1, 'C', 'D', 0, -10), g(2, 'A', 'D', 0, 10), g(2, 'C', 'B', 0, -10)];
  /* each week-3 miss repeats the teams' earlier misses exactly: A − C = +20, B − D = 0 */
  const wk3 = [g(3, 'A', 'C', 0, 20), g(3, 'B', 'D', 0, 0), g(3, 'D', 'B', 0, 0)];
  const pw = T.pastWeeks(hist.concat(wk3));
  chk('only games whose teams have ' + pw.min_prior_games + '+ earlier games are tested', pw.earlier_misses.n === 3, pw.earlier_misses);
  chk('a miss that repeats the earlier ones exactly has slope 1 and carries over', pw.earlier_misses.slope === 1 && pw.earlier_misses.se === 0 && pw.earlier_misses.carries_over === true, pw.earlier_misses);
  /* a game read in the same week must not reach another's history: absorbing as it goes would make the order matter */
  const extra = g(3, 'A', 'D', 0, -100);
  const fwd = T.pastWeeks(hist.concat([extra], wk3)), rev = T.pastWeeks(hist.concat(wk3.slice().reverse(), [extra]));
  chk('a team’s history is its EARLIER weeks only: the order of a week’s games changes nothing', JSON.stringify(fwd) === JSON.stringify(rev) && fwd.earlier_misses.n === 4, [fwd.earlier_misses, rev.earlier_misses]);
  const fcs = T.pastWeeks(hist.concat(wk3).map((x) => Object.assign({}, x, { fbs: x.week < 3 })));
  chk('only FBS-vs-FBS games are tested', fcs.earlier_misses.n === 0, fcs.earlier_misses);
}

section('4. a team’s season, from its own side');
{
  const rows = [
    { id: '1', week: 2, home: 'H', away: 'A', neutral: false, fbs: true, model: 7, close: 3, actual: 10 },
    { id: '2', week: 3, home: 'A', away: 'H', neutral: false, fbs: true, model: 2, close: -1, actual: -4 },
    { id: '3', week: 4, home: 'H', away: 'F', neutral: false, fbs: false, model: 30, close: 40, actual: 45 }
  ];
  const t = T.teamSeasons(rows);
  chk('the away side reads every margin flipped', t.H.games[1].model === -2 && t.H.games[1].close === 1 && t.H.games[1].actual === 4 && t.H.games[1].site === 'away', t.H.games[1]);
  chk('the summary reads FBS opponents only, and counts the FCS games it left out', t.H.n === 2 && t.H.fcs_games === 1 && t.H.games.length === 3, t.H);
  chk('lean = EdgeDesk − close, result = final − close, from the team’s side', t.H.lean_vs_close === 0.5 && t.H.result_vs_close === 5 && t.A.lean_vs_close === -0.5, [t.H, t.A]);
}

section('5. quotes: before the start, by the moment, the latest');
{
  const st = '2026-10-27T23:00:00Z', q = (cap, pt, extra) => Object.assign({ event_key: 'CFB|1', start_utc: st, captured_at: cap, book: 'DK', spread: { home_point: pt }, total: { point: 50 } }, extra || {});
  const Q = [q('2026-10-26T10:00:00Z', 2.5), q('2026-10-27T10:00:00Z', -1.5), q('2026-10-27T12:00:00Z', 1.5), q('2026-10-27T23:00:00Z', 9), q('2026-10-27T11:00:00Z', null)];
  const at = T.latestQuotes(Q, Date.parse('2026-10-27T11:30:00Z'));
  chk('the latest quote captured by the moment', at['CFB|1'].home_point === -1.5 && at['CFB|1'].market_margin === 1.5, at['CFB|1']);
  chk('a quote at or after the start never counts', T.latestQuotes(Q, Date.parse('2026-10-28T03:00:00Z'))['CFB|1'].home_point === 1.5);
  chk('a quote with no spread is skipped', T.latestQuotes([q('2026-10-27T11:00:00Z', null)], Date.parse('2026-10-27T12:00:00Z'))['CFB|1'] === undefined);
}

section('6. one game: the gap, the terms behind it, the flags and the reads');
{
  /* SHSU @ MOST as published on 2026-10-27 (football/fbs/slate.json), and the 4.5 line */
  const g = { game_id: '401871072', week: 9, kickoff: '2026-10-28T00:00:00.000Z', home_team: 'Missouri State', away_team: 'Sam Houston', model_status: 'PREDICTED',
    model_home_margin: 6.65, v1: { model_home_margin_exact: 6.652975652727075 },
    disagreement_inputs: { projection: { components: { rating: 2.10910111483566, hfa: 2.8, qb: 0, matchup: 1.7438745378914149 },
      rating_detail: { home_carried: -13.819454875726688, home_fresh: -24.73354689883049, away_carried: -17.982077856991996, away_fresh: -23.762365214021678, prior_weight: 0.6, home_gp: 7, away_gp: 7 } } } };
  const quote = { book: 'DraftKings', captured_at: '2026-10-27T10:55:18.563Z', home_point: -4.5, market_margin: 4.5, total: 50.5 };
  const MX = { status_text: 'In the number, held-out gain not significant', result: 'MAE +0.037 better with it (95% CI −0.02 to +0.09, p = 0.20; better in 4 of 4 seasons); weight k 0.84' };
  const ctx = { teams: { 'Missouri State': { team: 'Missouri State', n: 5, fcs_games: 1, lean_vs_close: 2.3, result_vs_close: -3.7, model_mae: 13.3, close_mae: 14.1, games: [] } },
    byGap: T.byGap([{ model: 2, close: 0, actual: 0 }]), factors: { matchup: MX } };
  const a = T.gameAudit(g, quote, ctx);
  chk('the gap is the unrounded margin minus the line, toward the team EdgeDesk likes more', a.gap === 2.153 && a.gap_toward === 'Missouri State' && a.verdict === 'DISAGREES', a);
  chk('the terms add up to the margin, the zero term left out', a.terms_reconcile && a.terms.map((t) => t.term).join() === 'hfa,rating,matchup', a.terms);
  chk('the rating blend reconciles: 60% long run, 40% this season', a.rating.blend_reconciles && a.rating.long_run === 4.163 && a.rating.this_season === -0.971, a.rating);
  chk('this season’s games alone: the margin with that rating, and its gap to the line', a.rating.this_season_margin === 3.573 && a.rating.this_season_gap === -0.927, a.rating);
  chk('flags: the matchup term carries the gap, and so does the long-run track', a.flags.join() === 'MATCHUP_TERM_CARRIES_GAP,LONG_RUN_TRACK_CARRIES_GAP', a.flags);
  chk('the season record at this gap size is attached', a.season_at_gap && a.season_at_gap.label === '1.5–3 pts' && a.season_at_gap.n === 1, a.season_at_gap);
  const txt = a.read.join(' ');
  chk('the reads print the audit’s own numbers, rounded as the graphic rounds them', /Missouri State by 6\.7/.test(txt) && /2\.2 pts more bullish on Missouri State/.test(txt) && /stylistic matchup Missouri State \+1\.7/.test(txt)
    && /carries 1\.7 of the 2\.2-pt gap/.test(txt) && /Sam Houston by 1\.0\) at 40%/.test(txt) && /would be 0\.9 pts, not 2\.2/.test(txt), a.read);
  chk('…name the matchup term’s held-out record without breaking its brackets', /held-out gain not significant, MAE \+0\.037 better with it \(95% CI −0\.02 to \+0\.09, p = 0\.20; better in 4 of 4 seasons\)\./.test(txt), txt);
  chk('…and never read as a pick', !GG.BANNED.test(txt) && !/\b(bet|wager|play the|take the)\b/i.test(txt), txt);
  const agree = T.gameAudit(g, Object.assign({}, quote, { home_point: -6, market_margin: 6 }), ctx);
  chk('within ' + T.AGREE_BELOW + ' pts the line and EdgeDesk agree, and nothing is flagged', agree.verdict === 'AGREES' && agree.flags.length === 0, agree);
  const none = T.gameAudit(g, null, ctx);
  chk('no captured line: NO_LINE, no gap, and it says so', none.verdict === 'NO_LINE' && none.gap === undefined && /No pregame sportsbook line/.test(none.read.join(' ')), none);
  const away = T.gameAudit(g, Object.assign({}, quote, { home_point: -9.5, market_margin: 9.5 }), ctx);
  chk('a gap the other way leans toward the visitor, and the home-side matchup term does not carry it', away.gap_toward === 'Sam Houston' && away.flags.indexOf('MATCHUP_TERM_CARRIES_GAP') < 0, away);
}

/* ======================================================================= */
section('7. the committed record, slate and quotes');
{
  const files = ['record/football/cfb_2026.json', 'football/fbs/slate.json', 'performance/ledger/quotes/cfb-2026.jsonl'];
  const hash = () => files.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')).join();
  const before = hash();
  const inp = T.load();
  /* a moment an hour before the slate's first game, so every slate game is upcoming */
  const first = Math.min.apply(null, inp.slate.games.map((g) => Date.parse(g.kickoff)).filter(isFinite));
  const now = first - H;
  const A = T.build(inp, now), B = T.build(T.load(), now);
  chk('the same moment gives the same audit', JSON.stringify(A) === JSON.stringify(B));
  chk('the inputs are read, never written', hash() === before);
  const predicted = inp.slate.games.filter((g) => g.model_status === 'PREDICTED' && typeof g.model_home_margin === 'number');
  chk('every predicted slate game is audited', A.games.length === predicted.length && A.games.length > 20, { audited: A.games.length, predicted: predicted.length });
  const unrec = A.games.filter((g) => !g.terms_reconcile);
  chk('every game’s engine terms add up to its margin', unrec.length === 0, unrec.slice(0, 2).map((g) => [g.game_id, g.model_margin, g.terms]));
  const blend = A.games.filter((g) => g.rating && !g.rating.blend_reconciles);
  chk('every game’s rating is its two tracks blended at the published weight', blend.length === 0, blend.slice(0, 2).map((g) => [g.game_id, g.rating]));
  const lined = A.games.filter((g) => g.market);
  chk('some games carry a captured line', lined.length > 0, lined.length);
  chk('every gap is the margin minus the line', lined.every((g) => Math.abs(g.gap - (g.model_margin - g.market.market_margin)) < 0.002));
  chk('every line was captured before the moment and the game', lined.every((g) => Date.parse(g.market.captured_at) <= now && Date.parse(g.market.captured_at) < Date.parse(g.kickoff)));
  chk('no graded game kicked off within ' + T.FINAL_AFTER_HOURS + ' h of the moment', A.season.fbs_vs_fbs.n + A.season.fbs_vs_fcs.n === A.season.graded);
  chk('the season record by gap adds up to the FBS-vs-FBS games', A.season.by_gap.reduce((s, b) => s + b.n, 0) === A.season.fbs_vs_fbs.n);
  chk('the season tests are measured on the committed record', A.season.fbs_vs_fbs.n > 100 && A.season.past_weeks.earlier_misses.slope !== null && A.season.fbs_vs_fbs.disagreement_slope.slope !== null, A.season.past_weeks);
  const md = T.markdown(A);
  chk('the report names every audited game and passes the copy rule', A.games.every((g) => md.indexOf('### ' + g.away + ' @ ' + g.home) >= 0) && !GG.BANNED.test(md));
  chk('the report says it is research only', /Research only: it changes no number, grade or label\./.test(md));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | cfb trust audit | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
