#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB AVAILABILITY — collectors.

   Each collector turns ONE source into raw reports. Nothing here decides a
   canonical status, a confidence or an impact: that is availability.js. Every
   collector is isolated and returns {reports, note} — a thrown error is caught
   by the pipeline and recorded as a failed source, never as "no injuries".

   Collectors, in the order the pipeline trusts them:
     official   — a school or conference availability page from the registry.
                  Anchored on the roster: only names ALREADY on the roster are
                  read off a page, so a stray string can never become a player.
     espn       — ESPN's college-football injuries feed (Tier 2 media).
     depth      — ESPN depth charts. Supplies the ROLE only, never a status.
     participation — who recorded a stat in the team's last completed game.
                  Evidence of availability, never proof of injury.
   ========================================================================== */
'use strict';
const A = require('./availability.js');

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const UA = { 'user-agent': 'EdgeDesk-availability-sync (+https://edgedesksports.com)' };

async function getJson(url, ms) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(ms || 20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getText(url, ms) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(ms || 20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function base(team, extra) {
  return Object.assign({
    season: null, week: null,
    team_id: team.team_id, team_name: team.team_name, team_abbr: team.team_abbr || null
  }, extra || {});
}

/* ------------------------------------------------------------------ ESPN */
/* The injuries feed. ESPN is a major outlet, so these are Tier 2 reports:
   good evidence, not an official filing, and labelled as such. */
async function espnInjuries(team, ctx) {
  const reports = [];
  const idx = await getJson(`${CORE}/teams/${team.espn_team_id}/injuries?limit=100`);
  const items = (idx && idx.items) || [];
  for (const it of items.slice(0, 60)) {
    let inj = it;
    if (it && it.$ref && !it.status) { try { inj = await getJson(it.$ref); } catch (_) { continue; } }
    if (!inj) continue;
    let athlete = inj.athlete;
    if (athlete && athlete.$ref && !athlete.displayName) { try { athlete = await getJson(athlete.$ref); } catch (_) { athlete = null; } }
    const name = athlete && (athlete.displayName || athlete.fullName);
    if (!name) continue;
    const d = inj.details || {};
    const rawStatus = inj.status || (inj.type && (inj.type.description || inj.type.name)) || '';
    const rawText = [rawStatus, d.type, d.detail, d.location, inj.shortComment, inj.longComment].filter(Boolean).join(' · ');
    const parsed = A.normalizeAvailabilityStatus(rawText);
    const status = A.normalizeDesignation(rawStatus) !== 'UNKNOWN' ? A.normalizeDesignation(rawStatus) : parsed.status;
    reports.push(base(team, {
      player_name: name, player_id: athlete && athlete.id ? String(athlete.id) : null,
      position: (athlete && athlete.position && (athlete.position.abbreviation || athlete.position.name)) || null,
      jersey: athlete && athlete.jersey != null ? String(athlete.jersey) : null,
      status: status, practice_status: parsed.practice_status,
      injury_type: d.type || (inj.type && inj.type.name) || null, body_part: d.location || parsed.body_part || null,
      source_type: 'REPUTABLE_MEDIA', source_name: 'ESPN injuries',
      source_url: `https://www.espn.com/college-football/team/injuries/_/id/${team.espn_team_id}`,
      source_published_at: inj.date || null, observed_at: ctx.now,
      raw_status: rawStatus || null, raw_text: rawText || null, observations: parsed.observations
    }));
  }
  return { reports, note: { source: 'espn_injuries', team: team.team_name, rows: reports.length } };
}

/* Depth charts give the ROLE, which is what turns "a corner is out" into
   "a starting corner is out". They never carry a status here. */
async function espnDepthRoles(team) {
  const roles = {};
  const dc = await getJson(`${CORE}/teams/${team.espn_team_id}/depthcharts?limit=50`);
  const items = (dc && dc.items) || [];
  for (const it of items.slice(0, 12)) {
    let group = it;
    if (it && it.$ref && !it.positions) { try { group = await getJson(it.$ref); } catch (_) { continue; } }
    const positions = (group && group.positions) || {};
    for (const key of Object.keys(positions)) {
      const pos = positions[key];
      const abbr = (pos.position && (pos.position.abbreviation || pos.position.name)) || key;
      const ath = (pos.athletes || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
      for (const a of ath) {
        let who = a.athlete;
        if (who && who.$ref && !who.displayName) { try { who = await getJson(who.$ref); } catch (_) { who = null; } }
        const name = who && (who.displayName || who.fullName);
        if (!name) continue;
        const role = String(abbr).toUpperCase() + (a.rank != null ? a.rank : '');
        const k = A.normName(name);
        if (!roles[k] || (a.rank || 99) < (roles[k].rank || 99)) roles[k] = { depth_role: role, rank: a.rank == null ? 99 : a.rank, position: abbr, player_id: who.id ? String(who.id) : null };
      }
    }
  }
  return { roles, note: { source: 'espn_depth', team: team.team_name, rows: Object.keys(roles).length } };
}

/* Participation: who actually recorded a stat in the last completed game.
   This is evidence of availability. It is NEVER an injury and the wording
   downstream says so. */
async function espnParticipation(team, ctx) {
  const reports = [];
  const sched = await getJson(`${SITE}/teams/${team.espn_team_id}/schedule`);
  const events = ((sched && sched.events) || []).filter(e => {
    const st = e && e.competitions && e.competitions[0] && e.competitions[0].status && e.competitions[0].status.type;
    return st && (st.completed === true || String(st.state).toLowerCase() === 'post');
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const last = events[0];
  if (!last) return { reports, note: { source: 'espn_participation', team: team.team_name, rows: 0, detail: 'no completed game yet' } };
  const sum = await getJson(`${SITE}/summary?event=${last.id}`);
  const played = {};
  for (const t of ((sum && sum.boxscore && sum.boxscore.players) || [])) {
    if (String((t.team && t.team.id) || '') !== String(team.espn_team_id)) continue;
    for (const cat of (t.statistics || [])) for (const a of (cat.athletes || [])) {
      const who = a.athlete || {};
      const name = who.displayName || who.fullName;
      if (name) played[A.normName(name)] = { name, id: who.id ? String(who.id) : null };
    }
  }
  return { reports, played, game: { id: last.id, date: last.date, name: last.name || null }, note: { source: 'espn_participation', team: team.team_name, rows: Object.keys(played).length, detail: last.date } };
}

/* --------------------------------------------------------------- official */
/* A school or conference availability page. ANCHORED ON THE ROSTER: the page
   text is scanned only for names already on the team's roster, and the status
   is read from the words immediately around the name. A page the extractor
   cannot read yields nothing and says so — it never yields a guess. */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6]|table)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}
function extractFromText(text, rosterPlayers, opts) {
  opts = opts || {};
  const out = [];
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  const byNorm = {};
  (rosterPlayers || []).forEach(p => { const k = A.normName(p.name); if (k) (byNorm[k] = byNorm[k] || []).push(p); });
  const keys = Object.keys(byNorm).sort((a, b) => b.length - a.length);
  const seen = {};
  for (const line of lines) {
    if (line.length > 400) continue;
    const norm = ' ' + A.normName(line) + ' ';
    for (const k of keys) {
      if (norm.indexOf(' ' + k + ' ') < 0) continue;
      if (seen[k]) continue;
      const parsed = A.normalizeAvailabilityStatus(line);
      if (parsed.status === 'UNKNOWN' && parsed.practice_status === 'NOT_REPORTED' && !parsed.observations.length) continue;
      seen[k] = 1;
      const p = byNorm[k][0];
      out.push({ player_name: p.name, position: p.position || null, jersey: p.jersey || null,
        status: parsed.status, practice_status: parsed.practice_status, body_part: parsed.body_part,
        observations: parsed.observations, raw_text: line, raw_status: parsed.matched || null });
      break;
    }
  }
  return out;
}
async function officialPage(team, ctx, src) {
  const html = await getText(src.url, 25000);
  const rows = extractFromText(stripHtml(html), ctx.roster, {});
  const reports = rows.map(r => base(team, Object.assign({}, r, {
    source_type: src.source_type, source_name: src.name, source_url: src.url,
    source_published_at: null, observed_at: ctx.now
  })));
  return { reports, note: { source: 'official', team: team.team_name, url: src.url, rows: reports.length } };
}

module.exports = { espnInjuries, espnDepthRoles, espnParticipation, officialPage, extractFromText, stripHtml, getJson, getText, CORE, SITE };
