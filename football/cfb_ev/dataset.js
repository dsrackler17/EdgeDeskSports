#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the calibration dataset (docs/edgedesk-ev/DESIGN.md §§6-7).

   One row per game × checkpoint: the champion's RAW probability at the market
   line, computed through the exact production path the game page uses, and
   what happened.

     raw probability   football/cfb_terminal/build.js v1Dist (the champion's
                       empirical margin PMF, conditioned on the market margin
                       exactly as the build conditions it, re-centred on
                       EdgeDesk's fair margin, stretched to the game's sigma)
                       -> lib/edgedesk_read.js buildCurve -> sideProb.
                       Nothing here re-derives a distribution.
     fair margin       the SHIPPED champion engine (football/cfb_p4/engine.js,
                       edgedesk_cfb_p4_v1.0.0), replayed COLD at the Tuesday
                       12:00 UTC freeze before each kickoff by
                       football/cfb_p4/research/disagreement_replay.js. The
                       market never enters it.
     2026 holdout      the numbers EdgeDesk actually published (the frozen
                       record, record/football/cfb_2026.json), never a replay.

   WINDOWS (what each row may be used for)
     IN_SAMPLE   2015-2021: the champion's margin PMF (2006-2021) and its
                 tuning layers (2014-2021) saw these seasons. Diagnostics only;
                 never a calibration fit or a claim.
     OOS         2022-2025: no layer of the champion and none of its PMF was
                 fitted here. The tournament's walk-forward folds live here.
     HOLDOUT     2026 weeks already graded: the published record. Read once by
                 the tournament (football/cfb_ev/tournament.js --read-holdout).

   Usage
     node football/cfb_ev/dataset.js --replay DIR/out/disagreement_replay.jsonl \
          --data DIR            # DIR holds betting/cfb_line_odds.csv.gz and sched/
   Writes football/cfb_ev/data/cfb_ev_calibration_rows_v1.csv.gz and its manifest.
   The raw inputs are public (sportsdataverse/cfbfastR-data); the replay is
   reproduced with:
     node football/cfb_p4/research/disagreement_eff.js --data DIR 2014 … 2025
     node football/cfb_p4/research/disagreement_replay.js --data DIR --from 2015 --to 2025 --replay-from 2007
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const B = require(path.join(ROOT, 'football', 'cfb_terminal', 'build.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
function num(x) { if (x === null || x === undefined || x === '' || x === 'NA') return null; const n = Number(x); return isFinite(n) ? n : null; }
function r(x, k) { if (num(x) == null) return null; const m = Math.pow(10, k == null ? 6 : k); return Math.round(x * m) / m; }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

const OUT = path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.csv.gz');
const MANIFEST = path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.manifest.json');
const OFFSETS = [-7, -3, 3, 7];               /* alternate-line domain rows: the home line moved by these points */

/* the production curve for one game at one conditioning market margin */
function curveFor(fair, sigma, condMargin) {
  const dist = B.v1Dist(fair, sigma, condMargin);
  const center = condMargin != null ? condMargin : fair;
  const hw = Math.min(60, Math.max(30, Math.ceil(Math.abs(fair - center)) + 24));
  return { curve: RD.buildCurve(dist.cover, center, hw, { basis: dist.basis, conditioned_on: dist.conditioned_on_market_margin }), conditioned: dist.conditioned_on_market_margin != null };
}
function half(x) { return Math.round(x * 2) / 2; }

/* archive games whose home/away ids are swapped against the schedule
   (build_market.py F-11): their side-labelled lines are not used */
function swappedIds(dataDir) {
  const out = new Set();
  if (!dataDir) return out;
  const sched = {};
  const sd = path.join(dataDir, 'sched');
  if (fs.existsSync(sd)) fs.readdirSync(sd).forEach((f) => {
    const t = fs.readFileSync(path.join(sd, f), 'utf8').split('\n');
    const h = t[0].replace(/"/g, '').split(','), gi = h.indexOf('game_id'), hi = h.indexOf('home_id'), ai = h.indexOf('away_id');
    t.slice(1).forEach((l) => { const c = l.replace(/"/g, '').split(','); if (c[gi]) sched[String(num(c[gi]))] = [String(num(c[hi])), String(num(c[ai]))]; });
  });
  const f = path.join(dataDir, 'betting', 'cfb_line_odds.csv.gz');
  if (!fs.existsSync(f)) return out;
  const L = zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n');
  const h = L[0].split(','), gi = h.indexOf('game_id'), hi = h.indexOf('home_team_id'), ai = h.indexOf('away_team_id');
  for (let i = 1; i < L.length; i++) {
    const c = L[i].split(',');
    if (c.length < h.length) continue;
    const g = String(num(c[gi])), s = sched[g];
    if (!s) continue;
    const ah = String(num(c[hi])), aa = String(num(c[ai]));
    if (ah === s[1] && aa === s[0]) out.add(g);
  }
  return out;
}

function rowFor(base, fair, sigma, condMargin, homeLine, checkpoint, finalMargin) {
  const cv = curveFor(fair, sigma, condMargin);
  const p = cv.curve ? RD.sideProb(cv.curve, 'home', homeLine) : null;
  if (!p) return null;
  const c = finalMargin + homeLine;                 /* home covers when margin + home line > 0 */
  return Object.assign({}, base, {
    checkpoint: checkpoint, market_home_line: homeLine, cond_margin: condMargin, pmf_conditioned: cv.conditioned ? 1 : 0,
    p_win: r(p.win), p_push: r(p.push), p_loss: r(p.loss), p_cover: r(p.cover),
    gap_pts: r(fair - (-homeLine), 3), abs_line: Math.abs(homeLine),
    y_cover: c > 0 ? 1 : (c < 0 ? 0 : ''), y_push: c === 0 ? 1 : 0
  });
}

function main() {
  const replay = arg('replay');
  const dataDir = arg('data');
  if (!replay || !fs.existsSync(replay)) { console.error('need --replay <disagreement_replay.jsonl>'); process.exit(2); }
  const swapped = swappedIds(dataDir);
  const rows = [];
  let dropped = { not_fbs: 0, not_final: 0, no_close: 0, swapped: 0, opener_fault: 0, no_curve: 0 };
  fs.readFileSync(replay, 'utf8').split('\n').filter(Boolean).forEach((l) => {
    const g = JSON.parse(l);
    if (!(g.home_fbs && g.away_fbs)) { dropped.not_fbs++; return; }
    if (!g.completed || num(g.final_margin) == null) { dropped.not_final++; return; }
    if (!g.mkt || num(g.mkt.close_home_line) == null) { dropped.no_close++; return; }
    if (swapped.has(String(g.game_id))) { dropped.swapped++; return; }
    const fair = num(g.fair), sigma = num(g.sigma);
    if (fair == null || sigma == null) { dropped.no_curve++; return; }
    const closeRaw = num(g.mkt.close_home_line), close = half(closeRaw);
    let openRaw = num(g.mkt.open_home_line);
    /* the opener-fault rule (football/validation forensics): an impossible opener is dropped, never guessed */
    if (openRaw != null && (Math.abs(openRaw) > 60 || Math.abs(openRaw - closeRaw) > 17)) { dropped.opener_fault++; openRaw = null; }
    const open = openRaw != null ? half(openRaw) : null;
    const ens = g.v2 && num(g.v2.ens) != null ? g.v2.ens : null;
    const base = {
      window: g.season <= 2021 ? 'IN_SAMPLE' : 'OOS', season: g.season, week: g.week, season_type: g.season_type || 'regular',
      game_id: String(g.game_id), kickoff: g.kickoff, prediction_ts: g.prediction_ts, home: g.home, away: g.away,
      neutral: g.neutral_site ? 1 : 0, conference_game: g.conference_game ? 1 : 0,
      fair_margin: r(fair, 3), sigma: r(sigma, 3), sigma_basis: 'replay engine sigma', p_home_ml: r(num(g.p_home), 4),
      close_home_line: close, open_home_line: open, close_books: g.mkt.close_books || 0,
      final_margin: g.final_margin, y_home_win: g.final_margin > 0 ? 1 : (g.final_margin < 0 ? 0 : ''),
      v2_ens: ens, v2_ens_sd: g.v2 ? num(g.v2.ens_sd) : null,
      favorite_flip: (Math.abs(fair) >= 0.5 && Math.abs(close) >= 0.5 && Math.sign(fair) !== Math.sign(-close)) ? 1 : 0,
      source: 'replay'
    };
    const add = (x) => { if (x) rows.push(x); else dropped.no_curve++; };
    add(rowFor(base, fair, sigma, -close, close, 'close', g.final_margin));
    if (open != null) add(rowFor(base, fair, sigma, -open, open, 'open', g.final_margin));
    if (base.window === 'OOS') OFFSETS.forEach((d) => add(rowFor(base, fair, sigma, -close, close + d, 'close_' + (d > 0 ? 'p' : 'm') + Math.abs(d), g.final_margin)));
  });

  /* THE 2026 HOLDOUT: what EdgeDesk published, graded at the close it was graded at */
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', 'cfb_2026.json'), 'utf8'));
  let hold = 0;
  Object.values(rec.games || {}).forEach((x) => {
    if (x.home_division !== 'fbs' || x.away_division !== 'fbs') return;
    if (!x.grade || x.grade.status !== 'GRADED' || !x.pick || num(x.pick.home_line) == null || !x.close || num(x.close.home_line) == null || !x.final) return;
    if (x.model_version !== 'edgedesk_cfb_p4_v1.0.0') return;
    const fair = -num(x.pick.home_line);
    const sg = B.v1Sigma({ model_home_margin: fair, model_home_win_prob: num(x.pick.home_win_prob) }, null, null);
    const close = half(num(x.close.home_line)), fm = num(x.final.home_score) - num(x.final.away_score);
    const base = { window: 'HOLDOUT_2026', season: 2026, week: x.week, season_type: 'regular', game_id: String(x.game_id), kickoff: x.kickoff, prediction_ts: x.pick.at,
      home: x.home, away: x.away, neutral: x.neutral_site ? 1 : 0, conference_game: x.matchup_type === 'conference' ? 1 : 0,
      fair_margin: r(fair, 3), sigma: r(sg.sigma, 3), sigma_basis: sg.basis, p_home_ml: r(num(x.pick.home_win_prob), 4),
      close_home_line: close, open_home_line: null, close_books: 1, final_margin: fm, y_home_win: fm > 0 ? 1 : (fm < 0 ? 0 : ''),
      v2_ens: null, v2_ens_sd: null,
      favorite_flip: (Math.abs(fair) >= 0.5 && Math.abs(close) >= 0.5 && Math.sign(fair) !== Math.sign(-close)) ? 1 : 0,
      source: 'record (' + (x.provenance || 'frozen') + ')' };
    const row = rowFor(base, fair, sg.sigma, -close, close, 'close', fm);
    if (row) { rows.push(row); hold++; }
  });

  const cols = ['window', 'source', 'season', 'week', 'season_type', 'game_id', 'kickoff', 'prediction_ts', 'home', 'away', 'neutral', 'conference_game',
    'checkpoint', 'fair_margin', 'sigma', 'sigma_basis', 'market_home_line', 'cond_margin', 'pmf_conditioned', 'close_home_line', 'open_home_line', 'close_books',
    'p_win', 'p_push', 'p_loss', 'p_cover', 'p_home_ml', 'gap_pts', 'abs_line', 'favorite_flip', 'v2_ens', 'v2_ens_sd',
    'final_margin', 'y_cover', 'y_push', 'y_home_win'];
  const cell = (v) => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = cols.join(',') + '\n' + rows.map((x) => cols.map((c) => cell(x[c])).join(',')).join('\n') + '\n';
  const gz = zlib.gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
  fs.writeFileSync(OUT, gz);
  const counts = {};
  rows.forEach((x) => { const k = x.window + '|' + x.checkpoint; counts[k] = (counts[k] || 0) + 1; });
  const manifest = {
    schema: 'edgedesk_ev_calibration_dataset_manifest_v1', dataset: 'cfb_ev_calibration_rows_v1', built_at: new Date().toISOString(),
    rows: rows.length, counts: counts, holdout_rows: hold, dropped: dropped, csv_sha256: sha(Buffer.from(csv, 'utf8')),
    model_version: 'edgedesk_cfb_p4_v1.0.0',
    probability_path: 'football/cfb_terminal/build.js v1Dist -> lib/edgedesk_read.js buildCurve -> sideProb (the game page path)',
    fair_source: 'football/cfb_p4/research/disagreement_replay.js (cold, Tuesday 12:00 UTC freeze, market never an input) for 2015-2025; record/football/cfb_2026.json (published picks) for 2026',
    windows: { IN_SAMPLE: '2015-2021: the champion PMF (2006-2021) and tuning layers saw these seasons — diagnostics only',
      OOS: '2022-2025: untouched by every champion layer and by its PMF — the walk-forward tournament',
      HOLDOUT_2026: 'the published 2026 record, read once' },
    conventions: { market_home_line: 'the line the HOME side lays (negative = home favoured), rounded to the half point as the production consensus rounds it',
      p_cover: 'P(home covers | no push) from the production curve', y_cover: '1 home covered, 0 did not, blank = push',
      checkpoint: 'close | open | close_{m,p}{3,7}: the home line moved by that many points (alternate-line domain rows)' },
    inputs: { replay: path.basename(replay), archive: dataDir ? 'betting/cfb_line_odds.csv.gz (sportsdataverse/cfbfastR-data)' : null, swapped_archive_games_dropped: dropped.swapped }
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  console.log(JSON.stringify({ rows: rows.length, counts: counts, dropped: dropped }, null, 1));
}

if (require.main === module) main();
module.exports = { curveFor };
