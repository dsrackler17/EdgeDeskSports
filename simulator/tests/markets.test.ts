/* Kalshi futures comparison over SYNTHETIC markets (invented tickers, prices
   and rules), except where a block says REAL: Kalshi's own 2026 MLB wording
   (simulator/fixtures/kalshi_mlb_2026_markets.json) and the committed config.
   node simulator/tests/markets.test.ts */
import { kit } from './_kit.ts';
import { compareFutures, validateFuturesConfig, configForSport, feePerContract, type FuturesConfig, type Quote, type RunView, type Mapping } from '../src/markets/compare.ts';
import { quoteFromMarket, kalshiClient, fetchQuotes } from '../src/markets/kalshi.ts';
import { sha256Hex } from '../src/core/canonical.ts';
import fs from 'node:fs';
import { marketStep } from '../src/cli/markets.ts';
import type { SimDb } from '../src/publish/db.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMappings, buildMlbMappings, buildNhlMappings, candidatesFromLog, versionWith, DISCLAIMER, KALSHI_TO_RETRO, KALSHI_LABEL, KALSHI_TO_NHL, NHL_PRES_TIEBREAK, type Candidate, type SeriesInfo } from '../src/cli/build_kalshi_mappings.ts';
import { MLB_TEAMS, formatFor } from '../src/sports/mlb/config.ts';
import { mlbOutcomes } from '../src/sports/mlb/module.ts';
import { NFL_TEAMS_2026 } from '../src/sports/nfl/config.ts';
import { NFL_OUTCOMES } from '../src/sports/nfl/module.ts';
import { NHL_TEAMS_2027 } from '../src/sports/nhl/config.ts';
import { NHL_OUTCOMES } from '../src/sports/nhl/module.ts';

const T = kit('Kalshi futures comparison (SYNTHETIC markets)');
const RULES = 'SYNTHETIC: resolves YES if the club wins Super Bowl LXI.';
const RH = sha256Hex(RULES + '\n');
const now = new Date('2026-10-23T12:00:00Z');
const run: RunView = { sport: 'nfl', competition: 'NFL', season: '2026', entities: [
  { entity_id: 'BUF', outcomes: { win_super_bowl: { probability: 0.20, mcse: 0.00126 }, win_division: { probability: 0.6, mcse: 0.0015 } } },
  { entity_id: 'KC', outcomes: { win_super_bowl: { probability: 0.10, mcse: 0.00095 }, win_division: { probability: 0.5, mcse: 0.0016 } } },
  { entity_id: 'SF', outcomes: { win_super_bowl: { probability: 0.70, mcse: 0.00145 }, win_division: { probability: 0.7, mcse: 0.0014 } } }] };
const map = (e: string, over: Partial<Mapping> = {}): Mapping => ({ mapping_id: 'syn-sb-' + e, status: 'verified', sport: 'nfl', competition: 'NFL', season: '2026',
  series_ticker: 'SYNSB', event_ticker: 'SYNSB-27', market_ticker: 'SYNSB-27-' + e, entity_id: e, outcome: 'win_super_bowl', outcome_set: null,
  settlement: { basis: 'SYNTHETIC Super Bowl LXI winner', rules_sha256: RH }, verified_by: 'test', verified_at: '2026-10-23', ...over });
const cfg = (over: Partial<FuturesConfig> = {}): FuturesConfig => ({ schema: 'edgedesk_sim_kalshi_futures_v1', mapping_version: 'test',
  thresholds: { max_quote_age_minutes: 30, max_reference_spread: 0.06, max_normalization_skew_minutes: 10, exec_quantity: 10, min_exec_edge_pp: 3, min_edge_mcse_multiple: 4 },
  fees: { verified: false, kind: 'taker', formula: 'ceil_to_cent(rate x C x P x (1-P))', rate: 0.07, source: 'unverified', verified_by: null, verified_at: null },
  outcome_sets: [], mappings: [map('BUF')], ...over });
const q = (e: string, over: Partial<Quote> = {}): Quote => ({ market_ticker: 'SYNSB-27-' + e, event_ticker: 'SYNSB-27', series_ticker: 'SYNSB', captured_at: '2026-10-23T11:55:00Z', status: 'active',
  yes_bid: 0.12, yes_ask: 0.14, yes_ask_size: 500, close_time: '2027-02-14T23:00:00Z', rules_sha256: RH, host: 'synthetic', ...over });
const Q = (...qs: Quote[]) => new Map(qs.map((x) => [x.market_ticker, x]));

/* ---- mapping validation ---- */
T.eq('a valid mapping validates', validateFuturesConfig(cfg(), run), []);
T.chk('a mapping for another season is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF', { season: '2025' })] }), run).some((e) => /the run is nfl\/NFL\/2026/.test(e)));
T.chk('a mapping to an unknown club is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF', { entity_id: 'XXX' })] }), run).some((e) => /unknown entity/.test(e)));
T.chk('a mapping to an outcome the simulator does not define (e.g. a regular-season title) is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF', { outcome: 'regular_season_conference_title' })] }), run).some((e) => /unknown outcome/.test(e)));
T.chk('a mapping without verification is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF', { verified_by: null })] }), run).some((e) => /verified_by/.test(e)));
T.chk('a mapping without the settlement rules hash is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF', { settlement: { basis: 'x', rules_sha256: '' } })] }), run).some((e) => /rules text sha256/.test(e)));
T.chk('the same market mapped twice is rejected', validateFuturesConfig(cfg({ mappings: [map('BUF'), map('BUF', { mapping_id: 'dup' })] }), run).some((e) => /mapped twice/.test(e)));
{
  /* one config holds every sport's mappings: a run sees only its own sport's (an earlier season of its sport is still an error) */
  const cfbRun: RunView = { sport: 'cfb', competition: 'NCAA FBS', season: '2026', entities: [{ entity_id: 'alabama', outcomes: { national_champion: { probability: 0.05, mcse: 0.0007 } } }] };
  const mixed = cfg({ mappings: [map('BUF'), map('KC', { season: '2025' })] });
  T.eq('a college football run sees none of the NFL mappings (and no NFL outcome set)', [configForSport(mixed, cfbRun).mappings.length, configForSport(mixed, cfbRun).outcome_sets.length], [0, 0]);
  T.eq('... so it validates instead of failing on another sport\'s markets', validateFuturesConfig(configForSport(mixed, cfbRun), cfbRun), []);
  T.chk('an NFL run still rejects its own wrong-season mapping', validateFuturesConfig(configForSport(mixed, run), run).some((e) => /the run is nfl\/NFL\/2026/.test(e)));
  /* next season's futures open before this season ends (MLB's 2027 markets during the 2026 World Series): not this run's */
  const next = cfg({ mappings: [map('BUF'), map('KC', { season: '2027' })] });
  T.eq('a later season of its own sport is left out of the run (next season\'s futures)', configForSport(next, run).mappings.map((m) => m.entity_id), ['BUF']);
  T.eq('so it validates', validateFuturesConfig(configForSport(next, run), run), []);
  const nhlLike: RunView = { ...run, season: '2026-27' };
  T.eq('a season key with a second year is ordered by its first (2027-28 is later than 2026-27)', configForSport(cfg({ mappings: [map('BUF', { season: '2026-27' }), map('KC', { season: '2027-28' })] }), nhlLike).mappings.map((m) => m.entity_id), ['BUF']);
}
T.chk('a verified fee schedule must name its source', validateFuturesConfig(cfg({ fees: { ...cfg().fees, verified: true } }), run).some((e) => /verified fee schedule/.test(e)));
T.throws('an invalid mapping refuses to compare at all', () => compareFutures(cfg({ mappings: [map('BUF', { season: '2025' })] }), run, Q(q('BUF')), now), /mapping is invalid/);
/* ---- no coverage is unavailable, not zero ---- */
{
  const c = compareFutures(cfg({ mappings: [] }), run, new Map(), now);
  T.chk('no verified mapping: status unavailable, no rows, and the note says not zero', c.status === 'unavailable' && c.rows.length === 0 && /unavailable \(not zero\)/.test(c.note));
}
/* ---- the reference comparison ---- */
{
  const c = compareFutures(cfg(), run, Q(q('BUF')), now), r = c.rows[0];
  T.near('reference = the YES mid of a two-sided quote', r.reference_prob as number, 0.13, 1e-12);
  T.near('reference edge = research - reference, in points', r.reference_edge_pp as number, 7, 1e-9);
  T.eq('a single market is not normalised', r.normalization, 'none');
  T.near('fair decimal odds = 1/p', r.research_fair_decimal as number, 5, 1e-9);
}
/* ---- the midpoint is never the executable price ---- */
{
  const r = compareFutures(cfg(), run, Q(q('BUF')), now).rows[0];
  T.eq('the executable price is the ask, not the mid', r.exec_price, 0.14);
  T.chk('reference and executable edges are separate numbers', r.reference_edge_pp === 7 && r.exec_edge_pp === 6, [r.reference_edge_pp, r.exec_edge_pp]);
}
/* ---- fees ---- */
T.near('fee at P=0.50, 10 contracts: ceil(17.5 cents) = 18 cents = 0.018 per contract', feePerContract(0.5, 10, 0.07), 0.018, 1e-12);
T.near('fee at P=0.10, 1 contract: ceil(0.63 cents) = 1 cent', feePerContract(0.1, 1, 0.07), 0.01, 1e-12);
T.near('fee at P=0.14, 10 contracts: ceil(8.428 cents) = 9 cents', feePerContract(0.14, 10, 0.07), 0.009, 1e-12);
T.throws('a fee at a price of 1 is refused (no such contract)', () => feePerContract(1, 10, 0.07));
{
  const unv = compareFutures(cfg(), run, Q(q('BUF')), now).rows[0];
  T.chk('unverified fees: executable cost is pre-fee, labelled, and nothing is flagged', !unv.fee_verified && unv.fee_per_contract === null && unv.expected_net_return === null && !unv.actionable && unv.block_reasons.some((b) => /fee schedule unverified/.test(b)));
  const fees = { ...cfg().fees, verified: true, source: 'https://example.invalid/synthetic-fee-schedule', verified_by: 'test', verified_at: '2026-10-23' };
  const ver = compareFutures(cfg({ fees }), run, Q(q('BUF')), now).rows[0];
  T.near('verified fees: cost = ask + fee per contract', ver.exec_cost_prob as number, 0.149, 1e-12);
  T.near('  ... executable edge after fees (points)', ver.exec_edge_pp as number, 5.1, 1e-9);
  T.near('  ... expected net return per $1 contract', ver.expected_net_return as number, 0.051, 1e-12);
  T.chk('  ... a fresh, deep, fee-verified, mapped quote over every threshold is actionable', ver.actionable && ver.block_reasons.length === 0, ver.block_reasons);
  /* stale quotes are never flagged */
  const st = compareFutures(cfg({ fees }), run, Q(q('BUF', { captured_at: '2026-10-23T10:00:00Z' })), now).rows[0];
  T.chk('a stale quote is shown with its age and never flagged', st.stale && !st.actionable && st.quote_age_minutes === 120 && st.block_reasons.some((b) => /minutes old/.test(b)));
  const shallow = compareFutures(cfg({ fees }), run, Q(q('BUF', { yes_ask_size: 3 })), now).rows[0];
  T.chk('an ask too thin for the stated quantity has no executable price', shallow.exec_price === null && !shallow.actionable && shallow.block_reasons.some((b) => /below the stated quantity/.test(b)));
  const nodepth = compareFutures(cfg({ fees }), run, Q(q('BUF', { yes_ask_size: null })), now).rows[0];
  T.chk('an unknown ask depth has no executable price', nodepth.exec_price === null && nodepth.block_reasons.some((b) => /depth unknown/.test(b)));
  const small = compareFutures(cfg({ fees }), { ...run, entities: [{ entity_id: 'BUF', outcomes: { win_super_bowl: { probability: 0.16, mcse: 0.00116 }, win_division: { probability: 0.5, mcse: 0.001 } } }, run.entities[1], run.entities[2]] }, Q(q('BUF')), now).rows[0];
  T.chk('an executable edge under the threshold is not flagged', !small.actionable && small.block_reasons.some((b) => /below 3/.test(b)));
  const closed = compareFutures(cfg({ fees }), run, Q(q('BUF', { close_time: '2026-10-22T00:00:00Z' })), now).rows[0];
  T.chk('a closed market is not eligible', !closed.eligible && !closed.actionable);
}
/* ---- one-sided and wide books ---- */
{
  const one = compareFutures(cfg(), run, Q(q('BUF', { yes_bid: 0 })), now).rows[0];
  T.chk('a one-sided book has no reference price', one.reference_prob === null && one.block_reasons.some((b) => /one-sided/.test(b)));
  const wide = compareFutures(cfg(), run, Q(q('BUF', { yes_bid: 0.05, yes_ask: 0.14 })), now).rows[0];
  T.chk('a spread over 0.06 has no reference price', wide.reference_prob === null && wide.block_reasons.some((b) => /spread/.test(b)));
}
/* ---- settlement drift and missing quotes are excluded with a reason ---- */
{
  const c = compareFutures(cfg({ mappings: [map('BUF'), map('KC')] }), run, Q(q('BUF', { rules_sha256: sha256Hex('changed rules') })), now);
  T.chk('a market whose rules changed since verification is excluded', c.excluded.some((x) => x.mapping_id === 'syn-sb-BUF' && /settlement rules changed/.test(x.reason)));
  T.chk('a mapped market with no quote is excluded, not shown at zero', c.excluded.some((x) => x.mapping_id === 'syn-sb-KC' && /no quote/.test(x.reason)) && c.rows.length === 0);
}
/* ---- normalisation only over a complete, fresh, aligned, exclusive set ---- */
{
  const set = { id: 'syn-sb', outcome: 'win_super_bowl', entities: ['BUF', 'KC', 'SF'], mutually_exclusive: true, exhaustive: true };
  const ms = ['BUF', 'KC', 'SF'].map((e) => map(e, { outcome_set: 'syn-sb' }));
  const qs = Q(q('BUF', { yes_bid: 0.20, yes_ask: 0.22 }), q('KC', { yes_bid: 0.10, yes_ask: 0.12 }), q('SF', { yes_bid: 0.73, yes_ask: 0.75 }));
  const full = compareFutures(cfg({ outcome_sets: [set], mappings: ms }), run, qs, now);
  const sum = 0.21 + 0.11 + 0.74;
  T.chk('a complete fresh set is normalised proportionally and labelled an assumption', full.rows.every((r) => r.normalization === 'proportional_complete_set' && /assumption/.test(r.normalization_note)));
  T.near('  ... normalised reference = mid / sum of mids', full.rows[0].normalized_ref_prob as number, 0.21 / sum, 1e-6);
  const part = compareFutures(cfg({ outcome_sets: [set], mappings: ms.slice(0, 2) }), run, qs, now);
  T.chk('an INCOMPLETE set is not normalised, and says why', part.rows.every((r) => r.normalization === 'none' && /incomplete/.test(r.normalization_note)));
  const skew = Q(q('BUF', { yes_bid: 0.20, yes_ask: 0.22 }), q('KC', { yes_bid: 0.10, yes_ask: 0.12, captured_at: '2026-10-23T11:40:00Z' }), q('SF', { yes_bid: 0.73, yes_ask: 0.75 }));
  T.chk('a set whose quotes are too far apart in time is not normalised', compareFutures(cfg({ outcome_sets: [set], mappings: ms }), run, skew, now).rows.every((r) => r.normalization === 'none' && /minutes apart/.test(r.normalization_note)));
  const notEx = compareFutures(cfg({ outcome_sets: [{ ...set, exhaustive: false }], mappings: ms }), run, qs, now);
  T.chk('independent YES markets not declared exhaustive are never normalised as a book', notEx.rows.every((r) => r.normalization === 'none'));
}
/* ---- the Kalshi client: fixed-point dollars, host fallback, bounded retry ---- */
{
  const m = { ticker: 'SYNSB-27-BUF', event_ticker: 'SYNSB-27', status: 'active', yes_bid_dollars: '0.1200', yes_ask_dollars: '0.1400', yes_ask_size_fp: '500.00', last_price_dollars: '0.1300', rules_primary: RULES, close_time: '2027-02-14T23:00:00Z' };
  const qq = quoteFromMarket(m, '2026-10-23T11:55:00Z', 'https://external-api.kalshi.com/trade-api/v2');
  T.chk('Kalshi fixed-point dollar strings parse to prices in [0,1] and sizes', qq.yes_bid === 0.12 && qq.yes_ask === 0.14 && qq.yes_ask_size === 500 && qq.rules_sha256 === RH && qq.host === 'external-api.kalshi.com');
  T.eq('a price outside [0,1] is not stored as a price', quoteFromMarket({ ...m, yes_ask_dollars: '14' }, 'x', null).yes_ask, null);
  let calls = 0;
  const fake = (async (u: string) => { calls++; const host = new URL(u).host;
    if (host === 'external-api.kalshi.com') return new Response('refused', { status: 403 });
    if (calls < 4) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({ markets: [m] }), { status: 200 }); }) as unknown as typeof fetch;
  const c = kalshiClient({ fetchImpl: fake, sleep: async () => {} });
  const got = await fetchQuotes(c, ['SYNSB-27-BUF']);
  T.chk('a refusing host hands over to the shared host, and 503s are retried', got.get('SYNSB-27-BUF')!.yes_ask === 0.14 && c.host === 'https://api.elections.kalshi.com/trade-api/v2' && calls === 4, calls);
  const down = kalshiClient({ fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, sleep: async () => {} });
  let err = ''; try { await fetchQuotes(down, ['X']); } catch (e) { err = String((e as Error).message); }
  T.chk('an outage raises (the market step fails; the simulation is untouched)', /could not be reached/.test(err), err);
}
/* ---- the market step on a sport the committed config maps nothing for: unavailable, nothing fetched, no error ---- */
{
  const cfb = { run: { sport: 'cfb', competition: 'NCAA FBS', season: '2026' }, entities: [{ entity_id: 'alabama', outcomes: { national_champion: { probability: 0.05, mcse: 0.0007 } } }] };
  const lines: string[] = [];
  const r = await marketStep({ results: cfb, runId: null, publish: false, log: (s) => lines.push(s), fetchImpl: (async () => { throw new Error('nothing should be fetched'); }) as unknown as typeof fetch });
  T.chk('a college football run against the committed futures config (no college football mapping) is unavailable, not a failure', r.status === 'unavailable' && /no verified Kalshi mapping for cfb/.test(lines.join(' ')), { r, lines });
}
/* ---- the market step: an outage fails the COMPARISON only ---- */
{
  const results = { run: { sport: 'nfl', competition: 'NFL', season: '2026' }, entities: run.entities.map((e) => ({ entity_id: e.entity_id, outcomes: e.outcomes })) };
  const calls: string[] = [];
  const db: SimDb = { async rpc(name) { calls.push(name); return name === 'sim_begin_comparison' ? '00000000-0000-0000-0000-000000000001' : {}; } };
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  let code = 0, msg = '';
  try { await marketStep({ results, runId: '00000000-0000-0000-0000-0000000000ff', publish: true, cfg: cfg(), db, fetchImpl: down, log: () => {}, now }); } catch (e) { code = (e as any).exitCode; msg = String((e as Error).message); }
  T.chk('a Kalshi outage exits 4 and marks the comparison failed (never the run)', code === 4 && calls.includes('sim_fail_comparison') && !calls.some((c) => /sim_(fail|publish)_run/.test(c)), { code, calls, msg });
  const none = await marketStep({ results, runId: null, publish: true, cfg: cfg({ mappings: [] }), db, log: () => {}, now });
  T.eq('with no verified mapping the step fetches and writes nothing', none.status, 'unavailable');
  /* one config serves every sport: an NBA run sees only NBA mappings (none today), and the other sports' mappings and outcome sets never reach its validation */
  const nba = { run: { sport: 'nba', competition: 'NBA', season: '2026-27' }, entities: [{ entity_id: 'BOS', outcomes: { win_title: { probability: 0.1, mcse: 0.001 } } }] };
  const real = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'kalshi_futures.json'), 'utf8')) as FuturesConfig;
  const nbaStep = await marketStep({ results: nba, runId: null, publish: false, cfg: real, log: () => {}, now, fetchImpl: (async () => { throw new Error('nothing should be fetched'); }) as unknown as typeof fetch });
  T.eq('an NBA run against the committed config (NFL, MLB and NHL mappings) is unavailable, not invalid', nbaStep.status, 'unavailable');
}
/* ---- the mapping generator refuses anything short of an exact match (SYNTHETIC markets) ---- */
{
  const ok = (over: Partial<Candidate> = {}): Candidate => ({ series_ticker: 'KXNFLAFCEAST', event_ticker: 'KXNFLAFCEAST-27', market_ticker: 'KXNFLAFCEAST-27-BUF', yes_sub_title: 'Buffalo',
    rules_primary: 'If Buffalo wins the Pro Football AFC East Division, then the market resolves to Yes.', rules_secondary: DISCLAIMER, rules_sha256: 'a'.repeat(64), ...over });
  const fee = [{ ticker: 'KXNFLAFCEAST', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 }];
  const by = { by: 'test', at: '2026-10-23' };
  const b = (cs: Candidate[], f = fee) => buildMappings(cs, f, by);
  T.eq('an exact match maps to the simulated outcome', b([ok()]).mappings.map((m) => [m.entity_id, m.outcome]), [['BUF', 'win_division']]);
  T.eq('different wording is left out', b([ok({ rules_primary: 'If Buffalo wins the Pro Football AFC East Division or has the best record, then the market resolves to Yes.' })]).left.length, 1);
  T.eq('extra secondary rules are left out', b([ok({ rules_secondary: DISCLAIMER + ' If the season is shortened, the market resolves to No.' })]).left.length, 1);
  T.eq('a club outside the division is left out', b([ok({ market_ticker: 'KXNFLAFCEAST-27-KC', yes_sub_title: 'Kansas City', rules_primary: 'If Kansas City wins the Pro Football AFC East Division, then the market resolves to Yes.' })]).left.length, 1);
  T.eq('rules naming another club than the label are left out', b([ok({ yes_sub_title: 'Miami' })]).left.length, 1);
  T.eq('a flat or multiplied fee type is left out', [b([ok()], [{ ticker: 'KXNFLAFCEAST', fee_type: 'flat', fee_multiplier: 1 }]).left.length, b([ok()], [{ ticker: 'KXNFLAFCEAST', fee_type: 'quadratic', fee_multiplier: 2 }]).left.length], [1, 1]);
  T.eq('Kalshi suffixes map to nflverse codes (JAC -> JAX, LAR -> LA)', b([ok({ series_ticker: 'KXSB', event_ticker: 'KXSB-27', market_ticker: 'KXSB-27-JAC', yes_sub_title: 'Jacksonville', rules_primary: 'If Jacksonville wins the 2027 Pro Football Championship, then the market resolves to Yes.' })],
    [{ ticker: 'KXSB', fee_type: 'quadratic', fee_multiplier: 1 }]).mappings.map((m) => m.entity_id), ['JAX']);
  const one = b([ok()]);
  T.chk('an incomplete set (one of four clubs) is never normalised', one.sets.length === 0 && one.mappings[0].outcome_set === null);
  const four = b(['BUF:Buffalo', 'MIA:Miami', 'NE:New England', 'NYJ:New York J'].map((x) => { const [c, n] = x.split(':'); return ok({ market_ticker: 'KXNFLAFCEAST-27-' + c, yes_sub_title: n, rules_primary: 'If ' + n + ' wins the Pro Football AFC East Division, then the market resolves to Yes.' }); }));
  T.chk('a complete division is one mutually exclusive, exhaustive set', four.sets.length === 1 && four.sets[0].entities.length === 4 && four.mappings.every((m) => m.outcome_set === 'nfl2026:win_division:AFC East'));
}
/* ---- the candidates read back from a source check's job log (SYNTHETIC lines in its print format) ---- */
{
  const ts = '2026-10-23T20:20:47.1459895Z ';
  const log = [
    'irrelevant runner line',
    ts + '  KXSYNWS | Synthetic World Series | quadratic_with_maker_fees | 1   <- futures',
    ts + '  KXSYNWINS-NYY | Synthetic wins New York Y | quadratic | 1',
    ts + '## SERIES KXSYNWS | Synthetic World Series | fee_type quadratic_with_maker_fees | fee_multiplier 1 | frequency custom | settlement_sources []',
    ts + '  - KXSYNWS-27-NYY | event KXSYNWS-27 | New York Y | close 2027-11-05T04:00:00Z | bid 0.1000 ask 0.1100 size 10.00 | rules_sha256 ' + 'c'.repeat(64) + ' | RULES: If New York Y wins. | RULES2: ' + DISCLAIMER,
    ts + '  - KXSYNWS-27-SF | event KXSYNWS-27 | San Francisco | close 2027-11-05T04:00:00Z | bid 0.0100 ask 0.0200 size 5.00 | rules_sha256 ' + 'd'.repeat(64) + ' | RULES: If San Francisco wins.',
    ts + '  ~ SETTLED KXSYNWS-26-MIL | event KXSYNWS-26 | Milwaukee | close 2026-11-01T04:00:00Z | settled yes | rules_sha256 ' + 'e'.repeat(64) + ' | RULES: If Milwaukee wins.'
  ].join('\n');
  const c = candidatesFromLog(log);
  T.eq('the fetch date is the first timestamp', c.fetched_at.slice(0, 10), '2026-10-23');
  T.eq('series rows keep their fee fields (dashed tickers included)', c.series.map((s) => [s.ticker, s.fee_type, Number(s.fee_multiplier)]), [['KXSYNWS', 'quadratic_with_maker_fees', 1], ['KXSYNWINS-NYY', 'quadratic', 1]]);
  T.eq('open markets are read with their series, label, rules and the runner\'s hash; a settled market never is', c.markets.map((k) => [k.series_ticker, k.market_ticker, k.yes_sub_title, k.rules_primary, k.rules_secondary, k.rules_sha256[0]]),
    [['KXSYNWS', 'KXSYNWS-27-NYY', 'New York Y', 'If New York Y wins.', DISCLAIMER, 'c'], ['KXSYNWS', 'KXSYNWS-27-SF', 'San Francisco', 'If San Francisco wins.', null, 'd']]);
  T.eq('mapping_version names each sport\'s source check (a version without a sport is the NFL\'s)', [versionWith('2026-10-23.run1', 'mlb', '2026-10-23.run2'), versionWith('mlb 2026-10-23.run2; nfl 2026-10-23.run1', 'mlb', '2027-03-01.run3')],
    ['mlb 2026-10-23.run2; nfl 2026-10-23.run1', 'mlb 2027-03-01.run3; nfl 2026-10-23.run1']);
}
/* ---- MLB: Kalshi's own 2026 wording (REAL markets: simulator/fixtures/kalshi_mlb_2026_markets.json) ---- */
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'kalshi_mlb_2026_markets.json'), 'utf8')) as { series: SeriesInfo[]; markets: Candidate[] };
  const by = { by: 'test', at: '2026-10-23' };
  T.chk('the fixture is the text the runner hashed', fx.markets.every((k) => sha256Hex(k.rules_primary + '\n' + (k.rules_secondary || '')) === k.rules_sha256));
  const r = buildMlbMappings(fx.markets, fx.series, by);
  const n = (o: string) => r.mappings.filter((m) => m.outcome === o).length;
  T.eq('every 2026 club market maps (World Series, pennants, divisions, playoff qualifiers)', [r.left.length, n('win_world_series'), n('win_pennant'), n('win_division'), n('make_playoffs')], [0, 2, 30, 30, 30]);
  T.chk('each maps to the club its ticker and its label name, in 2026', r.mappings.every((m) => m.season === '2026' && KALSHI_LABEL[m.entity_id] === fx.markets.find((k) => k.market_ticker === m.market_ticker)!.yes_sub_title));
  T.eq('pennants and divisions are complete sets; a World Series down to two clubs and the playoff field are never normalised', r.sets.map((s) => s.id + ' ' + s.entities.length),
    ['mlb2026:win_division:AL Central 5', 'mlb2026:win_division:AL East 5', 'mlb2026:win_division:AL West 5', 'mlb2026:win_division:NL Central 5', 'mlb2026:win_division:NL East 5', 'mlb2026:win_division:NL West 5',
      'mlb2026:win_pennant:AL 15', 'mlb2026:win_pennant:NL 15']);
  /* next season: the same wording one year on maps to that season's run (and a full 30-club World Series is a set) */
  const on = (k: Candidate): Candidate => ({ ...k, event_ticker: k.event_ticker.replace('-26', '-27'), market_ticker: k.market_ticker.replace('-26-', '-27-'), rules_primary: k.rules_primary.replace('2026', '2027') });
  const wsAll = MLB_TEAMS.map((t) => { const sfx = Object.keys(KALSHI_TO_RETRO).find((x) => KALSHI_TO_RETRO[x] === t.code) || t.code, lab = KALSHI_LABEL[t.code];
    return { ...fx.markets.find((k) => k.market_ticker === 'KXMLB-26-MIL')!, market_ticker: 'KXMLB-26-' + sfx, yes_sub_title: lab, rules_primary: 'If ' + lab + ' wins the 2026 Pro Baseball Championship, then the market resolves to Yes.' }; });
  const r27 = buildMlbMappings([...fx.markets.filter((k) => k.series_ticker !== 'KXMLB'), ...wsAll].map(on), fx.series, by);
  T.chk('next season\'s markets in the same wording map to next season', r27.left.length === 0 && r27.mappings.length === 120 && r27.mappings.every((m) => m.season === '2027' && m.mapping_id.startsWith('mlb2027:')), r27.left);
  T.chk('a World Series with every club listed is one complete set', r27.sets.some((s) => s.id === 'mlb2027:win_world_series' && s.entities.length === 30));
  /* exact or nothing (one real market, altered) */
  const ws = fx.markets.find((k) => k.market_ticker === 'KXMLB-26-MIL')!, al = fx.markets.find((k) => k.market_ticker === 'KXMLBAL-26-NYY')!, div = fx.markets.find((k) => k.market_ticker === 'KXMLBALEAST-26-NYY')!;
  const one = (k: Candidate) => buildMlbMappings([k], fx.series, by);
  T.eq('a season that is not the event ticker\'s is left out', one({ ...ws, rules_primary: ws.rules_primary.replace('2026', '2027') }).left.length, 1);
  T.eq('a label that is not the ticker\'s club is left out, even with rules to match', one({ ...ws, yes_sub_title: 'Chicago C', rules_primary: ws.rules_primary.replace('Milwaukee', 'Chicago C') }).left.length, 1);
  T.eq('a club of the other league is left out of a pennant', one({ ...al, market_ticker: 'KXMLBAL-26-NYM', yes_sub_title: 'New York M', rules_primary: al.rules_primary.replace('New York Y', 'New York M') }).left.length, 1);
  T.eq('a club outside the division is left out', one({ ...div, market_ticker: 'KXMLBALEAST-26-DET', yes_sub_title: 'Detroit', rules_primary: div.rules_primary.replace('New York Y', 'Detroit') }).left.length, 1);
  T.eq('extra secondary rules are left out', one({ ...ws, rules_secondary: ws.rules_secondary + ' If the season is shortened, the market resolves to No.' }).left.length, 1);
  T.eq('other wording is left out', one({ ...ws, rules_primary: ws.rules_primary.replace('wins the', 'reaches the') }).left.length, 1);
  T.eq('an older series under another ticker is not a candidate at all', [one({ ...ws, series_ticker: 'KXMLBWS' }).mappings.length, one({ ...ws, series_ticker: 'KXMLBWS' }).left.length], [0, 0]);
  T.chk('every Kalshi suffix names a club and every club has one label', MLB_TEAMS.every((t) => !!KALSHI_LABEL[t.code]) && Object.values(KALSHI_TO_RETRO).every((c) => MLB_TEAMS.some((t) => t.code === c)) && new Set(Object.values(KALSHI_LABEL)).size === 30);
}
/* ---- the NHL: Kalshi's own 2026-27 wording (REAL markets: simulator/fixtures/kalshi_nhl_2026_27_markets.json) ---- */
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'kalshi_nhl_2026_27_markets.json'), 'utf8')) as { series: SeriesInfo[]; markets: Candidate[] };
  const by = { by: 'test', at: '2026-10-23' };
  const unhashed = fx.markets.filter((k) => sha256Hex(k.rules_primary + '\n' + (k.rules_secondary || '')) !== k.rules_sha256);
  T.chk('the fixture is the text the runner hashed, but for the Presidents\' Trophy tiebreak list (printed with its line breaks squashed)', unhashed.length === 32 && unhashed.every((k) => k.series_ticker === 'KXNHLPRES'), unhashed.map((k) => k.market_ticker));
  const r = buildNhlMappings(fx.markets, fx.series, by);
  const n = (o: string) => r.mappings.filter((m) => m.outcome === o).length;
  T.eq('every 2026-27 club market maps (Stanley Cup, playoff conference titles, divisions, Presidents\' Trophy, playoff qualifiers)',
    [r.left.length, n('win_stanley_cup'), n('win_conference'), n('win_division'), n('presidents_trophy'), n('make_playoffs')], [0, 32, 32, 32, 32, 32]);
  T.chk('each maps to the club its ticker and its label name, in 2026-27', r.mappings.every((m) => m.season === '2026-27' && m.competition === 'NHL'
    && NHL_TEAMS_2027.find((t) => t.code === m.entity_id)!.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === fx.markets.find((k) => k.market_ticker === m.market_ticker)!.yes_sub_title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  T.eq('the Cup, the Presidents\' Trophy, each conference and each division are complete sets; the playoff field is never normalised', r.sets.map((s) => s.id + ' ' + s.entities.length),
    ['nhl2026-27:presidents_trophy 32', 'nhl2026-27:win_conference:Eastern 16', 'nhl2026-27:win_conference:Western 16', 'nhl2026-27:win_division:Atlantic 8', 'nhl2026-27:win_division:Central 8',
      'nhl2026-27:win_division:Metropolitan 8', 'nhl2026-27:win_division:Pacific 8', 'nhl2026-27:win_stanley_cup 32']);
  T.chk('Kalshi\'s "Conference Finals" is the playoff conference title, never the best regular-season record in the conference', r.mappings.filter((m) => /^KXNHL(EAST|WEST)$/.test(m.series_ticker)).every((m) => m.outcome === 'win_conference'));
  /* exact or nothing (one real market, altered) */
  const cup = fx.markets.find((k) => k.market_ticker === 'KXNHL-27-WSH')!, east = fx.markets.find((k) => k.market_ticker === 'KXNHLEAST-27-WSH')!, pres = fx.markets.find((k) => k.market_ticker === 'KXNHLPRES-27-WSH')!;
  const div = fx.markets.find((k) => k.market_ticker === 'KXNHLMETROPOLITAN-27-WSH')!;
  const one = (k: Candidate) => buildNhlMappings([k], fx.series, by);
  T.eq('a season that is not the event ticker\'s is left out', one({ ...cup, rules_primary: cup.rules_primary.replace('2026-27', '2027-28') }).left.length, 1);
  T.eq('a label that is not the ticker\'s club is left out, even with rules to match', one({ ...cup, yes_sub_title: 'Pittsburgh Penguins', rules_primary: cup.rules_primary.replace('Washington Capitals', 'Pittsburgh Penguins') }).left.length, 1);
  T.eq('a club of the other conference is left out of a conference title', one({ ...east, market_ticker: 'KXNHLEAST-27-EDM', yes_sub_title: 'Edmonton Oilers', rules_primary: east.rules_primary.replace('Washington Capitals', 'Edmonton Oilers') }).left.length, 1);
  T.eq('a club outside the division is left out', one({ ...div, market_ticker: 'KXNHLMETROPOLITAN-27-BOS', yes_sub_title: 'Boston Bruins', rules_primary: div.rules_primary.replace('Washington Capitals', 'Boston Bruins') }).left.length, 1);
  T.eq('a Presidents\' Trophy with other tiebreakers is left out', one({ ...pres, rules_secondary: NHL_PRES_TIEBREAK.replace('1) Regulation wins 2) Regulation and overtime wins', '1) Regulation and overtime wins 2) Regulation wins') }).left.length, 1);
  T.eq('secondary rules where a series has none are left out', one({ ...div, rules_secondary: 'If the season is shortened, the market resolves to No.' }).left.length, 1);
  T.eq('a Montreal label with or without its accent is the club\'s', ['Montréal Canadiens', 'Montreal Canadiens'].map((lab) => one({ ...cup, market_ticker: 'KXNHL-27-MTL', yes_sub_title: lab, rules_primary: cup.rules_primary.replace('Washington Capitals', lab) }).mappings.map((m) => m.entity_id).join()), ['MTL', 'MTL']);
  T.chk('every Kalshi suffix names a club', Object.values(KALSHI_TO_NHL).every((c) => NHL_TEAMS_2027.some((t) => t.code === c)));
}
/* ---- the committed config (real Kalshi markets, generated by build_kalshi_mappings.ts) ---- */
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const real = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'kalshi_futures.json'), 'utf8')) as FuturesConfig;
  const nflRun: RunView = { sport: 'nfl', competition: 'NFL', season: '2026',
    entities: NFL_TEAMS_2026.map((t) => ({ entity_id: t.code, outcomes: Object.fromEntries(NFL_OUTCOMES.map((o) => [o.key, { probability: 0, mcse: 0 }])) })) };
  T.eq('the committed futures config validates against a full NFL 2026 run', validateFuturesConfig(configForSport(real, nflRun), nflRun), []);
  /* each MLB season mapped validates against a full MLB run of that season (a later one is never that run's) */
  const mlbSeasons = [...new Set(real.mappings.filter((m) => m.sport === 'mlb').map((m) => m.season))];
  for (const season of mlbSeasons) {
    const mlbRun: RunView = { sport: 'mlb', competition: 'MLB', season,
      entities: MLB_TEAMS.map((t) => ({ entity_id: t.code, outcomes: Object.fromEntries(mlbOutcomes(formatFor(Number(season))).map((o) => [o.key, { probability: 0, mcse: 0 }])) })) };
    T.eq('the committed MLB ' + season + ' mappings validate against a full MLB ' + season + ' run', validateFuturesConfig(configForSport(real, mlbRun), mlbRun), []);
  }
  const nhlRun: RunView = { sport: 'nhl', competition: 'NHL', season: '2026-27',
    entities: NHL_TEAMS_2027.map((t) => ({ entity_id: t.code, outcomes: Object.fromEntries(NHL_OUTCOMES.map((o) => [o.key, { probability: 1 / 32, mcse: 0.0005 }])) })) };
  T.eq('the committed NHL mappings validate against a full NHL 2026-27 run', validateFuturesConfig(configForSport(real, nhlRun), nhlRun), []);
  {
    /* the market step on that NHL run: Kalshi answers with every mapped market's printed rules (REAL text from the fixture).
       Each compares, but for the 32 Presidents' Trophy markets, whose printed text lost its line breaks and so no longer
       hashes to the runner's rules sha256: the comparison excludes them, as it would any market whose wording changed. */
    const fx = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'kalshi_nhl_2026_27_markets.json'), 'utf8')) as { markets: Candidate[] };
    const kalshi = (async (u: string) => {
      const markets = (new URL(u).searchParams.get('tickers') || '').split(',').map((tk) => fx.markets.find((k) => k.market_ticker === tk)).filter(Boolean).map((k) => ({ ticker: k!.market_ticker, event_ticker: k!.event_ticker,
        series_ticker: k!.series_ticker, status: 'active', yes_bid_dollars: '0.0300', yes_ask_dollars: '0.0400', yes_ask_size_fp: '500.00', close_time: '2027-04-25T14:00:00Z', rules_primary: k!.rules_primary, rules_secondary: k!.rules_secondary }));
      return new Response(JSON.stringify({ markets }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const step = await marketStep({ results: { run: nhlRun, entities: nhlRun.entities }, runId: null, publish: false, cfg: real, fetchImpl: kalshi, log: () => {}, now: new Date() });
    const ex = step.comparison ? step.comparison.excluded : [];
    T.chk('an NHL 2026-27 run compares its 128 hash-checkable mapped markets, every one eligible; the 32 squashed Presidents\' Trophy texts are excluded by the rules hash',
      step.status === 'compared' && step.rows.length === 128 && step.rows.every((r) => r.eligible) && ex.length === 32 && ex.every((x) => /^KXNHLPRES-/.test(x.market_ticker) && /settlement rules changed/.test(x.reason)),
      { status: step.status, rows: step.rows.length, excluded: ex.slice(0, 2) });
  }
  {
    /* the market step on an MLB 2026 run against the committed config: Kalshi answers with the two World Series markets'
       own rules (REAL text from the fixture), so their hashes are what the runner hashed */
    const fx = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'kalshi_mlb_2026_markets.json'), 'utf8')) as { markets: Candidate[] };
    const results = { run: { sport: 'mlb', competition: 'MLB', season: '2026' }, entities: MLB_TEAMS.map((t) => ({ entity_id: t.code,
      outcomes: Object.fromEntries(mlbOutcomes(formatFor(2026)).map((o) => [o.key, { probability: o.key === 'win_world_series' ? (t.code === 'MIL' ? 0.636 : t.code === 'TBA' ? 0.364 : 0) : 0, mcse: 0.0015 }])) })) };
    const asked: string[] = [];
    const kalshi = (async (u: string) => { const url = new URL(u); asked.push(url.searchParams.get('tickers') || '');
      const markets = (url.searchParams.get('tickers') || '').split(',').map((tk) => fx.markets.find((k) => k.market_ticker === tk)).filter(Boolean).map((k) => ({ ticker: k!.market_ticker, event_ticker: k!.event_ticker,
        series_ticker: k!.series_ticker, status: 'active', yes_bid_dollars: '0.6390', yes_ask_dollars: '0.6510', yes_ask_size_fp: '250.00', close_time: '2028-10-31T04:00:00Z', rules_primary: k!.rules_primary, rules_secondary: k!.rules_secondary }));
      return new Response(JSON.stringify({ markets }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const step = await marketStep({ results, runId: null, publish: false, cfg: real, fetchImpl: kalshi, log: () => {}, now: new Date() });
    T.chk('an MLB 2026 run compares the two mapped World Series markets (rules hashes match, both eligible)', step.status === 'compared' && step.rows.length === 2 && step.rows.every((r) => r.eligible) && /KXMLB-26-MIL/.test(asked.join()) && !/KXSB/.test(asked.join()),
      { status: step.status, rows: step.rows.map((r) => [r.market_ticker, r.eligible, r.block_reasons]), asked });
  }
  T.chk('the fee schedule is verified only with a verifier, a date and an https source', !real.fees.verified || (!!real.fees.verified_by && /^\d{4}-\d{2}-\d{2}$/.test(real.fees.verified_at || '') && /^https:\/\//.test(real.fees.source)));
  T.chk('every mapping is verified, dated and carries its rules sha256', real.mappings.every((m) => m.status === 'verified' && /^[0-9a-f]{64}$/.test(m.settlement.rules_sha256) && !!m.verified_by && /^\d{4}-\d{2}-\d{2}$/.test(m.verified_at || '')));
  const clubs = (id: string) => { const [sport, , scope] = id.split(':');
    const teams: Array<{ code: string; groups: string[] }> = sport.startsWith('mlb') ? MLB_TEAMS.map((t) => ({ code: t.code, groups: [t.league, t.division] }))
      : sport.startsWith('nhl') ? NHL_TEAMS_2027.map((t) => ({ code: t.code, groups: [t.conference, t.division] })) : NFL_TEAMS_2026.map((t) => ({ code: t.code, groups: [t.conference, t.division] }));
    return teams.filter((t) => !scope || t.groups.includes(scope)).map((t) => t.code).sort(); };
  T.chk('every outcome set is exactly the clubs that can win it, each with one mapped market', real.outcome_sets.every((s) => {
    const members = real.mappings.filter((m) => m.outcome_set === s.id);
    return s.mutually_exclusive && s.exhaustive && JSON.stringify(s.entities) === JSON.stringify(clubs(s.id)) && members.length === s.entities.length && members.every((m) => m.outcome === s.outcome);
  }));
  T.chk('make_playoffs is never normalised (several clubs qualify)', real.mappings.filter((m) => m.outcome === 'make_playoffs').every((m) => m.outcome_set == null));
  T.chk('each club and outcome is mapped at most once per sport and season', new Set(real.mappings.map((m) => m.sport + '|' + m.season + '|' + m.entity_id + '|' + m.outcome)).size === real.mappings.length);
}
process.exit(T.done());
