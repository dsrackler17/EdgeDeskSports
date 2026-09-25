/* ============================================================================
   THE INPUT CONTRACT — one definition of what EdgeDesk says it has on file
   for a college game, shared by the published build and the board.

   WHY THIS FILE EXISTS. The contract was written twice: in
   football/matchup/inputs.js for the build that publishes
   football/fbs/slate.json, and in app.html fbP4Contract() for the board. Each
   carried a comment saying the two could not disagree. They did: the board
   listed 17 rows and the build 26, with different states for the same field,
   so the same game read 59% input coverage on the board and 77% in the
   published artifact — and lib/cfb_research_view.js turns coverage under 60%
   into LOW RELIABILITY, so the board, the article built from the same payload
   and the AI desk reading the slate could give one game two research labels.

   So the rows are assembled here, once, from the facts each caller holds, and
   both callers load this file (the build by require, the board by
   <script src>). What the two may still differ on is the DATA — a forecast
   the board fetched live that the build carried forward, a source that
   answered one and refused the other — and then the contract says so in its
   own rows, which is what it is for. The CODE cannot differ any more.

   THE STATES. Seven, and only three of them are a problem:

     USABLE         retrieved, current, and fed to the model
     RESEARCH_ONLY  retrieved and trustworthy, deliberately not priced
     STALE          retrieved, but older than this field's own floor
     CONFLICTING    two sources, one field, no resolution
     NOT_APPLICABLE the question does not arise here (weather in a dome,
                    travel at a neutral site)
     NOT_REQUIRED   no conference filing was required for this fixture
     NOT_DUE_YET    a report is required and its first filing is hours away
     FETCH_FAILED   EdgeDesk tried and the source refused
     UNAVAILABLE    no source EdgeDesk can reach publishes it at all

   Only NOT_APPLICABLE leaves the denominator.

   THE CALLER SUPPLIES, never this file:
     ctx   the season's facts: venues, weather, rosters, the availability
           layer, the player layer, starters, the EPA history, team talent,
           off-field and coaching readers (football/matchup/inputs.js load()
           builds it for the build; app.html fbP4InputCtx() for the board)
     o     the game: {game, meta, now, state, schedule_index}
     deps  the shared modules and the two per-caller joins:
             POLICY  football/availability/policy.js
             QBC     football/matchup/qb_context.js
             EPAMOD  football/fbs_epa/fbs_epa.js (only when ctx.fbs_epa)
             injuriesFor(ctx, teamName, gameId)  the engine's injury list —
                   both callers pass this file's own injuriesFor
             availabilityTeam(ctx, teamName)     the availability record
             schedCtx(si, game, side)            the schedule context
   It reads no file, no clock but o.now, and no page.

   Node and browser (UMD).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDInputContract = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var STATES = ['USABLE', 'RESEARCH_ONLY', 'STALE', 'CONFLICTING', 'NOT_APPLICABLE',
    'NOT_REQUIRED', 'NOT_DUE_YET', 'FETCH_FAILED', 'UNAVAILABLE'];

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function hoursSince(t, now) { var a = Date.parse(t); return isFinite(a) ? (now - a) / 3600000 : null; }
  function normKey(s) {
    if (s == null) return null;
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
  }

  /* ONE CONTRACT ROW. Beyond the state it carries the four things a reader
     needs in order to check it rather than believe it: WHEN THE FACT WAS
     OBSERVED (which is not when EdgeDesk retrieved it), HOW THE IDENTITY WAS
     RESOLVED, WHAT WOULD FILL IT, and whether the published number prices it.
     `observed_at` and `as_of` are deliberately two fields: re-reading an
     unchanged artifact moves the second and must never move the first. */
  function row(field, side, state, o) {
    o = o || {};
    return { field: field, side: side || null, state: state,
      source: o.source || null,
      as_of: o.as_of || null,
      observed_at: o.observed_at || null,
      age_hours: o.age_hours == null ? null : Math.round(o.age_hours * 10) / 10,
      identity: o.identity || null,
      detail: o.detail || null,
      fix: o.fix || null,
      priced: state === 'USABLE' };
  }

  function summarise(contract) {
    var by = {};
    STATES.forEach(function (s) { by[s] = 0; });
    contract.forEach(function (c) { by[c.state] = (by[c.state] || 0) + 1; });
    /* THE DENOMINATOR EXCLUDES WHAT DOES NOT APPLY. A dome has no weather to be
       missing and a neutral site has no travel asymmetry; counting either as a
       hole made the number smaller and told the reader nothing. */
    var applicable = contract.length - by.NOT_APPLICABLE;
    var known = by.USABLE + by.RESEARCH_ONLY;
    return {
      fields: contract.length, applicable: applicable, by_state: by,
      known: known, priced: by.USABLE,
      input_coverage: applicable ? Math.round((known / applicable) * 1000) / 1000 : null,
      priced_coverage: applicable ? Math.round((by.USABLE / applicable) * 1000) / 1000 : null,
      basis: 'input_coverage counts every applicable field EdgeDesk retrieved, whether or not it is approved '
        + 'for pricing; priced_coverage counts only the ones the published number actually uses. '
        + 'NOT_APPLICABLE fields are excluded from the denominator, never counted as missing.'
    };
  }

  /* a conference filing is evidence about ONE fixture */
  function officialReportForGame(team, gameId) {
    var r = team && team.official_report;
    if (!r || !r.ok || r.game_id == null || gameId == null) return null;
    return String(r.game_id) === String(gameId) ? r : null;
  }

  /* ==== WHO IS OUT, AND WHO THEY ARE ==================================
     The availability layer names a player; the engine prices a player. The
     bridge between them — which athlete this is, whether he starts, how
     much of the unit he plays, who replaces him — is the one thing about an
     injury that moves a number: context.injuryImpact prices a trained
     position's absence only for a row flagged `starter`, and scales its
     uncertainty by `snap_share`. The build had this bridge and the board had
     a copy that was never handed the teams a conference report named, so a
     starting quarterback listed out moved the published number and not the
     board's. It is here once, for both.

     ctx.player_details_by_team  { teamKey: playerDetailsFrom(teamFile) }
     ctx.availability_by_team    the merged availability view, by team key
     deps.AV_OVERLAY             football/availability/overlay.js (grades) */
  function normPersonName(s) {
    if (s == null) return null;
    var v = String(s).trim().toLowerCase();
    try { v = v.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return v.replace(/[^a-z0-9]+/g, '') || null;
  }

  var AVAIL_TO_ENGINE = { OUT: 'out', DOUBTFUL: 'doubtful', QUESTIONABLE: 'questionable',
    GAME_TIME_DECISION: 'questionable', DAY_TO_DAY: 'questionable',
    /* The pricing engine has no half-game designation. QUESTIONABLE is its
       measured 0.50 status weight, so OUT_FIRST_HALF maps there: exactly half
       the full-OUT status effect instead of disappearing or becoming four
       quarters of absence. */
    OUT_FIRST_HALF: 'questionable',
    PROBABLE: 'probable', LIMITED: 'probable' };

  /* One team's player file (football/players/teams/<key>.json) as the join
     reads it. Availability sources rarely publish athlete ids, so the only
     safe bridge is a UNIQUE name inside the already-known team: a name two
     players share resolves to nothing, because a wrong athlete is worse than
     an unknown one. */
  function playerDetailsFrom(d) {
    if (!d || !d.players || !d.players.length) return null;
    var byName = {}, groups = {};
    d.players.forEach(function (p) {
      if (!p || !p.n) return;
      var k = normPersonName(p.n);
      if (k) byName[k] = Object.prototype.hasOwnProperty.call(byName, k) ? null : p;
      var g = String(p.g || p.p || '').toUpperCase();
      if (g) (groups[g] = groups[g] || []).push(p);
    });
    Object.keys(groups).forEach(function (g) {
      groups[g].sort(function (a, b) {
        return (isNum(b.e) ? b.e : -Infinity) - (isNum(a.e) ? a.e : -Infinity)
          || (isNum(b.share) ? b.share : -1) - (isNum(a.share) ? a.share : -1);
      });
    });
    return { team: d.team || null, generated_at: d.generated_at || null, by_name: byName, groups: groups };
  }

  function playerIdentity(ctx, teamName, playerName) {
    var t = ctx && ctx.player_details_by_team && ctx.player_details_by_team[normKey(teamName)];
    var k = normPersonName(playerName);
    if (!t || !k || !Object.prototype.hasOwnProperty.call(t.by_name || {}, k)) return null;
    return t.by_name[k] || null;
  }

  /* the next man up at the same position group, skipping anyone the same
     report has out or doubtful */
  function replacementFor(ctx, teamName, athlete, scoped) {
    if (!athlete) return null;
    var t = ctx && ctx.player_details_by_team && ctx.player_details_by_team[normKey(teamName)];
    if (!t) return null;
    var g = String(athlete.g || athlete.p || '').toUpperCase();
    var rows = (t.groups && t.groups[g]) || [];
    var blocked = {};
    (scoped || []).forEach(function (p) {
      var st = String(p.status || p.availability_status || '').toUpperCase();
      if (st === 'OUT' || st === 'DOUBTFUL' || st === 'OUT_FIRST_HALF') {
        var k = normPersonName(p.player_name || p.name);
        if (k) blocked[k] = true;
      }
    });
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      if (!p || String(p.id || '') === String(athlete.id || '')) continue;
      if (blocked[normPersonName(p.n)]) continue;
      if (!isNum(p.e)) continue;
      return p;
    }
    return null;
  }

  /* THE ENGINE'S INJURY LIST for one side of one fixture.
     NULL WHEN NOBODY KNOWS, [] ONLY FOR A KNOWN CLEAN REPORT: a team
     EdgeDesk could not read returns null (maximum injury uncertainty); a
     graded read returns its rows; an empty list — "everybody is available" —
     is granted only by a comprehensive official filing for THIS game. */
  function injuriesFor(ctx, teamName, gameId, deps) {
    var AV = deps && deps.AV_OVERLAY;
    var t = ctx && ctx.availability_by_team ? ctx.availability_by_team[normKey(teamName)] : null;
    if (!t || !AV) return null;
    /* LIMITED and NONE are not reads that reached a report; handing the
       engine [] for them told it 138 programmes were healthy on the strength
       of refusals */
    if (!AV.isGraded(AV.normGrade(t.dataQuality || t.data_quality))) return null;
    /* a conference filing is evidence about ONE fixture: historical rows stay
       on disk for audit and are scoped out here */
    var official = officialReportForGame(t, gameId);
    var scoped = (t.players || []).filter(function (p) {
      return p.game_id == null || gameId == null || String(p.game_id) === String(gameId);
    });
    var out = [];
    scoped.forEach(function (p) {
      var st = AVAIL_TO_ENGINE[String(p.status || p.availability_status || '').toUpperCase()];
      if (!st) return;
      var playerName = p.player_name || p.name || null;
      var athlete = playerIdentity(ctx, teamName, playerName);
      var replacement = athlete ? replacementFor(ctx, teamName, athlete, scoped) : null;
      var role = athlete && athlete.role != null ? athlete.role : p.depth_role;
      /* Player quality is still research-only: the resolved replacement and
         his rating are kept for audit and explanation, and the priced
         replacement_quality stays null, so the engine keeps its trained
         neutral replacement assumption until this layer clears walk-forward
         validation. */
      out.push({
        player: playerName,
        athlete_id: athlete ? String(athlete.id) : null,
        identity_basis: athlete ? 'unique team/name -> player-layer athlete_id' : null,
        identity_confidence: athlete && isNum(athlete.cf) ? athlete.cf : null,
        player_rating: athlete && isNum(athlete.e) ? athlete.e : null,
        position: (athlete && (athlete.p || athlete.g)) || p.position || null,
        starter: role == null ? null : /(^|[^0-9])1($|[^0-9])|starter|^qb1|^rb1|^wr1|^lt$|^rt$/i.test(String(role)),
        snap_share: athlete && isNum(athlete.share) ? athlete.share : null,
        severity: null,
        status: st,
        replacement_quality: null,
        replacement_quality_research: replacement && isNum(replacement.e)
          ? Math.max(0, Math.min(1, replacement.e / 100)) : null,
        replacement_player_id: replacement ? String(replacement.id) : null,
        replacement_player: replacement ? replacement.n : null,
        replacement_rating: replacement && isNum(replacement.e) ? replacement.e : null,
        source: p.source_name || t.team_name || null,
        as_of: p.observed_at || t.lastUpdated || ctx.availability_as_of || null
      });
    });
    if (out.length) return out;
    if (official && official.comprehensive) return [];
    /* general unscoped evidence can be a graded read carrying no priced
       designation; an old fixture-scoped row never creates the empty list */
    for (var i = 0; i < scoped.length; i++) if (scoped[i].game_id == null) return out;
    return null;
  }

  /* WHO IS COACHING, AND SINCE WHEN, from football/coaching/continuity.json.
     NULL IS NOT FALSE: a coordinator the feed cannot see is unknown, and the
     engine reads `known` to price how much of the staff was answered. */
  function coachingFor(byTeam, key) {
    var r = key && byTeam ? byTeam[key] : null;
    if (!r) return null;
    return { new_hc: r.new_hc === true ? true : (r.new_hc === false ? false : null),
      new_oc: null, new_dc: null,
      known: r.new_hc == null ? [] : ['hc'],
      hc: r.hc || null, since_season: r.since_season, tenure_seasons: r.tenure_seasons,
      tenure_is_floor: r.tenure_is_floor, previous_hc: r.previous_hc || null };
  }

  /* THE ONE VENUE TABLE, in the precedence the model's coefficients require:
     the trained table wins (the venue coefficients were fitted on it), a
     hand-checked supplement entry comes next, the generated resolution is the
     floor, and none of them overwrites another's coordinates. Returns
     {venues, supplement:{entries, refused, source}, resolved:{entries,
     refused, source, generated_at}}. `base` is not modified. */
  function mergeVenues(base, supp, gen) {
    var venues = {}, k;
    for (k in (base || {})) if (Object.prototype.hasOwnProperty.call(base, k)) venues[k] = base[k];
    var out = { venues: venues,
      supplement: { entries: 0, refused: [], source: supp ? (supp.source || null) : null },
      resolved: { entries: 0, refused: 0, source: gen ? (gen.source || null) : null,
        generated_at: gen ? (gen.generated_at || null) : null } };
    if (supp && supp.venues) {
      Object.keys(supp.venues).forEach(function (key) {
        var v = supp.venues[key];
        if (!v || !isNum(v.lat) || !isNum(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180 || !v.source) {
          out.supplement.refused.push({ key: key, why: 'a supplement entry needs real lat/lon and a named source' });
          return;
        }
        if (!venues[key]) { venues[key] = v; out.supplement.entries++; }
      });
    }
    if (gen && gen.venues) {
      Object.keys(gen.venues).forEach(function (key) {
        var v = gen.venues[key];
        if (!v || !isNum(v.lat) || !isNum(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) {
          out.resolved.refused++;
          return;
        }
        if (!venues[key]) { venues[key] = v; out.resolved.entries++; }
        else {
          /* the coordinates stay where they are; a description field the
             winning layer lacks may be filled */
          var keep = venues[key] = Object.assign({}, venues[key]);
          ['city', 'tz_name', 'venue_id'].forEach(function (f) {
            if ((keep[f] == null || keep[f] === '') && v[f] != null) keep[f] = v[f];
          });
          if (!keep.name && v.name) keep.name = v.name;
        }
      });
      var desc = gen.describe || {};
      Object.keys(desc).forEach(function (key) {
        var have = venues[key];
        if (!have) return;
        have = venues[key] = Object.assign({}, have);
        ['name', 'city', 'tz_name', 'venue_id'].forEach(function (f) {
          if ((have[f] == null || have[f] === '') && desc[key][f] != null) have[f] = desc[key][f];
        });
      });
    }
    return out;
  }

  /* ------------------------------------------------------------- assemble */
  function assemble(ctx, o, deps) {
    var POLICY = deps.POLICY, QBC = deps.QBC;
    var g = o.game, meta = o.meta || null, now = o.now || Date.now();
    var hk = (meta && meta.home && meta.home.key) || normKey(g.home_team);
    var ak = (meta && meta.away && meta.away.key) || normKey(g.away_team);
    var homeFbs = meta ? !!meta.home.is_fbs : true;
    var awayFbs = meta ? !!meta.away.is_fbs : true;
    var contract = [];
    var venueSupp = (ctx.venue_supplement && ctx.venue_supplement.entries) || 0;
    var venueRes = (ctx.venue_resolved && ctx.venue_resolved.entries) || 0;

    /* ---- venue ------------------------------------------------------- */
    var vh = ctx.venues[hk] || null, va = ctx.venues[ak] || null;
    var dome = !!(vh && vh.dome);
    if (vh) contract.push(row('venue_geography', 'home', 'USABLE',
      { source: 'trained venue table' + (venueSupp ? ' + supplement' : '') + (venueRes ? ' + resolved' : ''),
        detail: vh.name || null }));
    else contract.push(row('venue_geography', 'home', 'UNAVAILABLE',
      { source: 'trained venue table', detail: 'no coordinates for ' + g.home_team + '\'s venue'
        + (g.venue ? ' (' + g.venue + ')' : '')
        + ' — the table covers the field the model was trained on, and this programme is not in it. '
        + 'football/venues/supplement.json is the injection point; it refuses an entry without real coordinates and a named source' }));
    /* THE AWAY VENUE IS NOT A MISSING FIELD. It exists only to measure travel,
       and at a neutral site there is no travel asymmetry to measure. */
    if (g.neutral_site) contract.push(row('venue_geography', 'away', 'NOT_APPLICABLE',
      { detail: 'neutral site — no travel asymmetry is modelled, so the away venue does not enter' }));
    else if (va) contract.push(row('venue_geography', 'away', 'USABLE',
      { source: 'trained venue table' + (venueSupp ? ' + supplement' : '') + (venueRes ? ' + resolved' : ''),
        detail: va.name || null }));
    else contract.push(row('venue_geography', 'away', 'UNAVAILABLE',
      { source: 'trained venue table',
        detail: 'no coordinates for ' + g.away_team + '\'s home venue, so travel distance cannot be computed'
          + (awayFbs
            ? ' — this programme is not in the table the model was trained on'
            : ' — the trained table covers the FBS field only, and this is an FCS visitor') }));

    /* ---- weather ------------------------------------------------------ */
    var wx = (ctx.weather || {})[String(g.game_id)] || null;
    /* A FORECAST THAT REACHES EDGEDESK IS NOT A FORECAST THE MODEL PRICES.
       params.js ships `unavailable_by_design.weather_coefficients` — no
       historical weather series exists in this corpus, so no coefficient was
       earned and supplied weather cannot move the total. Read from the
       parameters, so the day a coefficient IS earned this row upgrades itself. */
    var P_ = ctx.params || (typeof globalThis !== 'undefined' && globalThis.EDCfbP4Params) || null;
    var wxPriced = !!(P_ && P_.weather);
    var wxWhy = (P_ && P_.unavailable_by_design && P_.unavailable_by_design.weather_coefficients) || null;
    if (dome) contract.push(row('weather', null, 'NOT_APPLICABLE',
      { detail: (vh.name || 'an indoor venue') + ' is a dome — weather is neutralised, not missing' }));
    else if (wx) {
      /* AGED AGAINST WHEN IT WAS OBSERVED, never against when it was re-read */
      var wxAge = hoursSince(wx.as_of, now);
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
    /* THREE DIFFERENT SENTENCES: nobody asked, somebody asked and was refused,
       and there is nothing to ask about. */
    else if (!ctx.weather_attempted) contract.push(row('weather', null, 'UNAVAILABLE',
      { detail: 'no forecast provider was called in this build; the venue’s coordinates are known, so this is a '
        + 'build that did not ask rather than a source that did not answer' }));
    else contract.push(row('weather', null, 'FETCH_FAILED',
      { source: ctx.weather_source || 'open-meteo forecast',
        detail: ctx.weather_failure || 'venue coordinates are known; the forecast request did not answer for this game' }));

    /* ---- rosters ------------------------------------------------------ */
    var rosters = ctx.rosters || {};
    var rh = rosters[hk] || null, ra = rosters[ak] || null;
    var rosterAge = hoursSince(ctx.roster_as_of, now);
    var rosterSource = ctx.roster_source || 'EdgeDesk ESPN roster sync';
    [['home', hk, rh, homeFbs, g.home_team], ['away', ak, ra, awayFbs, g.away_team]].forEach(function (x) {
      var side = x[0], r = x[2], isFbs = x[3], name = x[4];
      if (r) contract.push(row('roster', side, rosterAge != null && rosterAge > 24 * 14 ? 'STALE' : 'USABLE',
        { source: rosterSource, as_of: ctx.roster_as_of, age_hours: rosterAge, detail: ctx.roster_note }));
      else if (!isFbs) contract.push(row('roster', side, 'UNAVAILABLE',
        /* NOT NOT_APPLICABLE: with no roster for the FCS side the engine's
           roster term is unmeasured and it charges the full weight for it, so
           the contract counts the gap the score charges for */
        { source: rosterSource,
          detail: name + ' is outside the ' + ctx.season + ' FBS universe EdgeDesk rates, so no roster is retrieved '
            + 'for it. The engine prices the side from a shared FCS floor and charges the full weight of its '
            + 'roster term, so this is counted as the gap it is rather than excused as inapplicable',
          fix: 'no FCS roster feed is wired in; the gap is real and the confidence cost is the honest price of it' }));
      else contract.push(row('roster', side, 'UNAVAILABLE',
        { source: rosterSource, detail: 'no roster bundle resolved for ' + name }));
    });

    /* ---- injuries / availability -------------------------------------- */
    /* WHAT THE CONFERENCE ACTUALLY REQUIRES FOR THIS FIXTURE, asked first.
       None of the states below is health. A comprehensive report naming
       nobody is the ONLY thing that means nobody is out, and only the policy
       registry may say a source is comprehensive. */
    var ih = deps.injuriesFor(ctx, g.home_team, g.game_id), ia = deps.injuriesFor(ctx, g.away_team, g.game_id);
    var policyGame = { home_conference: g.home_conference, away_conference: g.away_conference,
      is_conference_game: g.home_conference != null && g.away_conference != null
        && POLICY.norm(g.home_conference) === POLICY.norm(g.away_conference),
      kickoff: g.start_date };
    var avPolicy = { home: POLICY.forGame(policyGame, 'home', now), away: POLICY.forGame(policyGame, 'away', now) };
    var avEvidence = { home: 'NONE', away: 'NONE' };
    var avAsOf = { home: null, away: null };
    [['home', ih, homeFbs, g.home_team], ['away', ia, awayFbs, g.away_team]].forEach(function (x) {
      var side = x[0], list = x[1], isFbs = x[2], name = x[3];
      var pol = avPolicy[side];
      var t = deps.availabilityTeam(ctx, name) || null;
      var report = officialReportForGame(t, g.game_id);
      var official = !!report;
      var comprehensive = !!(report && report.comprehensive);
      var observedAt = report ? report.published_at : (t && t.observed_at) || ctx.availability_as_of;
      var evidenceAsOf = report ? (report.retrieved_at || report.published_at) : ctx.availability_as_of;
      avAsOf[side] = evidenceAsOf;
      var evidenceAge = hoursSince(observedAt || evidenceAsOf, now);
      var polNote = pol && pol.why ? ' ' + pol.why + '.' : '';
      if (list && list.length) {
        avEvidence[side] = 'EXPLICIT';
        contract.push(row('availability', side, evidenceAge != null && evidenceAge > 48 ? 'STALE' : 'USABLE',
          { source: (official ? pol.conference + ' availability report' : 'EdgeDesk college availability layer'),
            as_of: evidenceAsOf, observed_at: observedAt || null,
            age_hours: evidenceAge, identity: 'resolved against the current-season roster by name; a name that is not on '
              + 'the roster is refused rather than invented',
            detail: list.length + ' absence report(s) on file' + polNote,
            fix: null }));
      } else if (list && comprehensive) {
        /* the one branch that may say nobody is out */
        avEvidence[side] = 'COMPREHENSIVE_SILENCE';
        contract.push(row('availability', side, evidenceAge != null && evidenceAge > 48 ? 'STALE' : 'USABLE',
          { source: pol.conference + ' availability report',
            as_of: evidenceAsOf, observed_at: observedAt || null,
            age_hours: evidenceAge,
            detail: 'the ' + pol.conference + ' report for this game designates every player and names nobody on this '
              + 'roster — a report of no absences, which is a different statement from no report' }));
      } else if (list) {
        /* sources answered and named nobody, but nothing comprehensive covers
           this game, so this is not a clean bill of health for the roster */
        contract.push(row('availability', side, evidenceAge != null && evidenceAge > 48 ? 'STALE' : 'USABLE',
          { source: 'EdgeDesk college availability layer', as_of: evidenceAsOf, age_hours: evidenceAge,
            detail: 'the sources EdgeDesk reads were read and named nobody. No COMPREHENSIVE report covers this '
              + 'fixture, so this is an absence of named absences and not a statement that the roster is whole'
              + polNote,
            fix: pol && pol.report_url ? ('ingest the ' + pol.conference + ' report from ' + pol.report_url) : null }));
      } else if (official) {
        /* a selected/absence-only report for THIS game: silence is not health */
        contract.push(row('availability', side,
          evidenceAge != null && evidenceAge > 48 ? 'STALE' : 'RESEARCH_ONLY',
          { source: pol.conference + ' availability report',
            as_of: evidenceAsOf, observed_at: observedAt || null, age_hours: evidenceAge,
            detail: 'the official report for this game was read and names no priced absence, but its policy is '
              + 'not comprehensive. Silence therefore says nothing about players not listed, so it is not handed '
              + 'to the pricing engine as a clean injury report' }));
      } else if (!isFbs) {
        contract.push(row('availability', side, 'UNAVAILABLE',
          { detail: name + ' is outside the FBS availability registry, so no availability read covers it. The '
              + 'engine prices maximum injury uncertainty for this side and charges for the gap, so the contract '
              + 'counts it as a gap rather than excusing it as inapplicable',
            fix: 'no FCS availability source is registered; a school release is the only route and none is wired' }));
      } else if (pol && pol.state === 'NOT_REQUIRED_FOR_THIS_GAME') {
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
        /* WHY THE READ FAILED, not just that it did. A failure on every team
           is one failure — a closed endpoint — and is said so. */
        var q = t ? String(t.dataQuality || t.data_quality || 'NONE').toUpperCase() : null;
        var failed = t && isNum(t.sources_failed) ? t.sources_failed : null;
        var checked = t && isNum(t.sources_checked) ? t.sources_checked : null;
        var sys = ctx.availability_systematic || [];
        contract.push(row('availability', side, q === 'LIMITED' ? 'FETCH_FAILED' : 'UNAVAILABLE',
          { source: 'EdgeDesk college availability layer', as_of: evidenceAsOf,
            detail: !t
              ? name + ' is not in the availability registry; the engine prices this as maximum injury uncertainty, never as healthy'
              : 'EdgeDesk read ' + (checked == null ? 'the' : checked) + ' source(s) for ' + name + ' and '
                + (failed ? failed + ' refused' : 'none carried a usable report')
                + '; the read is graded ' + q + ' and an ungraded read is not a clean bill of health. '
                + 'The engine prices this as maximum injury uncertainty, never as healthy'
                + (sys.length
                  ? '. THIS IS NOT A PER-TEAM FAILURE: ' + sys.map(function (f) {
                      return f.source + ' refuses for all ' + f.teams + ' programmes (' + f.error + ')'; }).join('; ')
                    + ' — an endpoint the provider closed, not ' + sys[0].teams
                    + ' separate misses'
                  : '') + polNote,
            fix: pol && pol.report_url
              ? ('ingest the ' + pol.conference + ' availability report for this game from ' + pol.report_url)
              : 'register an official source for this programme in football/availability/sources.overrides.json, or '
                + 'record a dated operator correction in football/availability/operator.json' }));
      }
    });

    /* ---- roster talent -------------------------------------------------- */
    /* a SEPARATE field from `roster`: who is on it, and how good they are */
    [['home', rh, homeFbs, g.home_team], ['away', ra, awayFbs, g.away_team]].forEach(function (x) {
      var side = x[0], r = x[1], isFbs = x[2], name = x[3];
      var rq = ctx.roster_quality || null;
      if (r && isNum(r.overall_talent)) contract.push(row('roster_talent', side, 'USABLE',
        { source: (rq && rq.source) || 'EdgeDesk player layer', as_of: (rq && rq.as_of) || null,
          age_hours: hoursSince((rq && rq.as_of) || null, now),
          detail: 'composite ' + (Math.round(r.overall_talent * 10) / 10)
            + (isNum(r.overall_talent_confidence) ? ' at confidence ' + r.overall_talent_confidence : '')
            + ' — measured production, not recruiting pedigree' }));
      else if (!isFbs) contract.push(row('roster_talent', side, 'UNAVAILABLE',
        { source: 'EdgeDesk player layer',
          detail: name + ' is outside the FBS field the player layer rates, so no composite is measured for it. '
            + 'The engine charges for the gap, so the contract counts it as one',
          fix: 'the player layer is built from FBS play attribution; extending it to the FCS field is the fix, and '
            + 'nothing is substituted for it meanwhile' }));
      else contract.push(row('roster_talent', side, 'UNAVAILABLE',
        { source: 'EdgeDesk player layer',
          detail: 'no rated roster resolved for ' + name + (rq ? '' : '; football/players/current.json did not load') }));
    });

    /* ---- starter context ----------------------------------------------- */
    var st = ctx.starters && ctx.starters.teams ? ctx.starters.teams : {};
    var sh = st[hk] || null, sa = st[ak] || null;
    var starters = { home: sh, away: sa };
    var qbEvidenceClass = { home: null, away: null };
    var qbAvailEvidence = { home: 'NONE', away: 'NONE' };
    var qbAvailWhy = { home: null, away: null };
    [['home', sh, homeFbs, g.home_team], ['away', sa, awayFbs, g.away_team]].forEach(function (x) {
      var side = x[0], rec = x[1], isFbs = x[2], name = x[3];
      if (!rec) {
        contract.push(row('qb_starter', side, isFbs ? 'UNAVAILABLE' : 'NOT_APPLICABLE',
          { detail: isFbs ? 'no starter record was built for ' + name
            : name + ' is outside the rated universe; no starter context is assembled for it',
            fix: isFbs ? 'run football/starters/build_starters.js --sport cfb' : null }));
        return;
      }
      var state = rec.field_state === 'USABLE' ? 'RESEARCH_ONLY' : rec.field_state;
      var cls = QBC.classOf(rec);
      qbEvidenceClass[side] = cls.id;
      contract.push(row('qb_starter', side, state, {
        source: rec.source, as_of: rec.retrieved_at, observed_at: rec.published_at || null,
        age_hours: hoursSince(rec.retrieved_at, now),
        identity: rec.identity_basis || null,
        /* THE EVIDENCE CLASS IS PART OF THE FIELD, not a footnote on it */
        detail: rec.label + ' — ' + cls.label + ': ' + cls.means
          + '. Retrieved and published as research; the priced QB layer is not fed from it until the starter '
          + 'layer has an out-of-sample record of its own',
        fix: cls.id === 'CONFIRMED' ? null
          : 'a team or conference announcement for THIS game would move this to CONFIRMED; register one in '
            + 'football/availability/sources.overrides.json or record it in football/starters/announcements.json'
      }));
      /* ---- can the resolved starter play ------------------------------- */
      var av = rec.availability || {};
      var pol = avPolicy[side];
      if (av.evidence === 'EXPLICIT') {
        qbAvailEvidence[side] = 'EXPLICIT';
        qbAvailWhy[side] = av.why || null;
        contract.push(row('qb_availability', side, 'USABLE',
          { source: av.source, as_of: av.retrieved_at, observed_at: av.published_at || null,
            identity: 'the same athlete id the starter record resolved',
            detail: av.why || 'an availability source names this player and states a status' }));
      } else if (avEvidence[side] === 'COMPREHENSIVE_SILENCE') {
        /* the ONLY route from silence to available */
        qbAvailEvidence[side] = 'COMPREHENSIVE_SILENCE';
        qbAvailWhy[side] = 'named nowhere on a comprehensive report for this game';
        contract.push(row('qb_availability', side, 'USABLE',
          { source: pol && pol.conference, as_of: avAsOf[side],
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
    /* RESEARCH_ONLY when measured: the provider's EPA is not on the scale the
       shipped coefficient was fitted on (football/fbs_epa/epa_contract.js).
       Four states, four statements: measured, a publication gap, an
       unresolved identity, and a quarterback who has never thrown an FBS pass. */
    var qbEpa = { home: null, away: null };
    var qbMeasured = { home: false, away: false };
    if (ctx.fbs_epa) {
      var EPAMOD = deps.EPAMOD;
      var kickoff = Date.parse(g.start_date);
      [['home', sh, hk, ak, homeFbs, g.home_team], ['away', sa, ak, hk, awayFbs, g.away_team]]
        .forEach(function (x) {
          var side = x[0], rec = x[1], key = x[2], opp = x[3], isFbs = x[4], name = x[5];
          var pk = EPAMOD.quarterback({ artifact: ctx.fbs_epa, starter: rec, team_key: key,
            opponent_key: opp, cutoff: isFinite(kickoff) ? kickoff : now, side: side });
          qbEpa[side] = pk;
          var card = EPAMOD.cardForm(pk);
          var stale = ctx.fbs_epa_freshness && ctx.fbs_epa_freshness.state === 'STALE';
          var state, detail;
          if (pk.state === 'MEASURED' && pk.career.state === 'MEASURED') {
            state = stale ? 'STALE' : 'RESEARCH_ONLY';
            qbMeasured[side] = !stale;
            detail = pk.identity.player + ' — ' + pk.career.epa_per_dropback + ' EPA per dropback over '
              + pk.career.dropbacks + ' career dropbacks'
              + (card.coverage_state === 'PARTIAL' ? ' (partial: a completed game has no passing row yet)' : '')
              + '. Research only: the provider’s EPA is not on the scale the engine’s coefficient '
              + 'was fitted on (football/fbs_epa/epa_contract.js)';
          } else if (pk.state === 'UNRESOLVED_IDENTITY') {
            state = isFbs ? 'UNAVAILABLE' : 'NOT_APPLICABLE';
            detail = isFbs ? 'no quarterback identity resolves for ' + name + ', so there is nobody to measure '
              + '— an unresolved identity, not a quarterback without history'
              : name + ' is outside the rated universe';
          } else if (pk.state === 'NO_OBSERVATIONS' || (pk.career && pk.career.state === 'NO_OBSERVATIONS')) {
            state = 'UNAVAILABLE';
            detail = (pk.identity && pk.identity.player ? pk.identity.player : 'this quarterback')
              + ' has thrown no FBS pass inside this history — an empty sample, never an average one';
          } else {
            state = 'UNAVAILABLE';
            detail = pk.why || 'no measured efficiency history for this side';
          }
          contract.push(row('qb_efficiency_history', side, state, {
            source: 'football/fbs_epa — sportsdataverse/cfbfastR-cfb-data adv_passing',
            as_of: ctx.fbs_epa.generated_at,
            age_hours: hoursSince(ctx.fbs_epa.generated_at, now),
            detail: detail
          }));
        });
    } else {
      ['home', 'away'].forEach(function (side) {
        contract.push(row('qb_efficiency_history', side, 'UNAVAILABLE',
          { detail: 'football/fbs_epa has published no artifact for this season — run '
            + 'football/fbs_epa/build_epa.js' }));
      });
    }

    /* ---- recruiting talent ---------------------------------------------- */
    /* the per-TEAM composite, public and keyless; RESEARCH_ONLY because no
       coefficient has been fitted against it on this corpus. Per-player
       recruiting ratings remain subscription data and are not substituted. */
    var TT = ctx.team_talent && ctx.team_talent.teams ? ctx.team_talent.teams : null;
    [['home', hk, homeFbs, g.home_team], ['away', ak, awayFbs, g.away_team]].forEach(function (x) {
      var side = x[0], key = x[1], isFbs = x[2], name = x[3];
      var t = TT ? TT[key] : null;
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
          { detail: name + ' is outside the FBS field EdgeDesk rates' }));
      } else {
        contract.push(row('recruiting_talent', side, 'UNAVAILABLE',
          { source: ctx.team_talent ? ctx.team_talent.source : 'sportsdataverse/cfbfastR-cfb-data cfb_team_talent',
            detail: ctx.team_talent
              ? 'the provider’s ' + ctx.team_talent.season + ' team-talent table does not carry ' + name + ' — a '
                + 'publication gap in the source, not an unresolved identity here'
              : 'football/players/team_talent.json has not been built',
            fix: ctx.team_talent ? null : 'run football/players/build_team_talent.js' }));
      }
    });

    /* ---- the team rating and the matchup profile ------------------------- */
    /* the two biggest-weight inputs: a rated programme is USABLE, an unrated
       one UNAVAILABLE with the reason, so the confidence ledger attributes
       the loss to the field instead of to a residue */
    var ratedH = o.state && o.state.r ? o.state.r[hk] : undefined;
    var ratedA = o.state && o.state.r ? o.state.r[ak] : undefined;
    function gamesOf(k) { return (o.state && o.state.g && isNum(o.state.g[k])) ? o.state.g[k] : null; }
    [['home', hk, ratedH, homeFbs, g.home_team], ['away', ak, ratedA, awayFbs, g.away_team]]
      .forEach(function (x) {
        var side = x[0], key = x[1], rat = x[2], isFbs = x[3], name = x[4];
        if (isNum(rat) && isFbs) {
          var n = gamesOf(key);
          contract.push(row('team_rating', side, 'USABLE',
            { source: 'EdgeDesk CFB pricing rating state: trained preseason seed + completed-game replay',
              identity: 'the engine’s own team key',
              detail: 'rated ' + Math.round(rat * 100) / 100
                + (n == null ? '' : ' over ' + n + ' absorbed game(s) this season')
                + ', blended with the trained prior on the learned curve' }));
        } else {
          contract.push(row('team_rating', side, 'UNAVAILABLE',
            { source: 'EdgeDesk CFB pricing non-FBS floor',
              detail: name + ' is outside the rated FBS field, so the projection uses params.rating.fcs_rating '
                + '— ONE floor number shared by every FCS programme. That is not a rating of this team, and '
                + 'the engine charges the full weight of the rating input for it. This row exists so that charge '
                + 'lands on a named field instead of on nothing',
              fix: 'no public rating of the FCS field is wired in; the floor is the honest substitute and the '
                + 'confidence cost is the honest price of it' }));
        }
      });
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
    /* the engine scores it; NOTHING is substituted for it. null means nobody
       looked, [] means a registered source was read and carried nothing. */
    ['home', 'away'].forEach(function (side) {
      var news = ctx.off_field_for ? ctx.off_field_for(side === 'home' ? hk : ak) : null;
      if (news && news.length) contract.push(row('off_field', side, 'USABLE',
        { source: ctx.off_field_source || 'supplied public reporting', as_of: ctx.off_field_as_of || null,
          detail: news.length + ' sourced, dated signal(s) on file' }));
      else if (news) contract.push(row('off_field', side, 'USABLE',
        { source: ctx.off_field_source || 'supplied public reporting', as_of: ctx.off_field_as_of || null,
          detail: 'the configured reporting sources were read and carried nothing material for this side' }));
      else contract.push(row('off_field', side, 'UNAVAILABLE',
        { source: ctx.off_field_source || null,
          detail: 'no source is registered for this programme, so nothing has been read and an empty result would '
            + 'be a false clean bill of health rather than a finding. The engine scores this input and it is '
            + 'missing on every game, so it is published here rather than left invisible. A signal must be all '
            + 'four of public, sourced, dated and severity-graded before it may move even the confidence score — '
            + 'a general news search supplies neither a severity nor a reliability a model may use, and a wire '
            + 'that supplies all four may not be redistributed as a committed artifact. The availability layer '
            + 'answers a different question (who can play) and is never substituted for this one'
            + ((ctx.off_field_counts && ctx.off_field_counts.refused)
              ? ('. ' + ctx.off_field_counts.refused + ' recorded signal(s) are currently REFUSED for missing one '
                + 'of the four') : ''),
          fix: 'record a dated, sourced, severity-graded signal with '
            + 'node football/offfield/record_signal.js, or register a source EdgeDesk actually reads in '
            + 'football/offfield/sources.json — an entry there is a commitment that something reads it, and is '
            + 'what turns an empty result from a gap into "read, and nothing material"' }));
    });

    /* ---- coaching continuity -------------------------------------------
       the head coach is known from the coach table; coordinators are not in
       that feed and stay unmeasured rather than becoming unchanged, so this
       is RESEARCH_ONLY even when it answers */
    ['home', 'away'].forEach(function (side) {
      var c = ctx.coaching_for ? ctx.coaching_for(side === 'home' ? hk : ak) : null;
      var who = side === 'home' ? g.home_team : g.away_team;
      if (c && c.new_hc != null) contract.push(row('coaching_continuity', side, 'RESEARCH_ONLY',
        { source: ctx.coaching_source || 'cfbfastR coach table',
          as_of: ctx.coaching_as_of || null,
          identity: c.hc || null,
          detail: (c.new_hc ? 'FIRST SEASON: ' : '') + (c.hc || 'head coach')
            + (c.new_hc
              ? (c.previous_hc ? ' replaced ' + c.previous_hc : ' is new this season')
              : ' since ' + c.since_season + (c.tenure_is_floor ? ' or earlier' : '')
                + ' (' + c.tenure_seasons + (c.tenure_is_floor ? '+' : '') + ' seasons)')
            + '. Coordinators are NOT in this feed and are unmeasured, not unchanged' }));
      else contract.push(row('coaching_continuity', side, 'UNAVAILABLE',
        { source: ctx.coaching_source || null,
          detail: ctx.coaching_source
            ? (who + ' has no prior season in the coach table to compare against, so whether this staff is new is '
              + 'unknown rather than continuous — a programme with no history is not a programme that kept its coach')
            : 'football/coaching/continuity.json has not been built; run football/coaching/build_coaching.js',
          fix: 'node football/coaching/build_coaching.js --season ' + (ctx.coaching_season || 'YYYY') }));
    });

    /* ---- schedule ------------------------------------------------------- */
    var sch = o.schedule_index || null;
    var ch = deps.schedCtx(sch, g, 'home');
    var ca = deps.schedCtx(sch, g, 'away');
    [['home', ch], ['away', ca]].forEach(function (x) {
      var side = x[0], c = x[1];
      if (c) contract.push(row('schedule_context', side, 'USABLE',
        { source: 'season schedule feed', detail: 'rest ' + (c.rest_days == null ? 'n/a' : c.rest_days + 'd') }));
      else contract.push(row('schedule_context', side, 'NOT_APPLICABLE',
        { detail: 'the first game of the season has no preceding rest interval to measure' }));
    });

    return {
      contract: contract, summary: summarise(contract),
      hk: hk, ak: ak, home_fbs: homeFbs, away_fbs: awayFbs,
      venue: { home: vh, away: va, dome: dome }, weather: wx,
      rosters: { home: rh, away: ra }, injuries: { home: ih, away: ia },
      starters: starters, schedule: { home: ch, away: ca },
      qb_epa: qbEpa, qb_measured: qbMeasured,
      qb_availability_evidence: qbAvailEvidence, qb_availability_why: qbAvailWhy,
      qb_evidence_class: qbEvidenceClass, availability_evidence: avEvidence
    };
  }

  /* ------------------------------------------------------ the request
     THE BASELINE REQUEST: exactly the inputs the published number is priced
     from, assembled from the facts assemble() resolved, so the board and the
     build hand the engine the same object for the same game. `qb` — the
     PRICED quarterback input — stays null on both paths; `qb_context` is the
     information layer's (who plays, how well that is known) and reaches no
     point. o.market and o.odds_as_of are the caller's market join. */
  function request(A, ctx, o, deps) {
    var g = o.game;
    function qbCtx(rec, side) {
      return deps.QBC.build(rec, {
        persistence: ctx.persistence,
        efficiency_history: A.qb_measured[side] === true,
        availability_evidence: A.qb_availability_evidence[side] || 'NONE',
        availability_why: A.qb_availability_why[side] || null
      });
    }
    return {
      season: g.season, week: g.week, state: o.state,
      game: { home: g.home_team, away: g.away_team, neutral_site: !!g.neutral_site,
        venue_id: g.venue_id, kickoff: g.start_date, home_fbs: A.home_fbs, away_fbs: A.away_fbs },
      teams: {
        home: { conference: g.home_conference, roster: A.rosters.home, qb: null,
          qb_context: qbCtx(A.starters.home, 'home'),
          injuries: A.injuries.home, news: ctx.off_field_for ? ctx.off_field_for(A.hk) : null,
          coaching: ctx.coaching_for ? ctx.coaching_for(A.hk) : null, schedule: A.schedule.home },
        away: { conference: g.away_conference, roster: A.rosters.away, qb: null,
          qb_context: qbCtx(A.starters.away, 'away'),
          injuries: A.injuries.away, news: ctx.off_field_for ? ctx.off_field_for(A.ak) : null,
          coaching: ctx.coaching_for ? ctx.coaching_for(A.ak) : null, schedule: A.schedule.away }
      },
      venue: { home: A.venue.home, away: A.venue.away },
      weather: A.weather, market: o.market || {},
      timestamps: { odds: o.odds_as_of || null, roster: ctx.roster_as_of || null,
        injuries: ctx.availability_as_of || null, weather: A.weather ? A.weather.as_of : null }
    };
  }

  /* THE TEAM RECRUITING COMPOSITE'S ONE PRICED-INPUT SIDE EFFECT, shared: a
     roster bundle with no blue-chip ratio takes the public TEAM ratio
     (football/players/team_talent.json), labelled as the team ratio it is.
     Per-player stars remain subscription data and are never substituted.
     Mutates the bundles in place, as the build always has. */
  function applyTeamTalent(rosters, teamTalent) {
    if (!rosters || !teamTalent || !teamTalent.teams) return 0;
    var n = 0;
    Object.keys(teamTalent.teams).forEach(function (k) {
      var b = rosters[k], t = teamTalent.teams[k];
      if (b && b.blue_chip_ratio == null && isNum(t.blue_chip_ratio)) { b.blue_chip_ratio = t.blue_chip_ratio; n++; }
    });
    return n;
  }

  return { STATES: STATES, row: row, summarise: summarise, officialReportForGame: officialReportForGame,
    coachingFor: coachingFor, mergeVenues: mergeVenues, assemble: assemble, request: request,
    applyTeamTalent: applyTeamTalent, normKey: normKey,
    normPersonName: normPersonName, AVAIL_TO_ENGINE: AVAIL_TO_ENGINE, playerDetailsFrom: playerDetailsFrom,
    playerIdentity: playerIdentity, replacementFor: replacementFor, injuriesFor: injuriesFor };
});
