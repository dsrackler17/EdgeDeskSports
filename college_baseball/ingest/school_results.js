#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk college baseball — results from the schools' own schedule pages
   (the collegiate collector: collegiate/data/schedules/baseball/<season>/).

     node college_baseball/ingest/school_results.js audit --season 2024
     node college_baseball/ingest/school_results.js fill  --season 2023 [--apply]

   WHY. Our 2023 source stops reporting results on 2023-03-29: 6,515 D-I
   contests are scheduled with no result (research/DATA_QUALITY.md DQ-06,
   "a SOURCE gap, recorded, not filled"). Every school publishes its own
   results; read from both schools of a contest, they fill the gap with the
   two programs' own word for the score.

   THE JOIN. A school's row is (date, its team, the opponent, home/away/
   neutral, its runs, the opponent's runs). The school is our team through
   the registry (collegiate/data/schools.json: baseball_team_id); the
   opponent through its website where the school lists one (SIDEARM: an
   exact join), else through its name against our NCAA names for that
   season. A contest is (date, the two teams); a doubleheader's games are
   paired in the order the schools list them.

   THE RULE. audit: for contests our record already has, how often the
   schools' score agrees with ours (the source earns its use there first).
   fill: a NO_RESULT contest gets a score only when
     - both schools list it and their scores agree (quality SCHOOL_SITES_BOTH), or
     - one school lists it and the other's page was read and does not
       contradict it, or was not read (SCHOOL_SITE_ONE),
   with the home side as our record has it. Schools that disagree leave the
   contest without a result, with both readings in the report. --apply
   writes the filled rows into data/games/<season>.csv, sources +=
   "school_sites", and the report to data/reports/school_results_<season>.json.
   Nothing else in the row changes.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
const COLL = path.join(ROOT, 'collegiate', 'data');
const GAMES = path.join(__dirname, '..', 'data', 'games');
const TEAMS = path.join(__dirname, '..', 'data', 'teams', 'team_seasons.csv');
const REPORTS = path.join(__dirname, '..', 'data', 'reports');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const keyName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\bst\b\.?/g, 'state').replace(/\buniv(ersity)?\b|\bof\b|\bthe\b/g, '').replace(/[^a-z0-9]/g, '');

/* the schools' rows for a season, as (date, team, opp, home/away/neutral, runs) in our team ids */
function schoolRows(season, o) {
  o = o || {};
  const dir = o.collegiate || COLL;
  const reg = readJson(path.join(dir, 'schools.json'), { schools: [] }).schools || [];
  const teamOf = new Map(reg.filter((s) => s.baseball_team_id).map((s) => [s.id, String(s.baseball_team_id)]));
  const byHost = new Map(reg.filter((s) => s.host && s.baseball_team_id).map((s) => [s.host, String(s.baseball_team_id)]));
  /* names: our NCAA names for this season, then the registry's */
  const byName = new Map();
  const ts = o.teamSeasons || readCsv(TEAMS).rows.filter((t) => +t.season === season);
  for (const t of ts) byName.set(keyName(t.name), String(t.team_id));
  for (const s of reg) if (s.baseball_team_id) for (const n of [s.name, s.full_name, s.ncaa_name]) if (n && !byName.has(keyName(n))) byName.set(keyName(n), String(s.baseball_team_id));
  const sdir = path.join(dir, 'schedules', 'baseball', String(season));
  const rows = []; const unmatched = {}; const read = new Set();
  if (!fs.existsSync(sdir)) return { rows, unmatched, read };
  for (const f of fs.readdirSync(sdir).filter((x) => x.endsWith('.json'))) {
    const doc = readJson(path.join(sdir, f), null);
    const team = doc && teamOf.get(doc.school);
    if (!team) continue;
    read.add(team);
    let seq = 0;
    for (const g of doc.games || []) {
      seq++;
      const opp = (g.opponent_host && byHost.get(g.opponent_host)) || byName.get(keyName(g.opponent)) || null;
      if (!opp) { unmatched[g.opponent] = (unmatched[g.opponent] || 0) + 1; continue; }
      rows.push({ team, opp, date: g.date, site: g.site, status: g.status, us: g.us, them: g.them, innings: g.innings, seq, school: doc.school, time: g.time || '' });
    }
  }
  return { rows, unmatched, read };
}

const pairKey = (date, a, b) => date + '|' + [a, b].sort().join('~');

/* the schools' readings of each contest: { key -> [{ from, home_id?, home_runs, away_runs, innings }] } in our home/away terms later */
function readingsByContest(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = pairKey(r.date, r.team, r.opp);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return by;
}

/* one school's reading in a contest's terms: runs for each of our two team ids */
const runsOf = (r) => (r.status === 'final' ? { [r.team]: r.us, [r.opp]: r.them } : null);

/* contests of one date and pair, in our record's order; readings of each school in its own listed order */
function assign(contests, readings) {
  const bySchool = new Map();
  for (const r of readings) { if (!bySchool.has(r.team)) bySchool.set(r.team, []); bySchool.get(r.team).push(r); }
  for (const list of bySchool.values()) list.sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.seq - b.seq);
  return contests.map((c, i) => [...bySchool.entries()].map(([team, list]) => ({ team, r: list[i] || null })).filter((x) => x.r));
}

function judge(c, readings, read) {
  const finals = readings.filter((x) => x.r.status === 'final');
  const sides = [c.home_id, c.away_id];
  const scores = finals.map((x) => { const m = runsOf(x.r); return { from: x.team, home: m[c.home_id], away: m[c.away_id], innings: x.r.innings }; });
  if (!scores.length) {
    const none = readings.find((x) => x.r.status === 'cancelled' || x.r.status === 'postponed');
    return { decision: none ? 'SCHOOLS_SAY_' + none.r.status.toUpperCase() : 'NO_READING', scores };
  }
  const agree = scores.every((s) => s.home === scores[0].home && s.away === scores[0].away);
  if (!agree) return { decision: 'SCHOOLS_DISAGREE', scores };
  if (scores.length >= 2) return { decision: 'SCHOOL_SITES_BOTH', home_runs: scores[0].home, away_runs: scores[0].away, innings: scores.find((s) => s.innings) ? scores.find((s) => s.innings).innings : null, scores };
  /* one school's word: the other side must be unread, or read and silent on this game (not contradicting it) */
  const other = sides.find((t) => t !== scores[0].from);
  const otherContradicts = readings.some((x) => x.team === other && x.r.status !== 'final');
  if (otherContradicts) return { decision: 'OTHER_SCHOOL_DIFFERS', scores };
  return { decision: 'SCHOOL_SITE_ONE', home_runs: scores[0].home, away_runs: scores[0].away, innings: scores[0].innings, scores, other_read: read.has(other) };
}

function run(mode, season, o) {
  o = o || {};
  const file = o.gamesFile || path.join(GAMES, season + '.csv');
  const { header, rows: games } = readCsv(file);
  const { rows, unmatched, read } = schoolRows(season, o);
  const by = readingsByContest(rows);
  /* our contests by date and pair, in id order (a doubleheader's _1 before _2) */
  const ours = new Map();
  for (const g of games) { const k = pairKey(g.date, g.home_id, g.away_id); if (!ours.has(k)) ours.set(k, []); ours.get(k).push(g); }
  for (const list of ours.values()) list.sort((a, b) => (a.start_time_local || '').localeCompare(b.start_time_local || '') || a.game_id.localeCompare(b.game_id));
  const out = { schema: 'edgedesk_cbase_school_results_v1', mode, season, at: new Date().toISOString(), schools_read: read.size, school_rows: rows.length,
    unmatched_opponents: Object.entries(unmatched).sort((a, b) => b[1] - a[1]).slice(0, 40), counts: {}, filled: [], disagreements: [] };
  const count = (k) => { out.counts[k] = (out.counts[k] || 0) + 1; };
  let changed = 0;
  for (const [k, contests] of ours) {
    const rs = by.get(k);
    if (!rs) { for (const c of contests) count(c.status === 'FINAL' ? 'final_not_read' : 'no_result_not_read'); continue; }
    const per = assign(contests, rs);
    contests.forEach((c, i) => {
      const j = judge(c, per[i], read);
      if (mode === 'audit') {
        if (c.status !== 'FINAL') return;
        if (j.decision === 'SCHOOL_SITES_BOTH' || j.decision === 'SCHOOL_SITE_ONE') {
          const same = +c.home_runs === j.home_runs && +c.away_runs === j.away_runs;
          count(same ? 'audit_agree' : 'audit_differ');
          if (!same && out.disagreements.length < 60) out.disagreements.push({ game_id: c.game_id, date: c.date, ours: [c.home_runs, c.away_runs], schools: j.scores });
        } else count('audit_' + j.decision.toLowerCase());
        return;
      }
      if (c.status !== 'NO_RESULT') return;
      count(j.decision.toLowerCase());
      if (j.decision === 'SCHOOL_SITES_BOTH' || j.decision === 'SCHOOL_SITE_ONE') {
        out.filled.push({ game_id: c.game_id, date: c.date, home_id: c.home_id, away_id: c.away_id, home_runs: j.home_runs, away_runs: j.away_runs, innings: j.innings, quality: j.decision, from: j.scores.map((s) => s.from) });
        if (o.apply) {
          c.status = 'FINAL'; c.home_runs = String(j.home_runs); c.away_runs = String(j.away_runs);
          if (j.innings) c.innings_played = String(j.innings);
          c.sources = c.sources ? c.sources + '+school_sites' : 'school_sites';
          c.quality_notes = (c.quality_notes ? c.quality_notes + '; ' : '') + 'result from the schools\' own sites (' + j.decision + ')';
          changed++;
        }
      } else if (j.decision === 'SCHOOLS_DISAGREE' && out.disagreements.length < 200) out.disagreements.push({ game_id: c.game_id, date: c.date, schools: j.scores });
    });
  }
  if (mode === 'audit') { const a = out.counts.audit_agree || 0, d = out.counts.audit_differ || 0; out.agreement = a + d ? +(a / (a + d)).toFixed(4) : null; }
  if (o.apply && changed) {
    fs.writeFileSync(file, toCsv(header, games));
  }
  out.changed = changed;
  if (o.write !== false) { fs.mkdirSync(o.reportsDir || REPORTS, { recursive: true }); fs.writeFileSync(path.join(o.reportsDir || REPORTS, 'school_results_' + mode + '_' + season + '.json'), JSON.stringify(out, null, 1) + '\n'); }
  return out;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const mode = a[0]; const season = +(a[a.indexOf('--season') + 1]);
  if (!['audit', 'fill'].includes(mode) || !season) { console.error('usage: school_results.js audit|fill --season YYYY [--apply]'); process.exit(2); }
  const out = run(mode, season, { apply: a.includes('--apply') });
  console.error('[school results] ' + mode + ' ' + season + ': ' + out.schools_read + ' schools read, ' + JSON.stringify(out.counts) + (out.agreement != null ? ', agreement ' + out.agreement : '') + (out.changed ? ', ' + out.changed + ' rows filled' : ''));
}
module.exports = { run, schoolRows, judge, assign, keyName, pairKey };
