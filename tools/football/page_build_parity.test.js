#!/usr/bin/env node
/* ===========================================================================
   THE BOARD REPRODUCES THE PUBLISHED NUMBER.

   EdgeDesk publishes one college number per game: football/fbs/slate.json,
   built by football/fbs/build_coverage.js and written to the model record.
   The terminal board projects the same games live in the browser, through
   the same engine, and the research desk compares the two: "N projections
   have moved 0.75+ pts from their latest published numbers".

   That comparison is only honest if the board, given the build's inputs,
   produces the build's number. It did not. The board's loader absorbed each
   game's play-level efficiency twice — once in the replay, alongside the
   score, and again in a "late join" written for a replay that no longer
   exists — and ordered same-kickoff games differently. On the live site the
   matchup term drifted up to 1.6 pts from the published number on the SAME
   inputs, 20 of 129 games read as MOVING, and the desk announced 20
   projections had moved while no published number had changed at all.

   This suite runs BOTH paths over one committed input set and requires the
   same state and the same number:

     page   the terminal's own loader (fbP4LoadGuarded: replay, efficiency
            late join, canonical rating), booted out of app.html, fed the
            committed schedule fixture and the committed artifacts;
     build  football/fbs/build_coverage.js buildState over the same rows and
            the same efficiency artifact.

   It also proves it would have caught the bug: absorbing the rows a second
   time must move the number past the tolerance.

   AND THE SAME INPUT CONTRACT. The board printed a reliability figure from a
   17-row copy of the build's contract while the slate published the build's
   26 rows, so one game read 59% on the board and 77% in the artifact and
   could carry two research labels. Both now assemble the contract and the
   request through football/matchup/contract.js. The second half of this
   suite hands the build's football/matchup/inputs.js load() the same
   committed artifacts and the same staged forecasts the board holds, and
   requires, for every upcoming game:

     fbP4ContractFor(u).summary  ===  buildRequest(...).summary
                                      (the slate's input_contract_summary)
     and every contract row equal, field by field;
     the request equal except where named below; and
     the same fair spread and the same confidence.

   AND THE SAME INJURY LIST. A listed player moves the number only when the
   player layer identifies him as the starter (football/players/teams), and
   the board used to load that layer only for teams the automated collector
   named — never for one only a conference report named. Both now read the
   one join in football/matchup/contract.js; the last section lists a real
   starting quarterback out on both sides and requires the same identified
   list and the same moved number.

   One request difference predates the shared contract and is PINNED here
   rather than hidden, because it moves a priced number on one side only:
     - the build's schedule index keys each opponent with
       football/matchup/inputs.js normKey, which drops an accent ("San José
       State" -> sanjosstate) while every rating is keyed by the engine's,
       which folds it (sanjosestate), so the build finds no rating for that
       opponent and its rest/strength context reads null where the board's
       reads the rating.
   Any OTHER request difference fails.

   The clock is pinned inside the fixture's season, so the suite reads the
   same games on every day of every year.
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fbs_schedule_sample.csv');
const EFF_FILE = path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = !!ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function finish() {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | board ↔ published build parity | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

/* ---- the one input set ------------------------------------------------ */
const B = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const csv = fs.readFileSync(FIXTURE, 'utf8');
const rows = B.normRows(B.parseCsv(csv));
const SEASON = rows.length ? rows[0].season : null;
const eff = JSON.parse(fs.readFileSync(EFF_FILE, 'utf8'));
/* the day after the fixture's last completed game: its unplayed rows are the
   upcoming slate, as they were when it was captured */
const lastDone = rows.filter(r => r.completed).map(r => Date.parse(r.start_date)).filter(isFinite)
  .reduce((a, b) => Math.max(a, b), 0);
const NOW = lastDone + 86400e3;

/* the schedule is served to the page from a private feed cache, under the
   exact name the headless host reads it by */
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-parity-'));
process.env.EDP_CACHE = CACHE;
const H = require(path.join(ROOT, 'tools', 'articles', 'research_host.js'));
fs.writeFileSync(path.join(CACHE, H.cacheNameFor(H.FEEDS.cfb(SEASON))), csv);

const M = require('./_module.js');

function waitFor(test, ms) {
  const until = Date.now() + ms;
  return new Promise(resolve => {
    (function tick() {
      let ok = false; try { ok = !!test(); } catch (_) { ok = false; }
      if (ok || Date.now() > until) return resolve(ok);
      setTimeout(tick, 50);
    })();
  });
}

(async function main() {
  console.log('\n== one input set: ' + SEASON + ' fixture schedule, committed efficiency (' + (eff.games_with_stats || 0)
    + ' games), clock ' + new Date(NOW).toISOString().slice(0, 10) + ' ==');
  chk('the fixture is one season with completed games', SEASON > 2000 && lastDone > 0, { SEASON, lastDone });
  chk('the committed efficiency artifact is that season', +eff.season === SEASON, eff.season);

  /* ---- the page ------------------------------------------------------- */
  const boot = M.boot({ probe: ['fbP4LoadGuarded', 'fbP4Request', 'fbP4Key', 'fbP4ContractFor', 'fbP4InjuryPlayerEnsure'] });
  if (boot.error) { chk('the football module boots', false, String(boot.error.message || boot.error)); return finish(); }
  const win = boot.win;
  /* the page's clock, pinned; everything else about Date is the real one */
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }
  win.Date = PinnedDate;
  H.installPageGlobals(win);
  const fx = H.makeFetch({ network: false }, () => {});
  win.fetch = fx[0];
  H.installScriptLoader(win, fx[1]);
  M.loadEngine(win, ROOT);
  const E = win.EDCfbP4;

  let settled = false, loadErr = null;
  win.__FBTEST.fbP4LoadGuarded(true, null).then(() => { settled = true; }, e => { loadErr = e; settled = true; });
  await waitFor(() => settled, 120000);
  const S = win.FB.p4;
  chk('the terminal loader finishes', settled && !loadErr, loadErr && String(loadErr.message || loadErr));
  chk('and projects upcoming games', (S.up || []).length > 0, { up: (S.up || []).length, gate: S.gate });
  chk('the page read the committed efficiency artifact', S.engineEfficiency && S.engineEfficiency.schema === eff.schema);
  const R = S.efficiencyReplay || {};
  chk('the late join absorbed nothing the replay had already absorbed', R.late_joined === 0, R);
  chk('and still counts every game that supplied efficiency', R.games > 0 && R.error == null, R);

  /* ---- the build ------------------------------------------------------ */
  /* the build replays in a node global scope with its own engine instance;
     its state is plain data, so it is projected here through the page's
     engine — the same file, byte for byte */
  const built = B.buildState({ [SEASON]: rows }, SEASON, eff);
  chk('the build replay absorbed the same completed games', built.absorbed === S.absorbed,
    { build: built.absorbed, page: S.absorbed });
  chk('with play-level rows for games the page also joined', built.efficiency_games_absorbed > 0
    && built.efficiency_games_absorbed <= R.games, { build: built.efficiency_games_absorbed, page: R.games });

  /* ---- the same request, under each state ------------------------------ */
  /* every input except the rating state is the page's own request, so any
     difference is the replay's and nothing else's */
  const buildState = JSON.parse(JSON.stringify(built.st));
  function project(u, st) {
    const req = win.__FBTEST.fbP4Request(u, { noMarket: true });
    if (st) req.state = st;
    return E.projectGame(req);
  }
  function terms(p) {
    const o = {}; ((p && p.contributions) || []).forEach(c => { if (c.available) o[c.key] = c.points; });
    return o;
  }
  /* the canonical research rating is installed after the replay on the page
     (fbP4ApplyCanonicalRating) and by the build's own caller; it is carried
     across so the comparison is the replay alone */
  ['canonicalRatings', 'canonicalResearchRatings', 'canonicalRatingMeta', 'canonicalRatingCount', 'canonicalRatingActiveCount']
    .forEach(k => { if (S.state[k] !== undefined) buildState[k] = JSON.parse(JSON.stringify(S.state[k])); });
  let worst = 0, worstGame = null, worstTerm = {}, n = 0;
  (S.up || []).forEach(u => {
    const a = project(u), b = project(u, buildState);
    if (!a || a.status !== 'PREDICTED' || !b || b.status !== 'PREDICTED') return;
    n++;
    const d = Math.abs(a.model.fair_spread - b.model.fair_spread);
    if (d > worst) {
      worst = d; worstGame = u.g.away_team + ' @ ' + u.g.home_team;
      const ta = terms(a), tb = terms(b);
      worstTerm = {};
      Object.keys(Object.assign({}, ta, tb)).forEach(k => {
        const dd = (ta[k] || 0) - (tb[k] || 0);
        if (Math.abs(dd) > 1e-9) worstTerm[k] = Math.round(dd * 1e4) / 1e4;
      });
    }
  });
  chk('games were projected on both states', n > 20, n);
  chk('the board reproduces the published build to 1e-9 pts on every game', worst < 1e-9,
    { worst, game: worstGame, terms: worstTerm });

  /* ---- and it would have caught the bug -------------------------------- */
  /* the old late join: every game's rows absorbed a second time, in the
     build's order */
  const sorted = rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))
    || String(a.game_id).localeCompare(String(b.game_id)));
  const twice = JSON.parse(JSON.stringify(S.state));
  sorted.forEach(r => {
    if (!r.completed || r.home_points == null || r.away_points == null) return;
    const ts = B.efficiencyForGame(eff, r, SEASON);
    if (ts) E.ingest.absorbEfficiencyGame(twice, { home: r.home_team, away: r.away_team, team_stats: ts });
  });
  let moved = 0;
  (S.up || []).forEach(u => {
    const a = project(u), b = project(u, twice);
    if (a && b && a.model && b.model) moved = Math.max(moved, Math.abs(a.model.fair_spread - b.model.fair_spread));
  });
  chk('absorbing the same rows twice moves the number past the tolerance (the old bug is detectable)', moved > 0.05, moved);

  /* ==== THE SAME INPUT CONTRACT ========================================= */
  console.log('\n== the input contract: the board’s fbP4ContractFor against the build’s buildRequest ==');
  chk('the board assembled its contract through the shared file', !!win.EDInputContract && typeof win.EDInputContract.assemble === 'function');
  chk('the board read the committed artifacts the build reads',
    !!(S.art && S.art.av_current && S.art.av_reports && S.art.coaching && S.art.team_talent && S.art.supp && S.art.gen),
    Object.keys(S.art || {}).filter(k => S.art[k]));
  chk('and the roster sync the build prices from', S.rosterSource === 'EdgeDesk ESPN roster sync', S.rosterSource);

  /* ONE FORECAST, BOTH SIDES. The board fetches it live and the build
     carries the last observation forward; the question here is whether the
     two contracts read the same forecast the same way, so both are handed
     the same staged one — three fresh, one old enough to be stale, and the
     rest attempted and refused. */
  const P0 = win.EDCfbP4Params;
  const withVenue = (S.up || []).filter(u => {
    const v = P0.universe && P0.universe.venues && P0.universe.venues[win.__FBTEST.fbP4Key(u.g.home_team)];
    return v && !v.dome;
  });
  const wx = {};
  withVenue.slice(0, 4).forEach((u, i) => {
    wx[String(u.g.game_id)] = { temp_f: 61 + i, wind_mph: 8 + i, precip_in: 0, dome: false, humidity_pct: 50,
      source: 'open-meteo forecast', as_of: new Date(NOW - (i === 3 ? 96 : 2) * 3600e3).toISOString() };
  });
  S.weather = wx; S.weatherAttempted = true; S.weatherN = (S.weatherN || 0) + 1;
  chk('forecasts were staged for games with venue coordinates', Object.keys(wx).length === 4, Object.keys(wx).length);

  /* the build, on the same clock, with its own copy of the parameters —
     load() merges venues into the table it is handed, as the build does */
  const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
  const realNow = Date.now;
  Date.now = () => NOW;
  let ctx, si, perGame = [];
  try {
    ctx = IN.load({ season: SEASON, params: JSON.parse(JSON.stringify(P0)), normKey: E.normKey,
      weather: wx, weather_attempted: true, weather_source: 'open-meteo forecast' });
    const ratingIndex = Object.assign({}, S.state.r);
    Object.keys(S.state.canonicalRatings || {}).forEach(k => { ratingIndex[k] = S.state.canonicalRatings[k].value; });
    si = IN.scheduleIndex(rows, ratingIndex);
    (S.up || []).forEach(u => {
      const row = rows.find(r => String(r.game_id) === String(u.g.game_id));
      if (!row) return;
      perGame.push({ u, row, build: IN.buildRequest(ctx, { game: row, meta: u.meta, state: S.state, schedule_index: si, now: NOW }),
        ratingIndex });
    });
  } finally { Date.now = realNow; }
  chk('the build assembled every upcoming game the board holds', perGame.length === (S.up || []).length && perGame.length > 20,
    { build: perGame.length, page: (S.up || []).length });

  const sumBad = [], rowBad = [], reqBad = [], pricedBad = [];
  let schedNull = 0, staleSeen = 0, usableWx = 0, failedWx = 0;
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'state' ? undefined : v)));
  const SCHED = /^\.teams\.(home|away)\.schedule\.(prev|next)_opp_rating$/;
  perGame.forEach(({ u, build, ratingIndex }) => {
    const name = u.g.away_team + ' @ ' + u.g.home_team;
    const page = win.__FBTEST.fbP4ContractFor(u);
    if (!page || JSON.stringify(page.summary) !== JSON.stringify(build.summary)) {
      sumBad.push({ game: name, page: page && page.summary && page.summary.by_state, build: build.summary.by_state });
    }
    if (!page || JSON.stringify(page.rows) !== JSON.stringify(build.contract)) {
      const d = [];
      (build.contract || []).forEach((r, i) => {
        const q = page && page.rows[i];
        if (JSON.stringify(q) !== JSON.stringify(r)) d.push({ field: r.field, side: r.side, build: r.state, page: q && q.state });
      });
      rowBad.push({ game: name, rows: d.slice(0, 4) });
    }
    (build.contract || []).forEach(r => {
      if (r.field !== 'weather') return;
      if (r.state === 'STALE') staleSeen++;
      if (r.state === 'USABLE' || r.state === 'RESEARCH_ONLY') usableWx++;
      if (r.state === 'FETCH_FAILED') failedWx++;
    });

    /* the request, path by path */
    const pr = win.__FBTEST.fbP4Request(u, { noMarket: true });
    const A1 = strip(pr), B1 = strip(build.baseline);
    const known = [];
    (function walk(a, b, at) {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        new Set(Object.keys(a).concat(Object.keys(b))).forEach(k => walk(a[k], b[k], at + '.' + k));
        return;
      }
      if (SCHED.test(at) && b == null) {
        /* the same fixture, keyed by each side's own normaliser: the build
           found no rating because its key for the opponent is not the key
           the rating is filed under */
        const side = at.split('.')[2], which = /prev_/.test(at) ? 'prev' : 'next';
        const team = side === 'home' ? u.g.home_team : u.g.away_team;
        const blist = si.idx[IN.normKey(team)] || [];
        const bi = blist.findIndex(x => String(x.gid) === String(u.g.game_id));
        const bopp = bi >= 0 ? blist[which === 'prev' ? bi - 1 : bi + 1] : null;
        const popp = bopp && ((S.schedIdx || {})[win.__FBTEST.fbP4Key(team)] || []).find(x => String(x.gid) === String(bopp.gid));
        if (bopp && popp && bopp.oppKey !== popp.oppKey && ratingIndex[bopp.oppKey] == null && ratingIndex[popp.oppKey] != null) {
          known.push('sched'); return;
        }
      }
      reqBad.push({ game: name, at, page: JSON.stringify(a).slice(0, 120), build: JSON.stringify(b).slice(0, 120) });
    })(A1, B1, '');
    if (known.indexOf('sched') >= 0) schedNull++;

    /* the number and the confidence, with the pinned difference reconciled
       so that what is compared is the shared assembly alone */
    const same = JSON.parse(JSON.stringify(pr, (k, v) => (k === 'state' ? undefined : v)));
    same.state = S.state;
    ['home', 'away'].forEach(side => {
      same.teams[side].schedule = build.baseline.teams[side].schedule;
    });
    const a = E.projectGame(same), b = E.projectGame(build.baseline);
    if (!a || !b || a.status !== b.status) { pricedBad.push({ game: name, page: a && a.status, build: b && b.status }); return; }
    if (a.status !== 'PREDICTED') return;
    if (Math.abs(a.model.fair_spread - b.model.fair_spread) > 1e-9 || a.scores.confidence !== b.scores.confidence) {
      pricedBad.push({ game: name, fair: [a.model.fair_spread, b.model.fair_spread], confidence: [a.scores.confidence, b.scores.confidence] });
    }
  });
  chk('the board’s contract summary equals the build’s input_contract_summary on every game', sumBad.length === 0,
    { games: perGame.length, differ: sumBad.length, first: sumBad.slice(0, 3) });
  chk('and every contract row is the build’s row, field by field', rowBad.length === 0,
    { differ: rowBad.length, first: rowBad.slice(0, 2) });
  chk('the staged forecasts reached both contracts as usable, stale and refused',
    usableWx >= 3 && staleSeen >= 1 && failedWx >= 1, { usableWx, staleSeen, failedWx });
  chk('the request differs from the build’s only where this suite names it', reqBad.length === 0,
    { differ: reqBad.length, first: reqBad.slice(0, 4) });
  console.log('       (pinned, pre-existing: ' + schedNull + ' game(s) with a build-only null schedule rating from an '
    + 'accent-dropping key)');
  chk('on the same assembly, the same fair spread and the same confidence on every game', pricedBad.length === 0,
    { differ: pricedBad.length, first: pricedBad.slice(0, 3) });

  /* and it would have caught the old divergence: the board's former 17-row
     contract read coverage over a different denominator */
  const any = perGame[0];
  chk('the shared contract is the build’s 24-plus rows, not the board’s former 17',
    any && win.__FBTEST.fbP4ContractFor(any.u).rows.length === any.build.contract.length && any.build.contract.length > 17,
    any && any.build.contract.length);

  /* ==== THE SAME INJURY LIST ============================================ */
  console.log('\n== the injury join: a starting quarterback listed out, on both sides ==');
  const C = win.EDInputContract;
  /* a fixture whose home side has a quarterback the player layer marks as
     the starter */
  let pick = null;
  for (const g of perGame) {
    const tk = C.normKey(g.u.g.home_team);
    const det = ctx.player_details_by_team[tk];
    const qb = det && (det.groups.QB || []).find(p => /starter/i.test(String(p.role)) && det.by_name[C.normPersonName(p.n)] === p);
    if (qb) { pick = { g, qb }; break; }
  }
  chk('a fixture with an identified starting quarterback exists', !!pick);
  if (pick) {
    const { g, qb } = pick;
    const name = g.u.g.home_team, gid = String(g.u.g.game_id);
    /* one conference filing for this fixture, as the overlay merges it */
    const filed = () => ({ team_name: name, team_display: name, dataQuality: 'OFFICIAL', lastUpdated: null,
      players: [{ player_name: qb.n, name: qb.n, status: 'OUT', game_id: gid, source_name: 'staged availability report',
        observed_at: new Date(NOW - 3600e3).toISOString() }],
      official_report: { ok: true, game_id: gid, comprehensive: true, report_of_no_absences: false } });
    ctx.availability_by_team[IN.normKey(name)] = filed();
    const view = win.__FBTEST && S._av && S._av.v;
    chk('the board holds its merged availability view', !!view);
    view.by_team[C.normKey(name)] = filed();
    /* the board decides for itself which player files to load, from that view */
    delete (win.FB.pq.teams || {})[win.__FBTEST.fbP4Key(name)];
    await win.__FBTEST.fbP4InjuryPlayerEnsure();
    chk('the board loaded the named team’s player file because the filing named someone on it',
      !!(win.FB.pq.teams || {})[win.__FBTEST.fbP4Key(name)]);
    S._ictx = null; g.u._asm = null; g.u._contract = null;
    Date.now = () => NOW;
    let buildReq;
    try { buildReq = IN.buildRequest(ctx, { game: g.row, meta: g.u.meta, state: S.state, schedule_index: si, now: NOW }); }
    finally { Date.now = realNow; }
    const pageReq = win.__FBTEST.fbP4Request(g.u, { noMarket: true });
    const bi = buildReq.baseline.teams.home.injuries, pi = pageReq.teams.home.injuries;
    chk('the board’s injury list is the build’s, field for field', JSON.stringify(pi) === JSON.stringify(bi),
      { page: pi, build: bi });
    chk('and it identifies the quarterback as the starter, with his snap share',
      pi && pi[0] && pi[0].starter === true && pi[0].athlete_id === String(qb.id) && pi[0].snap_share === qb.share, pi && pi[0]);
    const clear = JSON.parse(JSON.stringify(pageReq, (k, v) => (k === 'state' ? undefined : v)));
    clear.state = S.state; clear.teams.home.injuries = null;
    const withOut = JSON.parse(JSON.stringify(pageReq, (k, v) => (k === 'state' ? undefined : v)));
    withOut.state = S.state; withOut.teams.home.schedule = buildReq.baseline.teams.home.schedule;
    withOut.teams.away.schedule = buildReq.baseline.teams.away.schedule;
    const a = E.projectGame(withOut), b = E.projectGame(buildReq.baseline), c = E.projectGame(clear);
    chk('both price the same number with him out', a.status === 'PREDICTED' && Math.abs(a.model.fair_spread - b.model.fair_spread) < 1e-9,
      { page: a.model && a.model.fair_spread, build: b.model && b.model.fair_spread });
    const moved = a.model.fair_spread - c.model.fair_spread;
    chk('and the absence moves it by the trained primary-quarterback effect', Math.abs(moved) > 2, moved);
    console.log('       (' + qb.n + ', ' + name + ': ' + (Math.round(moved * 100) / 100) + ' pts)');
  }

  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (_) {}
  finish();
})().catch(e => { chk('the suite ran', false, String(e && e.stack || e).slice(0, 600)); finish(); });
