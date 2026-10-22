'use strict';
/* ===========================================================================
   EdgeDesk collegiate — our team ids for the schools and websites the
   registry does not tie to one, learnt from the schools' own schedules and
   our own record (college_baseball/data/games/<season>.csv).

   The registry takes a school's baseball id from our record where ncaa.com's
   name and ours agree; 82 Division I schools' names do not ("App State",
   "Appalachian St."), and every box score read from their sites failed to
   join. And a schedule names some opponents by an older website than the
   registry's (gojsutigers.com for Jackson State). Names are not the way to
   close either gap. Results are:

     a SCHOOL is team T when its own schedule's finals, each against an
       opponent we already know, are our record's contests between that
       opponent and T on the same date, with the same score;
     a WEBSITE is team T when the finals a known school lists against it
       are our record's contests between that school and T, same date and
       score.

   Accepted only with at least MIN_VOTES such games and at least SHARE of
   all the games that matched anything agreeing on T, and never for a team
   another school already is. Learnt in rounds (a school learnt in one
   round can identify the websites it lists in the next). Written to
   collegiate/data/team_ids.json with the evidence; read by the collectors
   (rosters.loadSchools fills a school's baseball_team_id from it,
   boxscores and school_results resolve opponents' websites with it).
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const MIN_VOTES = 5;
const SHARE = 0.9;
const ROOT = path.join(__dirname, '..');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

/* our contests by date: date -> [{ h, a, hr, ar }] (FINAL only) */
function contests(gamesDir, seasons) {
  const { readCsv } = require('../engine/csv');
  const by = new Map();
  for (const s of seasons) {
    const f = path.join(gamesDir, s + '.csv');
    if (!fs.existsSync(f)) continue;
    for (const g of readCsv(f).rows) {
      if (g.status !== 'FINAL' || g.home_runs === '' || g.away_runs === '') continue;
      if (!by.has(g.date)) by.set(g.date, []);
      by.get(g.date).push({ h: String(g.home_id), a: String(g.away_id), hr: +g.home_runs, ar: +g.away_runs });
    }
  }
  return by;
}

const dayShift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
/* the other team of a contest of ours on that date (or a day either side: a school dates by its local day) in which `known`
   scored `knownRuns` and the other `otherRuns` */
function otherTeam(by, date, known, knownRuns, otherRuns) {
  for (const d of [date, dayShift(date, -1), dayShift(date, 1)]) {
    const hit = (by.get(d) || []).filter((c) => (c.h === known && c.hr === knownRuns && c.ar === otherRuns) || (c.a === known && c.ar === knownRuns && c.hr === otherRuns));
    if (hit.length) return [...new Set(hit.map((c) => (c.h === known ? c.a : c.h)))];
  }
  return [];
}

function decide(votes, taken) {
  const out = {};
  for (const [k, v] of votes) {
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [best, n] = [...v.entries()].sort((x, y) => y[1] - x[1])[0] || [];
    if (best && n >= MIN_VOTES && n >= SHARE * total && !(taken && taken.has(best))) out[k] = { team_id: best, votes: n, of: total };
  }
  return out;
}

/* o: { dataDir, gamesDir, schools (the registry, hosts corrected), seasons } */
function learn(o) {
  const dataDir = o.dataDir; const gamesDir = o.gamesDir || path.join(ROOT, 'college_baseball', 'data', 'games');
  const schools = o.schools || [];
  const sroot = path.join(dataDir, 'schedules', 'baseball');
  const seasons = o.seasons || (fs.existsSync(sroot) ? fs.readdirSync(sroot).map(Number).filter(Boolean) : []);
  const by = contests(gamesDir, seasons);
  const docs = [];
  for (const s of seasons) {
    const dir = path.join(sroot, String(s));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { const d = readJson(path.join(dir, f), null); if (d && d.games) docs.push(d); }
  }
  const schoolId = new Map(schools.filter((s) => s.baseball_team_id).map((s) => [s.id, String(s.baseball_team_id)]));
  const hostId = new Map(schools.filter((s) => s.host && s.baseball_team_id).map((s) => [s.host, String(s.baseball_team_id)]));
  for (const s of schools) if (s.baseball_team_id && s.registry_host) hostId.set(s.registry_host, String(s.baseball_team_id));
  const learnt = { schools: {}, hosts: {} };
  for (let round = 1; round <= 3; round++) {
    const taken = new Set(schoolId.values());
    const sv = new Map(); const hv = new Map();
    const vote = (m, k, t) => { if (!m.has(k)) m.set(k, new Map()); m.get(k).set(t, (m.get(k).get(t) || 0) + 1); };
    for (const d of docs) {
      const me = schoolId.get(d.school);
      for (const g of d.games) {
        if (g.status !== 'final' || g.exhibition || g.us == null || g.them == null || !g.date) continue;
        const opp = g.opponent_host ? hostId.get(g.opponent_host) : null;
        if (!me && opp) for (const t of otherTeam(by, g.date, opp, g.them, g.us)) vote(sv, d.school, t);
        if (me && g.opponent_host && !opp) for (const t of otherTeam(by, g.date, me, g.us, g.them)) vote(hv, g.opponent_host, t);
      }
    }
    const ns = decide(sv, taken); const nh = decide(hv, null);
    for (const [k, v] of Object.entries(ns)) { schoolId.set(k, v.team_id); learnt.schools[k] = Object.assign({ round }, v); }
    for (const [k, v] of Object.entries(nh)) { hostId.set(k, v.team_id); learnt.hosts[k] = Object.assign({ round }, v); }
    /* a school whose own website was learnt is that team (a WMT schedule names no opponent website, but its opponents name its) */
    const taken2 = new Set(schoolId.values());
    for (const sc of schools) {
      if (schoolId.has(sc.id) || !sc.host || !hostId.has(sc.host) || taken2.has(hostId.get(sc.host))) continue;
      const v = learnt.hosts[sc.host] || {};
      schoolId.set(sc.id, hostId.get(sc.host)); taken2.add(hostId.get(sc.host));
      learnt.schools[sc.id] = { team_id: hostId.get(sc.host), votes: v.votes || null, of: v.of || null, round, via: 'its website, as its opponents list it' };
      ns[sc.id] = true;
    }
    if (!Object.keys(ns).length && !Object.keys(nh).length) break;
  }
  return learnt;
}

function update(dataDir, schools, o) {
  const out = learn(Object.assign({ dataDir, schools }, o || {}));
  const doc = Object.assign({ schema: 'edgedesk_collegiate_team_ids_v1', rule: 'a school or website is our team T when at least ' + MIN_VOTES + ' of its finals, and ' + Math.round(SHARE * 100) + '% of those that match anything, are our record\'s contests with T on that date, same score' }, out);
  fs.writeFileSync(path.join(dataDir, 'team_ids.json'), JSON.stringify(doc, null, 1) + '\n');
  return doc;
}

/* the learnt ids, for the readers: { school(id) -> team id | null, host(h) -> team id | null } */
function load(dataDir) {
  const d = readJson(path.join(dataDir, 'team_ids.json'), { schools: {}, hosts: {} });
  return { school: (id) => (d.schools[id] ? d.schools[id].team_id : null), host: (h) => (d.hosts[h] ? d.hosts[h].team_id : null), doc: d };
}

module.exports = { learn, update, load, otherTeam, MIN_VOTES, SHARE };
