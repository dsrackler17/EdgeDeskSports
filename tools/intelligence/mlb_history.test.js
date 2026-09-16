#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Intelligence — the MLB historical pitching layer, end to end.

   The questions in the brief, asked of the real code over the real archive:

     "How has Gerrit Cole changed over the last five seasons in your dataset?"
     "Compare these two starters' strikeout rates, walks and workload."
     "Which teams did this pitcher play for, and how did he perform with each?"
     "Was his ERA supported by his FIP?"
     "Who had the strongest 2025 ratings among starters with at least 120 innings?"
     "Which relievers improved their strikeout-minus-walk rate from 2024 to 2025?"
     "How does this starter's current season compare with his historical baseline?"
     "What does the historical pitching data add to this matchup?"

   Each one is routed, retrieved and rendered, and the numbers in the rendered
   block are checked against SQL computed independently of the layer that
   produced them. Then the follow-up — "now compare him to the other starter" —
   is asked with only the conversation state the previous turn returned, and
   has to resolve to the same two MLB ids without a name being repeated.

   The tool registry is exercised through EDRESEARCH.runTool itself, so the
   budget, the allowlist, the input validation and the failure envelope are the
   ones production uses, not a stand-in.

   Finally the critic is attacked: prose that reads the archive as the current
   season, that invents a pitch mix, that turns the descriptive index into a
   probability, or that quietly picks one of two pitchers the retrieval refused
   to choose between.

   Without PostgreSQL the database half skips and the pure half still runs.

   Run: node tools/intelligence/mlb_history.test.js
   =========================================================================== */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'mlb', 'pg_client.js'));
const D = require(path.join(ROOT, 'tools', 'mlb', 'dataset.js'));
const IMPORT = require(path.join(ROOT, 'tools', 'mlb', 'import_pitcher_history.js'));
const M = require(path.join(ROOT, 'lib', 'mlb_pitcher_history.js'));
const EDRESEARCH = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_research.js'));
const H = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_mlbhist.js'));

const DB = 'edgedesk_mlbhist_ai';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SCHEMA_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

/* ── the half that needs no database ──────────────────────────────────── */
console.log('mlb history — routing (no database needed)');

const st2 = { player_ids: [543037, 554430], player_names: { 543037: 'Gerrit Cole', 554430: 'Zack Wheeler' } };
function r(q, sport, state) { return H.route({ question: q, sport: sport || '', state: state || null }); }

ok('a football question is not routed here', r('What is the weather for the Bears game?', 'americanfootball_nfl') === null);
ok('a live question is not routed here', r("Who is pitching tonight for the Yankees?") === null);
ok('a bare price question is not routed here', r('What is the best price on the Yankees moneyline?') === null);

const q1 = r('How has Gerrit Cole changed over the last five seasons in your dataset?');
ok('"how has X changed over the last five seasons" routes', !!q1 && q1.is_history);
eq('…as a pitcher history', q1 && q1.primary_intent, 'pitcher_history');
eq('…with the name extracted', q1 && q1.names[0], 'Gerrit Cole');
eq('…and five seasons understood', q1 && q1.last_n_seasons, 5);
ok('…as a probe, because nothing in it says "pitcher"', q1 && q1.probe_only === true);

const q2 = r('Who had the strongest 2025 ratings among starters with at least 120 innings?');
eq('a superlative with filters routes to the leaderboard', q2 && q2.primary_intent, 'leaderboard');
eq('…season 2025', q2 && q2.season, 2025);
eq('…role starter', q2 && q2.role, 'starter');
eq('…minimum 120 innings', q2 && q2.min_innings, 120);

const q3 = r('Which relievers improved their strikeout-minus-walk rate from 2024 to 2025?');
eq('a population improvement question is a board, not a career', q3 && q3.primary_intent, 'leaderboard');
eq('…role reliever', q3 && q3.role, 'reliever');
ok('…and both seasons are read', q3 && q3.season_range && q3.season_range.from === 2024 && q3.season_range.to === 2025);
eq('…ordered on K-BB%', H.metricFor(q3).metric, 'k_minus_bb_pct');

const q4 = r('Compare Gerrit Cole and Zack Wheeler on strikeout rates, walks and workload in 2024');
eq('a comparison routes as one', q4 && q4.primary_intent, 'compare_pitchers');
eq('…with both names, not just the second', (q4 && q4.names || []).join(' + '), 'Gerrit Cole + Zack Wheeler');
eq('…on the season named', q4 && q4.season, 2024);

const q5 = r('now compare him to the other starter', '', st2);
ok('a bare follow-up routes when ids are carried', !!q5 && q5.follow_up === true);
ok('…and uses the carried ids', (q5.carried_player_ids || []).join(',') === '543037,554430');
ok('the same follow-up with NO carried state does not route', r('now compare him to the other starter') === null);

const q6 = r('Was his ERA supported by his FIP?', '', st2);
eq('an ERA-versus-FIP follow-up routes', q6 && q6.primary_intent, 'era_vs_fip');

const q7 = r("How does this starter's current season compare with his historical baseline?", '', st2);
ok('a question spanning both eras is flagged as wanting current data too', q7 && q7.wants_current_too === true);

const q8 = r('What does the historical pitching data add to this matchup?', 'baseball_mlb');
eq('a matchup question routes to game context', q8 && q8.primary_intent, 'game_context');

ok('a club name is not read as a pitcher', H.pitcherNamesIn('the New York Yankees rotation').length === 0);
ok('an accented name survives extraction', H.pitcherNamesIn('Luis García had a good year')[0] === 'Luis García');

/* the tools register into the SAME registry the rest of the desk uses */
global.EDRESEARCH = EDRESEARCH;
global.EDMlbPitchers = M;
ok('the tools register into EDRESEARCH', H.registerTools() === true);
H.TOOL_NAMES.forEach(function (n) { ok('tool registered: ' + n, !!EDRESEARCH.TOOLS[n]); });
const defs = EDRESEARCH.toolDefinitions(H.TOOL_NAMES);
eq('every tool is offered to the model with a schema', defs.length, H.TOOL_NAMES.length);
ok('every description says this is not current-season data',
  defs.every(function (d) { return /NOT current-season data/i.test(d.description); }));

/* ── the half that needs the database ─────────────────────────────────── */
const conn = PG.findServer();
if (!conn) {
  console.log('');
  console.log('SKIP | mlb history — retrieval | no reachable PostgreSQL server');
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} routing checks (retrieval half skipped)`);
  process.exit(fail ? 1 : 0);
}

(async function main() {
  if (!PG.createDatabase(conn, DB)) { console.log('SKIP | could not create the test database'); process.exit(fail ? 1 : 0); }
  const db = PG.pgClient(conn, { database: DB });
  try {
    for (const f of [SHIM, SCHEMA_SQL]) {
      const a = PG.applyFile(conn, DB, f);
      if (!a.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); throw new Error('apply'); }
    }
    const ds = D.loadDataset(D.DEFAULT_DIR);
    await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });
    const svc = M.createService({ read: (rel, q) => db.select('mlbhist', rel, q) });

    console.log('');
    console.log('mlb history — retrieval over the real archive');

    /* "How has Gerrit Cole changed over the last five seasons in your dataset?" */
    const plan1 = r('How has Gerrit Cole changed over the last five seasons in your dataset?');
    const res1 = await H.retrieve({ plan: plan1, service: svc });
    ok('the probe resolved a real pitcher', res1.players.length === 1 && res1.players[0].player_id === 543037,
      JSON.stringify(res1.players));
    ok('…and retrieved an overview and the change', res1.sections.some(s => s.kind === 'overview')
      && res1.sections.some(s => s.kind === 'changes'));
    const changes = res1.sections.filter(s => s.kind === 'changes')[0];
    eq('…over exactly five seasons', changes.data.seasons.length, 5);
    const sqlCole = db.rows(`select season, era, fip, k_pct, outs, performance_index
                               from mlbhist.pitcher_seasons where player_id = 543037
                               order by season desc limit 5`).reverse();
    eq('…the first of those five matches the database', changes.data.seasons[0].season, Number(sqlCole[0].season));
    ok('…and so does its ERA', Math.abs(changes.data.seasons[0].era - Number(sqlCole[0].era)) < 1e-6,
      `${changes.data.seasons[0].era} vs ${sqlCole[0].era}`);
    const yoy0 = changes.data.year_over_year[0];
    ok('…year-over-year ERA is the arithmetic difference, computed in code',
      yoy0.changes.era.delta == null
      || Math.abs(yoy0.changes.era.delta - (yoy0.changes.era.to - yoy0.changes.era.from)) < 1e-4);

    const block1 = H.promptBlock(res1);
    ok('the prompt block states the coverage window', /Coverage: 2016–2025/.test(block1));
    ok('…says in capitals that this is not current-season data', /THIS IS NOT CURRENT-SEASON DATA/.test(block1));
    ok('…names what the archive cannot say', /velocity, his pitch mix/.test(block1));
    ok('…carries the rating version', /ED_PITCH_PERF_V1/.test(block1));
    ok('…forbids converting the index to a price', /Never convert it to a probability, a fair price or an edge/.test(block1));
    ok('…labels the latest season as the latest in the archive',
      /LATEST IN THE ARCHIVE — not his current club or role/.test(block1));
    ok('…tells the model every figure must appear above it', /Every figure in your answer must appear above/.test(block1));
    ok('…contains a real season line from the database',
      block1.indexOf(String(sqlCole[4].season)) >= 0);

    /* "Which teams did this pitcher play for, and how did he perform with each?" */
    const plan2 = r('Which teams did Luis Garcia pitch for, and how did he perform with each?');
    const res2 = await H.retrieve({ plan: plan2, service: svc });
    ok('an ambiguous name is refused, not guessed',
      res2.unavailable != null || res2.resolution.some(x => x.code === 'AMBIGUOUS_PLAYER'),
      JSON.stringify(res2.resolution.map(x => x.code)));
    const block2 = H.promptBlock(res2);
    ok('…and the block tells the model to ask which one', /ASK WHICH ONE/.test(block2), block2.slice(0, 400));

    /* the same question, disambiguated by MLB id — the reliever traded in 2024 */
    const plan2b = Object.assign({}, plan2, { names: [], carried_player_ids: [472610] });
    const res2b = await H.retrieve({ plan: plan2b, service: svc });
    const th = res2b.sections.filter(s => s.kind === 'team_history')[0];
    ok('with the id supplied, the club record comes back', !!th && th.ok, JSON.stringify(res2b.resolution));
    ok('…and the traded season is named', (th.data.multi_club_seasons || []).indexOf(2024) >= 0);
    const clubs = db.rows(`select team_id from mlbhist.pitcher_team_seasons
                            where player_id = 472610 and season = 2024 order by team_id`);
    eq('…with both clubs in the database', clubs.length, 2);
    const block2b = H.promptBlock(res2b);
    ok('…the block warns against adding the two grains',
      /never add them to the season line/i.test(block2b));
    ok('…and says what tenure means', /TENURE MEANS/.test(block2b));

    /* "Who had the strongest 2025 ratings among starters with at least 120 innings?" */
    const plan3 = r('Who had the strongest 2025 ratings among starters with at least 120 innings?');
    const res3 = await H.retrieve({ plan: plan3, service: svc });
    const lb = res3.sections.filter(s => s.kind === 'leaderboard')[0];
    ok('the board came back', !!lb && lb.ok, JSON.stringify(res3).slice(0, 200));
    const sqlBoard = db.rows(`select player_id, player_name, performance_index from mlbhist.pitcher_seasons
                               where season = 2025 and role = 'starter' and outs >= 360
                                 and position_reported = 'P' and performance_index is not null
                               order by performance_index desc limit 3`);
    eq('…and its leader is the database’s leader', lb.data.rows[0].player_id, Number(sqlBoard[0].player_id));
    eq('…second too', lb.data.rows[1].player_id, Number(sqlBoard[1].player_id));
    ok('…every row clears the workload filter', lb.data.rows.every(x => x.outs >= 360));
    const block3 = H.promptBlock(res3);
    ok('the block states the filter that was applied', /minimum 120 IP/.test(block3));
    ok('…and prints the league baseline it is measured against', /league ERA/.test(block3));

    /* "Which relievers improved their K-BB% from 2024 to 2025?" */
    const plan4 = r('Which relievers improved their strikeout-minus-walk rate from 2024 to 2025?');
    const res4 = await H.retrieve({ plan: plan4, service: svc });
    const imp = res4.sections.filter(s => s.kind === 'improvement')[0];
    ok('the improvement join ran', !!imp && imp.ok, JSON.stringify(res4.sections.map(s => s.kind)));
    ok('…every listed pitcher genuinely improved',
      imp.data.improved.every(x => x.delta > 0 && x.from != null && x.to != null));
    if (imp.data.improved.length) {
      const top = imp.data.improved[0];
      const chk = db.rows(`select season, k_minus_bb_pct from mlbhist.pitcher_seasons
                            where player_id = ${Number(top.player_id)} and season in (2024, 2025) order by season`);
      ok('…and the join’s two ends match the database',
        chk.length === 2 && Math.abs(Number(chk[0].k_minus_bb_pct) - top.from) < 1e-6
        && Math.abs(Number(chk[1].k_minus_bb_pct) - top.to) < 1e-6,
        JSON.stringify({ top, chk }));
    }
    ok('…a pitcher missing from the earlier season is named, not scored as zero',
      (imp.data.unmatched || []).every(x => x.delta == null && /no qualifying season/.test(x.status)));

    /* "Compare these two starters' strikeout rates, walks and workload." */
    const plan5 = r('Compare Gerrit Cole and Zack Wheeler on strikeout rates, walks and workload in 2024');
    const res5 = await H.retrieve({ plan: plan5, service: svc });
    const cmp = res5.sections.filter(s => s.kind === 'comparison')[0];
    ok('two starters compare', !!cmp && cmp.ok, JSON.stringify(res5.resolution.map(x => x.code)));
    eq('…on the season the question named', cmp.data.comparison.scope, '2024');
    const kRow = cmp.data.comparison.metrics.filter(m => m.metric === 'k_pct')[0];
    const ids = cmp.data.comparison.sides.map(s => s.player_id);
    const sqlK = db.rows(`select player_id, k_pct from mlbhist.pitcher_seasons
                           where season = 2024 and player_id in (${ids.join(',')}) order by player_id`);
    ok('…and the K% values are the database’s',
      ids.every((id, i) => {
        const want = sqlK.filter(x => Number(x.player_id) === id)[0];
        return want && Math.abs(Number(want.k_pct) - kRow.values[i]) < 1e-6;
      }), JSON.stringify({ kRow, sqlK }));
    const block5 = H.promptBlock(res5);
    ok('the comparison block names its scope', /scope: 2024/.test(block5));
    ok('…and says a better number is a description, not a projection',
      /it is not a projection/.test(block5));

    /* THE FOLLOW-UP. Only the state the previous turn produced is carried. */
    const state5 = H.conversationState({ previous: null, result: res5, plan: plan5 });
    ok('the turn produced a carried state', !!state5 && state5.player_ids.length === 2, JSON.stringify(state5));
    /* No statistic may ride in the carried state: the next turn re-reads every
       number from the archive, so anything numeric here could go stale and be
       quoted anyway. Checked on the KEYS, because a naive substring search for
       "era" matches "coverage". */
    const stateKeys = [];
    (function walk(v, p) {
      if (!v || typeof v !== 'object') return;
      Object.keys(v).forEach(k => { stateKeys.push(p + k); walk(v[k], p + k + '.'); });
    })(state5, '');
    const statKeys = stateKeys.filter(k => /(^|\.)(era|fip|whip|k_pct|bb_pct|k_minus_bb_pct|innings|outs|performance_index|rating_sample_weight)$/.test(k));
    ok('…carrying ids, not statistics', statKeys.length === 0, JSON.stringify(statKeys));
    ok('…and carrying the MLB ids it resolved', stateKeys.indexOf('player_ids') >= 0);
    const plan6 = r('and how did each of them do with every club he pitched for?', '', state5);
    ok('a bare follow-up routes off the carried state', !!plan6 && plan6.follow_up === true);
    const res6 = await H.retrieve({ plan: plan6, service: svc });
    ok('…and resolves to the SAME two pitchers with no name given',
      res6.players.map(p => p.player_id).sort().join(',') === state5.player_ids.slice().sort().join(','),
      JSON.stringify(res6.players));
    ok('…and answers the new question, not the old one',
      res6.sections.some(s => s.kind === 'team_history'),
      JSON.stringify(res6.sections.map(s => s.kind)));

    /* "What does the historical pitching data add to this matchup?" */
    const plan7 = r('What does the historical pitching data add to this matchup?', 'baseball_mlb');
    const res7 = await H.retrieve({
      plan: plan7, service: svc,
      game: { label: 'Philadelphia Phillies @ New York Yankees', starters: [
        { side: 'home', name: 'Gerrit Cole', team: 'New York Yankees', status: 'probable' },
        { side: 'away', name: 'Zack Wheeler', team: 'Philadelphia Phillies', status: 'probable' }] }
    });
    const gc = res7.sections.filter(s => s.kind === 'game_context')[0];
    ok('a matchup question retrieves both starters’ histories', !!gc && gc.ok, JSON.stringify(res7).slice(0, 300));
    ok('…and keeps both as PROBABLE, not confirmed',
      gc.data.starters.every(s => s.starter_status === 'PROBABLE'));
    ok('…with a side-by-side on a stated scope', !!gc.data.comparison && !!gc.data.comparison.scope);
    const block7 = H.promptBlock(res7);
    ok('the block prints the card’s own claim about each start', /card says PROBABLE/.test(block7));
    ok('…and links to each pitcher’s profile', /pitcher\/543037/.test(block7));

    /* ── the tool registry, through the real runTool ────────────────────── */
    console.log('');
    console.log('mlb history — the tools, through EDRESEARCH.runTool');
    const ctx = { mlb_history: svc, budget: { max: 40, used: 0 }, allow: H.TOOL_NAMES };

    const t1 = await EDRESEARCH.runTool('resolve_mlb_player', { name: 'Gerrit Cole' }, ctx);
    ok('resolve_mlb_player returns a real envelope', t1.ok === true, JSON.stringify(t1.error));
    eq('…with the right MLB id', t1.data.data.resolved.player_id, 543037);
    ok('…and the coverage window', t1.data.coverage.start === 2016 && t1.data.coverage.end === 2025);

    const t1b = await EDRESEARCH.runTool('resolve_mlb_player', { name: 'Luis Ortiz' }, ctx);
    ok('an ambiguous name comes back as a REFUSAL, not a pick', t1b.ok === false);
    eq('…named AMBIGUOUS_PLAYER', t1b.error.code, 'AMBIGUOUS_PLAYER');

    const t1c = await EDRESEARCH.runTool('resolve_mlb_player', { name: 'Zebediah Notarealpitcher' }, ctx);
    eq('an unresolvable name is UNRESOLVED_PLAYER', t1c.error.code, 'UNRESOLVED_PLAYER');

    const t2 = await EDRESEARCH.runTool('get_pitcher_overview', { player_id: 543037 }, ctx);
    ok('get_pitcher_overview returns the career window', t2.ok === true);
    const sqlOv = db.rows(`select outs, era from mlbhist.pitcher_overview where player_id = 543037`)[0];
    eq('…with the database’s outs', t2.data.data.overview.outs, Number(sqlOv.outs));

    const t3 = await EDRESEARCH.runTool('get_pitcher_season_history', { player_id: 543037, from: 2021, to: 2023 }, ctx);
    ok('get_pitcher_season_history honours from/to', t3.ok === true
      && t3.data.data.seasons.every(s => s.season >= 2021 && s.season <= 2023));

    const t4 = await EDRESEARCH.runTool('get_pitcher_team_history', { player_id: 472610 }, ctx);
    ok('get_pitcher_team_history returns every club', t4.ok === true && t4.data.data.clubs.length > 1);

    const t5 = await EDRESEARCH.runTool('compare_pitchers', { player_ids: [543037, 554430], season: 2024 }, ctx);
    ok('compare_pitchers works through the tool layer', t5.ok === true, JSON.stringify(t5.error));
    const t5b = await EDRESEARCH.runTool('compare_pitchers', { player_ids: [543037] }, ctx);
    ok('…and refuses a comparison of one', t5b.ok === false);

    const t6 = await EDRESEARCH.runTool('search_pitcher_leaderboard',
      { season: 2025, role: 'starter', min_innings: 120, limit: 5 }, ctx);
    ok('search_pitcher_leaderboard filters by role and workload', t6.ok === true
      && t6.data.data.rows.length === 5 && t6.data.data.rows.every(x => x.role === 'starter' && x.outs >= 360));

    const t6b = await EDRESEARCH.runTool('search_pitcher_leaderboard', { season: 1999 }, ctx);
    ok('a season outside the archive is refused with the window named',
      t6b.ok === false && /2016–2025/.test(t6b.error.message), JSON.stringify(t6b.error));

    const t7 = await EDRESEARCH.runTool('get_game_pitcher_context', {
      game: 'Phillies @ Yankees',
      starters: [{ side: 'home', name: 'Gerrit Cole', status: 'probable' },
                 { side: 'away', name: 'Zack Wheeler', status: 'projected' }]
    }, ctx);
    ok('get_game_pitcher_context returns both sides', t7.ok === true && t7.data.data.starters.length === 2);
    eq('…keeping "probable" as probable', t7.data.data.starters[0].starter_status, 'PROBABLE');
    eq('…and "projected" as projected', t7.data.data.starters[1].starter_status, 'PROJECTED');

    const t8 = await EDRESEARCH.runTool('get_team_pitching_history', { team_id: 147, season: 2025, role: 'starter' }, ctx);
    ok('get_team_pitching_history returns one club’s starters', t8.ok === true
      && t8.data.data.club_seasons.every(x => x.team_id === 147));

    const notAllowed = await EDRESEARCH.runTool('get_pitcher_overview', { player_id: 543037 },
      { mlb_history: svc, allow: ['resolve_mlb_player'] });
    eq('the allowlist still governs these tools', notAllowed.error.code, 'NOT_ALLOWED');

    const spent = await EDRESEARCH.runTool('get_pitcher_overview', { player_id: 543037 },
      { mlb_history: svc, budget: { max: 1, used: 1 }, allow: H.TOOL_NAMES });
    eq('the budget still governs these tools', spent.error.code, 'BUDGET_EXHAUSTED');

    const badInput = await EDRESEARCH.runTool('get_pitcher_overview', { player_id: 'not a number' }, ctx);
    eq('input validation still governs these tools', badInput.error.code, 'INVALID_INPUT');

    const noSvc = await EDRESEARCH.runTool('get_pitcher_overview', { player_id: 543037 }, { allow: H.TOOL_NAMES });
    ok('a turn with no archive attached refuses rather than pretending', noSvc.ok === false
      && /not attached to this turn/.test(noSvc.error.message));

    /* ── the critic ─────────────────────────────────────────────────────── */
    console.log('');
    console.log('mlb history — the critic');
    const good = 'Gerrit Cole’s strikeout rate has fallen across the five seasons in EdgeDesk’s 2016–2025 archive. '
      + 'In 2021 he struck out 33.5% of batters faced over 181.1 innings; by 2025 that was lower. This is the historical '
      + 'record only and says nothing about his current club or form.';
    ok('honest prose passes', H.criticExtras({ result: res1, answer: good }).filter(f => f.severity === 'FAIL').length === 0,
      JSON.stringify(H.criticExtras({ result: res1, answer: good })));

    const asCurrent = 'His current season ERA is 3.10 and he is pitching well right now.';
    ok('reading the archive as the current season is a FAIL',
      H.criticExtras({ result: res1, answer: asCurrent }).some(f => f.code === 'MLBHIST_ARCHIVE_AS_CURRENT'));

    const invented = 'His fastball velocity dropped two ticks and he threw his slider more often.';
    ok('inventing velocity or a pitch mix is a FAIL',
      H.criticExtras({ result: res1, answer: invented }).some(f => f.code === 'MLBHIST_INVENTED_DETAIL'));

    const asProb = 'A performance index of 118 implies a 62% chance he beats the number.';
    ok('turning the index into a probability is a FAIL',
      H.criticExtras({ result: res1, answer: asProb }).some(f => f.code === 'MLBHIST_RATING_AS_PROBABILITY'));

    const picked = 'Luis Garcia pitched for the Angels and the Red Sox in 2024.';
    ok('silently resolving an ambiguous name is a FAIL',
      H.criticExtras({ result: res2, answer: picked }).some(f => f.code === 'MLBHIST_AMBIGUITY_RESOLVED_IN_PROSE'),
      JSON.stringify(H.criticExtras({ result: res2, answer: picked })));
    ok('…but asking which one is fine',
      !H.criticExtras({ result: res2, answer: 'Two pitchers share that name in this archive — which do you mean?' })
        .some(f => f.code === 'MLBHIST_AMBIGUITY_RESOLVED_IN_PROSE'));

    const asContract = 'He signed with the Red Sox in July 2024 and was under contract through the season.';
    ok('reading observed seasons as a contract is a WARN',
      H.criticExtras({ result: res2b, answer: asContract }).some(f => f.code === 'MLBHIST_TENURE_AS_CONTRACT'));

    const silent = 'Cole has been excellent over the period.';
    const down = { unavailable: 'the archive could not be read', coverage: null, sections: [], resolution: [] };
    ok('answering anyway when retrieval failed is a FAIL',
      H.criticExtras({ result: down, answer: silent }).some(f => f.code === 'MLBHIST_INVENTED_ON_FAILURE'));
    ok('…and saying it could not be read is not',
      !H.criticExtras({ result: down, answer: 'EdgeDesk could not read the historical archive on this turn.' })
        .some(f => f.code === 'MLBHIST_INVENTED_ON_FAILURE'));

    const strayNumber = 'His 2024 ERA was 9.87 across the window.';
    ok('a number that was never retrieved is flagged',
      H.criticExtras({ result: res1, answer: strayNumber }).some(f => f.code === 'MLBHIST_NUMBER_NOT_RETRIEVED'));

    /* ── an outage is reported, never papered over ───────────────────────── */
    const broken = M.createService({ read: () => { throw new Error('db 503'); } });
    const resDown = await H.retrieve({ plan: plan1, service: broken });
    ok('an archive outage produces an explicit failure', !!resDown.unavailable);
    const blockDown = H.promptBlock(resDown);
    ok('…and the block forbids answering from memory',
      /do not answer the historical question from memory/i.test(blockDown), blockDown.slice(0, 300));

  } catch (e) {
    fail++;
    console.log('  FAIL harness — ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e));
  } finally {
    db.close();
    PG.dropDatabase(conn, DB);
  }

  console.log('');
  if (fail) { console.log(`FAILED mlb history — ${pass} passed, ${fail} failed`); process.exit(1); }
  console.log(`ALL GREEN mlb history — ${pass} checks`);
})();
