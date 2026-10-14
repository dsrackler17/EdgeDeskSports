#!/usr/bin/env node
/* ===========================================================================
   The NHL market test (hockey/model/market_test.js) on synthetic archives
   where the right verdict is known.

     - a model that knows the truth, against a noisy "market"  → TESTED_AHEAD
     - a noisy model, against a market that knows the truth     → TESTED_BEHIND
     - a closing price captured at or after the start is rejected, never scored
     - a row without a source or capture time is rejected
     - with no archive at all the answer is NO_ARCHIVE, never a guess
   The archives here are generated in a temp directory and are labelled
   synthetic; no real price is invented or committed.

   Run: node tools/hockey/market_test.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const MT = require(path.join(ROOT, 'hockey', 'model', 'market_test.js'));
const ST = require(path.join(ROOT, 'engine', 'stats.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const toAm = (p) => { const d = 1 / p; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };

function world(seed, modelNoise, marketNoise, n) {
  const rnd = ST.rng(seed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhlmt-'));
  const closing = path.join(dir, 'closing'); fs.mkdirSync(closing);
  const preds = []; const csv = ['game_id,source,book,captured_at,close_home_ml,close_away_ml'];
  for (let i = 0; i < n; i++) {
    const p = 0.35 + rnd() * 0.3; const y = rnd() < p ? 1 : 0;
    const clip = (v) => Math.min(0.9, Math.max(0.1, v));
    const pm = clip(p + (rnd() - 0.5) * 2 * modelNoise), pk = clip(p + (rnd() - 0.5) * 2 * marketNoise);
    const day = new Date(Date.UTC(2025, 9, 1) + Math.floor(i / 8) * 864e5).toISOString().slice(0, 10);
    const start = day + 'T23:00:00Z';
    preds.push({ game_id: 1000 + i, date: day, start_utc: start, predicted_at: day + 'T22:30:00Z', p: { xg_no_goalie: { ml: pm } }, y: { hw: y, total: 5, margin: y ? 1 : -1 } });
    /* a 4% overround on the synthetic close */
    const ph = pk * 1.02, pa = (1 - pk) * 1.02;
    csv.push([1000 + i, 'SYNTHETIC test archive', 'synthbook', day + 'T22:55:00Z', toAm(ph), toAm(pa)].join(','));
  }
  fs.writeFileSync(path.join(closing, '2026.csv'), csv.join('\n') + '\n');
  const pf = path.join(dir, 'predictions.jsonl'); fs.writeFileSync(pf, preds.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { dir, closing, pf };
}

let w = world(11, 0.0, 0.12, 2500);
let r = MT.run({ closing: w.closing, predictions: w.pf, model: 'xg_no_goalie' /* the model the synthetic predictions are keyed by */ });
chk('a model that knows the truth beats a noisy close: TESTED_AHEAD', r.markets.moneyline && r.markets.moneyline.status === 'TESTED_AHEAD', r.markets.moneyline && r.markets.moneyline.why);
chk('the strategy report prints its bets, ROI and interval, and a profit claim only by the rule', r.markets.moneyline.strategy_at_close.bets > 0 && 'roi_after_fees' in r.markets.moneyline.strategy_at_close && /ALLOWED|NOT_SUPPORTED/.test(r.markets.moneyline.strategy_at_close.profit_claim));
fs.rmSync(w.dir, { recursive: true, force: true });

w = world(12, 0.12, 0.0, 2500);
r = MT.run({ closing: w.closing, predictions: w.pf, model: 'xg_no_goalie' /* the model the synthetic predictions are keyed by */ });
chk('a noisy model against a close that knows the truth: TESTED_BEHIND', r.markets.moneyline.status === 'TESTED_BEHIND', r.markets.moneyline.why);
fs.rmSync(w.dir, { recursive: true, force: true });

w = world(13, 0.0, 0.1, 60);
const csvPath = path.join(w.closing, '2026.csv');
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
lines[1] = lines[1].replace(/T22:55:00Z/, 'T23:10:00Z');            /* captured after the start */
lines[2] = lines[2].replace(/^(\d+),[^,]*,/, '$1,,');                 /* no source */
fs.writeFileSync(csvPath, lines.join('\n') + '\n');
r = MT.run({ closing: w.closing, predictions: w.pf, model: 'xg_no_goalie' /* the model the synthetic predictions are keyed by */ });
chk('a closing price captured after the start is rejected, never scored', r.rejected.CAPTURED_AT_OR_AFTER_START === 1, r.rejected);
chk('a row with no source is rejected', r.rejected.MISSING_PROVENANCE === 1, r.rejected);
chk('a small sample cannot be TESTED_AHEAD', r.markets.moneyline.status !== 'TESTED_AHEAD', r.markets.moneyline.status);
fs.rmSync(w.dir, { recursive: true, force: true });

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nhlmt-'));
r = MT.run({ closing: path.join(empty, 'nothing'), predictions: path.join(empty, 'p.jsonl') });
chk('without a model named, the market test scores the production model the record chose', r.model === JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'hockey', 'validation', 'nhl_walkforward.json'), 'utf8')).selection.chosen, r.model);
chk('with no archive the answer is NO_ARCHIVE', r.status === 'NO_ARCHIVE' && Object.keys(r.markets).length === 0);
fs.rmSync(empty, { recursive: true, force: true });

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL market test — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
