/* ===========================================================================
   EDGEDESK MARKET STRUCTURE — what a number is worth, how it moved after a
   fixed snapshot, and which situation each side is in. T0 observations and
   T2 deterministic transforms only. docs/market-structure/README.md

     marginFrequency(games, window)
                              the empirical distribution of final NFL margins,
                              absolute and signed by the closing favourite,
                              from settled games we own
                              (football/pricing/lines_nfl.json)
     halfPoint(rows, line)    the push probability AT a spread and the mass that
                              moves when the number moves half a point either
                              way, read off the favourite-signed distribution.
                              Mirrored by public.half_point_value() in
                              supabase/nfl_market_structure.sql; the SQL suite
                              holds the two in parity.
     keyContext(line)         which key numbers a line sits on or straddles,
                              and the Six watch
     keysCrossed(from, to)    which key numbers a move touched (closed interval)
     snapshotDelta(a, b)      the move from a snapshot to a later number, and
                              whether it is flagged
     sides(game)              favourite/underdog, home/road/neutral, divisional,
                              divisional home dog — for both sides
     atsBuckets(games)        season-to-date against-the-spread record of every
                              situational bucket, always with its sample size
     twoPointSeries(weeks)    the league's two-point try share per week and its
                              drift against the prior seasons

   WHAT THIS FILE NEVER DOES
     - price anything. A spread's cover probability depends on THIS game's own
       distribution (EDQuoteEV / football/engine.js); the unconditional league
       distribution here does not know the game, so only the mass that MOVES
       across a half point is reported — never an absolute cover probability.
     - feed a projection, a ranking, an EV or a grade. Every output is
       displayed under Market Structure and read by the registered
       EXPERIMENTAL studies (football/market_structure/preregistration.json);
       none of it reaches the engine until a validation report says so.

   Browser: window.EDMarketStructure. Node: require('./edgedesk_market_structure.js').
   ES5, no dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDMarketStructure = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_market_structure_v1';
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 6 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function isInt(x) { return isNum(x) && Math.abs(x - Math.round(x)) < EPS; }

  /* The football key numbers. The SAME list capture stores crossings against
     (supabase/functions/capture/index.ts KEY_NUMBERS.nfl); the suite fails if
     the two drift apart. */
  var KEY_NUMBERS = [3, 6, 7, 10, 14];
  /* the spreads the Six watch names: the numbers that win, push or lose on a
     six-point margin */
  var SIX_WATCH = [5.5, 6, 6.5];
  /* the recent era is measured separately because the distribution moves */
  var WINDOWS = [
    { label: 'full', first_season: null, note: 'every settled game in the archive' },
    { label: 'recent_2023', first_season: 2023, note: '2023 onward' }
  ];
  var CONFIG = {
    version: 'edgedesk_market_structure_config_v1',
    /* a snapshot move is flagged at a full point, or when it touches a key */
    flag_delta: 1.0,
    /* the default contest-style freeze: Thursday 1:00 PM Eastern for that
       week's slate (supabase/nfl_market_structure.sql market_snapshot_config) */
    snapshot: { sport_key: 'americanfootball_nfl', dow: 4, local_time: '13:00', tz: 'America/New_York' }
  };

  /* Current alignment (since 2002). Code = lib/football_identity.js NFL_TEAMS
     code; nflverse spells the Rams "LA". Seeded identically into
     public.nfl_team_divisions; the suite holds the two equal. */
  var DIVISIONS = [
    ['BUF', 'BUF', 'Buffalo Bills', 'AFC', 'AFC East'], ['MIA', 'MIA', 'Miami Dolphins', 'AFC', 'AFC East'],
    ['NE', 'NE', 'New England Patriots', 'AFC', 'AFC East'], ['NYJ', 'NYJ', 'New York Jets', 'AFC', 'AFC East'],
    ['BAL', 'BAL', 'Baltimore Ravens', 'AFC', 'AFC North'], ['CIN', 'CIN', 'Cincinnati Bengals', 'AFC', 'AFC North'],
    ['CLE', 'CLE', 'Cleveland Browns', 'AFC', 'AFC North'], ['PIT', 'PIT', 'Pittsburgh Steelers', 'AFC', 'AFC North'],
    ['HOU', 'HOU', 'Houston Texans', 'AFC', 'AFC South'], ['IND', 'IND', 'Indianapolis Colts', 'AFC', 'AFC South'],
    ['JAX', 'JAX', 'Jacksonville Jaguars', 'AFC', 'AFC South'], ['TEN', 'TEN', 'Tennessee Titans', 'AFC', 'AFC South'],
    ['DEN', 'DEN', 'Denver Broncos', 'AFC', 'AFC West'], ['KC', 'KC', 'Kansas City Chiefs', 'AFC', 'AFC West'],
    ['LV', 'LV', 'Las Vegas Raiders', 'AFC', 'AFC West'], ['LAC', 'LAC', 'Los Angeles Chargers', 'AFC', 'AFC West'],
    ['DAL', 'DAL', 'Dallas Cowboys', 'NFC', 'NFC East'], ['NYG', 'NYG', 'New York Giants', 'NFC', 'NFC East'],
    ['PHI', 'PHI', 'Philadelphia Eagles', 'NFC', 'NFC East'], ['WAS', 'WAS', 'Washington Commanders', 'NFC', 'NFC East'],
    ['CHI', 'CHI', 'Chicago Bears', 'NFC', 'NFC North'], ['DET', 'DET', 'Detroit Lions', 'NFC', 'NFC North'],
    ['GB', 'GB', 'Green Bay Packers', 'NFC', 'NFC North'], ['MIN', 'MIN', 'Minnesota Vikings', 'NFC', 'NFC North'],
    ['ATL', 'ATL', 'Atlanta Falcons', 'NFC', 'NFC South'], ['CAR', 'CAR', 'Carolina Panthers', 'NFC', 'NFC South'],
    ['NO', 'NO', 'New Orleans Saints', 'NFC', 'NFC South'], ['TB', 'TB', 'Tampa Bay Buccaneers', 'NFC', 'NFC South'],
    ['ARI', 'ARI', 'Arizona Cardinals', 'NFC', 'NFC West'], ['LAR', 'LA', 'Los Angeles Rams', 'NFC', 'NFC West'],
    ['SF', 'SF', 'San Francisco 49ers', 'NFC', 'NFC West'], ['SEA', 'SEA', 'Seattle Seahawks', 'NFC', 'NFC West']
  ];
  /* old and alternate codes for the same franchise (lib/football_identity.js) */
  var CODE_ALIAS = { LA: 'LAR', STL: 'LAR', SL: 'LAR', SD: 'LAC', SDG: 'LAC', OAK: 'LV', LVR: 'LV', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE',
    HST: 'HOU', JAC: 'JAX', KAN: 'KC', KCC: 'KC', NWE: 'NE', NOR: 'NO', NOS: 'NO', SFO: 'SF', TAM: 'TB', TBB: 'TB', WSH: 'WAS', WFT: 'WAS', GNB: 'GB' };
  var DIV_OF = {};
  DIVISIONS.forEach(function (d) { DIV_OF[d[0]] = { code: d[0], nflverse_code: d[1], name: d[2], conference: d[3], division: d[4] }; });
  function teamCode(c) { var s = String(c || '').toUpperCase().replace(/[^A-Z]/g, ''); return DIV_OF[s] ? s : (CODE_ALIAS[s] || null); }
  /* a club's full name as the odds feed spells it ("Los Angeles Rams") → its code */
  var NAME_OF = {};
  DIVISIONS.forEach(function (d) { NAME_OF[d[2].toLowerCase().replace(/[^a-z0-9]+/g, '')] = d[0]; });
  function codeOfName(n) { return NAME_OF[String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '')] || teamCode(n); }
  function division(c) { var k = teamCode(c); return k ? DIV_OF[k] : null; }
  function isDivisional(a, b) { var x = division(a), y = division(b); return !!(x && y && x.code !== y.code && x.division === y.division); }

  /* ================================================== MARGIN FREQUENCY */
  /* games: [{season, margin (home − away), close:{home_line}}] — the archive's
     own sign convention: home_line is what the HOME side lays (negative =
     home favoured). Unplayed games are skipped. */
  function marginFrequency(games, window) {
    window = window || WINDOWS[0];
    var abs = {}, fav = {}, nAbs = 0, nFav = 0, pk = 0, noLine = 0, lo = null, hi = null;
    (games || []).forEach(function (g) {
      var m = num(g && g.margin), s = num(g && g.season);
      if (m == null || s == null) return;
      if (window.first_season != null && s < window.first_season) return;
      if (window.last_season != null && s > window.last_season) return;
      m = Math.round(m);
      abs[Math.abs(m)] = (abs[Math.abs(m)] || 0) + 1; nAbs++;
      lo = lo == null ? s : Math.min(lo, s); hi = hi == null ? s : Math.max(hi, s);
      var hl = num(g.close && g.close.home_line);
      if (hl == null) { noLine++; return; }
      if (Math.abs(hl) < EPS) { pk++; return; }
      /* the favourite's margin: positive = the favourite won by that much */
      var fm = hl < 0 ? m : -m;
      fav[fm] = (fav[fm] || 0) + 1; nFav++;
    });
    function rows(c, n) { return Object.keys(c).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return { margin: k, games: c[k], frequency: r(c[k] / n, 6) }; }); }
    return { window_label: window.label, first_season: lo, last_season: hi,
      abs: { basis: 'abs', n_games: nAbs, rows: nAbs ? rows(abs, nAbs) : [] },
      fav_signed: { basis: 'fav_signed', n_games: nFav, excluded_pickem: pk, excluded_no_line: noLine, rows: nFav ? rows(fav, nFav) : [] } };
  }
  function massMap(rows) { var o = {}; (rows || []).forEach(function (x) { o[x.margin] = num(x.frequency) || 0; }); return o; }

  /* ================================================== HALF-POINT VALUE */
  /* `line` is the spread as the BETTOR holds it: -6 = laying six, +6 =
     getting six. A side pushes when the favourite wins by exactly |line|, so
     the mass that matters is the favourite-signed mass at |line| (at PK: a
     tie). Moving half a point:
       from a whole number, toward the bettor (-6 → -5.5): pushes become wins;
                            against the bettor (-6 → -6.5): pushes become losses;
       from a half point,   toward (-6.5 → -6): losses at 6 become pushes;
                            against (-5.5 → -6): wins at 6 become pushes.
     Every number is a share of games in the window; none is a cover
     probability for this game. */
  function pushMass(M, line) { if (!isInt(line)) return 0; return M[Math.abs(Math.round(line))] || 0; }
  function halfPoint(rows, line, meta) {
    var L = num(line);
    if (L == null || !rows || !rows.length) return null;
    L = Math.round(L * 2) / 2;
    var M = massMap(rows), up = L + 0.5, dn = L - 0.5, whole = isInt(L);
    var mu = whole ? pushMass(M, L) : pushMass(M, up), md = whole ? pushMass(M, L) : pushMass(M, dn);
    return {
      line: L, window_label: meta && meta.window_label || null, games: meta && meta.n_games != null ? meta.n_games : null,
      push_prob: r(pushMass(M, L), 6),
      up: { to_line: up, moved_mass: r(mu, 6), win_change: r(whole ? mu : 0, 6), push_change: r(whole ? -mu : mu, 6), loss_change: r(whole ? 0 : -mu, 6),
        half_push_change: r(0.5 * mu, 7), effect: whole ? 'push_to_win' : 'loss_to_push' },
      down: { to_line: dn, moved_mass: r(md, 6), win_change: r(whole ? 0 : -md, 6), push_change: r(whole ? -md : md, 6), loss_change: r(whole ? md : 0, 6),
        half_push_change: r(-0.5 * md, 7), effect: whole ? 'push_to_loss' : 'win_to_push' }
    };
  }
  /* the same, through EDExecution.halfPointValue's pushWin interface — used
     by the suite as an independent oracle for every line away from PK (at PK
     the favourite flips and the unconditional levels do not compose) */
  function pushWinFrom(rows) {
    var M = massMap(rows), ks = Object.keys(M).map(Number);
    return function (side, line) {
      var L = num(line); if (L == null) return null;
      var win = 0, push = 0, loss = 0;
      ks.forEach(function (m) {
        var f = M[m];
        if (L < 0) { if (m > -L + EPS) win += f; else if (Math.abs(m + L) < EPS) push += f; else loss += f; }
        else { if (m < L - EPS) win += f; else if (Math.abs(m - L) < EPS) push += f; else loss += f; }
      });
      return { win: win, push: push, loss: loss };
    };
  }

  /* ================================================== KEY NUMBERS */
  function keyContext(line) {
    var L = num(line); if (L == null) return null;
    var a = Math.abs(Math.round(L * 2) / 2);
    return { line: L, abs: a,
      on: KEY_NUMBERS.filter(function (k) { return Math.abs(a - k) < EPS; }),
      straddles: KEY_NUMBERS.filter(function (k) { return Math.abs(Math.abs(a - k) - 0.5) < EPS; }),
      six_watch: SIX_WATCH.some(function (s) { return Math.abs(a - s) < EPS; }) };
  }
  /* Closed interval, exactly as capture's keyNumbersCrossed: landing on 3 and
     leaving 3 both count; an unchanged number touches nothing. Lines are
     signed (one side's view), and a key counts at +k or -k, so a move that
     passes through PK (-3.5 → +3.5) touches 3 — where an absolute-value
     comparison would see no move at all. */
  function keysCrossed(from, to) {
    var a = num(from), b = num(to);
    if (a == null || b == null || Math.abs(a - b) < EPS) return [];
    var lo = Math.min(a, b), hi = Math.max(a, b);
    return KEY_NUMBERS.filter(function (k) { return (k >= lo - EPS && k <= hi + EPS) || (-k >= lo - EPS && -k <= hi + EPS); });
  }
  /* a: the snapshot home line, b: a later home line (current or close) */
  function snapshotDelta(a, b) {
    a = num(a); b = num(b);
    if (a == null || b == null) return null;
    var d = r(b - a, 2), crossed = keysCrossed(a, b);
    return { from: a, to: b, delta: d, crossed: crossed, toward: d < 0 ? 'home' : (d > 0 ? 'away' : null),
      flagged: Math.abs(d) >= CONFIG.flag_delta - EPS || crossed.length > 0,
      reasons: (Math.abs(d) >= CONFIG.flag_delta - EPS ? ['moved ' + Math.abs(d) + ' pts'] : []).concat(crossed.map(function (k) { return 'touched ' + k; })) };
  }

  /* ================================================== SITUATIONS */
  /* g: {home, away (codes), home_line (what HOME lays; negative = home
     favoured), neutral, divisional (optional: else from the table)} */
  function sides(g) {
    if (!g) return null;
    var hl = num(g.home_line), neutral = !!g.neutral;
    var div = g.divisional != null ? !!g.divisional : isDivisional(g.home, g.away);
    function one(isHome) {
      var role = hl == null ? null : (Math.abs(hl) < EPS ? 'pickem' : ((isHome ? hl < 0 : hl > 0) ? 'favorite' : 'underdog'));
      var venue = neutral ? 'neutral' : (isHome ? 'home' : 'road');
      var buckets = [];
      if (role === 'favorite' || role === 'underdog') {
        var R = role === 'favorite' ? 'favorites' : 'underdogs';
        buckets.push(R, venue + '_' + R);
        if (div) buckets.push('divisional_' + R);
        if (div && venue === 'home' && role === 'underdog') buckets.push('divisional_home_underdogs');
      }
      return { side: isHome ? 'home' : 'away', team: isHome ? g.home : g.away, role: role, venue: venue, divisional: div,
        divisional_home_dog: div && venue === 'home' && role === 'underdog', buckets: buckets };
    }
    return { home: one(true), away: one(false), divisional: div, neutral: neutral, home_line: hl };
  }
  var BUCKETS = ['favorites', 'underdogs', 'home_favorites', 'home_underdogs', 'road_favorites', 'road_underdogs',
    'neutral_favorites', 'neutral_underdogs', 'divisional_favorites', 'divisional_underdogs', 'divisional_home_underdogs'];
  function wilson(k, n, z) {
    if (!n) return null; z = z || 1.96;
    var p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [r((c - h) / d, 4), r((c + h) / d, 4)];
  }
  /* the home side's result against the closing number: W / L / P */
  function atsHome(margin, homeLine) { var m = num(margin), h = num(homeLine); if (m == null || h == null) return null; var v = m + h; return v > EPS ? 'W' : (v < -EPS ? 'L' : 'P'); }
  /* games: settled games of ONE season [{season, week, date, home, away,
     margin, close:{home_line}, neutral, divisional}] */
  function atsBuckets(games, opts) {
    opts = opts || {};
    var B = {}, through = null, n = 0;
    BUCKETS.forEach(function (k) { B[k] = { w: 0, l: 0, p: 0 }; });
    (games || []).forEach(function (g) {
      if (opts.season != null && num(g.season) !== opts.season) return;
      var res = atsHome(g.margin, g.close && g.close.home_line); if (!res) return;
      var S = sides({ home: g.home, away: g.away, home_line: g.close.home_line, neutral: g.neutral, divisional: g.divisional });
      n++; if (g.date && (!through || g.date > through)) through = g.date;
      [S.home, S.away].forEach(function (s) {
        var mine = s.side === 'home' ? res : (res === 'W' ? 'L' : (res === 'L' ? 'W' : 'P'));
        s.buckets.forEach(function (k) { if (!B[k]) return; if (mine === 'W') B[k].w++; else if (mine === 'L') B[k].l++; else B[k].p++; });
      });
    });
    var out = {};
    BUCKETS.forEach(function (k) { var b = B[k], d = b.w + b.l; out[k] = { w: b.w, l: b.l, p: b.p, n: d + b.p, cover_rate: d ? r(b.w / d, 4) : null, ci95: wilson(b.w, d) }; });
    return { season: opts.season != null ? opts.season : null, through: through, n_games: n, basis: 'closing consensus line (nflverse games.csv), pushes shown and excluded from the rate', buckets: out };
  }

  /* ================================================== TWO-POINT DRIFT */
  /* weeks: [{season, week, season_type, games, xp_att, two_pt_att, two_pt_made, touchdowns}]
     The share is two-point tries over all tries (extra point + two-point). The
     drift compares the season in progress with the pooled prior seasons named
     in `baseline` — a two-proportion z, descriptive only. */
  function twoPointSeries(weeks, opts) {
    opts = opts || {};
    var bySeason = {};
    (weeks || []).forEach(function (w) {
      var s = num(w.season); if (s == null) return;
      var S = bySeason[s] = bySeason[s] || { season: s, games: 0, xp_att: 0, two_pt_att: 0, two_pt_made: 0, touchdowns: 0, weeks: 0 };
      S.games += num(w.games) || 0; S.xp_att += num(w.xp_att) || 0; S.two_pt_att += num(w.two_pt_att) || 0;
      S.two_pt_made += num(w.two_pt_made) || 0; S.touchdowns += num(w.touchdowns) || 0; S.weeks++;
    });
    var seasons = Object.keys(bySeason).map(Number).sort(function (a, b) { return a - b; }).map(function (s) {
      var S = bySeason[s], tries = S.xp_att + S.two_pt_att;
      S.share = tries ? r(S.two_pt_att / tries, 4) : null; S.ci95 = wilson(S.two_pt_att, tries); S.per_game = S.games ? r(S.two_pt_att / S.games, 3) : null;
      return S;
    });
    var cur = opts.current_season != null ? bySeason[opts.current_season] : seasons[seasons.length - 1];
    var drift = null;
    if (cur) {
      var base = (opts.baseline || [cur.season - 3, cur.season - 2, cur.season - 1]).map(function (s) { return bySeason[s]; }).filter(Boolean);
      var bk = 0, bn = 0; base.forEach(function (b) { bk += b.two_pt_att; bn += b.two_pt_att + b.xp_att; });
      var ck = cur.two_pt_att, cn = cur.two_pt_att + cur.xp_att;
      if (bn && cn) {
        var p1 = ck / cn, p0 = bk / bn, pp = (ck + bk) / (cn + bn), se = Math.sqrt(pp * (1 - pp) * (1 / cn + 1 / bn));
        drift = { season: cur.season, share: r(p1, 4), baseline_seasons: base.map(function (b) { return b.season; }), baseline_share: r(p0, 4),
          diff_pp: r(100 * (p1 - p0), 2), z: se > 0 ? r((p1 - p0) / se, 2) : null, n_tries: cn, baseline_tries: bn,
          status: se > 0 && Math.abs((p1 - p0) / se) >= 2 ? (p1 > p0 ? 'RISING' : 'FALLING') : 'STABLE',
          rule: 'share of tries that went for two, season to date vs the pooled prior three seasons; |z| ≥ 2 is reported as a move. Descriptive: it feeds nothing.' };
      }
    }
    return { definition: 'two-point tries ÷ (extra-point tries + two-point tries), nflverse play-by-play; no_play rows (penalties) excluded', seasons: seasons, drift: drift };
  }

  return { VERSION: VERSION, CONFIG: CONFIG, KEY_NUMBERS: KEY_NUMBERS, SIX_WATCH: SIX_WATCH, WINDOWS: WINDOWS, DIVISIONS: DIVISIONS, BUCKETS: BUCKETS,
    teamCode: teamCode, codeOfName: codeOfName, division: division, isDivisional: isDivisional,
    marginFrequency: marginFrequency, halfPoint: halfPoint, pushWinFrom: pushWinFrom,
    keyContext: keyContext, keysCrossed: keysCrossed, snapshotDelta: snapshotDelta,
    sides: sides, atsHome: atsHome, atsBuckets: atsBuckets, wilson: wilson, twoPointSeries: twoPointSeries };
}));
