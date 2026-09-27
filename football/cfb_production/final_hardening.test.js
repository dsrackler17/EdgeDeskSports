#!/usr/bin/env node
/* ===========================================================================
   The final hardening test (brief §122; docs/cfb-production/CANONICAL.md §9).

   A normal upcoming slate — every V2.1 row of football/cfb_v2/current.json,
   three books quoting each priced game near its number — goes through every
   stage of the production pathway, and every game must pass each one:

     1 source validation   team identity (identity master), quote validity
     2 feature validation  the canonical input contract
     3 model inference     canonical.snapshot: PREDICTED (or NOT_PRICED for
                           FBS-vs-FCS), numeric checks clean
     4 market ingestion    the consensus integrity verdict: ACTIONABLE
     5 decision policy     decision.js with the PINNED policy and calibration:
                           never a BET (betting disabled), policy-consistent
     6 snapshot write      the Model Lab writes one row per game (temp ledger),
                           the ledger verifies, a second run writes nothing;
                           the stored projections resolve every game

   Then failures are injected one at a time; each must fail safely (the
   brief's list): stale odds, a missing QB field, a NaN input, a wrong team
   mapping, an impossible quote, an incompatible artifact, a duplicate run,
   a provider timeout, a database deadlock, duplicate game rows, a BET while
   betting is disabled.

   Run: node football/cfb_production/final_hardening.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CANON = require('./canonical.js');
const N = require('./numeric.js');
const PR = require('./projections.js');
const C = require('./compat.js');
const DB = require('./db.js');
const I = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));
const ID = require(path.join(ROOT, 'football', 'cfb_lab', 'identity.js'));
const PV = require(path.join(ROOT, 'football', 'cfb_lab', 'providers.js'));
const M = require(path.join(ROOT, 'football', 'cfb_lab', 'models.js'));
const CP = require(path.join(ROOT, 'football', 'cfb_lab', 'checkpoint.js'));
const LG = require(path.join(ROOT, 'football', 'cfb_lab', 'ledger.js'));
const D = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }

const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
const rows = cur.rows;
const first = Math.min.apply(null, rows.map((r) => Date.parse(r.kickoff)));
const NOW = new Date(first - 30 * 3600000).toISOString();          // 30 h before the first kickoff
const art = C.decisionArtifacts();
const E = CANON.loadEngine();
const quotesFor = (r, o) => {
  o = o || {};
  const line = o.line != null ? o.line : Math.round(-r.ens_pred * 2) / 2;
  const at = o.at || new Date(Date.parse(NOW) - 10 * 60000).toISOString();
  return ['dk', 'fd', 'mgm'].map((b) => ({ quote_id: 'q_' + r.game_id + '_' + b, source: 'odds_api', book: b, game_id: String(r.game_id), market_type: 'spread',
    home_line: line, price_home: -110, price_away: -110, observed_at: at, kickoff_ts: r.kickoff, week: r.week, is_pregame: true, is_provider_open: false, is_provider_close: false }));
};
function stages(r, o) {
  o = o || {};
  const out = {};
  const idv = ID.validateGame({ home_team: r.home, away_team: r.away, home_id: r.home_id, away_id: r.away_id });
  const qs = o.quotes || quotesFor(r, o);
  const qv = qs.map((q) => I.validateQuote(q, { now: NOW }));
  out.source = !idv.problems.length && qv.every((v) => v.ok) ? 'OK' : 'REFUSED: ' + idv.problems.concat(...qv.map((v) => v.reasons)).join(', ');
  const c = CANON.checkRow(r, { model_version: E.params.model_version });
  out.features = c.ok ? 'OK' : 'REFUSED: ' + c.critical.join('; ');
  const integrity = I.assessMarket(qs, NOW, { kickoff: r.kickoff });
  const snap = CANON.snapshot(r, { as_of_ts: NOW, context: { market_integrity: { status: integrity.status, actionable_status: integrity.actionable_status } } });
  out.inference = snap.status;
  out.snapshot = snap;
  out.market = integrity.actionable_status;
  if (snap.status === 'PREDICTED') {
    const p = E.engine.pure(r, {});
    const g = D.decideGame(p, { quotes: qs, integrity }, { policy: art.policy, artifact: art.calibration, now: Date.parse(NOW), row: r, expected_model_version: p.model_version });
    out.decision = g.status;
    out.decision_codes = g.reason_codes;
    out.policy_problems = N.policyConsistency({ status: g.status, bet_enabled: !!art.policy.bet_enabled });
  } else out.decision = 'NO_BET';
  return out;
}

/* ═══ the normal slate ═══════════════════════════════════════════════ */
const results = rows.map((r) => ({ r, s: stages(r) }));
const priced = results.filter((x) => x.r.priced !== false);
chk('slate: the pinned policy and calibration load', !!art.policy && !!art.calibration, art.problems);
chk('stage 1 source validation: every game\'s teams resolve and every quote is valid (' + rows.length + ' games)', results.every((x) => x.s.source === 'OK'), results.filter((x) => x.s.source !== 'OK').map((x) => [x.r.game_id, x.s.source]).slice(0, 5));
chk('stage 2 feature validation: every row passes the input contract', results.every((x) => x.s.features === 'OK'), results.filter((x) => x.s.features !== 'OK').map((x) => [x.r.game_id, x.s.features]).slice(0, 5));
chk('stage 3 inference: every priced game is PREDICTED, every FBS-vs-FCS game NOT_PRICED, numeric checks clean', priced.every((x) => x.s.inference === 'PREDICTED' && x.s.snapshot.numeric.ok)
  && results.filter((x) => x.r.priced === false).every((x) => x.s.inference === 'NOT_PRICED'), results.filter((x) => !['PREDICTED', 'NOT_PRICED'].includes(x.s.inference)).map((x) => x.r.game_id));
chk('stage 4 market ingestion: every priced game\'s consensus is ACTIONABLE', priced.every((x) => x.s.market === 'ACTIONABLE'), priced.filter((x) => x.s.market !== 'ACTIONABLE').map((x) => [x.r.game_id, x.s.market]).slice(0, 5));
chk('stage 5 decision policy: every priced game is decided, none is a BET (betting disabled), all policy-consistent', priced.every((x) => ['LEAN', 'PASS', 'RESEARCH', 'NO_BET'].includes(x.s.decision) && !x.s.policy_problems.length),
  priced.filter((x) => x.s.decision === 'BET' || x.s.policy_problems.length).map((x) => x.r.game_id));
const d0 = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-final-'));
try {
  const so = { root: path.join(d0, 'ledger'), govRoot: path.join(d0, 'gov') };
  const store = new LG.Store(2026, so);
  store.appendQuotes(rows.flatMap((r) => quotesFor(r)).map((q) => Object.assign(q, { quote_id: LG.ids.quote(q), retrieved_at: q.observed_at })));
  const models = [M.v2Adapter('current', { current: cur, slate: { games: [] } })];
  const r1 = CP.run({ now: NOW, season: 2026, models, storeOpts: so, schedule: {} });
  const snaps = store.predictions();
  chk('stage 6 snapshot write: one Model Lab row per game in the window, each carrying the canonical verdict', r1.taken === snaps.length && snaps.length > 0
    && snaps.every((p) => p.inputs_ref.canonical && p.inputs_ref.canonical.contract_ok && p.inputs_ref.market_integrity), r1);
  chk('stage 6 snapshot write: no snapshot is a BET, and the stored class never contradicts the policy', snaps.every((p) => p.decision_class !== 'BET' && !N.policyConsistency(p).length));
  chk('stage 6 snapshot write: the ledger verifies', LG.verify({ roots: [so.root, so.govRoot], base: null }).length === 0);
  const r2 = CP.run({ now: NOW, season: 2026, models, storeOpts: so, schedule: {} });
  chk('failure (duplicate cron run): the same hour again writes nothing', r2.taken === 0 && store.predictions().length === snaps.length);
  const rep = PR.build({ now: NOW, predictions: snaps, decisions: [], files: { 'football/cfb_v2/current.json': cur, 'football/fbs/slate.json': { games: [] },
    'football/cfb_production/manifest.json': JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')) } });
  chk('stage 6 stored projections: every game resolves at level 1 or 2 (or NOT_PRICED), each with its official decision field', rep.games.length === rows.filter((r) => Date.parse(r.kickoff) - Date.parse(NOW) <= 240 * 3600000).length
    && rep.games.every((g) => [1, 2, null].includes(g.resolved.level) && g.official_decision && (g.research || g.resolved.mode === 'NOT_PRICED')), rep.counts);
} finally { fs.rmSync(d0, { recursive: true, force: true }); }

/* ═══ injected failures ═══════════════════════════════════════════════ */
const r0 = priced[0].r;
const stale = stages(r0, { at: new Date(Date.parse(NOW) - 8 * 3600000).toISOString() });
chk('failure (stale odds): the market is not actionable, the policy fails closed, the football number stays', stale.market !== 'ACTIONABLE' && stale.decision !== 'BET'
  && stale.inference === 'PREDICTED' && stale.snapshot.degraded.modes.includes('MARKET_DEGRADED'), [stale.market, stale.decision_codes]);
const noQb = stages(Object.assign({}, r0, { qb: { home: null, away: r0.qb && r0.qb.away }, qb_missing_any: 0 }));
chk('failure (missing QB field): visible as QB_UNCERTAIN and a contract note, never assumed healthy', noQb.snapshot.degraded.modes.includes('QB_UNCERTAIN') && noQb.snapshot.contract.degrade.some((x) => /qb_missing_any/.test(x)));
const nan = stages(Object.assign({}, r0, { ens_pred: NaN }));
chk('failure (NaN input): refused before inference, no number, no decision', /REFUSED/.test(nan.features) && nan.inference === 'UNAVAILABLE' && nan.decision === 'NO_BET');
const map = stages(Object.assign({}, r0, { away_id: r0.home_id, away: r0.home }));
chk('failure (wrong team mapping): home = away is refused at the source and at the contract', /REFUSED/.test(map.source) && map.inference === 'UNAVAILABLE' && map.decision === 'NO_BET');
const unk = ID.validateGame({ home_team: 'Miami', away_team: 'Nowhere State', home_id: null, away_id: null });
chk('failure (unmapped team): an unknown name is never guessed ("Miami" alone is not matched by substring)', !unk.ok || unk.problems.length > 0, unk);
const q450 = quotesFor(r0).map((q) => Object.assign({}, q, { home_line: 450 }));
const bad = stages(r0, { quotes: q450 });
chk('failure (impossible quote +450): rejected at ingestion, no actionable market, the decision fails closed', /SPREAD_OUT_OF_BOUNDS/.test(bad.source) && bad.market !== 'ACTIONABLE' && bad.decision !== 'BET' && bad.decision !== 'LEAN', [bad.source, bad.market, bad.decision_codes]);
const f = C.facts(), tam = JSON.parse(JSON.stringify(f)); tam.artifact.manifest_sha256 = 'f'.repeat(64);
chk('failure (incompatible artifact): the pinned tuple fails, so the gate fails the job before any snapshot', C.check(f, C.loadMatrix()).every((c) => c.ok) && C.check(tam, C.loadMatrix()).some((c) => !c.ok && c.code === 'MODEL_ARTIFACT'));
chk('failure (provider timeout): classified TIMEOUT (bounded retry); a 401 is AUTH (never retried)', PV.classify({ name: 'AbortError', message: 'timeout' }) === 'TIMEOUT' && PV.retryable('TIMEOUT')
  && PV.classify({ status: 401 }) === 'AUTH' && !PV.retryable('AUTH'));
(async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw Object.assign(new Error('HTTP 500 deadlock detected'), { code: '40P01' }); return 'ok'; };
  let got = null;
  try { got = await DB.withRetry(flaky, { label: 'final', sleep: async () => {}, rng: () => 0.5, log: { warn() {}, info() {}, critical() {}, event() {} } }); } catch (e) { got = 'threw ' + e.message; }
  chk('failure (database deadlock 40P01): rolled back and retried with jitter, then completes', got === 'ok' && calls === 2, [got, calls]);
  const dup = PR.build({ now: NOW, predictions: [], decisions: [], files: { 'football/cfb_v2/current.json': { rows: [r0, Object.assign({}, r0, { ens_pred: r0.ens_pred + 5, components: { C_ridge: r0.ens_pred + 5, D_gbm: r0.ens_pred + 5 } })] },
    'football/fbs/slate.json': { games: [] }, 'football/cfb_production/manifest.json': {} } });
  chk('failure (duplicate game rows): neither is used; the game is UNAVAILABLE, never a silent pick', dup.games.length === 1 && dup.games[0].canonical === null && dup.games[0].resolved.mode === 'UNAVAILABLE');
  chk('failure (a BET while betting is disabled): flagged as a policy breach', N.policyConsistency({ status: 'BET', bet_enabled: false }).includes('BET_WHILE_BETTING_DISABLED'));
  const noArt = D.decideGame(E.engine.pure(r0, {}), { quotes: quotesFor(r0) }, { policy: art.policy, artifact: null, now: Date.parse(NOW), row: r0 });
  chk('failure (decision calibration missing): NO_BET, fail closed', noArt.status === 'NO_BET' && /NO_BET_CALIBRATION/.test(noArt.reason_codes.join()), noArt.reason_codes);
  fails.forEach((x) => console.log('FAIL | ' + x));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
