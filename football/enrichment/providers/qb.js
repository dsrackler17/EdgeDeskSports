/* ============================================================================
   QUARTERBACK EVIDENCE PROVIDERS.

     starters_usage       Tier 5  who opened the previous game (cfbfastR play
                                  attribution, via football/starters)
     epir_projection      Tier 5  EdgeDesk's own quality ranking (inference,
                                  weighed below an observed start)
     operator_starters    Tier 1/2 a dated, sourced announcement a person
                                  recorded (operator.json kind STARTER):
                                  official or coach -> Tier 1, otherwise Tier 2
     provider_depth_chart Tier 3  ESPN's depth chart (refused today; recorded)
     team_announcements   Tier 1  a school's own news feed, where registered
     beat_starters        Tier 2  registered beat reporting

   The resolver never sees a provider name; it sees items with a kind and a
   tier. A provider that is not configured contributes no item and is
   published as NOT_CONFIGURED — "no official announcement found" and "no
   official source is wired" are different sentences.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { http } = require('../core/provider.js');
const { ms } = require('../core/lineage.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

const startersUsage = {
  name: 'starters_usage', label: 'Observed previous-game starts (cfbfastR play attribution)', kind: 'qb',
  source_type: 'PREVIOUS_GAME_START', role: 'TIER 5 INFERENCE',
  configured() { return true; },
  async healthCheck() {
    return http('https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_2026.csv',
      { method: 'GET', timeout_ms: 30000, accept: (t) => (t && t.length > 1000) ? true : 'empty feed' });
  },
  load(season) { return readJson(path.join(ROOT, 'football', 'starters', 'cfb_' + season + '.json'), null); },
  normalize() { return []; }
};
const epirProjection = {
  name: 'epir_projection', label: 'EdgeDesk player-quality ranking (QB1 by EPIR)', kind: 'qb',
  source_type: 'MODEL_PROJECTION', role: 'TIER 5 INFERENCE (not a source)',
  configured() { return true; }, async healthCheck() { return null; }, normalize() { return []; }
};
const operatorStarters = {
  name: 'operator_starters', label: 'Recorded announcements (operator, kind STARTER)', kind: 'qb',
  source_type: 'OFFICIAL_ANNOUNCEMENT', role: 'MANUAL VERIFIED OVERRIDE',
  configured() { return fs.existsSync(path.join(ROOT, 'football', 'availability', 'operator.json')) ? true : 'operator.json is missing'; },
  async healthCheck() { return null; },
  load(now) {
    const OP = require('../../availability/operator.js');
    return OP.load(readJson(path.join(ROOT, 'football', 'availability', 'operator.json'), { entries: [] }), now);
  },
  normalize() { return []; }
};
const providerDepth = {
  name: 'provider_depth_chart', label: 'ESPN college depth chart (QB1)', kind: 'qb',
  source_type: 'PROVIDER_DEPTH_CHART', role: 'TIER 3 PROVIDER',
  configured() { return true; },
  async healthCheck() {
    return http('https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/333/depthchart',
      { accept: (t) => { try { JSON.parse(t); return true; } catch (_) { return 'not JSON'; } } });
  },
  normalize() { return []; }
};
function registry(name, label, sourceType, field, role) {
  return { name, label, kind: 'qb', source_type: sourceType, role,
    configured() {
      const s = readJson(path.join(ROOT, 'football', 'availability', 'sources.json'), null);
      const n = s && s.teams ? s.teams.filter((t) => field === 'beat_sources' ? (t.beat_sources || []).length : !!t[field]).length : 0;
      return n > 0 ? true : 'no ' + (field === 'beat_sources' ? 'beat source' : 'team news feed') + ' is registered for any programme (football/availability/sources.overrides.json)';
    },
    async healthCheck() { return null; }, normalize() { return []; } };
}
const teamAnnouncements = registry('team_announcements', 'Official team announcements (school news feed)', 'OFFICIAL_ANNOUNCEMENT', 'football_news_url', 'TIER 1 OFFICIAL');
const beatStarters = registry('beat_starters', 'Trusted beat reporting on the starting QB', 'BEAT_REPORT', 'beat_sources', 'TIER 2 REPORTING');

const PROVIDERS = [teamAnnouncements, operatorStarters, beatStarters, providerDepth, startersUsage, epirProjection];

/* collect(ctx) -> { records: {teamKey: starters record}, operator: {teamKey: [entries]}, generated_at } */
async function collect(ctx) {
  const L = ctx.ledger, now = ms(ctx.now);
  if (ctx.live) {
    for (const p of PROVIDERS) {
      if (p.configured() !== true) continue;
      const c = await p.healthCheck();
      if (c) L.record(p.name, { outcome: c.outcome, status: c.status, detail: c.detail, at: c.at, url: c.url, via: 'live health check' });
    }
  }
  const art = startersUsage.load(ctx.season);
  const records = {};
  if (art && art.teams) {
    Object.keys(art.teams).forEach((k) => { records[k] = art.teams[k]; });
    (art.sources || []).forEach((s) => L.record('starters_usage', { outcome: s.ok ? 'OK' : 'NETWORK', status: s.status || null,
      detail: s.error || null, at: s.retrieved_at, url: s.url, via: 'starters build (' + s.field + ')' }));
    const withUsage = Object.values(art.teams).filter((t) => (t.evidence || []).some((e) => e.kind === 'GAME_USAGE' && !e.stale)).length;
    L.note('starters_usage', { source: 'starters artifact + live check', artifact_at: art.generated_at,
      data_age_hours: (now - ms(art.generated_at)) / 3600e3, ttl_hours: 48,
      covers: withUsage + ' of ' + Object.keys(art.teams).length + ' programmes with a current observed start' });
    const proj = Object.values(art.teams).filter((t) => (t.evidence || []).some((e) => e.kind === 'PROJECTION')).length;
    L.record('epir_projection', { outcome: 'OK', status: 200, at: art.generated_at, via: 'players layer via starters build' });
    L.note('epir_projection', { source: 'players layer', artifact_at: art.generated_at, covers: proj + ' programmes with a projected QB1',
      note: 'an opinion about who is better, weighed below an observed start; it is never counted as an independent source' });
  } else {
    L.note('starters_usage', { note: 'football/starters/cfb_' + ctx.season + '.json is missing' });
  }
  /* ESPN's depth chart: the availability collector records the refusal */
  const full = readJson(path.join(ROOT, 'football', 'availability', 'current.full.json'), null);
  const g = full && (full.failure_groups || []).find((x) => x.source === 'espn_depth');
  if (g) {
    require('../core/health.js').callsFromFailureGroup(g, full.generated_at).forEach((c) => L.record('provider_depth_chart', Object.assign(c, { via: 'collector artifact' })));
    L.note('provider_depth_chart', { source: 'collector artifact + live check', artifact_at: full.generated_at, note: g.teams + ' programmes: ' + g.error });
  }
  const op = operatorStarters.load(now);
  L.record('operator_starters', { outcome: 'OK', status: 200, at: new Date(now).toISOString(), via: 'football/availability/operator.json' });
  const operator = {};
  (op.live || []).filter((e) => e.kind === 'STARTER').forEach((e) => {
    const key = ctx.teamKeyByName ? ctx.teamKeyByName[String(e.team || '').toLowerCase().replace(/[^a-z0-9]/g, '')] : null;
    if (!key) return;
    if (!e.player_id && ctx.resolveName) { const r = ctx.resolveName(key, e.player, 'QB'); if (r) e.player_id = r.player_id; }
    (operator[key] = operator[key] || []).push(e);
  });
  L.note('operator_starters', { note: Object.values(operator).reduce((a, x) => a + x.length, 0) + ' live STARTER entr'
    + (Object.values(operator).reduce((a, x) => a + x.length, 0) === 1 ? 'y' : 'ies') });
  return { records, operator, generated_at: art ? art.generated_at : null,
    persistence: readJson(path.join(ROOT, 'football', 'starters', 'persistence.json'), null) };
}

module.exports = { PROVIDERS, collect };
