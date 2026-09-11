/* ============================================================================
   EdgeDesk FBS UNIVERSE — the one canonical answer to three questions.

     Who is an FBS team this season?
     What conference are they in THIS season?
     Which games belong on the board, and what kind of game is each one?

   Every one of those answers is DERIVED FROM THE SEASON'S OWN SCHEDULE FEED,
   which is the same artifact the rating state, the rankings pipeline and the
   Collective settler already read. Nothing in this file hardcodes a team's
   membership, and nothing hardcodes how many FBS teams exist: realignment
   happens every winter, programs move up from FCS, and a list frozen in a
   source file is a list that is wrong by September.

   WHAT *IS* HARDCODED, AND WHY IT IS SAFE
     One conference NAMING table. Feeds spell the same conference four ways
     ("American Athletic", "American", "AAC", "The American") and two feeds
     disagree about the same league on the same day. The table maps every
     spelling onto one id and one display name; it does NOT decide who is in
     the conference. A label the table has never seen still resolves — to a
     slug of itself, carrying its own source spelling — and is reported as an
     unexpected label rather than silently dropped.

   POWER 4 IS A VIEW, NOT A GATE
     The board covers every game with at least one active FBS team. "Power 4",
     "Other FBS" and "Independents" are groupings a reader can filter BY, and
     the Power 4 set itself is resolved per season from the trained universe
     (`params.universe.p4_by_season`) rather than assumed. When a season is
     past the end of that record the nearest earlier season is used and the
     basis says so, out loud, in the product.

     There is deliberately no "Group of 5": the 2026 FBS has six non-power
     conferences, so that name is simply false. "Other FBS" is the durable
     user-facing category and the individual conferences sit underneath it.

   Runs in the browser (window.EDFbs) and in node (module.exports).
   ES5-only on purpose: it matches the app it ships inside.
   ========================================================================== */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;

  var VERSION = 'edgedesk_fbs_universe_v1.0.0';

  /* ---------------------------------------------------------------------
     CANONICAL TEAM KEY — byte-for-byte the same function the Power 4
     engine, the rankings pipeline and the player layer use. One team is
     one team across every artifact in this repo, or a join silently
     drops a program. fbs.test.js asserts the two agree on every team in
     the live schedule feed.
     --------------------------------------------------------------------- */
  var ACCENTS = { 'é': 'e', 'í': 'i', 'á': 'a', 'ó': 'o',
    'ú': 'u', 'ñ': 'n', '’': "'", '‘': "'" };
  function normKey(name) {
    if (name == null) return null;
    var s = String(name).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/[^a-z0-9]+/g, '');
    return out || null;
  }

  /* A LOOSER key, for joining feeds that decorate the school name with a
     nickname ("Ohio Bobcats" for "Ohio") or an ampersand ("Texas A&M" ->
     "texasaandm" in one artifact, "texasam" in another). Used ONLY for
     alias resolution, never as a team's identity. */
  function aliasKey(name) {
    if (name == null) return null;
    var s = String(name).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    return out || null;
  }

  function slug(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || null;
  }

  /* =====================================================================
     THE CONFERENCE NAMING TABLE

     `source` is how the primary schedule feed (cfbfastR-data) spells it —
     recorded so a reader can trace a display name back to the row it came
     from. `label` is what EdgeDesk shows. `tier` is the STRUCTURAL default
     and is only consulted when the trained universe carries no membership
     record for the season being asked about.
     ===================================================================== */
  var CONFERENCES = [
    { id: 'acc', label: 'ACC', source: 'ACC', tier: 'p4', subdivision: 'fbs',
      aliases: ['acc', 'atlanticcoast', 'atlanticcoastconference'] },
    { id: 'bigten', label: 'Big Ten', source: 'Big Ten', tier: 'p4', subdivision: 'fbs',
      aliases: ['bigten', 'big10', 'b1g', 'bigtenconference'] },
    { id: 'big12', label: 'Big 12', source: 'Big 12', tier: 'p4', subdivision: 'fbs',
      aliases: ['big12', 'bigxii', 'big12conference', 'bigtwelve'] },
    { id: 'sec', label: 'SEC', source: 'SEC', tier: 'p4', subdivision: 'fbs',
      aliases: ['sec', 'southeastern', 'southeasternconference'] },
    { id: 'american', label: 'American', source: 'American Athletic', tier: 'other', subdivision: 'fbs',
      aliases: ['american', 'americanathletic', 'aac', 'theamerican',
        'americanathleticconference', 'americanconference'] },
    { id: 'cusa', label: 'Conference USA', source: 'Conference USA', tier: 'other', subdivision: 'fbs',
      aliases: ['conferenceusa', 'cusa', 'cusa1', 'conference-usa'] },
    { id: 'mac', label: 'MAC', source: 'Mid-American', tier: 'other', subdivision: 'fbs',
      aliases: ['midamerican', 'mac', 'midamericanconference', 'mid-american'] },
    { id: 'mwc', label: 'Mountain West', source: 'Mountain West', tier: 'other', subdivision: 'fbs',
      aliases: ['mountainwest', 'mwc', 'mw', 'mountainwestconference'] },
    { id: 'pac12', label: 'Pac-12', source: 'Pac-12', tier: 'other', subdivision: 'fbs',
      aliases: ['pac12', 'pactwelve', 'pacific12', 'pac12conference'] },
    { id: 'sunbelt', label: 'Sun Belt', source: 'Sun Belt', tier: 'other', subdivision: 'fbs',
      aliases: ['sunbelt', 'sbc', 'sunbeltconference'] },
    { id: 'independents', label: 'Independents', source: 'FBS Independents', tier: 'independent', subdivision: 'fbs',
      aliases: ['fbsindependents', 'fbsindependent', 'independents', 'independent', 'ind',
        'fbsindependentsconference'] },
    /* Historical FBS leagues. Registered so a backwards-looking build reads
       2009 Oregon as Pac-10 rather than inventing a Pac-12 that did not
       exist, and so a season-aware conference attribution is checkable. */
    { id: 'pac10', label: 'Pac-10', source: 'Pac-10', tier: 'p4', subdivision: 'fbs', historical: true,
      aliases: ['pac10', 'pacten', 'pacific10'] },
    { id: 'bigeast', label: 'Big East', source: 'Big East', tier: 'p4', subdivision: 'fbs', historical: true,
      aliases: ['bigeast', 'bigeastconference'] },
    { id: 'wac', label: 'Western Athletic', source: 'Western Athletic', tier: 'other', subdivision: 'fbs', historical: true,
      aliases: ['westernathletic', 'wac', 'westernathleticconference'] },
    /* FCS. Present so an FCS opponent's league is NAMED rather than reported
       as an unexpected label, and — the part that matters — so "FCS
       Independents" can never be mistaken for the FBS independents. */
    { id: 'fcs-independents', label: 'FCS Independents', source: 'FCS Independents', tier: 'fcs', subdivision: 'fcs',
      aliases: ['fcsindependents', 'fcsindependent'] },
    { id: 'bigsky', label: 'Big Sky', source: 'Big Sky', tier: 'fcs', subdivision: 'fcs', aliases: ['bigsky'] },
    { id: 'caa', label: 'Coastal Athletic', source: 'Coastal Athletic', tier: 'fcs', subdivision: 'fcs',
      aliases: ['coastalathletic', 'caa', 'colonialathletic'] },
    { id: 'meac', label: 'MEAC', source: 'MEAC', tier: 'fcs', subdivision: 'fcs',
      aliases: ['meac', 'mideasternathletic'] },
    { id: 'mvfc', label: 'MVFC', source: 'MVFC', tier: 'fcs', subdivision: 'fcs',
      aliases: ['mvfc', 'missourivalleyfootball', 'missourivalley'] },
    { id: 'nec', label: 'NEC', source: 'NEC', tier: 'fcs', subdivision: 'fcs', aliases: ['nec', 'northeast'] },
    { id: 'ovc', label: 'OVC', source: 'OVC', tier: 'fcs', subdivision: 'fcs',
      aliases: ['ovc', 'ohiovalley', 'ovcbigsouth', 'bigsouthovc'] },
    { id: 'patriot', label: 'Patriot', source: 'Patriot', tier: 'fcs', subdivision: 'fcs', aliases: ['patriot'] },
    { id: 'swac', label: 'SWAC', source: 'SWAC', tier: 'fcs', subdivision: 'fcs',
      aliases: ['swac', 'southwesternathletic'] },
    { id: 'southern', label: 'Southern', source: 'Southern', tier: 'fcs', subdivision: 'fcs',
      aliases: ['southern', 'socon', 'southernconference'] },
    { id: 'southland', label: 'Southland', source: 'Southland', tier: 'fcs', subdivision: 'fcs', aliases: ['southland'] },
    { id: 'uac', label: 'UAC', source: 'UAC', tier: 'fcs', subdivision: 'fcs',
      aliases: ['uac', 'unitedathletic', 'unitedathleticconference'] },
    { id: 'pioneer', label: 'Pioneer', source: 'Pioneer', tier: 'fcs', subdivision: 'fcs',
      aliases: ['pioneer', 'pfl', 'pioneerfootballleague'] },
    { id: 'ivy', label: 'Ivy', source: 'Ivy', tier: 'fcs', subdivision: 'fcs', aliases: ['ivy', 'ivyleague'] },
    { id: 'bigsouth', label: 'Big South', source: 'Big South', tier: 'fcs', subdivision: 'fcs', aliases: ['bigsouth'] }
  ];

  var BY_ID = {}, BY_ALIAS = {};
  (function () {
    var i, j, c;
    for (i = 0; i < CONFERENCES.length; i++) {
      c = CONFERENCES[i];
      BY_ID[c.id] = c;
      BY_ALIAS[c.id] = c;
      BY_ALIAS[aliasKey(c.source)] = c;
      for (j = 0; j < c.aliases.length; j++) BY_ALIAS[c.aliases[j]] = c;
    }
  })();

  /* One conference label -> one canonical record. A label nobody has seen
     before resolves to a slug of itself with `known:false`, so it is still
     one stable id everywhere downstream, still displayable, and still
     reportable as something the table should learn. */
  function conference(label, opts) {
    opts = opts || {};
    var raw = String(label == null ? '' : label).trim();
    if (!raw) {
      return { id: null, label: null, source_label: null, known: false,
        tier: null, subdivision: opts.division || null, missing: true };
    }
    var hit = BY_ALIAS[aliasKey(raw)];
    if (hit) {
      return { id: hit.id, label: hit.label, source_label: raw, known: true,
        tier: hit.tier, subdivision: hit.subdivision,
        historical: !!hit.historical, missing: false };
    }
    return { id: 'x-' + slug(raw), label: raw, source_label: raw, known: false,
      tier: (String(opts.division || '').toLowerCase() === 'fcs') ? 'fcs' : null,
      subdivision: opts.division || null, missing: false };
  }

  /* =====================================================================
     SUBDIVISION

     The GitHub schedule carries `home_division` truthfully. The Supabase
     fallback does not carry it at all, and the seeded rating table is then
     the only FBS list the browser has. Read case-insensitively: 'fbs',
     'FBS' and 'Football Bowl Subdivision' have all been seen in the wild,
     and a strict === once turned a vocabulary change into every team being
     derated to the FCS floor with nothing on screen saying why.
     ===================================================================== */
  function isFbsDivision(division, teamName, opts) {
    opts = opts || {};
    var d = String(division == null ? '' : division).toLowerCase().trim();
    if (d === 'fbs' || d.indexOf('bowl') >= 0 || d === 'i-a' || d === 'ia') return true;
    if (d === 'fcs' || d.indexOf('championship') >= 0 || d === 'i-aa' || d === 'iaa'
      || d === 'ii' || d === 'iii' || d === 'd2' || d === 'd3') return false;
    if (d) return false;
    var known = opts.knownFbs;
    if (!known) return true;                       /* nothing to resolve against */
    var k = normKey(teamName);
    return !!(k && Object.prototype.hasOwnProperty.call(known, k));
  }

  /* =====================================================================
     THE POWER 4 SET, PER SEASON

     Resolved from the trained universe's own per-season membership record,
     which was derived from the schedules themselves and therefore reflects
     realignment correctly. Past the end of that record the nearest earlier
     season is used and the basis SAYS SO — the alternative is a constant
     that is wrong the first winter somebody moves.
     ===================================================================== */
  function p4Scope(season, opts) {
    opts = opts || {};
    var P = opts.params || root.EDCfbP4Params || null;
    var uni = (P && P.universe) || null;
    var bySeason = opts.p4BySeason || (uni && uni.p4_by_season) || null;
    var ids, yr;
    function idsOf(map) {
      var out = [], k, c;
      for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) {
        c = conference(k);
        if (c.id && out.indexOf(c.id) < 0) out.push(c.id);
      }
      return out.sort();
    }
    if (bySeason && season != null) {
      if (Object.prototype.hasOwnProperty.call(bySeason, String(season))) {
        return { ids: idsOf(bySeason[String(season)]), season_used: +season,
          basis: 'the ' + season + ' Power 4 membership in the trained universe, derived from that season’s own schedules' };
      }
      var years = [];
      for (yr in bySeason) if (Object.prototype.hasOwnProperty.call(bySeason, yr)) {
        if (isFinite(+yr) && +yr <= +season) years.push(+yr);
      }
      if (years.length) {
        years.sort(function (a, b) { return b - a; });
        return { ids: idsOf(bySeason[String(years[0])]), season_used: years[0],
          basis: 'the ' + years[0] + ' Power 4 membership — the latest season the trained universe carries. '
            + season + ' realignment is NOT reflected in this grouping, and each team’s conference itself '
            + 'still comes from the ' + season + ' schedule feed.' };
      }
    }
    var list = (uni && uni.p4_conferences) || opts.p4Conferences || ['SEC', 'Big Ten', 'Big 12', 'ACC'];
    ids = [];
    for (var i = 0; i < list.length; i++) {
      var c = conference(list[i]);
      if (c.id && ids.indexOf(c.id) < 0) ids.push(c.id);
    }
    return { ids: ids.sort(), season_used: null,
      basis: 'the declared Power 4 conference list — no per-season membership record was available' };
  }

  var GROUPS = [
    { id: 'all', label: 'All FBS' },
    { id: 'p4', label: 'Power 4' },
    { id: 'other', label: 'Other FBS' },
    { id: 'independent', label: 'Independents' }
  ];
  var GROUP_LABEL = { all: 'All FBS', p4: 'Power 4', other: 'Other FBS', independent: 'Independents' };

  function groupFor(confId, scope) {
    if (!confId) return null;
    if (confId === 'independents') return 'independent';
    if (scope && scope.ids && scope.ids.indexOf(confId) >= 0) return 'p4';
    var rec = BY_ID[confId];
    if (rec && rec.tier === 'fcs') return null;
    return 'other';
  }

  /* =====================================================================
     THE UNIVERSE — every team the season's schedule actually contains.
     ===================================================================== */
  function buildUniverse(opts) {
    opts = opts || {};
    var rows = opts.rows || [], season = opts.season, i, s;
    var scope = p4Scope(season, opts);
    var teams = {}, order = [];
    var diagnostics = { unmapped_teams: [], unexpected_conferences: [], missing_conference: [],
      conflicting_conferences: [], ambiguous_aliases: [] };
    var unexpectedSeen = {};

    function side(row, which) {
      var name = which === 'home' ? row.home_team : row.away_team;
      var div = which === 'home' ? row.home_division : row.away_division;
      var conf = which === 'home' ? row.home_conference : row.away_conference;
      var id = which === 'home' ? row.home_id : row.away_id;
      return { name: name, division: div, conference: conf, source_id: id == null ? null : String(id) };
    }

    for (i = 0; i < rows.length; i++) {
      var sides = [side(rows[i], 'home'), side(rows[i], 'away')];
      for (s = 0; s < 2; s++) {
        var sd = sides[s], key = normKey(sd.name);
        if (!key) {
          if (sd.name != null && String(sd.name).trim() !== '')
            diagnostics.unmapped_teams.push({ name: String(sd.name), reason: 'name does not normalise to a key' });
          continue;
        }
        var fbs = isFbsDivision(sd.division, sd.name, opts);
        var c = conference(sd.conference, { division: fbs ? 'fbs' : 'fcs' });
        var t = teams[key];
        if (!t) {
          t = teams[key] = { key: key, name: sd.name, aliases: [], division: fbs ? 'fbs' : 'fcs',
            source_ids: [], conference: c, group: fbs ? groupFor(c.id, scope) : null,
            games: 0, active: true };
          order.push(key);
        }
        if (t.aliases.indexOf(sd.name) < 0 && sd.name !== t.name) t.aliases.push(sd.name);
        if (sd.source_id && t.source_ids.indexOf(sd.source_id) < 0) t.source_ids.push(sd.source_id);
        /* An FBS reading anywhere in the season wins: a feed row that omits
           the division must never demote a team the rest of the feed calls
           FBS. */
        if (fbs && t.division !== 'fbs') { t.division = 'fbs'; t.group = groupFor(t.conference.id, scope); }
        if (c.id && t.conference.id && c.id !== t.conference.id) {
          diagnostics.conflicting_conferences.push({ team: t.name, key: key,
            seen: [t.conference.source_label, c.source_label] });
        }
        if (c.id && !t.conference.id) { t.conference = c; t.group = t.division === 'fbs' ? groupFor(c.id, scope) : null; }
        if (t.division === 'fbs' && c.missing) {
          if (!t._missingConf) { t._missingConf = true;
            diagnostics.missing_conference.push({ team: t.name, key: key }); }
        }
        if (t.division === 'fbs' && c.id && !c.known && !unexpectedSeen[c.id]) {
          unexpectedSeen[c.id] = true;
          diagnostics.unexpected_conferences.push({ label: c.source_label, id: c.id,
            team: t.name, note: 'not in the conference naming table — it still resolves to a stable id, but the table should learn it' });
        }
        t.games++;
      }
    }

    /* alias collisions: two DIFFERENT canonical teams that a looser feed
       key would merge (the "Ohio must never swallow Ohio State" case, and
       "Texas A&M" arriving from a feed that writes the ampersand out) */
    var byAlias = {};
    for (i = 0; i < order.length; i++) {
      var ak = aliasKey(teams[order[i]].name);
      (byAlias[ak] = byAlias[ak] || []).push(order[i]);
    }
    for (var a in byAlias) if (Object.prototype.hasOwnProperty.call(byAlias, a)) {
      if (byAlias[a].length > 1) diagnostics.ambiguous_aliases.push({ alias: a, keys: byAlias[a].slice() });
    }

    var confs = {}, fbsTeams = 0, fcsTeams = 0;
    for (i = 0; i < order.length; i++) {
      var tt = teams[order[i]];
      delete tt._missingConf;
      if (tt.division === 'fbs') fbsTeams++; else fcsTeams++;
      if (tt.division !== 'fbs' || !tt.conference.id) continue;
      var cid = tt.conference.id;
      if (!confs[cid]) confs[cid] = { id: cid, label: tt.conference.label, source_label: tt.conference.source_label,
        group: tt.group, known: tt.conference.known, teams: 0 };
      confs[cid].teams++;
    }
    var conferences = [];
    for (var ci in confs) if (Object.prototype.hasOwnProperty.call(confs, ci)) conferences.push(confs[ci]);
    var GORD = { p4: 0, other: 1, independent: 2 };
    conferences.sort(function (x, y) {
      var gx = GORD[x.group] == null ? 9 : GORD[x.group], gy = GORD[y.group] == null ? 9 : GORD[y.group];
      if (gx !== gy) return gx - gy;
      return x.label.localeCompare(y.label);
    });

    return { version: VERSION, season: season == null ? null : +season,
      source: opts.source || null, teams: teams, order: order, conferences: conferences,
      p4: scope, counts: { fbs_teams: fbsTeams, non_fbs_teams: fcsTeams, conferences: conferences.length,
        rows: rows.length },
      diagnostics: diagnostics };
  }

  function team(universe, name) {
    if (!universe || !universe.teams) return null;
    var k = normKey(name);
    if (k && universe.teams[k]) return universe.teams[k];
    return null;
  }

  /* =====================================================================
     ONE GAME, CLASSIFIED

     A conference game is BOTH programs in the same conference AND the feed
     saying so. Where the feed carries no flag the shared conference is used
     and the basis records that it was inferred — two independents are never
     a conference game whichever way the flag reads, because "Independents"
     is a bucket, not a league.
     ===================================================================== */
  var MATCHUP_LABEL = {
    conference: 'Conference game',
    non_conference: 'Non-conference FBS',
    fbs_fcs: 'FBS vs FCS',
    non_fbs: 'No FBS participant'
  };

  function truthy(v) {
    if (v === true) return true;
    if (v === false || v == null) return false;
    return /^(true|1|t|yes|y)$/i.test(String(v).trim());
  }
  function hasFlag(v) { return v === true || v === false || (v != null && String(v).trim() !== ''); }

  /* A stable id for a game the feed did not number. Deterministic in the
     participants, the season, the date and the kickoff — so the same game
     read twice is the same row twice, and two different games never
     collide. */
  function gameKey(row) {
    if (row && row.game_id != null && String(row.game_id).trim() !== '') return String(row.game_id);
    var d = String((row && row.start_date) || '');
    var stamp = d ? (d.slice(0, 10) + 'T' + d.slice(11, 16)) : 'no-kickoff';
    return 'edfbs:' + String((row && row.season) || '') + ':' + stamp + ':'
      + (normKey(row && row.away_team) || '?') + '@' + (normKey(row && row.home_team) || '?');
  }

  function classifyGame(row, universe) {
    var opts = { knownFbs: universe && universe._knownFbs };
    function sideOf(which) {
      var name = which === 'home' ? row.home_team : row.away_team;
      var t = team(universe, name);
      var fbs = t ? t.division === 'fbs'
        : isFbsDivision(which === 'home' ? row.home_division : row.away_division, name, opts);
      var c = t ? t.conference : conference(which === 'home' ? row.home_conference : row.away_conference,
        { division: fbs ? 'fbs' : 'fcs' });
      var scope = (universe && universe.p4) || null;
      return { side: which, name: name, key: normKey(name), is_fbs: fbs,
        conference_id: c.id, conference: c.label, conference_source: c.source_label,
        group: fbs ? (t ? t.group : groupFor(c.id, scope)) : null,
        group_label: fbs ? (GROUP_LABEL[t ? t.group : groupFor(c.id, scope)] || null) : null,
        known: !!t };
    }
    var home = sideOf('home'), away = sideOf('away');
    var fbsSides = (home.is_fbs ? 1 : 0) + (away.is_fbs ? 1 : 0);
    var sameConf = !!(home.conference_id && away.conference_id
      && home.conference_id === away.conference_id && home.conference_id !== 'independents');
    var flagged = hasFlag(row.conference_game) ? truthy(row.conference_game) : null;
    var isConf = null, basis = null;
    if (fbsSides === 2) {
      if (flagged === null) {
        isConf = sameConf;
        basis = sameConf ? 'inferred: both programs are in the same conference this season (the feed carries no conference-game flag)'
          : 'inferred: the two programs are in different conferences this season';
      } else {
        isConf = flagged && sameConf;
        basis = flagged
          ? (sameConf ? 'the schedule feed marks this a conference game and both programs share a conference'
            : 'the schedule feed marks this a conference game but the two programs are in different conferences — treated as non-conference')
          : 'the schedule feed marks this a non-conference game';
      }
    } else {
      isConf = false;
      basis = fbsSides === 1 ? 'an FBS program hosting or visiting a non-FBS opponent is never a conference game'
        : 'neither program is FBS';
    }
    var type = fbsSides === 0 ? 'non_fbs' : (fbsSides === 1 ? 'fbs_fcs' : (isConf ? 'conference' : 'non_conference'));
    var confIds = [];
    if (home.is_fbs && home.conference_id) confIds.push(home.conference_id);
    if (away.is_fbs && away.conference_id && confIds.indexOf(away.conference_id) < 0) confIds.push(away.conference_id);
    var groups = [];
    if (home.group && groups.indexOf(home.group) < 0) groups.push(home.group);
    if (away.group && groups.indexOf(away.group) < 0) groups.push(away.group);
    return { id: gameKey(row), home: home, away: away, fbs_sides: fbsSides,
      eligible: fbsSides >= 1, matchup_type: type, matchup_label: MATCHUP_LABEL[type],
      is_conference_game: isConf, conference_basis: basis,
      conference_ids: confIds, groups: groups,
      /* a projection on the same coherent FBS scale needs both teams on that
         scale; one FBS side is a real game that the model cannot fully price */
      projectable: fbsSides === 2 };
  }

  /* =====================================================================
     THE CANONICAL WEEKLY SLATE

     Every scheduled game with at least one active FBS team inside the
     window, deduplicated by canonical id, in kickoff order. A game appears
     ONCE however many selected conferences its two teams belong to.
     ===================================================================== */
  function buildSlate(opts) {
    opts = opts || {};
    var rows = opts.rows || [], universe = opts.universe;
    var now = opts.now == null ? Date.now() : opts.now;
    var look = opts.lookaheadDays == null ? 10 : opts.lookaheadDays;
    var back = opts.lookbackHours == null ? 6 : opts.lookbackHours;
    var hi = now + look * 864e5, lo = now - back * 3600e3;
    var seen = {}, out = [], dropped = { completed: 0, outside_window: 0, no_fbs: 0, duplicate: 0, no_kickoff: 0 };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.completed) { dropped.completed++; continue; }
      var t = Date.parse(r.start_date);
      if (!isFinite(t)) { dropped.no_kickoff++; continue; }
      if (t < lo || t > hi) { dropped.outside_window++; continue; }
      var meta = classifyGame(r, universe);
      if (!meta.eligible) { dropped.no_fbs++; continue; }
      if (seen[meta.id]) { dropped.duplicate++; continue; }
      seen[meta.id] = true;
      out.push({ g: r, t: t, meta: meta });
    }
    out.sort(function (a, b) { return a.t - b.t || String(a.meta.id).localeCompare(String(b.meta.id)); });
    return { items: out, dropped: dropped, window: { from: lo, to: hi, lookahead_days: look } };
  }

  /* =====================================================================
     FILTERS — composable, and each one independent of the others.
     ===================================================================== */
  var MATCHUPS = [
    { id: 'all', label: 'All matchups' },
    { id: 'conference', label: 'Conference games' },
    { id: 'non_conference', label: 'Non-conference FBS' },
    { id: 'fbs_fcs', label: 'FBS vs FCS' }
  ];

  function matchesGroup(meta, group) {
    if (!group || group === 'all') return true;
    return meta.groups.indexOf(group) >= 0;
  }
  function matchesConferences(meta, ids) {
    if (!ids || !ids.length) return true;
    for (var i = 0; i < meta.conference_ids.length; i++)
      if (ids.indexOf(meta.conference_ids[i]) >= 0) return true;
    return false;
  }
  function matchesMatchup(meta, m) {
    if (!m || m === 'all') return true;
    return meta.matchup_type === m;
  }
  function matches(meta, filters) {
    filters = filters || {};
    return matchesGroup(meta, filters.group)
      && matchesConferences(meta, filters.conferences)
      && matchesMatchup(meta, filters.matchup);
  }
  /* One pass, one row per game. Deduplication is structural: the slate is
     already keyed, so a game whose two teams both match a selected
     conference is still one item in one list. */
  function filterSlate(items, filters) {
    var out = [];
    for (var i = 0; i < items.length; i++) if (matches(items[i].meta, filters)) out.push(items[i]);
    return out;
  }

  /* =====================================================================
     ALIAS RESOLUTION — joining a sportsbook feed to a schedule feed.

     Two feeds never spell a school the same way. A book writes the nickname
     ("Ohio Bobcats"), an abbreviation ("Southern Miss"), a state short form
     ("UL Monroe"), or punctuation the other feed does not use ("Miami (OH)",
     "Hawai'i", "Texas A&M"). The board's old join was a bare PREFIX test —
     `norm(bookName).indexOf(norm(scheduleName)) === 0` — and on a Power 4
     slate that mostly worked because the ambiguous pairs were not both on
     the board. Across the whole FBS they are: "Miami (OH) RedHawks" begins
     with "miami", so Miami FLORIDA would have taken Miami OHIO's quote, and
     "Ohio State Buckeyes" begins with "ohio", so Ohio would have taken Ohio
     State's.

     THE RULE: exact key, then a curated alias, then the LONGEST prefix that
     is unambiguous. A tie resolves to NOTHING — an unmatched quote is a
     reported miss, and a quote on the wrong team is a fabricated market.
     ===================================================================== */

  /* canonical key -> spellings other feeds use for the same program. Only
     entries the canonical key cannot already reach on its own are listed;
     everything here is a real spelling seen in a schedule, book or odds
     feed, not a guess at one. */
  var TEAM_ALIASES = {
    appstate: ['appalachian state', 'appalachian st', 'app st'],
    hawaii: ["hawai'i", 'hawaii', 'hawaii rainbow warriors', 'university of hawaii'],
    sanjosestate: ['san jose state', 'san jose st', 'sjsu'],
    miamioh: ['miami ohio', 'miami (ohio)', 'miami oh', 'miami (oh)', 'miami redhawks', 'miami-ohio'],
    miami: ['miami fl', 'miami (fl)', 'miami florida', 'miami (florida)', 'miami hurricanes', 'miami-florida'],
    olemiss: ['mississippi', 'ole miss rebels'],
    massachusetts: ['umass', 'u mass', 'mass'],
    southernmiss: ['southern mississippi', 'southern miss', 'so miss', 'usm'],
    uconn: ['connecticut'],
    ulmonroe: ['louisiana monroe', 'louisiana-monroe', 'ul monroe', 'ulm', 'la monroe'],
    louisiana: ['louisiana lafayette', 'louisiana-lafayette', 'ul lafayette', 'ull', 'la lafayette',
      'louisiana ragin cajuns'],
    ncstate: ['north carolina state', 'n c state', 'nc st'],
    utsa: ['texas san antonio', 'texas-san antonio', 'ut san antonio'],
    utep: ['texas el paso', 'texas-el paso', 'ut el paso'],
    floridainternational: ['fiu', 'florida intl'],
    floridaatlantic: ['fau'],
    uab: ['alabama birmingham', 'alabama-birmingham', 'ala birmingham'],
    ucf: ['central florida'],
    southflorida: ['usf'],
    smu: ['southern methodist'],
    tcu: ['texas christian'],
    byu: ['brigham young'],
    lsu: ['louisiana state'],
    pittsburgh: ['pitt'],
    texasam: ['texas a&m', 'texas a and m', 'texas am', 'texas a m', 'texas aandm', 'texasaandm'],
    samhouston: ['sam houston state', 'sam houston st', 'shsu'],
    jacksonvillestate: ['jax state', 'jacksonville st'],
    usc: ['southern california', 'southern cal'],
    unlv: ['nevada las vegas', 'nevada-las vegas', 'las vegas'],
    nevada: ['nevada reno', 'nevada-reno'],
    middletennessee: ['middle tennessee state', 'middle tennessee st', 'mtsu'],
    westernkentucky: ['wku'],
    northernillinois: ['niu'],
    charlotte: ['north carolina charlotte', 'unc charlotte'],
    olddominion: ['odu'],
    coastalcarolina: ['ccu'],
    bowlinggreen: ['bowling green state'],
    kentstate: ['kent'],
    sacramentostate: ['sac state', 'sacramento st', 'csu sacramento'],
    northdakotastate: ['ndsu', 'north dakota st'],
    missouristate: ['missouri st'],
    kennesawstate: ['kennesaw st'],
    georgiasouthern: ['ga southern'],
    georgiastate: ['ga state'],
    mississippistate: ['miss state', 'mississippi st'],
    northcarolina: ['unc'],
    fresnostate: ['fresno st'],
    boisestate: ['boise st'],
    arizonastate: ['arizona st'],
    michiganstate: ['michigan st'],
    oklahomastate: ['oklahoma st'],
    oregonstate: ['oregon st'],
    washingtonstate: ['washington st'],
    pennstate: ['penn st'],
    iowastate: ['iowa st'],
    kansasstate: ['kansas st'],
    floridastate: ['florida st'],
    coloradostate: ['colorado st'],
    sandiegostate: ['san diego st'],
    utahstate: ['utah st'],
    texasstate: ['texas st'],
    arkansasstate: ['arkansas st'],
    ballstate: ['ball st'],
    newmexicostate: ['new mexico st'],
    louisianatech: ['la tech'],
    virginiatech: ['va tech'],
    eastcarolina: ['ecu'],
    westvirginia: ['wvu']
  };
  /* the reverse map, keyed the loose way so "Texas A&M" and "Texas AandM"
     both land on the same row */
  var ALIAS_TO_KEY = {};
  (function () {
    var k, i;
    for (k in TEAM_ALIASES) if (Object.prototype.hasOwnProperty.call(TEAM_ALIASES, k)) {
      for (i = 0; i < TEAM_ALIASES[k].length; i++) ALIAS_TO_KEY[aliasKey(TEAM_ALIASES[k][i])] = k;
    }
  })();

  /* "Boise St" and "Boise St." are the same school as "Boise State"; the
     expansion is tried only AFTER the exact and alias passes fail, so it can
     never overrule a real name. */
  function expandState(name) {
    var s = String(name == null ? '' : name);
    var out = s.replace(/(^|[^a-z])st\.?($|[^a-z])/gi, function (m, a, b) { return a + 'State' + b; });
    return out === s ? null : out;
  }

  function teamIndex(universe) {
    var ix = { byKey: {}, byAlias: {}, keys: [], prefixes: [], universe: universe };
    if (!universe || !universe.teams) return ix;
    var i, k, t;
    for (i = 0; i < universe.order.length; i++) {
      k = universe.order[i]; t = universe.teams[k];
      ix.byKey[k] = t;
      ix.byAlias[aliasKey(t.name)] = k;
      for (var a = 0; a < t.aliases.length; a++) ix.byAlias[aliasKey(t.aliases[a])] = k;
      ix.keys.push(k);
    }
    for (k in ALIAS_TO_KEY) if (Object.prototype.hasOwnProperty.call(ALIAS_TO_KEY, k)) {
      if (ix.byKey[ALIAS_TO_KEY[k]] && !ix.byAlias[k]) ix.byAlias[k] = ALIAS_TO_KEY[k];
    }
    ix.keys.sort(function (x, y) { return y.length - x.length || x.localeCompare(y); });
    /* The prefix pass runs over canonical keys AND known aliases together:
       a book writes "UMass Minutemen" and "Pitt Panthers", which are a
       nickname stuck onto an ALIAS, not onto the school's schedule name. */
    var seen = {};
    function addPrefix(s, key) {
      if (!s || s.length < 3 || seen[s + '|' + key]) return;
      seen[s + '|' + key] = 1;
      ix.prefixes.push({ s: s, key: key });
    }
    for (i = 0; i < ix.keys.length; i++) addPrefix(ix.keys[i], ix.keys[i]);
    for (k in ix.byAlias) if (Object.prototype.hasOwnProperty.call(ix.byAlias, k)) addPrefix(k, ix.byAlias[k]);
    ix.prefixes.sort(function (x, y) { return y.s.length - x.s.length || x.s.localeCompare(y.s); });
    return ix;
  }

  function resolveTeam(name, ix, opts) {
    opts = opts || {};
    if (!ix || !name) return null;
    var k = normKey(name);
    if (k && ix.byKey[k]) return { key: k, team: ix.byKey[k], how: 'exact', ambiguous: null };
    var ak = aliasKey(name);
    if (ak && ix.byAlias[ak]) return { key: ix.byAlias[ak], team: ix.byKey[ix.byAlias[ak]], how: 'alias', ambiguous: null };
    var ex = expandState(name);
    if (ex) {
      var ek = normKey(ex), eak = aliasKey(ex);
      if (ek && ix.byKey[ek]) return { key: ek, team: ix.byKey[ek], how: 'state-expansion', ambiguous: null };
      if (eak && ix.byAlias[eak]) return { key: ix.byAlias[eak], team: ix.byKey[ix.byAlias[eak]], how: 'state-expansion', ambiguous: null };
    }
    /* longest unambiguous prefix, over canonical keys and aliases together.
       `ix.prefixes` is longest-first, so the first hit is the longest; a
       SECOND hit of the same length pointing at a DIFFERENT school is a tie
       and resolves to nothing — "Ohio" must never swallow "Ohio State", and
       Miami Florida must never take Miami Ohio's number. */
    if (!ak || ak.length < (opts.minPrefix == null ? 3 : opts.minPrefix)) return null;
    var best = null, tie = null, i, c;
    for (i = 0; i < ix.prefixes.length; i++) {
      c = ix.prefixes[i];
      if (ak.indexOf(c.s) !== 0) continue;
      if (!best) { best = c; continue; }
      if (c.s.length === best.s.length) { if (c.key !== best.key) { tie = c; } continue; }
      break;                                     /* shorter than `best`: stop */
    }
    if (!best) return null;
    if (tie) return { key: null, team: null, how: 'ambiguous', ambiguous: [best.key, tie.key] };
    return { key: best.key, team: ix.byKey[best.key], how: 'prefix', matched: best.s, ambiguous: null };
  }

  /* Does this captured odds event describe this scheduled game? Both sides
     must resolve to the game's own teams and the kickoffs must agree. A
     half match is not a match: a quote joined on the home team alone is how
     a book's Ohio number ends up priced against Ohio State. */
  function matchesEvent(ev, item, ix, opts) {
    opts = opts || {};
    if (!ev || !item) return false;
    var windowMs = opts.windowMs == null ? 36 * 3600e3 : opts.windowMs;
    var hk = item.meta ? item.meta.home.key : normKey(item.g && item.g.home_team);
    var ak = item.meta ? item.meta.away.key : normKey(item.g && item.g.away_team);
    var rh = resolveTeam(ev.home, ix), ra = resolveTeam(ev.away, ix);
    if (!rh || !ra || !rh.key || !ra.key) return false;
    if (rh.key !== hk || ra.key !== ak) return false;
    var t = Date.parse(ev.t);
    if (!isFinite(t) || !isFinite(item.t)) return false;
    return Math.abs(t - item.t) < windowMs;
  }

  /* =====================================================================
     THE AUDIT — what a build-time gate needs, as data.
     ===================================================================== */
  function audit(universe, opts) {
    opts = opts || {};
    var slate = opts.slate || [];
    var ratings = opts.ratings || {};          /* key -> anything, from the engine state / seed table */
    var report = {
      version: VERSION, season: universe ? universe.season : null,
      source: universe ? universe.source : null,
      generated_at: new Date().toISOString(),
      counts: universe ? universe.counts : null,
      p4: universe ? universe.p4 : null,
      conferences: universe ? universe.conferences : [],
      unmapped_teams: universe ? universe.diagnostics.unmapped_teams : [],
      ambiguous_aliases: universe ? universe.diagnostics.ambiguous_aliases : [],
      missing_conference: universe ? universe.diagnostics.missing_conference : [],
      unexpected_conferences: universe ? universe.diagnostics.unexpected_conferences : [],
      conflicting_conferences: universe ? universe.diagnostics.conflicting_conferences : [],
      fbs_teams_without_rating: [],
      duplicate_games: [],
      games_missing_projection: [],
      odds_unmatched: opts.oddsUnmatched || [],
      slate: { total: slate.length, by_group: {}, by_matchup: {}, by_conference: {} }
    };
    var k, i;
    if (universe) {
      for (i = 0; i < universe.order.length; i++) {
        k = universe.order[i];
        var t = universe.teams[k];
        if (t.division !== 'fbs') continue;
        if (!Object.prototype.hasOwnProperty.call(ratings, k))
          report.fbs_teams_without_rating.push({ key: k, team: t.name, conference: t.conference.label });
      }
    }
    var seen = {};
    for (i = 0; i < slate.length; i++) {
      var it = slate[i], m = it.meta;
      if (seen[m.id]) report.duplicate_games.push({ id: m.id, label: m.away.name + ' @ ' + m.home.name });
      seen[m.id] = true;
      report.slate.by_matchup[m.matchup_type] = (report.slate.by_matchup[m.matchup_type] || 0) + 1;
      for (var gi = 0; gi < m.groups.length; gi++)
        report.slate.by_group[m.groups[gi]] = (report.slate.by_group[m.groups[gi]] || 0) + 1;
      for (var ci = 0; ci < m.conference_ids.length; ci++)
        report.slate.by_conference[m.conference_ids[ci]] = (report.slate.by_conference[m.conference_ids[ci]] || 0) + 1;
      if (m.projectable && opts.projected && !opts.projected[m.id])
        report.games_missing_projection.push({ id: m.id, label: m.away.name + ' @ ' + m.home.name });
    }
    report.ok = !report.unmapped_teams.length && !report.missing_conference.length
      && !report.conflicting_conferences.length && !report.fbs_teams_without_rating.length
      && !report.duplicate_games.length && !report.games_missing_projection.length;
    return report;
  }

  var api = {
    VERSION: VERSION,
    normKey: normKey, aliasKey: aliasKey, slug: slug,
    CONFERENCES: CONFERENCES, GROUPS: GROUPS, GROUP_LABEL: GROUP_LABEL, MATCHUPS: MATCHUPS,
    MATCHUP_LABEL: MATCHUP_LABEL,
    conference: conference, conferenceById: function (id) { return BY_ID[id] || null; },
    isFbsDivision: isFbsDivision,
    p4Scope: p4Scope, groupFor: groupFor,
    buildUniverse: buildUniverse, team: team,
    TEAM_ALIASES: TEAM_ALIASES, teamIndex: teamIndex, resolveTeam: resolveTeam,
    matchesEvent: matchesEvent, expandState: expandState,
    classifyGame: classifyGame, gameKey: gameKey,
    buildSlate: buildSlate, filterSlate: filterSlate, matches: matches,
    matchesGroup: matchesGroup, matchesConferences: matchesConferences, matchesMatchup: matchesMatchup,
    audit: audit
  };

  root.EDFbs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
