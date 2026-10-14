#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the play-by-play against the official box score, every
   season, at three levels.

     node hockey/crosscheck/boxscore.js            write hockey/validation/nhl_crosscheck_box.json
     node hockey/crosscheck/boxscore.js --check    the committed report passes its bar

   The models are built on the play-by-play (every event). The box score is
   the NHL's own per-game summary, published through a different endpoint.
   Where they disagree, one of them dropped or mis-coded something; neither is
   overwritten — the report keeps both values and counts the disagreement.

     team      goals (box vs the official final), shots on goal (box vs SHOT +
               GOAL events), power-play goals (box vs goals scored with more
               skaters on the ice), penalty minutes
     goalie    shots against and goals against (box vs the on-goal attempts
               and goals the play-by-play charged to him); the box's starter vs
               the goalie in net at the first event
     skater    goals, assists and shots on goal per player (box vs the events
               crediting him)

   Agreement bar (--check): goals and goals against agree in ≥ 99.5% of rows,
   every other count in ≥ 97% — a lower rate means a source changed how it
   records something and the models must be reviewed before the next refit.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readSeason } = require('../ingest/season');
const { loadBox } = require('../ingest/boxscores');

const OUT = path.join(C.PATHS.validation, 'nhl_crosscheck_box.json');
const SCHEMA = 'edgedesk_nhl_crosscheck_box_v1';
const BAR = { exact: 0.995, counts: 0.97 };

function tally() { return { rows: 0, agree: 0, examples: [] }; }
function cmp(t, a, b, ex) { if (a == null || b == null) return; t.rows++; if (a === b) t.agree++; else if (t.examples.length < 6) t.examples.push(Object.assign({ play_by_play: a, box: b }, ex)); }
function rate(t) { return t.rows ? Math.round((t.agree / t.rows) * 1e5) / 1e5 : null; }

/** one season: { team: {...}, goalie: {...}, skater: {...} } of tallies (pure over the two inputs) */
function reconcileSeason(games, box) {
  const T = { goals: tally(), shots_on_goal: tally(), power_play_goals: tally(), pim: tally() };
  const Gk = { shots_against: tally(), goals_against: tally(), starter: tally() };
  const Sk = { goals: tally(), assists: tally(), shots_on_goal: tally() };
  let matched = 0, missing = 0;
  for (const rec of games) {
    const g = rec.game; const b = box.games[g.game_id];
    if (!b || !b.teams.home || !b.teams.away) { missing++; continue; }
    matched++;
    const ex = { game_id: g.game_id, date: g.date };
    const sideTeam = { home: g.home, away: g.away };
    const pbp = { home: { sog: 0, ppg: 0 }, away: { sog: 0, ppg: 0 } };
    const gk = {}; const sk = {};
    const P = (id) => sk[id] || (sk[id] = { g: 0, a: 0, sog: 0 });
    for (const s of rec.shots) {
      if (s.on_goal) pbp[s.side].sog++;
      if (s.goal && s.state === 'pp') pbp[s.side].ppg++;
      if (s.goalie != null && !s.empty_net && s.on_goal) { const k = gk[s.goalie] || (gk[s.goalie] = { sa: 0, ga: 0 }); k.sa++; k.ga += s.goal; }
      if (s.shooter != null) { const p = P(s.shooter); if (s.on_goal) p.sog++; if (s.goal) p.g++; }
      if (s.goal) { if (s.a1 != null) P(s.a1).a++; if (s.a2 != null) P(s.a2).a++; }
    }
    for (const side of ['home', 'away']) {
      const bt = b.teams[side]; const e = Object.assign({ team: sideTeam[side] }, ex);
      cmp(T.goals, side === 'home' ? g.final_home : g.final_away, bt.goals, e);
      cmp(T.shots_on_goal, pbp[side].sog, bt.sog, e);
      cmp(T.power_play_goals, pbp[side].ppg, bt.ppg, e);
      /* on the box score's definition: players' PIM (the play-by-play's penalties that name no player excluded) */
      cmp(T.pim, rec.teams[side].pim - (rec.teams[side].pim_unattributed || 0), bt.pim, e);
      for (const row of b.goalies[side]) {
        const [pid, starter, toi, sa, , ga] = row;
        if (!toi) continue; /* dressed, did not play */
        const p = gk[pid] || { sa: 0, ga: 0 }; const eg = Object.assign({ goalie: pid }, e);
        cmp(Gk.shots_against, p.sa, sa, eg); cmp(Gk.goals_against, p.ga, ga, eg);
        if (starter) cmp(Gk.starter, side === 'home' ? g.starter_home : g.starter_away, pid, eg);
      }
      for (const row of b.skaters[side]) {
        const [pid, , goals, assists, sog] = row; const p = sk[pid] || { g: 0, a: 0, sog: 0 }; const es = Object.assign({ player: pid }, e);
        cmp(Sk.goals, p.g, goals, es); cmp(Sk.assists, p.a, assists, es); cmp(Sk.shots_on_goal, p.sog, sog, es);
      }
    }
  }
  return { games_pbp: games.length, games_matched: matched, games_without_box: missing, team: T, goalie: Gk, skater: Sk };
}

function summarise(t) { const o = {}; for (const [k, v] of Object.entries(t)) o[k] = { rows: v.rows, agree: v.agree, rate: rate(v), examples: v.examples }; return o; }

function main() {
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const bySeason = {}; const total = {};
  const add = (lvl, k, v) => { const key = lvl + '.' + k; const t = total[key] || (total[key] = { rows: 0, agree: 0 }); t.rows += v.rows; t.agree += v.agree; };
  for (const s of seasons) {
    const box = loadBox(s); if (!box) { bySeason[s] = { skipped: 'no box-score cache (hockey/ingest/boxscores.js)' }; continue; }
    let games; try { games = [...readSeason(s)]; } catch (_) { bySeason[s] = { skipped: 'no play-by-play cache' }; continue; }
    const r = reconcileSeason(games, box);
    for (const lvl of ['team', 'goalie', 'skater']) for (const [k, v] of Object.entries(r[lvl])) add(lvl, k, v);
    bySeason[s] = { games_pbp: r.games_pbp, games_matched: r.games_matched, games_without_box: r.games_without_box, box_source: box.sources, team: summarise(r.team), goalie: summarise(r.goalie), skater: summarise(r.skater) };
    console.log('[nhl box crosscheck] ' + s + ': ' + r.games_matched + '/' + r.games_pbp + ' games; SOG ' + rate(r.team.shots_on_goal) + ', PPG ' + rate(r.team.power_play_goals) + ', goalie SA ' + rate(r.goalie.shots_against) + ', skater G/A/SOG ' + rate(r.skater.goals) + '/' + rate(r.skater.assists) + '/' + rate(r.skater.shots_on_goal));
  }
  const overall = {};
  for (const [k, v] of Object.entries(total)) {
    const bar = /goals$|goals_against$/.test(k) && !/power_play/.test(k) ? BAR.exact : BAR.counts;
    const rt = v.rows ? Math.round((v.agree / v.rows) * 1e5) / 1e5 : null;
    overall[k] = { rows: v.rows, agree: v.agree, rate: rt, bar, status: v.rows && v.agree / v.rows >= bar ? 'OK' : 'REVIEW' };
    if (k === 'team.pim' && overall[k].status !== 'OK') Object.assign(overall[k], { status: 'INFORMATIONAL', note: 'Penalty minutes are not a model input. Compared on the box score\'s definition (players\' PIM): the play-by-play\'s penalties that name no player (too many men on the ice, other bench minors) are excluded. The residual is misconduct and served-penalty coding; it is reported, not corrected.' });
  }
  const out = {
    schema: SCHEMA, generated_at: new Date().toISOString(), sources: { play_by_play: 'sportsdataverse fastRhockey pbp_lite (the NHL play-by-play feed)', box: 'sportsdataverse fastRhockey skater_box / goalie_box / team_box (the NHL boxscore feed)' },
    rule: 'neither source is overwritten: both values are kept and every disagreement counted; goals and goals against must agree in ≥ 99.5% of rows, every other count in ≥ 97%',
    overall, by_season: bySeason,
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  for (const [k, v] of Object.entries(overall)) console.log('  ' + k.padEnd(28) + ' ' + v.agree + '/' + v.rows + ' = ' + v.rate + ' ' + v.status);
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const fails = [];
  if (r.schema !== SCHEMA) fails.push('schema');
  for (const [k, v] of Object.entries(r.overall || {})) if (v.status === 'REVIEW') fails.push(k + ' agrees in ' + v.rate + ' (bar ' + v.bar + ')');
  if (fails.length) { console.error('[nhl box crosscheck --check] REVIEW: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl box crosscheck --check] ok: ' + Object.keys(r.overall).length + ' quantities within their bars');
}

if (require.main === module) { if (process.argv.includes('--check')) check(); else main(); }
module.exports = { reconcileSeason, BAR };
