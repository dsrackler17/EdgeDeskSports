/* ============================================================================
   PERSONNEL ADAPTERS — EdgeDesk's committed datasets onto the scoring core's
   input contract (football/personnel/impact.js). One adapter per league; the
   injury logic itself lives once, in the core.

   Pure: every function takes data already loaded and returns plain objects.
   No file, no clock, no network. build_personnel.js does the reading.

   COLLEGE (all real, all committed):
     player quality  football/players/teams/<key>.json — EPIR, accepted only
                     when the player has measured production (career sample
                     and a non-zero shrink weight). A rating that is the scale
                     prior plus role/experience points is carried as evidence
                     and leaves player_quality null.
     usage           the same file's participation share (box-score
                     appearances + touch share). Labelled a proxy: it is NOT
                     a snap share, and it costs confidence.
     depth order     the same file, ordered by participation, then measured
                     rating. No college depth chart is authoritative (ESPN's
                     depth endpoints refuse this repository).
     availability    the merged availability view (football/availability/
                     overlay.js: conference filings > operator corrections >
                     automated read), gated and fixture-scoped exactly as the
                     engine's own injury list is (football/matchup/contract.js
                     injuriesFor).
     matchup         football/matchup/metrics.json — the OPPONENT's
                     opponent-adjusted unit metrics, z against the league.

   NFL (thin, and says so):
     availability    football/injuries/nfl_<season>.json — the official
                     report, for the game's own week only.
     player quality, usage, depth and unit metrics — no feed is wired in, so
                     every NFL absence is carried UNRATED with the reason.
   ========================================================================== */
'use strict';

function num(x) { return typeof x === 'number' && isFinite(x); }
function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}
function normPersonName(s) {
  if (s == null) return null;
  let v = String(s).trim().toLowerCase();
  try { v = v.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
  return v.replace(/[^a-z0-9]+/g, '') || null;
}

/* ======================================================= COLLEGE ===== */

/* EPIR is a measurement only when production was measured. `q[4]` is the
   shrink weight n/(n+k) the rating put on the player's own production. */
function cfbQuality(p) {
  if (!p || !num(p.e)) return null;
  const measured = num(p.cn) && p.cn > 0 && Array.isArray(p.q) && num(p.q[4]) && p.q[4] > 0;
  return {
    value: p.e,
    basis: measured ? 'MEASURED_PRODUCTION' : 'NO_MEASURED_PRODUCTION',
    confidence: measured && num(p.cf) ? p.cf : null,
    sample: num(p.cn) ? p.cn : 0,
    scale: 'EPIR',
    source: 'football/players EPIR'
  };
}

function cfbUsage(p) {
  if (!p || !num(p.share)) return null;
  return { value: p.share, basis: 'PARTICIPATION_SHARE', role: p.role || null,
    source: 'football/players participation (appearances + touch share; not a snap share)' };
}

/* One team file -> depth groups, ordered by who plays: participation share
   first (the evidence of role), then measured rating, then name. */
function cfbDepth(teamFile) {
  const groups = {}, byId = {}, byName = {};
  const players = (teamFile && teamFile.players) || [];
  players.forEach(function (p) {
    if (!p || !p.n) return;
    const g = String(p.g || p.p || '').toUpperCase();
    if (!g) return;
    const entry = {
      player_id: p.id != null ? String(p.id) : null,
      player_name: p.n,
      position: p.p || null,
      quality: cfbQuality(p),
      usage: cfbUsage(p),
      order_basis: num(p.share) ? 'ROSTER_PARTICIPATION_RANK' : 'ROSTER_RATING_RANK'
    };
    (groups[g] = groups[g] || []).push(entry);
    if (entry.player_id) byId[entry.player_id] = { entry: entry, group: g };
    const nk = normPersonName(p.n);
    if (nk) byName[nk] = Object.prototype.hasOwnProperty.call(byName, nk) ? null : { entry: entry, group: g };
  });
  const depth = {};
  Object.keys(groups).sort().forEach(function (g) {
    const list = groups[g].slice().sort(function (a, b) {
      const sa = a.usage ? a.usage.value : -1, sb = b.usage ? b.usage.value : -1;
      if (sb !== sa) return sb - sa;
      const qa = a.quality && a.quality.basis === 'MEASURED_PRODUCTION' ? a.quality.value : -1;
      const qb = b.quality && b.quality.basis === 'MEASURED_PRODUCTION' ? b.quality.value : -1;
      if (qb !== qa) return qb - qa;
      return String(a.player_name).localeCompare(String(b.player_name)) || String(a.player_id).localeCompare(String(b.player_id));
    });
    depth[g] = { basis: 'ROSTER_PARTICIPATION_RANK', players: list };
  });
  return { depth: depth, byId: byId, byName: byName,
    generated_at: teamFile ? teamFile.generated_at || null : null };
}

/* The opponent's measured unit metrics, keyed the way config.js POSITIONS
   names its drivers. A z above zero is better FOR THE OPPONENT'S UNIT. */
function cfbOpponentMetrics(mt) {
  const out = {};
  const perf = mt && mt.performance;
  if (!perf) return out;
  function detail(side, id) {
    const d = perf[side] && perf[side].used;
    return (d || []).filter(function (x) { return x && x.id === id; })[0] || null;
  }
  function put(id, rec, label) {
    if (rec && num(rec.z)) out[id] = { z: rec.z, reliability: num(rec.reliability) ? rec.reliability : null,
      n: num(rec.n_obs) ? rec.n_obs : null, label: label };
  }
  put('def_sack_rate', detail('defense_detail', 'def_sack_rate'), 'pass rush (sack rate generated)');
  put('def_stuff_rate', detail('defense_detail', 'def_stuff_rate'), 'run stuffing (stuff rate)');
  put('sack_rate_allowed', detail('offense_detail', 'sack_rate_allowed'), 'pass protection (sack rate allowed)');
  put('explosive_pass_rate', detail('offense_detail', 'explosive_pass_rate'), 'explosive passing rate');
  const su = perf.sub_units || {};
  const labels = { run_offense: 'rushing offense', pass_offense: 'passing offense',
    run_defense: 'run defense', pass_defense: 'pass defense' };
  Object.keys(labels).forEach(function (k) {
    const u = su[k];
    if (!u || !num(u.z)) return;
    const rels = (u.used || []).map(function (x) { return x.reliability; }).filter(num);
    out[k] = { z: u.z, reliability: rels.length ? rels.reduce(function (a, b) { return a + b; }, 0) / rels.length : null,
      label: labels[k] };
  });
  return out;
}

const TIER_BY_TYPE = { OFFICIAL: 1, OFFICIAL_TEAM: 1, OFFICIAL_CONFERENCE: 1, COACH_QUOTE: 1, DEPTH_CHART: 1,
  TEAM_REPORTER: 2, REPUTABLE_MEDIA: 2, GAME_PARTICIPATION: 3, OTHER: 3 };
const DROP_FRESHNESS = { STALE: true, HISTORICAL: true };

/* a conference filing is evidence about ONE fixture */
function officialReportForGame(team, gameId) {
  const r = team && team.official_report;
  if (!r || !r.ok || r.game_id == null || gameId == null) return null;
  return String(r.game_id) === String(gameId) ? r : null;
}

/* One side of one college fixture.
   o = { game, side:'home'|'away', teamName, teamKey, oppName, oppKey,
         availTeam (merged overlay team or null), overlay (EDAvailabilityOverlay),
         teamFile, metricsOpp } */
function cfbTeam(o) {
  const AV = o.overlay;
  const t = o.availTeam || null;
  const d = cfbDepth(o.teamFile);
  const gameId = o.game && o.game.game_id;
  const notes = [];

  const grade = AV && t ? AV.normGrade(t.dataQuality || t.data_quality) : 'NONE';
  const official = officialReportForGame(t, gameId);
  const scoped = t ? (t.players || []).filter(function (p) {
    return p.game_id == null || gameId == null || String(p.game_id) === String(gameId);
  }) : [];
  const dropped = scoped.filter(function (p) { return p.freshness && DROP_FRESHNESS[String(p.freshness).toUpperCase()]; });
  if (dropped.length) notes.push(dropped.length + ' stale or historical availability record(s) excluded: last week’s absence is not this week’s');
  const live = scoped.filter(function (p) { return dropped.indexOf(p) < 0; });

  /* the same gate the engine's injury list uses: a graded read, and either a
     designation for this fixture, a comprehensive filing for it, or general
     unscoped evidence */
  const graded = !!(AV && t && AV.isGraded(grade)) && (live.length > 0
    || !!(official && official.comprehensive)
    || scoped.some(function (p) { return p.game_id == null; }));

  const absences = live.map(function (p) {
    const name = p.player_name || p.name || null;
    let hit = p.player_id != null ? d.byId[String(p.player_id)] : null;
    let identity = hit ? 'athlete_id on the team’s player file' : null;
    if (!hit) {
      const nk = normPersonName(name);
      hit = nk ? d.byName[nk] : null;
      if (hit) identity = 'unique name on the team’s player file';
    }
    const tier = num(p.tier) ? p.tier : (TIER_BY_TYPE[String(p.source_type || '').toUpperCase()] || null);
    return {
      player_id: hit ? hit.entry.player_id : (p.player_id != null ? String(p.player_id) : null),
      player_name: hit ? hit.entry.player_name : name,
      position: (hit && hit.entry.position) || p.position || null,
      depth_group: hit ? hit.group : null,
      status: p.status || p.availability_status || null,
      practice_status: p.practice_status || null,
      identity: identity,
      source: { name: p.source_name || null, type: p.source_type || null, tier: tier,
        url: p.source_url || null, published_at: p.source_published_at || p.observed_at || null,
        freshness: p.freshness || null },
      quality: hit ? hit.entry.quality : null,
      usage: hit ? hit.entry.usage : null
    };
  });

  return {
    team_id: o.teamKey || null,
    team_name: o.teamName || null,
    sport: 'cfb',
    side: o.side,
    coverage: {
      grade: grade, graded: graded, official: !!official,
      comprehensive: !!(official && official.comprehensive),
      source: official ? (official.conference || 'conference') + ' availability report'
        : (t && (t.sources_merged || []).length ? t.sources_merged.join(' + ') : null),
      as_of: official ? official.published_at || null : (t ? t.observed_at || null : null)
    },
    absences: absences,
    depth: d.depth,
    opponent: {
      team_id: o.oppKey || null, team_name: o.oppName || null,
      metrics: cfbOpponentMetrics(o.metricsOpp),
      source: o.metricsOpp ? 'football/matchup/metrics.json' : null,
      as_of: o.metricsOpp && o.metricsOpp.rating ? o.metricsOpp.rating.as_of || null : null
    },
    notes: notes,
    inputs: {
      player_file: !!o.teamFile, player_file_generated_at: d.generated_at,
      availability_grade: grade, opponent_metrics: !!o.metricsOpp
    }
  };
}

/* =========================================================== NFL ===== */

const NFL_STATUS = { OUT: 'OUT', DOUBTFUL: 'DOUBTFUL', QUESTIONABLE: 'QUESTIONABLE' };

/* o = { game, side, code, teamName, oppCode, oppName, injuries (the file) } */
function nflTeam(o) {
  const inj = o.injuries && o.injuries.teams ? o.injuries.teams[o.code] : null;
  const week = o.game ? o.game.week : null;
  const current = !!(inj && o.injuries.published !== false && inj.week != null && week != null && +inj.week === +week);
  const notes = [];
  const absences = [];
  let practiceOnly = 0;
  if (current) {
    (inj.players || []).forEach(function (p) {
      const st = NFL_STATUS[String(p.status || '').toUpperCase()];
      let status = st || null;
      /* "did not practice" never becomes OUT; with no game designation it is UNKNOWN */
      if (!status && /did not participate/i.test(String(p.practice || ''))) status = 'UNKNOWN';
      if (!status) { practiceOnly++; return; }
      absences.push({
        player_id: p.gsis_id || null, player_name: p.name || null, position: p.position || null,
        status: status, practice_status: p.practice || null, injury: p.injury || null,
        source: { name: 'NFL official injury report', type: 'OFFICIAL', tier: 1,
          url: null, published_at: o.injuries.retrieved_at || null, freshness: null },
        quality: { value: null, basis: 'NO_PLAYER_RATING_FEED' },
        usage: null
      });
    });
    if (practiceOnly) notes.push(practiceOnly + ' player(s) on the practice report carry no game designation and are not treated as absences');
  } else {
    notes.push(inj ? 'the official report on file is for week ' + inj.week + ', not this game’s week ' + week
      : 'no official injury report on file for ' + o.code);
  }
  return {
    team_id: o.code || null, team_name: o.teamName || null, sport: 'nfl', side: o.side,
    coverage: { grade: current ? 'OFFICIAL' : 'NONE', graded: current, official: current, comprehensive: current,
      source: o.injuries ? o.injuries.source || 'NFL official injury report' : null,
      as_of: o.injuries ? o.injuries.retrieved_at || null : null },
    absences: absences,
    depth: {},
    opponent: { team_id: o.oppCode || null, team_name: o.oppName || null, metrics: {}, source: null, as_of: null },
    notes: notes.concat(['no NFL player-quality, snap-share or depth-chart feed is wired in, so NFL absences are listed unrated']),
    inputs: { injury_week: inj ? inj.week : null, game_week: week }
  };
}

module.exports = {
  normKey, normPersonName,
  cfbQuality, cfbUsage, cfbDepth, cfbOpponentMetrics, cfbTeam, officialReportForGame,
  nflTeam
};
