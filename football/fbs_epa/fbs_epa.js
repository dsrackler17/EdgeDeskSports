/* ============================================================================
   THE FBS QUARTERBACK EPA ADAPTER — one reader, four surfaces.

   The game card, the research packet, the AI's answer and the training
   pipeline all need the same sentence: who is playing quarterback, what he has
   done, over how many dropbacks, up to what moment, and whether any of it
   touches the price. Four implementations of that sentence is how a card and a
   newsletter end up disagreeing about a number, so there is one, and it is
   here.

   THE RULE THAT SHAPES EVERYTHING ELSE. A pregame measurement may not contain
   the game it is describing. This module therefore never reads a pre-computed
   season total: it reads DATED GAME ROWS and cuts them at the kickoff it was
   asked about. A game that had not finished cannot be inside the answer,
   because the row carrying it is filtered out before anything is summed. That
   is cheaper to prove than a promise, and football/fbs_epa/fbs_epa.test.js
   proves it on the real artifact.

   WHAT IT WILL NOT DO
   - It will not call anything here EPA that is not EPA. Success rate, CPOE,
     QBR and yards per attempt each keep their own name, and epa_contract.js
     holds the labelling table.
   - It will not turn a missing sample into a league average. A quarterback
     with no observed dropbacks comes back with `state: 'NO_OBSERVATIONS'`,
     not with a zero and not with the mean.
   - It will not promote evidence. A last-game dominant passer is a
     last-game dominant passer; an expected starter is not an announced one.
   - It will not price. `pricing.points_applied` is read from the contract and
     is false; no caller may set it.

   Node and browser (UMD), like fbs.js and starters.js, so the builders, the
   tests and the page read one implementation.
   ========================================================================== */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require : null);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDFbsEpa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (req) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_fbs_qb_epa_v1';

  var CONTRACT = (typeof globalThis !== 'undefined' && globalThis.EDFbsEpaContract)
    || (req ? req('./epa_contract.js') : null);

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r4(x) { return isNum(x) ? Math.round(x * 10000) / 10000 : null; }
  function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
  function ms(t) { var v = Date.parse(t); return isFinite(v) ? v : null; }

  /* THE FOUR KINDS OF ANSWER, kept apart. The product asks "who is the
     quarterback"; these are the four genuinely different things the evidence
     can say, and collapsing any two of them is how a guess becomes a fact. */
  var IDENTITY_KIND = {
    CONFIRMED_STARTER: 'an official team or conference source named him as the starter',
    PROJECTED_STARTER: 'current reporting or the published depth chart points to him — an expectation with '
      + 'evidence behind it, not an announcement',
    LAST_GAME_PROXY: 'he took the first dropback of this team’s most recent completed game. That is a fact '
      + 'about the last game and a proxy for this one',
    DOMINANT_PASSER_PROXY: 'he threw the most dropbacks in this team’s most recent completed game. Nobody '
      + 'has said he started it, and the leading passer of a game is not always the one who opened it',
    UNRESOLVED: 'the evidence does not settle on one player'
  };

  var STATUS_TO_KIND = {
    ANNOUNCED: 'CONFIRMED_STARTER',
    EXPECTED: 'PROJECTED_STARTER',
    DEPTH_CHART: 'PROJECTED_STARTER',
    PREVIOUS_GAME: 'LAST_GAME_PROXY',
    COMPETITION: 'UNRESOLVED',
    UNKNOWN: 'UNRESOLVED'
  };

  /* ---------------------------------------------------------------- windows */
  /* Every aggregate in this file goes through here, so the cut rule exists
     once. `cutoff` is a millisecond timestamp; a row whose kickoff is not
     strictly before it is not in the window, full stop. */
  function before(rows, cutoff) {
    if (!rows || !rows.length) return [];
    if (!isNum(cutoff)) return rows.slice();
    var out = [], i, t;
    for (i = 0; i < rows.length; i++) {
      t = ms(rows[i].kickoff);
      if (t != null && t < cutoff) out.push(rows[i]);
    }
    return out;
  }

  /* Sum a set of game rows into one measurement. EPA is summed over its own
     reconciled denominator; the yardage rates are summed over theirs. A rate
     is never the mean of per-game rates, because a 3-dropback game does not
     weigh the same as a 45-dropback one. */
  function aggregate(rows) {
    var a = { games: 0, epa_games: 0, dropbacks: 0, epa: 0, attempts: 0, sacks: 0,
      completions: 0, yards: 0, tds: 0, interceptions: 0, first_kickoff: null, last_kickoff: null,
      seasons: {} };
    (rows || []).forEach(function (r) {
      a.games++;
      a.attempts += isNum(r.attempts) ? r.attempts : 0;
      a.sacks += isNum(r.sacks) ? r.sacks : 0;
      a.completions += isNum(r.completions) ? r.completions : 0;
      a.yards += isNum(r.yards) ? r.yards : 0;
      a.tds += isNum(r.tds) ? r.tds : 0;
      a.interceptions += isNum(r.interceptions) ? r.interceptions : 0;
      if (r.epa_state === 'MEASURED' && isNum(r.epa) && isNum(r.dropbacks) && r.dropbacks > 0) {
        a.epa_games++; a.dropbacks += r.dropbacks; a.epa += r.epa;
      }
      if (r.season != null) a.seasons[r.season] = 1;
      var t = ms(r.kickoff);
      if (t != null) {
        if (a.first_kickoff == null || t < a.first_kickoff) a.first_kickoff = t;
        if (a.last_kickoff == null || t > a.last_kickoff) a.last_kickoff = t;
      }
    });
    return a;
  }

  /* Fold a frozen prior-seasons aggregate and a set of in-season rows into
     one career measurement. The frozen part is already bounded by its own
     season, so it needs no cut; the in-season part has been cut already. */
  function measure(frozen, rows, o) {
    o = o || {};
    var a = aggregate(rows);
    var games = a.games, epaGames = a.epa_games, db = a.dropbacks, epa = a.epa;
    var att = a.attempts, sk = a.sacks, yds = a.yards, ints = a.interceptions, cmp = a.completions, tds = a.tds;
    var firstSeason = null, seasons = Object.keys(a.seasons).length;
    if (frozen) {
      games += frozen.games || 0; epaGames += frozen.epa_games || 0;
      db += frozen.dropbacks || 0; epa += frozen.epa || 0;
      att += frozen.attempts || 0; sk += frozen.sacks || 0; yds += frozen.yards || 0;
      ints += frozen.interceptions || 0; cmp += frozen.completions || 0; tds += frozen.tds || 0;
      firstSeason = frozen.first_season != null ? frozen.first_season : null;
      seasons += frozen.seasons_observed || 0;
    }
    if (firstSeason == null && rows && rows.length) {
      firstSeason = rows.reduce(function (m, r) { return (m == null || r.season < m) ? r.season : m; }, null);
    }
    var out = {
      state: games ? (epaGames ? 'MEASURED' : 'NO_RECONCILED_EPA') : 'NO_OBSERVATIONS',
      games: games, epa_games: epaGames, dropbacks: db,
      attempts: att, sacks: sk, completions: cmp, yards: yds, touchdowns: tds, interceptions: ints,
      epa_total: epaGames ? r4(epa) : null,
      epa_per_dropback: (epaGames && db > 0) ? r4(epa / db) : null,
      yards_per_attempt: att > 0 ? r3(yds / att) : null,
      completion_rate: att > 0 ? r3(cmp / att) : null,
      sack_rate: (att + sk) > 0 ? r3(sk / (att + sk)) : null,
      interception_rate: att > 0 ? r4(ints / att) : null,
      first_season: firstSeason,
      seasons_observed: seasons || null,
      window: o.window || null,
      observed_through: a.last_kickoff != null ? new Date(a.last_kickoff).toISOString() : (o.frozen_through || null)
    };
    if (out.state === 'NO_OBSERVATIONS') {
      out.why = 'no FBS passing row in this history carries this athlete. That is an empty sample, not an average '
        + 'one, and nothing below substitutes a league value for it.';
    } else if (out.state === 'NO_RECONCILED_EPA') {
      out.why = 'this passer has observed games, but none of them carries an EPA total that reconciles against '
        + 'its own denominator, so no rate is derived.';
    }
    return out;
  }

  /* ------------------------------------------------------------ team context */
  function teamForm(team, cutoff, n) {
    if (!team) return { state: 'NO_TEAM_RECORD' };
    var off = before(team.offence_log || [], cutoff);
    var def = before(team.pass_defence_log || [], cutoff);
    var lastOff = off.slice(-(n || 5));
    var lastDef = def.slice(-(n || 5));
    function mean(rows, key) {
      var vals = rows.map(function (r) { return r[key]; }).filter(isNum);
      if (!vals.length) return null;
      return r4(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    }
    return {
      state: (off.length || def.length) ? 'MEASURED' : 'NO_OBSERVATIONS',
      season_games: off.length,
      offence_recent: {
        games: lastOff.length,
        pass_epa_per_play: mean(lastOff, 'pass_epa_per_play'),
        off_epa_per_play: mean(lastOff, 'off_epa_per_play')
      },
      pass_defence_recent: {
        games: lastDef.length,
        allowed_pass_epa_per_play: mean(lastDef, 'allowed_pass_epa_per_play')
      },
      basis: 'an UNWEIGHTED mean of per-game rates over the last ' + (n || 5) + ' completed games, and NOT '
        + 'opponent-adjusted. A team that has played weaker offences reads better here than it is.'
    };
  }

  /* ------------------------------------------------------------- the packet */
  /* One side of one game. `starter` is a football/starters record (the
     authoritative identity layer); `artifact` is qb_epa_<season>.json. */
  function quarterback(o) {
    o = o || {};
    var art = o.artifact;
    var starter = o.starter || null;
    var teamKey = o.team_key || null;
    var oppKey = o.opponent_key || null;
    var cutoff = isNum(o.cutoff) ? o.cutoff : ms(o.kickoff);
    var priced = !!(CONTRACT && CONTRACT.COMPATIBILITY && CONTRACT.COMPATIBILITY.priced_input === true);

    var base = {
      schema: SCHEMA, version: VERSION,
      side: o.side || null, team_key: teamKey, opponent_key: oppKey,
      cutoff: cutoff != null ? new Date(cutoff).toISOString() : null,
      source: art ? ('football/fbs_epa/qb_epa_' + art.season + '.json') : null,
      source_generated_at: art ? art.generated_at : null,
      observations_through: art ? art.observations_through : null,
      provider: CONTRACT ? {
        repository: 'sportsdataverse/cfbfastR-cfb-data',
        ep_model_version: CONTRACT.PROVIDER_MODEL.model_version,
        ep_model_training_seasons: CONTRACT.PROVIDER_MODEL.ep_model.training_seasons
      } : null,
      pricing: {
        points_applied: priced,
        why: CONTRACT ? CONTRACT.COMPATIBILITY.summary : 'no contract loaded, so nothing may be priced',
        statement: CONTRACT ? CONTRACT.pricingStatement('epa_per_dropback')
          : 'this measurement is research context and does not affect the fair line'
      }
    };

    if (!art || !art.players) {
      base.state = 'NO_ARTIFACT';
      base.why = 'football/fbs_epa has published no quarterback artifact for this season';
      return base;
    }

    /* ---- identity ---- */
    var id = starter && starter.player_id ? String(starter.player_id) : null;
    var kind = starter ? (STATUS_TO_KIND[String(starter.status || 'UNKNOWN').toUpperCase()] || 'UNRESOLVED')
      : 'UNRESOLVED';
    var evidence = null;
    if (starter) {
      evidence = {
        status: starter.status || 'UNKNOWN',
        confirmed: starter.confirmed === true,
        label: starter.label || null,
        source: starter.source || null,
        source_url: starter.source_url || null,
        published_at: starter.published_at || null,
        retrieved_at: starter.retrieved_at || null,
        identity_basis: starter.identity_basis || null,
        identity_corroborated: starter.identity_corroborated !== false,
        contested: !!(starter.competition && starter.competition.contested)
      };
    }

    /* the fallback the dataset itself offers, used ONLY when the starter
       layer resolved nobody, and never labelled as a start */
    var fallback = null;
    if (!id && teamKey) {
      fallback = dominantPasserLastGame(art, teamKey, cutoff);
      if (fallback) {
        id = fallback.athlete_id;
        kind = 'DOMINANT_PASSER_PROXY';
        evidence = {
          status: 'UNKNOWN', confirmed: false,
          label: fallback.name + ' threw ' + fallback.dropbacks + ' of this team’s '
            + fallback.team_dropbacks + ' dropbacks in its last completed game',
          source: 'football/fbs_epa — provider per-game passing rows',
          source_url: 'https://github.com/sportsdataverse/cfbfastR-cfb-data',
          published_at: fallback.kickoff, retrieved_at: art.generated_at,
          identity_basis: 'the provider’s athlete id on the passing row',
          identity_corroborated: true, contested: fallback.share < 0.7
        };
      }
    }

    if (!id) {
      base.state = 'UNRESOLVED_IDENTITY';
      base.identity = { kind: 'UNRESOLVED', kind_means: IDENTITY_KIND.UNRESOLVED,
        player: null, athlete_id: null, evidence: evidence };
      base.why = 'no athlete id resolves for this side, so there is no quarterback to measure. This is an '
        + 'unresolved identity, which is a different statement from a quarterback with no history.';
      base.team = teamForm(art.teams ? art.teams[teamKey] : null, cutoff, 5);
      base.opponent = teamForm(art.teams ? art.teams[oppKey] : null, cutoff, 5);
      return base;
    }

    var P = art.players[id] || null;
    if (!P) {
      base.state = 'NO_OBSERVATIONS';
      base.identity = {
        kind: kind, kind_means: IDENTITY_KIND[kind] || null,
        player: starter ? (starter.player_name || null) : null, athlete_id: id, evidence: evidence
      };
      base.career = { state: 'NO_OBSERVATIONS',
        why: 'this athlete has no FBS passing row anywhere in ' + (art.history ? art.history.first_season : '')
          + '–' + art.season + '. A true freshman, a transfer from outside FBS, or a passer who has not yet '
          + 'thrown — an empty sample, never an average one.' };
      base.season = base.career; base.recent_5 = base.career;
      base.team = teamForm(art.teams ? art.teams[teamKey] : null, cutoff, 5);
      base.opponent = teamForm(art.teams ? art.teams[oppKey] : null, cutoff, 5);
      return base;
    }

    var seasonRows = before(P.season_log || [], cutoff);
    /* the recent-five window crosses the season boundary on purpose: in week
       two a quarterback's last five games are mostly last season's, and
       pretending his form began in September is a worse answer than saying
       which games it came from. The previous-season tail is a SEPARATE list
       from the season log, so joining them cannot double count a game. */
    var recentRows = before((P.prior_log || []).concat(P.season_log || []), cutoff).slice(-5);
    var frozenThrough = P.prior ? (art.season - 1) : null;

    base.state = 'MEASURED';
    base.identity = {
      kind: kind, kind_means: IDENTITY_KIND[kind] || null,
      player: P.name || (starter ? starter.player_name : null), athlete_id: id,
      team_key: P.team_key || teamKey, evidence: evidence
    };
    base.career = measure(P.prior, seasonRows, {
      window: 'every FBS-involving game from ' + (art.history ? art.history.first_season : '?') + ' up to this '
        + 'kickoff',
      frozen_through: frozenThrough ? String(frozenThrough) : null
    });
    base.career.history_boundary = art.history ? art.history.career_basis : null;
    base.season = measure(null, seasonRows, { window: 'this season, up to this kickoff' });
    base.recent_5 = measure(null, recentRows, { window: 'his last five completed games, which may cross a season' });
    base.game_log = seasonRows.map(function (r) {
      return { game_id: r.game_id, season: r.season, week: r.week, kickoff: r.kickoff,
        opponent_key: r.opponent_key, dropbacks: r.dropbacks, attempts: r.attempts, sacks: r.sacks,
        interceptions: r.interceptions, epa: r.epa, epa_per_dropback: r.epa_per_dropback,
        epa_state: r.epa_state };
    });
    base.team = teamForm(art.teams ? art.teams[teamKey] : null, cutoff, 5);
    base.opponent = teamForm(art.teams ? art.teams[oppKey] : null, cutoff, 5);
    base.league = art.league ? {
      season_epa_per_dropback: art.league.season ? art.league.season.epa_per_dropback : null,
      basis: art.league.basis
    } : null;
    if (base.league && isNum(base.league.season_epa_per_dropback) && isNum(base.career.epa_per_dropback)) {
      base.career.vs_league = r4(base.career.epa_per_dropback - base.league.season_epa_per_dropback);
    }
    base.coverage = coverageFor(art, teamKey, oppKey, cutoff);
    base.measurements = measurementList(base);
    return base;
  }

  /* Which of this team's completed games are NOT in the history above. Four
     states have to stay apart on this surface and this is the one that is
     easiest to lose: a game the provider has not published yet looks exactly
     like a game that was not played, unless something says so. */
  function coverageFor(art, teamKey, oppKey, cutoff) {
    var c = art.coverage || null;
    if (!c) return { state: 'UNSTATED' };
    function forTeam(k) {
      var rows = (c.missing_passing_by_team && c.missing_passing_by_team[k]) || [];
      return before(rows, cutoff);
    }
    var mine = forTeam(teamKey), theirs = forTeam(oppKey);
    return {
      state: (mine.length || theirs.length) ? 'PARTIAL' : 'COMPLETE',
      team_games_without_passing_data: mine,
      opponent_games_without_passing_data: theirs,
      why: (mine.length || theirs.length)
        ? 'the provider has not published an advanced passing row for ' + (mine.length + theirs.length)
          + ' completed game' + ((mine.length + theirs.length) === 1 ? '' : 's') + ' in this matchup, so nothing '
          + 'above includes ' + ((mine.length + theirs.length) === 1 ? 'it' : 'them') + '. That is a publication '
          + 'gap, not a quarterback who did not play.'
        : null
    };
  }

  /* The last completed game's leading passer for a team, from the artifact's
     own dated rows. Never called a starter. */
  function dominantPasserLastGame(art, teamKey, cutoff) {
    var byGame = {};
    Object.keys(art.players || {}).forEach(function (id) {
      var P = art.players[id];
      before(P.season_log || [], cutoff).forEach(function (r) {
        if (r.team_key !== teamKey) return;
        var g = byGame[r.game_id] || (byGame[r.game_id] = { kickoff: r.kickoff, rows: [] });
        g.rows.push({ athlete_id: id, name: P.name, dropbacks: isNum(r.dropbacks) ? r.dropbacks : 0 });
      });
    });
    var keys = Object.keys(byGame);
    if (!keys.length) return null;
    keys.sort(function (a, b) { return (ms(byGame[b].kickoff) || 0) - (ms(byGame[a].kickoff) || 0); });
    var last = byGame[keys[0]];
    var total = last.rows.reduce(function (a, r) { return a + r.dropbacks; }, 0);
    last.rows.sort(function (a, b) { return b.dropbacks - a.dropbacks; });
    if (last.rows.length > 1 && last.rows[0].dropbacks === last.rows[1].dropbacks) return null;  /* a tie is not an answer */
    var top = last.rows[0];
    if (!top || !top.dropbacks) return null;
    return { athlete_id: top.athlete_id, name: top.name, dropbacks: top.dropbacks,
      team_dropbacks: total, share: total ? r3(top.dropbacks / total) : null, kickoff: last.kickoff,
      game_id: keys[0] };
  }

  /* Every number this packet carries, with its label, its sample size and one
     sentence on whether it touches the price. The surfaces render this list
     rather than picking fields out of the object, so the card, the packet and
     the AI cannot describe the same measurement differently. */
  function measurementList(p) {
    var out = [];
    function add(field, value, n, nUnit, scope) {
      var lab = CONTRACT ? CONTRACT.FIELD_LABELS[field] : null;
      out.push({
        field: field, scope: scope,
        label: (lab ? lab.label : field) + (scope ? ' — ' + scope : ''),
        value: value,
        sample: n, sample_unit: nUnit,
        is_epa: CONTRACT ? CONTRACT.isEpa(field) : false,
        definition: lab ? lab.definition : null,
        priced: CONTRACT ? CONTRACT.mayPrice(field) : false,
        pricing_statement: CONTRACT ? CONTRACT.pricingStatement(field)
          : 'research context; does not affect the fair line',
        state: value == null ? 'MISSING' : 'MEASURED'
      });
    }
    if (p.career) {
      add('epa_per_dropback', p.career.epa_per_dropback, p.career.dropbacks, 'dropbacks', 'career to date');
      add('yards_per_attempt', p.career.yards_per_attempt, p.career.attempts, 'attempts', 'career to date');
      add('sack_rate', p.career.sack_rate, p.career.attempts + p.career.sacks, 'dropbacks', 'career to date');
      add('interception_rate', p.career.interception_rate, p.career.attempts, 'attempts', 'career to date');
    }
    if (p.recent_5) {
      add('epa_per_dropback', p.recent_5.epa_per_dropback, p.recent_5.dropbacks, 'dropbacks', 'last five games');
    }
    return out;
  }

  /* The four-plus-one states, in one place, because the card and the legend
     must not describe them differently. */
  var LEGEND_STATES = {
    MEASURED: 'observed, with the sample size beside it',
    NO_OBSERVATIONS: 'this passer has thrown no FBS pass inside this history. An empty sample, never an '
      + 'average one',
    NO_RECONCILED_EPA: 'he has observed games, but none whose EPA reconciles against its own denominator',
    UNRESOLVED_IDENTITY: 'no athlete id resolves for this side, so there is nobody to measure',
    PARTIAL: 'the provider has not published a passing row for a completed game yet \u2014 a publication gap, '
      + 'not a quarterback who did not play',
    NO_ARTIFACT: 'no quarterback artifact has been published for this season'
  };

  /* ============================================================================
     THE CARD FORM — the same packet, small enough to ride on a slate row.

     football/fbs/slate.json is read by the board, the AI, the newsletter and
     every export, so what goes on it has to be compact. This is the SAME
     object shrunk, not a second version of it: the surfaces render this and
     nothing recomputes a rate from anything else, which is the whole reason
     the full packet exists in one place.
     ========================================================================== */
  function cardForm(p) {
    if (!p) return null;
    function slim(m) {
      if (!m) return null;
      if (m.state !== 'MEASURED') return { state: m.state, games: m.games || 0 };
      return {
        state: m.state, games: m.games, dropbacks: m.dropbacks, attempts: m.attempts,
        epa_per_dropback: m.epa_per_dropback, yards_per_attempt: m.yards_per_attempt,
        sack_rate: m.sack_rate, interception_rate: m.interception_rate,
        interceptions: m.interceptions, sacks: m.sacks,
        first_season: m.first_season, seasons_observed: m.seasons_observed,
        observed_through: m.observed_through
      };
    }
    var e = p.identity && p.identity.evidence ? p.identity.evidence : null;
    var cov = p.coverage || null;
    return {
      schema: SCHEMA, state: p.state, side: p.side || null,
      source: p.source, source_generated_at: p.source_generated_at, cutoff: p.cutoff,
      identity: p.identity ? {
        kind: p.identity.kind,
        /* the sentence travels WITH the card. A card can reach a surface that
           never saw the legend \u2014 the AI is handed one object per side \u2014
           and "LAST_GAME_PROXY" alone is a slug, not an explanation. */
        kind_means: p.identity.kind_means || IDENTITY_KIND[p.identity.kind] || null,
        player: p.identity.player, athlete_id: p.identity.athlete_id,
        status: e ? e.status : null, confirmed: e ? e.confirmed === true : false,
        label: e ? e.label : null, source: e ? e.source : null, source_url: e ? e.source_url : null,
        published_at: e ? e.published_at : null, retrieved_at: e ? e.retrieved_at : null,
        identity_corroborated: e ? e.identity_corroborated !== false : null,
        contested: e ? !!e.contested : null
      } : null,
      career: slim(p.career),
      season: slim(p.season),
      recent_5: slim(p.recent_5),
      vs_league: p.career ? p.career.vs_league : null,
      league_epa_per_dropback: p.league ? p.league.season_epa_per_dropback : null,
      team_pass_epa_per_play: p.team && p.team.offence_recent ? p.team.offence_recent.pass_epa_per_play : null,
      team_games: p.team && p.team.offence_recent ? p.team.offence_recent.games : 0,
      opponent_allowed_pass_epa_per_play: p.opponent && p.opponent.pass_defence_recent
        ? p.opponent.pass_defence_recent.allowed_pass_epa_per_play : null,
      opponent_games: p.opponent && p.opponent.pass_defence_recent ? p.opponent.pass_defence_recent.games : 0,
      state_means: LEGEND_STATES[p.state] || null,
      coverage_state: cov ? cov.state : null,
      coverage_means: cov && cov.state === 'PARTIAL' ? LEGEND_STATES.PARTIAL : null,
      games_without_passing_data: cov
        ? (cov.team_games_without_passing_data || []).concat(cov.opponent_games_without_passing_data || [])
        : null,
      points_applied: p.pricing ? p.pricing.points_applied === true : false,
      pricing_statement: p.pricing ? p.pricing.statement : null
    };
  }

  /* The prose, once. A slate row carries 152 of the cards above; it carries
     ONE of these, and every surface looks the sentences up here rather than
     writing its own. That is why the card and the AI cannot describe the same
     measurement differently. */
  var LEGEND = {
    identity_kinds: IDENTITY_KIND,
    windows: {
      career: 'every FBS-involving game from the first season of this history up to this kickoff',
      season: 'this season, up to this kickoff',
      recent_5: 'his last five completed games, which may cross a season boundary'
    },
    bases: {
      epa: 'expected points added on this passer\u2019s attempts and sacks, divided by attempts plus sacks. '
        + 'Scrambles are not in it, garbage time is, and the expected-points model is the provider\u2019s.',
      team_pass_epa: 'an unweighted mean of this team\u2019s per-game passing EPA per play over its last five '
        + 'completed games, and NOT opponent-adjusted',
      opponent_pass_defence: 'an unweighted mean of the passing EPA per play this opponent has allowed over its '
        + 'last five completed games, and NOT opponent-adjusted \u2014 a defence that has faced weaker offences '
        + 'reads better here than it is',
      league: 'every reconciled dropback in this season, all passers, FBS-involving games only'
    },
    states: LEGEND_STATES,
    pricing: null                         /* filled in below from the contract */
  };
  if (CONTRACT) {
    LEGEND.pricing = {
      points_applied: CONTRACT.COMPATIBILITY.priced_input === true,
      statement: CONTRACT.pricingStatement('epa_per_dropback'),
      why: CONTRACT.COMPATIBILITY.summary,
      blocking_findings: CONTRACT.COMPATIBILITY.blocking_findings,
      what_would_settle_it: CONTRACT.COMPATIBILITY.what_would_settle_it,
      provider_model_version: CONTRACT.PROVIDER_MODEL.model_version,
      ep_model_training_seasons: CONTRACT.PROVIDER_MODEL.ep_model.training_seasons
    };
  }

  /* The labelled measurement list, rebuilt from a CARD. The full packet builds
     the same list from itself; both go through the contract's labelling table,
     so neither can rename a field the other one did not. */
  function measurementsFromCard(c) {
    if (!c) return [];
    var out = [];
    function add(field, value, n, unit, scope) {
      var lab = CONTRACT ? CONTRACT.FIELD_LABELS[field] : null;
      out.push({
        field: field, scope: scope, label: (lab ? lab.label : field) + ' \u2014 ' + scope,
        value: value == null ? null : value, sample: n == null ? null : n, sample_unit: unit,
        is_epa: CONTRACT ? CONTRACT.isEpa(field) : false,
        definition: lab ? lab.definition : null,
        priced: CONTRACT ? CONTRACT.mayPrice(field) : false,
        pricing_statement: CONTRACT ? CONTRACT.pricingStatement(field)
          : 'research context; does not affect the fair line',
        state: value == null ? 'MISSING' : 'MEASURED'
      });
    }
    var C = c.career && c.career.state === 'MEASURED' ? c.career : null;
    add('epa_per_dropback', C ? C.epa_per_dropback : null, C ? C.dropbacks : null, 'dropbacks', 'career to date');
    add('yards_per_attempt', C ? C.yards_per_attempt : null, C ? C.attempts : null, 'attempts', 'career to date');
    add('sack_rate', C ? C.sack_rate : null, C ? C.dropbacks : null, 'dropbacks', 'career to date');
    add('interception_rate', C ? C.interception_rate : null, C ? C.attempts : null, 'attempts', 'career to date');
    var R = c.recent_5 && c.recent_5.state === 'MEASURED' ? c.recent_5 : null;
    add('epa_per_dropback', R ? R.epa_per_dropback : null, R ? R.dropbacks : null, 'dropbacks', 'last five games');
    return out;
  }

  /* ---------------------------------------------------------------- loading */
  /* Node only; the browser is handed the parsed artifact by the page. */
  function load(opts) {
    opts = opts || {};
    if (!req) return null;
    var fs = req('fs'), path = req('path');
    var here = typeof __dirname !== 'undefined' ? __dirname : '.';
    function j(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
    var season = opts.season;
    if (season == null) {
      var ix = j(path.join(here, 'index.json'));
      season = ix ? ix.season : null;
    }
    return {
      season: season,
      artifact: opts.artifact || (season != null ? j(path.join(here, 'qb_epa_' + season + '.json')) : null),
      teams: opts.teams || j(path.join(here, 'teams.json')),
      index: opts.index || j(path.join(here, 'index.json'))
    };
  }

  /* Freshness, in the four states that are not the same statement. */
  function freshness(index, now) {
    if (!index) return { state: 'ABSENT', why: 'no FBS EPA artifact has been published' };
    var f = index.freshness || {};
    var age = null;
    if (f.generated_at) age = ((now || Date.now()) - ms(f.generated_at)) / 3600000;
    var state = f.state || 'FRESH';
    if (isNum(age) && age > 24 * 10 && state === 'FRESH') state = 'STALE';
    return {
      state: state,
      generated_at: f.generated_at || null,
      observations_through: f.observations_through || null,
      age_hours: isNum(age) ? r3(age) : null,
      source_commit: f.source_commit || null,
      source_retrieved_at: f.source_retrieved_at || null,
      why: f.why || (state === 'FRESH' ? null : 'the artifact is older than its expected cadence')
    };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA,
    IDENTITY_KIND: IDENTITY_KIND, STATUS_TO_KIND: STATUS_TO_KIND,
    before: before, aggregate: aggregate, measure: measure,
    teamForm: teamForm, quarterback: quarterback, dominantPasserLastGame: dominantPasserLastGame,
    coverageFor: coverageFor,
    measurementList: measurementList, cardForm: cardForm, measurementsFromCard: measurementsFromCard,
    LEGEND: LEGEND, LEGEND_STATES: LEGEND_STATES, load: load, freshness: freshness
  };
});
