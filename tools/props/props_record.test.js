#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS RECORD (football/props/record.js): freeze before kickoff,
   grade after the final, and prove the ledger only ever grew.

     freeze   FIRST the first time a prop is priced; nothing new on an
              unchanged re-run; DECISION_CHANGE when the class moves;
              PREGAME_FINAL inside the last three hours; nothing at or after
              kickoff; nothing from a stale price; the model version, price,
              book and probabilities frozen with it
     ledger   append-only: an edited line, a removed line or a line frozen
              after kickoff is caught; each id is the hash of its content
     grade    WIN / LOSS / PUSH on the box score the model reads; VOID when
              the player did not play; units at the price taken; CLV against
              EdgeDesk's last pre-kickoff capture; one row per prop counts

   Run: node tools/props/props_record.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('./_fixture.js');
const R = require('../../football/props/record.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const F = X.load();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-record-'));
const LEDGER = path.join(TMP, 'predictions.jsonl');
const readLedger = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/* the base market: Kyren Williams on a whole number so a push can happen */
const whole = (b) => b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_rush_yds') m.outcomes.forEach((o) => { if (o.description === 'Kyren Williams') o.point = 64; }); }));
const better = (b) => { whole(b); b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Davante Adams') { o.point = 63.5; o.price = o.name === 'Over' ? 120 : -145; } }); })); };
function freezeAt(nowMs, file, unmapped) {
  const b = X.board(F, nowMs, file, unmapped);
  return { b, r: R.freeze('nfl', nowMs, { board: b.board, market: X.marketOf(file, unmapped), gameFiles: { [X.GID]: b.asm.gameFiles[0] }, ledger: LEDGER }) };
}

/* ============================================================ 1. FREEZE */
const c1 = X.capture(F, X.NOW - 5 * 60000, null, whole);
const f1 = freezeAt(X.NOW, c1.file, c1.unmapped);
const decided = f1.b.board.rows.filter((x) => x.mkt && x.dec && x.dec.cls !== 'NO_DECISION');
{
  chk('every priced prop with a decision is frozen once, as FIRST', f1.r.frozen === decided.length && f1.r.kinds.FIRST === decided.length && decided.length >= 7, [f1.r, decided.length]);
  const L = readLedger();
  chk('an unmapped name is never frozen', !L.some((x) => x.player_name === 'A.J. Brownn' || !x.player_id));
  const need = ['prediction_id', 'player_id', 'prop_type', 'side', 'line', 'american', 'book', 'quote_captured_at', 'model_prob', 'model_cover', 'market_prob', 'fair_american', 'fair_line', 'ev', 'edge_pp', 'decision', 'reason_code', 'units', 'reliability', 'confidence_tier', 'stage', 'model_version', 'projection_id', 'frozen_at', 'kickoff'];
  chk('each frozen prediction carries every number it was decided on', L.every((x) => need.every((k) => x[k] !== undefined)), need.filter((k) => L[0][k] === undefined));
  chk('the model version is frozen with it', L.every((x) => x.model_version === 'NFL_PLAYER_PROPS_V1.0'));
  chk('frozen before kickoff', L.every((x) => Date.parse(x.frozen_at) < Date.parse(x.kickoff)));
  chk('a PASS is frozen too (every class is graded, not just the winners)', L.some((x) => x.decision === 'PASS'));

  const again = freezeAt(X.NOW + 10 * 60000, X.capture(F, X.NOW + 5 * 60000, c1.file, whole).file, c1.unmapped);
  chk('an unchanged re-run freezes nothing new', again.r.frozen === 0, again.r);

  const c2 = X.capture(F, X.NOW + 20 * 60000, c1.file, better);
  const f2 = freezeAt(X.NOW + 25 * 60000, c2.file, c2.unmapped);
  const L2 = readLedger();
  chk('a class change is frozen as DECISION_CHANGE, a new row with its own id', f2.r.frozen === 1 && f2.r.kinds.DECISION_CHANGE === 1 && L2[L2.length - 1].player_name === 'Davante Adams' && L2[L2.length - 1].decision === 'BET', f2.r);
  chk('the earlier Adams prediction is still there, unchanged', L2.filter((x) => x.player_name === 'Davante Adams' && x.prop_type === 'rec_yds').length === 2 && JSON.stringify(L2.slice(0, L.length)) === JSON.stringify(L));
  chk('the BET was frozen with its units', L2[L2.length - 1].units > 0 && L2[L2.length - 1].units <= 0.25);

  const stale = freezeAt(X.KICKOFF - 2.5 * 3600e3, c2.file, c2.unmapped);
  chk('a stale price is never frozen, even in the final window', stale.r.frozen === 0, stale.r);

  const tf = X.KICKOFF - 2 * 3600e3;
  const c3 = X.capture(F, tf - 5 * 60000, c2.file, better);
  const f3 = freezeAt(tf, c3.file, c3.unmapped);
  chk('inside the last three hours each prop is frozen once more as PREGAME_FINAL', f3.r.frozen === decided.length && f3.r.kinds.PREGAME_FINAL === decided.length, f3.r);
  const f3b = freezeAt(tf + 10 * 60000, X.capture(F, tf + 5 * 60000, c3.file, better).file, c3.unmapped);
  chk('and not again while nothing changes', f3b.r.frozen === 0, f3b.r);

  const ko = freezeAt(X.KICKOFF, X.capture(F, X.KICKOFF - 60000, c3.file, better).file, c3.unmapped);
  chk('nothing is frozen at kickoff', ko.r.frozen === 0, ko.r);
}

/* ============================================================ 2. LEDGER */
const TEXT = fs.readFileSync(LEDGER, 'utf8');
{
  chk('the ledger verifies: every id is the hash of its content', R.checkLedger('', TEXT, 'ledger').length === 0, R.checkLedger('', TEXT, 'ledger'));
  const lines = TEXT.split('\n').filter(Boolean);
  const half = lines.slice(0, 5).join('\n') + '\n';
  chk('appending to a committed prefix is allowed', R.checkLedger(half, TEXT, 'ledger').length === 0);
  const edited = TEXT.replace(/"american":-110/, '"american":-105');
  chk('an edited price is caught (prefix and hash)', R.checkLedger(TEXT, edited, 'ledger').length >= 2, R.checkLedger(TEXT, edited, 'ledger'));
  const removed = lines.slice(1).join('\n') + '\n';
  chk('a removed prediction is caught', R.checkLedger(TEXT, removed, 'ledger').some((p) => /not a prefix/.test(p)));
  const late = JSON.parse(lines[0]); late.frozen_at = late.kickoff;
  chk('a prediction frozen at kickoff is caught', R.checkLedger('', JSON.stringify(late) + '\n', 'ledger').some((p) => /after kickoff/.test(p)));
}

/* ============================================================= 3. GRADE */
(async function () {
  const reg = F.registry;
  const gsis = (name) => { const p = Object.values(reg.players).find((x) => x.name === name); return p.ids.gsis; };
  const box = (name, team, o) => Object.assign({ game_id: X.GID, gsis: gsis(name), team, att: 0, cmp: 0, pass_yds: 0, pass_td: 0, int: 0, car: 0, rush_yds: 0, rush_td: 0, tgt: 0, rec: 0, rec_yds: 0, rec_td: 0, long_rec: 0, long_rush: 0, long_cmp: 0 }, o);
  /* Puka Nacua is not in the box score: he did not play */
  const data = {
    games: new Map([[X.GID, { game_id: X.GID, home_score: 24, away_score: 20, game_type: 'REG' }]]),
    teamGames: new Map([[X.GID + '|PHI', { game_id: X.GID, team: 'PHI' }], [X.GID + '|LA', { game_id: X.GID, team: 'LA' }]]),
    playerGames: [
      box('Davante Adams', 'LA', { tgt: 9, rec: 6, rec_yds: 88, long_rec: 31 }),
      box('Kyren Williams', 'LA', { car: 17, rush_yds: 64 }),
      box('Saquon Barkley', 'PHI', { car: 22, rush_yds: 104, rush_td: 1, tgt: 3, rec: 2, rec_yds: 11 }),
      box('DeVonta Smith', 'PHI', { tgt: 7, rec: 4, rec_yds: 41 }),
      box('Matthew Stafford', 'LA', { att: 38, cmp: 24, pass_yds: 262, pass_td: 2 })
    ]
  };
  const preds = readLedger();
  const out = await R.grade('nfl', X.KICKOFF + 6 * 3600e3, { seasons: [2026], predictions: preds, data, registry: reg, market_dir: TMP });
  fs.mkdirSync(path.join(TMP, 'markets'), { recursive: true });
  const g = out.seasons[2026].predictions;
  const one = (name, prop, kind) => g.filter((x) => x.player_name === name && x.prop_type === prop && (!kind || x.kind === kind)).slice(-1)[0];
  const adams = one('Davante Adams', 'rec_yds', 'PREGAME_FINAL');
  chk('Adams Over 63.5 with 88 yards: WIN, paid at the price taken', adams.result === 'WIN' && adams.actual === 88 && Math.abs(adams.profit_units - adams.units * 1.2) < 1e-6, adams);
  const kyren = one('Kyren Williams', 'rush_yds');
  chk('Kyren on 64 with 64 yards: PUSH, stake returned', kyren && kyren.result === 'PUSH' && kyren.profit_units === 0, kyren && [kyren.side, kyren.line, kyren.result]);
  const puka = one('Puka Nacua', 'rec_yds');
  chk('Puka did not play: VOID (the book voids a DNP)', puka && puka.result === 'VOID' && puka.void_reason === 'DID_NOT_PLAY', puka && [puka.result, puka.void_reason]);
  const smith = one('DeVonta Smith', 'rec_yds');
  chk('Smith on 55.5 with 41 yards: graded by side', smith && smith.result === (smith.side === 'over' ? 'LOSS' : 'WIN'), smith && [smith.side, smith.result]);
  const td = one('Saquon Barkley', 'anytime_td');
  chk('an anytime TD with a rushing score grades Yes as WIN', td && td.result === (td.side === 'yes' ? 'WIN' : 'LOSS'), td && [td.side, td.result]);
  chk('every graded row keeps its frozen numbers', g.every((x) => x.prediction_id && x.model_version && x.american != null));

  /* CLV against EdgeDesk's own last pre-kickoff capture */
  const c = X.capture(F, X.KICKOFF - 30 * 60000, null, (b) => { better(b); b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Davante Adams') o.price = o.name === 'Over' ? -120 : 100; }); })); });
  fs.writeFileSync(path.join(TMP, 'markets', X.GID + '.json'), JSON.stringify(c.file));
  const out2 = await R.grade('nfl', X.KICKOFF + 6 * 3600e3, { seasons: [2026], predictions: preds, data, registry: reg, market_dir: TMP });
  const a2 = out2.seasons[2026].predictions.filter((x) => x.player_name === 'Davante Adams' && x.decision === 'BET').slice(-1)[0];
  chk('the close is the last capture before kickoff', a2.close && a2.close.line === 63.5 && a2.close.over === -120 && a2.close.basis === 'last pre-kickoff capture', a2.close);
  chk('Over +120 taken, closing -120 / +100: positive price CLV', a2.clv_price > 0.1, a2.clv_price);
  chk('no line CLV where the line did not move', a2.clv_line === 0);

  const sc = out2.seasons[2026].scorecards;
  chk('the headline counts each prop once (its last pregame row)', sc.n_props === decided.length && sc.n_predictions === preds.length, [sc.n_props, decided.length, sc.n_predictions]);
  chk('scorecards by prop, position, stage, book, decision and model version', ['by_prop', 'by_position', 'by_stage', 'by_book', 'by_decision', 'by_model_version', 'by_confidence', 'by_tier'].every((k) => sc[k] && Object.keys(sc[k]).length));
  chk('voids are counted apart from settled', sc.all.voids >= 1 && sc.all.settled === sc.all.wins + sc.all.losses + sc.all.pushes, sc.all);
  chk('the sample state says how much to trust it', sc.all.sample_state === 'TOO EARLY');

  const pending = await R.grade('nfl', X.KICKOFF + 3600e3, { seasons: [2026], predictions: preds, data: Object.assign({}, data, { games: new Map([[X.GID, { game_id: X.GID, home_score: null, away_score: null }]]) }), registry: reg, market_dir: TMP });
  chk('no final score: PENDING, not graded', pending.seasons[2026].predictions.every((x) => x.status === 'PENDING' && x.result === null));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log((fail ? 'FAIL' : 'PASS') + ' | player props record | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
