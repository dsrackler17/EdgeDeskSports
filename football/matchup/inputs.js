/* ============================================================================
   THE MODEL INPUT ASSEMBLY — one definition of what the engine is given.

   WHY IT EXISTS. There were three callers of the college engine and they
   supplied three different things:

     app.html fbP4Request        roster, injuries, schedule, venue, weather
     football/fbs/build_coverage nothing at all — every field hard-coded null
     football/health/daily_check roster only

   The board therefore said one thing and `football/fbs/slate.json` — the
   artifact the AI, the newsletter and the exports all read — said another,
   and the artifact's `data_completeness` was 0.0 on all 75 games because the
   builder never loaded a single input, not because EdgeDesk did not have them.
   That is the join the coverage number was measuring: a hard-coded null.

   So the assembly lives here, once, and everything calls it.

   TWO REQUESTS, NOT ONE, AND THAT IS THE POINT.

     baseline  exactly the inputs the terminal has always priced with:
               roster bundles, the availability layer, schedule context,
               venue geography, weather. Its number is THE published number,
               and wiring this in is what makes the offline artifact agree
               with the screen instead of contradicting it.

     enriched  the same request PLUS the new starter context. Its number is
               research: it is published under `shadow_` names, graded on its
               own, and no reader-facing price is taken from it until its own
               validation record says it may be. A new adjustment that has
               never been out-of-sample tested does not get to move a line
               because it looked reasonable in a diff.

   AND A CONTRACT REPORT, because "missing" was doing too much work. Seven
   states, and only three of them are a problem:

     USABLE         retrieved, current, and fed to the model
     RESEARCH_ONLY  retrieved and trustworthy, deliberately not priced
     STALE          retrieved, but older than this field's own floor
     CONFLICTING    two sources, one field, no resolution
     NOT_APPLICABLE the question does not arise here (weather in a dome,
                    travel at a neutral site, a talent rating for a programme
                    outside the rated universe)
     FETCH_FAILED   EdgeDesk tried and the source refused
     UNAVAILABLE    no source EdgeDesk can reach publishes it at all

   A completeness percentage that counts NOT_APPLICABLE as missing is not a
   measure of what EdgeDesk knows, and it is not computed here.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');

const STATES = ['USABLE', 'RESEARCH_ONLY', 'STALE', 'CONFLICTING', 'NOT_APPLICABLE', 'FETCH_FAILED', 'UNAVAILABLE'];

/* WHICH STARTER STATES MAY MOVE A PRICE. Empty on purpose. The starter layer
   is new; nothing new prices until it has an out-of-sample record of its own,
   and this constant is the single switch that changes that — flip it here,
   and football/validation/ has to have something to show for it. */
const PRICED_STARTER_STATUSES = [];

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function hoursSince(t, now) { const a = Date.parse(t); return isFinite(a) ? (now - a) / 3600000 : null; }

function row(field, side, state, o) {
  o = o || {};
  return { field, side: side || null, state,
    source: o.source || null, as_of: o.as_of || null, age_hours: o.age_hours == null ? null : Math.round(o.age_hours * 10) / 10,
    detail: o.detail || null, priced: state === 'USABLE' };
}

/* -------------------------------------------------------------------- load */
/* Every committed artifact the assembly needs, read ONCE. A caller that
   projects 75 games must not read 75 copies of the rankings file. */
function load(opts) {
  opts = opts || {};
  const season = opts.season;
  const out = { season, loaded_at: new Date().toISOString(), problems: [] };

  const P = opts.params || (typeof globalThis !== 'undefined' && globalThis.EDCfbP4Params) || null;
  /* carried on the ctx so buildRequest can ask the PARAMETERS which layers
     are priced, rather than a constant in this file drifting from them */
  out.params = P;
  out.venues = (P && P.universe && P.universe.venues) || {};
  /* THE INJECTION POINT for a venue the trained table predates — a programme
     that moved up to FBS after the table was built. It is a committed file
     with a schema, not a guess: an entry without real coordinates is refused
     so that nothing can quietly substitute a plausible-looking point. */
  const supp = readJson(path.join(ROOT, 'football', 'venues', 'supplement.json'), null);
  out.venue_supplement = { entries: 0, refused: [], source: supp ? (supp.source || null) : null };
  if (supp && supp.venues) {
    for (const k of Object.keys(supp.venues)) {
      const v = supp.venues[k];
      if (!v || !isNum(v.lat) || !isNum(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180 || !v.source) {
        out.venue_supplement.refused.push({ key: k, why: 'a supplement entry needs real lat/lon and a named source' });
        continue;
      }
      if (!out.venues[k]) { out.venues[k] = v; out.venue_supplement.entries++; }
    }
  }

  /* roster bundles, from EdgeDesk's own ESPN sync (the app's fallback path
     and the only one a headless build can read without the network) */
  try {
    const B = require(path.join(ROOT, 'football', 'rosters', 'espn_to_bundles.js'));
    const cur = readJson(path.join(ROOT, 'football', 'rosters', `fbs_${season}_espn.json`), null);
    const prev = readJson(path.join(ROOT, 'football', 'rosters', `fbs_${season - 1}_espn.json`), null);
    if (cur) {
      /* the bundler takes the engine's own normaliser so every artifact keys
         a team the same way; passing a different one is how two files end up
         disagreeing about who "App State" is */
      const built = B.build(cur, prev, (opts.normKey || normKey));
      out.rosters = built.bundles;
      out.roster_as_of = cur.retrieved_at || null;
      out.roster_note = `${built.teams} teams, ${built.with_continuity} with continuity vs ${season - 1}`;
    } else { out.rosters = {}; out.problems.push(`football/rosters/fbs_${season}_espn.json is missing — the talent layer is blind`); }
  } catch (e) { out.rosters = {}; out.problems.push('roster bundles could not be built: ' + ((e && e.message) || e)); }

  /* THE PLAYER LAYER, merged into those bundles.

     The roster sync measures WHO IS ON THE ROSTER and who was there last year
     — continuity, portal flow, class mix. It has never measured HOW GOOD THEY
     ARE, and said so by shipping overall_talent: null on every programme.
     football/players/current.json has measured exactly that, weekly, for all
     138 of them, since long before this assembly existed; the two files were
     simply never joined, so the engine's talent layer reported empty next to
     a committed file that answers it. */
  out.player_layer = null;
  out.roster_quality = null;
  try {
    const RQ = require(path.join(ROOT, 'football', 'players', 'roster_quality.js'));
    const layer = readJson(path.join(ROOT, 'football', 'players', 'current.json'), null);
    if (layer) {
      const merged = RQ.merge(out.rosters, layer, (opts.normKey || normKey));
      out.rosters = merged.bundles;
      out.player_layer = { season: layer.season, week: layer.week, generated_at: layer.generated_at,
        player_count: layer.player_count, rated_with_production: layer.rated_with_production,
        quality: layer.quality || null };
      out.roster_quality = { teams: merged.teams, as_of: merged.as_of, source: merged.source,
        filled: merged.filled, note: merged.note };
    } else out.problems.push('football/players/current.json is missing — no roster carries a talent composite');
  } catch (e) { out.problems.push('the player layer could not be merged: ' + ((e && e.message) || e)); }

  /* the college availability layer */
  const av = readJson(path.join(ROOT, 'football', 'availability', 'current.json'), null);
  out.availability = av;
  out.availability_as_of = av ? (av.generated_at || null) : null;
  out.availability_by_team = {};
  if (av && av.teams) {
    for (const id of Object.keys(av.teams)) {
      const t = av.teams[id];
      const k = normKey(t.team_name || t.team_display);
      if (k) out.availability_by_team[k] = t;
    }
  } else out.problems.push('football/availability/current.json is missing — every injury report reads as not supplied');

  /* the starter context */
  out.starters = readJson(path.join(ROOT, 'football', 'starters', `cfb_${season}.json`), null);
  out.starters_as_of = out.starters ? out.starters.generated_at : null;
  if (!out.starters) out.problems.push(`football/starters/cfb_${season}.json is missing — run football/starters/build_starters.js`);

  /* HOW WELL "he opened the last one" PREDICTS THIS ONE, measured rather than
     assumed. Without it the engine declares the starter's reliability
     unmeasured instead of substituting a constant, which is the correct
     failure and why this is loaded here rather than defaulted in the engine. */
  out.persistence = readJson(path.join(ROOT, 'football', 'starters', 'persistence.json'), null);
  if (!out.persistence) out.problems.push('football/starters/persistence.json is missing — run '
    + 'football/starters/calibrate_persistence.js; until then no starter carries a measured reliability');

  /* the player layer's room ratings, research context for the packet */
  out.rooms = {};
  const tdir = path.join(ROOT, 'football', 'players', 'teams');
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir)) {
      if (!/\.json$/.test(f)) continue;
      const d = readJson(path.join(tdir, f), null);
      if (d && d.key) out.rooms[d.key] = d;
    }
  }
  out.rankings = readJson(path.join(ROOT, 'football', 'rankings', 'current.json'), null);
  out.weather = opts.weather || {};      /* game_id -> {temp_f, wind_mph, ..., as_of} */
  out.weather_source = opts.weather_source || null;
  out.weather_attempted = !!opts.weather_attempted;
  out.weather_failure = opts.weather_failure || null;
  return out;
}

function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}

/* --------------------------------------------------------------- injuries */
/* THE SAME CONTRACT THE TERMINAL USES, and the same distinction it protects:
   a team EdgeDesk could not read returns null (the engine prices maximum
   injury uncertainty); a team it DID read and found nobody on returns [] (a
   real report saying everybody is available). Collapsing those two was never
   an option and is not one here. */
const AVAIL_TO_ENGINE = { OUT: 'out', DOUBTFUL: 'doubtful', QUESTIONABLE: 'questionable',
  GAME_TIME_DECISION: 'questionable', DAY_TO_DAY: 'questionable', PROBABLE: 'probable', LIMITED: 'probable' };

function injuriesFor(ctx, teamName) {
  const t = ctx.availability_by_team[normKey(teamName)];
  if (!t) return null;
  /* THE GATE THIS FUNCTION WAS MISSING, and the reason football/fbs/slate.json
     published a higher completeness than the board on screen for the same game
     out of the same files.

     The availability layer grades its own read: STRONG and PARTIAL mean
     sources answered, LIMITED means EdgeDesk asked and got nothing usable
     back, NONE means it could not ask. Returning [] for a LIMITED team hands
     the engine "a report saying everybody is available" with confidence 0.6 —
     and in the current dataset that statement would be made about all 138 FBS
     programmes at once, on the strength of two sources returning 403/404 and a
     third answering with an empty list. That is not a clean injury report. It
     is no injury report, and the distinction this module's own comment calls
     non-negotiable is only protected if the QUALITY of the read is honoured
     and not just its presence.

     So the same gate the terminal applies is applied here. It makes the
     published completeness number smaller and makes it true, and it makes the
     offline artifact agree with the screen instead of contradicting it. */
  const q = String(t.dataQuality || t.data_quality || 'NONE').toUpperCase();
  if (q === 'NONE' || q === 'LIMITED') return null;
  const out = [];
  (t.players || []).forEach(p => {
    const st = AVAIL_TO_ENGINE[String(p.status || '').toUpperCase()];
    if (!st) return;
    out.push({
      player: p.player_name || p.name || null, position: p.position || null,
      starter: p.depth_role == null ? null : /(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(p.depth_role)),
      snap_share: null, severity: null, status: st, replacement_quality: null,
      source: p.source_name || t.team_name || null, as_of: p.observed_at || t.lastUpdated || ctx.availability_as_of
    });
  });
  return out;
}

/* --------------------------------------------------- schedule stress, offline */
/* The board reads this off its own per-team schedule index. Built here from
   the same schedule rows so the offline artifact and the screen agree. */
function scheduleIndex(rows, ratings) {
  const idx = {};
  (rows || []).forEach(g => {
    const t = Date.parse(g.start_date);
    if (!isFinite(t)) return;
    const hk = normKey(g.home_team), ak = normKey(g.away_team);
    if (hk) (idx[hk] = idx[hk] || []).push({ gid: String(g.game_id), t, road: false, oppKey: ak });
    if (ak) (idx[ak] = idx[ak] || []).push({ gid: String(g.game_id), t, road: !g.neutral_site, oppKey: hk });
  });
  Object.keys(idx).forEach(k => idx[k].sort((a, b) => a.t - b.t));
  return { idx, ratings: ratings || {} };
}

function schedCtx(si, game, which) {
  const tk = normKey(which === 'home' ? game.home_team : game.away_team);
  const list = si.idx[tk];
  if (!list || !list.length) return null;
  let i = -1;
  for (let j = 0; j < list.length; j++) if (String(list[j].gid) === String(game.game_id)) { i = j; break; }
  if (i < 0) return null;
  const r = si.ratings || {};
  const prev = i > 0 ? list[i - 1] : null, next = (i + 1 < list.length) ? list[i + 1] : null;
  let consec = 0; for (let j = i - 1; j >= 0 && list[j].road; j--) consec++;
  let road3 = 0; for (let j = Math.max(0, i - 3); j < i; j++) if (list[j].road) road3++;
  const out = {
    rest_days: prev ? Math.round((list[i].t - prev.t) / 864e5) : null,
    consecutive_road: i > 0 ? consec : null,
    road_last3: i > 0 ? road3 : null,
    prev_opp_rating: (prev && r[prev.oppKey] != null) ? r[prev.oppKey] : null,
    next_opp_rating: (next && r[next.oppKey] != null) ? r[next.oppKey] : null
  };
  return Object.keys(out).some(k => out[k] != null) ? out : null;
}

/* ------------------------------------------------------------ the assembly */
/* game: a normalised schedule row. meta: the FBS classification for it.
   Returns { baseline, enriched, contract, starters, applicable }. */
function buildRequest(ctx, o) {
  const g = o.game, meta = o.meta || null, now = o.now || Date.now();
  const hk = (meta && meta.home && meta.home.key) || normKey(g.home_team);
  const ak = (meta && meta.away && meta.away.key) || normKey(g.away_team);
  const homeFbs = meta ? !!meta.home.is_fbs : true;
  const awayFbs = meta ? !!meta.away.is_fbs : true;
  const contract = [];

  /* ---- venue ------------------------------------------------------- */
  const vh = ctx.venues[hk] || null, va = ctx.venues[ak] || null;
  const dome = !!(vh && vh.dome);
  if (vh) contract.push(row('venue_geography', 'home', 'USABLE',
    { source: 'trained venue table' + (ctx.venue_supplement.entries ? ' + supplement' : ''), detail: vh.name || null }));
  else contract.push(row('venue_geography', 'home', 'UNAVAILABLE',
    { source: 'trained venue table', detail: `no coordinates for ${g.home_team}'s venue`
      + (g.venue ? ` (${g.venue})` : '')
      + ' — the table covers the field the model was trained on, and this programme is not in it. '
      + 'football/venues/supplement.json is the injection point; it refuses an entry without real coordinates and a named source' }));
  /* THE AWAY VENUE IS NOT A MISSING FIELD. It exists only to measure travel,
     and at a neutral site there is no travel asymmetry to measure. */
  if (g.neutral_site) contract.push(row('venue_geography', 'away', 'NOT_APPLICABLE',
    { detail: 'neutral site — no travel asymmetry is modelled, so the away venue does not enter' }));
  else if (va) contract.push(row('venue_geography', 'away', 'USABLE', { source: 'trained venue table', detail: va.name || null }));
  else contract.push(row('venue_geography', 'away', 'UNAVAILABLE',
    { source: 'trained venue table',
      detail: `no coordinates for ${g.away_team}'s home venue, so travel distance cannot be computed`
        + (awayFbs
          ? ' — this programme is not in the table the model was trained on'
          : ' — the trained table covers the FBS field only, and this is an FCS visitor') }));

  /* ---- weather ------------------------------------------------------ */
  const wx = ctx.weather[String(g.game_id)] || null;
  /* A FORECAST THAT REACHES EDGEDESK IS NOT A FORECAST THE MODEL PRICES.
     params.js ships `unavailable_by_design.weather_coefficients` — no
     historical weather series exists in this corpus, so no coefficient was
     earned and supplied weather "cannot move the total". The row was USABLE
     anyway, and USABLE sets priced: true, so `priced_input_coverage` was
     counting a field the parameters themselves say prices nothing. That is
     the same overstatement the starter row avoids by being RESEARCH_ONLY, and
     it is read from the parameters rather than hard-coded here so the day a
     coefficient IS earned this row upgrades itself. */
  const P_ = ctx.params || (typeof globalThis !== 'undefined' && globalThis.EDCfbP4Params) || null;
  const wxPriced = !!(P_ && P_.weather);
  const wxWhy = (P_ && P_.unavailable_by_design && P_.unavailable_by_design.weather_coefficients) || null;
  if (dome) contract.push(row('weather', null, 'NOT_APPLICABLE',
    { detail: (vh.name || 'an indoor venue') + ' is a dome — weather is neutralised, not missing' }));
  else if (wx) contract.push(row('weather', null,
    hoursSince(wx.as_of, now) > 12 ? 'STALE' : (wxPriced ? 'USABLE' : 'RESEARCH_ONLY'),
    { source: ctx.weather_source || 'venue weather', as_of: wx.as_of, age_hours: hoursSince(wx.as_of, now),
      detail: wxPriced ? null
        : ('retrieved and shown, and it narrows the weather uncertainty term, but it moves no points: '
          + (wxWhy || 'no weather coefficient was earned on this corpus')) }));
  else if (!vh) contract.push(row('weather', null, 'UNAVAILABLE',
    { detail: 'the venue has no coordinates in the trained table, so no forecast can be located for it' }));
  /* THREE DIFFERENT SENTENCES, because "no weather" had been doing the work of
     all three: nobody asked, somebody asked and was refused, and there is
     nothing to ask about. */
  else if (!ctx.weather_attempted) contract.push(row('weather', null, 'UNAVAILABLE',
    { detail: 'no forecast provider was called in this build; the venue\u2019s coordinates are known, so this is a '
      + 'build that did not ask rather than a source that did not answer' }));
  else contract.push(row('weather', null, 'FETCH_FAILED',
    { source: ctx.weather_source || 'open-meteo forecast',
      detail: ctx.weather_failure || 'venue coordinates are known; the forecast request did not answer for this game' }));

  /* ---- rosters ------------------------------------------------------ */
  const rh = ctx.rosters[hk] || null, ra = ctx.rosters[ak] || null;
  const rosterAge = hoursSince(ctx.roster_as_of, now);
  [['home', hk, rh, homeFbs, g.home_team], ['away', ak, ra, awayFbs, g.away_team]].forEach(([side, key, r, isFbs, name]) => {
    if (r) contract.push(row('roster', side, rosterAge != null && rosterAge > 24 * 14 ? 'STALE' : 'USABLE',
      { source: 'EdgeDesk ESPN roster sync', as_of: ctx.roster_as_of, age_hours: rosterAge, detail: ctx.roster_note }));
    else if (!isFbs) contract.push(row('roster', side, 'NOT_APPLICABLE',
      { detail: `${name} is outside the ${ctx.season} FBS universe EdgeDesk rates; the roster layer is not defined for it and its absence is not a gap in this game's inputs` }));
    else contract.push(row('roster', side, 'UNAVAILABLE',
      { source: 'EdgeDesk ESPN roster sync', detail: `no roster bundle resolved for ${name}` }));
  });

  /* ---- injuries / availability -------------------------------------- */
  const ih = injuriesFor(ctx, g.home_team), ia = injuriesFor(ctx, g.away_team);
  const avAge = hoursSince(ctx.availability_as_of, now);
  [['home', ih, homeFbs, g.home_team], ['away', ia, awayFbs, g.away_team]].forEach(([side, list, isFbs, name]) => {
    if (list && list.length) contract.push(row('availability', side, avAge != null && avAge > 48 ? 'STALE' : 'USABLE',
      { source: 'EdgeDesk college availability layer', as_of: ctx.availability_as_of, age_hours: avAge,
        detail: `${list.length} absence report(s) on file` }));
    else if (list) contract.push(row('availability', side, avAge != null && avAge > 48 ? 'STALE' : 'USABLE',
      { source: 'EdgeDesk college availability layer', as_of: ctx.availability_as_of, age_hours: avAge,
        detail: 'the sources were read and named nobody — a report of no absences, which is not the same as no report' }));
    else if (!isFbs) contract.push(row('availability', side, 'NOT_APPLICABLE',
      { detail: `${name} is outside the FBS availability registry` }));
    else {
      /* WHY THE READ FAILED, not just that it did. The registry grades every
         team's read and records which sources refused; a row that says only
         "unavailable" sends the next person to look for a bug in this file
         instead of at the two endpoints that are actually returning 403. */
      const t = ctx.availability_by_team[normKey(name)] || null;
      const q = t ? String(t.dataQuality || t.data_quality || 'NONE').toUpperCase() : null;
      const failed = t && isNum(t.sources_failed) ? t.sources_failed : null;
      const checked = t && isNum(t.sources_checked) ? t.sources_checked : null;
      contract.push(row('availability', side, q === 'LIMITED' ? 'FETCH_FAILED' : 'UNAVAILABLE',
        { source: 'EdgeDesk college availability layer', as_of: ctx.availability_as_of,
          detail: !t
            ? `${name} is not in the availability registry; the engine prices this as maximum injury uncertainty, never as healthy`
            : `EdgeDesk read ${checked == null ? 'the'  : checked} source(s) for ${name} and ${failed ? failed + ' refused' : 'none carried a usable report'}`
              + `; the read is graded ${q} and an ungraded read is not a clean bill of health. `
              + 'The engine prices this as maximum injury uncertainty, never as healthy' }));
    }
  });

  /* ---- roster talent -------------------------------------------------- */
  /* A SEPARATE FIELD FROM `roster`, because they are separate questions and
     collapsing them hid this gap for as long as it existed: `roster` is who is
     on it and who was here last year; `roster_talent` is how good they are.
     The first has been measured by the roster sync all along. The second is
     measured by football/players and was, until this assembly joined them,
     reported as empty on every programme. */
  [['home', rh, homeFbs, g.home_team], ['away', ra, awayFbs, g.away_team]].forEach(([side, r, isFbs, name]) => {
    const rq = ctx.roster_quality || null;
    if (r && isNum(r.overall_talent)) contract.push(row('roster_talent', side, 'USABLE',
      { source: (rq && rq.source) || 'EdgeDesk player layer', as_of: (rq && rq.as_of) || null,
        age_hours: hoursSince((rq && rq.as_of) || null, now),
        detail: `composite ${Math.round(r.overall_talent * 10) / 10}`
          + (isNum(r.overall_talent_confidence) ? ` at confidence ${r.overall_talent_confidence}` : '')
          + ' — measured production, not recruiting pedigree' }));
    else if (!isFbs) contract.push(row('roster_talent', side, 'NOT_APPLICABLE',
      { detail: `${name} is outside the FBS field the player layer rates` }));
    else contract.push(row('roster_talent', side, 'UNAVAILABLE',
      { source: 'EdgeDesk player layer',
        detail: `no rated roster resolved for ${name}` + (rq ? '' : '; football/players/current.json did not load') }));
  });

  /* ---- starter context ----------------------------------------------- */
  const st = ctx.starters && ctx.starters.teams ? ctx.starters.teams : {};
  const sh = st[hk] || null, sa = st[ak] || null;
  const starters = { home: sh, away: sa };
  [['home', sh, homeFbs, g.home_team], ['away', sa, awayFbs, g.away_team]].forEach(([side, rec, isFbs, name]) => {
    if (!rec) {
      contract.push(row('qb_starter', side, isFbs ? 'UNAVAILABLE' : 'NOT_APPLICABLE',
        { detail: isFbs ? `no starter record was built for ${name}`
          : `${name} is outside the rated universe; no starter context is assembled for it` }));
      return;
    }
    const state = rec.field_state === 'USABLE' ? 'RESEARCH_ONLY' : rec.field_state;
    contract.push(row('qb_starter', side, state, {
      source: rec.source, as_of: rec.retrieved_at, age_hours: hoursSince(rec.retrieved_at, now),
      detail: rec.label + ' — retrieved and published as research; the priced QB layer is not fed from it '
        + 'until the starter layer has an out-of-sample record of its own'
    }));
    const av = rec.availability || {};
    contract.push(row('qb_availability', side, av.evidence === 'EXPLICIT' ? 'USABLE' : 'UNAVAILABLE',
      { source: av.source, as_of: av.retrieved_at, detail: av.why || null }));
  });

  /* ---- documented, permanent gaps ------------------------------------ */
  contract.push(row('recruiting_talent', null, 'UNAVAILABLE',
    { detail: 'per-player recruiting ratings are subscription data; no keyless feed carries them and none is substituted '
      + '(football/players/recruiting_adapter.js is the injection point)' }));
  contract.push(row('coaching_continuity', null, 'UNAVAILABLE',
    { detail: 'no public, keyless feed carries coordinator or staff continuity' }));

  /* ---- schedule ------------------------------------------------------- */
  const sch = o.schedule_index || null;
  const ch = sch ? schedCtx(sch, g, 'home') : null;
  const ca = sch ? schedCtx(sch, g, 'away') : null;
  [['home', ch], ['away', ca]].forEach(([side, c]) => {
    if (c) contract.push(row('schedule_context', side, 'USABLE',
      { source: 'season schedule feed', detail: `rest ${c.rest_days == null ? 'n/a' : c.rest_days + 'd'}` }));
    else contract.push(row('schedule_context', side, 'NOT_APPLICABLE',
      { detail: 'the first game of the season has no preceding rest interval to measure' }));
  });

  /* ---------------------------------------------------- the two requests */
  const baseline = {
    season: g.season, week: g.week, state: o.state,
    game: { home: g.home_team, away: g.away_team, neutral_site: !!g.neutral_site,
      venue_id: g.venue_id, kickoff: g.start_date, home_fbs: homeFbs, away_fbs: awayFbs },
    teams: {
      /* `qb` is the PRICED input and stays null: the college QB layer prices
         EPA per dropback and no feed publishes it. `qb_context` is a
         different question — who is playing and how well do we know it — and
         the engine reads it for its information score and for nothing that
         computes a point. The starter reaching the projection as CONTEXT is
         not the starter being priced; PRICED_STARTER_STATUSES is still the
         only switch for that, and it is still empty. */
      home: { conference: g.home_conference, roster: rh, qb: null, qb_context: qbContext(sh, ctx, hk),
        injuries: ih, news: null, coaching: null, schedule: ch },
      away: { conference: g.away_conference, roster: ra, qb: null, qb_context: qbContext(sa, ctx, ak),
        injuries: ia, news: null, coaching: null, schedule: ca }
    },
    venue: { home: vh, away: va },
    weather: wx, market: o.market || {},
    timestamps: { odds: o.odds_as_of || null, roster: ctx.roster_as_of || null,
      injuries: ctx.availability_as_of || null, weather: wx ? wx.as_of : null }
  };

  /* THE SHADOW. Same request, plus the starter — and the door it goes
     through refuses to price a status that is not on the whitelist, which
     today is empty. `priced` coming back false is the expected, correct
     answer, and the number this request produces is published under
     `shadow_` names and graded separately. */
  const SS = require(path.join(ROOT, 'football', 'starters', 'starters.js'));
  const qbh = sh ? SS.engineQbInput(sh, qbOpts(ctx, hk, sh)) : { priced: false, shadow: null, why: 'no starter record' };
  const qba = sa ? SS.engineQbInput(sa, qbOpts(ctx, ak, sa)) : { priced: false, shadow: null, why: 'no starter record' };
  const enriched = JSON.parse(JSON.stringify({
    season: baseline.season, week: baseline.week,
    game: baseline.game, teams: baseline.teams, venue: baseline.venue,
    weather: baseline.weather, market: baseline.market, timestamps: baseline.timestamps
  }));
  enriched.state = o.state;
  enriched.teams.home.qb = qbh.shadow;
  enriched.teams.away.qb = qba.shadow;

  return {
    baseline, enriched, contract, starters,
    qb_pricing: { home: { priced: qbh.priced, why: qbh.why }, away: { priced: qba.priced, why: qba.why },
      whitelist: PRICED_STARTER_STATUSES.slice() },
    summary: summarise(contract)
  };
}

/* THE STARTER, FLATTENED FOR THE ENGINE'S INFORMATION LAYER.

   Everything here answers "how well is this quarterback known", and nothing
   here can reach a point: the engine's information.quarterback() reads these
   fields and returns a 0-1 measurement that only the confidence score
   consumes. Deliberately NOT the same object as the shadow QB input — that
   one is shaped for the priced layer and carries efficiency fields this one
   must never acquire. */
function qbContext(rec, ctx, teamKey) {
  if (!rec || !rec.player_id) return null;
  const exp = rec.experience || null;
  const comp = rec.competition || null;
  /* the resolved starter's own share of his room's observed dropbacks; a
     contested room is genuinely less certain and the record already says so */
  let share = null;
  if (comp && Array.isArray(comp.players)) {
    const mine = comp.players.filter(p => String(p.player_id) === String(rec.player_id))[0];
    if (mine && isNum(mine.share)) share = mine.share;
  }
  /* THE LAST GAME HE ACTUALLY OPENED, and what share of it he threw. The
     persistence bands are measured on exactly this quantity, so it is read
     from the record's own history rather than from the season-long
     competition share — those are different numbers and using one where the
     other was measured would silently mis-band every team. */
  const hist = Array.isArray(rec.history) ? rec.history : [];
  let lastShare = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h && h.starter && String(h.starter.player_id) === String(rec.player_id) && isNum(h.starter.share)) {
      lastShare = h.starter.share; break;
    }
  }
  return {
    player: rec.player_name || null,
    player_id: rec.player_id,
    status: rec.status || 'UNKNOWN',
    field_state: rec.field_state || null,
    identity_corroborated: rec.identity_corroborated !== false,
    contested: !!(comp && comp.contested),
    dropback_share: share,
    last_game_share: lastShare,
    persistence: persistenceFor(ctx, lastShare),
    dropbacks: exp && isNum(exp.dropbacks) ? exp.dropbacks : null,
    starts: exp && isNum(exp.starts) ? exp.starts : null,
    seasons_observed: exp && isNum(exp.seasons_observed) ? exp.seasons_observed : null,
    source: rec.source || null,
    as_of: rec.retrieved_at || null
  };
}

/* The measured band for a given last-game dropback share. A band the
   calibration refused to publish for thin support comes back null, and the
   engine then declares the starter's reliability unmeasured. */
function persistenceFor(ctx, lastShare) {
  const cal = ctx && ctx.persistence;
  if (!cal || !Array.isArray(cal.by_band) || !isNum(lastShare)) return null;
  /* bands are ordered high to low by min_share in the artifact; re-sorted
     here so a reordering of the file cannot silently change the answer */
  const bands = cal.by_band.slice().sort((a, b) => b.min_share - a.min_share);
  const band = bands.filter(b => lastShare >= b.min_share)[0] || bands[bands.length - 1];
  if (!band || !isNum(band.rate)) return null;
  return { band: band.id, rate: band.rate, pairs: band.pairs, label: band.label,
    source: cal.source || null, as_of: cal.generated_at || null };
}

/* What the player layer knows about the resolved starter. It is attached as
   research context and — because the whitelist is empty — never priced. */
function qbOpts(ctx, teamKey, rec) {
  const room = ctx.rooms[teamKey];
  const grp = room && room.units && room.units.groups && room.units.groups.QB;
  let q = null;
  if (grp && rec && rec.player_id) {
    q = (grp.projected || []).filter(p => String(p.key || '').replace(/^a:/, '') === String(rec.player_id))[0] || null;
  }
  const exp = rec && rec.experience ? rec.experience : null;
  return {
    approved_statuses: PRICED_STARTER_STATUSES,
    quality: grp ? { rating: q ? q.epir : grp.rating, source: 'football/players EPIR' } : null,
    /* EPA per dropback is NOT computable from any feed this repository reads
       for college football (docs/football-data-sources.md), so it is left
       null rather than approximated from yards — which means the engine's QB
       layer contributes NO POINTS even in the shadow request. What the play
       feed does publish is the start count and the dropback volume, and those
       drive the engine's QB STABILITY term: an unknown starter is priced as
       minimum stability, and a quarterback with fifteen measured starts is
       not an unknown starter. That is the whole of the shadow difference, and
       it moves the distribution rather than the mean. */
    season_epa_per_db: null, career_epa_per_db: null,
    attempts: exp && isNum(exp.dropbacks) ? exp.dropbacks : null,
    starts: exp && isNum(exp.starts) ? exp.starts : null,
    rush_value: null, new_system: null,
    returning_starter: exp ? (exp.seasons_observed > 1) : null
  };
}

function summarise(contract) {
  const by = {};
  STATES.forEach(s => { by[s] = 0; });
  contract.forEach(c => { by[c.state] = (by[c.state] || 0) + 1; });
  /* THE DENOMINATOR EXCLUDES WHAT DOES NOT APPLY. A dome has no weather to be
     missing and a neutral site has no travel asymmetry; counting either as a
     hole made the number smaller and told the reader nothing. */
  const applicable = contract.length - by.NOT_APPLICABLE;
  const known = by.USABLE + by.RESEARCH_ONLY;
  return {
    fields: contract.length, applicable, by_state: by,
    known, priced: by.USABLE,
    input_coverage: applicable ? Math.round((known / applicable) * 1000) / 1000 : null,
    priced_coverage: applicable ? Math.round((by.USABLE / applicable) * 1000) / 1000 : null,
    basis: 'input_coverage counts every applicable field EdgeDesk retrieved, whether or not it is approved '
      + 'for pricing; priced_coverage counts only the ones the published number actually uses. '
      + 'NOT_APPLICABLE fields are excluded from the denominator, never counted as missing.'
  };
}

module.exports = { load, buildRequest, injuriesFor, scheduleIndex, schedCtx,
  summarise, STATES, PRICED_STARTER_STATUSES, normKey, row };
