#!/usr/bin/env node
/* ===========================================================================
   THE CLOSING-LINE-VALUE REPORT (audit 2026-09-30 follow-up #5).

   One question: when EdgeDesk's pregame number disagrees with the OPENING
   line, does the market move toward EdgeDesk by the close? A model that has
   information the opener lacks should be "closed toward" more often than
   not; one that does not should sit at a coin flip. Nothing here is fitted:
   the engine's number is replayed or read as it was frozen, and scored.

   Per game (every number a HOME MARGIN, + = the home side favoured):
        side      s = sign(fair − open)          (|fair − open| < 0.5: no side)
        CLV pts   s · (close − open)             (+ = the market came to EdgeDesk)
        CLV prob  the no-push cover probability, under a distribution centred
                  on the CLOSE, of a bet on side s at the OPENING number, minus
                  the same at the closing number (≈ 0.5): the price value of
                  having taken the opener
   Reported per sample, per season and per |fair − open| bucket: games, the
   share that moved toward EdgeDesk among those that moved (with a two-sided
   binomial p against 0.5), mean CLV points (bootstrap 95% CI) and mean CLV
   probability. A sample under 100 moved games is reported and marked "too
   small to read".

   THE AUDIT'S OWN CUTS (second follow-up to the 2026-09-30 audit, item 5 as it
   was asked): cumulative gaps of 2+, 3+ and 5+ points to the opener, each split
   by the v1 regime flag (either side's team-season fires the signal the shipped
   regime curve uses, football/coaching/regime_signal.js) and by games played
   against the curve's own fitted research minimum (football/cfb_p4/
   regime_curve.js min_games_for_research). No cut is chosen here: the
   thresholds are the audit's and the minimum is the one already fitted. A
   sample whose rows carry no regime flag says so rather than splitting.

   SAMPLES
     cfb_replay   2021-2025 FBS games in the cfbfastR archive with an opener and
                  a close, EdgeDesk's number from a cold replay of the shipped
                  engine (football/cfb_p4/research/replay_rows.js). The engine's
                  hyperparameters were tuned on 2018-2021 (research/train_p4.py),
                  so 2022-2025 is its held-out window and is the headline; 2021 is
                  reported separately as in-sample for the tune. The replay's state
                  is the one at KICKOFF: it also holds other games played between
                  the opener and kickoff (the two teams' own state is unchanged).
     cfb_2026     EdgeDesk's FROZEN pregame number (record/football/cfb_2026.json
                  `first`), the earliest line the Model Lab captured for the game
                  (football/cfb_lab/ledger/2026/quotes, the Lab's opener) and the
                  record's close.
     nfl_2026     EdgeDesk's frozen number (record/football/nfl_2026.json `first`),
                  EdgeDesk's own opener ledger (football/pricing/openers_nfl.json,
                  from 2026-09-16) and the record's close. No historical NFL opener
                  archive exists in the repository or in any feed reachable from the
                  build (agreed scope: this ledger only).

     node tools/football/clv_report.js --data D            # print
     node tools/football/clv_report.js --data D --write    # football/validation/clv_report.json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.window.EDCfbP4Params;
require(path.join(ROOT, 'football', 'params.js'));
const EF = require(path.join(ROOT, 'football', 'engine.js'));

const SCHEMA = 'edgedesk_clv_report_v1';
const RC = require(path.join(ROOT, 'football', 'cfb_p4', 'regime_curve.js'));
const RULES = { min_side_gap: 0.5, buckets: [[0.5, 2], [2, 4], [4, 7], [7, null]], min_moved_to_read: 100, headline_seasons: [2022, 2025], tune_seasons: [2018, 2021],
  cfb_sigma_base: 14.633,
  /* the audit's thresholds, and the regime curve's fitted research minimum (not chosen here) */
  thresholds: [2, 3, 5], min_games_for_research: RC.min_games_for_research };
const OUT = path.join(ROOT, 'football', 'validation', 'clv_report.json');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v == null || v.slice(0, 2) === '--') ? true : v; }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

/* the price value of the opener, on a distribution centred at the close */
function coverAt(sport, centre, side, homeMargin) {
  const hc = sport === 'NFL' ? ((t) => EF.dist.coverProbSpread('nfl', centre, t))
    : Q.cfbConditionedCover(P.distributions, centre, centre, RULES.cfb_sigma_base, RULES.cfb_sigma_base);
  if (!hc) return null;
  const line = side === 'home' ? -homeMargin : homeMargin, pr = Q.sideProb(hc, side, line);
  return pr && pr.cover != null ? pr.cover : null;
}
/* one game: { fair, open, close } home margins -> its CLV (null when no side) */
function clvOf(sport, g) {
  if (num(g.fair) == null || num(g.open) == null || num(g.close) == null) return null;
  const d = g.fair - g.open;
  if (Math.abs(d) < RULES.min_side_gap) return null;
  const s = d > 0 ? 1 : -1, side = s > 0 ? 'home' : 'away';
  const pts = s * (g.close - g.open);
  const cOpen = coverAt(sport, g.close, side, g.open), cClose = coverAt(sport, g.close, side, g.close);
  return { gap: Math.abs(d), side, pts, prob: cOpen != null && cClose != null ? cOpen - cClose : null };
}
function binomTwoSided(k, n) {
  if (!n) return null;
  const z = (Math.abs(k - n / 2) - 0.5) / Math.sqrt(n / 4);
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), dd = 0.3989423 * Math.exp(-z * z / 2);
  const tail = dd * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return r4(Math.min(1, 2 * (z > 0 ? tail : 1 - tail)));
}
function bootCI(xs, reps) {
  if (xs.length < 2) return null;
  /* an exact 32-bit LCG: the earlier (seed * 1103515245 + 12345) % 2^31 lost its low bits in doubles
     and cycled after ~10,466 draws, which made every bootstrap interval too narrow */
  let seed = 20260930; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const m = [];
  for (let i = 0; i < (reps || 2000); i++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)]; m.push(s / xs.length); }
  m.sort((a, b) => a - b);
  return [r3(m[Math.floor(0.025 * m.length)]), r3(m[Math.floor(0.975 * m.length)])];
}
function summarize(list) {
  const moved = list.filter((c) => c.pts !== 0), toward = moved.filter((c) => c.pts > 0).length;
  const probs = list.map((c) => c.prob).filter((x) => x != null);
  const mean = list.length ? list.reduce((s, c) => s + c.pts, 0) / list.length : null;
  return { games: list.length, moved: moved.length, moved_toward: toward, toward_rate: moved.length ? r4(toward / moved.length) : null,
    p_two_sided: binomTwoSided(toward, moved.length), mean_clv_pts: r3(mean), mean_clv_pts_ci95: bootCI(list.map((c) => c.pts)),
    mean_clv_prob: probs.length ? r4(probs.reduce((a, b) => a + b, 0) / probs.length) : null,
    readable: moved.length >= RULES.min_moved_to_read,
    reading: moved.length < RULES.min_moved_to_read ? 'too small to read (' + moved.length + ' moved games; ' + RULES.min_moved_to_read + ' is the floor)'
      : (binomTwoSided(toward, moved.length) < 0.05 ? (toward / moved.length > 0.5 ? 'the market moved TOWARD EdgeDesk more often than chance' : 'the market moved AWAY from EdgeDesk more often than chance')
        : 'not significantly different from a coin flip') };
}
function sampleReport(sport, rows, seasonOf) {
  const scored = rows.map((g) => ({ g, c: clvOf(sport, g) })).filter((x) => x.c);
  const out = { all: summarize(scored.map((x) => x.c)), by_bucket: {}, by_season: {} };
  RULES.buckets.forEach(([lo, hi]) => {
    const k = lo + (hi == null ? '+' : '-' + hi);
    out.by_bucket[k] = summarize(scored.filter((x) => x.c.gap >= lo && (hi == null || x.c.gap < hi)).map((x) => x.c));
  });
  if (seasonOf) {
    const ss = Array.from(new Set(scored.map((x) => seasonOf(x.g)))).sort();
    ss.forEach((s) => { out.by_season[s] = summarize(scored.filter((x) => seasonOf(x.g) === s).map((x) => x.c)); });
  }
  out.by_threshold = thresholdCuts(scored);
  out.with_line_pair = rows.filter((g) => num(g.open) != null && num(g.close) != null).length;
  return out;
}
/* the audit's cuts: 2+ / 3+ / 5+ (cumulative), by regime flag and by games played */
function thresholdCuts(scored) {
  const flagKnown = (g) => g.regime && g.regime.home != null && g.regime.away != null;
  const flagged = (g) => !!(g.regime && (g.regime.home === true || g.regime.away === true));
  const gpMin = (g) => (g.games_played && num(g.games_played.home) != null && num(g.games_played.away) != null ? Math.min(g.games_played.home, g.games_played.away) : null);
  const hasRegime = scored.some((x) => x.g.regime !== undefined);
  const N = RULES.min_games_for_research;
  const out = {};
  RULES.thresholds.forEach((t) => {
    const at = scored.filter((x) => x.c.gap >= t);
    const o = { all: summarize(at.map((x) => x.c)) };
    if (!hasRegime) o.split = 'not available: this sample\u2019s rows carry no regime flag or games played';
    else {
      /* regime-flagged: either side fires; not flagged: both sides measured and neither fires; the rest is unknown and counted */
      o.regime = summarize(at.filter((x) => flagged(x.g)).map((x) => x.c));
      o.not_regime = summarize(at.filter((x) => !flagged(x.g) && flagKnown(x.g)).map((x) => x.c));
      o.regime_unknown_games = at.filter((x) => !flagged(x.g) && !flagKnown(x.g)).length;
      o['before_' + N + '_games'] = summarize(at.filter((x) => gpMin(x.g) != null && gpMin(x.g) < N).map((x) => x.c));
      o['from_' + N + '_games'] = summarize(at.filter((x) => gpMin(x.g) != null && gpMin(x.g) >= N).map((x) => x.c));
    }
    out[t + '+'] = o;
  });
  return out;
}

/* ---- the samples ---------------------------------------------------------- */
function cfbReplay() {
  const data = arg('data', null);
  if (!data) throw new Error('--data <cfbfastR cache with sched/ and out/market.csv> is required for the college replay');
  const RR = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'replay_rows.js'));
  require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  return RR.replayRows({ data, from: 2021, to: 2025, regime: true }).rows;
}
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function cfb2026() {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'cfb_2026.json'), 'utf8'));
  const dir = path.join(ROOT, 'football', 'cfb_lab', 'ledger', '2026', 'quotes');
  const first = {};
  (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /\.jsonl$/.test(f)).forEach((f) => readJsonl(path.join(dir, f)).forEach((q) => {
    if (q.market_type !== 'spread' || num(q.home_line) == null || q.is_pregame === false) return;
    const t = Date.parse(q.observed_at); if (!Number.isFinite(t)) return;
    const k = String(q.game_id); if (!first[k] || t < first[k].t) first[k] = { t, home_line: q.home_line, book: q.book };
  }));
  return Object.values(rec.games).map((g) => {
    const f = g.first || g.pick || null, o = first[String(g.game_id)] || null;
    return { game_id: g.game_id, week: g.week, fair: f && num(f.home_line) != null ? -f.home_line : null,
      open: o ? -o.home_line : null, close: g.close && num(g.close.home_line) != null ? -g.close.home_line : null,
      model_at: f ? f.at : null, open_at: o ? new Date(o.t).toISOString() : null };
  }).filter((g) => g.fair != null && (g.open_at == null || g.model_at == null || Date.parse(g.model_at) <= Date.parse(g.open_at) + 7 * 86400e3));
}
function nfl2026() {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'nfl_2026.json'), 'utf8'));
  const op = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'openers_nfl.json'), 'utf8'));
  return Object.values(rec.games).map((g) => {
    const f = g.first || g.pick || null, o = op.games[g.game_id];
    return { game_id: g.game_id, week: g.week, fair: f && num(f.home_line) != null ? -f.home_line : null,
      open: o && o.open && num(o.open.home_line) != null ? -o.open.home_line : null,
      close: g.close && num(g.close.home_line) != null ? -g.close.home_line : null };
  }).filter((g) => g.fair != null);
}

function main() {
  const replay = cfbReplay();
  const cfbHead = replay.filter((r) => r.season >= RULES.headline_seasons[0] && r.season <= RULES.headline_seasons[1]);
  const cfbTune = replay.filter((r) => r.season === 2021);
  const art = {
    schema: SCHEMA, generated_at: new Date().toISOString(), rules: RULES,
    definition: 'side = sign(fair − open) on home margins; CLV pts = side · (close − open); CLV prob = the no-push cover probability of that side at the opening number, on a margin distribution centred at the close, minus the same at the close',
    market_is_an_input: false, fitted: 'nothing: every number is replayed or read as frozen',
    samples: {
      cfb_replay_2022_2025: Object.assign({ what: 'cold replay of the shipped engine vs the cfbfastR opener and close; the engine’s held-out window (hyperparameters tuned 2018-2021)' },
        sampleReport('CFB', cfbHead, (g) => g.season)),
      cfb_replay_2021: Object.assign({ what: 'the same, 2021: IN-SAMPLE for the engine’s hyperparameter tune (reported separately, never pooled into the headline)' },
        sampleReport('CFB', cfbTune, (g) => g.season)),
      cfb_2026: Object.assign({ what: 'EdgeDesk’s frozen pregame number (record first), the Model Lab’s earliest captured line, the record’s close' },
        sampleReport('CFB', cfb2026(), (g) => 'week ' + g.week)),
      nfl_2026: Object.assign({ what: 'EdgeDesk’s frozen pregame number (record first), EdgeDesk’s own opener ledger (from 2026-09-16), the record’s close; no historical NFL opener archive exists' },
        sampleReport('NFL', nfl2026(), (g) => 'week ' + g.week))
    },
    sources: { cfb_replay: 'football/cfb_p4/research/replay_rows.js (cfbfastR schedules; betting/cfb_line_odds.csv.gz via research/build_market.py)',
      cfb_2026: 'record/football/cfb_2026.json; football/cfb_lab/ledger/2026/quotes/*.jsonl', nfl_2026: 'record/football/nfl_2026.json; football/pricing/openers_nfl.json' }
  };
  console.log(JSON.stringify(art, null, 1));
  if (arg('write', false)) { fs.writeFileSync(OUT, JSON.stringify(art, null, 1) + '\n'); console.error('[write] ' + path.relative(ROOT, OUT)); }
}
if (require.main === module) main();
module.exports = { clvOf, summarize, sampleReport, thresholdCuts, coverAt, binomTwoSided, RULES, SCHEMA };
