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

/* THE STATES A CONTRACT ROW MAY TAKE. Two were added with the availability
   policy and both are deliberately NOT excused from the denominator:

     NOT_REQUIRED  no conference filing was required for this fixture. True,
                   precise, and not a statement that anybody is healthy.
     NOT_DUE_YET   a report is required and its first filing is still hours
                   away. The document does not exist yet.

   Only NOT_APPLICABLE leaves the denominator, and only for a question that
   genuinely does not arise: weather under a roof, travel at a neutral site. */
const STATES = ['USABLE', 'RESEARCH_ONLY', 'STALE', 'CONFLICTING', 'NOT_APPLICABLE',
  'NOT_REQUIRED', 'NOT_DUE_YET', 'FETCH_FAILED', 'UNAVAILABLE'];

/* the one flattening, shared with the browser */
const QBC = require(path.join(HERE, 'qb_context.js'));
/* who is required to publish an availability report for which fixture */
const POLICY = require(path.join(HERE, '..', 'availability', 'policy.js'));

/* WHICH STARTER STATES MAY MOVE A PRICE. Empty on purpose. The starter layer
   is new; nothing new prices until it has an out-of-sample record of its own,
   and this constant is the single switch that changes that — flip it here,
   and football/validation/ has to have something to show for it. */
const PRICED_STARTER_STATUSES = [];

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function hoursSince(t, now) { const a = Date.parse(t); return isFinite(a) ? (now - a) / 3600000 : null; }

/* ONE CONTRACT ROW. Beyond the state it carries the four things a reader
   needs in order to check it rather than believe it: WHEN THE FACT WAS
   OBSERVED (which is not when EdgeDesk retrieved it), HOW THE IDENTITY WAS
   RESOLVED, WHAT WOULD FILL IT, and whether the published number prices it.
   `observed_at` and `as_of` are deliberately two fields: re-reading an
   unchanged artifact moves the second and must never move the first. */
function row(field, side, state, o) {
  o = o || {};
  return { field, side: side || null, state,
    source: o.source || null,
    as_of: o.as_of || null,
    observed_at: o.observed_at || null,
    age_hours: o.age_hours == null ? null : Math.round(o.age_hours * 10) / 10,
    identity: o.identity || null,
    detail: o.detail || null,
    fix: o.fix || null,
    priced: state === 'USABLE' };
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

  /* THE COLLEGE AVAILABILITY LAYER, as three sources merged once.

     The automated collector read is one of them. The other two are the thing
     that was missing: the conference filings college football began requiring
     in 2025, and a dated operator correction for what no scraper recovers.
     football/availability/overlay.js does the merge at READ time so it is done
     in one place and cannot be applied twice or dropped by the next sync. */
  const av = readJson(path.join(ROOT, 'football', 'availability', 'current.json'), null);
  const OVERLAY = require(path.join(ROOT, 'football', 'availability', 'overlay.js'));
  const OPERATOR = require(path.join(ROOT, 'football', 'availability', 'operator.js'));
  const opStore = readJson(path.join(ROOT, 'football', 'availability', 'operator.json'), null);
  const nowMs = Date.now();
  const reports = [];
  const rdir = path.join(ROOT, 'football', 'availability', 'reports');
  if (fs.existsSync(rdir)) {
    for (const f of fs.readdirSync(rdir)) {
      if (!/\.json$/.test(f)) continue;
      const r = readJson(path.join(rdir, f), null);
      if (r && r.schema === 'edgedesk_availability_report_v1') reports.push(r);
    }
  }
  const opLoaded = OPERATOR.load(opStore || { entries: [] }, nowMs);
  const merged = OVERLAY.build({ current: av, operator: opLoaded, reports, now: nowMs, normKey });
  out.availability = av;
  out.availability_as_of = av ? (av.generated_at || null) : null;
  out.availability_overlay = { merged: merged.merged, counts: merged.counts,
    operator: opLoaded.counts, reports_on_file: reports.length };
  if (opLoaded.refused.length) out.problems.push(opLoaded.refused.length
    + ' operator correction(s) are refused for missing a source, a date or a fixture — run '
    + 'node football/availability/record_correction.js --list');
  out.availability_by_team = {};
  for (const id of Object.keys(merged.teams)) {
    const t = merged.teams[id];
    const k = normKey(t.team_name || t.team_display);
    if (k) out.availability_by_team[k] = t;
  }
  if (!av) out.problems.push('football/availability/current.json is missing — the automated read contributes '
    + 'nothing and only ingested reports and operator corrections are on file');

  /* the starter context */
  out.starters = readJson(path.join(ROOT, 'football', 'starters', `cfb_${season}.json`), null);
  out.starters_as_of = out.starters ? out.starters.generated_at : null;
  if (!out.starters) out.problems.push(`football/starters/cfb_${season}.json is missing — run football/starters/build_starters.js`);

  /* HOW WELL "he opened the last one" PREDICTS THIS ONE, measured rather than
     assumed. Without it the engine declares the starter's reliability
     unmeasured instead of substituting a constant, which is the correct
     failure and why this is loaded here rather than defaulted in the engine. */
  /* THE QUARTERBACK QUALITY COEFFICIENT and every passer's score as the tune
     window ended. Read together so a projection prices from the same feature
     definition the coefficient was fitted against — recomputing the feature at
     prediction time from a different definition is how a coefficient ends up
     applied to something it never saw. */
  out.qb_quality = readJson(path.join(ROOT, 'football', 'cfb_p4', 'research', 'qb_quality.json'), null);
  if (!out.qb_quality) out.problems.push('football/cfb_p4/research/qb_quality.json is missing — run '
    + 'football/cfb_p4/research/fit_qb_quality.js; until then the QB layer has no quality input either');

  /* THE MEASURED EPA HISTORY, and the audit that says what may be done with
     it. `football/fbs_epa` carries expected points added per dropback for
     every FBS quarterback from 2014 — the input the QB layer's VALUE term has
     never had — together with the semantic audit establishing that it is NOT
     on the same scale as the shipped coefficient. Both are loaded here so a
     caller cannot pick up the numbers without the verdict attached to them. */
  out.fbs_epa = null;
  out.fbs_epa_index = null;
  try {
    const EPA = require(path.join(ROOT, 'football', 'fbs_epa', 'fbs_epa.js'));
    const ix = readJson(path.join(ROOT, 'football', 'fbs_epa', 'index.json'), null);
    const artSeason = ix ? ix.season : season;
    const art = readJson(path.join(ROOT, 'football', 'fbs_epa', `qb_epa_${artSeason}.json`), null);
    if (art && artSeason === season) {
      out.fbs_epa = art;
      out.fbs_epa_index = ix;
      out.fbs_epa_freshness = EPA.freshness(ix, Date.now());
    } else if (art) {
      out.problems.push(`football/fbs_epa has published season ${artSeason}, not ${season} — the quarterback `
        + 'efficiency history is not read for this season rather than read from the wrong one');
    } else {
      out.problems.push('football/fbs_epa/qb_epa_' + season + '.json is missing — run '
        + 'football/fbs_epa/build_epa.js; until then no quarterback carries a measured EPA history');
    }
  } catch (e) { out.problems.push('the FBS EPA layer could not be loaded: ' + ((e && e.message) || e)); }

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
  /* TEAM RECRUITING TALENT. The per-player ratings are still subscription
     data and are still not substituted anywhere; this is the per-TEAM
     composite, which is public and keyless and which nothing here had ever
     read. It is research: no coefficient is fitted against it on this corpus,
     so it fills the recruiting_talent contract field and moves no point. */
  out.team_talent = readJson(path.join(ROOT, 'football', 'players', 'team_talent.json'), null);
  if (out.team_talent && out.team_talent.season !== season) {
    out.problems.push('football/players/team_talent.json is for season ' + out.team_talent.season
      + ', not ' + season + ' — it is not read for this season rather than read from the wrong one');
    out.team_talent = null;
  }
  if (!out.team_talent) out.problems.push('football/players/team_talent.json is missing — run '
    + 'football/players/build_team_talent.js');
  else if (out.team_talent.teams) {
    /* blue_chip_ratio was M.missing on every roster in the universe with the
       note "supply them via ingest.setRecruiting()". A public team-level
       ratio is not per-player stars and is labelled as the team ratio it is,
       but it IS the field the engine asked for and it is supplied here. */
    for (const k of Object.keys(out.team_talent.teams)) {
      const b = out.rosters[k];
      const t = out.team_talent.teams[k];
      if (b && b.blue_chip_ratio == null && isNum(t.blue_chip_ratio)) b.blue_chip_ratio = t.blue_chip_ratio;
    }
  }

  out.rankings = readJson(path.join(ROOT, 'football', 'rankings', 'current.json'), null);
  out.weather = opts.weather || {};      /* game_id -> {temp_f, wind_mph, ..., as_of} */
  out.weather_source = opts.weather_source || null;
  out.weather_attempted = !!opts.weather_attempted;
  out.weather_failure = opts.weather_failure || null;
  out.weather_read_at = opts.weather_read_at || null;
  /* THE LAST FORECAST EDGEDESK ACTUALLY OBSERVED, for every caller that does
     not fetch one itself — the coverage report, the daily check, the health
     job. Publishing nothing when a good observation is on disk is the same
     erasure the builder stopped making, one caller further out. It is aged
     against ITS OWN observation time and goes STALE on the contract's floor
     like any other carried value; it is never presented as current. */
  if (!Object.keys(out.weather).length) {
    const store = readJson(path.join(ROOT, 'football', 'venues', 'forecasts.json'), null);
    if (store && store.by_game) {
      const carried = {};
      for (const id of Object.keys(store.by_game)) {
        const w = store.by_game[id];
        if (!w || !w.as_of) continue;
        carried[id] = Object.assign({}, w, { carried: true,
          carried_reason: 'this build requested no forecast; the last one EdgeDesk observed is carried forward '
            + 'at its own observation time' });
      }
      if (Object.keys(carried).length) {
        out.weather = carried;
        out.weather_source = store.source || 'open-meteo forecast (carried from football/venues/forecasts.json)';
        out.weather_store_as_of = store.generated_at || null;
      }
    }
  }
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
  else if (wx) {
    /* AGED AGAINST WHEN IT WAS OBSERVED, never against when it was re-read.
       A forecast carried forward from an earlier build is still that earlier
       build's observation: `as_of` is the moment open-meteo answered, and the
       carry writes `carried_at` beside it rather than over it. */
    const wxAge = hoursSince(wx.as_of, now);
    contract.push(row('weather', null,
      wxAge > 12 ? 'STALE' : (wxPriced ? 'USABLE' : 'RESEARCH_ONLY'),
      { source: ctx.weather_source || 'venue weather',
        as_of: ctx.weather_read_at || (wx.carried ? wx.carried_at : wx.as_of),
        observed_at: wx.as_of,
        age_hours: wxAge,
        detail: (wx.carried
          ? 'CARRIED FORWARD: ' + (wx.carried_reason || 'this build could not reach the forecast provider')
            + '. Observed ' + (wxAge == null ? 'at an unknown time' : wxAge.toFixed(1) + ' hours ago') + '. '
          : '')
          + (wxPriced ? 'a forecast for this kickoff, matched to the venue coordinates'
            : 'retrieved and shown, and it narrows the weather uncertainty term, but it moves no points: '
              + (wxWhy || 'no weather coefficient was earned on this corpus')),
        fix: wx.carried ? 're-run the build from a host that can reach api.open-meteo.com' : null }));
  }
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
    else if (!isFbs) contract.push(row('roster', side, 'UNAVAILABLE',
      /* THIS ROW USED TO SAY NOT_APPLICABLE, AND THE SCORE DISAGREED WITH IT.
         "Its absence is not a gap in this game's inputs" is a claim that the
         projection does not need it, and the projection does: with no roster
         for the FCS side the engine's roster_away term is unmeasured and it
         charges the full 6.1 points for it, on every one of these games. A
         contract excluding a field from its own denominator while the
         weighted score charges for it is exactly the quiet contradiction the
         confidence ledger was built to surface, and it surfaced this one.

         So the contract now agrees with the score: EdgeDesk does not have this
         roster, that is a real gap, and it is counted as one. Coverage on an
         FBS-vs-FCS game falls, which is the correct direction for a number
         that is meant to mean something. */
      { source: 'EdgeDesk ESPN roster sync',
        detail: `${name} is outside the ${ctx.season} FBS universe EdgeDesk rates, so no roster is retrieved `
          + 'for it. The engine prices the side from a shared FCS floor and charges the full weight of its '
          + 'roster term, so this is counted as the gap it is rather than excused as inapplicable',
        fix: 'no FCS roster feed is wired in; the gap is real and the confidence cost is the honest price of it' }));
    else contract.push(row('roster', side, 'UNAVAILABLE',
      { source: 'EdgeDesk ESPN roster sync', detail: `no roster bundle resolved for ${name}` }));
  });

  /* ---- injuries / availability -------------------------------------- */
  /* WHAT THE CONFERENCE ACTUALLY REQUIRES FOR THIS FIXTURE, asked first.

     Every branch below used to end in the same sentence — EdgeDesk read some
     sources and none carried a report — and that sentence was doing the work
     of five different situations. College football acquired conference
     availability reporting in 2025 and football/availability/policy.js now
     carries each conference's published policy, with its scope, its cadence
     and its status vocabulary. That turns "no report" into the specific
     statement that is true of this game:

       NOT_REQUIRED     a non-conference fixture, where no policy obliges
                        anyone to file. Nothing was withheld
       NOT_DUE_YET      a conference game whose first filing is still hours
                        away. The report does not exist yet
       FETCH_FAILED     required, filed or filable, and EdgeDesk could not
                        read it
       UNAVAILABLE      required and EdgeDesk has no route to it at all
       USABLE           read, with the scope the policy says it has

     None of them is health. A comprehensive report naming nobody is the ONLY
     thing that means nobody is out, and only the policy registry may say a
     source is comprehensive. */
  const ih = injuriesFor(ctx, g.home_team), ia = injuriesFor(ctx, g.away_team);
  const avAge = hoursSince(ctx.availability_as_of, now);
  const policyGame = { home_conference: g.home_conference, away_conference: g.away_conference,
    is_conference_game: g.home_conference != null && g.away_conference != null
      && POLICY.norm(g.home_conference) === POLICY.norm(g.away_conference),
    kickoff: g.start_date };
  const avPolicy = { home: POLICY.forGame(policyGame, 'home', now), away: POLICY.forGame(policyGame, 'away', now) };
  const avEvidence = { home: 'NONE', away: 'NONE' };
  [['home', ih, homeFbs, g.home_team], ['away', ia, awayFbs, g.away_team]].forEach(([side, list, isFbs, name]) => {
    const pol = avPolicy[side];
    const t = ctx.availability_by_team[normKey(name)] || null;
    const official = !!(t && t.official_report);
    const comprehensive = !!(t && t.official_report && t.official_report.comprehensive);
    const polNote = pol && pol.why ? ' ' + pol.why + '.' : '';
    if (list && list.length) {
      avEvidence[side] = 'EXPLICIT';
      contract.push(row('availability', side, avAge != null && avAge > 48 ? 'STALE' : 'USABLE',
        { source: (official ? pol.conference + ' availability report' : 'EdgeDesk college availability layer'),
          as_of: ctx.availability_as_of, observed_at: (t && t.official_report && t.official_report.published_at) || null,
          age_hours: avAge, identity: 'resolved against the current-season roster by name; a name that is not on '
            + 'the roster is refused rather than invented',
          detail: `${list.length} absence report(s) on file` + polNote,
          fix: null }));
    } else if (list && comprehensive) {
      /* the one branch that may say nobody is out */
      avEvidence[side] = 'COMPREHENSIVE_SILENCE';
      contract.push(row('availability', side, avAge != null && avAge > 48 ? 'STALE' : 'USABLE',
        { source: pol.conference + ' availability report',
          as_of: ctx.availability_as_of, observed_at: (t.official_report && t.official_report.published_at) || null,
          age_hours: avAge,
          detail: 'the ' + pol.conference + ' report for this game designates every player and names nobody on this '
            + 'roster — a report of no absences, which is a different statement from no report' }));
    } else if (list) {
      /* sources answered and named nobody, but nothing comprehensive covers
         this game, so this is not a clean bill of health for the roster */
      contract.push(row('availability', side, avAge != null && avAge > 48 ? 'STALE' : 'USABLE',
        { source: 'EdgeDesk college availability layer', as_of: ctx.availability_as_of, age_hours: avAge,
          detail: 'the sources EdgeDesk reads were read and named nobody. No COMPREHENSIVE report covers this '
            + 'fixture, so this is an absence of named absences and not a statement that the roster is whole'
            + polNote,
          fix: pol && pol.report_url ? ('ingest the ' + pol.conference + ' report from ' + pol.report_url) : null }));
    } else if (!isFbs) {
      contract.push(row('availability', side, 'UNAVAILABLE',
        { detail: `${name} is outside the FBS availability registry, so no availability read covers it. The `
            + 'engine prices maximum injury uncertainty for this side and charges for the gap, so the contract '
            + 'counts it as a gap rather than excusing it as inapplicable',
          fix: 'no FCS availability source is registered; a school release is the only route and none is wired' }));
    } else if (pol && pol.state === 'NOT_REQUIRED_FOR_THIS_GAME') {
      /* NOT A GAP IN EDGEDESK'S RESEARCH. No report exists because none was
         required, and the engine still prices maximum injury uncertainty. */
      contract.push(row('availability', side, 'NOT_REQUIRED',
        { source: pol.conference, detail: pol.why,
          fix: 'none available from a conference source. A school release or game notes are the only route, and '
            + 'they are registered per school in football/availability/sources.overrides.json' }));
    } else if (pol && pol.state === 'NOT_DUE_YET') {
      contract.push(row('availability', side, 'NOT_DUE_YET',
        { source: pol.conference,
          detail: pol.why + '. The report will exist ' + pol.policy.first_filing_hours_before_kickoff
            + ' hours before kickoff, which is in ' + Math.max(0, Math.round((pol.hours_to_kickoff
              - pol.policy.first_filing_hours_before_kickoff) * 10) / 10) + ' hours; until then there is no '
            + 'report to read and nobody is assumed healthy',
          fix: 're-run the availability sync inside the filing window (' + pol.report_url + ')' }));
    } else {
      /* WHY THE READ FAILED, not just that it did. The registry grades every
         team's read and records which sources refused. */
      const q = t ? String(t.dataQuality || t.data_quality || 'NONE').toUpperCase() : null;
      const failed = t && isNum(t.sources_failed) ? t.sources_failed : null;
      const checked = t && isNum(t.sources_checked) ? t.sources_checked : null;
      contract.push(row('availability', side, q === 'LIMITED' ? 'FETCH_FAILED' : 'UNAVAILABLE',
        { source: 'EdgeDesk college availability layer', as_of: ctx.availability_as_of,
          detail: !t
            ? `${name} is not in the availability registry; the engine prices this as maximum injury uncertainty, never as healthy`
            : `EdgeDesk read ${checked == null ? 'the'  : checked} source(s) for ${name} and ${failed ? failed + ' refused' : 'none carried a usable report'}`
              + `; the read is graded ${q} and an ungraded read is not a clean bill of health. `
              + 'The engine prices this as maximum injury uncertainty, never as healthy' + polNote,
          fix: pol && pol.report_url
            ? ('ingest the ' + pol.conference + ' availability report for this game from ' + pol.report_url)
            : 'register an official source for this programme in football/availability/sources.overrides.json, or '
              + 'record a dated operator correction in football/availability/operator.json' }));
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
    else if (!isFbs) contract.push(row('roster_talent', side, 'UNAVAILABLE',
      { source: 'EdgeDesk player layer',
        detail: `${name} is outside the FBS field the player layer rates, so no composite is measured for it. `
          + 'The engine charges for the gap, so the contract counts it as one',
        fix: 'the player layer is built from FBS play attribution; extending it to the FCS field is the fix, and '
          + 'nothing is substituted for it meanwhile' }));
    else contract.push(row('roster_talent', side, 'UNAVAILABLE',
      { source: 'EdgeDesk player layer',
        detail: `no rated roster resolved for ${name}` + (rq ? '' : '; football/players/current.json did not load') }));
  });

  /* ---- starter context ----------------------------------------------- */
  const st = ctx.starters && ctx.starters.teams ? ctx.starters.teams : {};
  const sh = st[hk] || null, sa = st[ak] || null;
  const starters = { home: sh, away: sa };
  const qbEvidenceClass = { home: null, away: null };
  const qbAvailEvidence = { home: 'NONE', away: 'NONE' };
  const qbAvailWhy = { home: null, away: null };
  [['home', sh, homeFbs, g.home_team], ['away', sa, awayFbs, g.away_team]].forEach(([side, rec, isFbs, name]) => {
    if (!rec) {
      contract.push(row('qb_starter', side, isFbs ? 'UNAVAILABLE' : 'NOT_APPLICABLE',
        { detail: isFbs ? `no starter record was built for ${name}`
          : `${name} is outside the rated universe; no starter context is assembled for it`,
          fix: isFbs ? 'run football/starters/build_starters.js --sport cfb' : null }));
      return;
    }
    const state = rec.field_state === 'USABLE' ? 'RESEARCH_ONLY' : rec.field_state;
    const cls = QBC.classOf(rec);
    qbEvidenceClass[side] = cls.id;
    contract.push(row('qb_starter', side, state, {
      source: rec.source, as_of: rec.retrieved_at, observed_at: rec.published_at || null,
      age_hours: hoursSince(rec.retrieved_at, now),
      identity: rec.identity_basis || null,
      /* THE EVIDENCE CLASS IS PART OF THE FIELD, not a footnote on it. A
         projection supported by a measured observation is neither a
         confirmation nor an unknown, and the row says which it is. */
      detail: rec.label + ' — ' + cls.label + ': ' + cls.means
        + '. Retrieved and published as research; the priced QB layer is not fed from it until the starter '
        + 'layer has an out-of-sample record of its own',
      fix: cls.id === 'CONFIRMED' ? null
        : 'a team or conference announcement for THIS game would move this to CONFIRMED; register one in '
          + 'football/availability/sources.overrides.json or record it in football/starters/announcements.json'
    }));
    /* ---- can the resolved starter play ------------------------------- */
    const av = rec.availability || {};
    const pol = avPolicy[side];
    if (av.evidence === 'EXPLICIT') {
      qbAvailEvidence[side] = 'EXPLICIT';
      qbAvailWhy[side] = av.why || null;
      contract.push(row('qb_availability', side, 'USABLE',
        { source: av.source, as_of: av.retrieved_at, observed_at: av.published_at || null,
          identity: 'the same athlete id the starter record resolved',
          detail: av.why || 'an availability source names this player and states a status' }));
    } else if (avEvidence[side] === 'COMPREHENSIVE_SILENCE') {
      /* the ONLY route from silence to available, and it needs a source the
         policy registry marks comprehensive for THIS fixture */
      qbAvailEvidence[side] = 'COMPREHENSIVE_SILENCE';
      qbAvailWhy[side] = 'named nowhere on a comprehensive report for this game';
      contract.push(row('qb_availability', side, 'USABLE',
        { source: pol && pol.conference, as_of: ctx.availability_as_of,
          detail: 'the comprehensive ' + (pol && pol.conference) + ' availability report for this game designates '
            + 'every player and does not name him, which is a report that he is available' }));
    } else if (pol && pol.state === 'NOT_REQUIRED_FOR_THIS_GAME') {
      contract.push(row('qb_availability', side, 'NOT_REQUIRED',
        { source: pol.conference, detail: pol.why,
          fix: 'no conference source exists for a non-conference fixture; a school release or game notes are the '
            + 'only route and are registered per school' }));
    } else if (pol && pol.state === 'NOT_DUE_YET') {
      contract.push(row('qb_availability', side, 'NOT_DUE_YET',
        { source: pol.conference, detail: pol.why + ' — no report on this quarterback exists yet, which is not '
            + 'a statement that he is fit',
          fix: 're-run the availability sync inside the filing window (' + pol.report_url + ')' }));
    } else {
      contract.push(row('qb_availability', side, 'UNAVAILABLE',
        { source: av.source, as_of: av.retrieved_at,
          detail: (av.why || 'no source states whether this quarterback can play')
            + (pol && pol.why ? '. ' + pol.why : ''),
          fix: pol && pol.report_url ? ('ingest the ' + pol.conference + ' availability report from ' + pol.report_url)
            : 'record a dated operator correction in football/availability/operator.json' }));
    }
  });

  /* ---- quarterback efficiency history --------------------------------- */
  /* THE FIELD THAT USED TO BE A DOCUMENTED PERMANENT GAP.

     `qbOpts` below passes season_epa_per_db: null and always did, on the
     grounds that no feed published it. One now does, and it is loaded, joined
     on the same athlete ids and published on every card. It is still NOT
     priced, and for a different and more specific reason: the audit in
     football/fbs_epa/epa_contract.js establishes that the provider's series
     is not on the scale the shipped coefficient was fitted on. So the row is
     RESEARCH_ONLY, which is a retrieved field that the published number does
     not price — the distinction this contract exists to keep.

     Four states, and they are four different statements: measured, a
     publication gap in the provider's table, an unresolved identity, and a
     quarterback who has genuinely never thrown an FBS pass. */
  const qbEpa = { home: null, away: null };
  /* "we measured his performance" is its own statement, kept beside "we know
     who he is" and "we expect him to start" rather than merged into either */
  const qbMeasured = { home: false, away: false };
  if (ctx.fbs_epa) {
    const EPAMOD = require(path.join(ROOT, 'football', 'fbs_epa', 'fbs_epa.js'));
    const kickoff = Date.parse(g.start_date);
    [['home', sh, hk, ak, homeFbs, g.home_team], ['away', sa, ak, hk, awayFbs, g.away_team]]
      .forEach(([side, rec, key, opp, isFbs, name]) => {
        const pk = EPAMOD.quarterback({ artifact: ctx.fbs_epa, starter: rec, team_key: key,
          opponent_key: opp, cutoff: isFinite(kickoff) ? kickoff : now, side });
        qbEpa[side] = pk;
        const card = EPAMOD.cardForm(pk);
        const stale = ctx.fbs_epa_freshness && ctx.fbs_epa_freshness.state === 'STALE';
        let state, detail;
        if (pk.state === 'MEASURED' && pk.career.state === 'MEASURED') {
          state = stale ? 'STALE' : 'RESEARCH_ONLY';
          qbMeasured[side] = !stale;
          detail = pk.identity.player + ' — ' + pk.career.epa_per_dropback + ' EPA per dropback over '
            + pk.career.dropbacks + ' career dropbacks'
            + (card.coverage_state === 'PARTIAL' ? ' (partial: a completed game has no passing row yet)' : '')
            + '. Research only: the provider\u2019s EPA is not on the scale the engine\u2019s coefficient '
            + 'was fitted on (football/fbs_epa/epa_contract.js)';
        } else if (pk.state === 'UNRESOLVED_IDENTITY') {
          state = isFbs ? 'UNAVAILABLE' : 'NOT_APPLICABLE';
          detail = isFbs ? 'no quarterback identity resolves for ' + name + ', so there is nobody to measure '
            + '\u2014 an unresolved identity, not a quarterback without history'
            : name + ' is outside the rated universe';
        } else if (pk.state === 'NO_OBSERVATIONS' || (pk.career && pk.career.state === 'NO_OBSERVATIONS')) {
          state = 'UNAVAILABLE';
          detail = (pk.identity && pk.identity.player ? pk.identity.player : 'this quarterback')
            + ' has thrown no FBS pass inside this history \u2014 an empty sample, never an average one';
        } else {
          state = 'UNAVAILABLE';
          detail = pk.why || 'no measured efficiency history for this side';
        }
        contract.push(row('qb_efficiency_history', side, state, {
          source: 'football/fbs_epa \u2014 sportsdataverse/cfbfastR-cfb-data adv_passing',
          as_of: ctx.fbs_epa.generated_at,
          age_hours: hoursSince(ctx.fbs_epa.generated_at, now),
          detail
        }));
      });
  } else {
    ['home', 'away'].forEach(side => contract.push(row('qb_efficiency_history', side, 'UNAVAILABLE',
      { detail: 'football/fbs_epa has published no artifact for this season \u2014 run '
        + 'football/fbs_epa/build_epa.js' })));
  }

  /* ---- recruiting talent ---------------------------------------------- */
  /* THIS ROW WAS A PERMANENT GAP FOR A REASON THAT ANSWERED A NARROWER
     QUESTION THAN THE FIELD ASKS. "Per-player recruiting ratings are
     subscription data" is true and still true; the field asks how much
     pedigree is on the roster, and the per-TEAM composite that answers it is
     published keyless in the same mirror this repository already reads. It is
     RESEARCH_ONLY, not USABLE: no coefficient has been fitted against it on
     this corpus, so like the EPA series it is retrieved, published and not
     priced. One row per side, because it is a fact about a team. */
  const TT = ctx.team_talent && ctx.team_talent.teams ? ctx.team_talent.teams : null;
  [['home', hk, homeFbs, g.home_team], ['away', ak, awayFbs, g.away_team]].forEach(([side, key, isFbs, name]) => {
    const t = TT ? TT[key] : null;
    if (t && isNum(t.talent_composite)) {
      contract.push(row('recruiting_talent', side, 'RESEARCH_ONLY',
        { source: ctx.team_talent.source, as_of: ctx.team_talent.generated_at,
          age_hours: hoursSince(ctx.team_talent.generated_at, now),
          identity: 'joined on the provider’s ESPN team id and corroborated against the roster sync’s '
            + 'own spelling for that id',
          detail: 'composite ' + t.talent_composite + ' (national rank ' + t.talent_rank + '), blue-chip ratio '
            + t.blue_chip_ratio + ' over ' + t.recruits + ' rated recruits. Retrieved and published as research: '
            + 'no coefficient has been fitted against this series on this corpus, so it moves no point. '
            + 'PER-TEAM only — per-player recruiting ratings remain subscription data and are still not '
            + 'substituted anywhere' }));
    } else if (!isFbs) {
      contract.push(row('recruiting_talent', side, 'NOT_APPLICABLE',
        { detail: `${name} is outside the FBS field EdgeDesk rates` }));
    } else {
      contract.push(row('recruiting_talent', side, 'UNAVAILABLE',
        { source: ctx.team_talent ? ctx.team_talent.source : 'sportsdataverse/cfbfastR-cfb-data cfb_team_talent',
          detail: ctx.team_talent
            ? `the provider’s ${ctx.team_talent.season} team-talent table does not carry ${name} — a `
              + 'publication gap in the source, not an unresolved identity here'
            : 'football/players/team_talent.json has not been built',
          fix: ctx.team_talent ? null : 'run football/players/build_team_talent.js' }));
    }
  });

  /* ---- the team rating and the matchup profile ------------------------- */
  /* THE TWO BIGGEST-WEIGHT INPUTS HAD NO CONTRACT ROW AT ALL.

     `rating` carries 1.0 of the 4.083 weight table — as much as the
     quarterback and four times the venue — and `matchup` carries 0.4, and
     neither appeared on the input contract. So on an FBS-vs-FCS game the
     score was being charged twenty points for a rating it could not measure
     and the card had no field to hang that on: the confidence ledger
     reported it as a point EdgeDesk had lost to nothing in particular. A
     reader could see 30% and find nothing on the contract that explained it.

     They are rows now, with the same rules as every other field: a rated
     programme is USABLE, an unrated one is UNAVAILABLE with the reason, and
     the ledger attributes the loss to the field instead of to a residue. */
  const ratedH = o.state && o.state.r ? o.state.r[hk] : undefined;
  const ratedA = o.state && o.state.r ? o.state.r[ak] : undefined;
  const gamesOf = (k) => (o.state && o.state.g && isNum(o.state.g[k])) ? o.state.g[k] : null;
  [['home', hk, ratedH, homeFbs, g.home_team], ['away', ak, ratedA, awayFbs, g.away_team]]
    .forEach(([side, key, rat, isFbs, name]) => {
      if (isNum(rat) && isFbs) {
        const n = gamesOf(key);
        contract.push(row('team_rating', side, 'USABLE',
          { source: 'EdgeDesk ETSR + the trained preseason seed',
            identity: 'the engine’s own team key',
            detail: 'rated ' + Math.round(rat * 100) / 100
              + (n == null ? '' : ' over ' + n + ' absorbed game(s) this season')
              + ', blended with the trained prior on the learned curve' }));
      } else {
        contract.push(row('team_rating', side, 'UNAVAILABLE',
          { source: 'EdgeDesk ETSR',
            detail: name + ' is outside the rated FBS field, so the projection uses params.rating.fcs_rating '
              + '— ONE floor number shared by every FCS programme. That is not a rating of this team, and '
              + 'the engine charges the full weight of the rating input for it. This row exists so that charge '
              + 'lands on a named field instead of on nothing',
            fix: 'no public rating of the FCS field is wired in; the floor is the honest substitute and the '
              + 'confidence cost is the honest price of it' }));
      }
    });
  const profH = ctx.rooms && ctx.rooms[hk], profA = ctx.rooms && ctx.rooms[ak];
  if (homeFbs && awayFbs) contract.push(row('matchup_profile', null, 'USABLE',
    { source: 'football/matchup/profiles_' + ctx.season + '.json',
      detail: 'both sides carry a team-game profile, so the stylistic pairing is measurable' }));
  else contract.push(row('matchup_profile', null, 'UNAVAILABLE',
    { source: 'football/matchup/profiles_' + ctx.season + '.json',
      detail: 'the stylistic pairing needs a measured profile for BOTH sides and '
        + (homeFbs ? g.away_team : g.home_team) + ' is outside the FBS field the profiles cover',
      fix: 'none available: the profile is built from FBS play attribution and no equivalent is published for '
        + 'the FCS field' }));

  /* ---- off-field reporting -------------------------------------------- */
  /* A FIELD THE ENGINE SCORES AND THE CONTRACT NEVER PUBLISHED. The
     confidence table carries offfield_home and offfield_away, they are
     M.missing on every game in the universe, and together they were costing
     2.4 points of every score with nothing on the card to say so. A gap the
     reader cannot see is worse than a gap: it makes the number look
     arbitrary. So it is a contract row, one per side, with its cost
     attributable like every other row.

     NOTHING IS SUBSTITUTED FOR IT. The engine's own rule is that a signal
     must be public, sourced, dated and severity-graded before it may touch
     even the confidence score, and passing the injury layer's output in its
     place would be scoring one question with another question's answer. */
  ['home', 'away'].forEach(side => {
    const news = ctx.off_field_for ? ctx.off_field_for(side === 'home' ? hk : ak) : null;
    if (news && news.length) contract.push(row('off_field', side, 'USABLE',
      { source: ctx.off_field_source || 'supplied public reporting', as_of: ctx.off_field_as_of || null,
        detail: news.length + ' sourced, dated signal(s) on file' }));
    else if (news) contract.push(row('off_field', side, 'USABLE',
      { source: ctx.off_field_source || 'supplied public reporting', as_of: ctx.off_field_as_of || null,
        detail: 'the configured reporting sources were read and carried nothing material for this side' }));
    else contract.push(row('off_field', side, 'UNAVAILABLE',
      { detail: 'no off-field reporting feed is wired in. The engine scores this input and it is missing on every '
          + 'game, so it is published here rather than left invisible. A signal must be public, sourced, dated and '
          + 'severity-graded before it may move even the confidence score, and no keyless feed EdgeDesk reads '
          + 'supplies all four; the availability layer answers a different question and is not substituted for it',
        fix: 'supply dated, sourced, severity-graded signals through ctx.off_field_for(teamKey) — the assembly '
          + 'passes whatever it returns straight to the engine’s off-field layer' }));
  });

  /* ---- documented, permanent gaps ------------------------------------ */
  contract.push(row('coaching_continuity', null, 'UNAVAILABLE',
    { detail: 'no public, keyless feed carries head-coach or coordinator continuity. sportsdataverse publishes '
      + 'rosters, schedules, play attribution and team talent for this season and no coaching table; '
      + 'CollegeFootballData’s coaches endpoint needs a per-user key whose terms forbid redistributing the '
      + 'result as a committed dataset. Checked 2026-09-15 and recorded as checked',
      fix: 'a licensed caller may supply staff continuity through the engine’s `coaching` input; there is no '
        + 'keyless route to wire' }));

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
         EPA per dropback on the scale its coefficient was fitted on, which
         the published series is not (see qbOpts below). `qb_context` is a
         different question — who is playing and how well do we know it — and
         the engine reads it for its information score and for nothing that
         computes a point. The starter reaching the projection as CONTEXT is
         not the starter being priced; PRICED_STARTER_STATUSES is still the
         only switch for that, and it is still empty. */
      home: { conference: g.home_conference, roster: rh, qb: null,
        qb_context: qbContext(sh, ctx, hk, { efficiency_history: qbMeasured.home,
          availability_evidence: qbAvailEvidence.home, availability_why: qbAvailWhy.home }),
        injuries: ih, news: ctx.off_field_for ? ctx.off_field_for(hk) : null, coaching: null, schedule: ch },
      away: { conference: g.away_conference, roster: ra, qb: null,
        qb_context: qbContext(sa, ctx, ak, { efficiency_history: qbMeasured.away,
          availability_evidence: qbAvailEvidence.away, availability_why: qbAvailWhy.away }),
        injuries: ia, news: ctx.off_field_for ? ctx.off_field_for(ak) : null, coaching: null, schedule: ca }
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
    /* the measured efficiency history, carried beside the request and inside
       neither of them. The engine is handed identity and availability; it is
       NOT handed these numbers, because the coefficient that would turn them
       into points was fitted on a different scale. */
    qb_epa: qbEpa,
    qb_epa_freshness: ctx.fbs_epa_freshness || null,
    qb_pricing: { home: { priced: qbh.priced, why: qbh.why }, away: { priced: qba.priced, why: qba.why },
      whitelist: PRICED_STARTER_STATUSES.slice() },
    summary: summarise(contract)
  };
}

/* THE STARTER, FLATTENED FOR THE ENGINE'S INFORMATION LAYER.

   The flattening itself now lives in football/matchup/qb_context.js, loaded
   by this assembly AND by app.html, because two copies of one contract is how
   the board and the committed artifact come to disagree about the same game
   out of the same files. What stays here is only the wiring: which artifacts
   this process holds and what they say about this quarterback. */
function qbContext(rec, ctx, teamKey, extra) {
  extra = extra || {};
  return QBC.build(rec, {
    persistence: ctx.persistence,
    efficiency_history: extra.efficiency_history === true,
    availability_evidence: extra.availability_evidence || 'NONE',
    availability_why: extra.availability_why || null
  });
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
    /* EPA PER DROPBACK IS NOW OBSERVED, AND STILL DOES NOT GO HERE.

       This used to be null because no feed published it. That changed:
       football/fbs_epa carries it for every FBS quarterback from 2014, joined
       on these same athlete ids, and it is on every card. It stays null in
       THIS object for a narrower and better-evidenced reason.

       `params.qb.points_per_epa_db` is a slope in points per unit of EPA per
       dropback, and it was fitted against EdgeDesk's own reconstructed
       expected-points surface over a corpus with garbage time removed. The
       provider's series comes from a different expected-points model, keeps
       garbage time, and has a league average of +0.061 against the engine's
       replacement prior of 0.0. Passing one series into the other's slope
       would produce a football-sized number with no meaning behind it.

       So the efficiency history travels beside the request as research and
       the VALUE term stays missing, exactly as it was. What the play feed does
       publish and what this object does pass is the start count and the
       dropback volume, which drive the QB STABILITY term: an unknown starter
       is the minimum-stability case, and a quarterback with fifteen measured
       starts is not an unknown starter. That moves the distribution rather
       than the mean, and it is the whole of the shadow difference.

       football/fbs_epa/epa_contract.js holds the audit and the single flag;
       COMPATIBILITY.what_would_settle_it is the list of what would change
       this line. */
    season_epa_per_db: null, career_epa_per_db: null,
    /* THE SUBSTITUTE ROUTE. EPA per dropback stays null above because no feed
       publishes it; this is the measured stand-in and the coefficient fitted
       against it. Both travel together so the engine cannot price one with the
       other's calibration, and `points_applied` inside the calibration decides
       whether it prices at all — today it is false and the layer contributes
       zero, exactly as it did before the coefficient existed. */
    quality: qbQualityOf(ctx, rec),
    quality_calibration: qbCalibrationOf(ctx),
    attempts: exp && isNum(exp.dropbacks) ? exp.dropbacks : null,
    starts: exp && isNum(exp.starts) ? exp.starts : null,
    rush_value: null, new_system: null,
    returning_starter: exp ? (exp.seasons_observed > 1) : null
  };
}

/* One passer's score on the metric the coefficient was fitted against. A
   passer the window never saw returns null, and the engine then reports the
   value missing rather than pricing him at the league average. */
function qbQualityOf(ctx, rec) {
  const cal = ctx && ctx.qb_quality;
  if (!cal || !cal.players || !rec || !rec.player_id) return null;
  const row = cal.players[String(rec.player_id)];
  if (!row) return null;
  const v = row[cal.chosen_metric];
  return isNum(v) ? v : null;
}

/* The coefficient and, more importantly, the switch. Passed through verbatim
   from the artifact so the decision travels with the number and nothing here
   can quietly override it. */
function qbCalibrationOf(ctx) {
  const cal = ctx && ctx.qb_quality;
  if (!cal) return null;
  const w = cal.metrics && cal.metrics[cal.chosen_metric];
  return {
    metric: cal.chosen_metric,
    points_per_quality: cal.points_per_quality,
    points_applied: cal.points_applied === true,
    tune_window_games: cal.tune_window_games,
    held_out_mae_delta: w ? w.mae_delta : null,
    decision: cal.decision,
    as_of: cal.generated_at || null
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
