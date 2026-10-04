#!/usr/bin/env node
/* ============================================================================
   END-TO-END VERIFICATION — several real games, read the way a reader reads.

   Not a test. A test says a rule held; this prints what EdgeDesk actually
   says about specific games so a person can look at it and disagree. One
   game from each tier the board covers, because they fail differently:

     NFL           a league with a depth chart and a filed injury report
     Power 4       two rated programmes, full contract
     other FBS     two rated programmes, thinner evidence
     FBS vs FCS    half the matchup is outside the rated universe

     node tools/football/verify_games.js [--season 2026] [--game ID]...
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
const PK = require(path.join(ROOT, 'football', 'matchup', 'packet.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
const L = console.log;
function rule(t) { L(''); L('─'.repeat(78)); L(t); L('─'.repeat(78)); }

async function main() {
  const season = +(arg('season', defaultSeason()));
  const want = [];
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--game') want.push(String(process.argv[i + 1]));

  const cacheFile = path.join(ROOT, 'football', 'fbs', '.cache', `cfb_schedules_${season}.csv`);
  let text = null;
  try { text = await BC.loadSeason(season, true); } catch (_) { /* fall through */ }
  if (!text && fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8');
  if (!text) { console.error('no schedule feed'); return 2; }
  const rows = BC.normRows(BC.parseCsv(text));
  const universe = FBS.buildUniverse({ rows, season, params: P, knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const { st } = BC.buildState({ [season]: rows }, season);
  const built = FBS.buildSlate({ rows, universe, now: Date.now(), lookaheadDays: 10 });
  const ictx = IN.load({ season, params: P, normKey: FBS.normKey });
  const si = IN.scheduleIndex(rows, st.r);

  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  const week = slate ? (slate.games[0] || {}).week : null;
  const mk = readJson(path.join(ROOT, 'articles', 'data', 'market',
    `${season}-week-${String(week == null ? 0 : week).padStart(2, '0')}.json`), null);
  const quotes = [];
  ((mk && mk.quotes) || []).forEach(q => {
    if (q.spread) quotes.push({ game_id: q.game_id, sport: q.sport, market: 'spreads', selection: q.spread.selection,
      side: q.spread.side, point: q.spread.point, book: q.spread.book, best_dec: q.spread.odds_decimal,
      captured_at: q.captured_at, kickoff: q.kickoff, snapshot_kind: 'EDITION' });
  });
  const pctx = PK.loadContext({ season, params: P, quotes });

  /* pick one game per tier unless the caller named them */
  let picks = [];
  if (want.length) picks = built.items.filter(it => want.indexOf(String(it.g.game_id)) >= 0);
  else {
    const byTier = { p4: null, other: null, fcs: null };
    built.items.forEach(it => {
      const m = it.meta;
      if (m.fbs_sides !== 2) { if (!byTier.fcs) byTier.fcs = it; return; }
      if (m.home.group === 'p4' && m.away.group === 'p4') { if (!byTier.p4) byTier.p4 = it; return; }
      if (!byTier.other) byTier.other = it;
    });
    picks = [byTier.p4, byTier.other, byTier.fcs].filter(Boolean);
    const lsu = built.items.filter(it => String(it.g.game_id) === '401856688')[0];
    if (lsu && picks.indexOf(lsu) < 0) picks.unshift(lsu);
  }

  for (const it of picks) {
    const asm = IN.buildRequest(ictx, { game: it.g, meta: it.meta, state: st, schedule_index: si, now: Date.now() });
    const proj = E.projectGame(asm.baseline);
    const row = (slate && slate.games.filter(g => String(g.game_id) === String(it.g.game_id))[0]) || null;
    if (!row) continue;
    const pk = PK.build({ context: pctx, row, projection: proj, now: Date.now() });

    rule(`${row.away_team} at ${row.home_team}  ·  ${row.matchup_type}  ·  ${row.kickoff}`);
    L(`  card              ${row.home_conference} vs ${row.away_conference} · ${row.home_fbs_group}/${row.away_fbs_group} · week ${row.week}`);
    L(`  model             ${row.home_team} ${row.model_home_line > 0 ? '+' : ''}${row.model_home_line}, total ${row.model_fair_total}`);
    if (pk.market.home_line != null) {
      L(`  market            ${row.home_team} ${pk.market.home_line > 0 ? '+' : ''}${pk.market.home_line}`
        + `  [${pk.market.current.book || 'no book'} · ${pk.market.current.freshness}]`);
      L(`                    ${pk.market.current.freshness_why}`);
    } else L('  market            no comparable quote joined to this game');
    L('');
    L('  INPUT CONTRACT');
    L(`    coverage        ${Math.round((row.input_coverage || 0) * 100)}% of applicable fields retrieved · `
      + `${Math.round((row.priced_input_coverage || 0) * 100)}% priced · engine completeness ${row.data_completeness}`);
    const byState = {};
    (row.input_contract || []).forEach(c => { (byState[c.state] = byState[c.state] || []).push(c.field + (c.side ? '/' + c.side : '')); });
    Object.keys(byState).forEach(s => L(`    ${s.padEnd(15)} ${byState[s].join(', ')}`));
    L('');
    L('  STARTERS');
    ['home', 'away'].forEach(side => {
      const s = pk.starters[side];
      const team = side === 'home' ? row.home_team : row.away_team;
      if (!s) { L(`    ${team.padEnd(22)} no starter record`); return; }
      L(`    ${team.padEnd(22)} ${s.label}`);
      L(`    ${''.padEnd(22)} status ${s.status} · confirmed ${s.confirmed} · priced ${s.priced}`);
      if (s.experience) L(`    ${''.padEnd(22)} ${s.experience.starts} start(s), ${s.experience.dropbacks} dropbacks in ${s.experience.seasons_read.join('+')}`);
      if (s.history && s.history.length) {
        const h = s.history[s.history.length - 1];
        L(`    ${''.padEnd(22)} last: wk${h.week} vs ${h.opponent} — ${h.why}`);
      }
      const av = pk.availability[side];
      if (av) L(`    ${''.padEnd(22)} availability ${av.state} — ${av.why}`);
      if (s.conflicts && s.conflicts.length) L(`    ${''.padEnd(22)} ${s.conflicts.length} source(s) name somebody else`);
      L(`    ${''.padEnd(22)} source ${s.source_url || 'n/a'}`);
    });
    L('');
    L('  ARITHMETIC (home margin; positive favours the home side)');
    if (pk.model.arithmetic.available) {
      pk.model.arithmetic.steps.forEach(s => {
        L(`    ${String(s.points > 0 ? '+' + s.points : s.points).padStart(7)}  =${String(s.running_total).padStart(7)}  ${s.label}`
          + (s.applied ? '' : `  [not applied: ${String(s.why_absent).slice(0, 60)}]`));
      });
      L(`    ${''.padStart(7)}   ${String(pk.model.arithmetic.published_home_margin).padStart(7)}  published — ${pk.model.arithmetic.note}`);
    }
    L('');
    L('  RANKING vs PROJECTION');
    if (pk.ratings.available) {
      const r = pk.ratings;
      L(`    ranking       ${r.published_ranking.home.team} ${r.published_ranking.home.etsr} (#${r.published_ranking.home.rank} of ${r.published_ranking.home.ranked_of}) `
        + `vs ${r.published_ranking.away.team} ${r.published_ranking.away.etsr} (#${r.published_ranking.away.rank} of ${r.published_ranking.away.ranked_of})`);
      L(`    projection    seed ${r.game_model.home_seed} vs ${r.game_model.away_seed} · home margin ${r.game_model.home_margin}`);
      wrap('    ', r.read);
    } else L('    ' + pk.ratings.why);
    L('');
    L('  DISAGREEMENT');
    if (pk.disagreement.state === 'COMPARED') {
      const d = pk.disagreement;
      L(`    gap ${d.gap_points} points · band ${d.band} · priority ${d.priority}`);
      wrap('    basis: ', d.priority_basis);
      L(`    verdict ${d.questions.verdict}`);
      wrap('      ', d.questions.verdict_why);
      (d.questions.contradicting_evidence || []).forEach(e => wrap('    against: ', e.claim));
      (d.questions.missing_facts_that_would_change_it || []).slice(0, 3).forEach(u => wrap('    unknown: ', u.fact));
      (d.questions.how_each_side_wins || []).slice(0, 3).forEach(p => wrap('    route:   ', p.side + ' — ' + p.read));
    } else L('    ' + pk.disagreement.why);
    L('');
    L('  FOOTBALL (measured this season, not opponent-adjusted)');
    (pk.football.pairings || []).filter(p => p.state === 'MEASURED').slice(0, 4).forEach(p => wrap('    ', p.read));
    (pk.football.pairings || []).filter(p => p.state === 'THIN').slice(0, 2).forEach(p => wrap('    [thin] ', p.read));
    const us = pk.football.unit_standing.home_qb_room_vs_away_secondary;
    if (us) wrap('    ', us.read);
    L('');
    L('  LIMITS');
    pk.limits.slice(0, 6).forEach(l => wrap('    - ', l));
  }
  L('');
  return 0;
}

function wrap(prefix, text, width) {
  width = width || 74;
  const words = String(text == null ? '' : text).split(/\s+/);
  let line = '';
  const pad = ' '.repeat(prefix.length);
  let first = true;
  words.forEach(w => {
    if ((line + ' ' + w).length > width) { L((first ? prefix : pad) + line); line = w; first = false; }
    else line = line ? line + ' ' + w : w;
  });
  if (line) L((first ? prefix : pad) + line);
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error((e && e.stack) || e); process.exit(2); });
}
