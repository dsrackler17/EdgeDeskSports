// @ts-nocheck — plain JavaScript cores (lib/*.js) inlined in a .ts file, as kalshi_sync inlines its identity.
// ============================================================
//  FILE:    supabase/functions/novig_sync/index.ts
//  TYPE:    Edge Function — Novig exchange market data (T0, provider Novig),
//           matched to the book's own games and compared with DraftKings
//  DEPLOY:  supabase functions deploy novig_sync --no-verify-jwt
//           .github/workflows/deploy-novig.yml does it, tests first
//  CRON:    supabase/novig_market_data_cron.sql — probe daily, discover
//           hourly, snapshot every 5 minutes
//  SQL:     supabase/novig_market_data.sql
//  DOCS:    docs/novig/README.md
// ============================================================
// READ-ONLY. This function signs GET requests to Novig's catalog, plus the
// harmless POST /v3/echo in a probe. It never calls an order, cancel,
// subaccount, transfer or key route; tools/novig/novig_sync.test.js fails if
// one appears in this file.
//
// CREDENTIALS (Edge Function secrets; docs/novig/README.md §Credentials):
//   NOVIG_ENV               production | paper — the environment the key was
//                           made in. Required: the host is chosen from it and
//                           every row is stamped with it. Never guessed.
//   NOVIG_READ_KEY_ID       a management::read key (POST /v3/keys), REST only
//   NOVIG_READ_PRIVATE_KEY  its PKCS#8 private key (PEM, "\n"-flattened PEM or
//                           the bare base64 body). Imported once into a
//                           non-extractable CryptoKey; never logged, returned
//                           or stored.
// The management key (NOVIG_MANAGEMENT_*) is NEVER read here: a process that
// polls every five minutes holds the least privilege that works. The
// streaming credential (NOVIG_STREAM_*) belongs to the stream worker only.
//
// SWITCHES: NOVIG_INGEST_ENABLED=true runs discover and snapshot (default:
// off — every call records one 'skipped' run an hour and reads nothing).
// A probe runs whenever credentials are set. Public display is a database
// switch (novig_config.public_display), not this function's.
//
// MODES (POST body {"mode": ...}):
//   probe     GET /v3/time (the clock), GET /v3/exchange/status, POST /v3/echo
//             (proves host, key, clock and canonical string at once),
//             GET /v3/limits (the throttle), GET /v3/account/geolocation
//             (the key holder's standing), GET /v3/keys (this key's scope:
//             a full management key is flagged as over-privileged)
//   discover  per tracked league: events, participants, game-line markets
//             (MONEY/SPREAD/TOTAL and the first-half twins) and consensus
//             lines; upserted; markets that left the open catalog closed out;
//             then the links (lib/novig_market_map.js) against public.signals,
//             existing links re-verified (a link that no longer holds is
//             invalidated with its reason), and the unmapped queue
//   snapshot  the order books of linked markets a DraftKings line can be
//             compared with (the moneyline; spreads and totals at a line
//             DraftKings has quoted in the last day, or Novig's consensus
//             line), each when DUE (5 / 10 / 30 min by time to kickoff); an
//             unchanged book (304 or the same seq) is CONFIRMED, not stored
//             again; a changed one is stored with its top of book, the fills
//             of the standard stakes (lib/edgedesk_venue_compare.js) and its
//             depth
//
// ERRORS, as Novig documents them (docs.novig.com/api/errors.md):
//   401  a timestamp complaint resyncs the clock and retries once; anything
//        else is an auth FAILURE and halts runs for an hour
//   403  JSON SCOPE_INSUFFICIENT: FAILURE, halt 6 h. HTML (the edge): the
//        request never reached Novig; DEGRADED, halt 15 min
//   404  the market is gone: closed out, not retried
//   423  locked (SYSTEM_LOCKED, ACCOUNT_LOCKED…): FAILURE, halt 6 h
//   429  wait Retry-After (≤ 10 s, with jitter) and retry twice; longer is a
//        DEGRADED stop
//   451  geolocation: FAILURE and STOP — never retried (Novig: a client that
//        keeps retrying a 451 can get the account locked); halt 2 h for a
//        network code, 6 h for a device code. Never routed around.
//   5xx, timeouts, network: three tries with exponential backoff and jitter
// A halt is written on the run (novig_sync_runs.halt_until); every later run
// skips until it passes.
//
// AUTH. pg_cron sends the Vault secret novig_cron_secret as x-cron-secret;
// it must equal NOVIG_CRON_SECRET. A GET is a public health probe (BUILD and
// which switches are on — never a key id).
//
// POST body (all optional): mode probe | discover | snapshot (default
// snapshot); dry (read and compute, write nothing); now (ISO, dry runs only).
//
// ENV (optional): NOVIG_LEAGUES (default NFL,NCAAF,NBA,NHL,NCAAB,MLB,WNBA,NCAABSB),
//   NOVIG_HORIZON_HOURS (default 96), NOVIG_BOOK_DEPTH (default 10),
//   NOVIG_MAX_BOOKS_PER_RUN (default 240), NOVIG_CONCURRENCY (default 4),
//   NOVIG_RUN_BUDGET_MS (default 110000)
// ============================================================

export const BUILD = "novig_sync@2026-10-30.1";
const UA = "edgedesk-research/1.0 (+https://edgedesksports.com)";
const GAME_TYPES = "MONEY,SPREAD,TOTAL,MONEY_1H,SPREAD_1H,TOTAL_1H";
const LIVE_STATUSES = "OPEN_PREGAME,OPEN_INGAME,DELAYED";
/* the snapshot cadence, public.novig_rule() snapshot_* (tools/novig/novig_sync.test.js checks they agree) */
export const CADENCE = { near_minutes: 5, mid_minutes: 10, far_minutes: 30 };
const NETWORK_451 = ["ANONYMIZED_NETWORK", "RESTRICTED_NETWORK_REGION"];

// ── BEGIN NOVIG CORE ── lib/football_identity.js, lib/novig_signing.js, lib/edgedesk_venue_compare.js, lib/novig_market_map.js, copied by tools/novig/inline.js; do not edit here
// ---- lib/football_identity.js
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
// ---- lib/novig_signing.js
/* ===========================================================================
   EdgeDesk — NOVIG-V3 REQUEST SIGNING (server side only).

   Novig signs every v3 request, GET included, with three headers:
     Novig-Key-Id      the key's UUID (not a secret)
     Novig-Timestamp   Unix milliseconds, unpadded decimal, within ±30 s of
                       Novig's clock (GET /v3/time)
     Novig-Signature   standard padded base64 of the raw signature bytes
   over a six-line string (https://docs.novig.com/api/signing.md):
     NOVIG-V3 \n {unix_millis} \n {METHOD} \n {path} \n {canonical_query} \n
     {lowercase_hex(sha256(raw_body))}
   joined by LF, no trailing newline. Ed25519 signs the string itself (64
   bytes); P-256 is ECDSA prime256v1 + SHA-256, DER-encoded SEQUENCE { r, s }.
   WebCrypto returns ECDSA as raw r‖s, which never verifies, so it is
   converted to DER here.

   Tested against all 30 of Novig's published vectors
   (tools/novig/fixtures/signing-vectors.public.json, tools/novig/signing.test.js).

   WHY NO PACKAGE. Every script here runs on a bare Node install (AGENTS.md
   §2), and the edge runtime is Deno: both ship WebCrypto with Ed25519 and
   ECDSA P-256 and SHA-256, which is all this needs. No hand-rolled
   cryptography: the primitives are the runtime's; this file only builds the
   string Novig specifies and moves bytes between encodings.

   SECRETS. The private key is read once into a non-extractable CryptoKey.
   No function here logs, returns or embeds key material, the string to sign
   or the signature in an error message; errors name the problem only.

   Usable in Node (require), Deno (inlined into supabase/functions/novig_*
   by tools/novig/inline.js, drift-tested) and a browser (window.NovigSigning,
   never given a key: nothing in the browser signs).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NovigSigning = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SCHEME = 'NOVIG-V3';
  var MAX_SKEW_MS = 30000;
  var EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  var HOSTS = { production: 'https://api.novig.com', paper: 'https://api.paper.novig.com' };

  function subtle() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error('NOVIG-V3: WebCrypto (crypto.subtle) is not available in this runtime');
    return c.subtle;
  }
  var enc = new TextEncoder();
  function utf8(s) { return enc.encode(String(s)); }
  function toBytes(body) {
    if (body === null || body === undefined || body === '') return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return utf8(body);
  }
  function hex(bytes) {
    var b = new Uint8Array(bytes), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function b64(bytes) {
    var b = new Uint8Array(bytes), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function unb64(s) {
    var t = atob(String(s).replace(/[\s]/g, '')), out = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------------ the canonical query
     1 split on '&'; 2 split each pair at the FIRST '=' (no '=' -> empty value);
     3 decode only %XX, as UTF-8 bytes (a bare '+' stays '+'); 4 re-encode,
     keeping ALPHA DIGIT - . _ ~ and writing every other byte as %XX upper
     case; 5 sort by encoded name, then encoded value, keeping repeats;
     6 join with '&'. An absent query is the empty string. */
  function isHex(c) { return /^[0-9A-Fa-f]$/.test(c); }
  function decodePercent(part) {
    var raw = utf8(part), out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] === 0x25 && i + 2 < raw.length
          && isHex(String.fromCharCode(raw[i + 1])) && isHex(String.fromCharCode(raw[i + 2]))) {
        out.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
        i += 2;
      } else out.push(raw[i]);
    }
    return out;
  }
  function encodeBytes(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      var keep = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
      s += keep ? String.fromCharCode(b) : '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    }
    return s;
  }
  function canonicalPart(part) { return encodeBytes(decodePercent(part)); }
  function canonicalQuery(raw) {
    var q = raw === null || raw === undefined ? '' : String(raw);
    if (q.charAt(0) === '?') q = q.slice(1);
    if (!q) return '';
    var pairs = [];
    q.split('&').forEach(function (p) {
      if (!p) return;
      var i = p.indexOf('=');
      var name = i < 0 ? p : p.slice(0, i), value = i < 0 ? '' : p.slice(i + 1);
      pairs.push([canonicalPart(name), canonicalPart(value)]);
    });
    /* encoded parts are ASCII, so code-unit order is byte order */
    pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    return pairs.map(function (x) { return x[0] + '=' + x[1]; }).join('&');
  }
  /* a query string to SEND: every value encoded the same way, so the bytes
     on the wire canonicalize to themselves */
  function buildQuery(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { parts.push(encodeBytes(utf8(k)) + '=' + encodeBytes(utf8(String(x)))); });
    });
    return parts.join('&');
  }

  async function sha256Hex(body) {
    var bytes = toBytes(body);
    if (!bytes.length) return EMPTY_SHA256;
    return hex(await subtle().digest('SHA-256', bytes));
  }

  function validateTimestamp(ts) {
    var s = String(ts);
    if (!/^[1-9][0-9]*$/.test(s)) throw new Error('NOVIG-V3: the timestamp must be unpadded decimal Unix milliseconds');
    return s;
  }
  function validatePath(path) {
    var p = String(path || '');
    if (p.charAt(0) !== '/' || /^\/\//.test(p) || /[?#]/.test(p) || /^[a-z]+:/i.test(p)) throw new Error('NOVIG-V3: sign the path only (leading /, no host, no query)');
    return p;
  }

  /** the six lines, joined by LF, no trailing newline */
  async function stringToSign(o) {
    var lines = [SCHEME, validateTimestamp(o.timestamp), String(o.method || '').toUpperCase(), validatePath(o.path),
      canonicalQuery(o.query), o.bodyHash || await sha256Hex(o.body)];
    if (!/^[A-Z]+$/.test(lines[2])) throw new Error('NOVIG-V3: the method must be ASCII letters');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ keys
     A PKCS#8 PEM, as Novig's Profile screen and `openssl genpkey` write it.
     Secrets stores often flatten newlines to a literal "\n", or keep only the
     base64 body: both are accepted. The algorithm is read from the key's own
     OID, never from configuration, so a key cannot be used as the other kind. */
  var OID_ED25519 = [0x06, 0x03, 0x2b, 0x65, 0x70];
  var OID_EC = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  var OID_P256 = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  function hasSeq(bytes, seq) {
    outer: for (var i = 0; i + seq.length <= bytes.length; i++) {
      for (var j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
      return true;
    }
    return false;
  }
  function pemBody(pem, label) {
    var t = String(pem === null || pem === undefined ? '' : pem).replace(/\\n/g, '\n').replace(/\r/g, '').trim();
    if (!t) throw new Error('NOVIG-V3: no ' + label + ' was given');
    if (/-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )PRIVATE KEY-----/.test(t)) throw new Error('NOVIG-V3: the ' + label + ' must be an unencrypted PKCS#8 PEM ("BEGIN PRIVATE KEY"), Ed25519 or P-256');
    var m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(t);
    var body = m ? m[2] : t;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) throw new Error('NOVIG-V3: the ' + label + ' is not PEM or base64');
    return { kind: m ? m[1] : null, der: unb64(body) };
  }
  function algorithmOfDer(der) {
    if (hasSeq(der, OID_ED25519)) return 'Ed25519';
    if (hasSeq(der, OID_EC) && hasSeq(der, OID_P256)) return 'P-256';
    return null;
  }
  async function importPrivateKey(pem) {
    var p = pemBody(pem, 'private key');
    if (p.kind && p.kind !== 'PRIVATE KEY') throw new Error('NOVIG-V3: expected a "PRIVATE KEY" PEM, got "' + p.kind + '"');
    var alg = algorithmOfDer(p.der);
    if (!alg) throw new Error('NOVIG-V3: the private key is neither Ed25519 nor P-256 (Novig accepts only those)');
    var key;
    try {
      key = await subtle().importKey('pkcs8', p.der, alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    } catch (_) {
      throw new Error('NOVIG-V3: the ' + alg + ' private key could not be imported (not valid PKCS#8)');
    }
    return { algorithm: alg, key: key };
  }
  async function importPublicKey(pem) {
    var p = pemBody(pem, 'public key');
    if (p.kind && p.kind !== 'PUBLIC KEY') throw new Error('NOVIG-V3: expected a "PUBLIC KEY" (SPKI) PEM');
    var alg = algorithmOfDer(p.der);
    if (!alg) throw new Error('NOVIG-V3: the public key is neither Ed25519 nor P-256');
    var key = await subtle().importKey('spki', p.der, alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return { algorithm: alg, key: key, der: p.der };
  }
  /** Novig's fingerprint of a public key: sha256 of the SPKI DER ("sha256:<hex>") */
  async function spkiFingerprint(pem) {
    var p = pemBody(pem, 'public key');
    return 'sha256:' + hex(await subtle().digest('SHA-256', p.der));
  }

  /* ------------------------------------------------------------ ECDSA encodings */
  function derInt(bytes) {
    var i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    var v = Array.prototype.slice.call(bytes, i);
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length].concat(v);
  }
  /** WebCrypto's raw r‖s (64 bytes) -> DER SEQUENCE { INTEGER r, INTEGER s } */
  function p1363ToDer(sig) {
    var b = new Uint8Array(sig);
    if (b.length !== 64) throw new Error('NOVIG-V3: a P-256 raw signature is 64 bytes');
    var body = derInt(b.slice(0, 32)).concat(derInt(b.slice(32)));
    return new Uint8Array([0x30, body.length].concat(body));
  }
  /** DER -> raw r‖s, for verifying with WebCrypto */
  function derToP1363(der) {
    var b = new Uint8Array(der), i = 0;
    if (b[i++] !== 0x30) throw new Error('NOVIG-V3: not a DER signature');
    if (b[i] & 0x80) i += 1 + (b[i] & 0x7f); else i++;
    function int() {
      if (b[i++] !== 0x02) throw new Error('NOVIG-V3: not a DER integer');
      var n = b[i++], v = b.slice(i, i + n); i += n;
      while (v.length > 32 && v[0] === 0) v = v.slice(1);
      if (v.length > 32) throw new Error('NOVIG-V3: integer too long for P-256');
      var out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
    }
    var r = int(), s = int(), raw = new Uint8Array(64);
    raw.set(r, 0); raw.set(s, 32);
    return raw;
  }

  async function signString(s, k) {
    if (!k || !k.key || !k.algorithm) throw new Error('NOVIG-V3: no signing key');
    if (k.algorithm === 'Ed25519') return b64(await subtle().sign({ name: 'Ed25519' }, k.key, utf8(s)));
    return b64(p1363ToDer(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, utf8(s))));
  }
  async function verifyString(s, signatureB64, pub) {
    var sig = unb64(signatureB64);
    if (pub.algorithm === 'Ed25519') return subtle().verify({ name: 'Ed25519' }, pub.key, sig, utf8(s));
    return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub.key, derToP1363(sig), utf8(s));
  }

  /* ------------------------------------------------------------ one signed request
     Returns the URL, the headers and the exact body bytes to send: what is
     signed is what is sent, so the two can never disagree. `clockOffsetMs`
     is Novig's clock minus ours (from GET /v3/time). */
  async function signRequest(o) {
    if (!o || !o.keyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(o.keyId))) throw new Error('NOVIG-V3: the key id must be the key\'s UUID');
    var method = String(o.method || 'GET').toUpperCase();
    var path = validatePath(o.path);
    var query = typeof o.query === 'string' ? (o.query.charAt(0) === '?' ? o.query.slice(1) : o.query) : buildQuery(o.query);
    var bodyBytes = o.body === undefined || o.body === null ? new Uint8Array(0) : toBytes(typeof o.body === 'string' || o.body instanceof Uint8Array ? o.body : JSON.stringify(o.body));
    var ts = String(Math.round((o.nowMs === undefined ? Date.now() : o.nowMs) + (o.clockOffsetMs || 0)));
    var s = await stringToSign({ timestamp: ts, method: method, path: path, query: query, body: bodyBytes });
    var headers = { 'Novig-Key-Id': String(o.keyId), 'Novig-Timestamp': ts, 'Novig-Signature': await signString(s, o.signer) };
    /* without a content type the server hashes zero bytes, not the body */
    if (bodyBytes.length) headers['Content-Type'] = 'application/json';
    var base = String(o.host || '').replace(/\/$/, '');
    return { url: base + path + (query ? '?' + query : ''), method: method, headers: headers, body: bodyBytes.length ? bodyBytes : undefined, timestamp: ts };
  }

  /** a header set safe to log: the signature and key id never are */
  function redactHeaders(h) {
    var out = {};
    Object.keys(h || {}).forEach(function (k) {
      out[k] = /signature|key-id|authorization|apikey|secret|token/i.test(k) ? '[redacted]' : h[k];
    });
    return out;
  }

  /* ------------------------------------------------------------ the clock
     offset = Novig's clock minus ours, corrected by half the round trip. */
  function clockOffset(localBeforeMs, localAfterMs, serverTs) {
    var mid = (localBeforeMs + localAfterMs) / 2;
    return Math.round(Number(serverTs) - mid);
  }
  function skewState(offsetMs) {
    var a = Math.abs(offsetMs);
    return a > MAX_SKEW_MS ? 'outside_window' : a > MAX_SKEW_MS / 3 ? 'drifting' : 'ok';
  }

  function hostFor(environment) {
    if (!Object.prototype.hasOwnProperty.call(HOSTS, environment)) throw new Error('NOVIG-V3: the environment must be production or paper');
    return HOSTS[environment];
  }

  return {
    SCHEME: SCHEME, MAX_SKEW_MS: MAX_SKEW_MS, EMPTY_SHA256: EMPTY_SHA256, HOSTS: HOSTS,
    canonicalQuery: canonicalQuery, buildQuery: buildQuery, sha256Hex: sha256Hex, stringToSign: stringToSign,
    importPrivateKey: importPrivateKey, importPublicKey: importPublicKey, spkiFingerprint: spkiFingerprint,
    algorithmOfDer: algorithmOfDer, p1363ToDer: p1363ToDer, derToP1363: derToP1363,
    signString: signString, verifyString: verifyString, signRequest: signRequest, redactHeaders: redactHeaders,
    clockOffset: clockOffset, skewState: skewState, hostFor: hostFor,
  };
});
// ---- lib/edgedesk_venue_compare.js
/* ===========================================================================
   EdgeDesk VENUE COMPARISON — what a line actually costs at each venue.

   A sportsbook quote and an exchange order book are different objects. A
   book's price is one number for any stake it accepts. An exchange's
   displayed best price is only the first level of a ladder: a larger stake
   walks down it, and a stake the ladder cannot hold is not fillable at all.
   This module turns both into the same comparable thing — what a stake of $S
   costs, what it pays on a win, and what that implies — and never pretends
   a price is better than it is.

   ONE FILE, EVERY HOST. The browser (window.EDVENUE), Node (require) and the
   novig_sync edge function (inlined by tools/novig/inline.js, drift-tested)
   run this exact code, so a card, a snapshot and a research report cannot
   disagree about one price.

   NOVIG'S UNITS (docs.novig.com/api/concepts/money.md, fees.md; read
   2026-10-30). Everything money-shaped is exact integer arithmetic here:
     price      a decimal string, three places at most ("0.665", "0.62"),
                carried as an integer in thousandths ("milli", 0..1000)
     contract   pays full value, 1¢, if its outcome wins; quantities are whole
                contracts. 110 contracts at 0.665 cost $0.73150, pay $1.10000
     ledger     $0.00001 ("u" below): 1 contract at m milli costs m u, pays
                1000 u
     ask        every resting order is a bid. A bid at p on one outcome is
                liquidity for the OTHER outcome at 1 − p, with the bid's qty
     fee        taker only: c · P(1 − P) · N · 1¢ per fill, at the fill's
                price, rounded half up to the $0.00001, no minimum. Read c and
                `charged` from the market. WHEN_LIVE charges only while the
                event is OPEN_INGAME (decided by Novig at match time);
                ALWAYS charges in every phase
     grid       0.001–0.050 step 0.001, 0.055–0.945 step 0.005, 0.950–0.999
                step 0.001; a price off it is refused, never snapped
   Probabilities and odds are Numbers only when they are DISPLAYED or fed to
   a probability formula; no money total is ever a binary float.

   WHAT IS NEVER CLAIMED
   - A better price is not positive expected value. EV needs an independent,
     versioned, validated model probability for exactly this market; without
     one the result says the price is better and nothing more.
   - Hold is the margin built into a COMPLETE set of mutually exclusive
     outcomes quoted together. Two sides from different snapshots, different
     lines or different books are not a market and have no hold.
   - A no-vig probability is an estimate (proportional normalisation), never
     the true probability.
   - A stale quote is history. It is shown as history and never compared as
     if it could be bet now.
   - Nothing here places, sizes or recommends an order. It simulates what a
     taker order of a given size would have cost against a recorded book.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDVENUE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'edgedesk_venue_compare_v1';

  /* THE RULES. Mirrored by public.novig_rule() in supabase/novig_market_data.sql;
     tools/novig/venue_compare.test.js fails if the two disagree. A change is a
     reviewed code change in both places. */
  var RULES = {
    novig_live_seconds: 90,        /* a streamed book this fresh may be called Live */
    novig_recent_minutes: 10,      /* a REST snapshot this fresh is Recently updated; older is Stale */
    book_live_minutes: 10,         /* a sportsbook read this fresh may be called Live */
    book_recent_minutes: 90,       /* EDINTEL's quote_ttl_min: a sportsbook quote older than this is Stale */
    pair_max_gap_minutes: 10,      /* two venues' observations further apart are not a simultaneous comparison */
    tie_pp: 0.10,                  /* implied-probability difference below this (percentage points) is a tie */
    model_max_age_hours: 36        /* a model probability older than this is not current */
  };
  var STAKES = [25, 50, 100, 250, 500];

  var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B10 = BigInt(10), B1000 = BigInt(1000);
  function isInt(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function pow10(k) { var r = B1; for (var i = 0; i < k; i++) r *= B10; return r; }

  /* ------------------------------------------------------------ prices */
  /** "0.665" -> 665; "0.62" -> 620; "1" -> 1000. More than three places, a
      sign, an exponent or a value outside [0, 1] is refused (null). */
  function milli(price) {
    if (price === null || price === undefined) return null;
    var s = typeof price === 'number' ? (isFinite(price) ? String(price) : '') : String(price).trim();
    var m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(s);
    if (!m) return null;
    var whole = parseInt(m[1], 10), frac = (m[2] || '').padEnd(3, '0');
    var v = whole * 1000 + parseInt(frac || '0', 10);
    return v >= 0 && v <= 1000 ? v : null;
  }
  function milliStr(m) { return m == null ? null : (m / 1000).toFixed(3); }
  /** Novig's submittable grid (money.md): 279 prices in three bands */
  function onGrid(m) {
    if (!isInt(m)) return false;
    if (m >= 1 && m <= 50) return true;
    if (m >= 950 && m <= 999) return true;
    return m >= 55 && m <= 945 && m % 5 === 0;
  }
  /** a decimal coefficient string ("0.06") as an exact fraction {n, d} */
  function fraction(s) {
    var m = /^(\d+)(?:\.(\d+))?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var frac = m[2] || '';
    return { n: BigInt(m[1] + frac), d: pow10(frac.length) };
  }
  /** round a non-negative rational n/d half up to an integer */
  function roundHalfUp(n, d) { return (n * B2 + d) / (d * B2); }

  /* ------------------------------------------------------------ money in u ($0.00001) */
  function uToDollars(u) {
    if (u == null) return null;
    var b = typeof u === 'bigint' ? u : BigInt(u);
    var neg = b < B0; if (neg) b = -b;
    var s = b.toString().padStart(6, '0');
    return (neg ? '-' : '') + s.slice(0, -5) + '.' + s.slice(-5);
  }
  function dollarsToU(d) {
    var m = /^(-)?(\d+)(?:\.(\d{0,5}))?$/.exec(String(d == null ? '' : d).trim());
    if (!m) return null;
    var v = BigInt(m[2]) * BigInt(100000) + BigInt((m[3] || '').padEnd(5, '0') || '0');
    return m[1] ? -v : v;
  }
  function uNum(u) { return u == null ? null : Number(u) / 100000; }

  /** Novig's taker fee for one fill of n contracts at m milli, in u, rounded
      half up: c · P(1−P) · N · 1¢ = c · m · (1000 − m) · n / 1000 u */
  function takerFeeU(m, n, coefficient) {
    var c = fraction(coefficient);
    if (!c || !isInt(m) || !isInt(n) || n < 0) return null;
    var num = c.n * BigInt(m) * BigInt(1000 - m) * BigInt(n);
    return roundHalfUp(num, c.d * B1000);
  }
  /** is the taker fee charged now? (fees.md: WHEN_LIVE only while OPEN_INGAME) */
  function feeCharged(fee, eventStatus) {
    if (!fee || !fee.charged) return { charged: null, why: 'the market carried no fee schedule' };
    if (fee.charged === 'ALWAYS') return { charged: true, why: 'this market charges the taker in every phase (ALWAYS)' };
    if (fee.charged === 'WHEN_LIVE') {
      if (eventStatus === 'OPEN_INGAME') return { charged: true, why: 'the event is in play (OPEN_INGAME): WHEN_LIVE markets charge the taker' };
      return { charged: false, why: 'pregame: a WHEN_LIVE market charges no taker fee until the event goes live (Novig decides liveness at match time)' };
    }
    return { charged: null, why: 'unknown fee schedule ' + String(fee.charged) };
  }

  /* ------------------------------------------------------------ the book
     A Novig book (REST /v3/catalog/markets/{id}/book, or the websocket book
     channel) lists resting BIDS by outcome, best first. The ladder to BUY
     outcome X is the other outcome's bids, each at 1 − bid. Levels may be
     [price, qty] pairs or Novig's own {price, qty} order objects; equal
     prices are aggregated (each order kept, for per-fill fee rounding). */
  function levelsOf(list) {
    var byPrice = {}, out = [];
    (list || []).forEach(function (o) {
      var p = Array.isArray(o) ? o[0] : o && o.price, q = Array.isArray(o) ? o[1] : o && o.qty;
      var m = milli(p), n = Number(q);
      if (m == null || !isInt(n) || n <= 0) return;
      if (!byPrice[m]) { byPrice[m] = { m: m, qty: 0, fills: [] }; out.push(byPrice[m]); }
      byPrice[m].qty += n;
      /* a pre-aggregated level carries its order sizes in [2] */
      if (Array.isArray(o) && Array.isArray(o[2])) byPrice[m].fills.push.apply(byPrice[m].fills, o[2].map(Number));
      else byPrice[m].fills.push(n);
    });
    out.sort(function (a, b) { return b.m - a.m; });   /* best bid = highest first */
    return out;
  }
  /** the ladder to buy `outcomeId` in a two-outcome market: ascending prices */
  function askLadder(book, outcomeId, outcomeIds) {
    var ids = outcomeIds || Object.keys((book && book.orders) || {});
    var others = ids.filter(function (x) { return x !== outcomeId; });
    if (others.length !== 1) return { ok: false, reason: 'not_two_outcomes', ladder: [] };
    var bids = levelsOf(((book && book.orders) || {})[others[0]]);
    return { ok: true, against: others[0], ladder: bids.map(function (l) { return { m: 1000 - l.m, qty: l.qty, fills: l.fills }; }) };
  }
  /** aggregate depth for storage: {outcomeId: [[price, qty, [orderQty...]], ...]} best first */
  function compactDepth(book) {
    var out = {};
    Object.keys((book && book.orders) || {}).forEach(function (k) {
      out[k] = levelsOf(book.orders[k]).map(function (l) { return [milliStr(l.m), l.qty, l.fills]; });
    });
    return out;
  }

  /* ------------------------------------------------------------ odds */
  function americanToDecimal(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decimalToAmerican(d) { d = Number(d); if (!isFinite(d) || d <= 1) return null; return d >= 2 ? 100 * (d - 1) : -100 / (d - 1); }
  /** the prompt's own definitions: +A -> 100/(A+100); −A -> |A|/(|A|+100) */
  function impliedFromAmerican(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  function impliedFromDecimal(d) { d = Number(d); return isFinite(d) && d > 1 ? 1 / d : null; }
  function roundAmerican(a) { if (a == null || !isFinite(a)) return null; var r = Math.round(a); return r === -100 ? 100 : r; }
  function fmtAmerican(a) { var r = roundAmerican(a); return r == null ? '—' : (r > 0 ? '+' : '') + r; }

  /* ------------------------------------------------------------ one taker order against the ladder
     Buy as many whole contracts as the stake affords, all-in (price plus any
     taker fee), walking the ladder cheapest first. FILLED when the remainder
     is smaller than one more contract at the last price used; PARTIAL when
     the ladder ran out first (the stake is not fillable here); NO_LIQUIDITY
     when there is nothing to buy. Rounding: the fee per fill (per resting
     order) half up to $0.00001, as Novig books it. */
  function fill(ladder, stakeDollars, feeInfo) {
    var stakeU = dollarsToU(typeof stakeDollars === 'number' ? stakeDollars.toFixed(5) : stakeDollars);
    if (stakeU == null || stakeU <= B0) return { status: 'INVALID_STAKE', reason: 'the stake must be a positive dollar amount' };
    var charged = !!(feeInfo && feeInfo.charged);
    var coef = charged ? feeInfo.coefficient : null;
    if (charged && !fraction(coef)) return { status: 'FEE_UNKNOWN', reason: 'the market charges a taker fee but its coefficient is unreadable' };
    var left = stakeU, n = 0, costU = B0, feeU = B0, used = [], lastM = null, exhausted = true;
    var levels = ladder || [];
    for (var i = 0; i < levels.length; i++) {
      var L = levels[i];
      if (!isInt(L.m) || L.m <= 0 || L.m >= 1000) continue;
      var takeAtLevel = 0;
      var fills = L.fills && L.fills.length ? L.fills : [L.qty];
      for (var f = 0; f < fills.length; f++) {
        var avail = fills[f];
        /* contracts affordable at this price, fee included: m + c·m(1000−m)/1000 u each */
        var per = charged ? (function () { var c = fraction(coef); return { n: BigInt(L.m) * c.d * B1000 + c.n * BigInt(L.m) * BigInt(1000 - L.m), d: c.d * B1000 }; })() : { n: BigInt(L.m), d: B1 };
        var k = Number((left * per.d) / per.n);
        if (k > avail) k = avail;
        /* the half-up fee rounding can cost one more u: step down until it fits */
        while (k > 0) {
          var c0 = BigInt(L.m) * BigInt(k), f0 = charged ? takerFeeU(L.m, k, coef) : B0;
          if (c0 + f0 <= left) break;
          k--;
        }
        if (k <= 0) { exhausted = false; break; }
        var cost = BigInt(L.m) * BigInt(k), fee = charged ? takerFeeU(L.m, k, coef) : B0;
        costU += cost; feeU += fee; left -= cost + fee; n += k; takeAtLevel += k; lastM = L.m;
        if (k < avail) { exhausted = false; break; }
      }
      if (takeAtLevel) used.push({ price: milliStr(L.m), contracts: takeAtLevel });
      if (!exhausted) break;
    }
    var spent = costU + feeU;
    /* the ladder ran out with money left: is the remainder enough for one more contract at the last price? */
    var nextM = lastM != null ? lastM : (levels[0] && levels[0].m);
    var partial = exhausted && nextM != null && left >= BigInt(nextM);
    if (!n) return { status: 'NO_LIQUIDITY', reason: levels.length ? 'the stake cannot buy one contract at the best price' : 'no resting liquidity on the other side of the book', stake_u: stakeU.toString() };
    var payoutU = BigInt(n) * B1000;
    var out = {
      status: partial ? 'PARTIAL' : 'FILLED',
      contracts: n,
      cost: uToDollars(costU), fee: uToDollars(feeU), total: uToDollars(spent), payout: uToDollars(payoutU),
      profit_if_win: uToDollars(payoutU - spent), unspent: uToDollars(stakeU - spent),
      stake: uToDollars(stakeU), levels: used,
      vwap: (Number(costU) / n / 1000).toFixed(6),
      best_price: milliStr(levels[0].m), worst_price: milliStr(lastM),
      fee_charged: charged, fee_coefficient: charged ? String(coef) : null,
      /* what the stake actually bought, as odds */
      effective_decimal: Number(payoutU) / Number(spent),
      effective_implied: Number(spent) / Number(payoutU)
    };
    out.effective_american = decimalToAmerican(out.effective_decimal);
    out.top_decimal = 1000 / levels[0].m;
    out.top_american = decimalToAmerican(out.top_decimal);
    out.slippage_pp = (out.effective_implied - levels[0].m / 1000) * 100;
    out.top_not_achievable = n > 0 && lastM !== levels[0].m;
    if (partial) {
      out.reason = 'the book held ' + n + ' contracts (' + out.total + ' all-in); the rest of the stake (' + out.unspent + ') has no liquidity';
      out.fillable_dollars = out.total;
    }
    return out;
  }

  /** the executable quote for one outcome at a list of stakes */
  function executableQuote(book, outcomeId, outcomeIds, o) {
    o = o || {};
    var lad = askLadder(book, outcomeId, outcomeIds);
    if (!lad.ok) return { ok: false, reason: lad.reason };
    var fc = feeCharged(o.fee, o.eventStatus);
    var feeInfo = { charged: fc.charged === true, coefficient: o.fee && o.fee.coefficient };
    var top = lad.ladder[0] || null;
    var depthContracts = lad.ladder.reduce(function (s, l) { return s + l.qty; }, 0);
    var depthCostU = lad.ladder.reduce(function (s, l) { return s + BigInt(l.m) * BigInt(l.qty); }, B0);
    var stakes = (o.stakes || STAKES).map(function (s) { return Object.assign({ stake_dollars: Number(s) }, fill(lad.ladder, s, feeInfo)); });
    return {
      ok: true, outcome_id: outcomeId, against_outcome_id: lad.against,
      top: top ? { price: milliStr(top.m), contracts: top.qty, decimal: 1000 / top.m, american: decimalToAmerican(1000 / top.m), implied: top.m / 1000, on_grid: onGrid(top.m) } : null,
      depth: { levels: lad.ladder.length, contracts: depthContracts, cost_to_clear: uToDollars(depthCostU), payout_if_cleared: uToDollars(BigInt(depthContracts) * B1000) },
      fee: { charged: fc.charged, why: fc.why, coefficient: o.fee ? o.fee.coefficient || null : null, schedule: o.fee ? o.fee.charged || null : null, maker_credit: o.fee ? o.fee.makerCredit || null : null },
      stakes: stakes
    };
  }

  /* ------------------------------------------------------------ a sportsbook quote at a stake
     A fixed-odds book pays stake × decimal on a win. The decimal is the
     source's own (The Odds API's price_dec); American odds are derived. */
  function bookQuote(decimal, stakeDollars) {
    var d = Number(decimal), s = Number(stakeDollars);
    if (!(d > 1) || !(s > 0)) return { status: 'NO_PRICE' };
    var payout = s * d;
    return { status: 'FILLED', stake: s.toFixed(2), payout: payout.toFixed(2), profit_if_win: (payout - s).toFixed(2), effective_decimal: d, effective_implied: 1 / d, effective_american: decimalToAmerican(d), fee_charged: false };
  }

  /* ------------------------------------------------------------ hold and no-vig
     `outcomes` must be the COMPLETE mutually exclusive, exhaustive set of one
     market, quoted together: [{implied, label}]. Anything less returns null
     with the reason; nothing is filled in. */
  function hold(outcomes, o) {
    o = o || {};
    if (!Array.isArray(outcomes) || outcomes.length < 2) return { ok: false, reason: 'a hold needs the complete set of outcomes (at least two)' };
    if (o.expected != null && outcomes.length !== o.expected) return { ok: false, reason: 'the market has ' + o.expected + ' outcomes and ' + outcomes.length + ' were quoted' };
    if (o.sameSnapshot === false) return { ok: false, reason: 'the outcomes were not quoted in the same snapshot' };
    var p = outcomes.map(function (x) { return Number(x.implied); });
    if (p.some(function (x) { return !(x > 0 && x < 1); })) return { ok: false, reason: 'an outcome has no usable price' };
    var sum = p.reduce(function (a, b) { return a + b; }, 0);
    return { ok: true, overround: sum, hold: sum - 1, hold_pct: (sum - 1) * 100, n: p.length,
      note: 'the margin built into this complete set of prices (sum of implied probabilities minus one); not what any one bettor is certain to lose' };
  }
  /** proportional (multiplicative) normalisation; an ESTIMATE, labelled as one */
  function noVig(outcomes, o) {
    var h = hold(outcomes, o);
    if (!h.ok) return h;
    var p = outcomes.map(function (x) { return Number(x.implied); });
    return { ok: true, method: 'proportional', probabilities: p.map(function (x) { return x / h.overround; }), hold: h.hold,
      note: 'no-vig estimate by proportional normalisation of one venue\'s complete market: an estimate of the market\'s view, not a true probability' };
  }

  /* ------------------------------------------------------------ expected value
     EV per $1 staked = p · net_win_per_dollar − (1 − p − p_push).
     A push returns the stake (0). The probability must come from a model the
     caller has checked with modelGate(); this function does arithmetic only. */
  function evPerDollar(p, netWinPerDollar, pPush) {
    p = Number(p); var q = pPush == null ? 0 : Number(pPush); var w = Number(netWinPerDollar);
    if (!(p >= 0 && p <= 1) || !(q >= 0 && q <= 1) || p + q > 1 + 1e-12 || !isFinite(w)) return null;
    return p * w - (1 - p - q);
  }
  var EV_STATES = ['POSITIVE_BOTH', 'POSITIVE_NOVIG_ONLY', 'POSITIVE_BOOK_ONLY', 'NEGATIVE_BOTH', 'INSUFFICIENT_DATA'];
  var EV_STATE_LABEL = {
    POSITIVE_BOTH: 'Positive EV at both venues', POSITIVE_NOVIG_ONLY: 'Positive EV only at Novig', POSITIVE_BOOK_ONLY: 'Positive EV only at DraftKings',
    NEGATIVE_BOTH: 'Negative EV at both venues', INSUFFICIENT_DATA: 'Insufficient data: no EV is stated'
  };
  function evState(evBook, evNovig) {
    if (evBook == null || evNovig == null) return 'INSUFFICIENT_DATA';
    if (evBook > 0 && evNovig > 0) return 'POSITIVE_BOTH';
    if (evNovig > 0) return 'POSITIVE_NOVIG_ONLY';
    if (evBook > 0) return 'POSITIVE_BOOK_ONLY';
    return 'NEGATIVE_BOTH';
  }

  /** May this model probability price this exact market at this time?
      model: { p_win, p_push, model_version, tier, frozen_at, market: {kind, period, line, side},
               validated_tiers? }  quote: { kind, period, line, side, observed_at } */
  var MODEL_TIERS = { MARKET_VALIDATED: true, OUTCOME_VALIDATED: true, VALIDATED: true };
  function modelGate(model, quote, now) {
    var reasons = [];
    if (!model || model.p_win == null) return { ok: false, reasons: ['no model probability for this market'] };
    if (!model.model_version) reasons.push('the model is not versioned');
    if (!MODEL_TIERS[model.tier]) reasons.push('the model tier (' + (model.tier || 'unknown') + ') is not validated to price a market');
    var fz = Date.parse(model.frozen_at || ''), ob = Date.parse((quote && quote.observed_at) || ''), nw = now == null ? Date.now() : Number(now);
    if (!isFinite(fz)) reasons.push('the model probability carries no freeze time');
    else {
      if (isFinite(ob) && fz > ob) reasons.push('the model was frozen after the quote was observed (it could have seen the price)');
      if (nw - fz > RULES.model_max_age_hours * 3600e3) reasons.push('the model probability is older than ' + RULES.model_max_age_hours + ' hours');
    }
    var mm = model.market || {}, qm = quote || {};
    if (mm.kind !== qm.kind) reasons.push('the model prices ' + (mm.kind || '?') + ', the quote is ' + (qm.kind || '?'));
    if ((mm.period || 'game') !== (qm.period || 'game')) reasons.push('the model prices a different period');
    if ((mm.line == null ? null : Number(mm.line)) !== (qm.line == null ? null : Number(qm.line))) reasons.push('the model prices a different line (' + mm.line + ' vs ' + qm.line + ')');
    if (String(mm.side || '').toLowerCase() !== String(qm.side || '').toLowerCase()) reasons.push('the model prices the other side');
    return { ok: !reasons.length, reasons: reasons };
  }

  /* ------------------------------------------------------------ freshness (one place) */
  var STATES = ['LIVE', 'RECENT', 'STALE', 'SUSPENDED', 'NO_LIQUIDITY', 'MISMATCH', 'UNSUPPORTED', 'AWAITING'];
  var STATE_LABEL = { LIVE: 'Live', RECENT: 'Recently updated', STALE: 'Stale', SUSPENDED: 'Suspended', NO_LIQUIDITY: 'No liquidity', MISMATCH: 'Market mismatch', UNSUPPORTED: 'Unsupported market', AWAITING: 'Awaiting data' };
  /** venue: 'novig' | 'book'; source: 'ws' | 'rest' (Novig) */
  function freshness(venue, observedAt, now, o) {
    o = o || {};
    var t = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt || '');
    var n = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
    if (!isFinite(t)) return { state: 'AWAITING', age_seconds: null, why: 'no observation yet' };
    var age = (n - t) / 1000;
    if (age < -120) return { state: 'STALE', age_seconds: age, why: 'timestamped in the future: not trusted' };
    if (o.suspended) return { state: 'SUSPENDED', age_seconds: age, why: o.suspended };
    if (venue === 'novig') {
      if (o.source === 'ws' && age <= RULES.novig_live_seconds) return { state: 'LIVE', age_seconds: age, why: 'streamed book, ' + Math.round(age) + ' s old' };
      if (age <= RULES.novig_recent_minutes * 60) return { state: 'RECENT', age_seconds: age, why: 'order-book snapshot ' + Math.round(age / 60) + ' min old' };
      return { state: 'STALE', age_seconds: age, why: 'order-book snapshot ' + Math.round(age / 60) + ' min old (limit ' + RULES.novig_recent_minutes + ')' };
    }
    if (age <= RULES.book_live_minutes * 60) return { state: 'LIVE', age_seconds: age, why: 'read ' + Math.round(age / 60) + ' min ago' };
    if (age <= RULES.book_recent_minutes * 60) return { state: 'RECENT', age_seconds: age, why: 'read ' + Math.round(age / 60) + ' min ago' };
    return { state: 'STALE', age_seconds: age, why: 'last read ' + Math.round(age / 60) + ' min ago (limit ' + RULES.book_recent_minutes + '): historical, not a current price' };
  }
  function actionable(state) { return state === 'LIVE' || state === 'RECENT'; }

  /* ------------------------------------------------------------ one selection at both venues
     book:  { decimal, observed_at, freshness? }
     novig: { quote (executableQuote result), observed_at, source, freshness? }
     model: optional (see modelGate); market: { kind, period, line, side }
     Returns the stake-aware comparison and every reason something is not said. */
  function compareSelection(input) {
    var o = input || {}, now = o.now == null ? Date.now() : o.now;
    var stakes = o.stakes || STAKES;
    var bf = o.book && o.book.decimal ? (o.book.freshness || freshness('book', o.book.observed_at, now)) : { state: 'AWAITING', why: 'no DraftKings price for this selection' };
    var nq = o.novig && o.novig.quote && o.novig.quote.ok ? o.novig.quote : null;
    var nf = o.novig && o.novig.observed_at ? (o.novig.freshness || freshness('novig', o.novig.observed_at, now, { source: o.novig.source, suspended: o.novig.suspended })) : { state: 'AWAITING', why: 'no Novig snapshot for this selection' };
    if (nq && !nq.top && nf.state !== 'AWAITING' && nf.state !== 'SUSPENDED') nf = Object.assign({}, nf, { state: 'NO_LIQUIDITY', why: 'nothing rests on the other side of Novig\'s book' });
    var bookOk = actionable(bf.state), novigOk = actionable(nf.state) && !!(nq && nq.top);
    var tB = Date.parse((o.book && o.book.observed_at) || ''), tN = Date.parse((o.novig && o.novig.observed_at) || '');
    var gapMin = isFinite(tB) && isFinite(tN) ? Math.abs(tB - tN) / 60000 : null;
    var simultaneous = gapMin != null && gapMin <= RULES.pair_max_gap_minutes;
    var notes = [];
    if (!bookOk) notes.push('DraftKings: ' + (bf.why || bf.state));
    if (!novigOk) notes.push('Novig: ' + (nf.why || nf.state));
    var comparable = bookOk && novigOk;
    if (comparable && !simultaneous) notes.push('the two prices were observed ' + Math.round(gapMin) + ' min apart: both are within their freshness windows, but this is not a simultaneous comparison');
    var mg = o.model ? modelGate(o.model, Object.assign({}, o.market || {}, { observed_at: o.novig && o.novig.observed_at }), now) : { ok: false, reasons: ['no model probability supplied'] };
    var rows = stakes.map(function (s) {
      var b = o.book && o.book.decimal ? bookQuote(o.book.decimal, s) : { status: 'NO_PRICE' };
      var n = nq ? (nq.stakes.find(function (x) { return x.stake_dollars === Number(s); }) || null) : null;
      var row = { stake: Number(s), book: b, novig: n, comparable: comparable && b.status === 'FILLED' && !!n && n.status === 'FILLED' };
      if (row.comparable) {
        var pb = Number(b.payout), pn = Number(n.payout) + Number(n.unspent);  /* the unspent remainder is returned, not lost */
        row.payout_diff = pn - pb;  /* positive: Novig pays more on a win for the same stake */
        row.better = Math.abs(n.effective_implied - b.effective_implied) * 100 < RULES.tie_pp ? 'TIE' : (pn > pb ? 'NOVIG' : 'DRAFTKINGS');
        row.implied_gap_pp = (b.effective_implied - n.effective_implied) * 100;
        row.cost_of_worse_price = Math.abs(pn - pb);
        if (mg.ok) {
          var pw = Number(o.model.p_win), pp = o.model.p_push == null ? 0 : Number(o.model.p_push);
          var evB = evPerDollar(pw, b.effective_decimal - 1, pp);
          var evN = evPerDollar(pw, Number(n.payout) / Number(n.total) - 1, pp);
          row.ev = { book_per_dollar: evB, novig_per_dollar: evN, delta_per_dollar: evN - evB,
            book_dollars: evB * Number(s), novig_dollars: evN * Number(n.total), delta_dollars: evN * Number(n.total) - evB * Number(s), state: evState(evB, evN) };
        } else row.ev = { state: 'INSUFFICIENT_DATA', reasons: mg.reasons };
      } else if (n && n.status === 'PARTIAL') row.why = 'Novig\'s book cannot fill $' + s + ' (' + (n.reason || 'partial fill') + ')';
      else if (n && n.status === 'NO_LIQUIDITY') row.why = 'no Novig liquidity at this stake';
      return row;
    });
    return {
      version: VERSION, market: o.market || null, comparable: comparable, simultaneous: simultaneous, gap_minutes: gapMin,
      book_state: bf.state, novig_state: nf.state, book_freshness: bf, novig_freshness: nf,
      top: comparable ? (function () {
        var bi = 1 / Number(o.book.decimal), ni = nq.top.implied, d = (bi - ni) * 100;
        return { book_american: decimalToAmerican(Number(o.book.decimal)), novig_american: nq.top.american, implied_gap_pp: d, better: Math.abs(d) < RULES.tie_pp ? 'TIE' : d > 0 ? 'NOVIG' : 'DRAFTKINGS' };
      })() : null,
      model: mg, rows: rows, notes: notes,
      disclaimer: 'Price comparison only. A better price is not, by itself, a positive-expected-value bet; EV is shown only against a versioned, validated model probability for this exact market.'
    };
  }

  /* ------------------------------------------------------------ small statistics for the research views */
  function median(xs) { var a = xs.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function quantile(xs, q) { var a = xs.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }
  /** Wilson score interval for k successes in n (z = 1.96) */
  function wilson(k, n, z) {
    if (!n) return { p: null, low: null, high: null, n: 0 };
    z = z || 1.959964;
    var p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { p: p, low: Math.max(0, c - h), high: Math.min(1, c + h), n: n };
  }

  return {
    VERSION: VERSION, RULES: RULES, STAKES: STAKES, STATES: STATES, STATE_LABEL: STATE_LABEL, EV_STATES: EV_STATES, EV_STATE_LABEL: EV_STATE_LABEL,
    milli: milli, milliStr: milliStr, onGrid: onGrid, takerFeeU: takerFeeU, feeCharged: feeCharged, uToDollars: uToDollars, dollarsToU: dollarsToU, uNum: uNum,
    levelsOf: levelsOf, askLadder: askLadder, compactDepth: compactDepth, fill: fill, executableQuote: executableQuote, bookQuote: bookQuote,
    americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican, impliedFromAmerican: impliedFromAmerican, impliedFromDecimal: impliedFromDecimal,
    roundAmerican: roundAmerican, fmtAmerican: fmtAmerican,
    hold: hold, noVig: noVig, evPerDollar: evPerDollar, evState: evState, modelGate: modelGate,
    freshness: freshness, actionable: actionable, compareSelection: compareSelection,
    median: median, quantile: quantile, wilson: wilson
  };
});
// ---- lib/novig_market_map.js
/* ===========================================================================
   EdgeDesk — NOVIG MARKET MATCHING: a Novig market to the book's own game,
   market, line and side, or a reason it is left unmapped.

   ONE ANSWER TO "IS THIS THE SAME BET?" Novig's catalog
   (docs.novig.com/api/concepts/universe-model.md) and The Odds API's
   (public.signals, public.sharp_price_snapshots) describe the same games in
   different words. A comparison is only made when every one of these holds;
   any doubt is a rejection with its reason, never a guess:
     sport + league     Novig's league maps to exactly one Odds API sport key
     event              exactly one book event of that sport has BOTH teams,
                        the same home and away (a swapped listing is
                        refused: a spread's strike is the HOME side's
                        handicap), kickoff within the sport's tolerance
     teams              resolved through lib/football_identity.js for NFL and
                        college football (an NFL club by its symbol AND its
                        name, which must agree), and by the exact full name
                        elsewhere. Novig's `description` is never parsed
                        (Novig: "Display text. Don't parse it")
     market type        MONEY/SPREAD/TOTAL (full game) and their _1H twins
                        only; every other type is unsupported, not mapped
     period             full game against full game, first half against first
                        half
     line               the exact strike: a spread of −3.5 is never compared
                        with −4.5, a total of 47.5 never with 48
     orientation        each outcome is read from its own name and checked
                        against the market: a spread's home outcome must
                        carry the strike, the away outcome its negation; a
                        total's Over and Under must both carry the strike;
                        a moneyline's two outcomes must be the two teams
     overtime           MONEY is a two-way market with no draw outcome, the
                        same structure as the book's h2h (which includes
                        overtime); a three-way (regulation) market is a
                        different type and is never mapped to h2h
     settlement         recorded, not assumed equal: Novig voids a market at
                        fair market value (`voids: FMV`) where a sportsbook
                        refunds; Novig does not document how a two-way NFL
                        moneyline settles a tie. Both are carried as
                        settlement notes on every comparison and lower the
                        confidence where they can bite
   CONFIDENCE  high    both teams resolved by full name (and, in the NFL, by
                       symbol too), kickoff within 15 minutes, no settlement
                       note that applies to an ordinary result
               medium  everything verified, but a team needed an alias or a
                       mascot strip, the kickoff differs by more than 15
                       minutes inside the tolerance, or a settlement note can
                       apply to an ordinary result (an NFL moneyline tie)
   Nothing lower is linked.

   Usable in Node (require; needs lib/football_identity.js beside it), the
   browser (window.EDNovigMap, after FootballIdentity) and Deno (inlined into
   supabase/functions/novig_sync by tools/novig/inline.js, drift-tested).
   =========================================================================== */
(function (root, factory) {
  var FI = root && root.FootballIdentity;
  if (!FI && typeof require === 'function') { try { FI = require('./football_identity.js'); } catch (_) { FI = null; } }
  var api = factory(FI);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDNovigMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FI) {
  'use strict';

  var LINKER_VERSION = 'novig-link-1';

  /* Novig league -> the Odds API sport key public.signals uses, and the
     kickoff tolerance. Football moves rarely and plays weekly (36 h, the
     board's own tolerance); the daily sports play the same opponent on
     consecutive days and in doubleheaders, so a wider window would be
     ambiguous: 4 h. */
  var LEAGUES = {
    NFL:     { sport_key: 'americanfootball_nfl',   identity: 'NFL', tolerance_min: 36 * 60, sport: 'nfl' },
    NCAAF:   { sport_key: 'americanfootball_ncaaf', identity: 'CFB', tolerance_min: 36 * 60, sport: 'cfb' },
    NBA:     { sport_key: 'basketball_nba',         identity: null,  tolerance_min: 4 * 60,  sport: 'nba' },
    NHL:     { sport_key: 'icehockey_nhl',          identity: null,  tolerance_min: 4 * 60,  sport: 'nhl' },
    MLB:     { sport_key: 'baseball_mlb',           identity: null,  tolerance_min: 4 * 60,  sport: 'mlb' },
    NCAAB:   { sport_key: 'basketball_ncaab',       identity: null,  tolerance_min: 4 * 60,  sport: 'ncaab' },
    WNBA:    { sport_key: 'basketball_wnba',        identity: null,  tolerance_min: 4 * 60,  sport: 'wnba' },
    NCAABSB: { sport_key: 'baseball_ncaa',          identity: null,  tolerance_min: 4 * 60,  sport: 'cbase' },
    NCAAWB:  { sport_key: 'basketball_wncaab',      identity: null,  tolerance_min: 4 * 60,  sport: 'ncaaw' }
  };
  /* Novig market type -> the Odds API market key, its period and its shape */
  var MARKET_TYPES = {
    MONEY:     { book_market: 'h2h',       period: 'game',       shape: 'teams' },
    SPREAD:    { book_market: 'spreads',   period: 'game',       shape: 'spread' },
    TOTAL:     { book_market: 'totals',    period: 'game',       shape: 'total' },
    MONEY_1H:  { book_market: 'h2h_h1',    period: 'first_half', shape: 'teams' },
    SPREAD_1H: { book_market: 'spreads_h1', period: 'first_half', shape: 'spread' },
    TOTAL_1H:  { book_market: 'totals_h1', period: 'first_half', shape: 'total' }
  };
  var CLOSE_KICKOFF_MIN = 15;

  function key(s) { return FI ? FI.teamKey(s) : String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }
  /** a decimal line as a canonical string: "-3.50" -> "-3.5", "+3" -> "3", "0" -> "0" */
  function line(s) {
    var m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var frac = (m[3] || '').replace(/0+$/, ''), whole = m[2].replace(/^0+(?=\d)/, '');
    var v = whole + (frac ? '.' + frac : '');
    return v === '0' ? '0' : (m[1] === '-' ? '-' : '') + v;
  }
  function negate(l) { return l == null ? null : l === '0' ? '0' : l.charAt(0) === '-' ? l.slice(1) : '-' + l; }

  /* ------------------------------------------------------------ teams
     A resolver for one league: given a Novig competitor ({name, shortName,
     symbol}) and a book team name, are they the same team, and how sure? */
  var NFL_REG = null;
  function nflRegistry() {
    if (!NFL_REG && FI) NFL_REG = FI.buildRegistry('NFL', FI.NFL_TEAMS.map(function (t) { return { id: t[0], name: t[1], code: t[0], aliases: t[2] }; }));
    return NFL_REG;
  }
  function nflClub(raw) { var r = FI ? FI.resolveTeam(nflRegistry(), raw, []) : null; return r && r.team_id ? { id: r.team_id, method: r.method } : null; }
  /** the club a Novig NFL competitor is: its symbol and its name must agree when both exist */
  function nflCompetitor(c) {
    var bySym = c.symbol ? nflClub(c.symbol) : null, byName = c.name ? nflClub(c.name) : null;
    if (bySym && byName && bySym.id !== byName.id) return { id: null, reason: 'competitor_symbol_name_conflict' };
    var id = (byName || bySym || {}).id || null;
    if (!id) return { id: null, reason: 'competitor_unresolved' };
    return { id: id, strong: !!(bySym && byName) && byName.method === 'name', method: (bySym ? 'symbol' : '') + (bySym && byName ? '+' : '') + (byName ? 'name:' + byName.method : '') };
  }
  /** Are Novig's home and away the book event's home and away?
      -> {match: 'same' | 'swapped' | 'one' | 'none', strong, method, reason} */
  function pairMatch(league, home, away, b) {
    var L = LEAGUES[league];
    var ids;
    if (L.identity === 'NFL') {
      var nh = nflCompetitor(home), na = nflCompetitor(away);
      if (!nh.id || !na.id) return { match: 'none', reason: nh.reason || na.reason };
      var bh = nflClub(b.home), ba = nflClub(b.away);
      if (!bh || !ba) return { match: 'none', reason: 'book_team_unresolved' };
      ids = { h: bh.id, a: ba.id };
      var strongNfl = nh.strong && na.strong && bh.method === 'name' && ba.method === 'name';
      return classify(nh.id === ids.h, na.id === ids.a, nh.id === ids.a, na.id === ids.h, strongNfl, 'home:' + nh.method + '|away:' + na.method + '|book:' + bh.method + '+' + ba.method);
    }
    if (L.identity === 'CFB' && FI) {
      /* the registry holds Novig's two names; the book's names (with mascots)
         are resolved against it, as kalshi_sync resolves the book against
         Kalshi's: the resolver strips mascots from what it READS */
      var reg = FI.buildRegistry('CFB', [
        { id: 'H', name: home.name || null, aliases: [home.shortName].filter(Boolean) },
        { id: 'A', name: away.name || null, aliases: [away.shortName].filter(Boolean) }]);
      if (!home.name && !home.shortName || !away.name && !away.shortName) return { match: 'none', reason: 'competitor_unnamed' };
      var uni = [b.home, b.away];
      var rh = FI.resolveTeam(reg, b.home, uni), ra = FI.resolveTeam(reg, b.away, uni);
      var strongCfb = rh.method === 'name' && ra.method === 'name';
      return classify(rh.team_id === 'H', ra.team_id === 'A', rh.team_id === 'A', ra.team_id === 'H', strongCfb, 'cfb:book_home=' + (rh.method || rh.reason) + '|book_away=' + (ra.method || ra.reason));
    }
    /* the daily leagues: Novig's full name and the book's full name, exactly */
    if (!home.name || !away.name) return { match: 'none', reason: 'competitor_unnamed' };
    return classify(key(home.name) === key(b.home), key(away.name) === key(b.away), key(home.name) === key(b.away), key(away.name) === key(b.home), true, 'exact_name');
  }
  function classify(hh, aa, ha, ah, strong, method) {
    if (hh && aa) return { match: 'same', strong: strong, method: method };
    if (ha && ah) return { match: 'swapped', method: method };
    if (hh || aa || ha || ah) return { match: 'one', method: method };
    return { match: 'none', method: method };
  }

  /* ------------------------------------------------------------ the event */
  /** participants: {homeCompetitorId, awayCompetitorId, competitors:[{competitorId,name,shortName,symbol,marketIds}]}
      books: [{event_id, sport_key, home, away, kickoff_ms}] */
  function matchEvent(ev, participants, books) {
    var L = LEAGUES[ev && ev.league];
    if (!L) return { reason: 'unsupported_league', detail: { league: ev && ev.league } };
    if (!participants || !participants.homeCompetitorId || !participants.awayCompetitorId) return { reason: 'no_home_away', detail: { event: ev.eventId } };
    var byId = {};
    (participants.competitors || []).forEach(function (c) { byId[c.competitorId] = c; });
    var home = byId[participants.homeCompetitorId], away = byId[participants.awayCompetitorId];
    if (!home || !away) return { reason: 'competitor_missing' };
    if (participants.homeCompetitorId === participants.awayCompetitorId) return { reason: 'same_team_twice' };
    var t = Number(ev.startsTs);
    if (!isFinite(t)) return { reason: 'no_start_time' };
    var cands = [], swapped = [], oneTeam = [], refused = [];
    (books || []).filter(function (b) { return b.sport_key === L.sport_key && isFinite(b.kickoff_ms) && Math.abs(b.kickoff_ms - t) <= L.tolerance_min * 60000; }).forEach(function (b) {
      var pm = pairMatch(ev.league, home, away, b);
      if (pm.match === 'same') cands.push({ b: b, pm: pm });
      else if (pm.match === 'swapped') swapped.push(b.event_id);
      else if (pm.match === 'one') oneTeam.push(b.event_id);
      else if (pm.reason && pm.reason !== 'book_team_unresolved') refused.push(pm.reason);
    });
    if (cands.length > 1) return { reason: 'ambiguous_book_event', detail: { events: cands.map(function (c) { return c.b.event_id; }) } };
    if (!cands.length) {
      if (swapped.length) return { reason: 'home_away_swapped', detail: { events: swapped } };
      if (oneTeam.length) return { reason: 'one_team_only', detail: { events: oneTeam, home: home.name || home.symbol, away: away.name || away.symbol } };
      if (refused.length) return { reason: refused[0], detail: { home: home.name || home.symbol, away: away.name || away.symbol } };
      return { reason: 'no_book_event', detail: { home: home.name || home.symbol, away: away.name || away.symbol, starts: new Date(t).toISOString() } };
    }
    var c = cands[0], dMin = Math.abs(c.b.kickoff_ms - t) / 60000;
    return {
      event: {
        novig_event_id: ev.eventId, league: ev.league, sport: L.sport, odds_event_id: c.b.event_id, odds_sport_key: c.b.sport_key,
        home_team: c.b.home, away_team: c.b.away, kickoff_at: new Date(c.b.kickoff_ms).toISOString(), novig_starts_at: new Date(t).toISOString(),
        kickoff_delta_min: Math.round(dMin * 10) / 10, home: home, away: away,
        strong: !!c.pm.strong && dMin <= CLOSE_KICKOFF_MIN,
        method: c.pm.method + '|kickoff:' + Math.round(dMin) + 'm'
      }
    };
  }

  /* ------------------------------------------------------------ one outcome's own reading */
  /** which competitor an outcome name is (symbol, short name or full name, exactly) */
  function competitorOf(name, ev) {
    var k = key(name), hits = [];
    [['home', ev.home], ['away', ev.away]].forEach(function (p) {
      var c = p[1];
      if ([c.symbol, c.shortName, c.name].filter(Boolean).some(function (x) { return key(x) === k; })) hits.push(p[0]);
    });
    return hits.length === 1 ? hits[0] : null;
  }
  /** "BUF -3.5" -> {team:'BUF', line:'-3.5'}; "Over 47.5" -> {ou:'Over', line:'47.5'} */
  function parseOutcome(name) {
    var s = String(name == null ? '' : name).trim();
    var ou = /^(Over|Under)\s+([+-]?\d+(?:\.\d+)?)$/i.exec(s);
    if (ou) return { ou: ou[1].charAt(0).toUpperCase() + ou[1].slice(1).toLowerCase(), line: line(ou[2]) };
    var sp = /^(.+?)\s+([+-]\d+(?:\.\d+)?|0)$/.exec(s);
    if (sp) return { team: sp[1].trim(), line: line(sp[2]) };
    return { team: s, line: null };
  }

  /** one Novig market -> its link to the book's market, or a reason */
  function mapMarket(m, ev) {
    var T = MARKET_TYPES[m && m.marketType];
    if (!T) return { reason: 'unsupported_market_type', detail: { marketType: m && m.marketType } };
    if (!Array.isArray(m.outcomes) || m.outcomes.length !== 2) return { reason: 'not_two_outcomes', detail: { n: m.outcomes ? m.outcomes.length : 0 } };
    var strike = m.strike == null ? null : line(m.strike);
    var outs = [];
    for (var i = 0; i < 2; i++) {
      var o = m.outcomes[i], p = parseOutcome(o.name);
      if (T.shape === 'total') {
        if (!p.ou) return { reason: 'total_outcome_unreadable', detail: { name: o.name } };
        if (strike == null || p.line !== strike) return { reason: 'total_line_mismatch', detail: { name: o.name, strike: m.strike } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, side: p.ou, point: strike });
        continue;
      }
      var who = competitorOf(p.team, ev);
      if (!who) return { reason: 'outcome_team_unresolved', detail: { name: o.name } };
      if (T.shape === 'teams') {
        if (p.line != null && p.line !== '0') return { reason: 'moneyline_with_a_line', detail: { name: o.name } };
        if (strike != null && strike !== '0') return { reason: 'moneyline_with_a_strike', detail: { strike: m.strike } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, who: who, side: who === 'home' ? ev.home_team : ev.away_team, point: null });
      } else {
        if (strike == null || p.line == null) return { reason: 'spread_line_missing', detail: { name: o.name, strike: m.strike } };
        /* the strike is the HOME side's handicap (Novig: "A spread's line is the home side's handicap") */
        var want = who === 'home' ? strike : negate(strike);
        if (p.line !== want) return { reason: 'spread_orientation_mismatch', detail: { name: o.name, who: who, strike: m.strike, expected: want } };
        outs.push({ outcome_id: o.outcomeId, novig_name: o.name, who: who, side: who === 'home' ? ev.home_team : ev.away_team, point: p.line });
      }
    }
    if (outs[0].side === outs[1].side) return { reason: 'both_outcomes_one_side', detail: { names: m.outcomes.map(function (o) { return o.name; }) } };
    var notes = [], ordinaryNote = false;
    if (m.voids === 'FMV') notes.push('Novig settles a voided market at its fair market value (voids: FMV); a sportsbook normally refunds a void. The prices compare for a completed game, not for a void.');
    else if (m.voids === 'PUSH') notes.push('Novig refunds every fill if this market voids (voids: PUSH), as a sportsbook normally does.');
    else notes.push('Novig did not state how this market voids.');
    if (T.shape === 'teams' && ev.league === 'NFL') {
      notes.push('An NFL game can end tied. A sportsbook moneyline refunds a tie; Novig does not document how a two-way NFL moneyline settles one.');
      ordinaryNote = true;
    }
    if (T.shape !== 'teams' && /^-?\d+$/.test(String(strike))) notes.push('A whole-number line can push: both venues return the stake on a push (Novig grades "Pushes").');
    if (T.period === 'first_half') notes.push('First half only: overtime is not part of it at either venue.');
    var constraints = {
      league: ev.league, sport_key: ev.odds_sport_key, market_kind: T.book_market, period: T.period, line: T.shape === 'teams' ? null : strike,
      orientation: 'home_away_same', ot: T.period === 'first_half' ? 'excluded' : 'included_two_way', void_rule: { novig: m.voids || null, book: 'sportsbook house rules (refund on a void)' },
      kickoff_delta_min: ev.kickoff_delta_min, novig_market_type: m.marketType, novig_strike: m.strike == null ? null : String(m.strike)
    };
    return {
      link: {
        novig_market_id: m.marketId, novig_event_id: ev.novig_event_id, novig_market_type: m.marketType, odds_event_id: ev.odds_event_id, odds_sport_key: ev.odds_sport_key,
        book_market: T.book_market, period: T.period, line: T.shape === 'teams' ? null : strike, home_team: ev.home_team, away_team: ev.away_team, kickoff_at: ev.kickoff_at,
        outcomes: outs.map(function (x) { return { outcome_id: x.outcome_id, novig_name: x.novig_name, side: x.side, point: x.point }; }),
        match_confidence: ev.strong && !ordinaryNote ? 'high' : 'medium',
        match_method: ev.method + '|market:' + m.marketType + (strike != null && T.shape !== 'teams' ? '@' + strike : ''),
        constraints: constraints, settlement_notes: notes, linker_version: LINKER_VERSION
      }
    };
  }

  /** every market of one Novig event; markets whose type is unsupported are counted, not queued */
  function mapEvent(ev, participants, markets, books) {
    var e = matchEvent(ev, participants, books);
    var mine = (markets || []).filter(function (m) { return m.eventId === ev.eventId; });
    if (!e.event) return { links: [], unmapped: mine.filter(function (m) { return MARKET_TYPES[m.marketType]; }).map(function (m) { return { novig_market_id: m.marketId, novig_event_id: ev.eventId, reason: e.reason, detail: e.detail || null }; }), event_reason: e.reason, event_detail: e.detail || null };
    var links = [], unmapped = [], unsupported = 0;
    mine.forEach(function (m) {
      if (!MARKET_TYPES[m.marketType]) { unsupported++; return; }
      var r = mapMarket(m, e.event);
      if (r.link) links.push(r.link); else unmapped.push({ novig_market_id: m.marketId, novig_event_id: ev.eventId, reason: r.reason, detail: r.detail || null });
    });
    return { event: e.event, links: links, unmapped: unmapped, unsupported: unsupported };
  }

  return { LINKER_VERSION: LINKER_VERSION, LEAGUES: LEAGUES, MARKET_TYPES: MARKET_TYPES, line: line, negate: negate, parseOutcome: parseOutcome,
    pairMatch: pairMatch, nflCompetitor: nflCompetitor, matchEvent: matchEvent, mapMarket: mapMarket, mapEvent: mapEvent, hasIdentity: !!FI };
});
// ── END NOVIG CORE ──

// deno-lint-ignore no-explicit-any
type Any = any;
const G: Any = globalThis as Any;
const FI: Any = G.FootballIdentity, NS: Any = G.NovigSigning, EV: Any = G.EDVENUE, MAP: Any = G.EDNovigMap;
const env = (k: string): string => (G.Deno?.env.get(k) ?? "");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const iso = (ms: number) => new Date(ms).toISOString();
const msOf = (v: unknown) => { const t = v == null ? NaN : (typeof v === "number" ? v : Date.parse(String(v))); return Number.isFinite(t) ? t : null; };
function deadline(ms: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(ms); } catch { return undefined; } }

/* tests stand in for the clock and the dice */
export const hooks: Any = { sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), random: () => Math.random() };

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
const insert = (table: string, rows: Any, ret = false) =>
  db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: ret ? "return=representation" : "return=minimal" } });
const upsert = (table: string, rows: Any, key: string) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: "return=minimal,resolution=merge-duplicates" } });
const insertOnce = (table: string, rows: Any, key: string, ret = false) =>
  db(table + "?on_conflict=" + key, { method: "POST", body: JSON.stringify(rows), headers: { prefer: (ret ? "return=representation" : "return=minimal") + ",resolution=ignore-duplicates" } });
const patch = (path: string, body: Any) => db(path, { method: "PATCH", body: JSON.stringify(body), headers: { prefer: "return=minimal" } });
const rpc = (fn: string, args: Any) => db("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
async function dbAll(path: string, pages = 20): Promise<Any[]> {
  const out: Any[] = [];
  for (let p = 0; p < pages; p++) {
    const rows = (await db(path + "&limit=1000&offset=" + p * 1000)) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function inChunks(rows: Any[], n: number, fn: (c: Any[]) => Promise<Any>) { const out: Any[] = []; for (let i = 0; i < rows.length; i += n) { const r = await fn(rows.slice(i, i + n)); if (Array.isArray(r)) out.push(...r); } return out; }
const inList = (xs: string[]) => "(" + xs.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(",") + ")";

/* ---------------------------------------------------------------- Novig (signed REST, read-only) */
export class NovigError extends Error {
  kind: string; status: number; code: string | null; halt_minutes: number; severity: string;
  constructor(kind: string, status: number, code: string | null, message: string, halt: number, severity = "FAILURE") {
    super(message); this.kind = kind; this.status = status; this.code = code; this.halt_minutes = halt; this.severity = severity;
  }
}
/** the throttle, modelled client side (throttling.md): a token bucket */
function bucket(capacity: number, refill: number) {
  const b = { capacity, refill, tokens: capacity, at: hooks.now() };
  return {
    b,
    async take(cost: number, maxWaitMs: number) {
      const now = hooks.now();
      b.tokens = Math.min(b.capacity, b.tokens + ((now - b.at) / 1000) * b.refill); b.at = now;
      if (b.tokens >= cost) { b.tokens -= cost; return; }
      const wait = Math.ceil(((cost - b.tokens) / b.refill) * 1000);
      if (wait > maxWaitMs) throw new NovigError("budget", 0, null, "the read throttle would need " + wait + " ms; the run stops here", 0, "WARNING");
      await hooks.sleep(wait);
      b.tokens = 0; b.at = hooks.now();
    },
  };
}

export function client(ctx: Any) {
  const host = NS.hostFor(ctx.environment);
  let offset = 0, signer: Any = null;
  const tb = bucket(16, 8);
  const c: Any = { host, requests: 0, notModified: 0, rateLimited: 0, offsetMs: () => offset, bucket: tb.b };
  c.init = async () => {
    try { signer = await NS.importPrivateKey(env("NOVIG_READ_PRIVATE_KEY")); }
    catch (e) { throw new NovigError("credential", 0, null, "NOVIG_READ_PRIVATE_KEY could not be read: " + msg(e), 60); }
    if (!/^[0-9a-f-]{36}$/i.test(env("NOVIG_READ_KEY_ID"))) throw new NovigError("credential", 0, null, "NOVIG_READ_KEY_ID is not a key UUID", 60);
    c.algorithm = signer.algorithm;
  };
  /* GET /v3/time: Novig's clock. If our clock is already outside the ±30 s window the signed call is refused before
     the route runs, so the refusal's Date header (second precision) sets a first offset and the call is repeated */
  c.syncClock = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = hooks.now();
      const r = await raw("GET", "/v3/time", "", undefined, {});
      const after = hooks.now();
      if (r.status === 200) {
        const j = JSON.parse(r.text || "{}");
        if (!Number.isFinite(Number(j.ts))) throw new NovigError("drift", 200, null, "GET /v3/time answered without ts", 0, "DRIFT");
        offset = NS.clockOffset(before, after, j.ts);
        return { offset_ms: offset, skew: NS.skewState(offset) };
      }
      const d = msOf(r.headers.get("date"));
      if (r.status === 401 && /timestamp/i.test(r.text) && d != null) { offset = d + 500 - (before + after) / 2; continue; }
      throw classify(r, "/v3/time");
    }
    throw new NovigError("auth", 401, "SIGNATURE_REJECTED", "the clock could not be brought inside Novig's ±30 s window", 60);
  };
  async function raw(method: string, path: string, query: string, body: Any, headers: Record<string, string>) {
    const s = await NS.signRequest({ host, keyId: env("NOVIG_READ_KEY_ID"), signer, method, path, query, body, nowMs: hooks.now(), clockOffsetMs: offset });
    c.requests++;
    const res = await fetch(s.url, { method, headers: { ...s.headers, accept: "application/json", "user-agent": UA, ...headers }, body: s.body, signal: deadline(15000) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  function classify(r: Any, path: string): NovigError {
    let j: Any = null; try { j = JSON.parse(r.text); } catch { /* HTML or empty */ }
    const code = j && j.code ? String(j.code) : null, m = j && j.message ? String(j.message).slice(0, 200) : "";
    const html = !j && /<html|<!doctype/i.test(r.text || "");
    if (r.status === 401) {
      const wrongEnv = /api key not found/i.test(m);
      return new NovigError("auth", 401, code, "Novig refused the signature on " + path + " (" + (m || "401") + ")" + (wrongEnv ? ": a wrong key id, or a key from the other environment (NOVIG_ENV=" + ctx.environment + ")" : ""), 60);
    }
    if (r.status === 403 && html) return new NovigError("edge_blocked", 403, null, "Novig's edge refused " + path + " before it reached the API (an HTML 403: rate, user agent or this host's address)", 15, "DEGRADED");
    if (r.status === 403) return new NovigError("scope", 403, code, "the key's scope does not grant " + path + " (" + (code || m) + ")", 360);
    if (r.status === 404) return new NovigError("not_found", 404, code, path + " not found (" + (code || "404") + ")", 0, "WARNING");
    if (r.status === 423) return new NovigError("locked", 423, code, "Novig answered 423 " + (code || "") + " on " + path + ": the account or exchange is locked; contact Novig support", 360);
    if (r.status === 451) return new NovigError("geolocation", 451, code, "Novig's location check refused " + path + " (" + (code || "451") + "). Not retried: " + (code && NETWORK_451.includes(code) ? "this host's network address is refused; run from a fixed US address Novig admits" : "the key holder must open the Novig app in a permitted state"), code && NETWORK_451.includes(code) ? 120 : 360);
    if (r.status === 429) return new NovigError("rate_limited", 429, code, "Novig's throttle is empty on " + path, 0, "DEGRADED");
    if (r.status >= 500) return new NovigError("server", r.status, code, "Novig answered " + r.status + " on " + path, 0, "DEGRADED");
    return new NovigError("bad_request", r.status, code, "Novig answered " + r.status + " " + (code || "") + " on " + path + ": " + m, 0, "DRIFT");
  }
  /** one signed request, with the documented handling of every answer */
  c.req = async (method: string, path: string, params: Any = {}, o: Any = {}) => {
    const query = NS.buildQuery(params);
    let resynced = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (o.cost !== 0) await tb.take(o.cost || 1, o.maxWaitMs ?? 4000);
      let r: Any;
      try { r = await raw(method, path, query, o.body, o.headers || {}); }
      catch (e) {
        if (attempt >= 2) throw new NovigError("network", 0, null, "Novig could not be reached on " + path + " (" + msg(e) + ")", 0, "DEGRADED");
        await hooks.sleep(Math.round(250 * 2 ** attempt * (0.5 + hooks.random()))); continue;
      }
      if (r.status === 200 || r.status === 201) { try { return { status: r.status, json: r.text ? JSON.parse(r.text) : null, etag: r.headers.get("etag") }; } catch { throw new NovigError("drift", r.status, null, path + " answered a body that is not JSON", 0, "DRIFT"); } }
      if (r.status === 304) { c.notModified++; return { status: 304, json: null, etag: r.headers.get("etag") }; }
      if (r.status === 401 && !resynced && /timestamp/i.test(r.text || "")) { resynced = true; await c.syncClock(); continue; }
      if (r.status === 429) {
        c.rateLimited++;
        const ra = Number(r.headers.get("retry-after"));
        const wait = (Number.isFinite(ra) && ra >= 0 ? ra : 1) * 1000;
        if (attempt >= 2 || wait > 10000) throw classify(r, path);
        await hooks.sleep(Math.round(wait + 250 * hooks.random())); continue;
      }
      if (r.status >= 500 && attempt < 2) { await hooks.sleep(Math.round(250 * 2 ** attempt * (0.5 + hooks.random()))); continue; }
      throw classify(r, path);
    }
    throw new NovigError("server", 0, null, "Novig did not answer " + path + " after retries", 0, "DEGRADED");
  };
  /** every page of a listing (PageCursor: `after` takes the previous `next`) */
  c.pages = async (path: string, params: Any, maxPages = 40) => {
    const out: Any[] = [];
    let after = "";
    for (let p = 0; p < maxPages; p++) {
      const r = await c.req("GET", path, Object.assign({}, params, after ? { after } : {}));
      const items = r.json && Array.isArray(r.json.items) ? r.json.items : null;
      if (!items) throw new NovigError("drift", 200, null, "GET " + path + " answered without items", 0, "DRIFT");
      out.push(...items);
      after = r.json.next || "";
      if (!after) return out;
    }
    ctx.alert("WARNING", "page_cap", "GET " + path + " has more than " + maxPages + " pages; the rest was not read");
    (out as Any).truncated = true;
    return out;
  };
  return c;
}

/** an error that ends the run (and may halt the next ones) rather than one league or one book */
const fatal = (e: unknown) => e instanceof NovigError && (e.severity === "FAILURE" || ["edge_blocked", "rate_limited", "budget"].includes(e.kind));

/* ---------------------------------------------------------------- probe */
async function probe(ctx: Any, nv: Any) {
  const auth: Any = { environment: ctx.environment, host: nv.host, key_id_tail: env("NOVIG_READ_KEY_ID").slice(-4), algorithm: nv.algorithm };
  const clock = await nv.syncClock();
  Object.assign(auth, { clock_offset_ms: clock.offset_ms, clock: clock.skew });
  if (clock.skew === "outside_window") ctx.alert("WARNING", "clock_skew", "this host's clock is " + Math.round(clock.offset_ms / 1000) + " s from Novig's, outside the ±30 s window: requests are signed on Novig's time (GET /v3/time); fix the host clock");
  else if (clock.skew === "drifting") ctx.alert("WARNING", "clock_skew", "this host's clock is " + Math.round(clock.offset_ms / 1000) + " s from Novig's");
  try { const st = await nv.req("GET", "/v3/exchange/status", {}, { cost: 0 }); auth.exchange = st.json ? { trading: st.json.trading, reason: st.json.reason ?? null } : null; }
  catch (e) { auth.exchange = { error: msg(e) }; }
  const body = '{"probe":"edgedesk","at":' + hooks.now() + "}";
  const echo = await nv.req("POST", "/v3/echo", {}, { body, cost: 0 });
  auth.echo = echo.json && JSON.stringify(echo.json) === body ? "ok" : (echo.json && echo.json.probe === "edgedesk" ? "ok" : "mismatch");
  if (auth.echo !== "ok") ctx.alert("DRIFT", "echo_mismatch", "POST /v3/echo answered 200 but not the body that was sent");
  try {
    const lim = await nv.req("GET", "/v3/limits", {}, { cost: 0 });
    auth.limits = lim.json ? { read: lim.json.read, history: lim.json.history, stream: lim.json.stream, max_watched_markets: lim.json.maxWatchedMarkets } : null;
  } catch (e) { auth.limits = { error: msg(e) }; }
  try { const g = await nv.req("GET", "/v3/account/geolocation", {}); auth.geolocation = g.json ? { code: g.json.code ?? null, expires_at: g.json.expiresAt ?? null } : null; }
  catch (e) { auth.geolocation = { error: msg(e) }; }
  try {
    const k = await nv.req("GET", "/v3/keys", {});
    const mine = (Array.isArray(k.json) ? k.json : (k.json && k.json.items) || []).find((x: Any) => x && x.keyId === env("NOVIG_READ_KEY_ID"));
    auth.scope = mine ? mine.scope : "unlisted";
    if (mine && mine.scope === "management") ctx.alert("WARNING", "over_privileged_key", "the ingestion key is a full management key; provision a management::read key (docs/novig/README.md §Credentials)");
  } catch (e) {
    /* a trading::read key may not list keys: that is not an error of the probe */
    auth.scope = e instanceof NovigError && e.kind === "scope" ? "not management (cannot list keys)" : "unknown: " + msg(e);
  }
  ctx.run.auth = auth;
  ctx.out.auth = auth;
}

/* ---------------------------------------------------------------- discover */
function leagues(): string[] {
  const want = (env("NOVIG_LEAGUES") || "NFL,NCAAF,NBA,NHL,NCAAB,MLB,WNBA,NCAABSB").split(",").map((s) => s.trim()).filter(Boolean);
  return want.filter((l) => MAP.LEAGUES[l]);
}
const horizonMs = () => (Number(env("NOVIG_HORIZON_HOURS")) || 96) * 3600e3;

async function bookEvents(ctx: Any, sportKeys: string[]) {
  const lo = ctx.nowMs - 2 * 864e5, hi = ctx.nowMs + horizonMs() + 2 * 864e5;
  const rows = await dbAll("signals?select=event_id,sport_key,home_team,away_team,commence_time&market=eq.h2h&sport_key=in." + inList(sportKeys)
    + "&commence_time=gte." + encodeURIComponent(iso(lo)) + "&commence_time=lte." + encodeURIComponent(iso(hi)) + "&order=event_id");
  const ev: Record<string, Any> = {};
  for (const r of rows) {
    const k = msOf(r.commence_time);
    if (!r.event_id || k == null || !r.home_team || !r.away_team) continue;
    ev[r.event_id] = ev[r.event_id] || { event_id: r.event_id, sport_key: r.sport_key, home: r.home_team, away: r.away_team, kickoff_ms: k };
  }
  return Object.values(ev);
}

async function discover(ctx: Any, nv: Any) {
  const at = iso(ctx.nowMs);
  const window = { startsBefore: ctx.nowMs + horizonMs() };
  const allEvents: Any[] = [], allParts: Any[] = [], allMarkets: Any[] = [];
  const failed: string[] = [], truncated = new Set<string>();
  for (const L of leagues()) {
    try {
      const evs = await nv.pages("/v3/catalog/events", { league: L, status: LIVE_STATUSES, ...window, limit: 1000 });
      const games = evs.filter((e: Any) => e && e.eventId);
      if (!games.length) continue;
      const parts = await nv.pages("/v3/catalog/participants", { league: L, status: LIVE_STATUSES, ...window, limit: 1000 });
      const mkts = await nv.pages("/v3/catalog/markets", { league: L, marketType: GAME_TYPES, eventStatus: LIVE_STATUSES, ...window, limit: 5000 });
      let cons: Any[] = [];
      try { cons = await nv.pages("/v3/catalog/consensus", { league: L, marketType: GAME_TYPES, limit: 5000 }); }
      catch (e) { if (fatal(e)) throw e; ctx.alert("WARNING", "consensus_unread", L + ": consensus lines could not be read (" + msg(e) + ")"); }
      const consensus = new Set(cons.map((c: Any) => c.marketId));
      /* a listing cut short by the page cap is not evidence that a market left the catalog */
      if ((mkts as Any).truncated || (evs as Any).truncated) truncated.add(L);
      allEvents.push(...games.map((e: Any) => Object.assign({ _league: L }, e)));
      allParts.push(...parts);
      allMarkets.push(...mkts.filter((m: Any) => m && m.marketId && m.eventId).map((m: Any) => Object.assign({ _consensus: consensus.has(m.marketId) }, m)));
    } catch (e) {
      if (fatal(e)) throw e;
      failed.push(L + ": " + msg(e));
    }
  }
  Object.assign(ctx.run, { events_seen: allEvents.length, markets_seen: allMarkets.length });
  const partsBy: Record<string, Any> = {};
  for (const p of allParts) if (p && p.eventId) partsBy[p.eventId] = p;
  const compName = (p: Any, id: string) => ((p && p.competitors) || []).find((c: Any) => c.competitorId === id) || {};
  const eventRows = allEvents.map((e: Any) => {
    const p = partsBy[e.eventId];
    const h = p ? compName(p, p.homeCompetitorId) : {}, a = p ? compName(p, p.awayCompetitorId) : {};
    return { event_id: e.eventId, environment: ctx.environment, league: e.league || e._league, sport: e.sport ?? null, description: e.description ?? null, status: e.status ?? null,
      starts_at: e.startsTs ? iso(Number(e.startsTs)) : null, home_competitor_id: p?.homeCompetitorId ?? null, away_competitor_id: p?.awayCompetitorId ?? null,
      home_name: h.name ?? null, away_name: a.name ?? null, home_symbol: h.symbol ?? null, away_symbol: a.symbol ?? null, updated_at: at };
  });
  const known = new Set(eventRows.map((e: Any) => e.event_id));
  const marketRows = allMarkets.filter((m: Any) => known.has(m.eventId)).map((m: Any) => ({
    market_id: m.marketId, environment: ctx.environment, event_id: m.eventId, market_type: m.marketType, strike: m.strike == null ? null : String(m.strike), status: m.status ?? null,
    voids: m.voids ?? null, fee_coefficient: m.fee?.coefficient ?? null, fee_maker_credit: m.fee?.makerCredit ?? null, fee_charged: m.fee?.charged ?? null, description: m.description ?? null,
    outcomes: (m.outcomes || []).map((o: Any) => ({ outcomeId: o.outcomeId, name: o.name, status: o.status })), volume: m.volume ?? null, open_interest: m.openInterest ?? null,
    is_consensus: !!m._consensus, gone_at: null, updated_at: at }));
  const drift = allMarkets.filter((m: Any) => !m.fee || !m.voids || !Array.isArray(m.outcomes));
  if (drift.length) ctx.alert("DRIFT", "market_shape", drift.length + " market(s) arrived without fee, voids or outcomes: stored without a comparison");
  if (!ctx.dry) {
    await inChunks(eventRows, 500, (c) => upsert("novig_events", c, "event_id"));
    await inChunks(marketRows, 500, (c) => upsert("novig_markets", c, "market_id"));
    /* cleanup: a market of an event read this run that is no longer in the open catalog has closed, settled or been delisted */
    const listed = new Set(marketRows.map((m: Any) => m.market_id));
    const ids = eventRows.filter((e: Any) => !truncated.has(e.league)).map((e: Any) => e.event_id);
    for (let i = 0; i < ids.length; i += 100) {
      const open = await dbAll("novig_markets?select=market_id&environment=eq." + ctx.environment + "&gone_at=is.null&event_id=in." + inList(ids.slice(i, i + 100)) + "&order=market_id");
      const gone = open.map((x: Any) => x.market_id).filter((id: string) => !listed.has(id));
      if (gone.length) { await patch("novig_markets?market_id=in." + inList(gone), { gone_at: at, status: "CLOSED", updated_at: at }); ctx.details.markets_closed_out = (ctx.details.markets_closed_out || 0) + gone.length; }
    }
  }
  ctx.out.discover = { leagues: leagues(), events: eventRows.length, markets: marketRows.length, consensus: marketRows.filter((m: Any) => m.is_consensus).length, failed };
  if (failed.length && failed.length === leagues().length) { ctx.alert("FAILURE", "novig_unreachable", "every league failed: " + failed.join("; ").slice(0, 400)); return; }
  if (failed.length) ctx.alert("DEGRADED", "league_failed", failed.length + " league(s) failed: " + failed.join("; ").slice(0, 400), { failed });
  await link(ctx, allEvents, partsBy, allMarkets);
}

/* ---------------------------------------------------------------- the links */
async function link(ctx: Any, events: Any[], partsBy: Record<string, Any>, markets: Any[]) {
  const sportKeys = [...new Set(events.map((e: Any) => MAP.LEAGUES[e.league || e._league]?.sport_key).filter(Boolean))] as string[];
  if (!sportKeys.length) return;
  let books: Any[];
  try { books = await bookEvents(ctx, sportKeys); }
  catch (e) { ctx.alert("DEGRADED", "book_events_unreadable", "the book's events (public.signals) could not be read: nothing was linked (" + msg(e) + ")"); return; }
  const existing = await dbAll("novig_market_links?select=market_id,odds_event_id,book_market,line,outcomes,invalidated_at&environment=eq." + ctx.environment
    + "&invalidated_at=is.null&kickoff_at=gte." + encodeURIComponent(iso(ctx.nowMs - 864e5)) + "&order=market_id");
  const active: Record<string, Any> = {};
  for (const x of existing) active[x.market_id] = x;
  const newLinks: Any[] = [], unmapped: Any[] = [], invalid: Any[] = [];
  let unsupported = 0;
  for (const ev of events) {
    const e = Object.assign({}, ev, { league: ev.league || ev._league });
    const r = MAP.mapEvent(e, partsBy[e.eventId] || null, markets, books);
    unsupported += r.unsupported || 0;
    for (const u of r.unmapped) unmapped.push({ novig_event_id: u.novig_event_id, market_id: u.novig_market_id || "", reason: u.reason, detail: u.detail, starts_at: e.startsTs ? iso(Number(e.startsTs)) : null });
    const mapped = new Set<string>();
    for (const l of r.links) {
      mapped.add(l.novig_market_id);
      const prev = active[l.novig_market_id];
      if (prev) {
        /* re-verified: the same book event, market, line and sides, or it is invalidated (and relinked on the next run) */
        const same = prev.odds_event_id === l.odds_event_id && prev.book_market === l.book_market && (prev.line == null ? l.line == null : Number(prev.line) === Number(l.line))
          && JSON.stringify((prev.outcomes || []).map((o: Any) => o.outcome_id + "=" + o.side).sort()) === JSON.stringify(l.outcomes.map((o: Any) => o.outcome_id + "=" + o.side).sort());
        if (!same) invalid.push({ market_id: l.novig_market_id, reason: "re-verification: the match changed (" + prev.odds_event_id + " " + prev.book_market + " " + prev.line + " -> " + l.odds_event_id + " " + l.book_market + " " + l.line + ")" });
        continue;
      }
      newLinks.push({ market_id: l.novig_market_id, environment: ctx.environment, novig_event_id: l.novig_event_id, novig_market_type: l.novig_market_type, league: e.league,
        sport: MAP.LEAGUES[e.league].sport, odds_event_id: l.odds_event_id, odds_sport_key: l.odds_sport_key, book_market: l.book_market, period: l.period,
        line: l.line == null ? null : Number(l.line), outcomes: l.outcomes, home_team: l.home_team, away_team: l.away_team, kickoff_at: l.kickoff_at,
        novig_starts_at: r.event ? r.event.novig_starts_at : null, kickoff_delta_min: r.event ? r.event.kickoff_delta_min : null, match_confidence: l.match_confidence,
        match_method: l.match_method, constraints: l.constraints, settlement_notes: l.settlement_notes, linker_version: l.linker_version, run_id: ctx.run.run_id });
    }
    /* an active link of this event whose market no longer maps */
    for (const m of markets.filter((x: Any) => x.eventId === e.eventId)) {
      if (active[m.marketId] && !mapped.has(m.marketId)) invalid.push({ market_id: m.marketId, reason: "re-verification: the market no longer matches (" + (r.event_reason || (r.unmapped.find((u: Any) => u.novig_market_id === m.marketId) || {}).reason || "unknown") + ")" });
    }
  }
  if (!ctx.dry) {
    if (newLinks.length) await inChunks(newLinks, 200, (c) => insertOnce("novig_market_links", c, "market_id"));
    for (const x of invalid) await patch("novig_market_links?market_id=eq." + encodeURIComponent(x.market_id) + "&invalidated_at=is.null", { invalidated_at: iso(ctx.nowMs), invalidated_reason: x.reason.slice(0, 300) });
    try { ctx.details.unmapped_queue = await rpc("novig_record_unmapped", { p_environment: ctx.environment, p_rows: unmapped, p_linked: newLinks.map((l: Any) => l.market_id), p_events: events.map((e: Any) => e.eventId) }); }
    catch (e) { ctx.alert("DEGRADED", "unmapped_unrecorded", "the unmapped queue could not be written (" + msg(e) + ")"); }
  }
  const counts: Record<string, number> = {};
  for (const u of unmapped) counts[u.reason] = (counts[u.reason] || 0) + 1;
  Object.assign(ctx.run, { links_new: newLinks.length, links_invalidated: invalid.length, unmapped: unmapped.length });
  ctx.details.unmapped_counts = counts; ctx.details.unsupported_markets = unsupported;
  ctx.out.links = { new: newLinks.length, invalidated: invalid.length, unmapped: unmapped.length, unmapped_counts: counts, sample: newLinks.slice(0, 5).map((l: Any) => ({ market: l.market_id, event: l.odds_event_id, kind: l.book_market, line: l.line, confidence: l.match_confidence })) };
  /* unmapped markets a book prices, starting within 30 h: a warning, at most hourly (a game no book prices is counted, not alerted) */
  const soon = unmapped.filter((u: Any) => u.reason !== "no_book_event" && u.starts_at && msOf(u.starts_at)! - ctx.nowMs < 30 * 3600e3);
  if (soon.length && !ctx.dry) {
    const recent = (await db("novig_alerts?select=id&code=eq.unmapped_markets&created_at=gt." + encodeURIComponent(iso(ctx.nowMs - 3600e3)) + "&limit=1")) || [];
    if (!recent.length) ctx.alert("WARNING", "unmapped_markets", soon.length + " Novig market(s) starting within 30 hours could not be matched: " + Object.entries(counts).map(([k, v]) => k + " " + v).join(", "));
  }
}

/* ---------------------------------------------------------------- snapshot */
/** is this market's book due? (novig_rule snapshot_*: by time to kickoff) */
export function due(lastAt: number | null, kickoffMs: number, nowMs: number) {
  const toKick = kickoffMs - nowMs;
  const every = toKick <= 2 * 3600e3 ? CADENCE.near_minutes : toKick <= 24 * 3600e3 ? CADENCE.mid_minutes : CADENCE.far_minutes;
  /* a minute of slack so a 5-minute cron does not miss a 5-minute cadence by a few seconds */
  return lastAt == null || nowMs - lastAt >= (every - 1) * 60000;
}
const EXEC_STATUS = (s: Any) => [s.status, s.contracts ?? 0, s.total ?? null, s.payout ?? null, s.unspent ?? null, s.vwap ?? null];
/** the stored row of one changed book: top of book, the standard stakes' fills, depth */
export function snapshotOf(market: Any, book: Any, eventStatus: string | null, at: string, environment: string, runId: string) {
  const ids = (market.outcomes || []).map((o: Any) => o.outcomeId);
  const top: Any = {}, exec: Any = {};
  const fee = { coefficient: market.fee_coefficient, makerCredit: market.fee_maker_credit, charged: market.fee_charged };
  const fc = EV.feeCharged(fee, eventStatus);
  for (const id of ids) {
    const bids = EV.levelsOf((book.orders || {})[id]);
    const other = ids.find((x: string) => x !== id);
    const ob = EV.levelsOf((book.orders || {})[other]);
    top[id] = { bid: bids[0] ? EV.milliStr(bids[0].m) : null, bid_qty: bids[0] ? bids[0].qty : null, ask: ob[0] ? EV.milliStr(1000 - ob[0].m) : null, ask_qty: ob[0] ? ob[0].qty : null };
    const q = EV.executableQuote(book, id, ids, { fee, eventStatus });
    exec[id] = {};
    if (q.ok) for (const s of q.stakes) exec[id][String(s.stake_dollars)] = EXEC_STATUS(s);
  }
  return { environment, market_id: market.market_id, captured_at: at, source: "rest_book", book_seq: Number(book.seq), event_status: eventStatus, market_status: market.status,
    fee_charged_now: fc.charged, top, exec, levels: Number(env("NOVIG_BOOK_DEPTH")) || 10, run_id: runId, _depth: EV.compactDepth(book) };
}

async function snapshot(ctx: Any, nv: Any) {
  const at = iso(ctx.nowMs);
  const links = await dbAll("novig_market_links?select=market_id,odds_event_id,book_market,line,outcomes,kickoff_at,league&environment=eq." + ctx.environment
    + "&invalidated_at=is.null&kickoff_at=gte." + encodeURIComponent(iso(ctx.nowMs - 6 * 3600e3)) + "&kickoff_at=lte." + encodeURIComponent(iso(ctx.nowMs + horizonMs())) + "&order=kickoff_at");
  if (!links.length) { ctx.alert("WARNING", "nothing_linked", "no linked Novig market in the window: nothing to snapshot (has discover run?)"); return; }
  const ids = links.map((l: Any) => l.market_id);
  const markets: Record<string, Any> = {};
  for (let i = 0; i < ids.length; i += 150) for (const m of await dbAll("novig_markets?select=market_id,event_id,market_type,status,gone_at,fee_coefficient,fee_maker_credit,fee_charged,outcomes,is_consensus,last_book_seq,last_book_etag,last_snapshot_at&market_id=in." + inList(ids.slice(i, i + 150)) + "&order=market_id")) markets[m.market_id] = m;
  /* the event status decides the fee (WHEN_LIVE charges only OPEN_INGAME): read it fresh, one request per league */
  const evStatus: Record<string, string> = {};
  for (const L of [...new Set(links.map((l: Any) => l.league))] as string[]) {
    try {
      for (const e of await nv.pages("/v3/catalog/events", { league: L, status: LIVE_STATUSES, startsBefore: ctx.nowMs + horizonMs(), limit: 1000 })) evStatus[e.eventId] = e.status;
    } catch (e) { if (fatal(e)) throw e; ctx.alert("DEGRADED", "event_status_unread", L + ": event statuses could not be read; fees treated as unknown (" + msg(e) + ")"); }
  }
  /* which lines DraftKings has quoted for these events in the last day */
  const dkLines = new Set<string>();
  try {
    const evIds = [...new Set(links.map((l: Any) => l.odds_event_id))] as string[];
    for (let i = 0; i < evIds.length; i += 100) for (const r of await dbAll("sharp_price_snapshots?select=event_id,market,point&book=eq.draftkings&event_id=in." + inList(evIds.slice(i, i + 100))
      + "&captured_at=gte." + encodeURIComponent(iso(ctx.nowMs - 864e5)) + "&order=event_id")) dkLines.add(r.event_id + "|" + r.market + "|" + (r.point == null ? "" : Math.abs(Number(r.point))));
  } catch (e) { ctx.alert("WARNING", "dk_lines_unread", "the DraftKings tape could not be read; only moneylines and consensus lines are snapshotted (" + msg(e) + ")"); }
  const wanted = links.filter((l: Any) => {
    const m = markets[l.market_id];
    if (!m || m.gone_at || (m.status && m.status !== "OPEN")) return false;
    if (/^h2h/.test(l.book_market)) return true;
    return m.is_consensus || dkLines.has(l.odds_event_id + "|" + l.book_market + "|" + Math.abs(Number(l.line)));
  });
  const dueList = wanted.filter((l: Any) => due(msOf(markets[l.market_id].last_snapshot_at), msOf(l.kickoff_at) as number, ctx.nowMs))
    .sort((a: Any, b: Any) => (msOf(a.kickoff_at) as number) - (msOf(b.kickoff_at) as number));
  const cap = Number(env("NOVIG_MAX_BOOKS_PER_RUN")) || 240;
  const todo = dueList.slice(0, cap);
  if (dueList.length > cap) ctx.alert("WARNING", "book_cap", dueList.length + " books were due; the nearest " + cap + " were read");
  ctx.details.books_wanted = wanted.length; ctx.details.books_due = dueList.length;
  const budget = Number(env("NOVIG_RUN_BUDGET_MS")) || 110000;
  const rows: Any[] = [], confirm: Any[] = [], gone: string[] = [];
  let read = 0, stopped: Any = null, skippedBudget = 0;
  const depth = Math.min(20, Math.max(1, Number(env("NOVIG_BOOK_DEPTH")) || 10));
  let i = 0;
  const worker = async () => {
    while (i < todo.length && !stopped) {
      const l = todo[i++];
      if (hooks.now() - ctx.startedMs > budget) { skippedBudget++; continue; }
      const m = markets[l.market_id];
      try {
        const r = await nv.req("GET", "/v3/catalog/markets/" + l.market_id + "/book", { depth }, { headers: m.last_book_etag ? { "if-none-match": m.last_book_etag } : {} });
        read++;
        if (r.status === 304 || (r.json && Number(r.json.seq) === Number(m.last_book_seq))) { confirm.push({ market_id: l.market_id, etag: r.etag || m.last_book_etag }); continue; }
        if (!r.json || !r.json.orders || !Number.isFinite(Number(r.json.seq))) { ctx.alert("DRIFT", "book_shape", "a book arrived without seq or orders (" + l.market_id + ")"); continue; }
        rows.push(Object.assign(snapshotOf(m, r.json, evStatus[m.event_id] || null, at, ctx.environment, ctx.run.run_id), { _etag: r.etag || null }));
      } catch (e) {
        if (e instanceof NovigError && e.kind === "not_found") { gone.push(l.market_id); continue; }
        if (fatal(e)) { stopped = stopped || e; continue; }
        ctx.alert("DEGRADED", "book_failed", "a book could not be read (" + l.market_id + "): " + msg(e));
      }
    }
  };
  const n = Math.min(8, Math.max(1, Number(env("NOVIG_CONCURRENCY")) || 4));
  await Promise.all(Array.from({ length: n }, worker));
  let written = 0;
  if (!ctx.dry) {
    for (let k = 0; k < rows.length; k += 50) {
      const chunk = rows.slice(k, k + 50);
      const ins = await insertOnce("novig_book_snapshots", chunk.map((r: Any) => { const { _depth, _etag, ...x } = r; return x; }), "environment,market_id,source,book_seq", true) || [];
      written += ins.length;
      const byKey: Record<string, Any> = {};
      for (const r of chunk) byKey[r.market_id + "|" + r.book_seq] = r;
      const depthRows = ins.map((s: Any) => ({ snapshot_id: s.id, market_id: s.market_id, captured_at: s.captured_at, depth: byKey[s.market_id + "|" + s.book_seq]._depth }));
      if (depthRows.length) await insert("novig_book_depth", depthRows);
    }
    for (const r of rows) await patch("novig_markets?market_id=eq." + encodeURIComponent(r.market_id), { last_book_seq: r.book_seq, last_book_etag: r._etag, last_snapshot_at: at, book_confirmed_at: at, updated_at: at });
    for (const c of confirm) await patch("novig_markets?market_id=eq." + encodeURIComponent(c.market_id), { book_confirmed_at: at, last_snapshot_at: at, last_book_etag: c.etag || null });
    if (gone.length) await patch("novig_markets?market_id=in." + inList(gone), { gone_at: at, status: "CLOSED", updated_at: at });
  } else written = rows.length;
  Object.assign(ctx.run, { books_read: read, snapshots_written: written, snapshots_unchanged: confirm.length });
  ctx.out.snapshot = { linked: links.length, wanted: wanted.length, due: dueList.length, read, written, unchanged: confirm.length, gone: gone.length, captured_at: at };
  if (ctx.dry) ctx.out.sample = rows.slice(0, 3).map((r: Any) => ({ market_id: r.market_id, seq: r.book_seq, top: r.top, exec: r.exec }));
  if (skippedBudget) ctx.alert("WARNING", "run_budget", skippedBudget + " due book(s) were left for the next run (time budget)");
  if (gone.length) ctx.details.markets_gone = gone.length;
  if (stopped) throw stopped;
}

/* ---------------------------------------------------------------- one run */
async function lastHalt(nowMs: number) {
  const r = (await db("novig_sync_runs?select=halt_until,halt_reason&halt_until=gt." + encodeURIComponent(iso(nowMs)) + "&order=halt_until.desc&limit=1")) || [];
  return r[0] || null;
}
/** record a skip at most once per window, so an idle cron does not fill the run log */
async function skipOnce(mode: string, reason: string, nowMs: number, windowMin: number) {
  const recent = (await db("novig_sync_runs?select=run_id&status=eq.skipped&skipped_reason=eq." + encodeURIComponent(reason) + "&finished_at=gt." + encodeURIComponent(iso(nowMs - windowMin * 60000)) + "&limit=1")) || [];
  if (!recent.length) await insert("novig_sync_runs", [{ trigger: "cron", mode, status: "skipped", skipped_reason: reason, started_at: iso(nowMs), finished_at: iso(nowMs) }]);
}

export async function syncOnce(opts: Any = {}) {
  const startedMs = hooks.now();
  const nowMs = opts.dry && opts.now ? Date.parse(opts.now) : startedMs;
  const mode = ["probe", "discover", "snapshot"].includes(opts.mode) ? opts.mode : "snapshot";
  const dry = !!opts.dry;
  const environment = env("NOVIG_ENV");
  const run: Any = { run_id: crypto.randomUUID(), build: BUILD, trigger: opts.trigger || "manual", mode, environment: environment || null, status: "ok", started_at: iso(nowMs) };
  const alerts: Any[] = [];
  const ctx: Any = { run, dry, nowMs, startedMs, environment, out: {}, details: {},
    alert: (severity: string, code: string, message: string, detail?: Any) => alerts.push({ severity, code, message: String(message).slice(0, 600), detail: detail ?? null }) };
  const out: Any = { ok: true, build: BUILD, run_id: run.run_id, mode, dry, environment: environment || null };
  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return Object.assign(out, { ok: false, status: "error", error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this function" });
  /* switched off, or not configured: one skipped run an hour, no Novig call */
  const why = environment !== "production" && environment !== "paper" ? "no_environment"
    : !env("NOVIG_READ_KEY_ID") || !env("NOVIG_READ_PRIVATE_KEY") ? "no_credentials"
    : mode !== "probe" && env("NOVIG_INGEST_ENABLED") !== "true" ? "ingest_disabled" : null;
  if (why) {
    if (!dry) try { await skipOnce(mode, why, nowMs, 60); } catch (e) { out.record_error = msg(e); }
    return Object.assign(out, { status: "skipped", skipped_reason: why,
      hint: why === "no_environment" ? "set NOVIG_ENV=production or paper" : why === "no_credentials" ? "set NOVIG_READ_KEY_ID and NOVIG_READ_PRIVATE_KEY (docs/novig/README.md §Credentials)" : "set NOVIG_INGEST_ENABLED=true" });
  }
  try {
    const halt = await lastHalt(nowMs);
    if (halt) {
      if (!dry) await skipOnce(mode, "halted", nowMs, 30);
      return Object.assign(out, { status: "skipped", skipped_reason: "halted", halted_until: halt.halt_until, halt_reason: halt.halt_reason });
    }
  } catch (e) { return Object.assign(out, { ok: false, status: "error", error: "the run log could not be read: " + msg(e) }); }
  let nv: Any = null;
  try {
    if (!FI || !NS || !EV || !MAP) throw new Error("an inlined core did not load");
    nv = client(ctx);
    await nv.init();
    if (mode === "probe") await probe(ctx, nv);
    else {
      const clock = await nv.syncClock();
      run.clock_offset_ms = clock.offset_ms;
      if (clock.skew === "outside_window") ctx.alert("WARNING", "clock_skew", "this host's clock was " + Math.round(clock.offset_ms / 1000) + " s from Novig's; requests are signed on Novig's time");
      try { const lim = await nv.req("GET", "/v3/limits", {}, { cost: 0 }); if (lim.json && lim.json.read) { nv.bucket.capacity = Number(lim.json.read.capacity) || nv.bucket.capacity; nv.bucket.refill = Number(lim.json.read.refillPerSec) || nv.bucket.refill; nv.bucket.tokens = nv.bucket.capacity; } }
      catch (e) { if (fatal(e)) throw e; }
      if (mode === "discover") await discover(ctx, nv); else await snapshot(ctx, nv);
    }
    if (alerts.some((a) => a.severity === "FAILURE")) run.status = "error";
    else if (alerts.some((a) => a.severity === "DEGRADED" || a.severity === "DRIFT")) run.status = "warn";
  } catch (e) {
    const ne = e instanceof NovigError ? e : null;
    run.status = ne && ne.severity !== "FAILURE" ? "warn" : "error";
    run.message = mode + ": " + msg(e);
    const code = ne ? (ne.kind === "geolocation" ? "geolocation_" + String(ne.code || "451").toLowerCase() : ne.kind === "auth" ? "auth_failed" : ne.kind) : mode + "_error";
    ctx.alert(ne ? ne.severity : "FAILURE", code, run.message, ne ? { status: ne.status, code: ne.code } : null);
    if (ne && ne.halt_minutes > 0) { run.halt_until = iso(hooks.now() + ne.halt_minutes * 60000); run.halt_reason = (ne.status ? ne.status + " " : "") + (ne.code || ne.kind) + ": " + msg(e).slice(0, 200); }
  } finally {
    run.finished_at = iso(Math.max(hooks.now(), nowMs));
    if (nv) Object.assign(run, { requests: nv.requests, requests_not_modified: nv.notModified, rate_limited: nv.rateLimited, clock_offset_ms: run.clock_offset_ms ?? (nv.offsetMs ? nv.offsetMs() : null) });
    if (nv && nv.rateLimited) ctx.alert("WARNING", "rate_limited", nv.rateLimited + " request(s) met Novig's 429 and waited Retry-After");
    if (!run.message) run.message = alerts.filter((a) => a.severity !== "WARNING").map((a) => a.message).join("; ").slice(0, 600) || null;
    run.details = Object.assign({}, ctx.details, { alerts: alerts.map((a) => a.code) });
    Object.assign(out, ctx.out, { status: run.status, alerts, ok: run.status !== "error", halted_until: run.halt_until || null });
    if (!dry) {
      try {
        await insert("novig_sync_runs", [run]);
        if (alerts.length) await insert("novig_alerts", alerts.map((a) => Object.assign({ run_id: run.run_id }, a)));
      } catch (e) { out.ok = false; out.record_error = msg(e); }
    }
    console.log("NOVIG_SYNC", JSON.stringify({ run_id: run.run_id, mode, env: environment, status: run.status, requests: run.requests ?? 0, not_modified: run.requests_not_modified ?? 0,
      links_new: run.links_new ?? null, written: run.snapshots_written ?? null, halt: run.halt_until || null, alerts: alerts.map((a) => a.severity + ":" + a.code) }));
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
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, linker: MAP ? MAP.LINKER_VERSION : null,
    environment: env("NOVIG_ENV") || null, ingest_enabled: env("NOVIG_INGEST_ENABLED") === "true", credentials_set: !!(env("NOVIG_READ_KEY_ID") && env("NOVIG_READ_PRIVATE_KEY")) });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("NOVIG_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "NOVIG_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const mode = String(body.mode || "snapshot");
  if (!["probe", "discover", "snapshot"].includes(mode)) return Response.json({ ok: false, error: "mode must be probe, discover or snapshot" }, { status: 400 });
  const dry = !!body.dry;
  const out = await syncOnce({ mode, dry, now: dry ? body.now : undefined, trigger: body.source === "supabase_cron" ? "cron" : "manual" });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof G.Deno !== "undefined" && G.Deno.serve) G.Deno.serve(handle);
