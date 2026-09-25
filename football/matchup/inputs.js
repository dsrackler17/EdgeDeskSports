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
const AV_OVERLAY = require(path.join(ROOT, 'football', 'availability', 'overlay.js'));
/* THE INPUT CONTRACT, shared with the browser: the rows are assembled in
   football/matchup/contract.js, which app.html loads too, so the board and
   the published slate cannot count coverage two different ways again */
const CONTRACT = require(path.join(HERE, 'contract.js'));

/* THE STATES A CONTRACT ROW MAY TAKE. Two were added with the availability
   policy and both are deliberately NOT excused from the denominator:

     NOT_REQUIRED  no conference filing was required for this fixture. True,
                   precise, and not a statement that anybody is healthy.
     NOT_DUE_YET   a report is required and its first filing is still hours
                   away. The document does not exist yet.

   Only NOT_APPLICABLE leaves the denominator, and only for a question that
   genuinely does not arise: weather under a roof, travel at a neutral site. */
const STATES = CONTRACT.STATES;

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
const row = CONTRACT.row;

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
  /* AND THE FLOOR UNDER BOTH: football/venues/resolved.json, generated by
     football/venues/build_venues.js from the same public mirror this repo
     already reads for schedules and rosters. It fills what neither the
     trained table nor the hand-checked supplement has — which on this slate
     was nineteen FCS visitors, every one of them an AWAY side, which is why
     the weather layer was never short of coordinates but travel distance was.

     PRECEDENCE IS NOT NEGOTIABLE HERE. The trained table wins because the
     model's venue coefficients were fitted on it; moving a stadium under a
     trained number would make the parameters describe a different place. The
     supplement comes next because a person checked it against a named source.
     This is last, and it never overwrites either. */
  /* WHO IS COACHING, AND SINCE WHEN. football/coaching/build_coaching.js
     reads cfbfastR's coach table and walks each tenure back until the name
     changes. It answers the HEAD COACH question only — that feed carries no
     coordinators — so `new_oc` and `new_dc` arrive null and the engine is
     told which of the three were actually supplied. */
  /* OFF-FIELD SIGNALS, through the one door that exists.
     football/offfield/record_signal.js validates every entry against the four
     properties the engine's decay actually reads and refuses anything short of
     all four. `for(key)` returns NULL when nobody looked and [] when a
     registered source was read and carried nothing — the engine already
     prices those two differently and EdgeDesk previously could produce
     neither. */
  let offfield = null;
  try { offfield = require(path.join(ROOT, 'football', 'offfield', 'record_signal.js')).load({ now: Date.now() }); }
  catch (_) { offfield = null; }
  if (offfield) {
    out.off_field_for = offfield.for;
    out.off_field_source = 'EdgeDesk off-field register (football/offfield/signals.json)';
    out.off_field_as_of = offfield.as_of || null;
    out.off_field_counts = offfield.counts;
    if (offfield.refused && offfield.refused.length) out.problems.push(offfield.refused.length
      + ' off-field signal(s) are refused for missing a source, a date or a severity grade — run '
      + 'node football/offfield/record_signal.js --list');
  }

  const coach = readJson(path.join(ROOT, 'football', 'coaching', 'continuity.json'), null);
  out.coaching = (coach && coach.by_team) || {};
  out.coaching_source = coach ? (coach.source || null) : null;
  out.coaching_as_of = coach ? (coach.generated_at || null) : null;
  out.coaching_season = coach ? (coach.season || null) : null;
  /* the one mapping, shared with the board (football/matchup/contract.js) */
  out.coaching_for = function (key) { return CONTRACT.coachingFor(out.coaching, key); };

  const gen = readJson(path.join(ROOT, 'football', 'venues', 'resolved.json'), null);
  /* THE ONE MERGE, shared with the board (football/matchup/contract.js
     mergeVenues): trained table, then the supplement, then the generated
     floor, none overwriting another's coordinates. Written back into the
     trained table in place, as this assembly always has. */
  const mv = CONTRACT.mergeVenues(out.venues, supp, gen);
  Object.keys(mv.venues).forEach(k => { out.venues[k] = mv.venues[k]; });
  out.venue_supplement = mv.supplement;
  out.venue_resolved = mv.resolved;

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

  /* Individual player identity/value rows. These stay separate from the team
     talent composite because they answer a different question: when an
     availability source names a player, who exactly is he and how much of the
     unit does he actually play? */
  out.player_details_by_team = loadPlayerDetails();
  out.player_detail_teams = Object.keys(out.player_details_by_team).length;
  if (!out.player_detail_teams) out.problems.push(
    'football/players/teams has no readable player detail files — injury rows cannot be identity-enriched');

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
    /* in file-name order, the order the board's bundle carries them in
       (football/availability/reports.js bundle): a team with two filings on
       file keeps the later one, on every machine */
    for (const f of fs.readdirSync(rdir).sort()) {
      if (!/\.json$/.test(f)) continue;
      const r = readJson(path.join(rdir, f), null);
      if (r && r.schema === 'edgedesk_availability_report_v1') reports.push(r);
    }
  }
  const opLoaded = OPERATOR.load(opStore || { entries: [] }, nowMs);
  const merged = OVERLAY.build({ current: av, operator: opLoaded, reports, now: nowMs, normKey });
  out.availability = av;
  out.availability_as_of = av ? (av.generated_at || null) : null;
  /* THE FAILURES THE REGISTRY ALREADY GROUPED. `failure_groups` marks a
     source `systematic` when it refused for every programme on the same run:
     two ESPN endpoints currently do, 276 refusals per run, with the same
     status every time. That is one closed endpoint, and the contract says so
     rather than reporting it as a hundred and thirty-eight bad reads. */
  out.availability_systematic = (av && Array.isArray(av.failure_groups))
    ? av.failure_groups.filter(f => f && f.systematic)
        .map(f => ({ source: f.source, error: f.error, teams: f.teams, kind: f.kind }))
    : [];
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
       but it IS the field the engine asked for and it is supplied here —
       through the one function the board calls too. */
    CONTRACT.applyTeamTalent(out.rosters, out.team_talent);
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

function normPersonName(s) {
  if (s == null) return null;
  let v = String(s).trim().toLowerCase();
  try { v = v.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return v.replace(/[^a-z0-9]+/g, '') || null;
}

/* Build a compact individual-player index from football/players/teams/*.json.
   Availability sources rarely publish athlete ids, so the only safe bridge is
   a UNIQUE name inside the already-known team. Ambiguity deliberately resolves
   to nothing; a wrong athlete is worse than an unknown athlete. */
function loadPlayerDetails() {
  const out = {};
  const dir = path.join(ROOT, 'football', 'players', 'teams');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.json$/.test(f)) continue;
    const d = readJson(path.join(dir, f), null);
    if (!d || !Array.isArray(d.players)) continue;
    const tk = normKey(d.key || d.team || f.replace(/\.json$/, ''));
    if (!tk) continue;
    const byName = {}, groups = {};
    for (const p of d.players) {
      if (!p || !p.n) continue;
      const nk = normPersonName(p.n);
      if (nk) {
        if (!byName[nk]) byName[nk] = p;
        else byName[nk] = null; /* ambiguous within this team: refuse the join */
      }
      const g = String(p.g || p.p || '').toUpperCase();
      if (g) (groups[g] = groups[g] || []).push(p);
    }
    Object.keys(groups).forEach(g => groups[g].sort((a, b) =>
      (isNum(b.e) ? b.e : -Infinity) - (isNum(a.e) ? a.e : -Infinity)
      || (isNum(b.share) ? b.share : -1) - (isNum(a.share) ? a.share : -1)));
    out[tk] = { team: d.team || null, generated_at: d.generated_at || null, by_name: byName, groups };
  }
  return out;
}

function playerIdentity(ctx, teamName, playerName) {
  const t = ctx && ctx.player_details_by_team && ctx.player_details_by_team[normKey(teamName)];
  const nk = normPersonName(playerName);
  if (!t || !nk || !Object.prototype.hasOwnProperty.call(t.by_name || {}, nk)) return null;
  return t.by_name[nk] || null;
}

function replacementFor(ctx, teamName, athlete, scopedAvailability) {
  if (!athlete) return null;
  const t = ctx && ctx.player_details_by_team && ctx.player_details_by_team[normKey(teamName)];
  if (!t) return null;
  const g = String(athlete.g || athlete.p || '').toUpperCase();
  const rows = (t.groups && t.groups[g]) || [];
  const blocked = {};
  (scopedAvailability || []).forEach(p => {
    const st = String(p.status || p.availability_status || '').toUpperCase();
    if (st === 'OUT' || st === 'DOUBTFUL' || st === 'OUT_FIRST_HALF') {
      const k = normPersonName(p.player_name || p.name);
      if (k) blocked[k] = true;
    }
  });
  for (const p of rows) {
    if (!p || String(p.id || '') === String(athlete.id || '')) continue;
    if (blocked[normPersonName(p.n)]) continue;
    if (!isNum(p.e)) continue;
    return p;
  }
  return null;
}

/* --------------------------------------------------------------- injuries */
/* THE SAME CONTRACT THE TERMINAL USES, and the same distinction it protects:
   a team EdgeDesk could not read returns null (the engine prices maximum
   injury uncertainty); a team it DID read and found nobody on returns [] (a
   real report saying everybody is available). Collapsing those two was never
   an option and is not one here. */
const AVAIL_TO_ENGINE = { OUT: 'out', DOUBTFUL: 'doubtful', QUESTIONABLE: 'questionable',
  GAME_TIME_DECISION: 'questionable', DAY_TO_DAY: 'questionable',
  /* The pricing engine has no half-game designation. QUESTIONABLE is its
     measured 0.50 status weight, so OUT_FIRST_HALF maps there: exactly half
     the full-OUT status effect instead of disappearing or becoming four
     quarters of absence. */
  OUT_FIRST_HALF: 'questionable',
  PROBABLE: 'probable', LIMITED: 'probable' };

const officialReportForGame = CONTRACT.officialReportForGame;

function injuriesFor(ctx, teamName, gameId) {
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
  /* The grade vocabulary is the overlay's, not a copy: OFFICIAL, STRONG and
     PARTIAL are reads that reached a report; LIMITED and NONE are not. */
  const q = AV_OVERLAY.normGrade(t.dataQuality || t.data_quality);
  if (!AV_OVERLAY.isGraded(q)) return null;

  /* A conference filing is evidence about ONE fixture. Historical reports stay
     on disk for audit/backtest purposes, so the consumer must scope them here.
     Unscoped rows are the general automated/media evidence layer and may carry
     forward while fresh; a row that names a game may not. */
  const official = officialReportForGame(t, gameId);
  const scoped = (t.players || []).filter(p =>
    p.game_id == null || gameId == null || String(p.game_id) === String(gameId));
  const out = [];
  scoped.forEach(p => {
    const st = AVAIL_TO_ENGINE[String(p.status || p.availability_status || '').toUpperCase()];
    if (!st) return;
    const playerName = p.player_name || p.name || null;
    const athlete = playerIdentity(ctx, teamName, playerName);
    const replacement = athlete ? replacementFor(ctx, teamName, athlete, scoped) : null;
    const role = athlete && athlete.role != null ? athlete.role : p.depth_role;
    const share = athlete && isNum(athlete.share) ? athlete.share : null;
    /* Player quality is still research-only. Keep the resolved replacement
       and his rating for audit/explanation, but do NOT feed that unpromoted
       rating into the priced replacement_quality field. The engine therefore
       retains its trained/default neutral replacement assumption until this
       layer clears walk-forward validation. */
    const replQualityResearch = replacement && isNum(replacement.e)
      ? Math.max(0, Math.min(1, replacement.e / 100)) : null;
    out.push({
      player: playerName,
      athlete_id: athlete ? String(athlete.id) : null,
      identity_basis: athlete ? 'unique team/name -> player-layer athlete_id' : null,
      identity_confidence: athlete && isNum(athlete.cf) ? athlete.cf : null,
      player_rating: athlete && isNum(athlete.e) ? athlete.e : null,
      position: (athlete && (athlete.p || athlete.g)) || p.position || null,
      starter: role == null ? null : /(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(role)),
      snap_share: share,
      severity: null,
      status: st,
      replacement_quality: null,
      replacement_quality_research: replQualityResearch,
      replacement_player_id: replacement ? String(replacement.id) : null,
      replacement_player: replacement ? replacement.n : null,
      replacement_rating: replacement && isNum(replacement.e) ? replacement.e : null,
      source: p.source_name || t.team_name || null,
      as_of: p.observed_at || t.lastUpdated || ctx.availability_as_of
    });
  });
  if (out.length) return out;

  /* An empty array means a real clean report to the engine. Grant that meaning
     only to a COMPREHENSIVE official filing for THIS game. A selected report
     naming nobody, or an OFFICIAL grade inherited from last week's filing, is
     still unknown for the mean and returns null. */
  if (official && official.comprehensive) return [];

  /* General unscoped evidence can still be a graded read that simply carries
     no priced designation. Preserve the pre-existing contract for that case,
     but never let an old fixture-scoped row create the empty array. */
  if (scoped.some(p => p.game_id == null)) return out;
  return null;
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

/* what the shared contract needs from this process: the shared modules, and
   the three joins that read this process's own artifacts */
let EPAMOD_ = null;
const CONTRACT_DEPS = {
  POLICY, QBC,
  get EPAMOD() { return EPAMOD_ || (EPAMOD_ = require(path.join(ROOT, 'football', 'fbs_epa', 'fbs_epa.js'))); },
  injuriesFor,
  availabilityTeam: (ctx, name) => ctx.availability_by_team[normKey(name)] || null,
  schedCtx: (si, game, which) => (si ? schedCtx(si, game, which) : null)
};

/* ------------------------------------------------------------ the assembly */
/* game: a normalised schedule row. meta: the FBS classification for it.
   Returns { baseline, enriched, contract, starters, applicable }. */
function buildRequest(ctx, o) {
  /* THE CONTRACT, from the one definition the board also loads
     (football/matchup/contract.js). It returns the rows and every fact it
     resolved on the way — the venues, the forecast, the rosters, the
     injury lists, the starters, the schedule context and the QB evidence —
     so the request below is assembled from exactly what the contract
     describes. */
  const A = CONTRACT.assemble(ctx, o, CONTRACT_DEPS);
  const contract = A.contract, starters = A.starters, qbEpa = A.qb_epa;
  const hk = A.hk, ak = A.ak, sh = A.starters.home, sa = A.starters.away;

  /* ---------------------------------------------------- the two requests */
  /* the baseline, from the same shared assembly the board uses */
  const baseline = CONTRACT.request(A, ctx, o, CONTRACT_DEPS);

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

/* THE STARTER, FLATTENED FOR THE ENGINE'S INFORMATION LAYER, is built by
   football/matchup/contract.js request() through football/matchup/qb_context.js —
   the one flattening this assembly and app.html both load. */


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

const summarise = CONTRACT.summarise;

module.exports = { load, buildRequest, injuriesFor, officialReportForGame, scheduleIndex, schedCtx,
  summarise, STATES, PRICED_STARTER_STATUSES, normKey, normPersonName, row, AVAIL_TO_ENGINE,
  loadPlayerDetails, playerIdentity, replacementFor };
