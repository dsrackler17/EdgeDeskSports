/* ===========================================================================
   EdgeDesk football — CANONICAL TEAM AND EVENT IDENTITY (football-v2).

   One answer to "which game is this?" for every representation of a football
   fixture: the Collective's schedule (team ids whose codes are cut to ten
   characters: MISSISSIPP, WESTVIRGIN), the odds feeds (full names with
   mascots: "Ole Miss Rebels"), ESPN (location, display name, abbreviation),
   nflverse (LA for the Rams), cfbfastR, and the committed settlement record.

   The 2026 college season lost most of its against-the-spread record to this
   question being answered with a string comparison: the Collective's stored
   "MISSISSIPP" never equals an odds feed's "Mississippi State Bulldogs", so
   the market row that carried the close was never joined to the game. This
   module resolves a NAME to a TEAM first, and matches GAMES on team ids and a
   kickoff tolerance, never on raw strings.

   MATCH PRIORITY for an event against the canonical games:
     1. the provider event id (collective.games.external_ref "espn:<id>")
     2. sport + season + home team id + away team id + kickoff within tolerance
     3. the same, home and away swapped (a neutral-site listing); the event is
        linked with orientation "swapped" so every line on it is negated
     4. one side resolved exactly, the other agreeing only by the ten-character
        code, unique for the pair and the window (the page's old rule, kept
        only as the last resort and labelled)
   Anything else is UNRESOLVED with a reason, and is logged, never dropped.

   The alias groups below are the single list: the SQL migration's
   collective.fg2_name_alias rows are generated from ALIAS_GROUPS
   (tools/collective/football_identity_sql.js) and a test fails if the two
   disagree.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FootballIdentity = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var CODE_MAX = 10;

  /* The canonical key: accents folded rather than stripped ("San José" is
     "San Jose"), lower case, letters and digits only. The same rule as
     teamKey() in settle_finals.js and collective/index.html. */
  function teamKey(s) {
    if (s === null || s === undefined) return '';
    var t = String(s).trim().toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, '');
  }
  /* The Collective's stored team code (collective_admin / sync_schedule):
     upper case, alphanumerics, cut to ten. */
  function teamCode(name) {
    return String(name === null || name === undefined ? '' : name).toUpperCase()
      .replace(/[^A-Z0-9]+/g, '').slice(0, CODE_MAX);
  }
  /* The same code from the accent-folded spelling: the Collective's loader
     received "San Jose State" (SANJOSESTA) where ESPN says "San José State",
     whose unfolded code drops the É entirely (SANJOSSTAT). Both are tried. */
  function fold(s) {
    var t = String(s === null || s === undefined ? '' : s);
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t;
  }
  function codesOf(name) {
    var a = teamCode(name), b = teamCode(fold(name));
    return a === b ? [a] : [b, a];
  }
  function words(s) {
    return String(s === null || s === undefined ? '' : s).trim().split(/\s+/).filter(Boolean);
  }
  /* "Ohio St." / "Ohio St" -> "Ohio State"; the only abbreviation folded by
     rule, because it is the one every provider disagrees about. A leading
     "St." is Saint and is left alone. */
  function expandState(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\s+St\.?$/i, ' State')
      .replace(/\s+St\.?(\s+\()/i, ' State$1');
  }

  /* ------------------------------------------------------------------ NFL */
  var NFL_TEAMS = [
    ['ARI', 'Arizona Cardinals', ['ARZ', 'Arizona', 'Cardinals', 'Phoenix Cardinals']],
    ['ATL', 'Atlanta Falcons', ['Atlanta', 'Falcons']],
    ['BAL', 'Baltimore Ravens', ['BLT', 'Baltimore', 'Ravens']],
    ['BUF', 'Buffalo Bills', ['Buffalo', 'Bills']],
    ['CAR', 'Carolina Panthers', ['Carolina', 'Panthers']],
    ['CHI', 'Chicago Bears', ['Chicago', 'Bears']],
    ['CIN', 'Cincinnati Bengals', ['Cincinnati', 'Bengals']],
    ['CLE', 'Cleveland Browns', ['CLV', 'Cleveland', 'Browns']],
    ['DAL', 'Dallas Cowboys', ['Dallas', 'Cowboys']],
    ['DEN', 'Denver Broncos', ['Denver', 'Broncos']],
    ['DET', 'Detroit Lions', ['Detroit', 'Lions']],
    ['GB', 'Green Bay Packers', ['GNB', 'Green Bay', 'Packers']],
    ['HOU', 'Houston Texans', ['HST', 'Houston', 'Texans']],
    ['IND', 'Indianapolis Colts', ['Indianapolis', 'Colts']],
    ['JAX', 'Jacksonville Jaguars', ['JAC', 'Jacksonville', 'Jaguars']],
    ['KC', 'Kansas City Chiefs', ['KAN', 'KCC', 'Kansas City', 'Chiefs', 'KC Chiefs']],
    ['LV', 'Las Vegas Raiders', ['LVR', 'OAK', 'Las Vegas', 'Raiders', 'Oakland Raiders']],
    ['LAC', 'Los Angeles Chargers', ['SD', 'SDG', 'LA Chargers', 'Chargers', 'San Diego Chargers']],
    /* nflverse spells the Rams "LA" */
    ['LAR', 'Los Angeles Rams', ['LA', 'STL', 'SL', 'LA Rams', 'Rams', 'St. Louis Rams']],
    ['MIA', 'Miami Dolphins', ['Miami', 'Dolphins']],
    ['MIN', 'Minnesota Vikings', ['Minnesota', 'Vikings']],
    ['NE', 'New England Patriots', ['NWE', 'New England', 'Patriots']],
    ['NO', 'New Orleans Saints', ['NOR', 'NOS', 'New Orleans', 'Saints']],
    ['NYG', 'New York Giants', ['NY Giants', 'Giants']],
    ['NYJ', 'New York Jets', ['NY Jets', 'Jets']],
    ['PHI', 'Philadelphia Eagles', ['Philadelphia', 'Eagles']],
    ['PIT', 'Pittsburgh Steelers', ['Pittsburgh', 'Steelers']],
    ['SF', 'San Francisco 49ers', ['SFO', 'San Francisco', '49ers', 'Niners']],
    ['SEA', 'Seattle Seahawks', ['Seattle', 'Seahawks']],
    ['TB', 'Tampa Bay Buccaneers', ['TAM', 'TBB', 'Tampa Bay', 'Buccaneers', 'Bucs']],
    ['TEN', 'Tennessee Titans', ['Tennessee', 'Titans']],
    ['WAS', 'Washington Commanders', ['WSH', 'WFT', 'Washington', 'Commanders', 'Washington Football Team']]
  ];

  /* ------------------------------------------------------------------ CFB */
  /* Each group is ONE school. Any spelling in a group resolves to whichever
     spelling of the same group the team registry holds. Nothing here is a
     prefix rule; every entry is an exact equivalence. */
  var CFB_ALIAS_GROUPS = [
    ['Ole Miss', 'Mississippi'],
    ['Miami', 'Miami (FL)', 'Miami FL', 'Miami Florida', 'Miami (Florida)'],
    ['Miami (OH)', 'Miami OH', 'Miami Ohio', 'Miami (Ohio)', 'Miami University'],
    ['UConn', 'Connecticut'],
    ['UMass', 'Massachusetts'],
    ['USC', 'Southern California', 'Southern Cal'],
    ['LSU', 'Louisiana State'],
    ['SMU', 'Southern Methodist'],
    ['TCU', 'Texas Christian'],
    ['UCF', 'Central Florida'],
    ['UNLV', 'Nevada-Las Vegas', 'Nevada Las Vegas'],
    ['UTEP', 'Texas-El Paso', 'Texas El Paso', 'UT El Paso'],
    ['UTSA', 'Texas-San Antonio', 'Texas San Antonio', 'UT San Antonio'],
    ['FIU', 'Florida International', 'Florida Intl'],
    ['FAU', 'Florida Atlantic'],
    ['BYU', 'Brigham Young'],
    ['NC State', 'North Carolina State', 'N.C. State'],
    ['Pitt', 'Pittsburgh'],
    ['App State', 'Appalachian State'],
    ['Hawaii', "Hawai'i", 'Hawaiʻi'],
    ['San Jose State', 'San José State', 'SJSU'],
    ['UL Monroe', 'Louisiana-Monroe', 'Louisiana Monroe', 'ULM'],
    ['Louisiana', 'Louisiana-Lafayette', 'Louisiana Lafayette', 'UL Lafayette', 'Louisiana Ragin Cajuns'],
    ['Southern Miss', 'Southern Mississippi'],
    ['Sam Houston', 'Sam Houston State'],
    ['Army', 'Army West Point'],
    ['UAB', 'Alabama-Birmingham', 'Alabama Birmingham'],
    ['Middle Tennessee', 'Middle Tennessee State', 'MTSU'],
    ['Western Kentucky', 'WKU'],
    ['Texas A&M', 'Texas AM'],
    ['Bowling Green', 'Bowling Green State', 'BGSU'],
    ['Northern Illinois', 'NIU'],
    ['Louisiana Tech', 'La Tech'],
    ['New Mexico State', 'NM State'],
    ['Jacksonville State', 'Jax State'],
    ['Georgia Southern', 'Ga Southern', 'GA Southern'],
    ['South Florida', 'USF'],
    ['North Texas', 'UNT'],
    ['East Carolina', 'ECU'],
    ['San Diego State', 'SDSU'],
    ['Kansas State', 'K-State'],
    ['Florida State', 'FSU'],
    ['Oklahoma State', 'OK State'],
    ['Boston College', 'BC'],
    ['Coastal Carolina', 'Coastal'],
    ['Central Michigan', 'Cent Michigan', 'C Michigan'],
    ['Eastern Michigan', 'E Michigan'],
    ['Western Michigan', 'W Michigan'],
    ['Georgia Tech', 'Georgia Institute of Technology'],
    ['Kent State', 'Kent'],
    ['Charlotte', 'UNC Charlotte'],
    ['Southeastern Louisiana', 'SE Louisiana'],
    ['Stephen F. Austin', 'SFA', 'Stephen F Austin'],
    ['Tennessee-Martin', 'UT Martin', 'Tennessee Martin'],
    ['Tennessee State', 'Tenn State'],
    ['Prairie View A&M', 'Prairie View'],
    ['Florida A&M', 'FAMU'],
    ['North Carolina A&T', 'NC A&T'],
    ['North Carolina Central', 'NC Central'],
    ['Alabama A&M', 'AAMU'],
    ['Mississippi Valley State', 'MVSU', 'Miss Valley State'],
    ['Arkansas-Pine Bluff', 'Arkansas Pine Bluff', 'UAPB'],
    ['Texas A&M-Commerce', 'East Texas A&M', 'Texas A&M Commerce'],
    ['Houston Christian', 'Houston Baptist'],
    ['McNeese', 'McNeese State'],
    ['Nicholls', 'Nicholls State'],
    ['Grambling', 'Grambling State'],
    ['Long Island University', 'LIU'],
    ['Saint Francis (PA)', 'St. Francis (PA)', 'St Francis PA'],
    ['Cal Poly', 'Cal Poly San Luis Obispo'],
    ['UC Davis', 'California-Davis'],
    ['Sacramento State', 'Sac State'],
    ['Southern Utah', 'SUU'],
    ['Utah Tech', 'Dixie State'],
    ['Eastern Washington', 'E Washington'],
    ['Northern Colorado', 'N Colorado'],
    ['Northern Arizona', 'N Arizona'],
    ['Idaho State', 'Idaho St'],
    ['UT Rio Grande Valley', 'UTRGV', 'Texas-Rio Grande Valley']
  ];

  var ALIAS_GROUPS = { NFL: NFL_TEAMS.map(function (t) { return [t[0], t[1]].concat(t[2]); }), CFB: CFB_ALIAS_GROUPS };
  var CFB_CODES = ['CFB', 'CFB-P4', 'NCAAF'];
  function leagueOf(sport) {
    var s = String(sport || '').toUpperCase();
    if (s === 'NFL') return 'NFL';
    if (CFB_CODES.indexOf(s) >= 0) return 'CFB';
    return s;
  }

  /* ---------------------------------------------------------- the registry */
  /* teams: [{id, name, code, aliases:[...]}] as the Collective holds them.
     A team whose stored name is just its code (a row loaded before full
     names were kept) is marked legacy: it can be reached by code or by
     truncation, never by an exact name it does not have. */
  function buildRegistry(sport, teams) {
    var lg = leagueOf(sport);
    var reg = { sport: lg, byKey: {}, byCode: {}, teams: {}, groupOf: {} };
    function add(map, k, id) {
      if (!k) return;
      (map[k] = map[k] || []);
      if (map[k].indexOf(id) < 0) map[k].push(id);
    }
    (ALIAS_GROUPS[lg] || []).forEach(function (grp, gi) {
      grp.forEach(function (n) { reg.groupOf[teamKey(n)] = gi; reg.groupOf[teamKey(expandState(n))] = gi; });
    });
    (teams || []).forEach(function (t) {
      if (!t || t.id === null || t.id === undefined) return;
      var id = String(t.id);
      var code = String(t.code || teamCode(t.name) || '').toUpperCase();
      var legacy = !t.name || String(t.name) === String(t.code) ||
        (/^[A-Z0-9]+$/.test(String(t.name)) && String(t.name) === code);
      reg.teams[id] = { id: id, name: t.name || null, code: code, legacy: !!legacy };
      if (code) add(reg.byCode, code, id);
      var names = legacy ? [] : [t.name];
      /* A legacy code SHORTER than the cut was never cut: it is the whole
         name with its spaces and punctuation removed (OHIO, KC, LSU), so it
         is an exact key. A code AT the cut may be a truncation and is not. */
      if (legacy && code && code.length < CODE_MAX) names.push(code);
      (t.aliases || []).forEach(function (a) { names.push(a); });
      names.forEach(function (n) {
        add(reg.byKey, teamKey(n), id);
        add(reg.byKey, teamKey(expandState(n)), id);
      });
    });
    /* every other spelling of a group reaches the team that holds one of
       them, only when exactly one team does */
    (ALIAS_GROUPS[lg] || []).forEach(function (grp) {
      var owners = [];
      grp.forEach(function (n) {
        [teamKey(n), teamKey(expandState(n))].forEach(function (k) {
          (reg.byKey[k] || []).forEach(function (id) { if (owners.indexOf(id) < 0) owners.push(id); });
        });
      });
      if (owners.length !== 1) return;
      grp.forEach(function (n) {
        var k = teamKey(n);
        if (!reg.byKey[k]) reg.byKey[k] = [owners[0]];
        var k2 = teamKey(expandState(n));
        if (!reg.byKey[k2]) reg.byKey[k2] = [owners[0]];
      });
    });
    return reg;
  }

  /* Words that are part of a school's NAME, never a mascot. Stripping one
     turns a school into a different school ("Mississippi State" into
     "Mississippi", "Miami (OH)" into "Miami"), so mascot stripping stops at
     the first of these. */
  var QUALIFIERS = ['state', 'st', 'tech', 'am', 'southern', 'northern', 'eastern', 'western', 'central',
    'christian', 'international', 'intl', 'atlantic', 'poly', 'baptist', 'methodist', 'valley', 'martin',
    'monroe', 'lafayette', 'commerce', 'birmingham', 'carolina', 'florida', 'texas', 'illinois', 'michigan',
    'kentucky', 'tennessee', 'washington', 'arizona', 'colorado', 'mexico', 'city'];
  /* The name with trailing words removed one at a time, longest first,
     stopping before any qualifier or parenthetical. */
  function prefixes(raw) {
    var w = words(raw), out = [];
    for (var n = w.length - 1; n >= 1; n--) {
      var dropped = w[n];
      if (/^\(/.test(dropped) || /\)$/.test(dropped) || QUALIFIERS.indexOf(teamKey(dropped)) >= 0) break;
      out.push(w.slice(0, n).join(' '));
    }
    return out;
  }

  /* A NAME to a TEAM. Returns {team_id, method} or {team_id:null, reason,
     candidates}. Methods, strongest first: name (an exact name, alias or
     alias-group spelling), mascot (the same after dropping trailing words:
     "Mississippi State Bulldogs" -> "Mississippi State", longest first),
     code (the ten-character code of the name equals a legacy team's code
     and nobody else's), truncation (the name IS a ten-character code, and
     exactly one full name in the registry starts with it). */
  function resolveTeam(reg, raw, universe) {
    if (!reg || raw === null || raw === undefined || raw === '') return { team_id: null, reason: 'empty', candidates: [] };
    var k = teamKey(raw), k2 = teamKey(expandState(raw));
    var hit = reg.byKey[k] || reg.byKey[k2];
    if (hit) return hit.length === 1 ? { team_id: hit[0], method: 'name' } : { team_id: null, reason: 'ambiguous_name', candidates: hit.slice() };
    var pres = prefixes(raw);
    for (var n = 0; n < pres.length; n++) {
      var pk = teamKey(pres[n]), pk2 = teamKey(expandState(pres[n]));
      var ph = reg.byKey[pk] || reg.byKey[pk2];
      if (ph) {
        if (ph.length === 1) return { team_id: ph[0], method: 'mascot' };
        return { team_id: null, reason: 'ambiguous_name', candidates: ph.slice() };
      }
    }
    /* codes: the raw string, or a mascot-free prefix of it, clipped */
    var sources = [raw].concat(pres), codes = [], owners = [];
    sources.forEach(function (s) { codesOf(s).forEach(function (c) { codes.push(c); owners.push(s); }); });
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (!c) continue;
      var ch = (reg.byCode[c] || []).filter(function (id) { return reg.teams[id].legacy; });
      if (ch.length > 1) return { team_id: null, reason: 'ambiguous_code', candidates: ch };
      if (ch.length !== 1) continue;
      if (c.length < CODE_MAX) return { team_id: ch[0], method: 'code' };
      /* AT the cut the code may be a truncation shared by two schools:
         "Mississippi" and "Mississippi State" are both MISSISSIPP. Refused
         when another school in the same slate clips to the same code. */
      var own = teamKey(owners[i]);
      var rival = (universe || []).some(function (u) {
        if (teamKey(u) === k) return false;
        return [u].concat(prefixes(u)).some(function (x) {
          return codesOf(x).indexOf(c) >= 0 && teamKey(x) !== own;
        });
      });
      if (rival) return { team_id: null, reason: 'ambiguous_code', candidates: ch };
      return { team_id: ch[0], method: 'code_truncated' };
    }
    /* a ten-character code arriving from the Collective's own schedule */
    if (k.length === CODE_MAX) {
      var tr = [];
      Object.keys(reg.teams).forEach(function (id) {
        var t = reg.teams[id];
        if (t.legacy || !t.name) return;
        if (teamKey(t.name).slice(0, CODE_MAX) === k) tr.push(id);
      });
      if (tr.length === 1) return { team_id: tr[0], method: 'truncation' };
      if (tr.length > 1) return { team_id: null, reason: 'ambiguous_truncation', candidates: tr };
    }
    return { team_id: null, reason: 'unresolved', candidates: [] };
  }

  function msOf(v) { var t = Date.parse(v); return isFinite(t) ? t : null; }

  /* ONE EVENT to ONE CANONICAL GAME. event: {source, source_event_id,
     provider_ref, sport, season, home_name, away_name, kickoff_at}. games:
     [{game_id, sport, season, home_team_id, away_team_id, kickoff_at,
     external_ref}]. */
  function matchEvent(reg, event, games, opts) {
    opts = opts || {};
    var tol = (opts.toleranceMinutes === undefined ? 36 * 60 : opts.toleranceMinutes) * 60000;
    var lg = leagueOf(event.sport);
    var pool = (games || []).filter(function (g) {
      return leagueOf(g.sport) === lg && (event.season == null || g.season == null || Number(g.season) === Number(event.season));
    });
    var kt = msOf(event.kickoff_at);
    var near = function (g) { var gk = msOf(g.kickoff_at); return kt !== null && gk !== null && Math.abs(gk - kt) <= tol; };
    var out = { source: event.source || null, source_event_id: event.source_event_id == null ? null : String(event.source_event_id),
      game_id: null, method: null, orientation: null, home: null, away: null, reason: null, candidates: 0 };

    /* 1. the provider's own id */
    if (event.provider_ref) {
      var ref = String(event.provider_ref);
      var byRef = pool.filter(function (g) {
        var r = String(g.external_ref || '');
        return r === ref || r === 'espn:' + ref || r.replace(/^[a-z]+:/, '') === ref.replace(/^[a-z]+:/, '');
      });
      if (byRef.length === 1) { out.game_id = String(byRef[0].game_id); out.method = 'provider_id'; out.orientation = 'same'; return out; }
      if (byRef.length > 1) { out.reason = 'duplicate_provider_ref'; out.candidates = byRef.length; return out; }
    }
    var h = resolveTeam(reg, event.home_name, opts.universe), a = resolveTeam(reg, event.away_name, opts.universe);
    out.home = h; out.away = a;
    if (h.team_id && a.team_id && h.team_id === a.team_id) {
      out.reason = 'both_sides_same_team';
      return out;
    }
    /* 2 and 3. both teams, the window, either orientation */
    if (h.team_id && a.team_id) {
      var same = pool.filter(function (g) { return String(g.home_team_id) === h.team_id && String(g.away_team_id) === a.team_id; });
      var swap = pool.filter(function (g) { return String(g.home_team_id) === a.team_id && String(g.away_team_id) === h.team_id; });
      var sameN = same.filter(near), swapN = swap.filter(near);
      if (sameN.length === 1 && !swapN.length) { out.game_id = String(sameN[0].game_id); out.method = 'teams_kickoff'; out.orientation = 'same'; return out; }
      if (swapN.length === 1 && !sameN.length) { out.game_id = String(swapN[0].game_id); out.method = 'teams_kickoff_swapped'; out.orientation = 'swapped'; return out; }
      if (sameN.length + swapN.length > 1) { out.reason = 'ambiguous_games'; out.candidates = sameN.length + swapN.length; return out; }
      if (same.length || swap.length) { out.reason = 'kickoff_out_of_tolerance'; out.candidates = same.length + swap.length; return out; }
      out.reason = 'no_game_for_teams';
      return out;
    }
    /* 4. one side exact, the other only by candidates */
    var strong = h.team_id ? 'home' : (a.team_id ? 'away' : null);
    if (strong) {
      var weak = strong === 'home' ? a : h;
      var sid = strong === 'home' ? h.team_id : a.team_id;
      var cand = (weak.candidates || []);
      var hits = pool.filter(near).filter(function (g) {
        var gs = strong === 'home' ? g.home_team_id : g.away_team_id;
        var gw = strong === 'home' ? g.away_team_id : g.home_team_id;
        return String(gs) === sid && cand.indexOf(String(gw)) >= 0;
      });
      if (hits.length === 1) { out.game_id = String(hits[0].game_id); out.method = 'one_side_exact'; out.orientation = 'same'; return out; }
    }
    out.reason = !h.team_id ? 'home_team_' + h.reason : 'away_team_' + a.reason;
    return out;
  }

  /* Every event of a batch, each resolved against the teams playing within
     a day of it (the only schools its ten-character code could be confused
     with). Returns the links, the refusals by reason, and any game that two
     events of the SAME source claimed. */
  function linkEvents(reg, events, games, opts) {
    opts = opts || {};
    var list = (events || []).filter(Boolean);
    var win = 36 * 3600000;
    var byTime = list.map(function (e) { return { e: e, t: msOf(e.kickoff_at) }; });
    var links = [], unresolved = [], reasons = {}, claimed = {};
    byTime.forEach(function (x) {
      var uni = [];
      byTime.forEach(function (y) {
        if (x.t === null || y.t === null || Math.abs(x.t - y.t) > win) return;
        if ((x.e.source || '') !== (y.e.source || '')) return;
        uni.push(y.e.home_name, y.e.away_name);
      });
      var r = matchEvent(reg, x.e, games, { toleranceMinutes: opts.toleranceMinutes, universe: uni });
      if (r.game_id) {
        links.push(r);
        var ck = (r.source || '') + '|' + r.game_id;
        (claimed[ck] = claimed[ck] || []).push(r.source_event_id);
      } else {
        unresolved.push(r);
        reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      }
    });
    var conflicts = Object.keys(claimed).filter(function (k) { return claimed[k].length > 1; })
      .map(function (k) { return { game_id: k.split('|')[1], source: k.split('|')[0], source_event_ids: claimed[k] }; });
    return { links: links, unresolved: unresolved, reasons: reasons, conflicts: conflicts,
      matched: links.length, total: list.length };
  }

  /* The same fixture held twice. Grouped on sport, season, the unordered
     pair of team ids and a kickoff tolerance; the canonical member is chosen
     deterministically: most predictions, then a provider ref, then the
     earliest kickoff, then the smallest id. */
  function findDuplicateGames(games, opts) {
    opts = opts || {};
    var tol = (opts.toleranceMinutes === undefined ? 36 * 60 : opts.toleranceMinutes) * 60000;
    var preds = opts.predictionCounts || {};
    var groups = {};
    (games || []).forEach(function (g) {
      if (!g || g.home_team_id == null || g.away_team_id == null) return;
      var pair = [String(g.home_team_id), String(g.away_team_id)].sort().join('|');
      var k = leagueOf(g.sport) + '|' + g.season + '|' + pair;
      (groups[k] = groups[k] || []).push(g);
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var list = groups[k].slice().sort(function (x, y) { return (msOf(x.kickoff_at) || 0) - (msOf(y.kickoff_at) || 0); });
      var used = {};
      list.forEach(function (g, i) {
        if (used[g.game_id]) return;
        var cluster = [g];
        for (var j = i + 1; j < list.length; j++) {
          if (used[list[j].game_id]) continue;
          if (Math.abs((msOf(list[j].kickoff_at) || 0) - (msOf(g.kickoff_at) || 0)) <= tol) cluster.push(list[j]);
        }
        if (cluster.length < 2) return;
        cluster.forEach(function (c) { used[c.game_id] = 1; });
        var ranked = cluster.slice().sort(function (x, y) {
          var px = preds[x.game_id] || 0, py = preds[y.game_id] || 0;
          if (px !== py) return py - px;
          var rx = x.external_ref ? 1 : 0, ry = y.external_ref ? 1 : 0;
          if (rx !== ry) return ry - rx;
          var kx = msOf(x.kickoff_at) || 0, ky = msOf(y.kickoff_at) || 0;
          if (kx !== ky) return kx - ky;
          return String(x.game_id) < String(y.game_id) ? -1 : 1;
        });
        out.push({ canonical_game_id: String(ranked[0].game_id),
          duplicate_game_ids: ranked.slice(1).map(function (x) { return String(x.game_id); }) });
      });
    });
    return out;
  }

  return {
    CODE_MAX: CODE_MAX, NFL_TEAMS: NFL_TEAMS, CFB_ALIAS_GROUPS: CFB_ALIAS_GROUPS, ALIAS_GROUPS: ALIAS_GROUPS,
    teamKey: teamKey, teamCode: teamCode, expandState: expandState, leagueOf: leagueOf,
    buildRegistry: buildRegistry, resolveTeam: resolveTeam, matchEvent: matchEvent,
    linkEvents: linkEvents, findDuplicateGames: findDuplicateGames, codesOf: codesOf
  };
});
