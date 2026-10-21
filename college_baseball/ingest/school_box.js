#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk college baseball — starters, lineups and weather from the
   schools' own box scores (the collegiate collector: collegiate/data/
   boxscores/baseball/<season>/<school>.jsonl.gz), joined to our contests.

     node college_baseball/ingest/school_box.js build --season 2019
     node college_baseball/ingest/school_box.js audit --season 2024

   THE JOIN. A school's box score names both teams by their NCAA codes, the
   ids our record uses, so a box joins a contest by (date, the two teams);
   a doubleheader's two boxes pair with our two contests in order (the box's
   doubleheader game number, else the order read). A box whose teams or date
   match no contest is counted and left out, never forced onto one.

   OUT: data/school_box/<season>.csv, one row per contest side:
     game_id, team_id, side, starter, starter_throws, starter_outs,
     starter_bf, starter_k, starter_bb, starter_pitches, opp_lineup_bats
     (the opposing starting nine's bats, spot order, e.g. RLRRSRRLR),
     opp_lefty_bats (L and S), temp_f, wind_dir, wind_mph, attendance,
     source (the box's address).
   audit: for 2024-2026, where our record has its own box scores, how often
   the schools' starter is ours (by name) and their outs agree.

   HANDS. A newer SIDEARM box gives each player's throwing hand and bats. An
   older SIDEARM box gives none, but links the school's own players to its
   roster page; the roster (collegiate/data/rosters) lists bats/throws, and
   the link's name slug is the roster player's id there, an exact join. The
   opponent's players carry no link and keep no hand from it.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readCsv, toCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
const BOX = path.join(ROOT, 'collegiate', 'data', 'boxscores', 'baseball');
const GAMES = path.join(__dirname, '..', 'data', 'games');
const OUT = path.join(__dirname, '..', 'data', 'school_box');
const OURS = path.join(__dirname, '..', 'data', 'box');
const ROSTERS = path.join(ROOT, 'collegiate', 'data', 'rosters', 'baseball');

const HEADER = ['game_id', 'season', 'date', 'team_id', 'side', 'starter', 'starter_throws', 'starter_outs', 'starter_bf', 'starter_k', 'starter_bb', 'starter_pitches',
  'opp_lineup_bats', 'opp_lefty_bats', 'temp_f', 'wind_dir', 'wind_mph', 'attendance', 'source'];

const readLines = (f) => { try { return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const pairKey = (date, a, b) => date + '|' + [String(a), String(b)].sort().join('~');
const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z]/g, '');

/* every box held for a season, once per game (two schools may both hold one) */
function boxes(season, o) {
  const dir = path.join((o && o.boxDir) || BOX, String(season));
  const seen = new Set(); const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
    for (const b of readLines(path.join(dir, f))) {
      if (!b.date || !b.home || !b.away || !b.home.code || !b.away.code) continue;
      const k = pairKey(b.date, b.home.code, b.away.code) + '|' + (b.doubleheader_game || 0) + '|' + b.home.runs + '-' + b.away.runs;
      if (seen.has(k)) continue;
      seen.add(k); out.push(b);
    }
  }
  return out;
}

/* an older SIDEARM box's school-side hands from the school's roster, by the roster slug the box links (the last
   element of a pitcher [.., slug] and a lineup [.., slug] row) */
function rosterHands(b, season, o) {
  if (b.platform !== 'sidearm_legacy' || !b.school) return b;
  const f = path.join((o && o.rostersDir) || ROSTERS, String(season), b.school + '.json');
  let roster = null; try { roster = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return b; }
  const bySlug = new Map((roster.players || []).filter((p) => /^slug:/.test(p.pid)).map((p) => [p.pid.slice(5), p]));
  const fill = (t) => {
    const pit = (r) => { const p = r && r[9] && bySlug.get(r[9]); return p && !r[1] && p.throws ? Object.assign([], r, { 1: p.throws }) : r; };
    return Object.assign({}, t, { starter: pit(t.starter), pitchers: (t.pitchers || []).map(pit),
      lineup: (t.lineup || []).map((l) => { const p = l[4] && bySlug.get(l[4]); return p && !l[3] && p.bats ? Object.assign([], l, { 3: p.bats }) : l; }) });
  };
  return Object.assign({}, b, { home: fill(b.home), away: fill(b.away) });
}

function sideRow(c, team, opp, side, b) {
  const st = team.starter || null;   /* [name, throws, outs, bf, k, bb, h, er, pitches] */
  const bats = (opp.lineup || []).slice().sort((x, y) => x[0] - y[0]).map((l) => l[3] || '?').join('');
  return { game_id: c.game_id, season: c.season, date: c.date, team_id: team.code, side, starter: st ? st[0] : '', starter_throws: st ? st[1] || '' : '',
    starter_outs: st && st[2] != null ? st[2] : '', starter_bf: st && st[3] != null ? st[3] : '', starter_k: st && st[4] != null ? st[4] : '', starter_bb: st && st[5] != null ? st[5] : '',
    starter_pitches: st && st[8] != null ? st[8] : '', opp_lineup_bats: bats.length === 9 ? bats : '', opp_lefty_bats: bats.length === 9 ? (bats.match(/[LS]/g) || []).length : '',
    temp_f: b.weather && b.weather.temp_f != null ? b.weather.temp_f : '', wind_dir: (b.weather && b.weather.wind_dir) || '', wind_mph: b.weather && b.weather.wind_mph != null ? b.weather.wind_mph : '',
    attendance: b.attendance != null ? b.attendance : '', source: b.url || '' };
}

function build(season, o) {
  o = o || {};
  const games = readCsv(o.gamesFile || path.join(GAMES, season + '.csv')).rows.filter((g) => g.status === 'FINAL');
  const ours = new Map();
  for (const g of games) { const k = pairKey(g.date, g.home_id, g.away_id); if (!ours.has(k)) ours.set(k, []); ours.get(k).push(g); }
  for (const list of ours.values()) list.sort((a, b) => (a.start_time_local || '').localeCompare(b.start_time_local || '') || a.game_id.localeCompare(b.game_id));
  const byPair = new Map();
  for (const raw of boxes(season, o)) { const b = rosterHands(raw, season, o); const k = pairKey(b.date, b.home.code, b.away.code); if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(b); }
  const rows = []; const counts = { boxes: 0, joined: 0, no_contest: 0, score_differs: 0 };
  for (const [k, bs] of byPair) {
    counts.boxes += bs.length;
    const cs = ours.get(k);
    if (!cs) { counts.no_contest += bs.length; continue; }
    bs.sort((a, b) => (a.doubleheader_game || 0) - (b.doubleheader_game || 0));
    bs.forEach((b, i) => {
      if (i >= cs.length) { counts.no_contest++; return; }
      const c = cs[i];
      /* the box's sides in our contest's terms: our home team may be the box's visitor on a neutral site */
      const homeIsHome = String(b.home.code) === String(c.home_id);
      const H = homeIsHome ? b.home : b.away; const A = homeIsHome ? b.away : b.home;
      if (+c.home_runs !== H.runs || +c.away_runs !== A.runs) { counts.score_differs++; return; }
      counts.joined++;
      rows.push(sideRow(c, H, A, 'H', b), sideRow(c, A, H, 'A', b));
    });
  }
  if (o.write !== false && rows.length) { fs.mkdirSync(o.outDir || OUT, { recursive: true }); fs.writeFileSync(path.join(o.outDir || OUT, season + '.csv'), toCsv(HEADER, rows)); }
  return { season, counts, contests: games.length, coverage: games.length ? +(counts.joined / games.length).toFixed(4) : 0, rows };
}

/* the schools' starters against our own box scores (2024-2026) */
function audit(season, o) {
  o = o || {};
  const b = build(season, Object.assign({}, o, { write: false }));
  const f = path.join(o.oursDir || OURS, season + '_pitchers.csv.gz');
  if (!fs.existsSync(f)) return { season, error: 'no box scores of our own for ' + season };
  const starters = new Map();
  for (const r of readCsv(f).rows) if (r.starter === '1') starters.set(r.game_id + '|' + r.team_id, r);
  let same = 0, differ = 0, outsSame = 0, compared = 0; const examples = [];
  for (const r of b.rows) {
    const s = starters.get(r.game_id + '|' + r.team_id);
    if (!s || !r.starter) continue;
    compared++;
    if (normName(s.name) === normName(r.starter)) { same++; if (String(s.outs) === String(r.starter_outs)) outsSame++; } else { differ++; if (examples.length < 20) examples.push({ game_id: r.game_id, team_id: r.team_id, ours: s.name, schools: r.starter }); }
  }
  return { season, compared, starter_agreement: compared ? +(same / compared).toFixed(4) : null, outs_agreement: same ? +(outsSame / same).toFixed(4) : null, differ, examples, coverage: b.coverage, counts: b.counts };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const season = +(a[a.indexOf('--season') + 1]);
  if (!['build', 'audit'].includes(a[0]) || !season) { console.error('usage: school_box.js build|audit --season YYYY'); process.exit(2); }
  const r = a[0] === 'build' ? build(season) : audit(season);
  delete r.rows;
  console.error('[school box] ' + a[0] + ' ' + season + ': ' + JSON.stringify(r));
}
module.exports = { build, audit, boxes, rosterHands, HEADER };
