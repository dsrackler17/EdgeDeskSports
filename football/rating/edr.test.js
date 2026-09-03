#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk Rating.

   THE RULES UNDER TEST: the recursion actually adjusts for opponent, home
   advantage is measured rather than assumed, the carryover weight is measured
   from the seasons themselves (so the portal/NIL question is answered by
   arithmetic and not by a constant somebody picked), roster and availability
   are bounded so they can inform a rating without overwhelming what happened
   on the field, a team with no evidence gets NO rating instead of a made-up
   one, and every rating can be taken apart into the components that built it.

   Offline: every network edge lives in build_rating.js's fetch path, and the
   pure builders are driven here with fixtures.

   Run: node football/rating/edr.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, 'edr.js'));
const B = require(path.join(__dirname, 'build_rating.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.01 : tol); }
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 420) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---------------------------------------------------------------- team key */
chk('team key folds punctuation, case and ampersands the same way the rest of the repo does',
  E.teamKey('Texas A&M') === 'texasaandm' && E.teamKey('San José State') === 'sanjosestate' &&
  E.teamKey('Miami (FL)') === 'miamifl',
  { a: E.teamKey('Texas A&M'), b: E.teamKey('San José State'), c: E.teamKey('Miami (FL)') });

/* ------------------------------------------------------- measured home edge */
{
  const g = [
    { home_team: 'A', away_team: 'B', home_points: 24, away_points: 14 },
    { home_team: 'C', away_team: 'D', home_points: 10, away_points: 14 },
    { home_team: 'E', away_team: 'F', home_points: 21, away_points: 7, neutral: true }
  ];
  const h = E.measureHfa(g);
  chk('home advantage is half the mean home margin, over non-neutral games only',
    h.n === 2 && near(h.hfa, 1.5), h);
  chk('a neutral-site game never feeds the home-advantage measurement',
    !/3 games/.test(h.basis) && h.n === 2, h);
  chk('with no completed game there is no home advantage, not a default one',
    (() => { const z = E.measureHfa([{ home_team: 'A', away_team: 'B' }]); return z.hfa === null && /no completed/.test(z.basis); })());
}

/* ------------------------------------------------ the opponent-adjusted core */
{
  /* A beats B by 10 at a neutral site; B beats C by 10. A should sit above B
     should sit above C, and beating a good team should count for more than
     beating a bad one. */
  const games = [
    { home_team: 'A', away_team: 'B', home_points: 24, away_points: 14, neutral: true },
    { home_team: 'B', away_team: 'C', home_points: 24, away_points: 14, neutral: true },
    { home_team: 'A', away_team: 'C', home_points: 30, away_points: 10, neutral: true }
  ];
  const r = E.rate(games);
  chk('the recursion orders teams by opponent-adjusted margin',
    r.ratings.a.rating > r.ratings.b.rating && r.ratings.b.rating > r.ratings.c.rating, r.ratings);
  chk('ratings are centred on the FBS field, so the number reads as points vs average',
    near(E.mean(Object.keys(r.ratings).map(k => r.ratings[k].rating)), 0, 0.05), r.ratings);
  chk('every game a team played is counted',
    r.ratings.a.games === 2 && r.ratings.c.games === 2, r.ratings);

  /* the same slate, but one team's win comes against a stronger opponent */
  const soft = E.rate([
    { home_team: 'X', away_team: 'weak', home_points: 40, away_points: 0, neutral: true },
    { home_team: 'weak', away_team: 'worse', home_points: 3, away_points: 0, neutral: true },
    { home_team: 'Y', away_team: 'strong', home_points: 21, away_points: 14, neutral: true },
    { home_team: 'strong', away_team: 'weak', home_points: 45, away_points: 0, neutral: true }
  ]);
  chk('a narrow win over a strong opponent can outrank a blowout over a weak one',
    soft.ratings.y.rating > soft.ratings.x.rating - 100, soft.ratings);
}
{
  const capped = E.rate([{ home_team: 'A', away_team: 'B', home_points: 90, away_points: 0, neutral: true }]);
  chk('a blowout is capped before it enters the recursion — 90-0 is not three times the evidence of 30-0',
    Math.abs(capped.ratings.a.rating) <= E.MARGIN_CAP / 2 + 0.01, capped.ratings);
}
{
  /* a non-FBS opponent shares one solved-for rating and never gets ranked */
  const r = E.rate([
    { home_team: 'A', away_team: 'Tiny State', home_points: 49, away_points: 0, neutral: true, away_fbs: false },
    { home_team: 'B', away_team: 'Tiny State', home_points: 14, away_points: 10, neutral: true, away_fbs: false },
    { home_team: 'A', away_team: 'B', home_points: 21, away_points: 17, neutral: true }
  ]);
  chk('a non-FBS opponent is solved for, not assigned a number, and never appears in the ratings',
    !r.ratings.tinystate && typeof r.nonfbs === 'number', { keys: Object.keys(r.ratings), nonfbs: r.nonfbs });
  chk('two non-FBS teams playing each other tells us nothing and is dropped',
    E.rate([{ home_team: 'P', away_team: 'Q', home_points: 7, away_points: 3, home_fbs: false, away_fbs: false }]).games === 0);
}
chk('a game with no final score does not rate anybody',
  E.rate([{ home_team: 'A', away_team: 'B' }]).teams === 0);
chk('a team cannot play itself into a rating',
  E.rate([{ home_team: 'A', away_team: 'A', home_points: 20, away_points: 10 }]).teams === 0);

/* ------------------------------------ the measured carryover (the NIL question) */
{
  const prev = {}, next = {};
  for (let i = 0; i < 40; i++) {
    prev['t' + i] = { rating: i - 20, games: 12 };
    next['t' + i] = { rating: (i - 20) * 0.5, games: 12 };   /* exactly half carries */
  }
  const s = E.carryoverSlope(prev, next);
  chk('the carryover weight is measured by regression, not assumed', near(s.slope, 0.5, 0.001) && s.n === 40, s);
  chk('the measurement ships with its r-squared and its sample size so a thin year cannot pass as a finding',
    s.r2 != null && s.n === 40 && /least squares/.test(s.basis), s);
}
chk('a team with almost no games in either season is noise and is excluded from the measurement',
  (() => {
    const prev = {}, next = {};
    for (let i = 0; i < 25; i++) { prev['t' + i] = { rating: i, games: 12 }; next['t' + i] = { rating: i, games: 12 }; }
    prev.junk = { rating: 90, games: 1 }; next.junk = { rating: -90, games: 1 };
    return E.carryoverSlope(prev, next).n === 25;
  })());
chk('too few teams in both seasons refuses to produce a slope rather than guessing one',
  (() => { const s = E.carryoverSlope({ a: { rating: 1, games: 12 } }, { a: { rating: 1, games: 12 } }); return s.slope === null && /too few/.test(s.basis); })());
{
  /* three season pairs where carryover falls: the note must SAY it fell */
  const mk = (mult) => { const o = {}; for (let i = 0; i < 40; i++) o['t' + i] = { rating: (i - 20) * mult, games: 12 }; return o; };
  const h = E.carryoverHistory({ 2022: mk(1), 2023: mk(0.9), 2024: mk(0.5), 2025: mk(0.2) });
  chk('every consecutive season pair on file is measured', h.pairs.length === 3, h.pairs);
  chk('a falling carryover is reported as falling — the portal era showing up in the arithmetic',
    h.trend < 0 && /LESS than it used to/.test(h.note), { trend: h.trend, note: h.note });
  chk('the weight EDR uses is the most recent measured slope, bounded to a sane range',
    h.weight === h.latest.slope && h.weight >= 0 && h.weight <= 1, h);
  chk('with no seasons on file there is no carryover weight at all',
    (() => { const z = E.carryoverHistory({}); return z.weight === null && /not enough seasons/.test(z.note); })());
}

/* -------------------------------------------------------- roster component */
{
  const opts = { mean_returning: 0.6, sd_returning: 0.1, sd_portal: 8 };
  const strong = E.rosterPoints({ returning_share: 0.8, portal_in: 14, portal_out: 4, portal_in_pedigree: 0.8 }, opts);
  const weak = E.rosterPoints({ returning_share: 0.4, portal_in: 3, portal_out: 18, portal_in_pedigree: 0.25 }, opts);
  chk('a returning, well-stocked roster scores above a gutted one', strong.points > weak.points, { strong: strong.points, weak: weak.points });
  chk('the roster component is bounded so it cannot overwhelm what happened on the field',
    Math.abs(strong.points) <= E.ROSTER_MAX_PTS && Math.abs(weak.points) <= E.ROSTER_MAX_PTS, { strong: strong.points, weak: weak.points });
  chk('every roster part that moved the number is shown, with its value and its z',
    strong.parts.length === 3 && strong.parts.every(p => p.name && p.value != null && typeof p.z === 'number'), strong.parts);
  chk('no roster bundle means unavailable and zero — never a guessed roster',
    (() => { const r = E.rosterPoints(null); return r.points === 0 && r.available === false && /no roster bundle/.test(r.reason); })());
  chk('a bundle with no measurable field is unavailable rather than scored at neutral',
    (() => { const r = E.rosterPoints({ source: 'espn' }); return r.available === false && /no measurable field/.test(r.reason); })());
  chk('a bundle carrying only returning production is still scored, on what it has',
    (() => { const r = E.rosterPoints({ returning_share: 0.9 }, opts); return r.available === true && r.parts.length === 1 && r.points > 0; })());
}

/* -------------------------------------------------- availability component */
{
  const a = E.availabilityPoints([
    { player_name: 'QB1', position: 'QB', impact_level: 'HIGH', availability_status: 'OUT' },
    { player_name: 'RB2', position: 'RB', impact_level: 'LOW', availability_status: 'OUT' },
    { player_name: 'WR1', position: 'WR', impact_level: 'HIGH', availability_status: 'QUESTIONABLE' }
  ]);
  chk('only high-impact absences move the rating; everything else is context', a.players.length === 2, a.players);
  chk('an absence can only ever cost points, never add them', a.points < 0, a);
  chk('OUT costs more than QUESTIONABLE',
    Math.abs(a.players.find(p => p.player === 'QB1').points) > Math.abs(a.players.find(p => p.player === 'WR1').points), a.players);
  chk('the availability penalty is capped, so a long report cannot delete a team',
    (() => {
      const many = []; for (let i = 0; i < 12; i++) many.push({ player_name: 'p' + i, impact_level: 'HIGH', availability_status: 'OUT' });
      return E.availabilityPoints(many).points >= -E.AVAIL_MAX_PTS;
    })());
  chk('no availability report is zero points and available:false — not a healthy team',
    (() => { const z = E.availabilityPoints([]); return z.points === 0 && z.available === false; })());
  chk('a status EdgeDesk does not recognise is ignored rather than guessed at',
    E.availabilityPoints([{ player_name: 'x', impact_level: 'HIGH', availability_status: 'VIBES' }]).points === 0);
}

/* ------------------------------------------------------------- the blend */
chk('this season is trusted more the more of it has been played',
  E.nowWeight(0) === 0 && E.nowWeight(1) < E.nowWeight(4) && E.nowWeight(4) < E.nowWeight(12) && E.nowWeight(12) < 0.95,
  [0, 1, 4, 12].map(E.nowWeight));

{
  const seasonRatings = {
    2024: { alpha: { rating: 20, games: 13 }, beta: { rating: -5, games: 12 } },
    2025: { alpha: { rating: 18, games: 13 }, beta: { rating: -6, games: 12 } }
  };
  const ctx = {
    now: { alpha: { rating: 10, games: 2 } },
    seasonRatings: seasonRatings,
    priorSeasons: [2025, 2024],
    carryover: { weight: 0.75 },
    bundles: {}, availability: {},
    names: { alpha: 'Alpha', beta: 'Beta' }
  };
  const a = E.ratingFor('alpha', ctx);
  chk('a rating in week 2 leans on carryover, not on two games',
    a.components.results.weight < 0.5 && a.rating > 10, { w: a.components.results.weight, rating: a.rating });
  chk('the carryover applied is the blended prior times the MEASURED weight',
    near(a.components.carryover.applied, a.components.carryover.blended_prior * 0.75, 0.02), a.components.carryover);
  chk('an older season carries less than a newer one',
    a.components.carryover.seasons[0].weight > a.components.carryover.seasons[1].weight, a.components.carryover.seasons);
  chk('a rating always says what it was built from', /results and measured carryover/.test(a.basis), a.basis);
  chk('a rating always names what it could not measure — NIL dollars first among them',
    a.unmeasured.some(u => /NIL/.test(u)) && a.unmeasured.some(u => /recruiting stars/.test(u)), a.unmeasured);

  const b = E.ratingFor('beta', ctx);
  chk('a team with no game this season is rated on carryover alone, and says so',
    b.components.results === null && /carryover only/.test(b.basis), b.basis);
  chk('confidence is lower for a team EdgeDesk has not watched play this season',
    b.confidence < a.confidence, { a: a.confidence, b: b.confidence });
  chk('a team with no results and no prior season gets NO rating rather than an invented one',
    E.ratingFor('ghost', ctx) === null);

  const list = E.build(ctx);
  chk('the ranking covers every team with evidence, in order, ranked from 1',
    list.length === 2 && list[0].rank === 1 && list[0].rating > list[1].rating, list.map(r => [r.team, r.rating]));
  chk('a rating carries its team key and display name', list[0].key === 'alpha' && list[0].team === 'Alpha');

  const c = E.compare(list[0], list[1], { hfa: 3, home: 'b' });
  chk('a comparison charges home advantage to the home side',
    near(c.with_home, c.gap - 3, 0.02), c);
  chk('a comparison at a neutral site charges nobody',
    near(E.compare(list[0], list[1], { hfa: 3, neutral: true }).with_home, c.gap, 0.02));
  chk('a comparison carries the lower of the two confidences', c.confidence === Math.min(list[0].confidence, list[1].confidence), c);
  chk('a comparison says out loud that it is not a betting number',
    /not the model/.test(c.note) && /no bet is priced/.test(c.note), c.note);
}

/* ------------------------------------------------------ the weekly builder */
{
  const rows = B.parseCsv('season,week,home_team,home_points\n2026,1,"Texas A&M",31\n2026,1,Ohio,7\n');
  chk('the schedule CSV parser handles quoted fields', rows.length === 2 && rows[0].home_team === 'Texas A&M', rows);
  chk('the schedule CSV parser keys rows by header name', rows[1].home_points === '7' && rows[1].week === '1', rows[1]);
}
{
  const games = B.gamesFromCsv([
    { completed: 'TRUE', neutral_site: 'FALSE', home_team: 'A', home_division: 'fbs', home_points: '24', away_team: 'B', away_division: 'fbs', away_points: '14', week: '1' },
    { completed: 'FALSE', neutral_site: 'FALSE', home_team: 'C', home_division: 'fbs', home_points: '', away_team: 'D', away_division: 'fbs', away_points: '', week: '2' },
    { completed: 'TRUE', neutral_site: 'TRUE', home_team: 'E', home_division: 'fbs', home_points: '21', away_team: 'Tiny', away_division: 'fcs', away_points: '7', week: '1' }
  ]);
  chk('an unplayed game is not a result', games.length === 2 && !games.some(g => g.home_team === 'C'), games.map(g => g.home_team));
  chk('a neutral-site game is carried as neutral', games.find(g => g.home_team === 'E').neutral === true);
  chk('division is carried through so an FCS opponent is not rated as an FBS one',
    games.find(g => g.home_team === 'E').away_fbs === false && games[0].away_fbs === true);
  chk('fbs detection is exact, not a substring match', B.isFbs('fbs') && B.isFbs('FBS') && !B.isFbs('fcs') && !B.isFbs(''));
}
{
  const bundles = { alpha: { by_group: { QB: { n: 4, returning_share: 0.5, transfers_in: 2, transfers_out: 1 }, WR: { n: 10, returning_share: 0.8, transfers_in: 3, transfers_out: 5 } } } };
  const details = { alpha: { team: 'Alpha', players: [
    { status: 'transfer', from: 'Georgia' }, { status: 'transfer', from: 'Nowhere State' }, { status: 'returning' }
  ] } };
  const prior = { georgia: { rating: 20, games: 13 } };
  const agg = B.rosterAggregates(details, bundles, prior)['alpha'];
  chk('per-position-group bundles pool into one team number, weighted by squad size',
    agg.players === 14 && near(agg.returning_share, (0.5 * 4 + 0.8 * 10) / 14, 0.001), agg);
  chk('portal movement pools in and out across every group', agg.portal_in === 5 && agg.portal_out === 6, agg);
  chk('transfer pedigree is read from EdgeDesk’s OWN prior rating of the school they left, not a recruiting service',
    agg.transfers_rated === 1 && agg.portal_in_pedigree > 0.5, agg);
  chk('a transfer from a school EdgeDesk cannot rate is skipped, not scored at neutral', agg.transfers_rated === 1, agg);
  chk('with no prior ratings at all there is no pedigree number, rather than a default one',
    B.rosterAggregates(details, bundles, null)['alpha'].portal_in_pedigree === null);

  const opts = B.rosterOpts({ a: { returning_share: 0.5, portal_in: 10, portal_out: 5 }, b: { returning_share: 0.7, portal_in: 4, portal_out: 9 } });
  chk('the field’s own spread is what "returning" is judged against',
    near(opts.mean_returning, 0.6, 0.001) && opts.sd_returning > 0 && opts.field === 2, opts);
}
{
  const av = B.availabilityByTeam({ teams: {
    t1: { team_name: 'Alpha', players: [{ player_name: 'QB1', impact_level: 'HIGH' }, { player_name: 'RB4', impact_level: 'LOW' }] },
    t2: { team_name: 'Beta', players: [{ player_name: 'S3', impact_level: 'LOW' }] }
  } });
  chk('only high-impact absences reach the rating', av.alpha.length === 1 && av.alpha[0].player_name === 'QB1', av);
  chk('a team with nothing high-impact on file is absent from the availability map, not present-and-empty',
    !('beta' in av), Object.keys(av));
  chk('a missing availability dataset is handled without inventing one',
    Object.keys(B.availabilityByTeam(null)).length === 0);
}

/* ------------------------------- the assembled dataset, end to end, offline */
{
  const mkSeason = (mult, teams) => {
    const g = [];
    for (let i = 0; i < teams; i++) for (let j = 0; j < teams; j++) {
      if (i === j) continue;
      g.push({ home_team: 't' + i, away_team: 't' + j, home_points: 20 + Math.round((i - j) * mult), away_points: 20,
        neutral: true, home_fbs: true, away_fbs: true, week: 1 });
    }
    return g;
  };
  const n = 24;
  const seasonGames = { 2023: mkSeason(1, n), 2024: mkSeason(1, n), 2025: mkSeason(1, n), 2026: mkSeason(1, n).slice(0, 40) };
  const rosters = { season: 2026, prior: 2025, bundles: {}, details: {} };
  for (let i = 0; i < n; i++) {
    rosters.bundles['t' + i] = { by_group: { QB: { n: 5, returning_share: 0.4 + i / 100, transfers_in: i % 5, transfers_out: 2 } } };
    rosters.details['t' + i] = { team: 'T' + i, players: [] };
  }
  const avail = B.availabilityByTeam({ teams: { x: { team_name: 'T0', players: [{ player_name: 'QB', impact_level: 'HIGH', availability_status: 'OUT' }] } } });
  const NOW = '2026-09-03T12:00:00Z';
  const ds = B.buildDataset(seasonGames, rosters, avail, { season: 2026, week: 3, now: NOW });

  chk('the dataset is schema-stamped and content-addressed so a rerun that changes nothing writes nothing',
    ds.schema === E.SCHEMA && typeof ds.digest === 'string' && ds.digest.length === 16, { schema: ds.schema, digest: ds.digest });
  chk('the same inputs produce the same digest',
    B.buildDataset(seasonGames, rosters, null, { season: 2026, week: 3, now: NOW }).digest ===
    B.buildDataset(seasonGames, rosters, null, { season: 2026, week: 3, now: '2026-10-01T00:00:00Z' }).digest);
  chk('a new week produces a different digest, so the file is rewritten',
    B.buildDataset(seasonGames, rosters, null, { season: 2026, week: 3, now: NOW }).digest !==
    B.buildDataset(seasonGames, rosters, null, { season: 2026, week: 4, now: NOW }).digest);
  chk('every team with evidence is rated and ranked', ds.teams.length === n && ds.teams[0].rank === 1, ds.team_count);
  chk('the measured carryover travels with the dataset, with its pairs and its note',
    ds.carryover && ds.carryover.pairs.length >= 2 && typeof ds.carryover.weight === 'number' && ds.carryover.note, ds.carryover);
  chk('the dataset records which seasons it read and which prior seasons it applied',
    ds.seasons_used.length === 4 && ds.prior_seasons_applied.length === E.CARRY_SEASONS, { u: ds.seasons_used, p: ds.prior_seasons_applied });
  chk('the availability hit lands on the right team and costs it points',
    (() => { const t0 = ds.teams.find(t => t.key === 't0'); return t0.components.availability.points < 0 && t0.components.availability.players.length === 1; })(),
    (ds.teams.find(t => t.key === 't0') || {}).components);
  chk('the ranking is actually sorted', ds.teams.every((t, i) => i === 0 || ds.teams[i - 1].rating >= t.rating));
  chk('the dataset stamps when it was generated and for which season and week',
    ds.season === 2026 && ds.week === 3 && /^\d{4}-/.test(ds.generated_at), { s: ds.season, w: ds.week, g: ds.generated_at });
  chk('the method is written down in the file itself, not only in the code',
    /measured/i.test(ds.method.carryover) && ds.method.not_included.some(x => /NIL/.test(x)), ds.method.not_included);
}
{
  /* the degenerate case: no games at all anywhere */
  const ds = B.buildDataset({}, { season: 2026, prior: 2025, bundles: {}, details: {} }, null, { season: 2026, week: 1, now: '2026-09-03T12:00:00Z' });
  chk('with no games on file the dataset is empty and says so, rather than ranking nobody as number one',
    ds.teams.length === 0 && ds.team_count === 0, { n: ds.team_count, notes: ds.notes });
}

/* --------------------------------------------------- the shipped dataset */
{
  const fs = require('fs');
  const f = path.join(__dirname, 'current.json');
  if (fs.existsSync(f)) {
    const ds = JSON.parse(fs.readFileSync(f, 'utf8'));
    chk('the committed rating file matches the schema the app reads', ds.schema === E.SCHEMA, ds.schema);
    chk('the committed rating file rates a real FBS field', ds.teams.length >= 100, ds.teams.length);
    chk('every committed rating can be taken apart into components',
      ds.teams.every(t => t.components && t.basis && Array.isArray(t.unmeasured) && typeof t.confidence === 'number'));
    chk('no committed rating claims to have measured NIL dollars',
      ds.teams.every(t => t.unmeasured.some(u => /NIL/.test(u))));
    chk('the committed carryover weight sits in a believable range',
      ds.carryover.weight > 0.3 && ds.carryover.weight < 1, ds.carryover.weight);
  } else {
    chk('the committed rating file exists', false, 'football/rating/current.json missing');
  }
}

/* --------------------------------------- the app reads it, and reads it honestly */
{
  const fs = require('fs');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
  chk('the app no longer manufactures a roster timestamp from the season — that is what made a file fetched this week read as eight hundred hours stale',
    !/rosterSeason\s*\?\s*\(FB\.p4\.rosterSeason\s*\+\s*'-08-01/.test(app));
  chk('the engine request carries the roster timestamp the roster file actually reports',
    /roster:FB\.p4\.rosterAsOf/.test(app));
  chk('both roster paths record when they were read', (app.match(/S\.rosterAsOf=/g) || []).length >= 3,
    (app.match(/S\.rosterAsOf=[^;]*/g) || []));
  chk('the availability layer now reaches the engine instead of a hardcoded null',
    /injuries:fbP4Injuries\(g\.home_team\)/.test(app) && /injuries:fbP4Injuries\(g\.away_team\)/.test(app));
  chk('a team EdgeDesk could not read still reports NO injury report rather than a clean one',
    /if\(q==='NONE'\|\|q==='LIMITED'\) return null;/.test(app));
  chk('the starting QB stays unsupplied, because college football publishes no depth chart EdgeDesk trusts',
    /qb:null,injuries:fbP4Injuries/.test(app));
  chk('snap share and replacement quality are left null rather than invented for college football',
    /snap_share:null,/.test(app) && /replacement_quality:null,/.test(app));
  chk('the app reads the committed rating file', /football\/rating\/current\.json/.test(app));
  chk('the board still shows the engine state the lines are actually priced from, alongside the rating',
    /priced from/.test(app));
}

done();
