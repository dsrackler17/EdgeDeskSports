#!/usr/bin/env node
/* ===========================================================================
   MARKET RESILIENCE — the thirteen scenarios, on real research objects.
   docs/market-resilience/README.md

   The research objects come from a fresh terminal build of the committed
   production artifacts (football/cfb_terminal/build.js --out <tmp>); each
   market condition is then produced through the SAME code the build and the
   page use (lib/edgedesk_market_state.js → lib/edgedesk_research_engine.js).

     S1  live market, valid                    S8  major roster turnover
     S2  odds API timeout                      S9  page opened repeatedly by many users
     S3  HTTP 429 / exhausted quota            S10 API access resumes after an outage
     S4  no market snapshot exists             S11 projection, no sportsbook coverage
     S5  cached market, stale                  S12 a total inconsistent with other sources
     S6  quote fails an integrity check        S13 AI research while the provider is down
     S7  model-market spread gap over 7

   Across every scenario: research visibility is AVAILABLE, sections 1–4 are
   byte-identical whatever the market does, no market number is invented, an
   old price is never LIVE, and nothing unverified is betting-eligible.
   (The provider-side halves of S2, S3, S9 and S10 — the capture run's stop,
   the breaker, coalescing and recovery — are tools/resilience/quota_guard.test.js
   and odds_quota_sql.test.js.)

   Run: node tools/resilience/resilience.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MKS = require(path.join(ROOT, 'lib', 'edgedesk_market_state.js'));
const RE = require(path.join(ROOT, 'lib', 'edgedesk_research_engine.js'));
const RES = require(path.join(ROOT, 'football', 'cfb_terminal', 'resilience.js'));
const T = require(path.join(ROOT, 'lib', 'cfb_terminal.js'));
const MAN = require(path.join(ROOT, 'tools', 'football', 'manual_market.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function section(t) { console.log('· ' + t); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'market resilience — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- real research objects ------------------------------------------------ */
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'resil-'));
/* the build's clock is PINNED to four hours before UCF @ Oklahoma State
   (2026-10-10 16:00Z), the fixture every scenario is written around: on the
   live clock the game leaves the slate at kickoff and the suite has nothing
   to stand on (it broke that way the afternoon it merged). */
const BUILD_NOW = '2026-10-10T12:00:00Z';
cp.execFileSync(process.execPath, [path.join(ROOT, 'football', 'cfb_terminal', 'build.js'), '--out', out, '--now', BUILD_NOW], { stdio: 'ignore' });
const G = JSON.parse(fs.readFileSync(path.join(out, 'games.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(out, 'board.json'), 'utf8'));
fs.rmSync(out, { recursive: true, force: true });
const NOW = Date.parse(G.generated_at);
const OSU = G.games['401856824'];                  /* UCF @ Oklahoma State: a regime change */
const plain = Object.values(G.games).find((o) => o.week_scope !== 'FUTURE_WEEK' && o.edgedesk.available && !(o.edgedesk.regime && (o.edgedesk.regime.home || o.edgedesk.regime.away))
  && o.decision_status && o.decision_status.key !== 'NO_DECISION');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const gameOf = (o) => ({ game_id: o.game_id, season: o.season, kickoff: o.kickoff, home: o.game.home, away: o.game.away });
const modelOf = (o) => ({ home_margin: o.edgedesk.home_margin, fair_total: o.edgedesk.fair_total });
function q(book, homeLine, minsAgo, extra) {
  return Object.assign({ book, source: 'odds_api', market_type: 'spread', home_line: homeLine, price_home: -110, price_away: -110, observed_at: ago(minsAgo) }, extra || {});
}
function tq(book, total, minsAgo, extra) {
  return Object.assign({ book, source: 'odds_api', market_type: 'total', total, price_over: -110, price_under: -110, observed_at: ago(minsAgo) }, extra || {});
}
function snap(o, quotes, provider, extra) {
  return MKS.classify(Object.assign({ game: gameOf(o), now: NOW, quotes: quotes || [], provider: provider ? { status: provider, checked_at: ago(5) } : null, model: modelOf(o) }, extra || {}));
}
function build(o, s, ctx) { return RE.build(o, s, Object.assign({ now: NOW, betting_enabled: false, carryover: o.carryover }, ctx || {})); }
const research = (R) => JSON.stringify([R.sections.projection, R.sections.matchup, R.sections.explanation, R.sections.uncertainty, R.research_priority]);
const BANNED = /\b(lock|guarantee[ds]?|best bet|bet now|smash|hammer|free money)\b/i;

/* the projection moves with each week's ratings (-4.6 when this was written,
   -4.0 by that evening): the scenarios read it from the build, and hold only what
   they are about, Oklahoma State favoured and a -10.5 market far from it */
const OSU_FAIR = OSU && OSU.edgedesk.fair_text;
const OSU_GAP = OSU ? Math.round(Math.abs(10.5 - OSU.edgedesk.home_margin) * 10) / 10 : null;
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
chk('the fixture: UCF @ Oklahoma State is in the build with a projection, Oklahoma State favoured', !!(OSU && OSU.edgedesk.available && /^Oklahoma State -\d+(\.\d)?$/.test(OSU_FAIR) && OSU_GAP >= 4), [OSU_FAIR, OSU_GAP]);
chk('the fixture: a projected, decision-evaluated game without a regime change exists', !!plain, null);

/* every scenario's snapshot, for the cross-scenario invariants at the end */
const ALL = [];
function record(name, o, s, R) { ALL.push({ name, o, s, R }); return R; }

/* ═══ S1 — live, valid ═══════════════════════════════════════════════════ */
section('S1 live market, valid');
{
  const s = snap(plain, [q('draftkings', plain.market_state.spread.value != null ? plain.market_state.spread.value : -3, 20), q('fanduel', plain.market_state.spread.value != null ? plain.market_state.spread.value : -3, 25),
    q('betmgm', plain.market_state.spread.value != null ? plain.market_state.spread.value : -3, 30), tq('draftkings', 52.5, 20), tq('fanduel', 52.5, 25)], 'OK');
  const R = record('S1', plain, s, build(plain, s));
  chk('S1 LIVE, verified by three fresh books', s.state === 'LIVE' && s.verified === true && s.spread.books === 3, [s.state, s.verified, s.spread.books]);
  chk('S1 market integrity VERIFIED', R.axes.market_integrity.key === 'VERIFIED', R.axes.market_integrity);
  const c = R.sections.market;
  chk('S1 spread and total differences, no-vig and break-even all computed', c.spread && c.total && c.no_vig && c.break_even && c.unavailable.length === 0, c.unavailable);
  chk('S1 the gap is the difference of the two printed lines', /^\|[\d.]+ − [\d.]+\| = [\d.]+$/.test(c.spread.formula), c.spread.formula);
  chk('S1 with betting disabled by policy, validation is BLOCKED by that alone (plus any INVESTIGATE)', R.axes.betting_validation.blockers.every((b) => b.code === 'BETTING_DISABLED' || b.code === 'INVESTIGATE'), R.axes.betting_validation.blockers);
  const R2 = build(plain, s, { betting_enabled: true });
  chk('S1 with betting enabled and a verified live quote, the price is ELIGIBLE for the decision engine (not a bet)', R2.disagreement.key === 'INVESTIGATE' ? R2.axes.betting_validation.key === 'BLOCKED' : R2.axes.betting_validation.key === 'ELIGIBLE', [R2.disagreement.key, R2.axes.betting_validation]);
  chk('S1 the verdict is never a betting verdict', R.sections.verdict.not_a_bet === true && !BANNED.test(R.sections.verdict.text));
}

/* ═══ S2 — odds API timeout ═══════════════════════════════════════════════ */
section('S2 odds API timeout');
{
  const s = snap(OSU, [q('draftkings', -10.5, 240), tq('draftkings', 53.5, 240)], 'TIMEOUT');
  const R = record('S2', OSU, s, build(OSU, s));
  chk('S2 the last capture (4 h) is CACHED, with source and capture time', s.state === 'CACHED' && s.captured_at && s.sources.length && /h old/.test(s.age_text), [s.state, s.age_text, s.sources]);
  chk('S2 the provider status is carried and explained', s.provider.status === 'TIMEOUT' && s.provider.down && /timed out/.test(s.provider.text));
  chk('S2 the comparison is research context, labelled cached', R.sections.market.spread.research_only === true && R.sections.market.spread.market_basis === 'CACHED');
  chk('S2 price calculations are Unavailable (no no-vig, no break-even, no EV)', R.sections.market.no_vig === null && R.sections.market.break_even === null
    && ['no_vig', 'break_even', 'price_ev'].every((k) => R.sections.market.unavailable.some((u) => u.key === k && /Unavailable/.test(u.reason))));
  chk('S2 betting validation BLOCKED: an old price is never a betting opportunity', R.axes.betting_validation.key === 'BLOCKED' && R.axes.betting_validation.blockers.some((b) => b.code === 'MARKET_CACHED'));
  chk('S2 the verdict names the cached capture', /captured market/.test(R.sections.verdict.text) && /not a current price/.test(R.sections.verdict.text), R.sections.verdict.text);
}

/* ═══ S3 — 429 / exhausted quota ══════════════════════════════════════════ */
section('S3 HTTP 429 or exhausted quota');
for (const st of ['RATE_LIMITED', 'QUOTA_EXHAUSTED']) {
  const s = snap(OSU, [q('draftkings', -10.5, 20 * 60)], st);
  const R = record('S3 ' + st, OSU, s, build(OSU, s));
  chk('S3 ' + st + ': the stored snapshot is loaded as CACHED (20 h), never LIVE', s.state === 'CACHED' && s.spread.basis === 'CACHED', [s.state, s.spread.basis]);
  chk('S3 ' + st + ': the research page is complete', R.axes.research_visibility.key === 'AVAILABLE' && R.sections.projection.available && R.sections.matchup.cards.length > 0);
  chk('S3 ' + st + ': the provider text says nothing is retried / paused', /retried|paused|back-off/.test(s.provider.text), s.provider.text);
}

/* ═══ S4 — no snapshot exists ═════════════════════════════════════════════ */
section('S4 no market snapshot exists');
{
  const s = snap(OSU, [], 'QUOTA_EXHAUSTED');
  const R = record('S4', OSU, s, build(OSU, s));
  chk('S4 UNAVAILABLE', s.state === 'UNAVAILABLE' && !s.spread.available && !s.total.available);
  chk('S4 verdict: RESEARCH AVAILABLE — MARKET OFFLINE, with the projection', R.sections.verdict.headline === 'RESEARCH AVAILABLE — MARKET OFFLINE'
    && new RegExp('^EdgeDesk projects ' + esc(OSU_FAIR) + '\\. No verified current sportsbook market is available').test(R.sections.verdict.text) && /Independent football analysis remains accessible\./.test(R.sections.verdict.text), R.sections.verdict);
  chk('S4 every market value is null with an "Unavailable" reason — never a zero', R.sections.market.spread === null && R.sections.market.total === null
    && R.sections.market.unavailable.length >= 4 && R.sections.market.unavailable.every((u) => /^Unavailable/.test(u.reason)), R.sections.market.unavailable);
  chk('S4 no model number stands in for the market', s.spread.value === null && s.total.value === null);
}

/* ═══ S5 — cached market, stale ═══════════════════════════════════════════ */
section('S5 cached market exists but is stale');
{
  const s = snap(OSU, [q('draftkings', -10, 5 * 24 * 60), tq('draftkings', 52.5, 5 * 24 * 60)], 'OK');
  const R = record('S5', OSU, s, build(OSU, s));
  chk('S5 a 5-day-old capture is HISTORICAL (line-movement context only)', s.state === 'HISTORICAL', s.state);
  chk('S5 no spread or total comparison is drawn against it', R.sections.market.spread === null && R.disagreement.available === false);
  chk('S5 verdict: NO CURRENT MARKET', R.sections.verdict.key === 'NO_CURRENT_MARKET' && /historical line/.test(R.sections.verdict.text), R.sections.verdict);
  const s2 = snap(OSU, [q('draftkings', -10.5, 600)], 'OK');
  chk('S5 a 10-hour-old capture is CACHED, labelled "not a current price"', s2.state === 'CACHED' && /not a current price/.test(MKS.basisLabel(s2)), MKS.basisLabel(s2));
}

/* ═══ S6 — integrity failure ══════════════════════════════════════════════ */
section('S6 market quote fails an integrity check');
{
  const cases = [
    ['wrong season', [q('draftkings', -10.5, 20, { season: 2025 })], 'WRONG_SEASON'],
    ['swapped home/away', [q('draftkings', 10.5, 20, { home_team: 'UCF Knights', away_team: 'Oklahoma State Cowboys' })], 'ORIENTATION_SWAPPED'],
    ['another game', [q('draftkings', -3, 20, { game_id: '401856999' })], 'WRONG_GAME_ID'],
    ['kickoff a week off', [q('draftkings', -10.5, 20, { kickoff_ts: new Date(Date.parse(OSU.kickoff) - 7 * 864e5).toISOString() })], 'WRONG_KICKOFF'],
    ['decimal odds read as American', [q('draftkings', -10.5, 20, { price_home: 1.91, price_away: 1.91 })], 'BAD_ODDS_FORMAT'],
    ['a +450 spread', [q('draftkings', 450, 20)], 'IMPOSSIBLE_SPREAD'],
    ['opposite favourites', [q('draftkings', -10.5, 20), q('fanduel', 10.5, 20)], 'OPPOSITE_FAVORITE']
  ];
  cases.forEach(([name, quotes, code]) => {
    const s = snap(OSU, quotes, 'OK');
    const R = record('S6 ' + name, OSU, s, build(OSU, s));
    const codes = s.integrity.failures.map((f) => f.codes.join(',')).concat(s.integrity.checks_fired).join(',');
    chk('S6 ' + name + ' → FAULT (' + code + ')', s.state === 'FAULT' && codes.indexOf(code) >= 0, [s.state, codes]);
    chk('S6 ' + name + ': no comparison number survives', s.spread.value === null && R.sections.market.spread === null && R.disagreement.available === false);
    chk('S6 ' + name + ': the verdict is MARKET FAULT and the research stands', R.sections.verdict.key === 'MARKET_FAULT' && R.axes.research_visibility.key === 'AVAILABLE');
  });
  const s = snap(OSU, [q('draftkings', -10.5, 20), q('fanduel', -10.5, 25), q('caesars', -10, 22), q('rogue', 6.5, 20)], 'OK');
  chk('S6 one bad book among good ones is excluded and logged; the market stands', s.state === 'LIVE' && s.spread.value === -10.5 && s.integrity.failures.some((f) => /SPREAD_OUTLIER/.test(f.codes.join())), [s.state, s.spread.value]);
  const alt = snap(OSU, [q('draftkings', -10.5, 20), q('draftkings', -3.5, 20, { market_key: 'alternate_spreads' }), q('fd', -6.5, 20, { market_key: 'spreads_h1' }), q('x', -10.5, 20, { market_key: 'player_pass_yds' })], 'OK');
  chk('S6 alternate, half and prop lines are refused by name and never mixed with the main line', alt.state === 'LIVE' && alt.spread.value === -10.5
    && ['ALTERNATE_LINE', 'PERIOD_MARKET', 'PLAYER_PROP'].every((c) => alt.integrity.failures.some((f) => f.codes.indexOf(c) >= 0)), alt.integrity.failures.map((f) => f.codes));
  const dup = snap(OSU, [q('draftkings', -10.5, 20), q('draftkings', -10.5, 20)], 'OK');
  chk('S6 a duplicated snapshot is merged, not counted twice', dup.integrity.duplicates_merged === 1 && dup.spread.books === 1);
  const fut = snap(OSU, [q('draftkings', -10.5, -60)], 'OK');
  chk('S6 a capture time in the future is a fault', fut.state === 'FAULT' && /FUTURE_TIMESTAMP/.test(fut.integrity.failures[0].codes.join()), fut.state);
}

/* ═══ S7 — spread gap over seven ══════════════════════════════════════════ */
section('S7 model-market spread difference over seven points');
{
  const line = Math.round((-plain.edgedesk.home_margin - 9.5 * Math.sign(plain.edgedesk.home_margin || 1)) * 2) / 2;   /* a book line: the half-point grid */
  const s = snap(plain, [q('draftkings', line, 20)], 'OK');
  const R = record('S7', plain, s, build(plain, s));
  chk('S7 the disagreement is kept and labelled INVESTIGATE', R.disagreement.available && R.disagreement.points > 7 && R.disagreement.key === 'INVESTIGATE', R.disagreement);
  chk('S7 the headline says how large', /^INVESTIGATE — \d+\.\d-POINT DISAGREEMENT$/.test(R.sections.verdict.headline), R.sections.verdict.headline);
  chk('S7 it is never presented as an edge', /No validated betting edge has been established\./.test(R.sections.verdict.text) && R.axes.betting_validation.key === 'BLOCKED');
  chk('S7 the research page stays fully available', R.axes.research_visibility.key === 'AVAILABLE' && R.sections.explanation.drivers.length > 0);
  chk('S7 the sensitivity panel runs, marks itself significant and says whether the gap persists', R.sensitivity.available && R.sensitivity.significant && R.sensitivity.persistence
    && ['PERSISTS', 'SENSITIVE'].indexOf(R.sensitivity.persistence.key) >= 0, R.sensitivity.persistence);
  chk('S7 every scenario row is labelled, and none is the official line except the base', R.sensitivity.rows.every((r) => ['OFFICIAL', 'SUPPORTED', 'HYPOTHETICAL', 'MODEL'].indexOf(r.status) >= 0)
    && R.sensitivity.rows.filter((r) => r.official).length === 1 && R.sensitivity.rows[0].home_margin === plain.edgedesk.home_margin);
  const v3 = snap(plain, [q('a', s.spread.value, 20), q('b', s.spread.value, 20), q('c', s.spread.value, 20)], 'OK');
  const R3 = build(plain, v3);
  chk('S7 three agreeing books do not verify it while the integrity gate has not passed', R3.disagreement.key === (plain.disagreement && plain.disagreement.verified ? 'VERIFIED_MAJOR' : 'INVESTIGATE'), R3.disagreement.key);
}

/* ═══ S8 — major roster turnover ══════════════════════════════════════════ */
section('S8 a team with major roster turnover');
{
  const s = snap(OSU, [q('draftkings', -10.5, 20, { source: 'espn' })], 'OK');
  const R = record('S8', OSU, s, build(OSU, s));
  chk('S8 UCF @ Oklahoma State: INVESTIGATE — the model-to-market gap in points', R.sections.verdict.headline === 'INVESTIGATE — ' + OSU_GAP.toFixed(1) + '-POINT DISAGREEMENT', [R.sections.verdict.headline, OSU_GAP]);
  chk('S8 the verdict text matches the owner’s example', new RegExp('^EdgeDesk projects ' + esc(OSU_FAIR) + ' against a market of -10\\.5\\. Major roster turnover \\(Oklahoma State: new head coach').test(R.sections.verdict.text)
    && /No validated betting edge has been established\.$/.test(R.sections.verdict.text), R.sections.verdict.text);
  const S = R.sensitivity;
  chk('S8 the prior-season share is stated for both teams', S.carryover.available && /Oklahoma State: 69% of the rating is carried/.test(S.carryover.text) && /UCF: 80%/.test(S.carryover.text), S.carryover.text);
  chk('S8 the re-weighting reconstructs the engine’s rating term exactly', S.carryover.reconstructs === true);
  const rowsBy = (g) => S.rows.filter((r) => r.group === g);
  chk('S8 current-season emphasis inside the validated curve is SUPPORTED; this-season-only is HYPOTHETICAL', rowsBy('current_season').length === 2
    && rowsBy('current_season')[0].status === 'SUPPORTED' && rowsBy('current_season')[1].status === 'HYPOTHETICAL', rowsBy('current_season').map((r) => [r.label, r.status, r.fair_text]));
  chk('S8 the roster adjustment row shows the regime curve’s effect', rowsBy('roster').some((r) => r.key === 'no_regime_home' && r.status === 'SUPPORTED'));
  chk('S8 availability scenarios use the measured QB effect', rowsBy('availability').length >= 2 && rowsBy('availability').every((r) => r.status === 'SUPPORTED'));
  chk('S8 the disagreement persists under every supported alternative', S.persistence.key === 'PERSISTS' && S.persistence.min_gap >= 4, S.persistence);
  chk('S8 the official fair line is untouched by every scenario', R.sections.projection.home_margin === OSU.edgedesk.home_margin && S.base.home_margin === OSU.edgedesk.home_margin);
  chk('S8 the roster continuity section names the turnover', R.sections.matchup.roster_continuity.some((r) => r.regime_change && /returning production at the 1st percentile/.test(r.text)));
  chk('S8 research priority leads with roster turnover', R.research_priority.reasons[0].key === 'roster_turnover', R.research_priority.reasons);
}

/* ═══ S9 — repeated opens by many users ═══════════════════════════════════ */
section('S9 a research page opened repeatedly by multiple users');
{
  const realFetch = global.fetch; let calls = 0;
  global.fetch = function () { calls++; throw new Error('the research layer must not fetch'); };
  const outs = new Set();
  for (let i = 0; i < 200; i++) outs.add(JSON.stringify(build(OSU, OSU.market_state)));
  global.fetch = realFetch;
  chk('S9 200 renders: identical output, deterministic', outs.size === 1);
  chk('S9 200 renders: zero network calls', calls === 0, calls);
  const page = ['research/cfb/terminal.js', 'research/cfb/resilience_ui.js', 'lib/edgedesk_research_engine.js', 'lib/edgedesk_market_state.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  chk('S9 no page or research code can reach an odds provider or the capture function', !/the-odds-api|oddsblaze|functions\/v1\/capture|functions\/v1\/odds/.test(page));
  chk('S9 no timer on the research page polls for odds', !/setInterval\s*\(/.test(fs.readFileSync(path.join(ROOT, 'research/cfb/resilience_ui.js'), 'utf8')));
}

/* ═══ S10 — API access resumes ════════════════════════════════════════════ */
section('S10 API access resumes after an outage');
{
  const down = snap(OSU, [q('draftkings', -10.5, 8 * 60)], 'OUTAGE');
  const up = snap(OSU, [q('draftkings', -10.5, 8 * 60), q('draftkings', -10.5, 3)], 'OK');
  chk('S10 during the outage: CACHED, provider OUTAGE', down.state === 'CACHED' && down.provider.status === 'OUTAGE');
  chk('S10 after recovery: the fresh capture is LIVE again', up.state === 'LIVE' && up.spread.age_minutes === 3, [up.state, up.spread.age_minutes]);
  const Rd = build(OSU, down), Ru = build(OSU, up);
  chk('S10 the research is the same before and after', research(Rd) === research(Ru));
}

/* ═══ S11 — no sportsbook coverage ════════════════════════════════════════ */
section('S11 a projected game with no sportsbook coverage');
{
  const look = Object.values(G.games).find((o) => o.market_state.state === 'UNAVAILABLE' && o.edgedesk.available);
  const s = snap(look, [], 'OK');
  const R = record('S11', look, s, build(look, s));
  chk('S11 UNAVAILABLE with the provider up: "MARKET UNAVAILABLE", not "offline"', R.sections.verdict.headline === 'RESEARCH AVAILABLE — MARKET UNAVAILABLE', R.sections.verdict.headline);
  chk('S11 a full projection, outcome distribution and game scripts', R.sections.projection.available && R.sections.projection.outcome_bands.length === 5 && R.sections.matchup.game_scripts.length === 4);
  chk('S11 the model-only research queue ranks it', BOARD.resilience.research_queue.indexOf(look.game_id) >= 0 && R.research_priority.score > 0);
  chk('S11 the board row carries the projection itself (total, score, win probability)', (() => { const r = BOARD.rows.find((x) => x.game_id === look.game_id); return r && 'fair_total' in r && 'projected_score' in r && r.win_prob && r.win_prob.home != null; })());
}

/* ═══ S12 — an inconsistent total ═════════════════════════════════════════ */
section('S12 a market total clearly inconsistent with other sources');
{
  const s = snap(OSU, [q('draftkings', -10.5, 20), tq('draftkings', 53.5, 20), tq('fanduel', 53.5, 22), tq('rogue', 34.5, 20)], 'OK');
  chk('S12 a 34.5 beside two 53.5s is excluded as an outlier; the total is 53.5', s.total.value === 53.5 && s.integrity.failures.some((f) => f.total === 34.5 && f.codes.indexOf('TOTAL_OUTLIER') >= 0), [s.total.value, s.integrity.failures]);
  const lone = snap(OSU, [q('draftkings', -10.5, 20), tq('rogue', 34.5, 20)], 'OK');
  chk('S12 a lone 34.5 against EdgeDesk’s 50.9 is held for verification and never compared', lone.total.value === null && lone.integrity.held.length === 1
    && build(OSU, lone).sections.market.total === null, [lone.total, lone.integrity.held]);
  const tt = snap(OSU, [q('draftkings', -10.5, 20), tq('fd', 34.5, 20, { market_key: 'team_totals' }), tq('fd', 27.5, 20, { market_key: 'totals_h1' }), tq('fd', 30.5, 20, { market_key: 'alternate_totals' })], 'OK');
  chk('S12 a team total, a first-half total and an alternate total are refused by name', tt.total.value === null
    && ['TEAM_TOTAL', 'PERIOD_MARKET', 'ALTERNATE_LINE'].every((c) => tt.integrity.failures.some((f) => f.codes.indexOf(c) >= 0)));
  const conf = snap(OSU, [q('draftkings', -10.5, 20), tq('fd', 10.5, 20)], 'OK');
  chk('S12 a spread read into the total field is a total/spread confusion', conf.integrity.failures.some((f) => f.codes.indexOf('TOTAL_SPREAD_CONFUSION') >= 0));
  const two = snap(OSU, [q('draftkings', -10.5, 20), tq('a', 53.5, 20), tq('b', 34.5, 20)], 'OK');
  chk('S12 two totals that disagree by 19 pts: neither is chosen', two.total.value === null && two.integrity.warnings.some((w) => /neither can be chosen/.test(w)), two.integrity.warnings);
  /* the app's brief gate holds the same numbers (app.html fbTotalCheck) */
  const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const m = /function fbTotalCheck\(total,modelTotal\)\{[\s\S]*?\n\}/.exec(html);
  const fbNum = (x) => { if (x == null || x === '') return null; const v = +x; return isFinite(v) ? v : null; };
  const fbTotalCheck = m ? new Function('fbNum', m[0] + '\nreturn fbTotalCheck;')(fbNum) : null;
  chk('S12 the brief prints 53.5 and holds 34.5 against a 50.9 model total', fbTotalCheck && fbTotalCheck(53.5, 50.9).ok && !fbTotalCheck(34.5, 50.9).ok && /held for verification/.test(fbTotalCheck(34.5, 50.9).reason));
  chk('S12 the app reads totals with their price and modal rows first', /point_is_modal\.desc\.nullslast/.test(html) && /fresh:current\(r\.last_seen_at,'totals'\),dec:fbNum\(r\.best_dec\)/.test(html));
}

/* ═══ S13 — AI research while the provider is down ════════════════════════ */
section('S13 AI research requested while the odds provider is unavailable');
{
  const s = snap(OSU, [], 'QUOTA_EXHAUSTED');
  const R = record('S13', OSU, s, build(OSU, s));
  const a1 = RE.ask('Why is the market unavailable?', OSU, R);
  chk('S13 the assistant explains the market state and that research is unaffected', a1 && a1.intent === 'market_state' && /quota/i.test(a1.text) && /None of the football research depends on it/.test(a1.text), a1);
  const a2 = RE.ask('How sensitive is this to roster turnover and last season?', OSU, R);
  chk('S13 it answers sensitivity from stored data', a2 && a2.intent === 'sensitivity' && /No scenario changes the official fair line/.test(a2.text));
  const a3 = RE.ask('Can I bet this?', OSU, R);
  chk('S13 a betting question gets the research verdict and its blockers, never a pick', a3 && a3.intent === 'verdict' && /BLOCKED/.test(a3.text) && !BANNED.test(a3.text));
  const realFetch = global.fetch; let calls = 0;
  global.fetch = function () { calls++; throw new Error('offline'); };
  let a4 = null;
  try { a4 = T.ask('Which player matters most?', OSU, null); } catch (e) { a4 = { error: e.message }; }
  global.fetch = realFetch;
  chk('S13 the terminal’s own assistant answers football questions with no network', a4 && a4.text && !a4.error && calls === 0, a4);
}

/* ═══ the invariants across every scenario ════════════════════════════════ */
section('invariants across every scenario');
{
  const osu = ALL.filter((x) => x.o === OSU);
  const base = research(osu[0].R);
  chk('research visibility is AVAILABLE in every scenario (' + ALL.length + ')', ALL.every((x) => x.R.axes.research_visibility.key === 'AVAILABLE'), ALL.filter((x) => x.R.axes.research_visibility.key !== 'AVAILABLE').map((x) => x.name));
  chk('sections 1–4 and the research priority are identical whatever the market does (' + osu.length + ' UCF scenarios)', osu.every((x) => research(x.R) === base), osu.filter((x) => research(x.R) !== base).map((x) => x.name));
  chk('research-only mode leaves sections 1–4 identical too', research(build(OSU, OSU.market_state, { mode: 'RESEARCH_ONLY' })) === base);
  const ro = build(OSU, OSU.market_state, { mode: 'RESEARCH_ONLY' });
  chk('research-only mode shows every market value as Unavailable and blocks betting', ro.sections.market.state === 'RESEARCH_ONLY' && ro.sections.market.spread === null
    && /research-only/i.test(ro.sections.market.unavailable[0].reason) && ro.axes.betting_validation.blockers[0].code === 'RESEARCH_ONLY' && ro.sections.verdict.key === 'RESEARCH_ONLY');
  chk('nothing but a LIVE verified quote is ever betting-eligible', ALL.every((x) => build(x.o, x.s, { betting_enabled: true }).axes.betting_validation.key === 'BLOCKED' || (x.s.state === 'LIVE' && x.s.verified)));
  chk('no FAULT carries a comparison number', ALL.filter((x) => x.s.state === 'FAULT').every((x) => x.s.spread.value === null && x.s.total.value === null && x.R.sections.market.spread === null));
  chk('no verdict uses banned wager language', ALL.every((x) => !BANNED.test(x.R.sections.verdict.headline + ' ' + x.R.sections.verdict.text)));
  chk('every verdict is marked not a bet', ALL.every((x) => x.R.sections.verdict.not_a_bet === true));
}

/* ═══ heartbeats, manual entries, the build ═══════════════════════════════ */
section('heartbeats confirm, manual entries, the committed build');
{
  const ledger = { quotes: new Map([['G', [
    { game_id: 'G', source: 'espn', book: 'draftkings', market_type: 'spread', home_line: -10.5, price_home: -112, price_away: -108, observed_at: ago(3 * 24 * 60) },
    { game_id: 'G', source: 'espn', book: 'draftkings', market_type: 'spread', home_line: -10.5, price_home: -112, price_away: -108, observed_at: ago(25), is_heartbeat: true }]]]), totals: new Map() };
  const qs = RES.quotesFor(ledger, 'G', null, NOW);
  chk('a heartbeat with the same values confirms the change row (one quote, confirmed 25 min ago)', qs.length === 1 && qs[0].confirmed_at === ago(25) && qs[0].observed_at === ago(3 * 24 * 60), qs);
  const s = MKS.classify({ game: { game_id: 'G', kickoff: new Date(NOW + 3600e3).toISOString(), home: 'H', away: 'A' }, now: NOW, quotes: qs });
  chk('a heartbeat-confirmed line is LIVE, and keeps its first-seen time', s.state === 'LIVE' && s.spread.first_seen_at === ago(3 * 24 * 60), [s.state, s.spread.first_seen_at]);
  const prev = process.env.TERMINAL_HEARTBEATS_CONFIRM; process.env.TERMINAL_HEARTBEATS_CONFIRM = '0';
  chk('TERMINAL_HEARTBEATS_CONFIRM=0 restores the old rule', RES.heartbeatsConfirm() === false);
  if (prev == null) delete process.env.TERMINAL_HEARTBEATS_CONFIRM; else process.env.TERMINAL_HEARTBEATS_CONFIRM = prev;

  const g = { game_id: OSU.game_id, season: OSU.season, kickoff: OSU.kickoff, home_team: OSU.game.home, away_team: OSU.game.away };
  const e = MAN.makeEntry({ game_id: OSU.game_id, game: g, season: OSU.season, home_line: -10.5, total: 53.5, note: 'test' }, NOW - 60e3);
  chk('a manual entry is recorded with who and when, labelled MANUAL', e.label === 'MANUAL' && e.entered_by === 'owner' && /^man_[0-9a-f]{16}$/.test(e.entry_id));
  let refused = null; try { MAN.makeEntry({ game_id: OSU.game_id, game: g, season: OSU.season, total: 10.5 }, NOW - 60e3); } catch (x) { refused = x.message; }
  chk('a manual total that reads like a spread is refused', /TOTAL_SPREAD_CONFUSION/.test(refused || ''), refused);
  const ms = snap(OSU, [q('draftkings', -10.5, 20 * 60)], 'QUOTA_EXHAUSTED', { manual: [{ game_id: OSU.game_id, home_line: -10.5, total: 53.5, entered_at: ago(30), entered_by: 'owner' }] });
  const Rm = build(OSU, ms, { betting_enabled: true });
  chk('a manual number newer than the cache becomes the MANUAL state', ms.state === 'MANUAL' && ms.spread.basis === 'MANUAL', [ms.state, ms.spread.basis]);
  chk('MANUAL: research comparison only, labelled, never betting-eligible', Rm.sections.market.spread.research_only === true && Rm.axes.betting_validation.key === 'BLOCKED'
    && Rm.axes.betting_validation.blockers.some((b) => b.code === 'MARKET_MANUAL') && /manually entered market/.test(Rm.sections.verdict.text), Rm.sections.verdict.text);

  chk('the build gives every projected game a resilience layer and a research-visible page', Object.values(G.games).every((o) => o.resilience && (!o.edgedesk.available || o.resilience.axes.research_visibility.key === 'AVAILABLE')));
  chk('the board carries the market-state counts and the model-only queue', BOARD.resilience && BOARD.resilience.research_queue.length === BOARD.rows.length
    && Object.keys(BOARD.resilience.market_states).length === 6);
  chk('the brief’s no-market summary keeps the model’s own largest term', /EdgeDesk’s largest term is/.test(Object.values(G.games).find((o) => !o.disagreement.available).summary.why));
}
done();
