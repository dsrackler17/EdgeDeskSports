#!/usr/bin/env node
/* ===========================================================================
   THE LANDING PAGE'S #model DEMO — real games, the way subscribers see them.

   lib/edgedesk_home_model.js draws up to three of the week's real games from
   football/game_research/landing.json with the research page's own code. What
   these checks hold:

     1  THE FILE      landing.json is current.json's own snapshots, unchanged,
                      each with probabilities.json's own sheet; a sample, not
                      the slate; built by tools/football/build_game_research.js
                      landingFor (featured games, one per league first, then
                      priority; the soonest fully checked games with none)
     2  THE PICK      only games before kickoff, with a projection and a sheet
     3  THE WORDS     the three levels restate the snapshot (no number of their
                      own), and what the model does not know is said plainly
     4  YOUR NUMBER   the price check IS the research page's (GS.comparePrice):
                      same probability, EV only on a CALIBRATED market, the
                      user-entered label, and bad input refused with a reason
     5  THE RECORD    the season's graded count is the public record's own sum
     6  THE COPY      nothing the demo can print is a pick word or a promise

   Run: node tools/presentation/landing_model.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const HM = require(path.join(ROOT, 'lib', 'edgedesk_home_model.js'));
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const BGR = require(path.join(ROOT, 'tools', 'football', 'build_game_research.js'));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const clone = (x) => JSON.parse(JSON.stringify(x));

const L = read('football/game_research/landing.json');
const CUR = read('football/game_research/current.json');
const PROB = read('football/game_research/probabilities.json');

/* ======================================================================== */
/* 1. THE FILE                                                              */
/* ======================================================================== */
chk('landing.json is the landing schema, with games', L.schema === BGR.LANDING_SCHEMA && Array.isArray(L.games) && L.games.length >= 1);
chk('a sample: at most ' + BGR.LANDING_GAMES + ' games', L.games.length <= BGR.LANDING_GAMES, L.games.length);
const byKey = {};
CUR.games.forEach((g) => { byKey[g.game_key] = g; });
const modelOnly = (s) => { const o = Object.assign({}, s); delete o.consensus; return o; };
chk('every game is current.json\'s own snapshot, unchanged but for its market line (the free page is model only)', L.games.every((g) => byKey[g.game_key] && JSON.stringify(modelOnly(byKey[g.game_key])) === JSON.stringify(g.snapshot) && !('consensus' in g.snapshot)),
  L.games.filter((g) => !byKey[g.game_key] || JSON.stringify(modelOnly(byKey[g.game_key])) !== JSON.stringify(g.snapshot)).map((g) => g.game_key));
chk('every sheet is probabilities.json\'s own, built from that snapshot', L.games.every((g) => JSON.stringify(PROB.sheets[g.game_key]) === JSON.stringify(g.sheet) && GS.sheetMatches(g.snapshot, g.sheet)));
chk('every snapshot\'s id is the hash of its content', L.games.every((g) => GS.snapshotId(g.snapshot) === g.snapshot.snapshot_id));
chk('the calibration block for each league shown is the sheet file\'s own', L.games.every((g) => JSON.stringify(L.models[g.snapshot.league]) === JSON.stringify(PROB.models[g.snapshot.league])));
chk('the counts are current.json\'s', L.counts.games === CUR.counts.games && L.counts.model_available === CUR.counts.model_available);
chk('no sportsbook price is in the file (Layer A only)', !/"(?:market_state|reference_market|quotes_h2h|best_price|book)"\s*:/.test(JSON.stringify(L)));

/* landingFor on synthetic slates: the selection rule */
{
  const NOW = Date.parse('2026-10-16T12:00:00Z');
  const base = CUR.games.find((g) => g.model.available && g.probability_sheet === 'MATCHED');
  function game(league, id, kickoff, opts) {
    const s = clone(base); s.league = league; s.game_id = id; s.game_key = league + '|' + id; s.kickoff = kickoff;
    s.started = !!(opts && opts.started); s.data = Object.assign({}, s.data, { status: (opts && opts.status) || 'OK' });
    s.probability_sheet = (opts && opts.sheet === false) ? 'NONE' : 'MATCHED';
    return s;
  }
  const later = '2026-10-18T00:00:00Z', soon = '2026-10-17T00:00:00Z', past = '2026-10-15T00:00:00Z';
  const games = [game('nfl', 'N1', later), game('nfl', 'N2', later), game('cfb', 'C1', later), game('cfb', 'C2', soon), game('cfb', 'C3', past, { started: true }),
    game('cfb', 'C4', later, { status: 'FAULT' }), game('nfl', 'N3', later, { sheet: false })];
  const cur = { generated_at: '2026-10-16T11:00:00Z', counts: { games: 7, nfl: 3, cfb: 4, model_available: 7, started: 1 }, games };
  const probs = { models: { nfl: { m: 1 }, cfb: { m: 2 } }, sheets: {} };
  games.forEach((g) => { if (g.probability_sheet === 'MATCHED') probs.sheets[g.game_key] = { s: g.game_key }; });
  const feat = (list) => ({ games: list.map(([k, p]) => ({ status: 'featured', key: k.toUpperCase().replace('|', ':'), sport: k.split('|')[0].toUpperCase(), game_id: k.split('|')[1], editorial_priority: p, window_label: 'Saturday night' })) });
  const a = BGR.landingFor(cur, probs, feat([['cfb|C1', 90], ['cfb|C2', 80], ['nfl|N2', 50], ['nfl|N1', 40]]), NOW);
  chk('featured games: one per league first (the NFL, then college), then by editorial priority', JSON.stringify(a.games.map((g) => g.game_key)) === JSON.stringify(['nfl|N2', 'cfb|C1', 'cfb|C2']), a.games.map((g) => g.game_key));
  chk('each says why it was chosen', a.games.every((g) => /featured by EdgeDesk’s editorial desk this week \(Saturday night\)/.test(g.chosen_because)));
  const b = BGR.landingFor(cur, probs, feat([['cfb|C3', 99], ['cfb|C4', 98], ['nfl|N3', 97], ['nfl|N1', 10]]), NOW);
  chk('a started game, a data fault and a game without a matched sheet are never shown', JSON.stringify(b.games.map((g) => g.game_key)) === JSON.stringify(['nfl|N1']), b.games.map((g) => g.game_key));
  const c = BGR.landingFor(cur, probs, { games: [] }, NOW);
  chk('with nothing featured: the soonest fully checked games, and it says so', c.games.length === 3 && c.games[0].game_key === 'cfb|C2' && c.games.every((g) => /next game with a full data check/.test(g.chosen_because)), c.games.map((g) => g.game_key));
  chk('the calibration blocks are only for the leagues shown', JSON.stringify(Object.keys(b.models)) === JSON.stringify(['nfl']));
  chk('never more than ' + BGR.LANDING_GAMES, BGR.landingFor(cur, probs, feat([['cfb|C1', 9], ['cfb|C2', 8], ['nfl|N1', 7], ['nfl|N2', 6]]), NOW).games.length === BGR.LANDING_GAMES);
}

/* ======================================================================== */
/* 2. THE PICK                                                              */
/* ======================================================================== */
const first = Math.min.apply(null, L.games.map((g) => Date.parse(g.snapshot.kickoff)));
chk('before any kickoff every game is shown', HM.pick(L, first - 3600e3).length === L.games.length);
chk('after every kickoff none is', HM.pick(L, Date.now() + 400 * 864e5).length === 0);
{
  const L2 = clone(L); L2.games[0].snapshot.model.available = false;
  chk('a game without a projection is never shown', HM.pick(L2, first - 3600e3).length === L.games.length - 1);
  const L3 = clone(L); delete L3.games[0].sheet;
  chk('nor one without its sheet', HM.pick(L3, first - 3600e3).length === L.games.length - 1);
  chk('an empty or broken file shows nothing', HM.pick(null, 0).length === 0 && HM.pick({ games: [] }, 0).length === 0);
}

/* ======================================================================== */
/* 3. THE WORDS                                                             */
/* ======================================================================== */
L.games.forEach((g) => {
  const v = HM.view(g, L.models), s = g.snapshot, M = s.model, row = (k) => (v.rows.find((r) => r[0] === k) || [])[1] || '';
  const tag = ' · ' + g.game_key;
  chk('Beginner is the research page\'s own words' + tag, JSON.stringify(v.beginner) === JSON.stringify(GS.beginner(s)));
  /* the display block (lib/edgedesk_football_lines.js) when the snapshot has one */
  const D = M.display, sc = D ? D.score : (M.headline_scores || M.scores);
  chk('the projected score is the snapshot\'s' + tag, row('Projected score') === s.away.name + ' ' + sc.away + ', ' + s.home.name + ' ' + sc.home, row('Projected score'));
  chk('the fair spread is the snapshot\'s, on its favourite' + tag, D ? row('Fair spread') === D.spread.text : (!M.fair.favorite || row('Fair spread') === s[M.fair.favorite].name + ' −' + Math.abs(M.fair.display).toFixed(1)), row('Fair spread'));
  chk('the fair total is the snapshot\'s' + tag, row('Fair total') === (D ? D.total.text : M.total.toFixed(1)));
  chk('the chance to win is the snapshot\'s display' + tag, row('Chance to win').indexOf(M.win_display.home) >= 0 && row('Chance to win').indexOf(M.win_display.away) >= 0);
  chk('the model moneyline is labelled an estimate, not a price' + tag, /\(an estimate, not a price\)$/.test(row('Model moneyline')));
  chk('what to watch for is the snapshot\'s insights' + tag, JSON.stringify(v.watch) === JSON.stringify((s.insights || []).slice(0, 4).map((i) => ({ title: i.title, text: i.text }))));
  chk('the Lab names the model, the snapshot and each market\'s calibration status' + tag, v.lab.some((r) => r[0] === 'Snapshot' && r[1].indexOf(s.snapshot_id) === 0)
    && v.lab.some((r) => r[0] === 'Spread probabilities' && r[1].indexOf(String(g.sheet.markets.spread.status).toLowerCase()) === 0));
  chk('the subtitle is words, never an object' + tag, typeof v.sub === 'string' && !/\[object/.test(v.sub) && v.sub.indexOf(s.league === 'nfl' ? 'NFL' : 'College football') === 0, v.sub);
});
{
  const s = clone(L.games[0].snapshot);
  s.qb = { home: null, away: { name: 'A Passer', confirmed: false, contested: false, basis: 'started the last game' } };
  s.risks = [{ severity: 'moderate', text: 'Home: availability not due yet — the conference requires a report 48 hours before k.' }];
  s.weather = null; s.league = 'nfl';
  const u = HM.unknowns(s);
  chk('an unnamed starter is said plainly, with what the projection carries instead', u.some((x) => /: no starting quarterback named for this game yet; the projection carries the team’s usual level\./.test(x)), u);
  chk('a carried starter is named as carried, not confirmed', u.some((x) => /A Passer is carried as the starter \(started the last game\), not confirmed\./.test(x)), u);
  chk('a flagged risk keeps only its first clause (the detail is on the research page)', u.indexOf('Home: availability not due yet.') >= 0, u);
  chk('an NFL game with no forecast says so', u.some((x) => /No game-day forecast/.test(x)));
  chk('at most four', u.length <= 4);
  s.qb = { home: { name: 'X', confirmed: true }, away: { name: 'Y', confirmed: true } }; s.risks = []; s.weather = { short: 'clear' };
  chk('a game with confirmed starters, no flags and a forecast lists nothing', HM.unknowns(s).length === 0);
}

/* ======================================================================== */
/* 4. YOUR NUMBER: the research page's price check, exactly                 */
/* ======================================================================== */
L.games.forEach((g) => {
  const s = g.snapshot, M = s.model, model = L.models[s.league], v = HM.view(g, L.models), half = (x) => Math.round(x * 2) / 2;
  const entries = [
    { market: 'spread', side: 'home', line: half(M.fair.home_line), american: -110 },
    { market: 'total', side: 'over', line: half(M.total), american: -105 },
    { market: 'moneyline', side: 'away', line: null, american: 150 }
  ];
  entries.forEach((en) => {
    const a = HM.compare(g, L.models, en), b = GS.comparePrice(s, g.sheet, model, en, FL);
    const tag = ' · ' + g.game_key + ' ' + en.market;
    chk('the probability is GS.comparePrice\'s' + tag, a.ok && b.ok && a.model_prob === b.model_prob && a.implied === b.implied && a.prob_diff === b.prob_diff, [a.errors, b.errors]);
    const w = HM.compareWords(a, v, en);
    const status = (g.sheet.markets[en.market] || {}).status;
    chk('EV is printed only for a CALIBRATED market' + tag, (status === 'CALIBRATED') === w.rows.some((r) => /^Expected value/.test(r[0])) && (status === 'CALIBRATED' || /not shown/.test(w.withheld)), [status, w.rows.map((r) => r[0])]);
    chk('the research page\'s closing line is left to this page\'s own footer' + tag, !w.notes.some((n) => /^Research and decision support only/.test(n)));
    chk('the typed price is restated with its side' + tag, /at [−+]\d+$/.test(w.rows[0][1]), w.rows[0]);
  });
  const bad = HM.compareWords(HM.compare(g, L.models, { market: 'spread', side: 'home', line: -3.25, american: 50 }), v, {});
  chk('bad odds and a quarter line are refused, with the reasons · ' + g.game_key, !bad.ok && /American odds/.test(bad.text) && /half points/.test(bad.text), bad.text);
});
chk('the result carries the user-entered label', HM.compare(L.games[0], L.models, { market: 'moneyline', side: 'home', american: -120 }).label === GS.USER_PRICE_LABEL);

/* ======================================================================== */
/* 5. THE RECORD                                                            */
/* ======================================================================== */
{
  const R = read('record/football/summary.json');
  const want = Object.keys(R.sports).reduce((n, k) => n + (R.sports[k].counts.graded || 0), 0);
  const g = HM.graded(R);
  chk('the graded count is the public record\'s own sum, per season', g && g.n === want && g.season === R.season, [g, want]);
  chk('no record, no count', HM.graded(null) === null && HM.graded({ sports: {} }) === null && HM.graded({ sports: { nfl: { counts: { graded: 0 } } } }) === null);
}

/* ======================================================================== */
/* 6. THE COPY                                                              */
/* ======================================================================== */
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_home_model.js'), 'utf8');
  const strings = [...src.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)].map((m) => m[1]).filter((t) => /[a-z] [a-z]/i.test(t));
  [/\block/i, /\bguarantee/i, /\bBET\b/, /\bPICK\b/, /\bbest bet\b/i, /\bsure thing\b/i, /\bfree money\b/i, /\bhammer\b/i, /\btail\b/i]
    .forEach((re) => chk('nothing the demo prints says ' + re, !strings.some((t) => re.test(t)), strings.filter((t) => re.test(t)).slice(0, 2)));
  chk('it says the numbers are EdgeDesk’s own and no sportsbook price is read', /No sportsbook price is read or shown here\./.test(src));
  chk('a typed price is never stored or sent', /Nothing you type is stored or sent\./.test(src) && !/localStorage|sessionStorage/.test(src));
}

console.log('');
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('\nlanding model demo: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
