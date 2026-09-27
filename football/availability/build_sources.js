#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB AVAILABILITY — the source registry builder.

   Writes football/availability/sources.json: one entry per FBS program, keyed
   by the ESPN team id the roster sync already uses, so availability, rosters
   and the Power 4 engine all speak about the same team.

   The registry is the growth path. Automated coverage starts from the feeds
   this repo already trusts (ESPN), and an official athletics or conference
   availability page is added per school by editing sources.overrides.json —
   no code change, no redeploy. See README.md, "Adding a school".

   An override is USED only when it carries a url. Anything else is inert, so
   a half-filled entry can be committed without changing what is collected.

     node football/availability/build_sources.js [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ROSTER_DIR = path.join(DIR, '..', 'rosters');
const OVERRIDES = path.join(DIR, 'sources.overrides.json');
const OUT = path.join(DIR, 'sources.json');
const SCHEMA = 'edgedesk_cfb_availability_sources_v1';

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fallback; } }

/* ESPN's core API carries the conference (group) for a season's FBS teams.
   Unreachable (or run offline) it simply stays null — the registry is still
   complete, it just does not know the conference yet. */
async function conferenceMap(season) {
  const out = {};
  try {
    const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/groups/80/children?limit=100`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return out;
    const j = await r.json();
    for (const ref of (j.items || [])) {
      const g = await (await fetch(ref.$ref, { signal: AbortSignal.timeout(20000) })).json().catch(() => null);
      if (!g || !g.id) continue;
      const teams = await (await fetch(`${(g.teams && g.teams.$ref) || ''}?limit=100`, { signal: AbortSignal.timeout(20000) })).json().catch(() => null);
      for (const t of ((teams && teams.items) || [])) {
        const id = String(t.$ref || '').match(/teams\/(\d+)/);
        if (id) out[id[1]] = g.name || g.shortName || null;
      }
    }
  } catch (_) { /* offline or blocked: conferences stay null, never guessed */ }
  return out;
}

function build(roster, overrides, confs, season) {
  const teams = (roster && roster.teams) || [];
  const byId = {};
  for (const t of teams) {
    const id = String(t.espn_id || '');
    if (!id) continue;
    const ov = (overrides && overrides.teams && (overrides.teams[id] || overrides.teams[t.location] || overrides.teams[t.display_name])) || {};
    byId[id] = {
      team_id: id,
      team_name: t.location || t.display_name || '',
      team_display: t.display_name || t.location || '',
      team_abbr: t.abbreviation || null,
      conference: ov.conference || confs[id] || null,
      espn_team_id: id,
      /* Official sources. Empty until a real, checked URL is added. */
      athletics_url: ov.athletics_url || null,
      football_news_url: ov.football_news_url || null,
      roster_url: ov.roster_url || null,
      depth_chart_url: ov.depth_chart_url || null,
      availability_url: ov.availability_url || null,
      conference_availability_url: ov.conference_availability_url || (overrides && overrides.conferences && overrides.conferences[ov.conference || confs[id]] && overrides.conferences[ov.conference || confs[id]].availability_url) || null,
      beat_sources: Array.isArray(ov.beat_sources) ? ov.beat_sources.filter(s => s && s.url && s.name && s.source_type) : [],
      notes: ov.notes || null
    };
  }
  const list = Object.keys(byId).sort((a, b) => byId[a].team_name.localeCompare(byId[b].team_name)).map(k => byId[k]);
  const withOfficial = list.filter(t => t.availability_url || t.conference_availability_url || t.athletics_url).length;
  return {
    schema: SCHEMA, season, generated_at: new Date().toISOString(),
    roster_source: `football/rosters/fbs_${season}_espn.json`,
    team_count: list.length,
    with_official_source: withOfficial,
    with_conference: list.filter(t => t.conference).length,
    teams: list
  };
}

async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason();
  for (let i = 0; i < args.length; i++) if (args[i] === '--season') season = parseInt(args[++i], 10);
  let roster = readJson(path.join(ROSTER_DIR, `fbs_${season}_espn.json`), null);
  let used = season;
  if (!roster) { roster = readJson(path.join(ROSTER_DIR, `fbs_${season - 1}_espn.json`), null); used = season - 1; }
  if (!roster) throw new Error(`no roster dataset in ${ROSTER_DIR} — run the roster sync first`);
  const confs = await conferenceMap(used);
  const reg = build(roster, readJson(OVERRIDES, {}), confs, used);
  if (reg.team_count < 100) throw new Error(`only ${reg.team_count} teams — refusing to write a hollow registry`);
  fs.writeFileSync(OUT, JSON.stringify(reg, null, 1) + '\n');
  console.log(`[sources] ${reg.team_count} FBS programs · ${reg.with_conference} with a conference · ${reg.with_official_source} with an official source → ${path.relative(process.cwd(), OUT)}`);
  return 0;
}
module.exports = { build, SCHEMA, defaultSeason };
if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error('[sources] ' + e.message); process.exit(1); });
