#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS PIPELINE: capture → market file → evaluated board, through the
   production code (football/props/capture.js, build.js reprice, assemble.js)
   on the committed fixture (tools/props/_fixture.js; INVENTED prices).

     capture     every quote carries game, player, team, opponent, prop,
                 line, both prices, book, capture time, provider, status,
                 home/away and kickoff; ids are EdgeDesk ids, never names; a
                 name that does not resolve is reported, never guessed
     history     a re-capture of an unchanged price adds nothing; a moved
                 line appends history and keeps the first capture (the open)
     board       every priced prop carries the consensus, the best price, the
                 no-vig probability, edge, EV, reliability and a decision; a
                 prop with no quote says PROJECTION ONLY; a quote for a
                 player EdgeDesk cannot map is BAD MAPPING, not a guess
     freshness   the same quotes three hours later decide nothing
     parity      the drawer (EDProps.prepare on the game file + market file)
                 reaches the same decision as the board row
     immutable   re-pricing never changes a distribution

   Run: node tools/props/props_pipeline.test.js
   =========================================================================== */
'use strict';
const P = require('../../lib/edgedesk_props.js');
const X = require('./_fixture.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const F = X.load();
const T0 = X.NOW - 5 * 60000;

/* ============================================================ 1. CAPTURE */
const c1 = X.capture(F, T0);
{
  const q = c1.quotes;
  chk('every priced outcome in the fixture becomes a quote', q.length === 18, q.length);
  const need = ['quote_id', 'league', 'game_id', 'kickoff', 'player_id', 'player_name', 'team', 'opponent', 'home_away', 'prop_type', 'market_key', 'is_alternate', 'book', 'line', 'over', 'under', 'captured_at', 'book_updated_at', 'provider', 'market_status'];
  const mapped = q.filter((x) => x.player_id);
  chk('each mapped quote carries every required field', mapped.every((x) => need.every((k) => x[k] !== undefined)), need.filter((k) => mapped[0][k] === undefined));
  chk('player ids are EdgeDesk ids, never names', mapped.every((x) => /^edp_[0-9a-f]{12}$/.test(x.player_id)));
  const puka = mapped.find((x) => x.player_name === 'Puka Nacua' && x.prop_type === 'rec_yds' && x.book === 'draftkings' && !x.is_alternate);
  chk('team, opponent and home/away come from the registry and the game', puka && puka.team === 'LA' && puka.opponent === 'PHI' && puka.home_away === 'away', puka);
  chk('the capture time is the observation, not the book’s stamp', puka.captured_at === new Date(T0).toISOString() && puka.book_updated_at === '2026-10-04T11:58:00Z');
  chk('alternate markets are captured as alternates', q.some((x) => x.is_alternate && x.market_key === 'player_reception_yds_alternate'));
  chk('anytime TD is a Yes/No quote at 0.5', q.some((x) => x.prop_type === 'anytime_td' && x.line === 0.5));
  chk('quote ids are deterministic', X.capture(F, T0).quotes.map((x) => x.quote_id).join() === q.map((x) => x.quote_id).join());
  chk('a name that resolves to nobody is reported, never guessed', c1.unmapped.length === 1 && c1.unmapped[0].name === 'A.J. Brownn' && c1.unmapped[0].reason === 'NO_MATCH' && q.find((x) => x.player_name === 'A.J. Brownn').player_id === null, c1.unmapped);
  const cands = X.candidates(F, 'LA').concat(X.candidates(F, 'PHI'));
  chk('the resolver searches only the two rosters', cands.length > 20 && cands.every((x) => x.team === 'LA' || x.team === 'PHI'), cands.length);
}

/* ======================================================== 2. HISTORY */
const T1 = X.NOW - 2 * 60000;
{
  const same = X.capture(F, T1, c1.file);
  chk('re-capturing an unchanged price stores nothing new', same.fresh.length === 0, same.fresh.length);
  const k = X.GID + '|edp_fbd010f80790|rec_yds';
  chk('and adds no history point', same.file.history[k].length === c1.file.history[k].length);
  chk('but moves the capture time forward (the quote is still live)', same.file.props[k].find((x) => x.book === 'draftkings' && !x.is_alternate).captured_at === new Date(T1).toISOString());
  const moved = X.capture(F, T1, c1.file, (b) => b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Puka Nacua') o.point = 81.5; }); })));
  chk('a moved line is a new quote', moved.fresh.length > 0 && moved.fresh.every((x) => x.player_name === 'Puka Nacua'), moved.fresh.map((x) => x.player_name + ' ' + x.line));
  chk('it appends to the consensus history', moved.file.history[k].length === c1.file.history[k].length + 1 && moved.file.history[k].slice(-1)[0].line === 81.5, moved.file.history[k]);
  chk('and the first capture (the open) is never overwritten', moved.file.open[k].line === 78.5 && moved.file.open[k].at === c1.file.open[k].at, moved.file.open[k]);
  chk('the earlier history entries are unchanged', JSON.stringify(moved.file.history[k].slice(0, -1)) === JSON.stringify(c1.file.history[k]));
  const b = X.board(F, X.NOW, moved.file, moved.unmapped);
  const r = b.board.rows.find((x) => x.pid === 'edp_fbd010f80790' && x.prop === 'rec_yds');
  chk('the board reports the move from the open', r.mkt.open === 78.5 && r.mkt.move === 3, r.mkt);
}

/* =========================================================== 3. BOARD */
const B1 = X.board(F, X.NOW, c1.file, c1.unmapped);
{
  const rows = B1.board.rows;
  const priced = rows.filter((x) => x.mkt);
  chk('only the props a book deals carry a market', priced.length === 9 && rows.length === 59, [priced.length, rows.length]);
  const pr = priced.filter((x) => !x.status);
  chk('a priced prop: consensus, books, no-vig, best price, EV, reliability and a decision', pr.every((x) => typeof x.mkt.line === 'number' && x.mkt.books >= 1 && x.mkt.bl && x.dec && ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].indexOf(x.dec.cls) >= 0 && typeof x.rel === 'number'), pr.map((x) => x.name + ' ' + x.prop));
  chk('two-sided props carry P(Over) / P(Under) and fair odds at the consensus line', pr.filter((x) => x.prop !== 'anytime_td').every((x) => x.at_line && x.at_line[0] + x.at_line[1] <= 1 + 1e-9 && typeof x.at_line[2] === 'number'));
  const puka = rows.find((x) => x.pid === 'edp_fbd010f80790' && x.prop === 'rec_yds');
  chk('three books on Puka: consensus 78.5, the book list carried for the filter', puka.mkt.line === 78.5 && puka.mkt.books === 3 && puka.mkt.bl.join() === 'betmgm,draftkings,fanduel', puka.mkt);
  chk('an unresolved availability status is WATCH, never a stake', puka.avail && puka.dec.cls === 'WATCH' && puka.dec.code === 'AVAILABILITY_PENDING', puka.dec);
  chk('an EXPERIMENTAL market never carries units', rows.filter((x) => x.stage === 'EXPERIMENTAL' && x.dec).every((x) => !(x.dec.units > 0)));
  const noMkt = rows.filter((x) => !x.mkt);
  chk('a prop with no quote has no price, no EV and no decision (PROJECTION ONLY)', noMkt.every((x) => !x.px && !x.dec && Array.isArray(x.proj)), noMkt.length);
  const aj = rows.find((x) => x.name === 'A.J. Brownn');
  chk('a quote EdgeDesk cannot map is a MARKET row with BAD MAPPING, never priced against someone', aj && aj.status === 'UNMAPPED' && aj.dec.cls === 'NO_DECISION' && aj.dec.state === 'BAD_MAPPING' && !aj.px, aj);
  chk('rows are keyed by durable ids', rows.filter((x) => !x.status).every((x) => /^edp_/.test(x.pid)));
  chk('counts add up', B1.board.counts.BET + B1.board.counts.LEAN + B1.board.counts.WATCH + B1.board.counts.PASS + B1.board.counts.NO_DECISION === rows.length, B1.board.counts);
  chk('the board states when the market was captured', B1.board.market_captured_at === new Date(T0).toISOString() && B1.board.market_note === null);
}

/* ========================================================= 4. A BET */
{
  const edit = (b) => b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Davante Adams') { o.point = 63.5; o.price = o.name === 'Over' ? 120 : -145; } }); }));
  const c = X.capture(F, T0, null, edit);
  const b = X.board(F, X.NOW, c.file, c.unmapped);
  const r = b.board.rows.find((x) => x.name === 'Davante Adams' && x.prop === 'rec_yds');
  chk('two books at +120 on a TRACKING market with a real edge: BET', r.dec.cls === 'BET' && r.dec.code === 'QUALIFIES' && r.px.side === 'over', r.dec);
  chk('sized by quarter-Kelly and capped at 0.25U (model-estimated source)', r.dec.units > 0 && r.dec.units <= 0.25, r.dec.units);
  chk('decided on the risk-adjusted probability (below the raw model, above the market)', r.px.dec_p < r.px.cover && r.px.dec_p > r.px.mkt_p && r.px.dec_ev < r.px.ev, r.px);
  chk('the edge is measured against the break-even of the exact price', Math.abs(r.px.edge - 100 * (r.px.cover - r.px.be)) < 0.05, r.px);

  /* the same quotes, three hours later */
  const late = X.board(F, X.NOW + 3 * 3600e3, c.file, c.unmapped);
  const r2 = late.board.rows.find((x) => x.name === 'Davante Adams' && x.prop === 'rec_yds');
  chk('three hours later the same quotes are STALE: NO DECISION, the EV still shown', r2.dec.cls === 'NO_DECISION' && r2.dec.code === 'STALE_QUOTE' && r2.px && r2.px.ev > 0 && r2.mkt.fresh === 'STALE', r2.dec);
  chk('no stale row anywhere on that board carries a stake', late.board.rows.every((x) => !(x.dec && x.dec.units > 0)));

  /* after kickoff */
  const after = X.board(F, X.KICKOFF + 60000, c.file, c.unmapped);
  chk('after kickoff every priced prop is NO DECISION · GAME STARTED', after.board.rows.filter((x) => x.mkt && !x.status).every((x) => x.dec.cls === 'NO_DECISION' && x.dec.code === 'GAME_STARTED'));

  /* ================================================ 5. PARITY (drawer) */
  const gf = b.asm.gameFiles[0];
  const rec = gf.projections.find((x) => x.projection_id === r.id);
  const proj = P.hydrate(gf, rec);
  const k = r.gid + '|' + r.pid + '|' + r.prop;
  const ev = P.prepare(proj, c.file.props[k], { now: X.NOW, stages: b.board.stages, cv_norm: b.board.cv_norm, calibration: b.board.calibration, history: c.file.history[k], open: c.file.open[k] }).evaluation;
  chk('the drawer re-runs prepare() on the files and reaches the board’s decision', ev.decision === r.dec.cls && ev.reason_code === r.dec.code && ev.recommended.american === r.px.am && ev.recommended.book === r.px.book, [ev.decision, ev.reason_code, r.dec]);
  chk('and the board’s EV, to the digit', Math.abs(ev.recommended.ev - r.px.ev) < 1e-9 && Math.abs(ev.recommended.decision_ev - r.px.dec_ev) < 1e-9);
  chk('the ladder prices every Adams quote, both sides', ev.ladder.rows.length >= 4, ev.ladder.rows.length);
}

/* ===================================================== 6. IMMUTABLE */
{
  const before = F.game.projections.filter((x) => x.dist).map((x) => x.projection_id + JSON.stringify(x.dist)).join('|');
  const after = B1.asm.gameFiles[0].projections.filter((x) => x.dist).map((x) => x.projection_id + JSON.stringify(x.dist)).join('|');
  chk('re-pricing never touches a distribution', before === after);
  chk('the projection ids are the model’s, unchanged by the market', F.game.projections.every((p) => B1.asm.gameFiles[0].projections.some((q) => q.projection_id === p.projection_id)));
  chk('the game file carries no market (the market lives in its own file)', !JSON.stringify(B1.asm.gameFiles[0]).includes('"over":-110'));
  const blank = X.board(F, X.NOW, null, []);
  chk('with no capture the board says PROJECTION ONLY and prices nothing', blank.board.market_captured_at === null && blank.board.rows.every((x) => !x.mkt && !x.px) && /never invents a price/i.test(blank.board.market_note || ''), blank.board.market_note);
}

console.log((fail ? 'FAIL' : 'PASS') + ' | player props pipeline | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
