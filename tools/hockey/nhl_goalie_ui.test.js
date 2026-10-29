#!/usr/bin/env node
/* ===========================================================================
   The NHL goalie block (lib/edgedesk_nhl_goalies.js) and the goalie gate in
   lib/edgedesk_nhl_market.js and lib/edgedesk_nhl_compare.js, in Node.

     block      each starter with its badge, source (T0 or T2) and "as of"
                time; the full pairing range and "Starter not confirmed.
                Numbers may change." unless both are Confirmed; the change
                note with both versions' win %; a conflict shown as such; a
                stale or failed check says so; the slate's own block in the
                same shape when the live layer has not answered
     gate       moneyline, puck line and totals: no edge while a starter is
                unconfirmed unless it holds under every pairing; a line no
                pairing prices cannot pass; both Confirmed opens it; a
                conflict never counts as Confirmed
     compare    the live card's pairings and statuses drive the gate when the
                page has them; the slate's scenarios otherwise

   Run: node tools/hockey/nhl_goalie_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const GL = require(path.join(ROOT, 'lib', 'edgedesk_nhl_goalies.js'));
const MK = require(path.join(ROOT, 'lib', 'edgedesk_nhl_market.js'));
const CMP = require(path.join(ROOT, 'lib', 'edgedesk_nhl_compare.js'));
const G = require(path.join(ROOT, 'hockey', 'goalies', 'core.js'));
const DIST = require(path.join(ROOT, 'hockey', 'model', 'distribution.js'));
const INPUTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nhl_goalie_inputs_min_van_2026-10-25.json'), 'utf8'));
const GI = INPUTS.games[0];
/* the slate's MIN @ VAN game as frozen before puck drop, pinned: the live slate drops a game once it is played */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nhl_slate_min_van_2026-10-25.json'), 'utf8'));
const SLATE = Object.assign({}, FX.slate, { games: [FX.game] });

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

/* cards as the sync writes them (the DB row's columns), from the real MIN @ VAN inputs */
const o = (source, id, name, status, extra) => Object.assign({ source, goalie_id: id, goalie_name: name, status, fetched_at: '2026-10-25T18:00:00Z' }, extra || {});
const merged = (h, a) => ({ home: G.nhlgDisplay(G.nhlgMergeSide(h.length ? h : [], h.length ? null : { goalie_id: '8480947', goalie_name: 'K. Lankinen', p: 0.5154, as_of: '2026-10-25T12:41:00Z' }), INPUTS),
  away: G.nhlgDisplay(G.nhlgMergeSide(a.length ? a : [], a.length ? null : { goalie_id: '8475717', goalie_name: 'C. Pickard', p: 0.7683, as_of: '2026-10-25T12:41:00Z' }), INPUTS) });
function row(card, version, id) {
  return Object.assign({}, card, { id, version, goalie_status_home: card.goalie_status.home, goalie_status_away: card.goalie_status.away, edge_gate_state: card.edge_gate.state });
}
const c1 = G.nhlgBuildCard(GI, INPUTS, merged([], []), DIST, { now: '2026-10-25T12:00:30Z' });
const r1 = row(c1, 1, 101);
const c2 = G.nhlgBuildCard(GI, INPUTS, merged([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'likely', { source_updated_at: '2026-10-25T17:42:00Z' })], [o('daily_faceoff', '8475717', 'Cam Pickard', 'likely')]), DIST, { now: '2026-10-25T18:00:20Z', first: r1 });
const c4 = G.nhlgBuildCard(GI, INPUTS, merged([o('nhl_api_boxscore', '8482447', 'L. Meriläinen', 'confirmed')], [o('daily_faceoff', '8475717', 'Cam Pickard', 'confirmed', { source_updated_at: '2026-10-26T01:14:00Z' })]), DIST, { now: '2026-10-26T01:30:15Z', first: r1 });
const cc = G.nhlgBuildCard(GI, INPUTS, merged([o('daily_faceoff', '8482447', 'Leevi Merilainen', 'confirmed'), o('nhl_api_boxscore', '8480947', 'K. Lankinen', 'confirmed')], [o('daily_faceoff', '8475717', 'Cam Pickard', 'confirmed')]), DIST, { now: '2026-10-26T01:30:15Z', first: r1 });
const live = (card, version, extra) => Object.assign({ state: 'CARD', freshness: 'FRESH', versions: version, card: row(card, version, 100 + version) }, extra || {});
const g = { game_id: 2026020184, home: 'VAN', away: 'MIN', start_utc: GI.start_utc, goalies: SLATE.games.find((x) => x.game_id === 2026020184).goalies, prices: SLATE.games.find((x) => x.game_id === 2026020184).prices };

/* ---------------------------------------------------------------- the block */
let h = GL.html(live(c1, 1), g), t = text(h);
chk('block v1: each starter with a badge, a source and an "as of" time', /K\. Lankinen\s+Projected/.test(t) && /C\. Pickard\s+Projected/.test(t) && /EdgeDesk usage projection · as of Oct 25, 8:41 AM ET · 52% to start/.test(t), t);
chk('block v1: the projection is labelled T2 (EdgeDesk\'s estimate), not an observation', /title="EdgeDesk’s own estimate/.test(h) && />T2</.test(h));
chk('block v1: not Confirmed → the full range: win % and fair line for every pairing (4)', (h.match(/<tr( class="on")?><td>/g) || []).length === 4 && /VAN 39\.4% to 42\.4% across 4 realistic pairings/.test(t) && /\+154 \/ −154|\+154 \/ -154/.test(t), t);
chk('block v1: Known Limitations: "Starter not confirmed. Numbers may change."', /Known limitations\s+Starter not confirmed\. Numbers may change\./.test(t));
chk('block v1: the edge flag is gated, and the headline is said to carry no goalie term', /Edge flag: gated/.test(t) && /carries no goalie term/.test(t));
h = GL.html(live(c2, 2), g); t = text(h);
chk('block v2: "Updated: starter changed from K. Lankinen to L. Meriläinen" with both versions\' win %', /Updated: starter changed from K\. Lankinen to L\. Meriläinen\. VAN 41\.2% under version 1 \(Oct 25, 8:00 AM ET\) → 42\.4% now/.test(t), t);
chk('block v2: Daily Faceoff is Observed (T0), with its news time', />T0</.test(h) && /L\. Meriläinen\s+Likely\s+T0\s+Daily Faceoff · as of Oct 25, 1:42 PM ET/.test(t), t);
chk('block v2: Likely is not Confirmed: still the range, still the limitation', /realistic pairings/.test(t) && /Starter not confirmed/.test(t));
h = GL.html(live(c4, 4), g); t = text(h);
chk('block v4: both Confirmed → one line, "With these starters", no range table, the edge flag open', /With these starters \(goalie-aware variant\) ?: VAN 42\.4%/.test(t) && !/realistic pairing/.test(t) && /Edge flag: open/.test(t) && !/Starter not confirmed/.test(t), t);
chk('block v4: the change after first posting is still shown', /Updated: starter changed from K\. Lankinen to L\. Meriläinen/.test(t));
h = GL.html(live(cc, 2), g); t = text(h);
chk('block conflict: "sources disagree", the range, the limitation naming both sources, never as fact', /sources disagree/.test(t) && /realistic pairings/.test(t) && /Sources disagree on the VAN starter/.test(t) && /Edge flag: gated/.test(t), t);
h = GL.html(live(c2, 2, { freshness: 'STALE', reason: 'starters last checked Oct 25 02:05 PM ET' }), g); t = text(h);
chk('block: a stale check says so, with the time', /Starter status may be out of date\. starters last checked Oct 25 02:05 PM ET/.test(t), t);
chk('block: a failed check says so', /out of date/.test(text(GL.html(live(c2, 2, { freshness: 'FAILED', reason: 'the latest check failed: no starter source could be read' }), g))));

/* every non-Confirmed rendering shows the range: a single goalie is never shown as fact */
for (const [name, c] of [['v1', c1], ['v2', c2], ['conflict', cc]]) chk('never a single goalie as fact unless Confirmed: ' + name + ' shows the range', /Every realistic pairing/.test(GL.html(live(c, 2), g)));

/* the slate's own block, when the live layer has not answered */
const fs1 = GL.fromSlate(g, SLATE);
h = GL.html(Object.assign(fs1, { live_error: 'the NHL goalie layer is not deployed' }), g); t = text(h);
chk('slate fallback: the same shape — both Projected (T2), the slate\'s 4 pairings, the limitation', fs1.card.goalie_status_home === 'projected' && fs1.card.pairing_range.length === 4 && /K\. Lankinen\s+Projected/.test(t) && /Starter not confirmed/.test(t) && /realistic pairings/.test(t), t);
chk('slate fallback: it says the live sync did not answer, and why', /The live starter sync did not answer \(the NHL goalie layer is not deployed\)/.test(t));
chk('slate fallback: the pairing shown is the slate\'s likeliest (Lankinen / Pickard, 41.2%)', fs1.card.pairing_price && fs1.card.pairing_price.p_home === 0.4117);
const gConf = JSON.parse(JSON.stringify(g)); gConf.goalies = { certainty: 'CONFIRMED', confirmed_source: { source: 'team announcement', recorded_at: '2026-10-25T23:00:00Z' }, home: [{ goalie: 8482447, name: 'L. Meriläinen', p_start: 1, confirmed: true }], away: [{ goalie: 8475717, name: 'C. Pickard', p_start: 1, confirmed: true }], scenarios: [g.goalies.scenarios[2]] };
const fs2 = GL.fromSlate(gConf, SLATE);
chk('slate fallback: a manual confirmation on file reads Confirmed, with its source', fs2.card.goalie_status_home === 'confirmed' && /Manual entry \(team announcement\)/.test(text(GL.html(fs2, gConf))) && fs2.card.edge_gate_state === 'OPEN');

/* ---------------------------------------------------------------- the market gate */
const base = { market: { kind: 'moneyline', label: 'VAN moneyline' }, model: { p_win: 0.4174, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900, sd_pp: 0.5 }, quote: { american: 150, book: 'b', captured_at: '2026-10-25T23:59:00Z', source: 'captured' } };
const ev = (model, context) => MK.evaluate(Object.assign({}, base, { model: Object.assign({}, base.model, model), context: Object.assign({ now: Date.parse('2026-10-26T00:00:00Z'), data_state: 'FRESH' }, context) }));
const gateOf = (r) => r.gates.find((x) => x.gate === 'goalie_gate');
let r = ev({}, { goalie_certainty: 'PROJECTED_UNCERTAIN' });
chk('gate: a starter not Confirmed and no pairing range → the goalie gate fails (no edge can be flagged)', !gateOf(r).ok && /not priced under every realistic goalie pairing/.test(gateOf(r).reason) && r.label !== 'VERIFIED_VALUE', r.gates);
r = ev({ scenario_p_win: c1.pairing_range.map((p) => p.p_home) }, { goalie_status: { home: 'projected', away: 'projected' } });
chk('gate: VAN +150 with Lankinen / Wallstedt in the range → fails (the worst pairing is below +2%)', !gateOf(r).ok && r.label === 'PROVISIONAL' && r.reasons.some((x) => /goalie gate/.test(x)), [gateOf(r), r.label]);
r = ev({ scenario_p_win: c1.pairing_range.map((p) => p.p_home) }, { goalie_status: { home: 'projected', away: 'projected' } });
r = MK.evaluate(Object.assign({}, base, { quote: Object.assign({}, base.quote, { american: 175 }), model: Object.assign({}, base.model, { scenario_p_win: c1.pairing_range.map((p) => p.p_home) }), context: { now: Date.parse('2026-10-26T00:00:00Z'), data_state: 'FRESH', goalie_status: { home: 'projected', away: 'projected' } } }));
chk('gate: VAN +175 holds under every pairing → the goalie gate passes though nobody is Confirmed (and VERIFIED VALUE is possible only with every other gate)', gateOf(r).ok && r.label === 'VERIFIED_VALUE', [gateOf(r), r.label, r.gates.filter((x) => !x.ok)]);
r = ev({}, { goalie_status: { home: 'confirmed', away: 'confirmed', conflict: false } });
chk('gate: both Confirmed (from the starter sync) → the goalie gate passes', gateOf(r).ok && /both starters are Confirmed/.test(gateOf(r).reason));
r = ev({}, { goalie_status: { home: 'confirmed', away: 'confirmed', conflict: true } });
chk('gate: a conflict is never "both Confirmed"', !gateOf(r).ok);
r = ev({}, { goalie_certainty: 'CONFIRMED' });
chk('gate: the slate\'s CONFIRMED certainty (a manual confirmation) still opens it when no sync status is given', gateOf(r).ok);
r = MK.evaluate({ market: { kind: 'total', label: 'Over 5.5' }, model: { p_win: 0.62, p_push: 0, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900, scenario_p_win: c1.pairing_range.map((p) => ({ p: p.total['5.5'][0], push: p.total['5.5'][1] })) },
  quote: { american: 200, book: 'b', captured_at: '2026-10-25T23:59:00Z', source: 'captured' }, context: { now: Date.parse('2026-10-26T00:00:00Z'), goalie_status: { home: 'projected', away: 'projected' } } });
chk('gate: totals follow the same rule, each pairing with its own push', gateOf(r).ok && /4 realistic goalie pairings/.test(gateOf(r).reason), gateOf(r));

/* ---------------------------------------------------------------- compare, with and without the live card */
const sg = SLATE.games.find((x) => x.game_id === 2026020184);
let v = CMP.view(sg, SLATE);
chk('compare: from the slate, the pairings are the slate\'s scenarios, with their puck lines and totals', v.pairings_source === 'slate' && v.pairings.length === 4 && v.goalie_status === null && v.pairings.every((x) => x.p_home != null));
v = CMP.view(sg, SLATE, { goalies: live(c2, 2) });
chk('compare: with the live card, its pairings and statuses drive the gate', v.pairings_source === 'starter_sync' && v.pairings.length === c2.pairing_range.length && v.goalie_status.home === 'likely' && v.goalie_status.version === 2, v.goalie_status);
const sc = CMP.scenFor(CMP.view(sg, SLATE, { goalies: live(c1, 1) }), 'puck_line', 'away', 1.5);
chk('compare: the away +1.5 under each pairing is 1 − P(home covers −1.5)', sc.length === 4 && Math.abs(sc[0].p - (1 - c1.pairing_range[0].puck_line['-1.5'][0] - c1.pairing_range[0].puck_line['-1.5'][1])) < 1e-9, sc);
chk('compare: a line a pairing has no price for gives no range (the gate then cannot pass)', CMP.scenFor(CMP.view(sg, SLATE, { goalies: live(c1, 1) }), 'total', 'over', 8.5).length === 0);
const mk = { book: 'DraftKings', source: 'captured', captured_at: '2026-10-25T23:59:00Z', moneyline: { home: 150, away: -170 }, total: { point: 6.5, over: 105, under: -125 }, spread: { home: { point: 1.5, price: -190 }, away: { point: -1.5, price: 160 } } };
const out = CMP.compare(CMP.view(sg, SLATE, { goalies: live(c1, 1) }), mk, { now: Date.parse('2026-10-26T00:00:00Z') });
const allSides = out.markets.reduce((a, m) => a.concat(m.sides), []);
chk('compare: every side of the moneyline, puck line and total carries the goalie gate', out.markets.length === 3 && allSides.every((x) => x.gates.some((y) => y.gate === 'goalie_gate')), out.markets.map((m) => m.kind));

/* ---------------------------------------------------------------- the lineup lock: the card's headline replaces the slate's */
{
  const SRC = require(path.join(__dirname, 'fixtures', 'nhl_goalie_sources.js'));
  const IL = SRC.withLineups(INPUTS), giL = IL.games[0];
  const mC = merged([o('nhl_api_boxscore', '8482447', 'L. Meriläinen', 'confirmed')], [o('nhl_api_boxscore', '8475717', 'C. Pickard', 'confirmed')]);
  const lineups = { home: SRC.skaterIds('VAN', 17, 2).concat(['9100099']), away: SRC.skaterIds('MIN') };
  const c5 = G.nhlgBuildCard(giL, IL, mC, DIST, { now: '2026-10-26T01:50:10Z', first: r1, lineups });
  const c4b = G.nhlgBuildCard(giL, IL, mC, DIST, { now: '2026-10-26T01:30:15Z', first: r1 });
  const hL = GL.html(live(c5, 5), g), tL = text(hL);
  chk('block at lock: "Priced at lineup lock", the lock price, its fair line, and the slate\'s price before lock', /Priced at lineup lock\./.test(tL) && tL.indexOf('VAN ' + (Math.round(c5.headline.p_home * 1000) / 10).toFixed(1) + '%') >= 0 && /before lock: VAN 41\.7%/.test(tL), tL);
  chk('block at lock: no second, goalie-only "With these starters" number beside it', !/With these starters/.test(tL));
  chk('block before lock (both Confirmed): the goalie-only number, and no lock line', /With these starters/.test(text(GL.html(live(c4b, 4), g))) && !/Priced at lineup lock/.test(text(GL.html(live(c4b, 4), g))));
  let vl = CMP.view(sg, SLATE, { goalies: live(c5, 5) });
  chk('compare at lock: the moneyline is the card\'s lock price, and the view says it is (priced_at, card version, before lock)', vl.priced_at === 'lineup_lock' && vl.moneyline.home === c5.headline.p_home && vl.lineup_lock.card_version === 5 && vl.lineup_lock.before_p_home === 0.4174, [vl.priced_at, vl.moneyline, vl.lineup_lock]);
  chk('compare at lock: puck lines and totals come from the same lock distribution, each with its push', vl.puck_line.length === 4 && vl.puck_line.find((x) => x.home_line === -1.5).home === c5.headline.markets.puck_line['-1.5'][0] && vl.total.lines.length === 5 && vl.total.expected === c5.headline.exp_total && vl.total.lines.every((x) => Math.abs(x.over + x.under + x.push - 1) < 1e-6), vl.total);
  vl = CMP.view(sg, SLATE, { goalies: live(c5, 5), compact: true });
  chk('compare at lock, compact (Today\'s Games): only the ±1.5 puck lines', vl.puck_line.length === 2 && vl.puck_line.every((x) => Math.abs(Math.abs(x.home_line) - 1.5) < 1e-9));
  chk('compare before lock: the slate\'s numbers, said to be the slate\'s', CMP.view(sg, SLATE, { goalies: live(c4b, 4) }).priced_at === 'slate' && CMP.view(sg, SLATE, { goalies: live(c4b, 4) }).moneyline.home === sg.prices.moneyline.home);
  const outL = CMP.compare(CMP.view(sg, SLATE, { goalies: live(c5, 5) }), mk, { now: Date.parse('2026-10-26T01:51:00Z') });
  const mlL = outL.markets.find((m) => m.kind === 'moneyline');
  chk('compare at lock: EdgeDesk\'s side of the moneyline and its EV at the book are the lock price\'s', mlL && Math.abs(mlL.sides.find((x) => x.key === 'home' || x.side === 'home' || x.name === 'VAN').edgedesk_pct - c5.headline.p_home * 100) < 0.051, mlL && mlL.sides);
}

/* ================================================ the live read: load() and its errors
   Every answer becomes the card's state or its error, never a rejection. Before 2026-10-26 an answer
   with no state was thrown inside .then(ok, fail)'s ok, where fail never sees it: load() rejected, the
   engine panel's GL.load(id).then(render) left it unhandled on the page, and the cache kept the
   rejected promise as "loading", so the block spun until the page was reloaded. */
(async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
  process.on('unhandledRejection', onUnhandled);
  const realFetch = globalThis.fetch, prev = { url: globalThis.SB_URL, key: globalThis.SB_KEY };
  globalThis.SB_URL = 'https://stub.supabase.co'; globalThis.SB_KEY = 'anon-stub';
  const answer = (body, status) => { globalThis.fetch = () => Promise.resolve({ ok: (status || 200) < 300, status: status || 200, json: () => Promise.resolve(body) }); };
  const settle = () => new Promise((r) => setImmediate(r));
  const read = async (id) => { let threw = null, out; try { out = await GL.load(id, true); } catch (e) { threw = String((e && e.message) || e); } await settle(); await settle(); return { out, threw, st: GL.state(id) }; };
  try {
    answer([]);   /* an empty PostgREST answer: no state */
    let r = await read('g-nostate');
    chk('load: an answer with no state resolves (null), it does not reject', r.threw === null && r.out === null, r.threw);
    chk('load: …it is the card\'s error, said in words', r.st.err === 'the starter sync answered without a state', r.st);
    chk('load: …and the card is no longer loading', r.st.loading === false, r.st);
    answer({ state: 'NO_CARD', freshness: 'FRESH', versions: 0 });
    r = await read('g-nostate');
    chk('load: the next answer with a state is read (nothing stuck on the failed one)', r.threw === null && r.out && r.out.state === 'NO_CARD' && r.st.err === null && r.st.loading === false, r.st);
    answer({ message: 'not found' }, 404);
    r = await read('g-404');
    chk('load: an HTTP failure is the card\'s error too, and names a missing layer', r.threw === null && r.out === null && /HTTP 404 \(the NHL goalie layer is not deployed\)/.test(r.st.err || ''), r.st);
    chk('load: no unhandled rejection reached the process', unhandled.length === 0, unhandled);
  } catch (e) {
    chk('load: the live-read checks ran', false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    globalThis.fetch = realFetch; globalThis.SB_URL = prev.url; globalThis.SB_KEY = prev.key;
    process.removeListener('unhandledRejection', onUnhandled);
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL goalie block and gate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
