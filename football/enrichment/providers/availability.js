/* ============================================================================
   AVAILABILITY PROVIDERS — one adapter per source, one shape for all.

     conference_reports    PRIMARY_STRUCTURED   the official conference
                           availability reports (SEC, Big Ten, ACC, Big 12 on
                           the HD Intelligence platform; Mountain West, C-USA,
                           Sun Belt pages), ingested by availability-sync
     team_official         TEAM_OFFICIAL        a school's own release, where
                           football/availability/sources.overrides.json
                           registers one
     beat_reporting        NEWS_REPORTING       registered beat sources
     espn_core_injuries    SECONDARY_STRUCTURED ESPN's college injury endpoint
     espn_depth_chart      SECONDARY_STRUCTURED ESPN depth charts (roles)
     espn_participation    DERIVED_PARTICIPATION who played last game
     operator_overrides    MANUAL_VERIFIED_OVERRIDE  dated, sourced entries a
                           person recorded (football/availability/operator.json)

   Each adapter reads what the scheduled collector wrote (the collectors stay
   the only code that scrapes), records every call it can see — the
   collector's own failures, stamped with when they happened — and makes one
   live health check of its own. Every value passes through the evidence
   cache, so a later refused or failed read of the same fixture can never
   erase an earlier good one: the good one is carried, with its own clocks.

   No adapter decides anything about a player. normalize() turns a source's
   words into injury_evidence records; the aggregator decides.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const ST = require('../availability/status.js');
const H = require('../core/health.js');
const K = require('../core/cache.js');
const { http } = require('../core/provider.js');
const { ms, iso } = require('../core/lineage.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const AVDIR = path.join(ROOT, 'football', 'availability');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

let EVID = 0;
function evid(p) { EVID++; return p + ':' + EVID; }

function evidence(o) {
  const n = ST.normalize(o.designation, o.text);
  return {
    evidence_id: evid(o.provider),
    provider: o.provider,
    team_id: o.team_key || null, team_name: o.team_name || null,
    player_id: o.player_id ? String(o.player_id) : null, player_name: o.player_name || null, position: o.position || null,
    availability_status: n.status, reported_status: n.reported_status, partial: n.partial, status_basis: n.basis,
    injury_type: o.injury_type || null, body_part: o.body_part || null, practice_status: o.practice_status || null,
    source: o.source, source_type: o.source_type,
    source_timestamp: iso(o.source_timestamp), retrieved_at: iso(o.retrieved_at),
    game_id: o.game_id == null ? null : String(o.game_id),
    identity: o.identity || { basis: o.player_id ? 'source id' : 'name only', confidence: o.player_id ? 'EXACT' : 'MEDIUM' },
    raw_evidence_reference: o.ref || null
  };
}

/* ------------------------------------------------------ conference reports */
const conferenceReports = {
  name: 'conference_reports', label: 'Official conference availability reports', kind: 'availability',
  source_type: 'PRIMARY_STRUCTURED', role: 'PRIMARY STRUCTURED SOURCE',
  configured() { return true; },
  async healthCheck() {
    /* one cheap call to the platform four conferences publish through */
    return http('https://app.hdintelligence.com/api/get-publish-public', { method: 'POST', timeout_ms: 20000,
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: 'https://app.hdintelligence.com' },
      body: JSON.stringify({ sport: 'Football', organization: 'SEC', conference: 'SEC' }),
      accept: (t) => { try { const j = JSON.parse(t); return (j && typeof j === 'object') ? true : 'not a table of reports'; } catch (_) { return 'not JSON'; } } });
  },
  /* every report file on disk, corroborated exactly as the overlay does */
  load(ctx) {
    const OV = require('../../availability/overlay.js');
    const dir = path.join(AVDIR, 'reports');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { files = []; }
    const reps = files.map((f) => { const j = readJson(path.join(dir, f), null); if (j) j._file = f; return j; })
      .filter((r) => r && r.schema === 'edgedesk_availability_report_v1');
    return OV.corroborate(reps).map((r, i) => Object.assign(r, { _file: reps[i]._file }));
  },
  normalize(r, side) {
    return (r.rows || []).map((row) => evidence({ provider: 'conference_reports', team_key: side.key, team_name: side.name,
      player_id: row.player_id, player_name: row.player_name, position: row.position,
      designation: row.status, text: row.raw_text, practice_status: row.practice_status, body_part: row.body_part,
      source: (r.conference || 'conference') + ' availability report', source_type: 'PRIMARY_STRUCTURED',
      source_timestamp: r.published_at, retrieved_at: r.retrieved_at, game_id: r.game_id,
      identity: row.player_id ? { basis: row.on_roster ? 'resolved against the current roster' : 'report id', confidence: row.on_roster ? 'EXACT' : 'HIGH' }
        : { basis: 'name only', confidence: 'MEDIUM' },
      ref: 'football/availability/reports/' + r._file }));
  }
};

/* --------------------------------------------------- ESPN core injuries */
const espnCoreInjuries = {
  name: 'espn_core_injuries', label: 'ESPN college injury endpoint', kind: 'availability',
  source_type: 'SECONDARY_STRUCTURED', role: 'SECONDARY STRUCTURED SOURCE',
  configured() { return true; },
  async healthCheck() {
    return http('https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/teams/333/injuries?limit=5',
      { accept: (t) => { try { JSON.parse(t); return true; } catch (_) { return 'not JSON'; } } });
  },
  async fetchTeam(team, ctx) { const COL = require('../../availability/collectors.js'); return COL.espnInjuries(team, ctx || {}); },
  normalize(rec, side) {
    return evidence({ provider: 'espn_core_injuries', team_key: side.key, team_name: side.name,
      player_id: rec.player_id, player_name: rec.player_name, position: rec.position,
      designation: rec.raw_status || rec.availability_status, text: rec.raw_text, injury_type: rec.injury_type,
      body_part: rec.body_part, practice_status: rec.practice_status,
      source: rec.source_name || 'ESPN injuries', source_type: 'SECONDARY_STRUCTURED',
      source_timestamp: rec.source_published_at, retrieved_at: rec.observed_at, game_id: null,
      ref: rec.source_url || null });
  }
};

/* ---------------------------------------- ESPN depth chart / participation */
function artifactOnly(name, label, sourceType, failureSource, url) {
  return {
    name, label, kind: 'availability', source_type: sourceType, role: 'SECONDARY STRUCTURED SOURCE',
    configured() { return true; },
    async healthCheck() { return http(url, { accept: (t) => { try { JSON.parse(t); return true; } catch (_) { return 'not JSON'; } } }); },
    failureSource,
    normalize() { return []; }
  };
}
const espnDepth = artifactOnly('espn_depth_chart', 'ESPN college depth charts', 'SECONDARY_STRUCTURED', 'espn_depth',
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/333/depthchart');
const espnParticipation = artifactOnly('espn_participation', 'ESPN game participation (who played)', 'DERIVED_PARTICIPATION', 'espn_participation',
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/333/schedule');

/* ----------------------------------------------- registry-driven sources */
function registrySource(name, label, sourceType, field, role) {
  return {
    name, label, kind: 'availability', source_type: sourceType, role,
    configured() {
      const s = readJson(path.join(AVDIR, 'sources.json'), null);
      const n = s && s.teams ? s.teams.filter((t) => field === 'beat_sources' ? (t.beat_sources || []).length : !!t[field]).length : 0;
      return n > 0 ? true : 'no ' + (field === 'beat_sources' ? 'beat source' : 'official team release URL') + ' is registered for any of the '
        + (s && s.teams ? s.teams.length : 0) + ' programmes (football/availability/sources.overrides.json)';
    },
    async healthCheck() { return null; },
    normalize() { return []; }
  };
}
const teamOfficial = registrySource('team_official', 'Official team availability releases', 'TEAM_OFFICIAL', 'availability_url', 'TEAM/OFFICIAL SOURCE');
const beatReporting = registrySource('beat_reporting', 'Registered beat reporting', 'NEWS_REPORTING', 'beat_sources', 'NEWS/REPORTING SOURCE');

/* ------------------------------------------------------ operator overrides */
const operatorOverrides = {
  name: 'operator_overrides', label: 'Manual verified overrides (operator)', kind: 'availability',
  source_type: 'MANUAL_VERIFIED_OVERRIDE', role: 'MANUAL VERIFIED OVERRIDE',
  configured() { return fs.existsSync(path.join(AVDIR, 'operator.json')) ? true : 'football/availability/operator.json is missing'; },
  async healthCheck() { return null; },
  load(now) {
    const OP = require('../../availability/operator.js');
    return OP.load(readJson(path.join(AVDIR, 'operator.json'), { entries: [] }), now);
  },
  normalize(e, side) {
    return evidence({ provider: 'operator_overrides', team_key: side.key, team_name: side.name,
      player_id: e.player_id || null, player_name: e.player, position: e.position,
      designation: e.status, text: e.note, source: e.source_name || 'operator', source_type: e.confirmed ? 'MANUAL_VERIFIED_OVERRIDE' : 'NEWS_REPORTING',
      source_timestamp: e.published_at, retrieved_at: e.recorded_at, game_id: e.game_id || null,
      identity: { basis: 'operator entry, resolved by name', confidence: 'HIGH' },
      ref: e.source_url || 'football/availability/operator.json' });
  }
};

const PROVIDERS = [conferenceReports, teamOfficial, beatReporting, espnCoreInjuries, espnDepth, espnParticipation, operatorOverrides];

/* ============================================================== collect
   ctx: { now, ledger, cache, live, teams: {key: {key, name, espn_id, is_fbs}},
          fixtures: [{game_id, side, key, name}], espnToKey, resolveName(teamKey, name) }
   returns { evidence: {teamKey: [...]}, official: {'gid|teamKey': official}, reportsRead, notes } */
async function collect(ctx) {
  const now = ms(ctx.now), L = ctx.ledger, cache = ctx.cache;
  const evidenceBy = {};
  const official = {};
  const push = (k, e) => { (evidenceBy[k] = evidenceBy[k] || []).push(e); };
  const fixtureSide = {};
  (ctx.fixtures || []).forEach((f) => { fixtureSide[f.game_id + '|' + f.key] = f; (fixtureSide[f.game_id] = fixtureSide[f.game_id] || []).push(f); });
  const notes = [];

  /* ---- live health checks, one per provider that has one */
  if (ctx.live) {
    for (const p of PROVIDERS) {
      if (p.configured() !== true) continue;
      const c = await p.healthCheck();
      if (c) L.record(p.name, { outcome: c.outcome, status: c.status, detail: c.detail, at: c.at, url: c.url, via: 'live health check' });
    }
  }

  /* ---- conference reports: every file is a call; a good read of a fixture
     is cached so a later failed read cannot erase it */
  const reps = conferenceReports.load(ctx);
  let newest = null;
  reps.forEach((r) => {
    const sides = fixtureSide[String(r.game_id)] || [];
    const nk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const side = sides.find((s) => nk(s.name) === nk(r.team)) || sides.find((s) => nk(r.team).indexOf(nk(s.name)) >= 0 || nk(s.name).indexOf(nk(r.team)) >= 0)
      || (ctx.teamKeyByName && ctx.teamKeyByName[nk(r.team)] ? { key: ctx.teamKeyByName[nk(r.team)], name: r.team, game_id: String(r.game_id) } : null);
    L.record('conference_reports', r.ok ? { outcome: 'OK', status: 200, at: r.retrieved_at, via: 'artifact ' + r._file }
      : { outcome: 'BAD_CONTENT', status: null, detail: String(r.why || '').slice(0, 160), at: r.retrieved_at, via: 'artifact ' + r._file });
    if (!side) return;
    const key = 'avail:conference_reports:' + side.key + ':' + r.game_id;
    let use = r;
    if (r.ok) {
      K.put(cache, key, 'injuries', { value: slimReport(r), source: r.conference, observed_at: r.published_at || r.retrieved_at, retrieved_at: r.retrieved_at }, now);
      if (!newest || ms(r.published_at) > ms(newest)) newest = r.published_at;
    } else {
      K.fail(cache, key, 'injuries', r.why, now);
      const back = K.recall(cache, key, now);
      if (back.found && back.value && back.value.ok) {
        use = Object.assign({}, back.value, { _file: r._file, _carried: true, _carried_reason: back.reason });
        notes.push('carried the last good read of ' + side.name + ' ' + r.game_id + ' over a failed re-read (' + String(r.why || '').slice(0, 60) + ')');
      } else return;
    }
    official[String(r.game_id) + '|' + side.key] = { ok: true, comprehensive: !!use.comprehensive, published_at: use.published_at,
      retrieved_at: use.retrieved_at, rows_n: (use.rows || []).length, source_url: use.source_url || null, game_id: String(use.game_id),
      source: (use.conference || 'conference') + ' availability report', carried: !!use._carried, file: use._file };
    conferenceReports.normalize(use, side).forEach((e) => push(side.key, e));
  });
  L.note('conference_reports', { source: 'artifact + live check', data_age_hours: newest ? (now - ms(newest)) / 3600e3 : null,
    covers: 'conference games in the SEC, Big Ten, ACC, Big 12, Mountain West, C-USA and Sun Belt' });

  /* ---- the automated read (ESPN) */
  const full = readJson(path.join(AVDIR, 'current.full.json'), null);
  if (full && full.teams) {
    const at = full.generated_at;
    let rows = 0, historical = 0, newestRow = null;
    Object.keys(full.teams).forEach((id) => {
      const t = full.teams[id];
      const key = ctx.espnToKey ? ctx.espnToKey[String(id)] : null;
      const failedHere = (t.failed_sources || []).map((f) => f.source);
      if (failedHere.indexOf('espn_injuries') >= 0) L.record('espn_core_injuries', Object.assign({ at, via: 'collector artifact' },
        H.classifyCall({ status: +((/HTTP (\d{3})/.exec(JSON.stringify(t.failed_sources)) || [])[1]) || 0 })));
      else L.record('espn_core_injuries', { outcome: 'OK', status: 200, at, via: 'collector artifact' });
      (t.records || []).forEach((rec) => {
        if (!/espn/i.test(rec.source_name || '')) return;
        rows++;
        const f = ms(rec.source_published_at);
        if (f != null && (!newestRow || f > newestRow)) newestRow = f;
        if (f == null || (now - f) / 3600e3 > 168) historical++;
        if (key) push(key, espnCoreInjuries.normalize(rec, { key, name: t.team_name }));
      });
    });
    const staleWhy = rows && historical === rows
      ? 'it answers, but every one of the ' + rows + ' rows it returned was published ' + (newestRow ? 'no later than ' + iso(newestRow).slice(0, 10) : 'with no date')
        + ' — historical rows, not this season’s injuries' : null;
    L.note('espn_core_injuries', { source: 'collector artifact + live check', artifact_at: at,
      data_age_hours: newestRow ? (now - newestRow) / 3600e3 : null, ttl_hours: 168, content_stale_why: staleWhy,
      covers: 'all 138 FBS programmes (the endpoint)' });
    /* the two ESPN endpoints the collector is refused */
    (full.failure_groups || []).forEach((g) => {
      const p = PROVIDERS.find((x) => x.failureSource === g.source);
      if (!p) return;
      H.callsFromFailureGroup(g, at).forEach((c) => L.record(p.name, Object.assign(c, { via: 'collector artifact' })));
      L.note(p.name, { source: 'collector artifact + live check', artifact_at: at,
        note: g.teams + ' programmes: ' + g.error + (g.systematic ? ' (systematic — the provider refuses every programme, not one team)' : '') });
    });
  } else {
    L.note('espn_core_injuries', { note: 'football/availability/current.full.json is missing: the automated read has not run' });
  }

  /* ---- operator overrides */
  const op = operatorOverrides.load(now);
  L.record('operator_overrides', { outcome: 'OK', status: 200, at: iso(now), via: 'football/availability/operator.json' });
  (op.live || []).filter((e) => e.kind === 'AVAILABILITY').forEach((e) => {
    const key = ctx.teamKeyByName ? ctx.teamKeyByName[String(e.team || '').toLowerCase().replace(/[^a-z0-9]/g, '')] : null;
    if (!key) return;
    const ev = operatorOverrides.normalize(e, { key, name: e.team });
    if (!ev.player_id && ctx.resolveName) { const r = ctx.resolveName(key, ev.player_name); if (r) { ev.player_id = r.player_id; ev.identity = { basis: r.basis, confidence: r.confidence }; } }
    push(key, ev);
  });
  L.note('operator_overrides', { note: (op.live || []).length + ' live entr' + ((op.live || []).length === 1 ? 'y' : 'ies')
    + ', ' + (op.expired || []).length + ' expired, ' + (op.refused || []).length + ' refused' });

  /* ---- resolve names to athletes where a source gave none */
  Object.keys(evidenceBy).forEach((k) => evidenceBy[k].forEach((e) => {
    if (e.player_id || !ctx.resolveName) return;
    const r = ctx.resolveName(k, e.player_name, e.position);
    if (r) { e.player_id = r.player_id; e.identity = { basis: r.basis, confidence: r.confidence }; }
  }));

  return { evidence: evidenceBy, official, reportsRead: reps.length, notes };
}

function slimReport(r) {
  return { ok: !!r.ok, conference: r.conference, team: r.team, game_id: String(r.game_id), kickoff: r.kickoff,
    source_url: r.source_url, published_at: r.published_at, retrieved_at: r.retrieved_at, comprehensive: !!r.comprehensive,
    vocabulary: r.vocabulary || [], rows: (r.rows || []).map((x) => ({ player_name: x.player_name, player_id: x.player_id, position: x.position,
      status: x.status, practice_status: x.practice_status || null, body_part: x.body_part || null, raw_text: x.raw_text || null, on_roster: !!x.on_roster })) };
}

module.exports = { PROVIDERS, collect, evidence };
