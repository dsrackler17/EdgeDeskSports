#!/usr/bin/env node
/* ===========================================================================
   The Signal Center engine (lib/edgedesk_signal_engine.js), the Model DNA
   builder (lib/edgedesk_model_dna.js) and one evaluation over the real
   committed sources (tools/signal_center/evaluate.js).

     node tools/signal_center/engine.test.js

     identity     the same comparison gets the same key and version hash; a
                  re-evaluation an hour later hashes equal; a different record
                  gets a different key
     arithmetic   displayed changes are the difference of the displayed values
                  (lib/edgedesk_calc.js policy), signs, rounding, relative change
     forecast     a move under the floor is not a signal; a model-version change
                  is labelled MODEL_VERSION_CHANGE with no rarity and a penalty;
                  rarity is point-in-time; a recorded record change is a
                  SUPPORTED_ASSOCIATION, nothing recorded is UNEXPLAINED; an
                  UNAVAILABLE snapshot is skipped; a cause is never CONFIRMED
     market       American / no-vig arithmetic; stale quotes, started games,
                  non-markets, unknown and swapped orientation are refused; a
                  divergence names its book, capture time and market test and
                  never claims an edge; convergence needs the same book and version
     line moves   same book only; under the floor is nothing
     simulator    Monte Carlo noise is not a signal (z); a provenance change is
                  refused; CFB Estimated outcomes say so; one-sided outcomes skip
     injuries     undated reports are refused; an unchanged status is not news;
                  a model effect is printed only when one was computed
     audits       a calibration band outside its interval with n >= 20 warns; a
                  TOO_EARLY market comparison does not; the serving version
                  with no live games warns
     DNA          grades follow the documented rule; spread/total are never
                  reduced to a win rate; small samples are counts
     scoring      components, weights, penalties and labels; the claim is printed
     copy         no payload carries a banned phrase; the guard refuses one
     real data    the committed sources evaluate deterministically, every signal
                  is VERIFIED or explains why not, and every payload re-hashes
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const DNA = require(path.join(ROOT, 'lib', 'edgedesk_model_dna.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = PG.kit('signal center engine');
const chk = T.chk;

const NOW = Date.parse('2026-10-23T20:30:00Z');
const GAME = {
  sport: 'nfl', league: 'nfl', season: 2026, event_key: 'nfl|2026_08_TST_HOM', event_at: '2026-10-26T17:00:00Z',
  home: { name: 'Home Team', abbr: 'HOM' }, away: { name: 'Test Visitors', abbr: 'TST' }, settles: 'game winner',
  research_href: '#game/nfl/2026_08_TST_HOM', source: { id: 'fx', label: 'fixture', ref: 'fixture' }
};
function snap(id, at, p, ver, extra) {
  return Object.assign({ snapshot_id: id, at, built_at: at, p_home: p, model_id: ver || 'm1', model_version: ver || 'm1', data_status: 'OK', consistent: true, inputs: { home_record: '3-2', away_record: '2-3', built_at: at } }, extra || {});
}

/* ── identity ─────────────────────────────────────────────────────────── */
{
  const s = [snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56)];
  const r1 = E.forecastShifts(s, GAME, { now: NOW }).signals;
  const r2 = E.forecastShifts(s, GAME, { now: NOW + 3600e3 }).signals;
  chk('one signal from a 6 pp move', r1.length === 1, r1.length);
  chk('same comparison, same key', r1[0].signal_key === r2[0].signal_key);
  chk('re-evaluated an hour later, same version hash (score/relevance/detected_at are volatile)', r1[0].version_hash === r2[0].version_hash);
  chk('detected_at is the evaluation time', r1[0].detected_at === new Date(NOW).toISOString());
  const s3 = [snap('a', '2026-10-22T10:00:00Z', 0.50), snap('c', '2026-10-22T11:00:00Z', 0.56)];
  chk('a different record, a different key', E.forecastShifts(s3, GAME, { now: NOW }).signals[0].signal_key !== r1[0].signal_key);
  chk('keys are prefixed and stable', /^sc1-[0-9a-f]{16}$/.test(r1[0].signal_key) && /^sv1-[0-9a-f]{16}$/.test(r1[0].version_hash));
  const again = E.versionHash(JSON.parse(JSON.stringify(r1[0])));
  chk('a payload re-hashes to its own version hash after a JSON round trip', again === r1[0].version_hash);
}

/* ── men's college basketball (published daily runs) ──────────────────── */
{
  const NG = Object.assign({}, GAME, { sport: 'ncaam', league: 'ncaam', event_key: 'NCAAM|401', event_at: '2026-11-12T00:00:00Z', home: { name: 'Home U', abbr: null }, away: { name: 'Away State', abbr: null }, research_href: null, simulator_href: '#simulator/ncaam' });
  const run = (id, at, p, hg, flags) => snap(id, at, p, 'ncaam_rtm@1.2.0', { data_status: flags ? 'LIMITED' : 'OK', inputs: { home_games: hg, away_games: 4, availability: 'Not modelled', built_at: at, flags: flags || null } });
  const s = E.forecastShifts([run('r1', '2026-11-10T14:00:00Z', 0.60, 3, 'EARLY_SEASON_FEW_GAMES'), run('r2', '2026-11-11T14:00:00Z', 0.52, 4, 'EARLY_SEASON_FEW_GAMES')], NG, { now: Date.parse('2026-11-11T15:00:00Z') }).signals;
  chk('a daily-run move of 8 pp is one verified forecast shift', s.length === 1 && s[0].values.change_pp === 8 && s[0].verification.state === 'VERIFIED', s.map((x) => [x.headline, x.verification.failed]));
  chk('…supported by a source-dated fact: a game was rated in between', s[0].evidence.class === 'SUPPORTED_ASSOCIATION' && /home team’s rated games changed from 3 to 4/.test(s[0].evidence.summary), s[0].evidence.summary);
  chk('…carrying the early-season flag', s[0].quality.flags.indexOf('DATA_LIMITED') >= 0);
  chk('…linking to the Simulator, with no game page claimed', s[0].links.simulator === '#simulator/ncaam' && s[0].links.research === null);
}

/* ── arithmetic ───────────────────────────────────────────────────────── */
{
  chk('displayed change = difference of displayed values (0.5545 -> 55.5, 0.6012 -> 60.1 => +4.6)', E._ppChange(0.5545, 0.6012) === 4.6, E._ppChange(0.5545, 0.6012));
  chk('negative change keeps its sign', E._ppChange(0.6, 0.55) === -5);
  chk('zero is zero, not -0', Object.is(E._ppChange(0.5, 0.5), 0));
  const s = [snap('a', '2026-10-22T10:00:00Z', 0.62), snap('b', '2026-10-22T11:00:00Z', 0.55)];
  const sig = E.forecastShifts(s, GAME, { now: NOW }).signals[0];
  chk('the subject is the team the move favours (away here)', sig.subject.side === 'away' && sig.subject.label === 'Test Visitors');
  chk('its change is positive and reproducible from the displayed values', sig.values.change_pp === 7 && sig.values.previous.display === '38.0%' && sig.values.current.display === '45.0%', sig.values);
  chk('the home-side change keeps the original sign', sig.values.home_change_pp === -7);
  chk('relative change is computed from the same side', Math.abs(sig.values.relative_change - (0.45 - 0.38) / 0.38) < 1e-4);
  chk('the headline prints percentage points as pp', /up 7\.0 pp to 45\.0%/.test(sig.headline), sig.headline);
}

/* ── forecast shifts ──────────────────────────────────────────────────── */
{
  const small = [snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.52)];
  const r = E.forecastShifts(small, GAME, { now: NOW });
  chk('a 2 pp move is under the 3 pp floor: no signal', r.signals.length === 0);
  chk('…but it is a move in the reference distribution', r.moves.length === 1 && r.moves[0].abs_pp === 2);
  const ver = [snap('a', '2026-10-22T10:00:00Z', 0.50, 'm1'), snap('b', '2026-10-22T11:00:00Z', 0.60, 'm2')];
  const v = E.forecastShifts(ver, GAME, { now: NOW });
  chk('a model-version change is labelled MODEL_VERSION_CHANGE', v.signals[0].evidence.class === 'MODEL_VERSION_CHANGE' && v.signals[0].subtype === 'model_version_change');
  chk('…its headline says so, never "win probability up"', /model version change/.test(v.signals[0].headline) && !/win probability up/.test(v.signals[0].headline));
  chk('…it gets no rarity', v.signals[0].values.distribution.rarity === null);
  chk('…and the methodology penalty', v.signals[0].score.penalties.some((p) => p.id === 'methodology_change'));
  chk('…and is not a same-version move in the reference', v.moves.length === 0);
  const rec = [snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56, null, { inputs: { home_record: '4-2', away_record: '2-3', built_at: '2026-10-22T11:00:00Z' } })];
  const s2 = E.forecastShifts(rec, GAME, { now: NOW }).signals[0];
  chk('a recorded record change is a SUPPORTED_ASSOCIATION', s2.evidence.class === 'SUPPORTED_ASSOCIATION', s2.evidence.class);
  chk('…and says its share is not isolated', /has not been isolated/.test(s2.evidence.summary));
  const un = E.forecastShifts([snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56)], GAME, { now: NOW }).signals[0];
  chk('nothing recorded changed: UNEXPLAINED, and says EdgeDesk does not know yet', un.evidence.class === 'UNEXPLAINED' && /does not know yet/.test(un.evidence.summary));
  const gap = [snap('a', '2026-10-22T10:00:00Z', 0.50), snap('x', '2026-10-22T10:30:00Z', null, null, { data_status: 'UNAVAILABLE' }), snap('b', '2026-10-22T11:00:00Z', 0.56)];
  const g = E.forecastShifts(gap, GAME, { now: NOW }).signals;
  chk('an UNAVAILABLE snapshot is skipped, the comparison bridges it', g.length === 1 && g[0].values.previous.snapshot_id === 'a' && g[0].values.current.snapshot_id === 'b');
  const ref = { nfl: [] };
  for (let i = 0; i < 40; i++) ref.nfl.push({ at: '2026-10-20T00:00:00Z', abs_pp: i < 30 ? 1 : 9 });
  ref.nfl.push({ at: '2026-10-25T00:00:00Z', abs_pp: 50 }); /* after the snapshot: never read */
  const rr = E.forecastShifts([snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56)], GAME, { now: NOW, reference: ref }).signals[0];
  chk('rarity is point-in-time: 30 of 40 earlier moves were smaller', rr.values.distribution.rarity === 0.75 && rr.values.distribution.reference_n === 40, rr.values.distribution);
  const few = E.forecastShifts([snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56)], GAME, { now: NOW, reference: { nfl: ref.nfl.slice(0, 10) } }).signals[0];
  chk('fewer than 30 earlier moves: rarity null, scored 0, explained', few.values.distribution.rarity === null && few.score.missing.indexOf('rarity') >= 0);
  const all = [un, s2, v.signals[0], rr];
  chk('a cause is never CONFIRMED from snapshots', all.every((x) => x.evidence.class !== 'CONFIRMED_CAUSE'));
  chk('every forecast signal carries six distinct timestamps', ['event_at', 'source_published_at', 'calculated_at', 'recorded_at', 'detected_at'].every((k) => k in un.timestamps));
  const post = Object.assign({}, GAME, { event_at: '2026-10-22T10:30:00Z' });
  const pg = E.forecastShifts([snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56)], post, { now: NOW }).signals[0];
  chk('a snapshot after the start fails the pregame check and is UNVERIFIED', pg.verification.state === 'UNVERIFIED' && pg.verification.failed.indexOf('pregame') >= 0);
  const inc = E.forecastShifts([snap('a', '2026-10-22T10:00:00Z', 0.50), snap('b', '2026-10-22T11:00:00Z', 0.56, null, { consistent: false })], GAME, { now: NOW }).signals[0];
  chk('a snapshot whose summary disagrees with its spec is UNVERIFIED', inc.verification.state === 'UNVERIFIED');
}

/* ── market ───────────────────────────────────────────────────────────── */
{
  const nv = C.noVigTwoWay(-162, 136);
  chk('no-vig: -162 / +136 multiplicative', Math.abs(nv.a - 0.5934) < 1e-3 && Math.abs(nv.a + nv.b - 1) < 1e-12, nv);
  chk('American +150 -> decimal 2.5, -200 -> 1.5', C.decimalFromAmerican(150) === 2.5 && C.decimalFromAmerican(-200) === 1.5);
  chk('±99 is not an American price', C.decimalFromAmerican(-99) === null);
  const model = { p_home: 0.30, at: '2026-10-23T19:00:00Z', snapshot_id: 's1', model_id: 'm1', model_version: 'm1', data_status: 'OK', validation: { market_test: 'TESTED_BEHIND', value_claims: false } };
  const quote = { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: '2026-10-23T19:30:00Z', moneyline: { home: -162, away: 136 }, home: { name: 'Home Team', abbr: 'HOM' }, away: { name: 'Test Visitors', abbr: 'TST' } };
  const r = E.marketDivergence([{ game: GAME, model, quote }], { now: NOW });
  const d = r.signals[0];
  chk('a 29 pp gap is a divergence', r.signals.length === 1, r);
  chk('…on the side the model is higher on (away)', d.subject.side === 'away' && d.values.change_pp > 0);
  chk('…naming the book, capture time and de-vig method', d.market.book === 'DraftKings' && d.market.captured_at === '2026-10-23T19:30:00.000Z' && /multiplicative/.test(d.market.devig_method));
  chk('…carrying the market test caveat', /behind the closing market/.test(d.evidence.summary));
  chk('…never claiming an edge or value', E.copyOk(d.headline) && E.copyOk(d.summary) && /not a betting/i.test(d.summary));
  chk('…and a consensus block with no consensus number', d.consensus.available && d.consensus.consensus === null && /validated out of sample/.test(d.consensus.consensus_note));
  const stale = E.marketDivergence([{ game: GAME, model, quote: Object.assign({}, quote, { captured_at: '2026-10-23T15:00:00Z' }) }], { now: NOW });
  chk('a quote older than 180 minutes is refused as not a current price', stale.signals.length === 0 && /not a current price/.test(stale.refused[0].reason));
  const started = E.marketDivergence([{ game: Object.assign({}, GAME, { event_at: '2026-10-23T20:00:00Z' }), model, quote }], { now: NOW });
  chk('a started game is refused', started.signals.length === 0 && /started/.test(started.refused[0].reason));
  const bad = E.marketDivergence([{ game: GAME, model, quote: Object.assign({}, quote, { moneyline: { home: 150, away: 150 } }) }], { now: NOW });
  chk('+150 / +150 is not a market (negative overround) and is refused', bad.signals.length === 0, bad.refused);
  const swapped = E.marketDivergence([{ game: GAME, model, quote: Object.assign({}, quote, { home: quote.away, away: quote.home }) }], { now: NOW });
  chk('a quote with the teams the other way round is refused', swapped.signals.length === 0 && /other way round/.test(swapped.refused[0].reason));
  const blind = E.marketDivergence([{ game: GAME, model, quote: { book: 'X', captured_at: quote.captured_at, moneyline: quote.moneyline } }], { now: NOW });
  chk('a quote with no team names and no oriented join is refused', blind.signals.length === 0 && /orientation unknown/.test(blind.refused[0].reason));
  const close = E.marketDivergence([{ game: GAME, model: Object.assign({}, model, { p_home: 0.55 }), quote }], { now: NOW });
  chk('a 4 pp gap is under the 8 pp floor: no signal, but counted as a board gap', close.signals.length === 0 && close.gaps.length === 1);
  /* convergence */
  const later = Date.parse('2026-10-24T12:00:00Z');
  const conv = E.marketConvergence([d], [{ game: GAME, model: Object.assign({}, model, { p_home: 0.57, at: '2026-10-24T11:00:00Z' }), quote: Object.assign({}, quote, { captured_at: '2026-10-24T11:30:00Z' }) }], { now: later });
  chk('a closed divergence (29 -> 2 pp) is a convergence', conv.length === 1 && conv[0].category === 'MARKET_CONVERGENCE', conv.map((x) => x.headline));
  chk('…saying who moved', /mostly the model/.test(conv[0].evidence.summary), conv[0].evidence.summary);
  const otherBook = E.marketConvergence([d], [{ game: GAME, model: Object.assign({}, model, { p_home: 0.57, at: '2026-10-24T11:00:00Z' }), quote: Object.assign({}, quote, { book: 'Other', captured_at: '2026-10-24T11:30:00Z' }) }], { now: later });
  chk('a different book is never a convergence', otherBook.length === 0);
  const otherVer = E.marketConvergence([d], [{ game: GAME, model: Object.assign({}, model, { p_home: 0.57, model_version: 'm2', at: '2026-10-24T11:00:00Z' }), quote: Object.assign({}, quote, { captured_at: '2026-10-24T11:30:00Z' }) }], { now: later });
  chk('a different model version is never a convergence', otherVer.length === 0);
  chk('a divergence within 2 pp of its stored version is not a new version', E.materialUpdate(d, Object.assign({}, d, { version_hash: 'x', values: Object.assign({}, d.values, { change_pp: d.values.change_pp + 1 }) })).update === false);
  chk('a changed verification is always a new version', E.materialUpdate(d, Object.assign({}, d, { version_hash: 'x', verification: { state: 'UNVERIFIED' } })).update === true);
}

/* ── line movement ────────────────────────────────────────────────────── */
{
  const q = (at, h, a, book) => ({ book: book || 'DK', captured_at: at, moneyline: { home: h, away: a } });
  const r = E.lineMovement([q('2026-10-22T10:00:00Z', -110, -110), q('2026-10-22T12:00:00Z', -160, 135)], GAME, { now: NOW });
  chk('a same-book no-vig move of ~9 pp is a line movement', r.signals.length === 1 && r.signals[0].values.change_pp > 8, r.signals.map((s) => s.values.change_pp));
  const two = E.lineMovement([q('2026-10-22T10:00:00Z', -110, -110, 'A'), q('2026-10-22T12:00:00Z', -160, 135, 'B')], GAME, { now: NOW });
  chk('two different books are never compared', two.signals.length === 0);
  const small = E.lineMovement([q('2026-10-22T10:00:00Z', -110, -110), q('2026-10-22T12:00:00Z', -120, 100)], GAME, { now: NOW });
  chk('under the 4 pp floor: no signal', small.signals.length === 0 && small.moves.length === 1);
  chk('a price move is never read as information about the game', /never read as information/.test(r.signals[0].evidence.attribution));
}

/* ── simulator ────────────────────────────────────────────────────────── */
{
  const run = (id, at, ver) => ({ run_id: id, model_version: ver || 'v1', rules_version: 'r1', engine_version: 'e1', n_sims: 100000, input_snapshot_at: at, completed_at: at, published_at: at, validation_summary: {} });
  const row = (e, o, p, prov) => ({ entity_id: e, entity_name: e + ' FC', outcome: o, probability: p, mcse: Math.sqrt(p * (1 - p) / 100000), provenance: prov || 'Research', applicable: true });
  const pair = { sport: 'nfl', competition: 'NFL', season: '2026', previous: run('r1', '2026-10-20T00:00:00Z'), current: run('r2', '2026-10-22T00:00:00Z') };
  const res = { previous: [row('AAA', 'make_playoffs', 0.552), row('BBB', 'make_playoffs', 0.40), row('CCC', 'seed_1', 0.10), row('DDD', 'win_division', 0.30)], current: [row('AAA', 'make_playoffs', 0.628), row('BBB', 'make_playoffs', 0.402), row('CCC', 'seed_1', 0.20), row('EEE', 'win_division', 0.5)] };
  const r = E.simulationShifts(pair, res, { now: NOW });
  chk('55.2% -> 62.8% playoff is one simulation shift (+7.6 pp)', r.signals.length === 1 && r.signals[0].values.change_pp === 7.6, r.signals.map((s) => s.headline));
  chk('…labelled sampling-only for its Monte Carlo error', /sampling only/.test(r.signals[0].values.sampling_note) && /not the forecast’s total uncertainty/.test(r.signals[0].values.sampling_note));
  chk('…linking to the Simulator for its sport', r.signals[0].links.simulator === '#simulator/nfl');
  chk('an outcome not in the signal list (seed_1) is not a signal', r.signals.every((s) => s.outcome.id !== 'seed_1'));
  chk('an entity on one side only is not compared', r.signals.every((s) => s.subject.entity_id !== 'EEE' && s.subject.entity_id !== 'DDD'));
  const noisy = { previous: [Object.assign(row('AAA', 'make_playoffs', 0.5), { mcse: 0.02 })], current: [Object.assign(row('AAA', 'make_playoffs', 0.54), { mcse: 0.02 })] };
  chk('a 4 pp change inside 4 Monte Carlo SEs is sampling noise, not a signal', E.simulationShifts(Object.assign({}, pair, { previous: Object.assign(run('r1', '2026-10-20T00:00:00Z'), { n_sims: 10000 }), current: Object.assign(run('r2', '2026-10-22T00:00:00Z'), { n_sims: 10000 }) }), noisy, { now: NOW }).signals.length === 0);
  const prov = { previous: [row('AAA', 'cfp_field', 0.30, 'Research')], current: [row('AAA', 'cfp_field', 0.50, 'Estimated')] };
  const pr = E.simulationShifts(Object.assign({}, pair, { sport: 'cfb' }), prov, { now: NOW });
  chk('a provenance change (Research -> Estimated) is refused as a methodology change', pr.signals.length === 0 && /provenance changed/.test(pr.refused[0].reason));
  const est = { previous: [row('AAA', 'cfp_field', 0.30, 'Estimated')], current: [row('AAA', 'cfp_field', 0.50, 'Estimated')] };
  const es = E.simulationShifts(Object.assign({}, pair, { sport: 'cfb' }), est, { now: NOW }).signals[0];
  chk('a CFB committee-proxy outcome says Estimated, and that it is not the committee', /estimated/.test(es.headline) && /not the committee/.test(es.simulation.estimated_note));
  const vchg = E.simulationShifts(Object.assign({}, pair, { current: run('r2', '2026-10-22T00:00:00Z', 'v2') }), res, { now: NOW }).signals[0];
  chk('a simulator model change is a MODEL_VERSION_CHANGE', vchg.evidence.class === 'MODEL_VERSION_CHANGE');
  chk('older inputs than the previous run are refused', E.simulationShifts(Object.assign({}, pair, { previous: pair.current, current: pair.previous }), res, { now: NOW }).signals.length === 0);
  chk('no previous run: nothing to compare', E.simulationShifts({ sport: 'nfl', current: pair.current }, res, { now: NOW }).signals.length === 0);

  /* tournaments and title paths: people, not teams */
  const golf = { sport: 'golf', competition: 'PGA Tour · Test Open', season: '2026', previous: run('g1', '2026-10-22T00:00:00Z'), current: run('g2', '2026-10-23T00:00:00Z') };
  const gres = { previous: [row('p1', 'top_10', 0.30), row('p1', 'win', 0.04), row('p1', 'make_cut', 0.80, 'Research')], current: [row('p1', 'top_10', 0.42), row('p1', 'win', 0.041), row('p1', 'make_cut', 1, 'Observed')] };
  const g = E.simulationShifts(golf, gres, { now: NOW });
  chk('golf: a top-10 move of +12 pp is a signal about a player', g.signals.length === 1 && g.signals[0].outcome.id === 'top_10' && g.signals[0].subject.kind === 'player' && /top-10 finish probability up 12\.0 pp/.test(g.signals[0].headline), g.signals.map((x) => x.headline));
  chk('golf: the cut, once made (Observed), is a provenance change and never compared', g.refused.some((x) => x.outcome === 'make_cut' && /provenance changed/.test(x.reason)));
  chk('golf: its relevance says tournament, not season', /^Tournament outcome/.test(g.signals[0].relevance));
  chk('golf: the evidence speaks of a player, never a team', /this player’s number/.test(g.signals[0].evidence.summary) && !/team/.test(g.signals[0].evidence.summary));
  const golfEnd = Object.assign({}, golf, { current: Object.assign(run('g2', '2026-10-23T00:00:00Z'), { validation_summary: { sport_summary: { kind: 'golf_tournament', event: { end: '2026-10-25T07:00Z' } } } }) });
  const ge = E.simulationShifts(golfEnd, gres, { now: NOW }).signals[0];
  chk('golf: the signal expires a day after ESPN’s end date (its final day), and keeps the date as listed', ge.event.at === '2026-10-26T07:00:00.000Z' && ge.event.ends === '2026-10-25T07:00:00.000Z', ge.event);
  chk('golf: no end on file, no expiry is invented', g.signals[0].event.at === null && !('ends' in g.signals[0].event));
  chk('a team sport’s season outcome never takes an end date', E.simulationShifts(Object.assign({}, pair, { current: Object.assign(run('r2', '2026-10-22T00:00:00Z'), { validation_summary: { sport_summary: { kind: 'golf_tournament', event: { end: '2026-10-25T07:00Z' } } } }) }), res, { now: NOW }).signals[0].event.at === null);
  const ten = E.simulationShifts({ sport: 'tennis', competition: 'Test Masters', season: '2026', previous: golf.previous, current: golf.current },
    { previous: [row('t1', 'win_title', 0.20), row('t1', 'win_next_match', 0.55)], current: [row('t1', 'win_title', 0.31), row('t1', 'win_next_match', 0.75)] }, { now: NOW });
  chk('tennis: the title move is compared; "win the next match" never is', ten.signals.length === 1 && ten.signals[0].outcome.id === 'win_title', ten.signals.map((x) => x.outcome.id));
  const ufc = E.simulationShifts({ sport: 'mma', sim_sport: 'ufc', competition: 'UFC lightweight', season: '2026', previous: golf.previous, current: golf.current },
    { previous: [row('f1', 'title_shot', 0.20, 'Estimated'), row('f1', 'win_next_bout', 0.5)], current: [row('f1', 'title_shot', 0.35, 'Estimated'), row('f1', 'win_next_bout', 0.7)] }, { now: NOW });
  chk('UFC: a title-shot move is Estimated and says so; the next bout is never compared', ufc.signals.length === 1 && /estimated/.test(ufc.signals[0].headline) && /modelled step/.test(ufc.signals[0].simulation.estimated_note), ufc.signals.map((x) => x.headline));
  chk('UFC: the signal is Signal Center’s mma and links to the Simulator’s ufc', ufc.signals[0].sport === 'mma' && ufc.signals[0].links.simulator === '#simulator/ufc');
}

/* ── injuries ─────────────────────────────────────────────────────────── */
{
  const rep = (id, at, st, extra) => Object.assign({ sport: 'cfb', team: { name: 'Army' }, player: { id: 'p1', name: 'Q Back', position: 'QB' }, status: st, report: { id, type: 'Game Day', published_at: at, retrieved_at: at, source_url: 'https://example.org/r', source: 'AAC availability report' }, game: { event_key: 'cfb|1', event_at: '2026-10-25T20:00:00Z', label: 'Army at Tulsa' } }, extra || {});
  const r = E.injuryChanges([rep('1', '2026-10-24T12:00:00Z', 'QUESTIONABLE'), rep('2', '2026-10-25T18:00:00Z', 'QUESTIONABLE'), rep('3', '2026-10-25T18:30:00Z', 'OUT')], { now: NOW, positions: ['QB'] });
  chk('first listing and a change are signals; an unchanged status is not', r.length === 2 && r[0].values.current.value === 'QUESTIONABLE' && r[1].values.current.value === 'OUT', r.map((s) => s.headline));
  chk('the change names the previous status', /was questionable/.test(r[1].headline));
  chk('no model effect is claimed when none was computed', r[1].model.effect_calculated === false && /No model effect is calculated/.test(r[1].evidence.summary) && r[1].values.change_pp === null);
  chk('facts and estimates are kept apart', r[1].facts_vs_estimates.estimate === null && r[1].facts_vs_estimates.facts.length >= 1);
  const undated = E.injuryChanges([rep('1', null, 'OUT')], { now: NOW, positions: ['QB'] });
  chk('a report with no publication time is never a signal', undated.length === 0);
  const wr = E.injuryChanges([rep('1', '2026-10-24T12:00:00Z', 'OUT', { player: { id: 'p2', name: 'W R', position: 'WR' } })], { now: NOW, positions: ['QB'] });
  chk('positions out of scope are not read', wr.length === 0);
  const after = E.injuryChanges([rep('1', '2026-10-25T21:00:00Z', 'OUT')], { now: NOW, positions: ['QB'] });
  chk('a report published after the start is not a pregame signal', after.length === 0);
  const eff = E.injuryChanges([rep('1', '2026-10-24T12:00:00Z', 'OUT')], { now: NOW, positions: ['QB'], effects: { 'cfb|p1|cfb|1': { model: 'ROSTER-ADJ', version: '0.1', status: 'OK', change_pp: -6.2, team: 'Army', computed_at: '2026-10-24T12:05:00Z', isolated: true } } })[0];
  chk('a computed, isolated effect is printed as an estimate and is a confirmed cause', eff.model.effect_calculated && eff.evidence.class === 'CONFIRMED_CAUSE' && eff.values.change_pp === -6.2 && /Estimated model effect/.test(eff.facts_vs_estimates.estimate));
}

/* ── audits and DNA ───────────────────────────────────────────────────── */
{
  const reg = { sports: [{ id: 'nfl', product: 'ACTIVE', brain: { id: 'edgedesk_football', status: 'BUILT' }, readiness: { markets: { moneyline: { state: 'OUTCOME_VALIDATED', outcome: 'VALIDATED', market: 'TESTED_BEHIND', n: 2750, headline: 'h', file: 'f' }, spread: { state: 'OUTCOME_VALIDATED', outcome: 'VALIDATED', market: 'TESTED_BEHIND', n: 2761 } } } }] };
  const band = (n, mp, ob, lo, hi, inside) => ({ from: 0.6, to: 0.7, n, mean_predicted: mp, observed: ob, wilson_low: lo, wilson_high: hi, inside_interval: inside });
  const perf = (n, cal, ml, models) => ({ generated_at: '2026-10-23T19:00:00Z', min_n: 20, ledger: { epoch: '2026-10-16T00:00:00Z' }, tiers: { VERIFIED: { means: 'locked' } },
    by_sport: { nfl: { verified: { winner: { n, brier: 0.22, log_loss: 0.64, sample_state: n < 20 ? 'TOO_EARLY' : 'EARLY_SIGNAL', calibration: cal }, margin: { n, mae: 11, bias: 0, rmse: 14 }, market: { moneyline: ml } } } },
    by_model: models || [{ sport: 'nfl', tier: 'VERIFIED', model_version: 'v1', graded: n, winner: { brier: 0.22, sample_state: 'EARLY_SIGNAL' } }] });
  chk('DNA: VALIDATED backtest + < 20 live games = EARLY', DNA.build(reg, perf(12, [], null), {}, NOW)[0].grade === 'EARLY');
  chk('DNA: 20-99 live games = PARTIAL', DNA.build(reg, perf(50, [], null), {}, NOW)[0].grade === 'PARTIAL');
  chk('DNA: 100+ games and no band outside = VALIDATED', DNA.build(reg, perf(150, [band(40, 0.65, 0.62, 0.47, 0.76, true)], null), {}, NOW)[0].grade === 'VALIDATED');
  chk('DNA: a band outside its interval = PARTIAL', DNA.build(reg, perf(150, [band(40, 0.65, 0.40, 0.26, 0.55, false)], null), {}, NOW)[0].grade === 'PARTIAL');
  const prov = { sports: [{ id: 'nfl', readiness: { markets: { moneyline: { outcome: 'PROVISIONAL', market: 'NOT_TESTED' } } } }] };
  chk('DNA: a PROVISIONAL backtest = EXPERIMENTAL', DNA.build(prov, perf(150, [], null), {}, NOW)[0].grade === 'EXPERIMENTAL');
  const d = DNA.build(reg, perf(150, [], { n: 60, model_brier: 0.24, market_brier: 0.22, sample_state: 'EARLY_SIGNAL' }), { nfl: { id: 'v2', version: 'v2' } }, NOW)[0];
  chk('DNA: the trust answer names the market test and the same-games Brier pair', /behind/.test(d.trust_answer) && /0\.24 against the market’s 0\.22/.test(d.trust_answer), d.trust_answer);
  chk('DNA: a serving version with no live games is said plainly', d.serving.live_graded === 0 && /no graded live games/.test(d.trust_answer));
  chk('DNA: spread is described by its own measure, never a win rate', d.live.margin && d.live.margin.mae === 11 && d.backtest.markets.filter((m) => m.market === 'spread')[0].forecast_type === 'margin distribution');
  const w = E.reliabilityWarnings([d], { now: NOW });
  chk('warning: model Brier behind the market on the same games', w.some((x) => x.subtype === 'behind_market' && /0\.24 vs the market’s 0\.22 on the same 60 games/.test(x.headline)), w.map((x) => x.headline));
  chk('warning: the serving version has no live record', w.some((x) => x.subtype === 'no_live_record'));
  const early = DNA.build(reg, perf(150, [], { n: 23, model_brier: 0.24, market_brier: 0.22, sample_state: 'TOO_EARLY' }), {}, NOW)[0];
  chk('a TOO_EARLY market comparison is not a warning', E.reliabilityWarnings([early], { now: NOW }).every((x) => x.subtype !== 'behind_market'));
  const bandW = E.reliabilityWarnings(DNA.build(reg, perf(150, [band(40, 0.65, 0.40, 0.26, 0.55, false)], null), {}, NOW), { now: NOW });
  chk('warning: a band outside its interval, with n, both rates and the interval', bandW.length === 1 && /60–70% band ran 25\.0 pp high/.test(bandW[0].headline) && bandW[0].values.statistic.n === 40, bandW.map((x) => x.headline));
  chk('a small band (n < 20) never warns', E.reliabilityWarnings(DNA.build(reg, perf(150, [band(12, 0.65, 0.40, 0.2, 0.6, false)], null), {}, NOW), { now: NOW }).length === 0);
}

/* ── data quality ─────────────────────────────────────────────────────── */
{
  const r = E.dataQuality([{ id: 'gr', label: 'Football research snapshots', state: 'ok', generated_at: '2026-10-23T10:00:00Z', max_age_minutes: 180 }, { id: 'ok', label: 'Fresh', state: 'ok', generated_at: '2026-10-23T20:00:00Z', max_age_minutes: 180 }], { now: NOW });
  chk('a stale source warns, a fresh one does not', r.length === 1 && r[0].category === 'DATA_QUALITY_WARNING');
  const r2 = E.dataQuality([{ id: 'gr', label: 'Football research snapshots', state: 'ok', generated_at: '2026-10-23T10:00:00Z', max_age_minutes: 180 }], { now: NOW + 3 * 3600e3 });
  chk('the same stale record an hour later: same key, same version (no live age in the payload)', r2[0].signal_key === r[0].signal_key && r2[0].version_hash === r[0].version_hash);
  chk('no generation time is its own warning', E.dataQuality([{ id: 'x', label: 'X', state: 'ok', generated_at: null, max_age_minutes: 60 }], { now: NOW })[0].subtype === 'time_unknown');
}

/* ── scoring ──────────────────────────────────────────────────────────── */
{
  const w = Object.values(E.SPEC.components).reduce((s, c) => s + c.weight, 0);
  chk('component weights sum to 1', Math.abs(w - 1) < 1e-9, w);
  const s = E.score({ abs_change_pp: 10, full_scale_pp: 10, rarity: { value: 1 }, evidence_class: 'CONFIRMED_CAUSE', source_at: NOW, detected_at: NOW, reliability_grade: 'VALIDATED', event_at: NOW + 86400e3 });
  chk('every component at 1 scores 100, Major', s.total === 100 && s.label === 'Major', s);
  const z = E.score({ abs_change_pp: 0, full_scale_pp: 10, rarity: null, evidence_class: 'MODEL_VERSION_CHANGE', source_at: null, detected_at: NOW, reliability_grade: null, event_at: NOW - 1, flags: ['SOURCE_TIME_UNKNOWN'] });
  chk('missing inputs score 0, are listed, and penalties never go below 0', z.total === 0 && z.missing.indexOf('freshness') >= 0 && z.penalties.length === 1);
  chk('labels: 70 Major, 50 Notable, 30 Routine, below Monitor', E.labelFor(70) === 'Major' && E.labelFor(69.9) === 'Notable' && E.labelFor(50) === 'Notable' && E.labelFor(30) === 'Routine' && E.labelFor(29.9) === 'Monitor');
  chk('the score states that it is not a probability or a profit claim', /not a probability/.test(s.claim) && /profitable/.test(s.claim));
  chk('the explanation names every scored component', /magnitude 35/.test(s.explanation) && /rarity 25/.test(s.explanation));
}

/* ── copy rule ────────────────────────────────────────────────────────── */
{
  chk('the guard refuses tout language', !E.copyOk('Lock of the week') && !E.copyOk('a +EV edge') && !E.copyOk('Guaranteed winner') && !E.copyOk('best bet'));
  chk('the guard leaves EdgeDesk’s name alone', E.copyOk('EdgeDesk 57.7% vs Draft Kings 34.3%'));
  let threw = false;
  try { E._finish({ identity: { x: 1 }, headline: 'This is a lock', evidence: { items: [] } }, {}, { now: NOW }); } catch (e) { threw = /research-not-picks/.test(e.message); }
  chk('a payload that breaks the copy rule is refused, not softened', threw);
}

/* ── the committed sources ───────────────────────────────────────────── */
{
  const S = require('./sources.js');
  const { evaluate } = require('./evaluate.js');
  const football = S.footballGames();
  const au = S.audits();
  const inputs = { football, footballCurrent: S.footballCurrent(), perfGames: S.perfForecastGames(), perfLastCapture: au.perf && au.perf.ledger ? au.perf.ledger.last_capture_at : null, quotes: S.perfQuotes(), slateTeams: S.slateTeams(), audits: au, cfbAvailability: S.cfbAvailability(null, football), sourceStates: S.sourceStates(null), now: NOW };
  const a = evaluate(inputs), b = evaluate(inputs);
  chk('the real sources evaluate to some signals', a.signals.length > 20, a.stats);
  chk('…deterministically (same keys and hashes twice)', JSON.stringify(a.signals.map((s) => s.signal_key + s.version_hash)) === JSON.stringify(b.signals.map((s) => s.signal_key + s.version_hash)));
  chk('…one payload per key', new Set(a.signals.map((s) => s.signal_key)).size === a.signals.length);
  chk('…every payload re-hashes to its version hash', a.signals.every((s) => E.versionHash(JSON.parse(JSON.stringify(s))) === s.version_hash));
  chk('…every payload passes the copy rule', a.signals.every((s) => [s.headline, s.summary, s.evidence.summary].every(E.copyOk)));
  chk('…every unverified payload names its failed checks', a.signals.every((s) => s.verification.state === 'VERIFIED' || s.verification.failed.length > 0));
  chk('…no NFL injury signal (no dated NFL source)', a.signals.every((s) => !(s.category === 'INJURY_IMPACT' && s.sport === 'nfl')));
  chk('…no MLB forecast signal (no forecast history)', a.signals.every((s) => !(s.sport === 'mlb' && s.category === 'FORECAST_SHIFT')));
  chk('…ineligible pairs are recorded with their reasons', Object.keys(a.ineligible).length > 0 && Object.values(a.ineligible).every((v) => / — /.test(v)));
  chk('…every football divergence was oriented by team names', a.signals.filter((s) => s.category === 'MARKET_DIVERGENCE').every((s) => s.verification.checks.some((c) => c.id === 'orientation' && c.ok)));
  chk('…Model DNA has a record for NFL and CFB with a grade', ['nfl', 'cfb'].every((k) => a.dna.some((d) => d.sport === k && DNA.GRADES[d.grade])));
  chk('…no signal claims a confirmed cause', a.signals.every((s) => s.evidence.class !== 'CONFIRMED_CAUSE'));
}

process.exit(T.done());
