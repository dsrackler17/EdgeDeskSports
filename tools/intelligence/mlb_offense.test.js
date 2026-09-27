#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Intelligence — the MLB OFFENSIVE layer, end to end.

   The ten questions in the brief, asked of the real code over the real
   archive imported into a real PostgreSQL:

     "How has Aaron Judge performed over the last five completed seasons?"
     "Compare Judge and Ohtani's power and plate discipline."
     "Which teams did this hitter play for?"
     "Was his OPS driven more by reaching base or power?"
     "Who led the 2025 offensive rating among hitters with at least 500 PA?"
     "Which hitters improved their walk rate from 2024 to 2025?"
     "Which teams had the strongest offense in 2025?"
     "Compare this lineup's historical power and strikeout profile."
     "Show Ohtani's hitting and pitching history together."
     "How does this player's current season compare with his 2016-2025 baseline?"

   Each one is routed, retrieved and rendered, and the numbers in the rendered
   block are checked against SQL computed independently of the layer that
   produced them. The follow-up is then asked with only the conversation state
   the previous turn returned, and has to resolve to the same MLB id without a
   name being repeated.

   The tool registry is exercised through EDRESEARCH.runTool itself, so the
   budget, the allowlist, the input validation and the failure envelope are
   production's, not a stand-in.

   Finally the critic is attacked: prose that states who is batting tonight,
   that invents handedness splits or batter-versus-pitcher history, that calls
   the descriptive index wRC+, that quotes a rating with no plate appearances,
   or that quietly picks one of two hitters the retrieval refused to choose
   between.

   Without PostgreSQL the database half skips and the pure half still runs.

   Run: node tools/intelligence/mlb_offense.test.js
   =========================================================================== */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'mlb', 'pg_client.js'));
const D = require(path.join(ROOT, 'tools', 'mlb', 'offense_dataset.js'));
const IMPORT = require(path.join(ROOT, 'tools', 'mlb', 'import_offense.js'));
const PD = require(path.join(ROOT, 'tools', 'mlb', 'dataset.js'));
const PIMPORT = require(path.join(ROOT, 'tools', 'mlb', 'import_pitcher_history.js'));
const M = require(path.join(ROOT, 'lib', 'mlb_offense_history.js'));
const EDRESEARCH = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_research.js'));
const H = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_mlboff.js'));

const DB = 'edgedesk_mlboff_ai';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const PITCH_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFF_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function has(hay, needle, name) { ok(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { ok(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }

/* ══════════════════════════════════════════════════════════════════════════
   PART 1 — ROUTING. No database needed: this is the decision about whether a
   turn belongs to this archive at all, and getting it wrong is how a question
   about tonight gets answered with a 2019 line.
   ══════════════════════════════════════════════════════════════════════════ */
console.log('mlb offense — routing');

function R(q, extra) { return H.route(Object.assign({ question: q, sport: 'baseball_mlb' }, extra || {})); }

/* The ten questions from the brief, each routed to the intent that answers it. */
const ROUTES = [
  ['How has Aaron Judge performed over the last five completed seasons?', 'hitter_history'],
  ['Compare Judge and Ohtani’s power and plate discipline.', 'compare_hitters'],
  ['Which teams did this hitter play for?', 'hitter_team_history'],
  ['Was his OPS driven more by reaching base or power?', 'ops_decomposition'],
  ['Who led the 2025 offensive rating among hitters with at least 500 PA?', 'leaderboard'],
  ['Which hitters improved their walk rate from 2024 to 2025?', 'improvement'],
  ['Which teams had the strongest offense in 2025?', 'team_offense'],
  ['Compare this lineup’s historical power and strikeout profile.', 'lineup_context'],
  ['Show Ohtani’s hitting and pitching history together.', 'two_way'],
  ['How does this player’s current season compare with his 2016–2025 baseline?', 'current_vs_baseline']
];
/* A carried hitter is supplied only where the question actually leans on one
   ("which teams did THIS hitter play for"). Handing a league-wide question a
   carried hitter would make it a question about him, which is the right
   behaviour and the wrong test. */
const NEEDS_CARRIED = { hitter_team_history: 1, ops_decomposition: 1, current_vs_baseline: 1 };
ROUTES.forEach(([q, want]) => {
  const p = R(q, NEEDS_CARRIED[want] ? { carried: { player_ids: [592450] } } : {});
  ok('routes: ' + q.slice(0, 52), p && p.primary === want, p ? 'got ' + p.primary : 'routed to nothing');
});

/* WHAT MUST NOT ROUTE HERE. */
ok('a football question does not route here', R('How has Josh Allen played this year?', {}) === null
  || H.route({ question: 'How has Josh Allen played this year?', sport: 'americanfootball_nfl' }) === null);
ok('a pure "who is pitching tonight" does not become a hitting answer',
  (() => { const p = R('Who is pitching tonight for the Yankees?'); return !p || p.primary !== 'hitter_history'; })());
ok('a bare price question does not route here', R('What is the moneyline on the Yankees?') === null);

/* THE LINEUP QUESTION ROUTES HERE ONLY TO REFUSE. */
const lu = R('Who is batting for the Dodgers today?');
ok('a "who is batting today" question routes to the refusal', lu && lu.primary === 'lineup_refusal',
  lu ? lu.primary : 'null');

/* Names survive the stop words around them. */
const names = H.hitterNamesIn('Compare Aaron Judge and Shohei Ohtani on power');
ok('both names are extracted from a comparison', names.length === 2
  && names.indexOf('Aaron Judge') >= 0 && names.indexOf('Shohei Ohtani') >= 0, JSON.stringify(names));
ok('a city word is not mistaken for a name',
  H.hitterNamesIn('Which New York hitters led in 2025?').indexOf('New York') < 0,
  JSON.stringify(H.hitterNamesIn('Which New York hitters led in 2025?')));

/* THE FILTER PHRASE IS NOT THE METRIC. "at least 500 PA" names a screen; a
   board ranked by plate appearances answers a different question. */
eq('a workload screen is not read as the ranking metric',
  H.metricFor('Who led the 2025 offensive rating among hitters with at least 500 PA?'), 'offensive_index');
eq('…and the screen itself is still parsed',
  H.minPaIn('Who led the 2025 offensive rating among hitters with at least 500 PA?'), 500);
eq('walk rate is recognised', H.metricFor('Which hitters improved their walk rate from 2024 to 2025?'), 'bb_pct');
eq('strikeout rate is recognised', H.metricFor('Who had the lowest strikeout rate in 2024?'), 'k_pct');
eq('home runs are recognised', H.metricFor('Who hit the most home runs in 2023?'), 'home_runs');
eq('OPS is recognised', H.metricFor('Who had the best OPS in 2022?'), 'ops');
eq('seasons are extracted', JSON.stringify(H.seasonsIn('from 2024 to 2025')), JSON.stringify([2024, 2025]));

/* A follow-up with no name at all still routes, on carried ids alone. */
const follow = R('And his walk rate?', { carried: { player_ids: [592450] } });
ok('a follow-up routes on carried ids alone', !!follow, 'routed to nothing');

/* ══════════════════════════════════════════════════════════════════════════
   PART 2 — THE TOOLS REGISTER
   ══════════════════════════════════════════════════════════════════════════ */
console.log('mlb offense — the tool registry');
global.EDRESEARCH = EDRESEARCH;
ok('the tools register into EDRESEARCH', H.registerTools() === true);
H.TOOL_NAMES.forEach((n) => ok('tool registered: ' + n, !!EDRESEARCH.TOOLS[n]));
const defs = EDRESEARCH.toolDefinitions(H.TOOL_NAMES);
ok('every tool has a definition the model can read', defs.length === H.TOOL_NAMES.length,
  defs.length + ' of ' + H.TOOL_NAMES.length);
/* EVERY tool description has to carry the coverage caveat: a model that reads
   one description in isolation must still know this is not tonight. */
defs.forEach((d) => {
  ok('  ' + d.name + ' says it is not current-season data',
    /NOT\s+current-season data/i.test(d.description), d.description.slice(0, 80));
  ok('  ' + d.name + ' says it is never a lineup',
    /never a lineup/i.test(d.description), d.description.slice(0, 80));
});

/* ══════════════════════════════════════════════════════════════════════════
   PART 3 — THE CRITIC, attacked
   ══════════════════════════════════════════════════════════════════════════ */
console.log('mlb offense — the critic');
const fakeRes = {
  coverage: { start: 2016, end: 2025, provisional_seasons: [] },
  rating_version: 'ED_BAT_PERF_V1',
  ambiguous: [{ name: 'Luis Garcia', candidates: [{ player_id: 605488, player_name: 'Luis Garcia' },
    { player_id: 472610, player_name: 'Luis García' }] }],
  overviews: [], seasons: {}, teams: {}
};
function critic(answer) { return H.criticExtras({ result: fakeRes, answer: answer }).map((x) => x.code); }

ok('the critic catches a lineup claim',
  critic('Judge is batting second tonight and Ohtani is batting third.').indexOf('HISTORY_AS_LINEUP') >= 0);
ok('…but not a sentence that refuses to make one',
  critic('This archive cannot say who is batting tonight; that comes from the live lineup feed.')
    .indexOf('HISTORY_AS_LINEUP') < 0);
ok('the critic catches the current season claimed from a 2025 archive',
  critic('He is hitting well currently, with a .320 average.').indexOf('CURRENT_FROM_HISTORY') >= 0);
ok('the critic catches an ambiguous name silently resolved',
  critic('Luis Garcia (605488) hit .250 across the window.').indexOf('AMBIGUITY_RESOLVED_SILENTLY') >= 0);
ok('…but not when the answer asks which one',
  critic('Two hitters named Luis Garcia are in the archive (605488 and 472610). Which did you mean?')
    .indexOf('AMBIGUITY_RESOLVED_SILENTLY') < 0);
ok('the critic catches the index described as wRC+',
  critic('His offensive index of 161 is essentially his wRC+ over 5002 PA.').indexOf('RATING_MISDESCRIBED') >= 0);
ok('the critic catches a rating quoted with no sample',
  critic('His offensive index is 161.4, well above average.').indexOf('RATING_WITHOUT_SAMPLE') >= 0);
ok('the critic catches an invented handedness split',
  critic('Against left-handed pitching he has a platoon split worth noting.').indexOf('UNAVAILABLE_CLAIM') >= 0);
ok('the critic catches invented batter-versus-pitcher history',
  critic('His career numbers against this pitcher are strong.').indexOf('UNAVAILABLE_CLAIM') >= 0);
ok('the critic catches invented Statcast',
  critic('His exit velocity and barrel rate both improved.').indexOf('UNAVAILABLE_CLAIM') >= 0);
ok('a clean historical answer draws nothing',
  critic('Across 2021–2025 in the archive he took 3,100 plate appearances with a .390 OBP; '
    + 'his ED_BAT_PERF_V1 index is 158.2 over those 3,100 PA.').length === 0,
  JSON.stringify(critic('Across 2021–2025 in the archive he took 3,100 plate appearances with a .390 OBP; '
    + 'his ED_BAT_PERF_V1 index is 158.2 over those 3,100 PA.')));

/* Conversation state is sanitised, not trusted. */
const dirty = H.sanitizeState({ player_ids: ['592450', 'drop table', -3], names: { 592450: 'A'.repeat(500) },
  seasons: [2024, 'x', 99999], metric: 'x'.repeat(200) });
ok('carried ids are cleaned to real ids', JSON.stringify(dirty.player_ids) === JSON.stringify([592450]),
  JSON.stringify(dirty.player_ids));
ok('a carried name is truncated', dirty.names[592450].length <= 80);
ok('a nonsense season is dropped', JSON.stringify(dirty.seasons) === JSON.stringify([2024]),
  JSON.stringify(dirty.seasons));
ok('an empty state sanitises to null', H.sanitizeState({ player_ids: [] }) === null);

/* ══════════════════════════════════════════════════════════════════════════
   PART 4 — RETRIEVAL, against a real database
   ══════════════════════════════════════════════════════════════════════════ */
const conn = PG.findServer();
if (!conn) {
  console.log('mlb offense — SKIPPING the database half (no reachable PostgreSQL)');
  report();
}

(async function main() {
  if (!PG.createDatabase(conn, DB)) { console.log('  (could not create the test database)'); report(); return; }
  const db = PG.pgClient(conn, { database: DB });
  try {
    for (const f of [SHIM, PITCH_SQL, OFF_SQL]) {
      const r = PG.applyFile(conn, DB, f);
      if (!r.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); throw new Error('apply'); }
    }
    const ds = D.loadDataset(D.DEFAULT_DIR);
    await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });
    const pds = PD.loadDataset(PD.DEFAULT_DIR);
    await PIMPORT.runImport(db, pds, PD.validateDataset(pds), { log: () => {}, chunk: 1000 });
    console.log('mlb offense — retrieval over the real archive');

    const svc = M.createService({ read: async (rel, q) => db.select('mlbhist', rel, q) });
    const ctx = { mlb_offense: svc };
    const JUDGE = ds.tables.batter_overview.filter((r) => r.player_name === 'Aaron Judge')[0].player_id;
    const OHTANI = ds.tables.batter_overview.filter((r) => /Ohtani/.test(r.player_name))[0].player_id;

    async function ask(q, carried) {
      const plan = H.route({ question: q, sport: 'baseball_mlb', carried: carried || null });
      if (!plan) return { plan: null, res: null, block: '' };
      const res = await H.retrieve({ service: svc, plan: plan });
      return { plan, res, block: H.promptBlock(res) };
    }

    /* ── Q1 "How has Aaron Judge performed over the last five completed seasons?" */
    {
      const { plan, res, block } = await ask('How has Aaron Judge performed over the last five completed seasons?');
      ok('Q1 routes and retrieves', !!res && res.overviews.length === 1, plan && plan.primary);
      eq('Q1 resolved the right hitter', res.overviews[0].player_id, JUDGE);
      has(block, 'MLB OFFENSIVE ARCHIVE (2016–2025)', 'Q1 names the coverage window');
      has(block, 'NOT current-season data', 'Q1 says it is not current');
      has(block, 'NEVER A LINEUP', 'Q1 says it is never a lineup');
      has(block, 'ED_BAT_PERF_V1', 'Q1 names the rating version');
      /* Every season line in the block must match SQL. */
      const sql = db.rows(`select season, plate_appearances, home_runs, ops, offensive_index
                             from mlbhist.batter_seasons where player_id = ${JUDGE} and plate_appearances > 0
                            order by season`);
      let bad = 0;
      sql.forEach((r) => {
        const line = block.split('\n').filter((l) => l.trim().startsWith(r.season + ':'))[0];
        if (!line) { bad++; return; }
        if (line.indexOf(r.plate_appearances + ' PA') < 0) bad++;
        if (line.indexOf(r.home_runs + ' HR') < 0) bad++;
      });
      eq('Q1 every season line matches SQL', bad, 0);
      has(block, 'profile link: #research/baseball/b' + JUDGE, 'Q1 links the player page');
    }

    /* ── Q2 "Compare Judge and Ohtani's power and plate discipline." */
    {
      const { res, block } = await ask('Compare Aaron Judge and Shohei Ohtani’s power and plate discipline.');
      ok('Q2 retrieves a comparison', !!res.compare && res.compare.ok, res.compare && res.compare.code);
      has(block, 'COMPARISON', 'Q2 renders the comparison');
      has(block, 'Isolated power', 'Q2 compares power');
      has(block, 'Walk rate', 'Q2 compares plate discipline');
      has(block, 'Strikeout rate', 'Q2 compares strikeouts');
      ok('Q2 shows plate appearances for both', /Aaron Judge \d+ PA/.test(block) && /Ohtani \d+ PA/.test(block));
      /* the lead the layer picked must be the one SQL agrees with */
      const iso = db.rows(`select player_id, iso from mlbhist.batter_overview
                            where player_id in (${JUDGE}, ${OHTANI})`);
      const best = iso.sort((a, b) => Number(b.iso) - Number(a.iso))[0];
      const row = res.compare.data.rows.filter((r) => r.metric === 'iso')[0];
      eq('Q2 the power lead matches SQL',
        res.compare.data.players[row.lead].player_id, Number(best.player_id));
    }

    /* ── Q3 "Which teams did this hitter play for?" (Ohtani: two clubs) */
    {
      const { res, block } = await ask('Which teams did this hitter play for?', { player_ids: [OHTANI] });
      ok('Q3 retrieves club history', !!res.teams[OHTANI] && res.teams[OHTANI].ok);
      has(block, 'CLUBS for id ' + OHTANI, 'Q3 renders the club list');
      has(block, 'Angels', 'Q3 names his first club');
      has(block, 'Dodgers', 'Q3 names his second club');
      has(block, 'NOT contract or trade dates', 'Q3 says what club duration means');
      has(block, 'Never add the two together', 'Q3 warns against adding the grains');
    }

    /* ── Q4 "Was his OPS driven more by reaching base or power?" */
    {
      const { res, block } = await ask('Was his OPS driven more by reaching base or power?', { player_ids: [JUDGE] });
      ok('Q4 retrieves the decomposition', !!res.decomposition && res.decomposition.result.available);
      has(block, 'OPS SHAPE for Aaron Judge', 'Q4 renders the decomposition');
      ok('Q4 names which half led', /led by (on-base|slugging)|not driven by one half/.test(block), block.slice(0, 100));
      /* checked against SQL: each half against its own league baseline */
      const d = res.decomposition.result;
      const lg = db.rows(`select obp, slg from mlbhist.league_offense_seasons
                           where season = (select max(season) from mlbhist.batter_seasons
                                            where player_id = ${JUDGE} and plate_appearances > 0)`)[0];
      ok('Q4 the league baseline is that season’s own',
        Math.abs(d.league_obp - Number(lg.obp)) < 1e-9 && Math.abs(d.league_slg - Number(lg.slg)) < 1e-9,
        `${d.league_obp}/${d.league_slg} vs ${lg.obp}/${lg.slg}`);
    }

    /* ── Q5 "Who led the 2025 offensive rating among hitters with at least 500 PA?" */
    {
      const { plan, res, block } = await ask('Who led the 2025 offensive rating among hitters with at least 500 PA?');
      eq('Q5 screens on 500 PA', plan.min_pa, 500);
      eq('Q5 ranks by the index, not the screen', plan.metric, 'offensive_index');
      ok('Q5 retrieves a leaderboard', !!res.leaderboard && res.leaderboard.ok);
      has(block, 'LEADERBOARD 2025 by offensive_index', 'Q5 renders the board');
      has(block, 'ordered by the database', 'Q5 says the database ordered it');
      const top = db.rows(`select player_name, offensive_index from mlbhist.batter_seasons
                            where season = 2025 and plate_appearances >= 500 and offensive_index is not null
                            order by offensive_index desc limit 1`)[0];
      has(block, '1. ' + top.player_name, 'Q5 the leader matches SQL');
      has(block, 'qualification for 2025 is 503 PA', 'Q5 names MLB’s own qualification');
    }

    /* ── Q6 "Which hitters improved their walk rate from 2024 to 2025?" */
    {
      const { plan, res, block } = await ask('Which hitters improved their walk rate from 2024 to 2025?');
      eq('Q6 routes to the change intent', plan.primary, 'improvement');
      eq('Q6 uses walk rate', plan.metric, 'bb_pct');
      ok('Q6 retrieves changes', !!res.changes && res.changes.ok, res.changes && res.changes.code);
      has(block, 'CHANGE 2024 → 2025 in bb_pct', 'Q6 renders the change board');
      has(block, 'most improved first', 'Q6 says the order');
      has(block, 'in BOTH seasons', 'Q6 says the screen applies to both seasons');
      /* most improved really is the largest gain */
      const d = res.changes.data;
      ok('Q6 the top mover has the largest gain', d.length > 1 ? d[0].delta >= d[1].delta : true,
        d.length > 1 ? `${d[0].delta} then ${d[1].delta}` : 'only one');
      ok('Q6 the top mover actually improved', d[0].improved === true, JSON.stringify(d[0]));
      /* cross-checked against SQL */
      const sqlTop = db.rows(`select a.player_name, (b.bb_pct - a.bb_pct) as d
                                from mlbhist.batter_seasons a
                                join mlbhist.batter_seasons b on b.player_id = a.player_id and b.season = 2025
                               where a.season = 2024 and a.plate_appearances >= 300
                                 and b.plate_appearances >= 300
                                 and a.bb_pct is not null and b.bb_pct is not null
                               order by d desc limit 1`)[0];
      eq('Q6 the top mover matches SQL', d[0].player_name, sqlTop.player_name);
    }

    /* ── Q7 "Which teams had the strongest offense in 2025?" */
    {
      const { plan, res, block } = await ask('Which teams had the strongest offense in 2025?');
      eq('Q7 routes to team offense', plan.primary, 'team_offense');
      ok('Q7 retrieves club rows', !!res.team_offense && res.team_offense.ok);
      has(block, 'TEAM OFFENSE 2025', 'Q7 renders the club board');
      has(block, 'R/G', 'Q7 shows runs per game');
      has(block, 'ACTUAL games', 'Q7 says which games runs per game uses');
      has(block, 'is NOT a club', 'Q7 warns that player_games_sum is not club games');
      const top = db.rows(`select team_name, runs, team_games from mlbhist.team_offense_seasons
                            where season = 2025 order by offensive_index desc limit 1`)[0];
      has(block, '1. ' + top.team_name, 'Q7 the top club matches SQL');
      has(block, top.runs + ' R in ' + top.team_games + ' G', 'Q7 shows runs over the club’s own games');
    }

    /* ── Q8 "Compare this lineup's historical power and strikeout profile." */
    {
      const plan = H.route({ question: 'Compare this lineup’s historical power and strikeout profile.',
        sport: 'baseball_mlb' });
      eq('Q8 routes to lineup context', plan && plan.primary, 'lineup_context');
      /* The lineup itself comes from a CURRENT source; here it is supplied. */
      const res = await H.retrieve({ service: svc,
        plan: Object.assign({}, plan, { names: ['Aaron Judge', 'Shohei Ohtani'] }) });
      const block = H.promptBlock(res);
      ok('Q8 retrieves the lineup history', !!res.lineup && res.lineup.ok, res.lineup && res.lineup.code);
      has(block, 'LINEUP HISTORY', 'Q8 renders the lineup block');
      has(block, 'this archive did not produce the lineup', 'Q8 says where the lineup came from');
      has(block, 'COMBINED', 'Q8 shows the combined profile');
      has(block, 'never a mean of means', 'Q8 says how the combined rates were computed');
      has(block, 'NOT TONIGHT’S LINEUP', 'Q8 refuses to be a lineup');
      /* the combined line is the sum, checked against SQL */
      const sql = db.rows(`select sum(hits)::int h, sum(at_bats)::int ab, sum(home_runs)::int hr,
                                  sum(plate_appearances)::int pa
                             from mlbhist.batter_overview where player_id in (${JUDGE}, ${OHTANI})`)[0];
      eq('Q8 the combined plate appearances are the sum', res.lineup.data.combined.plate_appearances, Number(sql.pa));
      eq('Q8 the combined home runs are the sum', res.lineup.data.combined.home_runs, Number(sql.hr));
      ok('Q8 the combined average is hits over at-bats, summed first',
        Math.abs(res.lineup.data.combined.avg - Number(sql.h) / Number(sql.ab)) < 1e-6,
        `${res.lineup.data.combined.avg} vs ${Number(sql.h) / Number(sql.ab)}`);
    }

    /* ── Q9 "Show Ohtani's hitting and pitching history together." */
    {
      const { plan, res, block } = await ask('Show Shohei Ohtani’s hitting and pitching history together.');
      eq('Q9 routes to two-way', plan.primary, 'two_way');
      ok('Q9 retrieves both sides', !!res.two_way && res.two_way.ok && res.two_way.data.length === 1);
      has(block, 'TWO-WAY RECORD', 'Q9 renders the two-way block');
      has(block, 'one MLB person id, both archives', 'Q9 says it is one identity');
      has(block, 'ED_BAT_PERF_V1', 'Q9 names the hitting rating');
      has(block, 'ED_PITCH_PERF_V1', 'Q9 names the pitching rating');
      has(block, 'never combined into one number', 'Q9 keeps the two scales apart');
      const p = db.rows(`select outs from mlbhist.pitcher_overview where player_id = ${OHTANI}`)[0];
      ok('Q9 the pitching side came from the pitching archive',
        res.two_way.data[0].pitching.outs === Number(p.outs),
        `${res.two_way.data[0].pitching.outs} vs ${p.outs}`);
    }

    /* ── Q10 "How does this player's current season compare with his baseline?" */
    {
      const { plan, res, block } = await ask(
        'How does this player’s current season compare with his 2016–2025 baseline?',
        { player_ids: [JUDGE] });
      eq('Q10 routes to current-vs-baseline', plan.primary, 'current_vs_baseline');
      ok('Q10 retrieves the baseline', !!res.baseline && res.baseline.ok);
      has(block, 'COMPLETED-SEASON BASELINE', 'Q10 renders the baseline');
      has(block, 'live tables are the only source', 'Q10 names where a current line must come from');
      eq('Q10 the baseline is five completed seasons', res.baseline.scope.baseline_seasons.length, 5);
    }

    /* ── THE FOLLOW-UP: identity and scope survive with no name repeated ── */
    {
      const first = await ask('How has Aaron Judge performed over the last five completed seasons?');
      const state = H.conversationState({ previous: null, result: first.res, plan: first.plan });
      ok('the turn returns conversation state', !!state && state.player_ids.indexOf(JUDGE) >= 0,
        JSON.stringify(state && state.player_ids));
      eq('…carrying his name for the next turn', state.names[JUDGE], 'Aaron Judge');

      const second = await ask('And which clubs did he play for?', H.sanitizeState(state));
      ok('the follow-up resolves with no name repeated', !!second.res && !!second.res.teams[JUDGE],
        second.plan && second.plan.primary);
      has(second.block, 'CLUBS for id ' + JUDGE, 'the follow-up answers about the same hitter');

      const third = await ask('And his walk rate over those seasons?',
        H.sanitizeState(H.conversationState({ previous: state, result: second.res, plan: second.plan })));
      ok('a second follow-up still carries the identity',
        !!third.res && third.res.player_ids.indexOf(JUDGE) >= 0,
        JSON.stringify(third.res && third.res.player_ids));
    }

    /* ── AMBIGUITY IS CARRIED THROUGH TO THE PROMPT, NOT RESOLVED ── */
    {
      const folded = {};
      ds.tables.batter_overview.forEach((r) => {
        const k = M.nameKey(r.player_name);
        (folded[k] = folded[k] || []).push(r);
      });
      const ambKey = Object.keys(folded).filter((k) => folded[k].length > 1)[0];
      const name = folded[ambKey][0].player_name;
      const { res, block } = await ask('How has ' + name + ' hit over his career?');
      ok('an ambiguous name is retrieved as ambiguous', res.ambiguous.length === 1, JSON.stringify(res.ambiguous.length));
      has(block, 'AMBIGUOUS NAME', 'the block flags the ambiguity');
      has(block, 'ASK WHICH ONE. Do not pick.', 'the block instructs the model not to pick');
      ok('every candidate is offered', res.ambiguous[0].candidates.length === folded[ambKey].length);
    }

    /* ── THE LINEUP REFUSAL, end to end ── */
    {
      const { plan, res, block } = await ask('Who is batting for the Dodgers tonight?');
      eq('the lineup question routes to the refusal', plan.primary, 'lineup_refusal');
      has(block, 'THE QUESTION ASKS WHO IS PLAYING', 'the block says the question cannot be answered here');
      has(block, 'live lineup source', 'the block names where the answer comes from');
      ok('and nothing was retrieved to dress it up', res.overviews.length === 0 && !res.leaderboard);
    }

    /* ══ THE TOOLS, through the real runTool ══════════════════════════════ */
    console.log('mlb offense — the tools, through EDRESEARCH.runTool');
    /* runTool wraps the tool's own envelope, so the query layer's payload is at
       .data.data and the tool's coverage/rating metadata at .data. Reading the
       outer one as if it were the inner is how a test passes while asserting
       on undefined. */
    const T1 = await EDRESEARCH.runTool('resolve_mlb_hitter', { name: 'Aaron Judge' }, ctx);
    ok('resolve_mlb_hitter resolves', T1.ok && T1.data.data.resolved.player_id === JUDGE,
      JSON.stringify(T1.error || T1.data.code));
    ok('…carrying the coverage window with it', T1.data.coverage && T1.data.coverage.end === 2025);
    const T1b = await EDRESEARCH.runTool('resolve_mlb_hitter', { name: 'Zebediah Notarealhitter' }, ctx);
    ok('…and refuses a name that is not there',
      !T1b.ok && T1b.error && T1b.error.code === 'UNRESOLVED_PLAYER', JSON.stringify(T1b.error));

    const T2 = await EDRESEARCH.runTool('get_hitter_overview', { player_id: JUDGE }, ctx);
    ok('get_hitter_overview answers', T2.ok && T2.data.data.overview.player_id === JUDGE);
    ok('…and is marked historical, never live', T2.data.historical === true && T2.freshness === 'STALE',
      T2.freshness);

    const T3 = await EDRESEARCH.runTool('get_hitter_season_history', { player_id: JUDGE, from: 2021, to: 2023 }, ctx);
    ok('get_hitter_season_history bounds the window', T3.ok && T3.data.data.length === 3,
      T3.ok ? T3.data.data.length : JSON.stringify(T3.error));

    const T4 = await EDRESEARCH.runTool('get_hitter_team_history', { player_id: OHTANI }, ctx);
    ok('get_hitter_team_history returns both clubs', T4.ok && T4.data.data.by_team.length === 2);

    const T5 = await EDRESEARCH.runTool('compare_hitters', { player_ids: [JUDGE, OHTANI] }, ctx);
    ok('compare_hitters answers', T5.ok && T5.data.data.players.length === 2);

    const T6 = await EDRESEARCH.runTool('search_offensive_leaderboard',
      { season: 2025, metric: 'offensive_index', min_pa: 500, limit: 5 }, ctx);
    ok('search_offensive_leaderboard answers', T6.ok && T6.data.data.length === 5, JSON.stringify(T6.error));

    const T7 = await EDRESEARCH.runTool('search_offensive_changes',
      { from_season: 2024, to_season: 2025, metric: 'bb_pct', min_pa: 300, limit: 5 }, ctx);
    ok('search_offensive_changes answers', T7.ok && T7.data.data.length > 0, JSON.stringify(T7.error));

    const T8 = await EDRESEARCH.runTool('get_team_offense_history', { season: 2025 }, ctx);
    ok('get_team_offense_history answers for a season', T8.ok && T8.data.data.seasons.length === 30,
      JSON.stringify(T8.error));

    const T9 = await EDRESEARCH.runTool('get_game_lineup_context',
      { names: ['Aaron Judge', 'Shohei Ohtani'] }, ctx);
    ok('get_game_lineup_context answers when given a lineup', T9.ok && T9.data.data.hitters.length === 2);
    const T9b = await EDRESEARCH.runTool('get_game_lineup_context', {}, ctx);
    ok('…and refuses to invent one', !T9b.ok, JSON.stringify(T9b.error));

    const T10 = await EDRESEARCH.runTool('get_two_way_player_history', { player_id: OHTANI }, ctx);
    ok('get_two_way_player_history answers', T10.ok && T10.data.data.length === 1);

    const T11 = await EDRESEARCH.runTool('get_hitter_current_vs_baseline',
      { player_id: JUDGE, baseline_seasons: 3 }, ctx);
    ok('get_hitter_current_vs_baseline answers', T11.ok && T11.data.data.historical_baseline != null);
    eq('…over the three seasons asked for', T11.data.scope.baseline_seasons.length, 3);

    /* A tool called with nothing attached fails honestly rather than inventing. */
    const T0 = await EDRESEARCH.runTool('get_hitter_overview', { player_id: JUDGE }, {});
    ok('a tool with no service attached says so',
      !T0.ok && /not attached/.test((T0.error && T0.error.message) || ''), JSON.stringify(T0.error));

  } catch (e) {
    console.log('FAIL | mlb offense intelligence | ' + (e && e.stack || e));
    fail++;
  } finally {
    try { db.close(); } catch (_) { /* best effort */ }
    PG.dropDatabase(conn, DB);
  }
  report();
})();

function report() {
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  if (fail === 0) console.log('PASS | mlb offense intelligence | ' + pass + ' assertions');
  process.exit(fail === 0 ? 0 : 1);
}
