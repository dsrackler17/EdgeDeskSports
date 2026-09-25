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
  const boot = M.boot({ probe: ['fbP4LoadGuarded', 'fbP4Request', 'fbP4Key'] });
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

  try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch (_) {}
  finish();
})().catch(e => { chk('the suite ran', false, String(e && e.stack || e).slice(0, 600)); finish(); });
