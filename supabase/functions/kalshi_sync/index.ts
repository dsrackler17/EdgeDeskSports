// @ts-nocheck — a plain JavaScript core (lib/football_identity.js) inlined in a .ts file, as nba_injury_sync and circa_ownership_sync inline theirs.
// ============================================================
//  FILE:    supabase/functions/kalshi_sync/index.ts
//  TYPE:    Edge Function — Kalshi public market data (T0, provider Kalshi)
//           and its link to EdgeDesk's NFL and CFB games
//  DEPLOY:  supabase functions deploy kalshi_sync --no-verify-jwt
//           .github/workflows/deploy-kalshi.yml does it, tests first
//  CRON:    supabase/kalshi_market_data_cron.sql — discover daily at 09:17
//           UTC, snapshot every 5 minutes
//  SQL:     supabase/kalshi_market_data.sql
// ============================================================
// Kalshi's market data is public: no Kalshi key is read or needed.
//
// MODES (POST body {"mode": ...}; ?mode= also works):
//   discover  GET /series?category=Sports -> kalshi_series, upserted WITHOUT
//             the operator's `tracked` switch; then the status and result of
//             tracked markets whose game has ended (GET /markets?tickers=)
//   snapshot  for every tracked series, GET /markets?status=open (multivariate
//             combos excluded), every page: the market rows upserted, then ONE
//             kalshi_price_snapshots row per market settling inside the
//             horizon (append-only); then the game links
//
// THE GAME LINKS. For every event of a game-winner series (kalshi_link_series)
// with no link yet:
//   1. its two markets name its two teams: yes_sub_title, and for the NFL also
//      the market ticker's club code (KXNFLGAME-26OCT26DALPHI-PHI). Names are
//      resolved with lib/football_identity.js, copied in verbatim below — the
//      Collective's grading and the board resolve teams with the same code.
//   2. EXACTLY ONE book event in public.signals (the h2h rows: event_id,
//      home_team, away_team, commence_time) must carry both teams, and the
//      date must agree on at least one of: the event ticker's Eastern date
//      (Kalshi does not update it when a game moves) and the markets'
//      expected_expiration_time (about kickoff + 3 hours).
//   3. the YES side of each market is the book's h2h selection for the same
//      team: that row's sig_key is the fair it is compared with.
//   4. the card's own game id comes from public.game_research_state (game_id,
//      home, away, kickoff_at): both teams, kickoff within 36 hours of the
//      book's — the board's own tolerance. Not there yet: the link is made
//      without it and the id is filled on a later run.
// Anything else stays UNMAPPED, with its reason in the run's details: no
// nearest name, no nearest game, nothing guessed.
// CONFIDENCE  high    every team resolved by name or alias (an NFL club by its
//                     ticker code AND its name — "New York G" is read by city
//                     and initial), the book's names by name or mascot, and
//                     both date signals agree
//             medium  matched on one NFL signal only, or one date signal
//
// FAILURE AND DEGRADATION (public.kalshi_alerts, public.kalshi_readiness):
//   FAILURE   Kalshi unreachable for every tracked series; a database write
//             failed; the poke had no secret (kalshi_market_data_cron.sql)
//   DEGRADED  some tracked series failed; the book events could not be read
//   DRIFT     a market without the dollar price fields (not snapshotted: no
//             price is stored in place of a missing one); a series list
//             without `series`; a game-winner series missing from the list
//   WARNING   nothing tracked; game markets settling soon left unmapped
//             (at most hourly); the research state unreadable
//
// AUTH. pg_cron sends the Vault secret kalshi_cron_secret as x-cron-secret; it
// must equal KALSHI_CRON_SECRET. A GET is a public health probe (BUILD only).
//
// POST body (all optional):
//   mode   discover | snapshot (default snapshot)
//   dry    read and compute; write nothing; return everything
//   now    ISO time to run as (dry runs only)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), KALSHI_CRON_SECRET,
//      KALSHI_BASE (default https://external-api.kalshi.com/trade-api/v2; the
//      shared host https://api.elections.kalshi.com/trade-api/v2 is tried
//      whenever the first cannot be reached or refuses),
//      KALSHI_SPORTS_CATEGORY (default Sports),
//      KALSHI_SNAPSHOT_HORIZON_HOURS (default 192: markets settling further
//      out keep their metadata current but are not snapshotted)
// ============================================================

export const BUILD = "kalshi_sync@2026-10-21.1";
export const LINKER_VERSION = "kalshi-link-1";
const DEFAULT_BASE = "https://external-api.kalshi.com/trade-api/v2";
const SHARED_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const UA = { "user-agent": "EdgeDesk research (+https://edgedesksports.com)" };
const BOOK_SPORT = { nfl: "americanfootball_nfl", cfb: "americanfootball_ncaaf" };
const GAME_TOLERANCE_MS = 36 * 3600e3;   // the board's own signals-to-game tolerance (fbNflMarketFor, fbGameCardCfb)
const EXPECTED_END_MAX_MS = 8 * 3600e3;  // expected_expiration_time sits ~3 h after kickoff; 8 h allows a long game and a delay
const UNMAPPED_WINDOW_MS = 30 * 3600e3;  // kalshi_rule('unmapped_window_hours')
/* Kalshi spellings the shared identity list does not carry, each with the
   spelling it does. Add a pair here when a run's details name one; never a
   prefix rule. */
const KALSHI_CFB_ALIASES = [
  ["University at Albany", "Albany"],
];

// ── BEGIN FOOTBALL IDENTITY ── copied from lib/football_identity.js by tools/kalshi/inline_identity.js; do not edit here
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
// ── END FOOTBALL IDENTITY ──

// deno-lint-ignore no-explicit-any
type Any = any;
const FI: Any = (globalThis as Any).FootballIdentity;
const env = (k: string): string => ((globalThis as Any).Deno?.env.get(k) ?? "");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const iso = (ms: number) => new Date(ms).toISOString();
function deadline(ms: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(ms); } catch { return undefined; } }

/* tests stand in for the clock between retries */
export const hooks: Any = { sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) };

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
async function db(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init?.headers as Any) ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) { const e: Any = new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300)); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
const insert = (table: string, rows: Any) =>
  db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal" } });
const upsert = (table: string, rows: Any, key: string) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=merge-duplicates" } });
const insertOnce = (table: string, rows: Any, key: string) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=ignore-duplicates" } });
async function dbAll(path: string, pages = 20): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < pages; p++) {
    const rows = (await db(path + "&limit=1000&offset=" + p * 1000)) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function inChunks(rows: Any[], n: number, fn: (c: Any[]) => Promise<Any>) { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); }
const inList = (xs: string[]) => "(" + xs.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(",") + ")";

/* ---------------------------------------------------------------- Kalshi (public REST) */
let hostInUse: string | null = null;
function hosts(): string[] {
  const first = (env("KALSHI_BASE") || DEFAULT_BASE).replace(/\/$/, "");
  const all = first === SHARED_BASE ? [first] : [first, SHARED_BASE];
  return hostInUse ? [hostInUse, ...all.filter((h) => h !== hostInUse)] : all;
}
/** GET a public Kalshi path. 429 and 5xx back off (Kalshi sends no Retry-After);
    a host that cannot be reached, or refuses (401/403), hands over to the next. */
export async function kalshiGet(path: string, params: Record<string, Any> = {}, ctx?: Any) {
  let last: Error | null = null;
  for (const base of hosts()) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try { res = await fetch(url.toString(), { headers: { accept: "application/json", ...UA }, signal: deadline(20000) }); }
      catch (e) { last = new Error("Kalshi could not be reached at " + new URL(base).host + " (" + msg(e) + ")"); break; }
      if (res.status === 429 || res.status >= 500) { last = new Error("Kalshi answered " + res.status + " on " + url.pathname); await hooks.sleep(250 * 2 ** attempt); continue; }
      if (res.status === 401 || res.status === 403) { last = new Error("Kalshi refused " + url.pathname + " at " + new URL(base).host + " (HTTP " + res.status + ")"); break; }
      if (!res.ok) { const e: Any = new Error("Kalshi answered " + res.status + " on " + url.pathname + ": " + (await res.text()).slice(0, 200)); e.status = res.status; throw e; }
      const j = await res.json();
      hostInUse = base;
      if (ctx) ctx.host = new URL(base).host;
      return j;
    }
  }
  throw last || new Error("Kalshi could not be reached");
}

/* Kalshi sends prices and counts as fixed-point strings ("0.5600", "10.00"). */
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/* a price is a dollar fraction of the $1 payout; anything else is not stored as one */
const price = (v: unknown) => { const n = num(v); return n == null || n < 0 || n > 1 ? null : n; };
const ms = (v: unknown) => { const t = v ? Date.parse(String(v)) : NaN; return Number.isFinite(t) ? t : null; };

/* ---------------------------------------------------------------- dates */
const MON: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
/** the Eastern game date in an event ticker: KXNFLGAME-26OCT26DALPHI -> 2026-10-26 */
export function tickerDate(eventTicker: string): string | null {
  const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(String(eventTicker || ""));
  if (!m || !MON[m[2]]) return null;
  return "20" + m[1] + "-" + String(MON[m[2]]).padStart(2, "0") + "-" + m[3];
}
const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const etDate = (t: number) => ET.format(new Date(t));

/* ---------------------------------------------------------------- rows */
function marketRow(m: Any, series: string, at: string) {
  return {
    ticker: m.ticker, event_ticker: m.event_ticker, series_ticker: series, market_type: m.market_type ?? null,
    title: m.title ?? null, yes_sub_title: m.yes_sub_title ?? null, no_sub_title: m.no_sub_title ?? null, rules_primary: m.rules_primary ?? null,
    open_time: m.open_time ?? null, close_time: m.close_time ?? null, expected_expiration_time: m.expected_expiration_time ?? null,
    status: m.status ?? null, result: m.result || null, updated_at: at,
  };
}
function snapRow(m: Any, at: string, nowMs: number, runId: string) {
  const close = ms(m.close_time);
  return {
    ticker: m.ticker, captured_at: at,
    minutes_to_close: close == null ? null : Math.round(((close - nowMs) / 60000) * 100) / 100,
    status: m.status ?? null,
    yes_bid: price(m.yes_bid_dollars), yes_ask: price(m.yes_ask_dollars), no_bid: price(m.no_bid_dollars), no_ask: price(m.no_ask_dollars),
    last_price: price(m.last_price_dollars),
    yes_bid_size: num(m.yes_bid_size_fp), yes_ask_size: num(m.yes_ask_size_fp),
    volume: num(m.volume_fp), volume_24h: num(m.volume_24h_fp), open_interest: num(m.open_interest_fp),
    run_id: runId,
  };
}
const hasPrices = (m: Any) => m && "yes_bid_dollars" in m && "yes_ask_dollars" in m;
/** expected end (~kickoff + 3 h), else Kalshi's close_time */
const settlesAt = (m: Any) => ms(m.expected_expiration_time) ?? ms(m.close_time);

/* ---------------------------------------------------------------- discover */
async function discover(ctx: Any) {
  const cat = env("KALSHI_SPORTS_CATEGORY") || "Sports";
  const data = await kalshiGet("/series", { category: cat }, ctx);
  if (!data || !Array.isArray(data.series)) {
    ctx.alert("DRIFT", "series_shape", "GET /series answered without a series list: nothing was written");
    return;
  }
  const at = iso(ctx.nowMs);
  const rows = data.series.filter((s: Any) => s && s.ticker).map((s: Any) => ({
    ticker: s.ticker, title: s.title ?? null, category: s.category ?? null,
    categories: Array.isArray(s.categories) ? s.categories : [], tags: Array.isArray(s.tags) ? s.tags : [],
    frequency: s.frequency ?? null, updated_at: at,
  }));
  ctx.run.series_found = rows.length;
  if (!rows.length) ctx.alert("DEGRADED", "no_series", "Kalshi listed no series in category " + cat);
  if (!ctx.dry) await inChunks(rows, 500, (c) => upsert("kalshi_series", c, "ticker"));
  const listed = new Set(rows.map((r: Any) => r.ticker));
  const ls = ((await db("kalshi_link_series?select=series_ticker")) || []).map((x: Any) => x.series_ticker);
  const missing = ls.filter((t: string) => !listed.has(t));
  if (rows.length && missing.length) ctx.alert("DRIFT", "link_series_missing", "game-winner series not in Kalshi's " + cat + " list: " + missing.join(", ") + " (renamed or retired?)", { missing });
  ctx.out.series = { found: rows.length, game_series_missing: missing };
  await refreshEnded(ctx);
}

/** the status and result of tracked markets whose game has ended: a snapshot
    run only sees open markets, so without this a settled market would read
    "active" forever */
async function refreshEnded(ctx: Any) {
  try {
    const tracked = ((await db("kalshi_series?select=ticker&tracked=is.true")) || []).map((x: Any) => x.ticker);
    if (!tracked.length) return;
    const ended = (await dbAll("kalshi_markets?select=ticker&series_ticker=in." + inList(tracked)
      + "&status=not.in.(finalized,settled)&expected_expiration_time=lt." + encodeURIComponent(iso(ctx.nowMs)) + "&order=ticker", 2)).map((x: Any) => x.ticker);
    let refreshed = 0;
    for (let i = 0; i < ended.length; i += 100) {
      const page = await kalshiGet("/markets", { tickers: ended.slice(i, i + 100).join(","), limit: 1000 }, ctx);
      const ms_ = (page && Array.isArray(page.markets) ? page.markets : []).filter((m: Any) => m && m.ticker && tracked.includes(m.series_ticker || String(m.event_ticker || "").split("-")[0]));
      const rows = ms_.map((m: Any) => marketRow(m, m.series_ticker || String(m.event_ticker).split("-")[0], iso(ctx.nowMs)));
      if (!ctx.dry && rows.length) await inChunks(rows, 500, (c) => upsert("kalshi_markets", c, "ticker"));
      refreshed += rows.length;
    }
    ctx.out.results = { ended: ended.length, refreshed };
  } catch (e) {
    ctx.alert("DEGRADED", "result_refresh", "the status and result of ended markets could not be refreshed: " + msg(e));
  }
}

/* ---------------------------------------------------------------- snapshot */
async function openMarkets(series: string, ctx: Any): Promise<Any[]> {
  const out: Any[] = [];
  let cursor = "";
  for (let p = 0; p < 20; p++) {
    const page = await kalshiGet("/markets", { series_ticker: series, status: "open", mve_filter: "exclude", limit: 1000, cursor }, ctx);
    if (!page || !Array.isArray(page.markets)) throw new Error("GET /markets answered without a markets list");
    out.push(...page.markets);
    cursor = page.cursor || "";
    if (!cursor) break;
  }
  return out;
}

async function snapshot(ctx: Any) {
  const tracked = ((await db("kalshi_series?select=ticker&tracked=is.true&order=ticker")) || []).map((x: Any) => x.ticker);
  ctx.run.series_tracked = tracked.length;
  if (!tracked.length) {
    ctx.alert("WARNING", "no_tracked_series", "no Kalshi series is tracked: nothing was snapshotted (set kalshi_series.tracked = true on the game series)");
    return;
  }
  const horizonH = num(env("KALSHI_SNAPSHOT_HORIZON_HOURS")) ?? 192;
  const horizonMs = ctx.nowMs + horizonH * 3600e3;
  const at = iso(ctx.nowMs);
  let seen = 0, written = 0, beyond = 0;
  const failed: string[] = [], drift: string[] = [];
  for (const series of tracked) {
    let markets: Any[];
    try { markets = (await openMarkets(series, ctx)).filter((m: Any) => m && m.ticker && m.event_ticker); }
    catch (e) { failed.push(series + ": " + msg(e)); continue; }
    seen += markets.length;
    if (!markets.length) continue;
    const bad = markets.filter((m: Any) => !hasPrices(m));
    if (bad.length) drift.push(series + " (" + bad.length + " of " + markets.length + ")");
    const snap = markets.filter((m: Any) => hasPrices(m) && (settlesAt(m) == null || (settlesAt(m) as number) <= horizonMs));
    beyond += markets.length - bad.length - snap.length;
    const mrows = markets.map((m: Any) => marketRow(m, series, at));
    ctx.fresh.push(...mrows);
    if (!ctx.dry) {
      await inChunks(mrows, 500, (c) => upsert("kalshi_markets", c, "ticker"));
      await inChunks(snap.map((m: Any) => snapRow(m, at, ctx.nowMs, ctx.run.run_id)), 500, (c) => insert("kalshi_price_snapshots", c));
    }
    written += snap.length;
    if (ctx.dry) (ctx.out.sample = ctx.out.sample || []).push(...snap.slice(0, 3).map((m: Any) => snapRow(m, at, ctx.nowMs, ctx.run.run_id)));
  }
  Object.assign(ctx.run, { markets_seen: seen, markets_snapshotted: written, markets_beyond_horizon: beyond, series_failed: failed.length ? failed : null });
  ctx.out.snapshot = { tracked: tracked.length, seen, written, beyond_horizon: beyond, failed, captured_at: at };
  if (failed.length && failed.length === tracked.length) {
    ctx.alert("FAILURE", "kalshi_unreachable", "every tracked series failed: " + failed.join("; ").slice(0, 400));
    return;
  }
  if (failed.length) ctx.alert("DEGRADED", "series_failed", failed.length + " of " + tracked.length + " tracked series failed: " + failed.join("; ").slice(0, 400), { failed });
  if (drift.length) ctx.alert("DRIFT", "market_shape", "markets without yes_bid_dollars / yes_ask_dollars were not snapshotted: " + drift.join(", "), { drift });
  await link(ctx);
}

/* ---------------------------------------------------------------- team identity */
let NFL_REG: Any = null, NFL_CODES: Record<string, string> | null = null;
function nflRegistry() {
  if (!NFL_REG) {
    NFL_REG = FI.buildRegistry("NFL", FI.NFL_TEAMS.map((t: Any) => ({ id: t[0], name: t[1], code: t[0], aliases: t[2] })));
    NFL_CODES = {};
    for (const t of FI.NFL_TEAMS) for (const c of [t[0]].concat(t[2].filter((a: string) => /^[A-Z]{2,4}$/.test(a)))) NFL_CODES[c] = t[0];
  }
  return NFL_REG;
}
/** "New York G" / "Los Angeles R": the city, then the club's first initial, unique among clubs */
function cityInitial(name: string): string | null {
  const m = /^(.+?)\s+([A-Z])\.?$/.exec(String(name || "").trim());
  if (!m) return null;
  const hits = FI.NFL_TEAMS.filter((t: Any) => t[1].startsWith(m[1] + " ") && t[1].slice(m[1].length + 1).startsWith(m[2]));
  return hits.length === 1 ? hits[0][0] : null;
}
/** one NFL market's club: its ticker code and its name, which must agree */
export function nflClubOf(m: Any) {
  nflRegistry();
  const code = String(m.ticker || "").slice(String(m.event_ticker || "").length + 1).toUpperCase();
  const byCode = code ? (NFL_CODES as Record<string, string>)[code] || null : null;
  const r = FI.resolveTeam(NFL_REG, m.yes_sub_title || "", []);
  let byName = r.team_id || null, nameMethod = r.team_id ? r.method : null;
  if (!byName) { byName = cityInitial(m.yes_sub_title); nameMethod = byName ? "city_initial" : null; }
  if (byCode && byName && byCode !== byName) return { club: null, reason: "team_conflict", detail: { code, byCode, name: m.yes_sub_title, byName } };
  const club = byCode || byName;
  if (!club) return { club: null, reason: "team_unresolved", detail: { code, name: m.yes_sub_title } };
  /* strong: two independent readings (the ticker's code and the name) agree */
  const strong = !!(byCode && byName);
  return { club, strong, method: byCode && byName ? "code+" + nameMethod : (byCode ? "code_only" : nameMethod + "_only") };
}
function cfbRegistry(names: string[]) {
  return FI.buildRegistry("CFB", names.map((n, i) => ({
    id: String(i), name: n,
    aliases: KALSHI_CFB_ALIASES.filter((g) => g.some((x) => FI.teamKey(x) === FI.teamKey(n))).flat().filter((x) => FI.teamKey(x) !== FI.teamKey(n)),
  })));
}

/** the card's game id: a research-state row of the same sport, kickoff within
    36 h of the book's, whose two teams are the book event's two teams */
export function gameIdFor(sport: string, home: string, away: string, kickoffMs: number, rows: Any[]) {
  const hits = (rows || []).filter((r: Any) => {
    if (r.sport !== sport) return false;
    const k = ms(r.kickoff_at);
    if (k == null || Math.abs(k - kickoffMs) > GAME_TOLERANCE_MS) return false;
    const reg = FI.buildRegistry(sport === "nfl" ? "NFL" : "CFB", [{ id: "H", name: r.home }, { id: "A", name: r.away }]);
    const h = FI.resolveTeam(reg, home, [r.home, r.away]), a = FI.resolveTeam(reg, away, [r.home, r.away]);
    return h.team_id && a.team_id && h.team_id !== a.team_id;
  });
  if (hits.length !== 1) return { game_id: null, reason: hits.length ? "ambiguous_game" : "no_research_game" };
  return { game_id: String(hits[0].game_id), game_key: hits[0].game_key || sport + "|" + hits[0].game_id, method: "teams+kickoff_36h" };
}

/** one Kalshi event -> its links, or the reason it stays unmapped */
export function matchEvent(sport: string, markets: Any[], books: Any[], research: Any[]) {
  const ev = markets[0].event_ticker;
  if (markets.length !== 2 || new Set(markets.map((m: Any) => m.ticker)).size !== 2) return { reason: "not_two_teams", detail: { markets: markets.length } };
  const tDate = tickerDate(ev);
  const ends = markets.map((m: Any) => ms(m.expected_expiration_time)).filter((x: Any) => x != null) as number[];
  const endMs = ends.length ? Math.max(...ends) : null;
  /* each market's team, and how each book name reads against it */
  let sideOf: (book: Any) => Any;
  let teamMeta: Any;
  if (sport === "nfl") {
    const clubs = markets.map(nflClubOf);
    const bad = clubs.find((c: Any) => !c.club);
    if (bad) return { reason: bad.reason, detail: bad.detail };
    if (clubs[0].club === clubs[1].club) return { reason: "same_team_twice", detail: { club: clubs[0].club } };
    teamMeta = { strong: clubs.every((c: Any) => c.strong), methods: clubs.map((c: Any) => c.method), clubs: clubs.map((c: Any) => c.club) };
    sideOf = (b: Any) => {
      const h = FI.resolveTeam(NFL_REG, b.home, []), a = FI.resolveTeam(NFL_REG, b.away, []);
      const i = teamMeta.clubs.indexOf(h.team_id), j = teamMeta.clubs.indexOf(a.team_id);
      return i >= 0 && j >= 0 && i !== j ? { home: i, away: j, methods: [h.method, a.method] } : null;
    };
  } else {
    const names = markets.map((m: Any) => String(m.yes_sub_title || "").trim());
    if (names.some((n: string) => !n)) return { reason: "team_unnamed" };
    if (FI.teamKey(names[0]) === FI.teamKey(names[1])) return { reason: "same_team_twice", detail: { names } };
    const reg = cfbRegistry(names);
    teamMeta = { names };
    sideOf = (b: Any) => {
      const uni = [b.home, b.away];
      const h = FI.resolveTeam(reg, b.home, uni), a = FI.resolveTeam(reg, b.away, uni);
      return h.team_id != null && a.team_id != null && h.team_id !== a.team_id ? { home: Number(h.team_id), away: Number(a.team_id), methods: [h.method, a.method] } : null;
    };
  }
  const sameTeams: Any[] = [];
  for (const b of books) {
    const s = sideOf(b);
    if (!s) continue;
    const onDate = !!tDate && etDate(b.kickoff_ms) === tDate;
    const onEnd = endMs != null && endMs >= b.kickoff_ms && endMs - b.kickoff_ms <= EXPECTED_END_MAX_MS;
    sameTeams.push({ b, s, onDate, onEnd });
  }
  const cands = sameTeams.filter((c: Any) => c.onDate || c.onEnd);
  if (!cands.length) return { reason: sameTeams.length ? "date_mismatch" : "no_book_event", detail: { ticker_date: tDate, expected_end: endMs == null ? null : iso(endMs), same_teams: sameTeams.map((c: Any) => ({ event_id: c.b.event_id, kickoff: iso(c.b.kickoff_ms) })) } };
  if (cands.length > 1) return { reason: "ambiguous_book_event", detail: { events: cands.map((c: Any) => c.b.event_id) } };
  const { b, s, onDate, onEnd } = cands[0];
  /* market i's team is the book's home when s.home === i */
  const bookName = (i: number) => (s.home === i ? b.home : b.away);
  const sigs = [0, 1].map((i) => b.sel[bookName(i)] || null);
  if (sigs.some((x) => !x)) return { reason: "no_book_moneyline", detail: { event_id: b.event_id } };
  const strongTeams = sport === "nfl" ? teamMeta.strong : true;
  const strongBook = s.methods.every((x: string) => x === "name" || x === "mascot");
  const confidence = strongTeams && strongBook && onDate && onEnd ? "high" : "medium";
  const dates = [onDate ? "ticker_date" : null, onEnd ? "expected_end" : null].filter(Boolean).join("+");
  const method = "teams:" + (sport === "nfl" ? teamMeta.methods.join("|") : "name") + ";book:" + s.methods.join("|") + ";date:" + dates;
  const game = gameIdFor(sport, b.home, b.away, b.kickoff_ms, research);
  const detail = { ticker_date: tDate, book_et_date: etDate(b.kickoff_ms), expected_end: endMs == null ? null : iso(endMs), date_signals: dates,
    kalshi_names: markets.map((m: Any) => m.yes_sub_title), book_names: [b.home, b.away], book_methods: s.methods,
    team_methods: sport === "nfl" ? teamMeta.methods : null, game: game.game_id ? null : game.reason };
  const links = markets.map((m: Any, i: number) => ({
    market_ticker: m.ticker, event_ticker: m.event_ticker, series_ticker: m.series_ticker, sport,
    kalshi_yes_name: m.yes_sub_title ?? null, yes_team: bookName(i), opponent: bookName(1 - i),
    home_team: b.home, away_team: b.away, kickoff_at: iso(b.kickoff_ms),
    odds_event_id: b.event_id, odds_sport_key: b.sport_key, odds_sig_key: sigs[i],
    game_id: game.game_id, game_key: game.game_id ? game.game_key : null, game_method: game.game_id ? game.method : null,
    game_linked_at: null as string | null,
    match_confidence: confidence, match_method: method, match_detail: detail, linker_version: LINKER_VERSION,
  }));
  return { links };
}

/* ---------------------------------------------------------------- the links */
async function link(ctx: Any) {
  const ls = (await db("kalshi_link_series?select=series_ticker,sport")) || [];
  if (!ls.length) return;
  const sportOf: Record<string, string> = {};
  for (const x of ls) sportOf[x.series_ticker] = x.sport;
  const lo = ctx.nowMs - 2 * 864e5, hi = ctx.nowMs + 16 * 864e5;
  /* the stored open game markets, overlaid with what this run just read (a dry run stores nothing) */
  const byTicker: Record<string, Any> = {};
  for (const m of await dbAll("kalshi_markets?select=ticker,event_ticker,series_ticker,yes_sub_title,expected_expiration_time,close_time,status"
    + "&series_ticker=in." + inList(Object.keys(sportOf)) + "&status=in.(active,open)&order=ticker")) byTicker[m.ticker] = m;
  for (const m of ctx.fresh || []) if (sportOf[m.series_ticker]) byTicker[m.ticker] = m;
  const markets = Object.values(byTicker)
    .filter((m: Any) => (m.status === "active" || m.status === "open") && (() => { const t = settlesAt(m); return t == null || (t >= lo && t <= hi); })());
  const existing = (await dbAll("kalshi_game_links?select=market_ticker,sport,home_team,away_team,kickoff_at,game_id&kickoff_at=gte." + encodeURIComponent(iso(lo)) + "&order=market_ticker"));
  const linked = new Set(existing.map((x: Any) => x.market_ticker));
  const byEvent: Record<string, Any[]> = {};
  for (const m of markets) (byEvent[m.event_ticker] = byEvent[m.event_ticker] || []).push(m);
  const pending = Object.values(byEvent).filter((g: Any[]) => !g.some((m: Any) => linked.has(m.ticker)));
  const partial = Object.values(byEvent).filter((g: Any[]) => g.some((m: Any) => linked.has(m.ticker)) && g.some((m: Any) => !linked.has(m.ticker)));
  const fills = existing.filter((x: Any) => !x.game_id && ms(x.kickoff_at) != null && (ms(x.kickoff_at) as number) > ctx.nowMs - 864e5);
  const unmapped: Any[] = partial.map((g: Any[]) => ({ event_ticker: g[0].event_ticker, reason: "partially_linked", markets: g.filter((m: Any) => !linked.has(m.ticker)).length, settles: settlesAt(g[0]) }));
  let linksNew = 0, filled = 0;
  if (pending.length || fills.length) {
    /* the book's events: its h2h rows (2 per event) */
    let books: Any[] | null = null;
    try {
      const rows = await dbAll("signals?select=sig_key,event_id,sport_key,selection,home_team,away_team,commence_time&market=eq.h2h"
        + "&sport_key=in.(" + Object.values(BOOK_SPORT).join(",") + ")&commence_time=gte." + encodeURIComponent(iso(lo)) + "&commence_time=lte." + encodeURIComponent(iso(hi)) + "&order=event_id");
      const ev: Record<string, Any> = {};
      for (const r of rows) {
        const k = ms(r.commence_time);
        if (!r.event_id || k == null || !r.home_team || !r.away_team) continue;
        const e = ev[r.event_id] = ev[r.event_id] || { event_id: r.event_id, sport_key: r.sport_key, home: r.home_team, away: r.away_team, kickoff_ms: k, sel: {} };
        if (r.selection && !e.sel[r.selection]) e.sel[r.selection] = r.sig_key;
      }
      books = Object.values(ev);
    } catch (e) {
      ctx.alert("DEGRADED", "book_events_unreadable", "the book's events (public.signals) could not be read: no game was linked this run (" + msg(e) + ")");
    }
    /* the card's game ids */
    let research: Any[] = [];
    try {
      research = await dbAll("game_research_state?select=game_key,sport,game_id,home,away,kickoff_at&sport=in.(nfl,cfb)"
        + "&kickoff_at=gte." + encodeURIComponent(iso(lo - GAME_TOLERANCE_MS)) + "&kickoff_at=lte." + encodeURIComponent(iso(hi + GAME_TOLERANCE_MS)) + "&order=game_key");
    } catch (e) {
      ctx.alert("WARNING", "research_state_unreadable", "public.game_research_state could not be read: links are made without the card's game id, which a later run fills (" + msg(e) + ")");
    }
    if (books) {
      const out: Any[] = [];
      for (const g of pending) {
        const sport = sportOf[g[0].series_ticker];
        const r = matchEvent(sport, g, books.filter((b: Any) => b.sport_key === BOOK_SPORT[sport]), research);
        if (r.links) out.push(...r.links.map((l: Any) => Object.assign(l, { run_id: ctx.run.run_id, game_linked_at: l.game_id ? iso(ctx.nowMs) : null })));
        else unmapped.push({ event_ticker: g[0].event_ticker, reason: r.reason, detail: r.detail ?? null, markets: g.length, settles: settlesAt(g[0]) });
      }
      if (!ctx.dry && out.length) await inChunks(out, 200, (c) => insertOnce("kalshi_game_links", c, "market_ticker"));
      linksNew = out.length;
      ctx.out.links = out.map((l: Any) => ({ market: l.market_ticker, yes_team: l.yes_team, event: l.odds_event_id, game_id: l.game_id, confidence: l.match_confidence, method: l.match_method }));
      /* a game id that had not resolved when the link was made */
      for (const x of fills) {
        const gid = gameIdFor(x.sport, x.home_team, x.away_team, ms(x.kickoff_at) as number, research);
        if (!gid.game_id) continue;
        if (!ctx.dry) await db("kalshi_game_links?market_ticker=eq." + encodeURIComponent(x.market_ticker) + "&game_id=is.null", {
          method: "PATCH", headers: { prefer: "return=minimal" },
          body: JSON.stringify({ game_id: gid.game_id, game_key: gid.game_key, game_method: gid.method, game_linked_at: iso(ctx.nowMs) }) });
        filled++;
      }
    } else {
      for (const g of pending) unmapped.push({ event_ticker: g[0].event_ticker, reason: "book_events_unreadable", markets: g.length, settles: settlesAt(g[0]) });
    }
  }
  const unmappedMarkets = unmapped.reduce((n: number, u: Any) => n + (u.markets || 0), 0);
  Object.assign(ctx.run, { links_new: linksNew, game_ids_filled: filled, unmapped_markets: unmappedMarkets });
  ctx.details.unmapped = unmapped.slice(0, 40).map((u: Any) => ({ event_ticker: u.event_ticker, reason: u.reason, detail: u.detail }));
  ctx.out.unmapped = ctx.details.unmapped;
  /* game markets settling soon that could not be matched: a warning, at most hourly */
  const soon = unmapped.filter((u: Any) => u.settles != null && u.settles - ctx.nowMs <= UNMAPPED_WINDOW_MS);
  if (soon.length && !ctx.dry) {
    const recent = (await db("kalshi_alerts?select=id&code=eq.unmapped_markets&created_at=gt." + encodeURIComponent(iso(ctx.nowMs - 3600e3)) + "&limit=1")) || [];
    if (!recent.length) ctx.alert("WARNING", "unmapped_markets", soon.length + " Kalshi game event(s) settling within 30 hours could not be matched to one game: "
      + soon.slice(0, 6).map((u: Any) => u.event_ticker + " (" + u.reason + ")").join(", "), { events: soon.slice(0, 20).map((u: Any) => ({ event_ticker: u.event_ticker, reason: u.reason })) });
  }
}

/* ---------------------------------------------------------------- one run */
export async function syncOnce(opts: Any = {}) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const mode = opts.mode === "discover" ? "discover" : "snapshot";
  const dry = !!opts.dry;
  hostInUse = null;
  const run: Any = { run_id: crypto.randomUUID(), build: BUILD, trigger: opts.trigger || "manual", mode, status: "ok", started_at: iso(nowMs) };
  const alerts: Any[] = [];
  const ctx: Any = { run, dry, nowMs, out: {}, details: {}, host: null, fresh: [],
    alert: (severity: string, code: string, message: string, detail?: Any) => alerts.push({ severity, code, message, detail: detail ?? null }) };
  const out: Any = { ok: true, build: BUILD, run_id: run.run_id, mode, dry };
  try {
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this function");
    if (!FI) throw new Error("the inlined football identity did not load");
    if (mode === "discover") await discover(ctx); else await snapshot(ctx);
    if (alerts.some((a) => a.severity === "FAILURE")) run.status = "error";
    else if (alerts.some((a) => a.severity === "DEGRADED" || a.severity === "DRIFT" || a.code === "no_tracked_series")) run.status = "warn";
  } catch (e) {
    run.status = "error";
    run.message = mode + " error: " + msg(e);
    ctx.alert("FAILURE", mode + "_error", run.message);
  } finally {
    run.finished_at = iso(Math.max(Date.now(), nowMs));
    if (!run.message) run.message = alerts.filter((a) => a.severity !== "WARNING").map((a) => a.message).join("; ").slice(0, 600) || null;
    run.details = Object.assign({}, ctx.details, { host: ctx.host, alerts: alerts.map((a) => a.code) });
    Object.assign(out, ctx.out, { status: run.status, alerts, ok: run.status !== "error" });
    if (!dry) {
      try {
        await insert("kalshi_sync_runs", [run]);
        if (alerts.length) await insert("kalshi_alerts", alerts.map((a) => Object.assign({ run_id: run.run_id }, a)));
      } catch (e) { out.ok = false; out.record_error = msg(e); }
    }
    console.log("KALSHI_SYNC", JSON.stringify({ run_id: run.run_id, mode, status: run.status, host: ctx.host, seen: run.markets_seen ?? null, snapshotted: run.markets_snapshotted ?? null,
      links_new: run.links_new ?? null, unmapped: run.unmapped_markets ?? null, alerts: alerts.map((a) => a.severity + ":" + a.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, linker: LINKER_VERSION });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("KALSHI_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "KALSHI_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const mode = String(body.mode || new URL(req.url).searchParams.get("mode") || "snapshot");
  if (mode !== "discover" && mode !== "snapshot") return Response.json({ ok: false, error: "mode must be discover or snapshot" }, { status: 400 });
  const dry = !!body.dry;
  const out = await syncOnce({ mode, dry, now: dry ? body.now : undefined, trigger: body.source === "supabase_cron" ? "cron" : "manual" });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as Any).Deno !== "undefined" && (globalThis as Any).Deno.serve) (globalThis as Any).Deno.serve(handle);
