#!/usr/bin/env node
/* ===========================================================================
   Research › Props (lib/player_props_ui.js) without a browser: the published
   boards unpack, the filters and sorts do what they say, the research card
   shows the model alone when no sportsbook line exists (and never a price),
   the priced paths render when observed quotes exist, and the published
   payloads stay inside the size budget the page is built for.

   The priced half uses football/props/fixture_quotes.js — a TEST FIXTURE
   quote set labelled as such, priced through the kernel's reprice(). The
   browser version of these checks is football/props/ui.e2e.js.

     node football/props/ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const EDP = require('../../lib/player_props.js');
const UI = require('../../lib/player_props_ui.js').EDPropsUI;
const FX = require('./fixture_quotes.js');

const PUB = path.join(__dirname, 'published');
let pass = 0, fail = 0;
function chk(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); } }
function reset() { Object.keys(UI.state.f).forEach((k) => { UI.state.f[k] = k === 'priced' ? false : ''; }); UI.state.sort = 'ev'; }
function text(html) { return String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' '); }

const leagues = ['nfl', 'cfb'].filter((lg) => fs.existsSync(path.join(PUB, 'board_' + lg + '.json')));
if (!leagues.length) { console.log('SKIPPED: nothing published under football/props/published (run football/props/run.js score)'); process.exit(0); }

/* ------------------------------------------------------------ budgets */
const BUDGET = { board: { nfl: 700e3, cfb: 2.5e6 }, card: 600e3, market: 400e3, cards_total: { nfl: 8e6, cfb: 24e6 } };
leagues.forEach((lg) => {
  chk(lg + ': the board is inside its payload budget', () => { const n = fs.statSync(path.join(PUB, 'board_' + lg + '.json')).size; assert.ok(n <= BUDGET.board[lg], n + ' bytes'); });
  chk(lg + ': every card and market file is inside its budget, and the league\'s cards together', () => {
    const dir = path.join(PUB, lg); let tot = 0;
    fs.readdirSync(dir).forEach((f) => { const n = fs.statSync(path.join(dir, f)).size; tot += n; assert.ok(n <= (/\.market\.json$/.test(f) ? BUDGET.market : BUDGET.card), f + ' ' + n + ' bytes'); });
    assert.ok(tot <= BUDGET.cards_total[lg], 'total ' + tot);
  });
});

/* ------------------------------------------------------------ the real boards */
leagues.forEach((lg) => {
  const raw = JSON.parse(fs.readFileSync(path.join(PUB, 'board_' + lg + '.json'), 'utf8'));
  const b = EDP.wire.expandBoard(raw);
  chk(lg + ': the packed board unpacks to one row per prop, each complete', () => {
    assert.strictEqual(raw.schema, 'edgedesk_props_board_v1'); assert.ok(Array.isArray(raw.rows[0]));
    assert.strictEqual(b.rows.length, raw.n_props);
    b.rows.forEach((r) => { assert.ok(r.id && r.player && r.market && r.team && r.opp && r.kickoff && r.model_version, JSON.stringify(r)); assert.ok(typeof r.mean === 'number'); });
  });
  chk(lg + ': every row id resolves to its game file', () => {
    const games = new Set(b.rows.map((r) => r.game_id));
    games.forEach((g) => assert.ok(fs.existsSync(path.join(PUB, lg, g + '.json')), g));
  });
  if (!raw.quotes || !raw.quotes.captured) {
    chk(lg + ': with no captured quote, no row carries a market, a price, an edge or an EV', () => {
      b.rows.forEach((r) => { assert.strictEqual(r.mkt, null); assert.strictEqual(r.focus, null); assert.ok(r.decision === 'PASS', r.decision); });
    });
  }
  chk(lg + ': filters — position, market, search and priced-only', () => {
    reset(); UI.state.f.pos = 'QB'; const qb = UI.filtered(b); assert.ok(qb.length > 0 && qb.every((r) => r.pos === 'QB'));
    reset(); UI.state.f.market = 'receiving_yards'; const ry = UI.filtered(b); assert.ok(ry.length > 0 && ry.every((r) => r.market === 'receiving_yards'));
    reset(); const name = b.rows[0].player; UI.state.f.q = name.toLowerCase(); assert.ok(UI.filtered(b).every((r) => (r.player + ' ' + r.team + ' ' + r.opp + ' ' + r.matchup).toLowerCase().indexOf(name.toLowerCase()) >= 0));
    reset(); UI.state.f.priced = true; assert.strictEqual(UI.filtered(b).length, b.rows.filter((r) => r.focus).length);
    reset(); UI.state.f.game = b.rows[0].game_id; assert.ok(UI.filtered(b).every((r) => r.game_id === b.rows[0].game_id));
    reset();
  });
  chk(lg + ': the model-only research card says there is no market and prints no price', () => {
    const r = b.rows.find((x) => x.market === 'receiving_yards' || x.market === 'rush_yards') || b.rows[0];
    const card = JSON.parse(fs.readFileSync(path.join(PUB, lg, r.game_id + '.json'), 'utf8'));
    const p = EDP.wire.expandCard(card, null).find((x) => x.id === r.id);
    assert.ok(p, 'prop in card');
    assert.strictEqual(p.model.mean, r.mean); assert.strictEqual(p.model.over_prob, r.over); assert.strictEqual(p.model.fair_over, r.fair_over);
    const t = text(UI.researchCard(p, card.game, EDP));
    assert.ok(/MODEL ONLY/.test(t)); assert.ok(/No observed sportsbook line has been captured for this prop\. Nothing on this card is a price\./.test(t));
    assert.ok(!/Alternate lines/.test(t) && !/Model vs market/.test(t));
    assert.ok(/not a sportsbook line/.test(t)); assert.ok(/Research, not picks\./.test(t));
    assert.ok(/<svg class="pp-chart"/.test(UI.researchCard(p, card.game, EDP)), 'distribution chart');
  });
});

/* ------------------------------------------------------------ the priced paths (TEST FIXTURE quotes) */
if (leagues.indexOf('nfl') >= 0) {
  const f = FX.build('nfl');
  const b = EDP.wire.expandBoard(JSON.parse(JSON.stringify(f.board)));
  const card = JSON.parse(fs.readFileSync(path.join(PUB, 'nfl', f.game_id + '.json'), 'utf8'));
  const props = EDP.wire.expandCard(card, JSON.parse(JSON.stringify(f.markets[f.game_id])));
  chk('fixture: every priced row names its fixture book, its exact price and the model beside the market', () => {
    const pr = b.rows.filter((r) => r.focus); assert.ok(pr.length > 20, pr.length);
    pr.forEach((r) => { assert.ok(FX.BOOKS.indexOf(r.focus.book) >= 0); assert.ok(typeof r.focus.am === 'number' && typeof r.focus.model === 'number' && typeof r.focus.edge === 'number'); });
    /* a two-sided main line has a no-vig market probability; a one-sided alternate has none (its edge is against the implied price) */
    assert.ok(pr.some((r) => typeof r.focus.market === 'number'));
    assert.ok(/TEST FIXTURE/.test(f.board.fixture) && /TEST FIXTURE/.test(f.markets[f.game_id].fixture));
  });
  chk('fixture: sort by best value is descending conservative EV; the edge filter holds', () => {
    reset(); UI.state.f.priced = true; UI.state.sort = 'ev';
    const v = UI.filtered(b).map((r) => r.focus.cev); assert.ok(v.every((x, i) => i === 0 || x <= v[i - 1] + 1e-12));
    reset(); UI.state.f.edge = '0.02'; assert.ok(UI.filtered(b).every((r) => r.focus && r.focus.edge >= 0.02));
    reset(); UI.state.f.book = 'FIXTURE-B'; assert.ok(UI.filtered(b).every((r) => (r.focus && r.focus.book === 'FIXTURE-B') || (r.mkt && ((r.mkt.best_over && r.mkt.best_over.sportsbook === 'FIXTURE-B') || (r.mkt.best_under && r.mkt.best_under.sportsbook === 'FIXTURE-B')))));
    reset();
  });
  chk('fixture: no decision is BET while the market calibration tier is RESEARCH', () => {
    b.rows.forEach((r) => assert.ok(r.decision !== 'BET' || r.tier === 'VALIDATED', r.id));
  });
  chk('fixture: the board row and the research card agree (one kernel)', () => {
    props.forEach((p) => { const r = b.rows.find((x) => x.id === p.id); if (!r) return;
      assert.strictEqual(!!r.focus, !!p.focus, p.id);
      if (p.focus) { assert.strictEqual(r.focus.ev, p.focus.ev); assert.strictEqual(r.focus.am, p.focus.american); assert.strictEqual(r.focus.line, p.focus.line); assert.strictEqual(r.decision, p.decision.decision); } });
  });
  chk('fixture: the priced research card shows market, line shopping, movement, the alternate ladder and the model-vs-market split', () => {
    const p = props.find((x) => x.ladders && x.ladders.over && x.ladders.over.rows.length >= 4 && x.movement && x.movement.available);
    assert.ok(p, 'a laddered prop');
    const html = UI.researchCard(p, card.game, EDP), t = text(html);
    ['Model vs market', 'Market', 'Consensus line', 'No-vig over', 'Best over', 'Opener', 'Alternate lines', 'Over ladder', 'Best value =', 'What if', 'Why EdgeDesk differs', 'Confidence and data quality'].forEach((s) => assert.ok(t.indexOf(s) >= 0, s));
    FX.BOOKS.forEach((bk) => assert.ok(t.indexOf(bk.slice(0, 6).toUpperCase()) >= 0, bk));
    assert.strictEqual((html.match(/<tr class="[^"]*pp-bv/g) || []).length, (p.ladders.over.best_value ? 1 : 0) + (p.ladders.under && p.ladders.under.best_value ? 1 : 0), 'one best-value row per ladder that has one');
  });
  chk('fixture: a ladder\'s best value is not simply the largest raw EV or the highest probability', () => {
    const lads = []; props.forEach((p) => { if (p.ladders) ['over', 'under'].forEach((s) => { if (p.ladders[s] && p.ladders[s].best_value) lads.push(p.ladders[s]); }); });
    assert.ok(lads.length > 0);
    lads.forEach((L) => { assert.ok(L.best_value.conservative_ev > 0 && L.best_value.kelly_growth > 0, JSON.stringify(L.best_value)); const bestG = Math.max.apply(null, L.rows.filter((x) => x.conservative_ev > 0).map((x) => x.kelly_growth)); assert.ok(Math.abs(L.best_value.kelly_growth - bestG) < 1e-6); });
    assert.ok(lads.some((L) => L.max_ev && (L.max_ev.line !== L.best_value.line || L.max_ev.sportsbook !== L.best_value.sportsbook)) || lads.length < 3, 'at least one ladder where value is not the max-EV quote');
  });
}

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props page — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
