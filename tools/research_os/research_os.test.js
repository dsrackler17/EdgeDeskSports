#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH OS — the pure parts, and the terminal's wiring as text.
   docs/research-os/DESIGN.md

     1  the research context: canonical ids (never team names), each feature's
        own link for the game, recently viewed, the desk's screen
     2  "changed since your last visit": a persisted reference, quotes compared
        only from the same book and market, the session roll
     3  the Overview: every count from rows, the documented order (a larger
        model–price difference never moves a game up), a difference only
        between the same contract, a model's own caveat carried with it, honest
        states for a failed load and an undeployed layer, escaping
     4  the AI suggestions: each one a question the desk has a route for
     5  search: games, teams, places; accent-blind; no operator page; fast
     6  the shell's map and the Performance page's two records, never combined
     7  app.html: the navigation, the views, the routes, the boot landing, the
        script order the modules depend on, the evidence names

   The browser half is tools/research_os/journey.e2e.js.
   Run: node tools/research_os/research_os.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const G = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const CX = require(path.join(ROOT, 'lib', 'edgedesk_context.js'));
const OV = require(path.join(ROOT, 'lib', 'edgedesk_overview.js'));
const SR = require(path.join(ROOT, 'lib', 'edgedesk_search.js'));
const SH = require(path.join(ROOT, 'lib', 'edgedesk_shell.js'));
const PH = require(path.join(ROOT, 'lib', 'edgedesk_perf_hub.js'));
const PERSONAL = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const F = require(path.join(ROOT, 'tools', 'slate', 'fixtures', 'slate_fixture.js'));
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const ZONE = 'America/Chicago';

(async function main() {
  const built = await F.buildFixture();
  const SNAP = built.snap, NOW = F.NOW;
  const EVENTS = SNAP.events.concat(SNAP.upcoming || []);
  const byId = {}; EVENTS.forEach((e) => { byId[e.id] = e; });

  /* ====================================================================== */
  /* 1. THE RESEARCH CONTEXT                                                */
  /* ====================================================================== */
  const den = byId['nfl:espn:401880001'], mtsu = byId['cfb:espn:401871067'], cbj = byId['nhl:espn:401802002'];
  const cDen = CX.fromSlateEvent(den), cMtsu = CX.fromSlateEvent(mtsu), cCbj = CX.fromSlateEvent(cbj);
  eq('a slate game carries the slate id and the research key', [cDen.gameId, cDen.researchKey, cDen.module, cDen.entity], ['nfl:espn:401880001', 'nfl|2026_06_SEA_DEN', 'football', 'nfl|2026_06_SEA_DEN']);
  eq('the key of "the same game" is the research key where there is one', CX.keyOf(cDen), 'nfl|2026_06_SEA_DEN');
  eq('and the slate id where there is not', CX.keyOf(cCbj), 'nhl:espn:401802002');
  const lDen = CX.links(cDen, { simSports: { nfl: 1, nhl: 1 } });
  eq('football: the game page, Signals, Foresight and the Simulator, each by the game\'s own ids', lDen,
    { research: '#research/football/nfl%7C2026_06_SEA_DEN', game: '#game/nfl/2026_06_SEA_DEN', signals: '#signals/nfl', foresight: '#foresight/game/nfl%3A2026_06_SEA_DEN', simulator: '#simulator/nfl' });
  const lMtsu = CX.links(cMtsu, { simSports: { nfl: 1 } });
  eq('college football: the same, keyed by the ESPN id the ledgers use', [lMtsu.game, lMtsu.foresight], ['#game/cfb/401871067', '#foresight/game/cfb%3A401871067']);
  chk('and no Simulator link where the Simulator does not list the sport', lMtsu.simulator === null);
  const lCbj = CX.links(cCbj, { simSports: { nhl: 1 } });
  eq('NHL: its Research panel on the game, Signals, the Simulator; never Foresight (NFL and CFB only)', lCbj,
    { research: '#research/nhl/2026020091', game: null, signals: '#signals/nhl', foresight: null, simulator: '#simulator/nhl' });
  const renamed = JSON.parse(JSON.stringify(den)); renamed.home.name = 'Some Other Club'; renamed.away.name = 'Another Club';
  eq('links never depend on team names', CX.links(CX.fromSlateEvent(renamed), { simSports: { nfl: 1, nhl: 1 } }), lDen);
  eq('the UFC slate sport maps to the Simulator\'s ufc key', CX.links({ sport: 'mma', module: 'ufc' }, { simSports: { ufc: 1 } }).simulator, '#simulator/ufc');
  eq('a game opened by its research key (the game page)', CX.fromResearchKey('p4|401871067', { home: 'H', away: 'A' }).researchKey, 'cfb|401871067');
  eq('the desk is handed the odds key and the card\'s own id (football)', CX.screenOf(cDen), { sport: 'americanfootball_nfl', game_id: '2026_06_SEA_DEN', home: 'Denver Broncos', away: 'Seattle Seahawks', market: null });
  eq('and the research entity elsewhere (NHL)', CX.screenOf(cCbj).game_id, '2026020091');
  chk('a context holds identifiers and labels only: no price, no model number, no account', Object.keys(cDen).every((k) => ['sport', 'gameId', 'researchKey', 'module', 'entity', 'season', 'home', 'away', 'start', 'marketType', 'marketSide', 'selectedModel', 'researchTimestamp'].indexOf(k) >= 0));
  let rec = [];
  for (let i = 0; i < 15; i++) rec = CX.recentAdd(rec, { sport: 'nhl', gameId: 'nhl:espn:' + i, home: 'H' + i, away: 'A' + i }, NOW + i);
  rec = CX.recentAdd(rec, { sport: 'nhl', gameId: 'nhl:espn:5' }, NOW + 99);
  chk('recently viewed: newest first, one row per game, at most ' + CX.RECENT_MAX, rec.length === CX.RECENT_MAX && rec[0].key === 'nhl:espn:5' && rec.filter((x) => x.key === 'nhl:espn:5').length === 1);
  chk('and a game long over drops out', CX.recentPrune([{ key: 'a', start: new Date(NOW - 5 * 864e5).toISOString() }, { key: 'b', start: new Date(NOW).toISOString() }], NOW).map((x) => x.key).join() === 'b');

  /* ====================================================================== */
  /* 2. CHANGED SINCE THE LAST VISIT                                        */
  /* ====================================================================== */
  const M0 = JSON.parse(JSON.stringify(SNAP.markets));
  const before = CX.snapshotOf(EVENTS, M0, NOW - 3600e3);
  chk('a game with no change reports none', Object.keys(CX.diff(before, CX.snapshotOf(EVENTS, M0, NOW))).length === 0);
  const M0b = JSON.parse(JSON.stringify(M0)); M0b['nfl:espn:401880001'].spread.home.point -= 1;
  chk('a different number under the SAME capture time is not called movement (one observation cannot move)', !CX.diff(before, CX.snapshotOf(EVENTS, M0b, NOW))['nfl:espn:401880001']);
  const M1 = JSON.parse(JSON.stringify(M0)), E1 = JSON.parse(JSON.stringify(EVENTS));
  const denMk = M1['nfl:espn:401880001'];
  denMk.captured_at = new Date(NOW + 60000).toISOString(); denMk.spread.home.point = denMk.spread.home.point - 1;
  const gb = M1['ncaam:espn:401910002']; gb.captured_at = new Date(NOW + 60000).toISOString(); gb.book = 'Another Book'; if (gb.spread) gb.spread.home.point += 2;
  E1.filter((e) => e.id === 'cfb:espn:401871067')[0].research.model.fair.spread_home = -11.5;
  E1.filter((e) => e.id === 'nhl:espn:401802004')[0].status = 'POSTPONED';
  const M2 = Object.assign({}, M1, { 'mlb:espn:401803002': null });
  const ch = CX.diff(before, CX.snapshotOf(E1, M2, NOW));
  const k = (id) => (ch[id] || []).map((c) => c.kind + (c.comparable ? '' : '!'));
  eq('the same book\'s spread moved: compared, with both capture times', k('nfl:espn:401880001'), ['quote_spread']);
  chk('and the comparison names both observations', ch['nfl:espn:401880001'][0].from_at !== ch['nfl:espn:401880001'][0].to_at && !!ch['nfl:espn:401880001'][0].book);
  eq('a different book is never read as movement', k('ncaam:espn:401910002'), ['quote_book_changed!']);
  eq('EdgeDesk\'s own fair line moved', k('cfb:espn:401871067'), ['model_spread']);
  eq('a status change is reported', k('nhl:espn:401802004'), ['status']);
  chk('a price that disappeared is not invented as a change', !ch['mlb:espn:401803002']);
  const fresh = CX.snapshotOf(E1, M1, NOW); delete fresh.games['nfl:espn:401880001'].mk;
  const M3 = JSON.parse(JSON.stringify(M1));
  chk('a price captured where none was is listed, and never as comparable movement', (CX.diff(CX.snapshotOf(E1, Object.assign({}, M1, { 'nfl:espn:401880001': null }), NOW), CX.snapshotOf(E1, M3, NOW))['nfl:espn:401880001'] || []).every((c) => c.kind === 'quote_new' && !c.comparable));
  chk('a game the reference never held has no "before"', !CX.diff({ games: {} }, CX.snapshotOf(E1, M1, NOW))['nfl:espn:401880001']);
  const A = { at: 'a' }, B = { at: 'b' }, Cc = { at: 'c' };
  eq('a new browser session takes the previous session\'s last snapshot as its reference', CX.visitRoll({ ref: A, next: B }, Cc, false), { ref: B, next: Cc });
  eq('within a session the reference stays put while "next" follows the screen', CX.visitRoll({ ref: A, next: B }, Cc, true), { ref: A, next: Cc });
  eq('a device with nothing stored has no reference (and says so)', CX.visitRoll(null, Cc, false), { ref: null, next: Cc });
  chk('old games leave the stored reference', Object.keys(CX.snapshotPrune({ v: 1, at: 'x', games: { a: { start: new Date(NOW - 3 * 864e5).toISOString() }, b: { start: new Date(NOW).toISOString() } } }, NOW).games).join() === 'b');

  /* ====================================================================== */
  /* 3. THE OVERVIEW                                                        */
  /* ====================================================================== */
  const snapView = { events: EVENTS, markets: SNAP.markets, zone: ZONE, today: G.today(NOW, ZONE), ready: true, generated_at: SNAP.generated_at, freshness: { alerts: [] } };
  const L = OV.lists(snapView, { now: NOW, watch: {}, card: {}, changes: {}, recent: [] });
  const todayIds = L.today.map((r) => r.id);
  chk('Today is the reader\'s calendar day in their zone (Chicago), live games first', L.today[0].group === 'live' && L.today.every((r) => G.dateKey(r.start, ZONE) === G.today(NOW, ZONE)));
  chk('a game after midnight in the reader\'s zone is not Today', todayIds.indexOf('nhl:espn:401802005') < 0 && L.upcoming.map((r) => r.id).indexOf('nhl:espn:401802005') >= 0);
  chk('finished and postponed games come last', (() => { let seen = false; return L.today.every((r) => { const d = r.group === 'final' || r.group === 'off'; if (seen && !d) return false; seen = seen || d; return true; }); })());
  const c0 = L.counts;
  eq('every count is a count of the rows listed', [c0.today, c0.live + c0.upcoming + c0.final + c0.off], [L.today.length, L.today.length]);
  eq('research and model counts come from the rows themselves', [c0.research, c0.model], [L.today.filter((r) => r.research.ok).length, L.today.filter((r) => r.model).length]);
  const rDen = L.byId['nfl:espn:401880001'];
  chk('a model–price difference only between the same contract (full-game home spread, points)', rDen.diff && rDen.diff.kind === 'spread' && rDen.diff.abs === Math.round(Math.abs(rDen.model.spread_home - rDen.market.home_point) * 10) / 10);
  chk('no difference for a sport whose fair line is not in points (NHL moneyline)', L.byId['nhl:espn:401802002'].diff === null);
  chk('a captured price is current only inside the limit, and its capture time is kept', rDen.market.current === true && rDen.market.captured_at === SNAP.markets['nfl:espn:401880001'].captured_at);
  const later = OV.row(den, SNAP.markets['nfl:espn:401880001'], { now: NOW + 3 * 3600e3, zone: ZONE });
  chk('three hours later the same price is a past price, never a current one', later.market.current === false && /past price/.test(OV.rowHTML(later, { now: NOW + 3 * 3600e3, zone: ZONE })));
  /* the order: interest, then completeness, then start — never the size of a difference */
  const mk = (id, o) => Object.assign({ id: id, group: 'upcoming', watched: false, carded: false, completeness: 2, start: NOW + 3600e3, diff: null }, o);
  eq('a game on the watchlist or Card comes first', OV.order([mk('b'), mk('a', { carded: true })]).map((r) => r.id), ['a', 'b']);
  eq('then the more complete research', OV.order([mk('b', { completeness: 1 }), mk('a', { completeness: 3 })]).map((r) => r.id), ['a', 'b']);
  eq('then the earlier start', OV.order([mk('b', { start: NOW + 7200e3 }), mk('a')]).map((r) => r.id), ['a', 'b']);
  eq('a larger model–price difference never moves a game up', OV.order([mk('a', { diff: { abs: 0.5 } }), mk('b', { diff: { abs: 9.5 } })]).map((r) => r.id), ['a', 'b']);
  lacks(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_overview.js'), 'utf8').slice(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_overview.js'), 'utf8').indexOf('O.compare = '), fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_overview.js'), 'utf8').indexOf('O.order = ')), 'diff', 'and the comparator does not read it');
  /* a model's own caveat travels with the comparison */
  const nba = { id: 'nba:espn:1', sport: 'nba', status: 'SCHEDULED', start_utc: new Date(NOW + 3600e3).toISOString(), home: { name: 'Charlotte Hornets', short: 'Hornets' }, away: { name: 'Washington Wizards', short: 'Wizards' },
    research: { module: 'nba', entity: '1', model: { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', fair: { spread_home: -9.5 }, note: 'value claims are off: No licensed archive of timestamped NBA closing prices exists here, so the model has never been compared with the market.' } } };
  const nbaRow = OV.row(nba, { book: 'Draft Kings', captured_at: new Date(NOW - 600e3).toISOString(), spread: { home: { point: -1.5, price: -110 }, away: { point: 1.5, price: -110 } } }, { now: NOW, zone: ZONE });
  has(OV.rowHTML(nbaRow, { now: NOW, zone: ZONE }), 'model not tested against the market', 'a model whose value claims are off says so beside its difference with a price');
  /* honest states */
  const empty = OV.lists({ events: [], markets: {}, zone: ZONE, today: G.today(NOW, ZONE), ready: false, freshness: { alerts: [] } }, { now: NOW });
  has(OV.queueHTML(empty, 'today', { now: NOW, ready: false, loading: false }), 'This is not an empty slate', 'a schedule that failed to load is never presented as an empty day');
  has(OV.queueHTML(empty, 'today', { now: NOW, ready: false, loading: true }), 'Loading the schedule', 'and a schedule still loading says so');
  const sum = (sig) => OV.summaryHTML(L, snapView, { signals: sig, watch: { state: 'signed_out' } }, NOW);
  has(sum({ state: 'not_deployed' }), 'Signal Center is not deployed yet', 'an undeployed Signal Center is "not live", never a zero');
  has(sum({ state: 'shadow' }), 'In review', 'shadow mode is "in review" for a reader');
  has(sum({ state: 'ok', published: 7, major: 2 }), '>7<', 'a live Signal Center shows its published count');
  has(sum({ state: 'error' }), 'Could not be read just now', 'a failed read says so');
  has(OV.queueHTML(L, 'changed', { now: NOW }), 'no earlier visit to compare with yet', 'with no stored reference, Changed explains when it will have one');
  const xss = JSON.parse(JSON.stringify(den)); xss.home.name = '<img src=x onerror=alert(1)>'; xss.away.name = '"><script>alert(1)</script>';
  const xr = OV.rowHTML(OV.row(xss, null, { now: NOW, zone: ZONE }), { now: NOW, zone: ZONE });
  chk('team names from a feed are escaped', xr.indexOf('<img') < 0 && xr.indexOf('<script') < 0 && xr.indexOf('&lt;img') >= 0);
  has(OV.workspaceHTML({ card: 2, watch: 3, signedIn: true }, L, NOW), 'never records a bet', 'the workspace says a saved game is not a position');
  has(OV.marketHTML(L, null, NOW), 'never presented as a price available now', 'a captured price is never called available');
  has(OV.simHTML({ state: 'not_deployed' }, NOW), 'not deployed', 'an undeployed Simulator says so');
  has(OV.simHTML({ state: 'ok', rows: [{ sport: 'nfl', competition: 'nfl', season: '2026', published_run_id: 'r', published_at: new Date(NOW - 3600e3).toISOString(), n_sims: 100000, model_version: 'm1' }] }, NOW), '100,000 simulated seasons', 'a published run is named with its size, model and time');
  lacks(OV.simHTML({ state: 'ok', rows: [{ sport: 'nfl', published_run_id: 'r', published_at: new Date(NOW).toISOString(), n_sims: 10, model_version: 'm' }] }, NOW), '%', 'and the Overview prints no simulated probability');

  /* ====================================================================== */
  /* 4. THE AI SUGGESTIONS: ONLY ROUTES THE DESK HAS                        */
  /* ====================================================================== */
  const INTEL = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_intel_ui.js'), 'utf8');
  const EX = (INTEL.match(/var EXAMPLES = \[([\s\S]*?)\];/) || ['', ''])[1];
  OV.SUGGEST.forEach((s) => {
    if (s.route === 'personal') chk('"' + s.q + '" goes to the personal desk (EDPersonal.PERSONAL_Q)', PERSONAL.PERSONAL_Q.test(s.q));
    else chk('"' + s.q + '" is one of the research engine\'s own examples', EX.indexOf(s.q) >= 0);
  });
  eq('a signed-out reader is not offered the watchlist question', OV.suggestions({ signedIn: false, nfl: true }).indexOf('What changed in my watchlist today?'), -1);
  eq('the NFL question only when NFL games are ahead', OV.suggestions({ signedIn: true, nfl: false }).filter((q) => /NFL/.test(q)).length, 0);

  /* ====================================================================== */
  /* 5. SEARCH                                                              */
  /* ====================================================================== */
  const simKeys = { nfl: 1, nhl: 1, ufc: 1 };
  const src = { nav: SH.NAV, events: EVENTS, now: NOW, sims: [{ key: 'nfl', label: 'NFL', status: 'ACTIVE' }], watch: [{ game_key: 'cfb|401871067', home: 'Middle Tennessee', away: 'Delaware', changed: true }],
    card: [{ selection: 'Denver Broncos +0.5', home: 'Denver Broncos', away: 'Seattle Seahawks', decision: 'LEAN' }], recent: [],
    sportOf: G.sport, researchTarget: (e) => G.researchTarget(e, 'app'), links: (e) => CX.links(CX.fromSlateEvent(e), { simSports: simKeys }), linksCtx: (c) => CX.links(c, { simSports: simKeys }), when: () => 'Today' };
  const IDX = SR.build(src);
  const top = (q) => SR.match(IDX, q, { now: NOW });
  chk('a matchup finds the game first, opening its research by id', top('seahawks broncos')[0].cat === 'game' && top('seahawks broncos')[0].href === '#research/football/nfl%7C2026_06_SEA_DEN');
  chk('and offers its Foresight record beside it (football)', (top('seahawks broncos')[0].alt || []).some((a) => a.href === '#foresight/game/nfl%3A2026_06_SEA_DEN'));
  chk('a team finds the team, with its next game', top('devils').some((x) => x.cat === 'team' && /New Jersey Devils/.test(x.t)));
  chk('an abbreviation finds the game (CBJ)', top('cbj').some((x) => x.cat === 'game' && x.id === 'nhl:espn:401802002'));
  chk('accent-blind: "montreal" finds Montréal', top('montreal').some((x) => /Montréal/.test(x.t)));
  chk('places: "simulator" finds the Simulator seat and its sports', top('simulator').some((x) => x.href === '#simulator') && top('simulator').some((x) => x.href === '#simulator/nfl'));
  chk('places: "import" finds Portfolio\'s import', top('import').some((x) => x.href === '#portfolio/import'));
  chk('your saved research: the watchlist row, with its change', top('delaware').some((x) => x.cat === 'saved' && /changed since you last looked/.test(x.s)));
  chk('and your Card', top('broncos').some((x) => x.cat === 'saved' && x.href === '#card'));
  chk('an empty or unknown query lists nothing', top('').length === 0 && top('zzqqxx').length === 0);
  chk('no operator page is ever a search result', IDX.every((x) => !/^\/admin|#admin/.test(x.href || '')) && SR.PLACES.every((p) => !/admin|faults|operator/i.test(p.href || '')));
  chk('every place that runs an action has one', SR.PLACES.filter((p) => p.act).every((p) => typeof SR.ACTS[p.act] === 'function'));
  const big = []; for (let i = 0; i < 40; i++) big.push.apply(big, IDX);
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) SR.match(big, 'new york', { now: NOW });
  const perQuery = Number(process.hrtime.bigint() - t0) / 20 / 1e6;
  chk('a query over ' + big.length + ' indexed items answers in well under 50 ms (' + perQuery.toFixed(1) + ' ms)', perQuery < 50);

  /* ====================================================================== */
  /* 6. THE SHELL'S MAP AND PERFORMANCE                                     */
  /* ====================================================================== */
  eq('the navigation, in order', SH.NAV.map((n) => n.v), ['overview', 'research', 'signals', 'foresight', 'simulator', 'card', 'portfolio', 'performance', 'process', 'more']);
  eq('three groups: Research, your workspace, More', SH.GROUPS.map((g) => g.id), ['research', 'workspace', 'more']);
  eq('five seats on a phone\'s bar; the rest in Menu', Object.keys(SH.BAR), ['overview', 'research', 'signals', 'card', 'portfolio']);
  chk('every destination has a deep link', SH.NAV.every((n) => /^#[a-z]/.test(n.hash)));
  /* the default landing: Research for a new account in its first-run window, else the Overview */
  {
    const FR = require(path.join(ROOT, 'lib', 'edgedesk_first_run.js'));
    const T0 = Date.parse('2026-10-26T12:00:00Z'), D = 864e5, at = (days) => ({ created_at: new Date(T0 - days * D).toISOString() });
    eq('a new account (1 day) lands on Research, where the first-run panel is', SH.landing(at(1), null, T0), 'research');
    eq('…until it puts the panel away', SH.landing(at(1), { done_at: '2026-10-26T10:00:00Z' }, T0), 'overview');
    eq('an account past the window (30 days) lands on the Overview', SH.landing(at(30), null, T0), 'overview');
    eq('no user, or no creation time: the Overview', [SH.landing(null, null, T0), SH.landing({}, null, T0)].join(), 'overview,overview');
    /* the same window as lib/edgedesk_first_run.js, on both sides of its edge (its predicate reads the clock) */
    const now = Date.now(), edge = SH.FIRST_RUN_DAYS * D;
    [edge - 3600e3, edge + 3600e3, 2 * D, 20 * D].forEach((age) => {
      const created = new Date(now - age).toISOString();
      eq('the window is the first-run module\'s own (' + Math.round(age / 3600e3) + ' h old)', SH.landing({ created_at: created }, null, now) === 'research', FR._isNew(created));
    });
  }
  chk('a door that is not deployed is told apart from a failure', SH.notDeployed({ status: 404 }) && SH.notDeployed({ status: 400, body: '{"code":"PGRST202","message":"Could not find the function"}' }) && !SH.notDeployed({ status: 500, body: 'boom' }));
  let calls = 0;
  const memoP = Promise.all([SH.memo('t', 1000, () => { calls++; return 1; }), SH.memo('t', 1000, () => { calls++; return 2; })]);
  const memoV = await memoP;
  chk('identical reads in flight are made once', calls === 1 && memoV[0] === 1 && memoV[1] === 1);
  const PERF = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance', 'data', 'summary.json'), 'utf8'));
  const rows = PH.modelRows(PERF);
  chk('the model record: one row per sport from the ledger\'s own summary', rows.length === Object.keys(PERF.by_sport).length);
  chk('nothing printed under the ledger\'s min_n', rows.filter((r) => r.n < PERF.min_n).every((r) => r.pct === null && r.brier === null));
  const mh = PH.modelHTML(PERF, null, Date.now());
  has(mh, 'Accuracy is not profit', 'the model record says accuracy is not profit');
  const yours = PH.mineHTML('ok', { settled: { n: 12, wins: 7, losses: 5, pnl: '84.10', staked: '1200', roi: '0.0701' }, process: { graded: 0 } });
  has(yours, 'Nothing EdgeDesk simulated or recommended is counted here', 'your record never counts EdgeDesk\'s results');
  has(yours, 'not a realised result', 'and says closing-line value is not a realised result');
  lacks(yours, 'Brier', 'and carries no model metric');
  has(PH.mineHTML('signed_out'), 'Sign in', 'signed out, it asks for a sign-in instead of showing anything');

  /* ====================================================================== */
  /* 7. THE TERMINAL'S WIRING                                               */
  /* ====================================================================== */
  const NAVM = APP.slice(APP.indexOf('<nav class="bottomnav"'), APP.indexOf('</nav>', APP.indexOf('<nav class="bottomnav"'))).replace(/<!--[\s\S]*?-->/g, '');
  eq('the markup holds the same destinations as the shell\'s map, in order', (NAVM.match(/data-v="([a-z]+)"/g) || []).map((s) => s.slice(8, -1)), SH.NAV.map((n) => n.v));
  SH.NAV.forEach((n) => {
    chk('#' + n.v + ' is a view the router can open', APP.indexOf('id="v-' + n.v + '"') >= 0 || n.v === 'research');
    chk(n.hash + ' routes', n.v === 'research' || new RegExp('NAV_HASH_MAP=\\{[^}]*\\b' + n.v + ":'" + n.v + "'").test(APP));
  });
  has(APP, "var NAV_PRIMARY={overview:1,signals:1,research:1,foresight:1,card:1,portfolio:1,performance:1,process:1,simulator:1};", 'every destination may be the remembered tab');
  has(APP, "else if(_fresh){edLandDefault();}", 'a reader with nothing saved starts where EDShell.landing says (the Overview, or Research in the first-run window)');
  has(APP, "if(window.EDShell&&EDShell.landing)to=EDShell.landing(edUser(),fr,Date.now());", 'the landing asks the shell\'s rule with the session user and the device\'s first-run state');
  has(APP, "defaultTab:'overview'", 'and the default landing page is the Overview');
  has(APP, "if(h==='#research'){researchGo(", 'a bare #research (a bookmark from when Research was the landing page) still opens Research');
  has(APP, "var navs=document.querySelectorAll('.bottomnav button[data-v]');", 'only seats are bound as seats (Menu and Close belong to the shell)');
  has(APP, "if(v==='overview'){try{if(window.EDOverview)window.EDOverview.open($('overviewHost'));}", 'show(\'overview\') opens the Overview');
  has(APP, 'record:\'performance\'', 'Record (EdgeDesk\'s model performance) lights Performance, never the reader\'s Portfolio');
  /* script order: the shell's modules load before the boot block that shows the Overview */
  const iBoot = APP.indexOf("else if(_fresh){edLandDefault();}");
  chk('the boot landing is found', iBoot > 0);
  ['edgedesk_games.js?', 'edgedesk_games_ui.js?', 'edgedesk_context.js?', 'edgedesk_shell.js?', 'edgedesk_overview.js?', 'edgedesk_search.js?', 'edgedesk_perf_hub.js?', '/foresight/service.js?'].forEach((f) => {
    const i = APP.indexOf(f); chk(f.replace('?', '') + ' loads before the boot landing runs', i > 0 && i < iBoot);
  });
  chk('the context and the shell load before the modules that use them', APP.indexOf('edgedesk_context.js?') < APP.indexOf('edgedesk_overview.js?') && APP.indexOf('edgedesk_shell.js?') < APP.indexOf('edgedesk_search.js?') && APP.indexOf('edgedesk_shell.js?') < APP.indexOf('/foresight/service.js?'));
  chk('the slate module the Overview reads loads before it', APP.indexOf('edgedesk_games_ui.js?') < APP.indexOf('edgedesk_overview.js?'));
  chk('each new script is loaded exactly once', ['edgedesk_context.js?', 'edgedesk_shell.js?', 'edgedesk_overview.js?', 'edgedesk_search.js?', 'edgedesk_perf_hub.js?', '/foresight/service.js?', 'edgedesk_shell.css?'].every((f) => APP.split(f).length === 2));
  lacks(APP, '<script src="/foresight/foresight.js', 'the record\'s controller is not loaded at boot (it loads on first use)');
  const TRACK = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_track.js'), 'utf8'), FUN = fs.readFileSync(path.join(ROOT, 'supabase', 'funnel.sql'), 'utf8'), MIG = fs.readFileSync(path.join(ROOT, 'supabase', 'research_os.sql'), 'utf8');
  ['overview', 'foresight', 'performance', 'simulator'].forEach((v) => {
    chk('primary_nav_' + v + ' is accepted by the client, the funnel and the migration', TRACK.indexOf("'primary_nav_" + v + "'") >= 0 && FUN.indexOf("('primary_nav_" + v + "'") >= 0 && MIG.indexOf("('primary_nav_" + v + "'") >= 0);
  });
  chk('the migration file and its mirror are identical', MIG === fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261026120000_research_os.sql'), 'utf8'));
  lacks(MIG.replace(/--[^\n]*/g, ''), 'create table', 'the migration creates no table');
  lacks(MIG.replace(/--[^\n]*/g, ''), 'policy', 'and touches no policy');
  /* the game page's workspace: by the game's ids, never a duplicate of a document-wide hook */
  const WS = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_workspace_ui.js'), 'utf8');
  const RAIL = CX.railHTML(cDen, { simSports: { nfl: 1 } });
  chk('the rail\'s actions use their own attributes (data-ws-card belongs to the workspace\'s document-wide handler)', !/data-ws-/.test(RAIL) && /data-gw-card/.test(RAIL) && /\[data-ws-card\]/.test(WS));
  chk('the rail links each feature by the game\'s ids', RAIL.indexOf('#signals/nfl') >= 0 && RAIL.indexOf('#simulator/nfl') >= 0);
  has(RAIL, 'Saving never records a bet', 'and says saving is not a bet');
  chk('a season simulation is never offered as a single-game price', /not a price for this single game/.test(RAIL));
  has(CX.railHTML(cCbj, {}), 'covers NFL and college football pregame markets only', 'the NHL rail says Foresight does not cover it, rather than linking to nothing');

  /* ------------------------------------------------------------------ */
  console.log(failures.length ? failures.map((f) => '  FAIL ' + f).join('\n') : '');
  console.log((fail ? 'FAIL' : 'PASS') + ' | research OS (context, overview, search, shell, performance, wiring) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
