#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB AVAILABILITY — the ingestion job.

   Reads the source registry, collects every configured source for every FBS
   program, resolves each report to a real roster player, ranks the evidence,
   and writes the canonical dataset the whole product reads:

     football/availability/current.json        lean, what the app loads
     football/availability/current.full.json   evidence + raw text, admin view
     football/availability/<season>/week-NN.json   the archive, never rewritten

   ONE FAILED SOURCE MUST NOT FAIL THE RUN. Every collector is wrapped; a
   failure is recorded against that team and reported, and the team's coverage
   drops accordingly. A team EdgeDesk could not read is "no verified data",
   which is a different sentence from "no reported injuries", and the dataset
   carries the difference so the product can say it.

     node football/availability/fetch_availability.js [--season 2026] [--week 3]
       [--teams 20] [--only 2641,158] [--out DIR] [--dry] [--verify]

   --verify probes every registered official source and says which answered.
   It writes nothing. Run it on a runner before committing a new override:
   a page that 404s and a page with nobody hurt produce the same zero reports,
   and only this tells them apart.
   Exit 0 = written or unchanged. Exit 1 = could not run at all.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./availability.js');
const C = require('./collectors.js');

const DIR = __dirname;
const SCHEMA = 'edgedesk_cfb_availability_v1';
const CONCURRENCY = 4;

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function digestOf(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16); }

/* ---- one team, every source, failures contained ------------------------- */
async function collectTeam(team, roster, ctx) {
  const reports = [], failed = [], notes = [];
  let roles = {}, played = null, playedGame = null, officialFound = false, checked = 0;
  const rosterPlayers = (roster && roster.players) || [];
  const run = async (label, fn) => {
    checked++;
    try { return await fn(); }
    catch (e) { failed.push({ source: label, error: String((e && e.message) || e).slice(0, 140) }); return null; }
  };
  /* 1. official first: a conference report, then the school's own page. */
  const official = [];
  if (team.conference_availability_url) official.push({ url: team.conference_availability_url, name: (team.conference || 'Conference') + ' availability report', source_type: 'OFFICIAL_CONFERENCE' });
  if (team.availability_url) official.push({ url: team.availability_url, name: team.team_name + ' availability report', source_type: 'OFFICIAL_TEAM' });
  if (team.football_news_url) official.push({ url: team.football_news_url, name: team.team_name + ' football news', source_type: 'OFFICIAL_TEAM' });
  for (const src of official) {
    const r = await run('official:' + src.url, () => C.officialPage(team, { now: ctx.now, roster: rosterPlayers }, src));
    if (r) { reports.push(...r.reports); notes.push(r.note); officialFound = true; }
  }
  for (const src of (team.beat_sources || [])) {
    const r = await run('beat:' + src.url, () => C.officialPage(team, { now: ctx.now, roster: rosterPlayers }, src));
    if (r) { reports.push(...r.reports); notes.push(r.note); }
  }
  /* 2. ESPN's own injuries feed. */
  const inj = await run('espn_injuries', () => C.espnInjuries(team, ctx));
  if (inj) { reports.push(...inj.reports); notes.push(inj.note); }
  /* 3. depth roles — the role only, never a status. */
  const dc = await run('espn_depth', () => C.espnDepthRoles(team));
  if (dc) { roles = dc.roles; notes.push(dc.note); }
  /* 4. participation, only where a name is already under discussion. */
  if (!ctx.skipParticipation) {
    const par = await run('espn_participation', () => C.espnParticipation(team, ctx));
    if (par) { played = par.played || null; playedGame = par.game || null; notes.push(par.note); }
  }
  return { team, reports, roles, played, playedGame, failed, notes, officialFound, checked, rosterPlayers };
}

/* ---- pure: raw reports -> canonical records for one team ---------------- */
function processTeam(res, ctx) {
  const unresolved = [], resolved = [];
  for (const rep of res.reports) {
    if (!A.isUsableSource(rep)) { unresolved.push({ reason: 'source refused', player_name: rep.player_name, source_name: rep.source_name, source_type: rep.source_type }); continue; }
    const hit = A.resolvePlayer(rep, res.rosterPlayers);
    if (!hit.player) {
      unresolved.push({ player_name: rep.player_name, position: rep.position || null, team_name: res.team.team_name,
        source_name: rep.source_name, source_type: rep.source_type, source_url: rep.source_url || null,
        raw_text: rep.raw_text || null, reason: hit.reason, candidates: hit.candidates });
      continue;
    }
    const role = res.roles[A.normName(hit.player.name)] || null;
    const merged = Object.assign({}, rep, {
      season: ctx.season, week: ctx.week,
      player_name: hit.player.name,
      player_id: (hit.player.espn_id && String(hit.player.espn_id)) || rep.player_id || null,
      position: hit.player.position || rep.position || (role && role.position) || null,
      depth_role: role ? role.depth_role : null,
      match: hit.match, match_confidence: hit.match_confidence
    });
    merged.confidence = A.scoreConfidence(merged);
    resolved.push(merged);
  }
  /* Participation is evidence only for players another source already put in
     question. It never introduces a player, and it is never an injury. */
  if (res.played) {
    const flagged = {};
    resolved.forEach(r => { if ((A.DOUBT[r.status] || 0) > A.DOUBT.PROBABLE) flagged[A.normName(r.player_name)] = r; });
    Object.keys(flagged).forEach(k => {
      const r = flagged[k];
      const did = !!res.played[k];
      resolved.push(Object.assign({}, r, {
        status: did ? 'AVAILABLE' : 'UNKNOWN', practice_status: 'NOT_REPORTED',
        source_type: 'GAME_PARTICIPATION', source_name: 'Game participation',
        source_url: res.playedGame ? ('https://www.espn.com/college-football/game/_/gameId/' + res.playedGame.id) : null,
        source_published_at: res.playedGame ? res.playedGame.date : null,
        raw_status: null,
        raw_text: did ? 'Recorded participation in the last completed game.' : 'Did not record participation in the last completed game.',
        observations: did ? [] : ['did not record participation'],
        confidence: 'LOW'
      }));
    });
  }
  const records = A.buildCanonical(resolved, { now: ctx.now, kickoff: ctx.kickoff });
  const summary = A.teamSummary(records, { sources_checked: res.checked, sources_failed: res.failed.length, official_report_found: res.officialFound });
  return { team_id: res.team.team_id, team_name: res.team.team_name, team_display: res.team.team_display, team_abbr: res.team.team_abbr,
    conference: res.team.conference || null, records, summary, unresolved, failed_sources: res.failed, notes: res.notes };
}

/* ---- pure: the dataset ------------------------------------------------- */
function buildDataset(teamResults, ctx) {
  const teams = {};
  let records = 0, flagged = 0, unresolved = 0, failed = 0, official = 0;
  teamResults.forEach(t => {
    teams[t.team_id] = t;
    records += t.records.length; flagged += t.summary.counts.flagged;
    unresolved += t.unresolved.length; failed += t.failed_sources.length;
    if (t.summary.counts.official) official++;
  });
  const lean = {};
  Object.keys(teams).forEach(id => {
    const t = teams[id];
    lean[id] = {
      team_id: id, team_name: t.team_name, team_display: t.team_display, team_abbr: t.team_abbr, conference: t.conference,
      dataQuality: t.summary.dataQuality, lastUpdated: t.summary.lastUpdated,
      counts: t.summary.counts, sources_checked: t.summary.sources_checked, sources_failed: t.summary.sources_failed,
      official_report_found: t.summary.official_report_found,
      players: t.records.map(r => ({
        player_name: r.player_name, position: r.position, depth_role: r.depth_role,
        availability_status: r.availability_status, practice_status: r.practice_status,
        injury_type: r.injury_type, body_part: r.body_part,
        confidence: r.confidence, impact_level: r.impact_level, verified: r.verified,
        freshness: r.freshness, age_hours: r.age_hours,
        source_name: r.source_name, source_type: r.source_type, source_url: r.source_url,
        source_published_at: r.source_published_at, observed_at: r.observed_at,
        contested: r.contested, evidence_count: r.evidence_count,
        timeline: r.timeline.map(x => ({ day: x.day, practice_status: x.practice_status })),
        observations: r.observations
      }))
    };
  });
  /* 276 IS NOT 276 PROBLEMS.
     A live run reported "276 failed source reads", which reads as a pipeline
     falling over at random. It was two systematic faults counted once per
     team: one endpoint that does not serve this sport (404 on all 138) and one
     that refuses access (403 on all 138). They need opposite responses — the
     first is repairable, the second must NOT be worked around — and a single
     total hides which is which. So the failures are grouped by their cause,
     with the affected team count, and the raw list is kept alongside. */
  const failureGroups = (function () {
    const by = new Map();
    for (const t of teamResults) {
      for (const f of t.failed_sources) {
        /* Per-team URLs collapse to the source label; the error keeps its
           shape (an HTTP code, a timeout) without its one-off detail. */
        const label = String(f.source || 'unknown').replace(/^(official|beat):.*/, '$1');
        const cause = String(f.error || '').replace(/\b\d{3,}\b/g, (n) => (/^[45]\d\d$/.test(n) ? n : 'N'));
        const key = label + ' :: ' + cause.slice(0, 120);
        const g = by.get(key) || { source: label, error: cause.slice(0, 120), teams: 0, example_team: t.team_name };
        g.teams += 1;
        by.set(key, g);
      }
    }
    return [...by.values()].sort((a, b) => b.teams - a.teams).map((g) => Object.assign(g, {
      /* Stated, so nobody tries to "fix" an access restriction by evading it. */
      kind: /\b403\b|forbidden/i.test(g.error) ? 'ACCESS_RESTRICTED'
        : /\b404\b/.test(g.error) ? 'ENDPOINT_NOT_SERVING_THIS_SPORT'
        : /timeout|abort/i.test(g.error) ? 'TIMEOUT' : 'OTHER',
      systematic: g.teams >= Math.max(5, Math.floor(teamResults.length * 0.5)),
    }));
  })();

  const head = { schema: SCHEMA, version: A.VERSION, season: ctx.season, week: ctx.week, generated_at: ctx.now,
    team_count: Object.keys(teams).length, records, flagged, unresolved, failed_sources: failed,
    /* The same number, told usefully. */
    failure_groups: failureGroups,
    teams_with_official: official,
    coverage: { with_records: Object.values(lean).filter(t => t.counts.records > 0).length, strong: Object.values(lean).filter(t => t.dataQuality === 'STRONG').length,
      partial: Object.values(lean).filter(t => t.dataQuality === 'PARTIAL').length, limited: Object.values(lean).filter(t => t.dataQuality === 'LIMITED').length,
      none: Object.values(lean).filter(t => t.dataQuality === 'NONE').length } };
  const current = Object.assign({}, head, { teams: lean });
  current.digest = digestOf(current.teams);
  const full = Object.assign({}, head, {
    teams: teams,
    unresolved: teamResults.reduce((a, t) => a.concat(t.unresolved.map(u => Object.assign({ team_name: t.team_name }, u))), []),
    failed_sources: teamResults.reduce((a, t) => a.concat(t.failed_sources.map(f => Object.assign({ team_name: t.team_name }, f))), []),
    notes: teamResults.reduce((a, t) => a.concat(t.notes), [])
  });
  full.digest = current.digest;
  return { current, full };
}

function writeIfChanged(file, ds) {
  const prev = readJson(file, null);
  if (prev && prev.digest && prev.digest === ds.digest) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ds, null, 1) + '\n');
  return true;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}
/* The current week, from ESPN's own scoreboard. Never guessed from a clock. */
async function currentWeek(season) {
  try {
    const j = await C.getJson(`${C.SITE}/scoreboard?groups=80&limit=1`);
    const w = j && j.week && j.week.number;
    if (w) return w;
    const s = j && j.season && j.season.year;
    if (s && s !== season) return null;
  } catch (_) {}
  return null;
}

/* ---------------------------------------------------------------- verify --
   DOES A REGISTERED SOURCE ACTUALLY ANSWER?

   The registry is the growth path: an official school or conference
   availability page is added by editing sources.overrides.json, no code
   change. What was missing is the step between adding a URL and trusting it.
   A page that 404s, that redirects to a marketing site, or that renders its
   table in JavaScript looks exactly like a page with nobody hurt this week —
   the collector returns zero reports either way, and zero reports is what
   "everybody is available" looks like too.

   So --verify probes every registered URL and reports, per source, whether it
   answered and whether anything could be read off it. It writes nothing and
   it is the check to run on the runner before committing an override. A
   registry with no URLs in it is not a failure here; it is the current state,
   and this says so with the number rather than looking clean. */
async function verify(reg, rosterById, ctx) {
  const withUrl = reg.teams.filter((t) => t.availability_url || t.conference_availability_url || t.athletics_url);
  console.error(`[verify] ${reg.teams.length} programs registered · ${withUrl.length} carrying an official URL`);
  if (!withUrl.length) {
    console.error('[verify] NO OFFICIAL SOURCE IS REGISTERED FOR ANY PROGRAM.');
    console.error('[verify] Availability therefore rests entirely on the ESPN injuries feed, which is Tier 2');
    console.error('[verify] and is thin for college football. Add a school or a conference report to');
    console.error('[verify] football/availability/sources.overrides.json and re-run this to prove it answers.');
    return 2;
  }
  let answered = 0, empty = 0, failed = 0;
  for (const t of withUrl) {
    const url = t.availability_url || t.conference_availability_url || t.athletics_url;
    const roster = rosterById[t.team_id];
    try {
      const r = await C.officialPage(t, roster, ctx);
      const n = (r && r.reports ? r.reports.length : 0);
      if (n > 0) { answered++; console.error(`[verify] OK      ${t.team_name} · ${n} report(s) · ${url}`); }
      else { empty++; console.error(`[verify] EMPTY   ${t.team_name} · the page answered and nothing could be read off it · ${url}`); }
    } catch (e) {
      failed++;
      console.error(`[verify] FAILED  ${t.team_name} · ${String((e && e.message) || e).slice(0, 90)} · ${url}`);
    }
  }
  console.error(`[verify] ${answered} answered with reports · ${empty} answered empty · ${failed} failed`);
  /* EMPTY IS NOT OK AND IS NOT A FAILURE EITHER. A school with nobody hurt
     publishes an empty report, and so does a page this parser cannot read.
     They are reported apart so the person adding the source decides, and the
     exit code is non-zero only when nothing answered at all. */
  return answered > 0 ? 0 : (failed ? 1 : 2);
}

async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason(), week = null, limit = null, only = null, out = DIR, dry = false, doVerify = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (v === '--season') season = parseInt(args[++i], 10);
    else if (v === '--week') week = parseInt(args[++i], 10);
    else if (v === '--teams') limit = parseInt(args[++i], 10);
    else if (v === '--only') only = String(args[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (v === '--out') out = args[++i];
    else if (v === '--dry') dry = true;
    else if (v === '--verify') doVerify = true;
  }
  const reg = readJson(path.join(DIR, 'sources.json'), null);
  if (!reg || !reg.teams || !reg.teams.length) throw new Error('no source registry — run build_sources.js first');
  let roster = readJson(path.join(DIR, '..', 'rosters', `fbs_${season}_espn.json`), null);
  if (!roster) { roster = readJson(path.join(DIR, '..', 'rosters', `fbs_${season - 1}_espn.json`), null); }
  if (!roster) throw new Error('no roster dataset — run the roster sync first');
  const rosterById = {};
  (roster.teams || []).forEach(t => { rosterById[String(t.espn_id)] = t; });

  let teams = reg.teams;
  if (only) teams = teams.filter(t => only.indexOf(t.team_id) >= 0);
  if (limit) teams = teams.slice(0, limit);
  if (week == null) week = await currentWeek(season);

  const ctx = { now: new Date().toISOString(), season, week, kickoff: null };
  if (doVerify) return verify({ ...reg, teams }, rosterById, ctx);
  console.error(`[availability] ${teams.length} programs · season ${season}${week ? ' · week ' + week : ' · week unknown'}`);
  const collected = await pool(teams, CONCURRENCY, async (t) => {
    const res = await collectTeam(t, rosterById[t.team_id], ctx);
    return processTeam(res, ctx);
  });
  const ds = buildDataset(collected, ctx);
  const groups = (ds.current.failure_groups || []).map((g) =>
    `${g.source} ${g.error} on ${g.teams} teams [${g.kind}${g.systematic ? ', SYSTEMATIC' : ''}]`).join(' | ');
  const line = `[availability] ${ds.current.team_count} teams · ${ds.current.records} records · ${ds.current.flagged} flagged · ${ds.current.unresolved} unresolved · ${ds.current.failed_sources} failed sources · coverage ${JSON.stringify(ds.current.coverage)}`
    + (groups ? `\n[availability] failures by cause: ${groups}` : '');
  if (dry) { console.error(line + ' · DRY RUN, nothing written'); console.log(JSON.stringify(ds.current.coverage)); return 0; }
  const a = writeIfChanged(path.join(out, 'current.json'), ds.current);
  const b = writeIfChanged(path.join(out, 'current.full.json'), ds.full);
  let c = false;
  if (week != null) c = writeIfChanged(path.join(out, String(season), `week-${String(week).padStart(2, '0')}.json`), ds.full);
  console.error(line + ` · ${a || b || c ? 'written' : 'unchanged'}`);
  return 0;
}

module.exports = { collectTeam, processTeam, buildDataset, writeIfChanged, defaultSeason, SCHEMA };
if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error('[availability] ' + e.message); process.exit(1); });
