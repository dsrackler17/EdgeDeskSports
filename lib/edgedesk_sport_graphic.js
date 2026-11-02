/* ===========================================================================
   EdgeDesk MATCHUP GRAPHIC, EVERY OTHER SPORT — the football research
   graphic's template (lib/edgedesk_game_graphic.js) filled from one game of
   men's or women's college basketball, the WNBA, MLB or college baseball, or
   from one UFC bout, as that sport's own model priced it. NFL and CFB
   (lib/edgedesk_game_view.js), the NHL (lib/edgedesk_nhl_graphic.js) and the
   NBA (lib/edgedesk_nba_graphic.js) keep their own builders.
   Browser: window.EDSportGraphic. Node: require(). docs/game-research/SPORTS.md

   ONE PICTURE PER GAME, SO A READER KNOWS WHAT TO RESEARCH AT A GLANCE
     the two sides as monogram badges, EdgeDesk's three numbers (the fair line,
     the projected score, the total), the market beside them when a price is
     on file or EdgeDesk's own detail when not, and WHAT TO WATCH FOR: the
     inputs that move this game's number and the ones the model cannot see.

   THE BUILDERS (each returns { ok, content, key } in EDGameGraphic.layout's shape)
     basketball(game, league, opts)  one basketball/slate.json game (ncaam,
                                     ncaaw, wnba): edgedesk_bb_points_v1
     mlb(row, opts)                  one Baseball-panel MLB row (app.html
                                     mlbxRows: the card game, mlb/engine.js
                                     projectGame, the captured market)
     collegeBaseball(row, opts)      one college row (app.html cbbxRows:
                                     projectCollegeGame)
     ufc(bout, opts)                 one model_loop/published/ufc/current.json
                                     bout: the served UFC Elo and the guard

   THE RULES (the football graphic's, applied to every sport)
     * Every number is the model's own, as its artifact or engine published it.
       The projected score splits the slate's own projected total and margin
       ((total ± margin) / 2), which is that model's distribution read back,
       not a new estimate. A fair price beside a probability is that
       probability with no margin.
     * College baseball is projected, never priced: its graphic carries the
       board's projected runs, total and win probability and no fair line,
       moneyline or run line (app.html cbbBriefHTML says why).
     * A market is shown only as captured, before the start, with its book
       and time; an older capture is LAST KNOWN MARKET. A model whose value
       claims are off (basketball's lab model, baseball, the experimental UFC
       Elo) never prints EDGE: the gap is stated in words and nothing more.
     * What to watch for names a team (or fighter) and a size, from the
       model's inputs, and says plainly what the model does not see
       (availability, a probable starter, a fighter's camp).
     * Research, not picks: the copy rule (BANNED) runs over every string.
     * Team identity is presentation: a monogram badge in the team's colours,
       a stable colour pair from the name where EdgeDesk holds none, and a
       fighter's initials in neutral colours. No logo is drawn.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDSportGraphic = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var ROOT = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  var S = { VERSION: 'edgedesk_sport_graphic/1', MARKET_LIVE_MIN: 180 };
  S.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;
  S.TAGLINE = 'RESEARCH NOT PICKS.';

  /* the header words and the surface each league draws on */
  S.LEAGUES = {
    ncaam: { league: 'ncaam', label: 'NCAAM', week: 'MEN’S BASKETBALL', surface: 'court', template: 'ncaam_matchup_v1', grade: 'NCAAM', unit: 'PTS', route: null },
    ncaaw: { league: 'ncaaw', label: 'NCAAW', week: 'WOMEN’S BASKETBALL', surface: 'court', template: 'ncaaw_matchup_v1', grade: 'NCAAW', unit: 'PTS', route: null },
    wnba: { league: 'wnba', label: 'WNBA', week: '', surface: 'court', template: 'wnba_matchup_v1', grade: 'WNBA', unit: 'PTS', route: null },
    mlb: { league: 'mlb', label: 'MLB', week: '', surface: 'diamond', template: 'mlb_matchup_v1', unit: 'RUNS', route: 'baseball' },
    ncaabase: { league: 'ncaabase', label: 'NCAA BASEBALL', week: 'DIVISION I', surface: 'diamond', template: 'cbase_matchup_v1', unit: 'RUNS', route: 'baseball' },
    mma: { league: 'mma', label: 'UFC', week: '', surface: 'octagon', template: 'ufc_bout_v1', unit: null, route: 'ufc' }
  };

  /* Team colours EdgeDesk holds, by the name each feed prints (the MLB card's
     club names, the basketball slate's WNBA names). [abbr, nickname, fill, ring] */
  S.MLB = {
    'Arizona Diamondbacks': ['ARI', 'D-backs', '#A71930', '#E3D4AD'], 'Athletics': ['ATH', 'Athletics', '#003831', '#EFB21E'], 'Oakland Athletics': ['ATH', 'Athletics', '#003831', '#EFB21E'],
    'Atlanta Braves': ['ATL', 'Braves', '#13274F', '#CE1141'], 'Baltimore Orioles': ['BAL', 'Orioles', '#DF4601', '#1C1C1C'], 'Boston Red Sox': ['BOS', 'Red Sox', '#BD3039', '#0C2340'],
    'Chicago Cubs': ['CHC', 'Cubs', '#0E3386', '#CC3433'], 'Chicago White Sox': ['CWS', 'White Sox', '#27251F', '#C4CED4'], 'Cincinnati Reds': ['CIN', 'Reds', '#C6011F', '#E8E8E8'],
    'Cleveland Guardians': ['CLE', 'Guardians', '#00385D', '#E50022'], 'Colorado Rockies': ['COL', 'Rockies', '#333366', '#C4CED4'], 'Detroit Tigers': ['DET', 'Tigers', '#0C2340', '#FA4616'],
    'Houston Astros': ['HOU', 'Astros', '#002D62', '#EB6E1F'], 'Kansas City Royals': ['KC', 'Royals', '#004687', '#BD9B60'], 'Los Angeles Angels': ['LAA', 'Angels', '#BA0021', '#C4CED4'],
    'Los Angeles Dodgers': ['LAD', 'Dodgers', '#005A9C', '#E8E8E8'], 'Miami Marlins': ['MIA', 'Marlins', '#00A3E0', '#EF3340'], 'Milwaukee Brewers': ['MIL', 'Brewers', '#12284B', '#FFC52F'],
    'Minnesota Twins': ['MIN', 'Twins', '#002B5C', '#D31145'], 'New York Mets': ['NYM', 'Mets', '#002D72', '#FF5910'], 'New York Yankees': ['NYY', 'Yankees', '#0C2340', '#C4CED4'],
    'Philadelphia Phillies': ['PHI', 'Phillies', '#E81828', '#002D72'], 'Pittsburgh Pirates': ['PIT', 'Pirates', '#27251F', '#FDB827'], 'San Diego Padres': ['SD', 'Padres', '#2F241D', '#FFC425'],
    'San Francisco Giants': ['SF', 'Giants', '#27251F', '#FD5A1E'], 'Seattle Mariners': ['SEA', 'Mariners', '#0C2C56', '#005C5C'], 'St. Louis Cardinals': ['STL', 'Cardinals', '#C41E3A', '#0C2340'],
    'Tampa Bay Rays': ['TB', 'Rays', '#092C5C', '#8FBCE6'], 'Texas Rangers': ['TEX', 'Rangers', '#003278', '#C0111F'], 'Toronto Blue Jays': ['TOR', 'Blue Jays', '#134A8E', '#E8291C'],
    'Washington Nationals': ['WSH', 'Nationals', '#AB0003', '#14225A']
  };
  S.WNBA = {
    'Atlanta Dream': ['ATL', 'Dream', '#C8102E', '#418FDE'], 'Chicago Sky': ['CHI', 'Sky', '#418FDE', '#FFCD00'], 'Connecticut Sun': ['CON', 'Sun', '#DC4405', '#0A2240'],
    'Dallas Wings': ['DAL', 'Wings', '#002B5C', '#C4D600'], 'Golden State Valkyries': ['GS', 'Valkyries', '#5B2C83', '#E8E8E8'], 'Indiana Fever': ['IND', 'Fever', '#002D62', '#E03A3E'],
    'Las Vegas Aces': ['LV', 'Aces', '#1C1C1C', '#C8102E'], 'Los Angeles Sparks': ['LA', 'Sparks', '#552583', '#FDB927'], 'Minnesota Lynx': ['MIN', 'Lynx', '#0C2340', '#78BE20'],
    'New York Liberty': ['NY', 'Liberty', '#1C1C1C', '#6ECEB2'], 'Phoenix Mercury': ['PHX', 'Mercury', '#3C286E', '#E56020'], 'Seattle Storm': ['SEA', 'Storm', '#2C5235', '#FEE11A'],
    'Washington Mystics': ['WSH', 'Mystics', '#0C2340', '#C8102E'], 'Toronto Tempo': ['TOR', 'Tempo', '#7A1F3D', '#E8E8E8'], 'Portland Fire': ['POR', 'Fire', '#C8102E', '#1C1C1C']
  };
  /* a stable colour pair for a school EdgeDesk holds no colours for: the same name, the same badge */
  var PALETTE = [['#1d4ed8', '#93c5fd'], ['#b91c1c', '#fca5a5'], ['#047857', '#6ee7b7'], ['#6d28d9', '#c4b5fd'], ['#c2410c', '#fdba74'], ['#0e7490', '#67e8f9'],
    ['#be185d', '#f9a8d4'], ['#4d7c0f', '#bef264'], ['#a16207', '#fde047'], ['#1e3a8a', '#fcd34d'], ['#9f1239', '#e8e8e8'], ['#0f766e', '#fde68a']];
  /* a person is not a team: initials in neutral colours, never a club's */
  var PERSON = [['#334155', '#94a3b8', '#8fb4e6'], ['#3f3f46', '#d4d4d8', '#e2c58f']];

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function str(x) { return x == null ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function one(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function two(v) { return (Math.round(v * 100) / 100).toFixed(2); }
  /* a line as the slate prints it: whole lines whole, half lines with their half, a sign, PK at zero */
  function line(v) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; var a = Math.abs(v); return (v > 0 ? '+' : '−') + (a === Math.round(a) ? String(a) : one(a)); }
  function signed(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + one(Math.abs(v)); }
  function whole(v) { v = num(v); if (v == null) return '—'; return v === Math.round(v) ? String(v) : one(v); }
  /* a probability as a price with no margin (the model's own fair price, never a quote) */
  function fairAm(p) { p = num(p); if (p == null || p <= 0 || p >= 1) return null; return Math.round(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p); }
  function decAm(d) { d = num(d); if (d == null || d <= 1.0001) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function imp(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  function cap(t) { t = str(t); return t.charAt(0).toUpperCase() + t.slice(1); }
  function title(t) { return str(t).toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, function (m, a, b) { return a + b.toUpperCase(); }); }
  function pct(p) { return Math.round(p * 100) + '%'; }

  /* whole percents that add to 100 (largest remainder), as every graphic prints them */
  S.split100 = function (pHome) {
    var h = pHome * 100, a = 100 - h, fh = Math.floor(h), fa = Math.floor(a);
    if (fh + fa < 100) { if (h - fh >= a - fa) fh++; else fa++; }
    return { home: fh, away: fa };
  };

  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { ET = null; }
  S.dateText = function (iso, tbd) {
    var t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!isFinite(t)) return 'DATE TBA';
    if (!ET || typeof ET.formatToParts !== 'function') return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var p = {}; ET.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return up(p.weekday + ', ' + p.month + ' ' + p.day) + (tbd ? ' • TIME TBA' : ' • ' + p.hour + ':' + p.minute + ' ' + up(p.dayPeriod) + ' ET');
  };
  function GG() { if (ROOT.EDGameGraphic) return ROOT.EDGameGraphic; try { return require('./edgedesk_game_graphic.js'); } catch (_) { return null; } }
  function bookName(b) { var G = GG(), k = str(b).toLowerCase().replace(/[^a-z_]/g, ''); return (G && G.BOOKS && G.BOOKS[k]) || str(b); }
  function stamp(iso) { var G = GG(); var s = G && G.stamp ? G.stamp(typeof iso === 'number' ? new Date(iso).toISOString() : iso) : null; return s || str(iso).slice(0, 16).replace('T', ' ') + ' UTC'; }

  /* ------------------------------------------------------------ team identity */
  function rgb(h) { h = str(h).replace('#', ''); return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }) : [0.3, 0.3, 0.4]; }
  function lum(h) { var c = rgb(h).map(function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function near(a, b) { var x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 0.35; }
  function hash(t) { var h = 0; t = str(t).toLowerCase(); for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; }
  /* an abbreviation for a name no feed abbreviated: the initials, or the first letters of one word */
  S.abbrOf = function (name) {
    var w = str(name).replace(/[^A-Za-zÀ-ÿ0-9&' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    if (w.length === 1) return up(w[0]).slice(0, 4);
    return w.slice(0, 4).map(function (x) { return x.charAt(0); }).join('').toUpperCase();
  };
  /* t: { name, short, abbr, record, rank }; T: [abbr, nickname, fill, ring] when EdgeDesk holds colours */
  function teamOf(t, T) {
    var name = str(t && t.name), ab = up((t && t.abbr) || (T && T[0]) || S.abbrOf(name));
    var pal = T ? [T[2], T[3]] : PALETTE[hash(name || ab) % PALETTE.length];
    var short = str(t && t.short) || (T && T[1]) || name || ab;
    var rec = t && t.record && !/^0-0(-0)?$/.test(str(t.record)) ? '(' + t.record + ')' : '';
    var rank = t && num(t.rank) != null && num(t.rank) <= 25 ? '#' + num(t.rank) : '';
    return { name: up(name || ab), short: up(short), abbr: ab.slice(0, 5), color: pal[0], alt: pal[1], on: '#ffffff', bar: lum(pal[0]) < 0.08 ? pal[1] : pal[0], record: rec, rank: rank };
  }
  S.team = teamOf;
  function personOf(f, i, rec) {
    var name = str(f && f.name), parts = name.split(/\s+/).filter(Boolean), P0 = PERSON[i % 2];
    var ini = parts.length > 1 ? (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)) : name.slice(0, 2);
    return { name: up(name), short: up(parts.length > 1 ? parts.slice(1).join(' ') : name), abbr: up(ini), color: P0[0], alt: P0[1], on: '#ffffff', bar: P0[2], record: rec ? '(' + rec + ')' : '', rank: '' };
  }
  /* the away bar must read apart from the home bar on the dark card */
  function separate(A, H) {
    if (near(A.bar, H.bar)) A.bar = A.bar === A.alt ? A.color : A.alt;
    if (near(A.bar, H.bar) || lum(A.bar) < 0.03) A.bar = '#9aa6bf';
  }
  function byName(table, name) {
    if (!name) return null;
    if (table[name]) return table[name];
    var n = str(name).toLowerCase().replace(/[^a-z]/g, ''), hit = null;
    Object.keys(table).forEach(function (k) { if (!hit && k.toLowerCase().replace(/[^a-z]/g, '') === n) hit = table[k]; });
    return hit;
  }

  /* -------------------------------------------------------------- shared parts */
  function winPart(pHome, A, H) {
    var wp = S.split100(pHome), favH = pHome >= 0.5;
    return { win: { away: wp.away + '%', home: wp.home + '%', away_pct: wp.away, home_pct: wp.home }, fav_side: favH ? 'home' : 'away', favH: favH, F: favH ? H : A };
  }
  /* the market strip from a Today's Games price ({ book, source, captured_at,
     moneyline, spread, total }), captured before the start; `fair` is the
     model's { spread_home, total, p_home, unit } for the gap sentences */
  function slateMarket(mk, startIso, now, A, H, fair) {
    if (!mk || !mk.book) return null;
    var t = Date.parse(mk.captured_at), start = Date.parse(startIso);
    if (!isFinite(t) || t > now + 5 * 60000 || (isFinite(start) && t >= start)) return null;
    var ml = mk.moneyline || {}, tot = mk.total || {}, sp = mk.spread || {}, old = now - t > S.MARKET_LIVE_MIN * 60000;
    var out = { title: old ? 'LAST KNOWN MARKET' : 'MARKET SNAPSHOT', state: old ? 'STALE' : 'LIVE', meta: bookName(mk.book) + (mk.source === 'espn_scoreboard' ? ' via ESPN · reference' : '') + ' · ' + stamp(mk.captured_at), vs: [] };
    var hp = sp.home ? num(sp.home.point) : null, ap = sp.away ? num(sp.away.point) : null;
    if (hp != null && ap != null && Math.abs(hp + ap) < 1e-9) {
      out.home_spread = line(hp); out.away_spread = line(ap);
      if (fair.spread_home != null) {
        var d = Math.round((fair.spread_home - hp) * 10) / 10;
        out.vs.push(d === 0 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + Math.abs(d).toFixed(1) + ' ' + fair.unit + ' toward ' + (d < 0 ? H.abbr : A.abbr));
      }
    }
    if (num(tot.point) != null) {
      out.total = whole(num(tot.point));
      if (num(tot.over) != null && num(tot.under) != null) out.total_prices = 'O ' + am(tot.over) + ' · U ' + am(tot.under);
      if (fair.total != null) {
        var td = Math.round((fair.total - num(tot.point)) * 10) / 10;
        out.vs.push(td === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(td).toFixed(1) + ' ' + fair.unit + ' ' + (td > 0 ? 'higher' : 'lower'));
      }
    }
    if (num(ml.home) != null && num(ml.away) != null) {
      out.home_ml = am(ml.home); out.away_ml = am(ml.away);
      var ih = imp(ml.home), ia = imp(ml.away);
      if (ih && ia) {
        var nv = S.split100(ih / (ih + ia)); out.no_vig = { home: nv.home + '%', away: nv.away + '%' };
        if (fair.p_home != null && out.vs.length < 2) { var me = S.split100(fair.p_home), fh = me.home >= 50; out.vs.push('Win %: EdgeDesk ' + (fh ? H.abbr + ' ' + me.home : A.abbr + ' ' + me.away) + '% · market ' + (fh ? nv.home : nv.away) + '%'); }
      }
    }
    if (!out.home_ml && !out.total && !out.home_spread) return null;
    out.vs = out.vs.slice(0, 2);
    out.note = mk.source === 'espn_scoreboard' ? 'A REFERENCE PRICE · NOT A VERIFIED QUOTE' : null;
    return out;
  }
  function rangeWords(lo, hi, A, H) {
    function w(v) { var r = Math.round(v); return r === 0 ? 'A TIE' : (r > 0 ? H.abbr : A.abbr) + ' BY ' + Math.abs(r); }
    return [w(lo), 'TO ' + w(hi)];
  }
  /* the footer, the alt text and the copy rule, the same for every sport */
  function finish(c, o) {
    var started = c.started;
    if (c.neutral_vs) c.at_word = 'VS';
    c.status = started ? 'PREGAME SNAPSHOT · RESEARCH ONLY' : (o.fault ? 'DATA FAULT · RESEARCH ONLY' : (o.early ? 'EARLY SEASON · RESEARCH ONLY' : (o.experimental ? 'EXPERIMENTAL MODEL · RESEARCH ONLY' : 'MODEL: ACTIVE · RESEARCH ONLY')));
    c.status_tone = o.fault ? 'fault' : (!started && (o.early || o.experimental) ? 'warn' : 'ok');
    c.snapshot_line = (started ? 'PREGAME SNAPSHOT · ' : 'SNAPSHOT ') + (o.built ? stamp(o.built) : '') + (o.model ? ' · ' + o.model : '') + ' · edgedesksports.com';
    c.tagline = S.TAGLINE;
    var LB = c.labels || {};
    c.alt = 'EdgeDesk research graphic: ' + title(c.away.name) + (c.neutral_vs ? ' vs ' : ' at ') + title(c.home.name) + ', ' + c.date + '. '
      + (c.model_available
        ? 'EdgeDesk ' + str(LB.center || 'projected score').toLowerCase() + ': ' + c.away.abbr + ' ' + c.scores.away + ', ' + c.home.abbr + ' ' + c.scores.home + '; '
          + str(LB.left || 'fair spread').toLowerCase() + ' ' + c.spread_text + '; ' + str(LB.right || 'fair total').toLowerCase() + ' ' + c.total + '; model win probability ' + c.away.abbr + ' ' + c.win.away + ', ' + c.home.abbr + ' ' + c.win.home + '. '
        : 'No EdgeDesk projection: ' + c.reason + '. ')
      + (c.market ? (c.market.state === 'STALE' ? 'Last known market (' : 'Market snapshot (') + c.market.meta + '): ' + [c.market.home_spread ? (LB.market_spread || 'spread').toLowerCase() + ' ' + c.home.abbr + ' ' + c.market.home_spread : null, c.market.total ? 'total ' + c.market.total : null, c.market.home_ml ? 'moneyline ' + c.away.abbr + ' ' + c.market.away_ml + ', ' + c.home.abbr + ' ' + c.market.home_ml : null].filter(Boolean).join('; ') + '. ' + (c.market.vs.length ? c.market.vs.join('. ') + '. ' : '') : '')
      + (c.fault ? c.fault.charAt(0) + c.fault.slice(1).toLowerCase() + '. ' : '')
      + (c.insights.length ? 'What to watch: ' + c.insights.map(function (i) { return i.text; }).join('; ') + '. ' : '') + c.confidence + '. Research, not picks.';
    var strings = [];
    (function walk(v) { if (v == null) return; if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); }); })(c);
    if (strings.some(function (t) { return S.BANNED.test(t); })) return { ok: false, reason: 'copy_rule', message: 'This graphic would break EdgeDesk’s research-only wording rules, so it is not made.' };
    return { ok: true, content: c, key: [S.VERSION, c.template, o.key].join('|') };
  }
  function base(L, A, H, startIso, o) {
    var now = o.now, start = typeof startIso === 'number' ? startIso : Date.parse(startIso);
    return { template: L.template, league: L.league, league_label: L.label, week_label: o.week != null ? o.week : L.week, surface: L.surface, snapshot_id: null,
      away: A, home: H, date: S.dateText(startIso, o.tbd), venue: up(o.venue || ''), context: o.context || '',
      started: !!o.frozen_at || (isFinite(start) && now >= start), model_available: true, reason: null, fault: null };
  }
  function noProjection(c, reason) {
    c.model_available = false; c.reason = str(reason || 'the model returned no projection for this game').replace(/\.$/, '');
    c.win = { away: '—', home: '—', away_pct: 50, home_pct: 50 }; c.scores = { away: '—', home: '—' }; c.points = { away: '—', home: '—' };
    c.spread_text = '—'; c.total = '—';
    return c;
  }
  function gradeLine(gr, fallback) {
    return gr && gr.letter && gr.letter !== 'INSUFFICIENT' ? 'RESEARCH GRADE ' + gr.letter + ' · ' + gr.score + '/100' : fallback;
  }

  /* ================================================================ BASKETBALL
     g: one basketball/slate.json game (edgedesk_lab_slate_v1); L: its league
     block. opts: { league ('ncaam' | 'ncaaw' | 'wnba'), now, generated_at,
     teams: { home, away } (Today's Games' sides: short name, abbreviation,
     record, rank), venue, context, market (a captured price), grade,
     exhibition, stats: { season, of, home, away } (men's only: each side's
     row in basketball/ncaam_research/published/index.json, last season's
     record and adjusted ratings; null for a team it does not rate) } */
  S.basketball = function (g, L, opts) {
    opts = opts || {};
    var LG = S.LEAGUES[opts.league] || S.LEAGUES.ncaam, P = g && g.prices;
    if (!g || !P || !P.moneyline || !P.spread || !P.total) return { ok: false, reason: 'no_spec', message: 'EdgeDesk holds no ' + LG.label + ' price for this game.' };
    var now = num(opts.now) || Date.now(), T = opts.teams || {};
    var tbl = LG.league === 'wnba' ? S.WNBA : null;
    /* last season's ratings for each side (opts.stats, from the research index): absent for a team it does not rate */
    var ST = opts.stats || null, sH = ST && ST.home && num(ST.home.rank) != null ? ST.home : null, sA = ST && ST.away && num(ST.away.rank) != null ? ST.away : null;
    var sLab = ST && num(ST.season) ? (num(ST.season) - 1) + '-' + String(num(ST.season)).slice(2) : 'LAST SEASON';
    /* a school's own colour from the research index, where the WNBA table does not apply */
    var hue = function (s) { return s && /^#[0-9a-f]{6}$/i.test(str(s.color)) ? [s.abbrev, s.short, s.color, '#e8e8e8'] : null; };
    var H = teamOf({ name: (T.home && T.home.name) || g.home, short: T.home && T.home.short, abbr: T.home && T.home.abbr, record: T.home && T.home.record, rank: T.home && T.home.rank }, tbl ? byName(tbl, g.home) : hue(sH));
    var A = teamOf({ name: (T.away && T.away.name) || g.away, short: T.away && T.away.short, abbr: T.away && T.away.abbr, record: T.away && T.away.record, rank: T.away && T.away.rank }, tbl ? byName(tbl, g.away) : hue(sA));
    separate(A, H);
    var pH = num(P.moneyline.home), W = winPart(pH, A, H);
    var fl = num(P.spread.fair_home_line), M = num(P.spread.projected_margin), Tt = num(P.total.projected), fairT = num(P.total.fair_line);
    var sideT = fl == null || fl === 0 ? null : (fl < 0 ? H : A);
    var ptsH = M != null && Tt != null ? (Tt + M) / 2 : null, ptsA = M != null && Tt != null ? (Tt - M) / 2 : null;
    var neutral = g.neutral === true;
    var c = base(LG, A, H, g.start_utc, { now: now, venue: opts.venue, tbd: opts.tbd, context: [opts.exhibition ? 'EXHIBITION' : '', neutral ? 'NEUTRAL SITE' : '', opts.context || ''].filter(Boolean).join(' · '), week: opts.exhibition ? 'EXHIBITION' : null });
    c.neutral_vs = neutral;
    c.labels = { center_sub: 'EXPECTED POINTS · OT INCLUDED', right_sub: 'EDGEDESK MODEL · NOT A SPORTSBOOK LINE' };
    c.spread_team = sideT ? sideT.short : 'PICK’EM'; c.spread_value = line(fl == null ? null : -Math.abs(fl)); c.spread_text = sideT ? sideT.abbr + ' ' + line(-Math.abs(fl)) : 'PK';
    c.win = W.win; c.fav_side = W.fav_side;
    c.scores = ptsH != null ? { away: one(ptsA), home: one(ptsH), big: true } : { away: '—', home: '—', big: true };
    c.points = c.scores;
    c.total = whole(fairT != null ? fairT : Tt);
    c.total_sub = { label: 'PROJECTED POINTS', text: Tt != null ? one(Tt) + ' PTS' : null };
    c.fair_ml = { away: am(P.moneyline.fair_away), home: am(P.moneyline.fair_home) };
    c.market = slateMarket(opts.market, g.start_utc, now, A, H, { spread_home: fl != null ? (M != null ? -M : fl) : null, total: Tt, p_home: pH, unit: 'pts' });
    if (!c.market) {
      var cells = [];
      var cov = P.spread.lines && P.spread.lines[String(fl)];
      cells.push({ k: 'MODEL MONEYLINE', v: [A.abbr + ' ' + c.fair_ml.away, H.abbr + ' ' + c.fair_ml.home], s: 'model estimate · not a price' });
      if (cov && num(cov.push) != null && num(cov.push) > 0) cells.push({ k: 'PUSH AT ' + c.spread_text, v: [Math.round(cov.push * 1000) / 10 + '%'], s: 'a whole-number line can land exactly' });
      else if (M != null) cells.push({ k: 'PROJECTED MARGIN', v: [M === 0 ? 'EVEN' : (M > 0 ? H.abbr : A.abbr) + ' BY ' + one(Math.abs(M))], s: 'overtime included' });
      var gp = g.inputs && g.inputs.games_this_season;
      if (sA || sH) {
        /* last season's numbers in place of the margin and the sample size, which the panels and what to watch already carry */
        cells = cells.slice(0, 1);
        cells.push({ k: sLab + ' RECORD', v: [A.abbr + ' ' + (sA ? sA.w + '-' + sA.l : '—'), H.abbr + ' ' + (sH ? sH.w + '-' + sH.l : '—')], s: 'last season' });
        cells.push({ k: 'ADJ. NET RATING', v: [A.abbr + ' ' + (sA ? signed(sA.net) + ' (#' + sA.rank + ')' : '—'), H.abbr + ' ' + (sH ? signed(sH.net) + ' (#' + sH.rank + ')' : '—')], s: 'pts per 100 poss. · rank of ' + ST.of });
      } else if (gp && num(gp.home) != null && num(gp.away) != null) cells.push({ k: 'GAMES THIS SEASON', v: [A.abbr + ' ' + gp.away + ' · ' + H.abbr + ' ' + gp.home], s: (g.data_quality && g.data_quality.early_season) || (L && L.early_season) ? 'early: ratings lean on last season' : 'the ratings’ sample' });
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No sportsbook price is on file for this game. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) };
    }
    /* what to watch for: what moves this number, and what the model cannot see */
    var ins = [], dq = g.data_quality || {}, inp = g.inputs || {}, b2b = inp.back_to_back || {}, gp2 = inp.games_this_season || {};
    ins.push({ icon: 'people', title: 'WHO IS PLAYING', text: /UNKNOWN|no availability/i.test(str(dq.lineup)) || !dq.lineup ? 'Not in the number: availability is not modelled. Check both teams’ injury reports and starting lineups' : cap(str(dq.lineup)) });
    if (num(b2b.home) || num(b2b.away)) ins.push({ icon: 'clock', title: 'REST', text: (num(b2b.home) && num(b2b.away) ? 'Both teams on the second night of a back-to-back' : (num(b2b.home) ? H.abbr : A.abbr) + ' on the second night of a back-to-back; ' + (num(b2b.home) ? A.abbr : H.abbr) + ' rested') + ': priced into the number' });
    var early = !!(dq.early_season || (L && L.early_season));
    if (num(gp2.home) != null && num(gp2.away) != null && (early || Math.min(num(gp2.home), num(gp2.away)) < 8)) ins.push({ icon: 'bars', title: 'SAMPLE SIZE', text: A.abbr + ' ' + gp2.away + ' games, ' + H.abbr + ' ' + gp2.home + ' this season: the ratings still lean on last season’s, so roster turnover can move this a lot' });
    else if (early) ins.push({ icon: 'bars', title: 'EARLY SEASON', text: 'Ratings carry last season forward until this season’s games build up: check each roster’s turnover' });
    if (neutral) ins.push({ icon: 'home', title: 'NEUTRAL SITE', text: 'No home court in the number' + (opts.venue ? ' (' + title(opts.venue) + ')' : '') });
    else if (M != null) ins.push({ icon: 'home', title: 'HOME COURT', text: H.abbr + ' at home: the projected margin of ' + (M === 0 ? 'zero' : (M > 0 ? H.abbr : A.abbr) + ' by ' + one(Math.abs(M))) + ' includes home court' });
    if (c.market && c.market.vs.length) ins.push({ icon: 'hoop', title: 'MODEL VS MARKET', text: c.market.vs[0] + '. Ask why the book differs before trusting either' });
    else if (Math.abs(pH - 0.5) < 0.06) ins.push({ icon: 'hoop', title: 'CLOSE CALL', text: 'EdgeDesk has this within ' + Math.abs(Math.round(pH * 100) - 50) + ' points of a coin flip: small inputs decide it' });
    if (sA || sH) {
      /* with last season's ratings: who is playing, then how each team rated and how the two match up,
         then the market and rest before the venue (the sample-size note is folded into the first) */
      var form = function (Tm, s) { return s ? Tm.abbr + ' ' + s.w + '-' + s.l + ' (#' + s.rank + ')' : Tm.abbr + ' unrated'; };
      var keep = ins.filter(function (i) { return i.title !== 'SAMPLE SIZE' && i.title !== 'EARLY SEASON'; });
      var lead = [keep[0], { icon: 'bars', title: sLab + ' RATINGS', text: form(A, sA) + ', ' + form(H, sH) + ' of ' + ST.of + ' by adjusted net rating' + (early ? '. Rosters turn over: check who returned' : '') }];
      if (sA && sH) lead.push({ icon: 'hoop', title: 'OFFENSE VS DEFENSE', text: A.abbr + ' offense #' + sA.rank_o + ' vs ' + H.abbr + ' defense #' + sH.rank_d + '. ' + H.abbr + ' offense #' + sH.rank_o + ' vs ' + A.abbr + ' defense #' + sA.rank_d });
      var rank = { 'MODEL VS MARKET': 0, REST: 1, 'CLOSE CALL': 1 };
      ins = lead.concat(keep.slice(1).sort(function (x, y) { return (rank[x.title] != null ? rank[x.title] : 2) - (rank[y.title] != null ? rank[y.title] : 2); }));
    }
    c.insights = ins.slice(0, 4);
    c.confidence = gradeLine(opts.grade, 'SPREAD: ' + up(str(P.spread.status || 'PROVISIONAL').replace(/_/g, ' ')));
    var mk = opts.market && opts.market.captured_at ? [opts.market.book, opts.market.captured_at].join('/') : 'model-only';
    return finish(c, { early: early, built: opts.generated_at, model: 'edgedesk_bb_points_v1' + (L && L.model ? ':' + L.model.split('+')[0] : ''),
      key: [LG.league, g.game_id, opts.generated_at || '', mk, opts.grade ? opts.grade.letter + opts.grade.score : '', JSON.stringify(T.home || {}), JSON.stringify(T.away || {}), opts.venue || '', ST ? [ST.season, sA ? sA.id + ':' + sA.rank : '', sH ? sH.id + ':' + sH.rank : ''].join(':') : ''].join('|') });
  };

  /* ================================================================ BASEBALL
     row: the Baseball panel's row for one game: { sport, key, g (the card's
     game, or the college board's), p (the engine's projection), mkt (the
     captured market: total_line, over_dec, under_dec, home_ml_dec,
     away_ml_dec, home_fair, home_fair_src, run_line, run_line_dec, book, at,
     stale), noStarter }. opts: { now, model } */
  function baseballCommon(row, opts, LG, sides) {
    var now = num(opts.now) || Date.now(), p = row.p, g = row.g || {};
    var A = sides.A, H = sides.H;
    separate(A, H);
    var c = base(LG, A, H, sides.start, { now: now, venue: sides.venue, tbd: sides.tbd, context: sides.context, week: sides.week });
    c.neutral_vs = !!sides.neutral;
    c.labels = { left: 'FAIR MONEYLINE', left_sub: 'EDGEDESK MODEL · NOT A SPORTSBOOK PRICE', center: 'PROJECTED SCORE', center_sub: 'EXPECTED RUNS', right: 'PROJECTED TOTAL', right_sub: 'EXPECTED RUNS · NOT A SPORTSBOOK LINE', market_spread: 'RUN LINE' };
    if (!p || p.status !== 'PREDICTED' || !p.model) {
      noProjection(c, p && (p.reason ? p.reason + (p.missing && p.missing.length ? ': ' + p.missing.join(', ') : '') : (p.missing && p.missing.length ? 'missing ' + p.missing.join(', ') : null)) || 'the run model did not load');
      c.insights = []; c.confidence = 'RUN MODEL: NOT YET GRADED';
      return c;
    }
    var m = p.model, pH = num(m.home_win_prob), W = winPart(pH, A, H);
    if (sides.noPrice) {
      /* college baseball: projected, never priced (the brief's rule) — the left panel is the run margin, not a moneyline */
      var mg = num(m.home_runs) - num(m.away_runs), MF = mg >= 0 ? H : A;
      c.labels.left = 'PROJECTED MARGIN'; c.labels.left_sub = 'EXPECTED RUNS · NOT A RUN LINE';
      c.spread_team = Math.abs(mg) < 0.05 ? 'EVEN' : MF.short; c.spread_value = Math.abs(mg) < 0.05 ? '0.0' : '+' + one(Math.abs(mg)); c.spread_text = Math.abs(mg) < 0.05 ? 'even' : MF.abbr + ' by ' + one(Math.abs(mg)) + ' runs';
    } else { c.spread_team = W.F.short; c.spread_value = am(W.favH ? m.fair_home_ml : m.fair_away_ml); c.spread_text = W.F.abbr + ' ' + c.spread_value; }
    c.win = W.win; c.fav_side = W.fav_side;
    c.scores = { away: one(num(m.away_runs)), home: one(num(m.home_runs)), big: true };
    c.points = c.scores;
    c.total = two(num(m.fair_total));
    c.total_sub = num(m.total_p10) != null && num(m.total_p90) != null ? { label: '80% OF GAMES', text: m.total_p10 + '–' + m.total_p90 + ' RUNS' } : { label: 'EXPECTED RUNS', text: two(num(m.fair_total)) + ' RUNS' };
    return c;
  }
  function baseballStrip(c, row) {
    var p = row.p, m = p.model, mk = row.mkt || {}, A = c.away, H = c.home, PM = p.market || {};
    var hasPrice = mk.total_line != null || (mk.home_ml_dec != null && mk.away_ml_dec != null) || mk.run_line != null;
    /* a price captured at or after first pitch is a live price, not the pregame market */
    var first = Date.parse((row.g && row.g.start_time) || ''), at = typeof mk.at === 'number' ? mk.at : Date.parse(mk.at);
    if (hasPrice && mk.book && isFinite(at) && !(isFinite(first) && at >= first)) {
      var out = { title: mk.stale ? 'LAST KNOWN MARKET' : 'MARKET SNAPSHOT', state: mk.stale ? 'STALE' : 'LIVE', meta: bookName(mk.book) + ' · ' + stamp(mk.at), vs: [] };
      if (mk.run_line != null && Math.abs(num(mk.run_line)) === 1.5) {
        var rl = num(mk.run_line), rp = decAm(mk.run_line_dec);
        out.home_spread = line(rl) + (rp != null ? ' ' + am(rp) : ''); out.away_spread = line(-rl);
      }
      if (mk.total_line != null) {
        out.total = whole(num(mk.total_line));
        var o = decAm(mk.over_dec), u = decAm(mk.under_dec);
        if (o != null && u != null) out.total_prices = 'O ' + am(o) + ' · U ' + am(u);
        if (PM.total_gap != null) out.vs.push(PM.total_gap === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(PM.total_gap).toFixed(2) + ' runs ' + (PM.total_gap > 0 ? 'higher' : 'lower'));
      }
      var ha = decAm(mk.home_ml_dec), aa = decAm(mk.away_ml_dec);
      if (ha != null && aa != null) { out.home_ml = am(ha); out.away_ml = am(aa); }
      if (num(PM.consensus_fair_home) != null) {
        var nv = S.split100(num(PM.consensus_fair_home)); out.no_vig = { home: nv.home + '%', away: nv.away + '%' };
        var me = S.split100(num(m.home_win_prob)), fh = me.home >= 50;
        out.vs.push('Win %: EdgeDesk ' + (fh ? H.abbr + ' ' + me.home : A.abbr + ' ' + me.away) + '% · market ' + (fh ? nv.home : nv.away) + '%');
      }
      out.vs = out.vs.slice(0, 2);
      out.note = 'A CAPTURED PRICE · ' + (mk.stale ? 'NOT ONE YOU CAN TAKE NOW' : 'CHECK YOUR BOOK');
      if (out.home_ml || out.total || out.home_spread) return { market: out };
    }
    var cells = [], fav = num(m.home_runs) >= num(m.away_runs);
    if (c.league === 'ncaabase') {
      /* no price of any kind: what the clubs' rates are against the league, and the spread of outcomes */
      var C = p.components || {}, rate = function (v) { return v == null ? '—' : Math.round(v * 100) + '%'; };
      if (num(C.away_offense_factor) != null) cells.push({ k: 'OFFENSE VS LEAGUE', v: [A.abbr + ' ' + rate(num(C.away_offense_factor)) + ' · ' + H.abbr + ' ' + rate(num(C.home_offense_factor))], s: 'runs scored, after the schedule' });
      if (num(C.away_defense_factor) != null) cells.push({ k: 'RUNS ALLOWED VS LEAGUE', v: [A.abbr + ' ' + rate(num(C.away_defense_factor)) + ' · ' + H.abbr + ' ' + rate(num(C.home_defense_factor))], s: 'under 100% is better' });
      if (num(m.total_p50) != null) cells.push({ k: 'MEDIAN TOTAL', v: [m.total_p50 + ' RUNS'], s: 'half of games score more' });
      return { detail: { title: 'EDGEDESK MODEL DETAIL', note: 'No sportsbook prices college baseball, and EdgeDesk turns none of these numbers into a price.', cells: cells.slice(0, 3) } };
    }
    if (num(m.run_line_cover_prob) != null) {
      var cp = num(m.run_line_cover_prob), favCover = num(m.run_line) < 0 ? cp : 1 - cp, F2 = fav ? H : A, D2 = fav ? A : H;
      cells.push({ k: 'MODEL RUN LINE', v: [F2.abbr + ' −1.5 ' + am(fairAm(favCover)), D2.abbr + ' +1.5 ' + am(fairAm(1 - favCover))], s: 'model estimate · not a price' });
    }
    cells.push({ k: 'MODEL MONEYLINE', v: [A.abbr + ' ' + am(m.fair_away_ml), H.abbr + ' ' + am(m.fair_home_ml)], s: 'model estimate · not a price' });
    if (num(m.total_p50) != null) cells.push({ k: 'MEDIAN TOTAL', v: [m.total_p50 + ' RUNS'], s: 'half of games score more' });
    return { detail: { title: 'EDGEDESK MODEL DETAIL', note: c.league === 'ncaabase' ? 'No sportsbook price is captured for college baseball. Every number here is EdgeDesk’s own.' : 'No sportsbook price is joined to this game. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) } };
  }
  function offenseInsight(p, A, H) {
    var best = null;
    [['away', A], ['home', H]].forEach(function (s) {
      ((p.contributions && p.contributions[s[0]]) || []).forEach(function (t) {
        if (t.k !== 'offense' || num(t.v) == null) return;
        var d = num(t.v) - 1;
        if (!best || Math.abs(d) > Math.abs(best.d)) best = { d: d, T: s[1], t: t.t };
      });
    });
    if (!best || Math.abs(best.d) < 0.03) return null;
    return { icon: 'bars', title: 'OFFENSE', text: best.T.abbr + ' score ' + Math.round(Math.abs(best.d) * 100) + '% ' + (best.d > 0 ? 'above' : 'below') + ' the league rate' + (best.t ? ' (' + str(best.t).split(',')[0] + ')' : '') };
  }
  function parkInsight(p, g) {
    var C = p.components || {}, pf = num(C.park_factor), wf = num(C.weather_factor), parts = [];
    if (pf != null) parts.push('park index ' + Math.round(pf * 100) + (pf >= 1.04 ? ' (a hitters’ park)' : pf <= 0.96 ? ' (a pitchers’ park)' : ''));
    if (g && (g.is_dome === true || /closed|fixed|dome/i.test(str(g.roof_type)))) parts.push('roof closed: weather out of play');
    else {
      if (num(g && g.temp_f) != null) parts.push(Math.round(g.temp_f) + '°F');
      if (num(g && g.wind_mph) != null && num(g.wind_mph) >= 8) parts.push('wind ' + Math.round(g.wind_mph) + ' mph' + (g.wind_rel || g.wind_dir ? ' (' + str(g.wind_rel || g.wind_dir) + ')' : ''));
      if (num(g && g.precip_prob) != null && num(g.precip_prob) >= 30) parts.push(Math.round(g.precip_prob) + '% rain');
    }
    if (wf != null && Math.abs(wf - 1) >= 0.01) parts.push('runs ×' + wf.toFixed(2) + ' for weather');
    if (!parts.length) return (C.weather_blind && C.weather_blind.length) ? { icon: 'cloud', title: 'PARK & WEATHER', text: 'No forecast on file: check the weather and the roof before first pitch' } : null;
    return { icon: 'cloud', title: 'PARK & WEATHER', text: cap(parts.join('; ')) };
  }

  S.mlb = function (row, opts) {
    opts = opts || {};
    if (!row || !row.g) return { ok: false, reason: 'no_spec', message: 'EdgeDesk holds no MLB game for this graphic.' };
    var g = row.g, LG = S.LEAGUES.mlb;
    var H = teamOf({ name: g.home_team_name, record: g.home_record }, byName(S.MLB, g.home_team_name));
    var A = teamOf({ name: g.away_team_name, record: g.away_record }, byName(S.MLB, g.away_team_name));
    var week = num(g.series_game_number) != null && num(g.games_in_series) != null ? 'SERIES GAME ' + g.series_game_number + ' OF ' + g.games_in_series : '';
    var c = baseballCommon(row, opts, LG, { A: A, H: H, start: g.start_time || (g.game_date ? g.game_date + 'T23:00:00Z' : null), venue: g.venue, week: week,
      tbd: !g.start_time, context: g.doubleheader && g.doubleheader !== 'N' && num(g.game_number) ? 'GAME ' + g.game_number + ' OF A DOUBLEHEADER' : '' });
    var p = row.p;
    if (c.model_available) {
      var s = baseballStrip(c, row); c.market = s.market || null; c.detail = s.detail || null;
      var ins = [];
      var sp = function (n, th) { return n ? surname(n) + (th ? ' (' + up(th).charAt(0) + ')' : '') : null; };
      var as = sp(g.away_pitcher_name, g.away_pitcher_throws), hs = sp(g.home_pitcher_name, g.home_pitcher_throws);
      ins.push({ icon: 'baseball', title: 'STARTING PITCHERS', text: as && hs ? 'Probable, not confirmed: ' + A.abbr + ' ' + as + ' · ' + H.abbr + ' ' + hs + '. A late scratch moves this number'
        : (as || hs ? (as ? A.abbr + ' ' + as : H.abbr + ' ' + hs) + ' probable; ' + (as ? H.abbr : A.abbr) + ' has no starter posted, so its whole staff carries the game' : 'No starter posted for either club: each staff’s rate carries the game. Check before first pitch') });
      var oi = offenseInsight(p, A, H); if (oi) ins.push(oi);
      var pk = parkInsight(p, g); if (pk) ins.push(pk);
      var e = p.edge || {}, recT = e.total && e.total.recommendation, recM = e.moneyline && e.moneyline.recommendation;
      if (recT === 'DATA_FAULT' || recM === 'DATA_FAULT') { c.fault = 'MODEL AND MARKET TOO FAR APART: A DATA FAULT'; c.market = null; }
      else if (recT === 'RESEARCH_LEAN' || recM === 'RESEARCH_LEAN') ins.push({ icon: 'bolt', title: 'MODEL VS MARKET', text: 'Past the review threshold' + (recT === 'RESEARCH_LEAN' && p.market.total_gap != null ? ' on the total (' + (p.market.total_gap > 0 ? '+' : '−') + Math.abs(p.market.total_gap).toFixed(2) + ' runs)' : ' on the moneyline') + ': a reason to open the game, not an edge' });
      else if (!c.market) ins.push({ icon: 'bolt', title: 'MARKET', text: 'No price joined: set ' + c.total + ' runs and ' + c.spread_text + ' against your book' });
      c.insights = ins.slice(0, 4);
      c.confidence = 'RUN MODEL: NOT YET GRADED';
    }
    return finish(c, { fault: !!c.fault, experimental: true, built: p && p.prediction_timestamp, model: (p && p.model_version) || 'MLB run model',
      key: ['mlb', row.key, p ? p.fingerprint || p.prediction_timestamp : 'none', row.mkt && row.mkt.at ? [row.mkt.book, row.mkt.at, row.mkt.stale ? 's' : ''].join('/') : 'model-only', g.home_pitcher_name || '', g.away_pitcher_name || ''].join('|') });
  };
  function surname(n) { var p = str(n).replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(' '); return p.length > 1 ? p.slice(1).join(' ') : str(n); }

  S.collegeBaseball = function (row, opts) {
    opts = opts || {};
    if (!row || !row.g || !row.g.home || !row.g.away) return { ok: false, reason: 'no_spec', message: 'EdgeDesk holds no college baseball game for this graphic.' };
    var g = row.g, LG = S.LEAGUES.ncaabase;
    var H = teamOf({ name: g.home.name, record: g.home.record }, null), A = teamOf({ name: g.away.name, record: g.away.record }, null);
    var c = baseballCommon(row, opts, LG, { A: A, H: H, start: g.start_time || (g.date ? g.date + 'T17:00:00Z' : null), venue: g.venue, tbd: !g.start_time || g.start_time_tbd,
      neutral: !!g.neutral_site, context: g.neutral_site ? 'NEUTRAL SITE' : '', noPrice: true });
    var p = row.p;
    if (c.model_available) {
      var s = baseballStrip(c, row); c.market = s.market || null; c.detail = s.detail || null;
      var C = p.components || {}, ins = [];
      ins.push({ icon: 'baseball', title: 'STARTING PITCHERS', text: 'Not in the number: college starters are not posted in the feed. Check each club’s weekend rotation' });
      var fac = [['away', A, 'offense', num(C.away_offense_factor)], ['home', H, 'offense', num(C.home_offense_factor)], ['away', A, 'defense', num(C.away_defense_factor)], ['home', H, 'defense', num(C.home_defense_factor)]]
        .filter(function (x) { return x[3] != null; }).sort(function (x, y) { return Math.abs(y[3] - 1) - Math.abs(x[3] - 1); });
      fac.slice(0, 1).forEach(function (x) {
        var d = x[3] - 1;
        if (Math.abs(d) >= 0.05) ins.push({ icon: x[2] === 'offense' ? 'bars' : 'shield', title: x[2] === 'offense' ? 'OFFENSE' : 'RUN PREVENTION', text: x[1].abbr + (x[2] === 'offense' ? ' score ' : ' allow ') + Math.round(Math.abs(d) * 100) + '% ' + (d > 0 ? 'more' : 'fewer') + ' runs than the league rate, after its schedule' });
      });
      var cn = [C.away_conference_note ? A.abbr + ': ' + C.away_conference_note : null, C.home_conference_note ? H.abbr + ': ' + C.home_conference_note : null].filter(Boolean);
      if (cn.length) ins.push({ icon: 'flag', title: 'CONFERENCE STRENGTH', text: cn.join('; ') });
      /* the starter line above already says what the feed lacks */
      var wq = ((p.data_quality && p.data_quality.warnings) || []).filter(function (w) { return !/starter|pitcher/i.test(str(w)); });
      if (wq.length) ins.push({ icon: 'alert', title: 'DATA CHECK', text: cap(str(wq[0]).replace(/\.$/, '')) });
      else ins.push({ icon: 'bolt', title: 'NOT A PRICE', text: 'An unvalidated run model, never graded against a line: ' + c.total + ' runs is a question to research, not a price' });
      c.insights = ins.slice(0, 4);
      c.confidence = 'RUN MODEL: NOT YET GRADED';
    }
    return finish(c, { experimental: true, built: p && p.prediction_timestamp, model: (p && p.model_version) || 'college run model',
      key: ['ncaabase', row.key, p ? p.fingerprint || p.prediction_timestamp : 'none'].join('|') });
  };

  /* ===================================================================== UFC
     b: one model_loop/published/ufc/current.json bout. opts: { now,
     generated_at, version (the served Elo's), records: { fighter id:
     'W-L-D' } (the slate's, for the main event), venue, title (the card) }.
     fighter_a is drawn on the left (the "away" side), fighter_b on the right. */
  S.ufc = function (b, opts) {
    opts = opts || {};
    if (!b || !b.fighter_a || !b.fighter_b || num(b.p_a) == null) return { ok: false, reason: 'no_spec', message: 'EdgeDesk’s UFC model has no number for this bout.' };
    var LG = S.LEAGUES.mma, now = num(opts.now) || Date.now(), R = opts.records || {};
    var fa = b.fighter_a, fb = b.fighter_b, Fa = fa.factors || {}, Fb = fb.factors || {};
    var recA = R[fa.id] || (num(Fa.pre_w) != null ? Fa.pre_w + '-' + (num(Fa.pre_l) || 0) + ' PRE-UFC' : ''), recB = R[fb.id] || (num(Fb.pre_w) != null ? Fb.pre_w + '-' + (num(Fb.pre_l) || 0) + ' PRE-UFC' : '');
    var A = personOf(fa, 0, R[fa.id] || ''), H = personOf(fb, 1, R[fb.id] || '');
    if (!R[fa.id] && recA) A.record = '(' + recA + ')';
    if (!R[fb.id] && recB) H.record = '(' + recB + ')';
    var pB = 1 - num(b.p_a), W = winPart(pB, A, H);
    var c = base(LG, A, H, b.start, { now: now, venue: opts.venue, week: up(b.weight_class || ''), context: up(opts.title || b.event || '') });
    c.neutral_vs = true;
    c.labels = { left: 'FAIR MONEYLINE', left_sub: 'EDGEDESK MODEL · NOT A SPORTSBOOK PRICE', center: 'UFC BOUTS IN THE DATA', center_sub: 'EACH FIGHTER’S UFC SAMPLE · 0 = DEBUT', right: 'MODEL VS MARKET', right_sub: 'POINTS OF WIN PROBABILITY' };
    c.spread_team = W.F.short; c.spread_value = am(fairAm(W.favH ? pB : num(b.p_a))); c.spread_text = W.F.abbr + ' ' + c.spread_value;
    c.win = W.win; c.fav_side = W.fav_side;
    c.scores = { away: String(num(fa.ufc_bouts_in_data) != null ? fa.ufc_bouts_in_data : (num(Fa.ufc_bouts) != null ? Fa.ufc_bouts : '—')), home: String(num(fb.ufc_bouts_in_data) != null ? fb.ufc_bouts_in_data : (num(Fb.ufc_bouts) != null ? Fb.ufc_bouts : '—')), big: true };
    c.points = c.scores;
    var mk = b.market || null, gd = b.guard || {}, gap = num(gd.gap_pp);
    c.total = gap == null ? '—' : (gap === 0 ? '0.0' : (gap > 0 ? '+' : '−') + Math.abs(gap).toFixed(1));
    c.total_sub = { label: gap == null ? 'NO PRICE ON FILE' : 'ON ' + up(surname(fa.name)) + ' · ' + (gd.status === 'DISAGREES' ? 'MODEL DISAGREES' : 'WITHIN ' + (num(gd.threshold_pp) || 8) + ' PTS'), text: gap == null ? 'MODEL ONLY' : (gd.status === 'DISAGREES' ? 'CHECK WHY' : 'AGREES') };
    if (mk && num(mk.p_a) != null && mk.observed_at && Date.parse(mk.observed_at) < Date.parse(b.start)) {
      var old = now - Date.parse(mk.observed_at) > S.MARKET_LIVE_MIN * 60000, nv = S.split100(1 - num(mk.p_a));
      c.market = { title: old ? 'LAST KNOWN MARKET' : 'MARKET SNAPSHOT', state: old ? 'STALE' : 'LIVE', meta: bookName(mk.book) + ' via ESPN · ' + stamp(mk.observed_at), vs: [] };
      if (num(mk.price_a) != null && num(mk.price_b) != null) { c.market.away_ml = am(mk.price_a); c.market.home_ml = am(mk.price_b); }
      c.market.no_vig = { away: nv.away + '%', home: nv.home + '%' };
      var me = S.split100(pB), fh = me.home >= 50;
      c.market.vs.push('Win %: EdgeDesk ' + (fh ? H.abbr + ' ' + me.home : A.abbr + ' ' + me.away) + '% · market ' + (fh ? nv.home : nv.away) + '%');
      if (gd.label) c.market.vs.push(cap(str(gd.label)));
      c.market.note = gd.status === 'DISAGREES' ? 'A LARGE GAP IS A QUESTION, NOT AN EDGE' : 'A REFERENCE PRICE · NOT A VERIFIED QUOTE';
    } else {
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No sportsbook price is on file for this bout. Every number here is EdgeDesk’s own.', cells: [
        { k: 'MODEL MONEYLINE', v: [A.abbr + ' ' + am(fairAm(num(b.p_a))), H.abbr + ' ' + am(fairAm(pB))], s: 'model estimate · not a price' },
        /\b(debut|prior)\b/i.test(str(b.basis)) ? { k: 'BASIS', v: ['A DEBUT'], s: 'priced from the pre-UFC record' } : { k: 'BASIS', v: ['UFC RESULTS'], s: 'Elo from every earlier UFC bout' }] };
      if (b.compare && num(b.compare.p_a) != null) c.detail.cells.push({ k: 'PRIOR VERSION', v: [A.abbr + ' ' + pct(num(b.compare.p_a))], s: 'UFC Elo ' + b.compare.version + ' said' });
    }
    var ins = [];
    (gd.factors || []).slice(0, 2).forEach(function (f) { var t = typeof f === 'string' ? f : f.text; if (t) ins.push({ icon: 'alert', title: 'WHY THE MODEL MAY MISREAD IT', text: cap(t) }); });
    if (b.basis && /debut|prior/i.test(b.basis)) ins.push({ icon: 'people', title: 'DEBUT', text: cap(str(b.basis)) + ': little UFC evidence behind the number' });
    var lay = [[A, num(Fa.days_off)], [H, num(Fb.days_off)]].filter(function (x) { return x[1] != null && x[1] >= 365; }).sort(function (x, y) { return y[1] - x[1]; })[0];
    if (lay) ins.push({ icon: 'clock', title: 'LAYOFF', text: cap(title(lay[0].short)) + ' has been out ' + Math.round(lay[1] / 30.4) + ' months: ring rust is not in the number' });
    var aa = num(Fa.age), ab = num(Fb.age);
    if (aa != null && ab != null && Math.abs(aa - ab) >= 5) ins.push({ icon: 'bars', title: 'AGE', text: title(A.short) + ' ' + Math.floor(aa) + ', ' + title(H.short) + ' ' + Math.floor(ab) + ': the model prices age by division' });
    /* what no fight model sees keeps its place whatever else the bout carries */
    c.insights = ins.slice(0, 3).concat([{ icon: 'glove', title: 'NOT IN THE NUMBER', text: 'Weight cut, short notice, injuries and the camp: check the fight-week news' }]);
    c.confidence = 'UFC ELO ' + (opts.version || '') + ': EXPERIMENTAL';
    return finish(c, { experimental: true, built: opts.generated_at, model: 'UFC Elo ' + (opts.version || ''),
      key: ['mma', b.bout_id, opts.generated_at || '', mk ? mk.observed_at : '', JSON.stringify(R[fa.id] || ''), JSON.stringify(R[fb.id] || '')].join('|') });
  };

  /* =============================================================== RENDERING */
  S.fileName = function (c, format) {
    function slug(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    return 'edgedesk-' + slug(c.league) + '-' + slug(c.away.name) + (c.neutral_vs ? '-vs-' : '-at-') + slug(c.home.name) + '-' + (format || 'square') + '.png';
  };
  /* built: a builder's { ok, content, key }. Drawn with the football renderer (layout, canvas, PNG, cache) */
  S.render = function (built, format) {
    var G = GG();
    if (!G || !G.renderContent) return Promise.reject({ ok: false, message: 'the graphic renderer is not loaded' });
    if (!built || !built.ok) return Promise.reject(built || { ok: false, message: 'no graphic' });
    return G.renderContent(built.content, built.key, format).then(function (r) { r.file_name = S.fileName(built.content, r.format); return r; });
  };

  /* ================================================================== BLOCK
     mount(host, spec): the graphic block every page shows, as football's
     research page does: the picture, Square / Portrait, Download PNG, Share
     and Copy link. spec: { id (the game), build () → a builder's result or a
     promise of one, link (the URL Copy link copies), title (optional) }. The
     format is kept across games for the session. */
  S.format = 'square';
  function esc(s) { return str(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function shell(st) {
    var F = S.format;
    return '<section class="sg-gfx" aria-label="Matchup graphic">' + (st.spec.title ? '<div class="sg-hd"><b>' + esc(st.spec.title) + '</b><span>What EdgeDesk’s model sees, and what to research</span></div>' : '')
      + '<figure class="gv-fig" style="aspect-ratio:' + (F === 'portrait' ? '1080/1350' : '1/1') + '"><div class="gv-skel gv-figskel"></div><img data-sg-img alt="" hidden></figure>'
      + '<div class="gv-fmt" role="group" aria-label="Graphic format">' + ['square', 'portrait'].map(function (f) { return '<button type="button" class="gv-seg' + (F === f ? ' on' : '') + '" aria-pressed="' + (F === f) + '" data-sg-act="fmt" data-v="' + f + '">' + (f === 'square' ? 'Square 1080×1080' : 'Portrait 1080×1350') + '</button>'; }).join('') + '</div>'
      + '<div class="gv-acts"><button type="button" class="gv-btn gv-primary" data-sg-act="dl">Download PNG</button><button type="button" class="gv-btn" data-sg-act="share">Share</button><button type="button" class="gv-btn" data-sg-act="copy">Copy link</button></div>'
      + '<div class="gv-msg" data-sg-msg role="status" aria-live="polite"></div></section>';
  }
  function msg(host, t) { var m = host.querySelector('[data-sg-msg]'); if (m) m.textContent = t; }
  function fail(host, t) { var fig = host.querySelector('.gv-fig'); if (fig) fig.outerHTML = '<div class="gv-empty">' + esc(t) + '</div>'; var a = host.querySelector('.gv-acts'), f = host.querySelector('.gv-fmt'); if (a) a.hidden = true; if (f) f.hidden = true; }
  function draw(host, st) {
    var tok = st.tok = (st.tok || 0) + 1, fmt = S.format;
    st.p = Promise.resolve().then(function () { return st.spec.build(); }).then(function (built) {
      if (!built || !built.ok) throw built || { message: 'no graphic for this game' };
      return S.render(built, fmt);
    }).then(function (r) {
      if (st.tok !== tok) return r;
      st.r = r;
      var im = host.querySelector('[data-sg-img]');
      if (im) { im.src = r.url; im.alt = r.alt; im.hidden = false; var sk = im.parentNode.querySelector('.gv-figskel'); if (sk) sk.remove(); }
      return r;
    }).catch(function (e) {
      if (st.tok !== tok) return null;
      st.r = null;
      fail(host, (e && (e.message || e.reason)) ? (e.message || e.reason) : 'The graphic could not be drawn. Every number elsewhere on this page is unaffected.');
      return null;
    });
    return st.p;
  }
  function act(host, st, a, v) {
    if (a === 'fmt') {
      S.format = v === 'portrait' ? 'portrait' : 'square'; S.mount(host, st.spec);
      /* the buttons were redrawn: keep the keyboard on the one just pressed (a dialog's Escape needs focus inside it) */
      var b = host.querySelector('[data-sg-act="fmt"][data-v="' + S.format + '"]'); if (b) try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); }
      return;
    }
    var link = typeof st.spec.link === 'function' ? st.spec.link() : st.spec.link;
    var Nv = ROOT.navigator;
    if (a === 'copy') { if (Nv && Nv.clipboard && Nv.clipboard.writeText && link) Nv.clipboard.writeText(link).then(function () { msg(host, 'Link copied: ' + link); }, function () { msg(host, link); }); else msg(host, link || 'No link for this game.'); return; }
    msg(host, 'Drawing the graphic…');
    (st.p || draw(host, st)).then(function (r) {
      if (!r) { msg(host, 'The graphic could not be drawn.'); return; }
      if (a === 'dl') { var x = document.createElement('a'); x.href = r.url; x.download = r.file_name; document.body.appendChild(x); x.click(); x.remove(); msg(host, 'Saved ' + r.file_name + '.'); return; }
      var file = null, text = 'EdgeDesk research: ' + title(r.content.away.short) + (r.content.neutral_vs ? ' vs ' : ' at ') + title(r.content.home.short) + ' · ' + r.content.spread_text + ', ' + str((r.content.labels && r.content.labels.right) || 'total').toLowerCase() + ' ' + r.content.total + '. Research, not picks.';
      try { if (r.blob && typeof File === 'function') file = new File([r.blob], r.file_name, { type: 'image/png' }); } catch (_) { file = null; }
      msg(host, '');
      if (Nv && Nv.share && file && Nv.canShare && Nv.canShare({ files: [file] })) return Nv.share({ files: [file], title: 'EdgeDesk research', text: text, url: link || undefined }).catch(function () { /* the reader closed the sheet */ });
      if (Nv && Nv.share) return Nv.share({ title: 'EdgeDesk research', text: text, url: link || undefined }).catch(function () { /* closed */ });
      act(host, st, 'copy'); msg(host, 'Sharing is not available in this browser: the link was copied. Use Download PNG for the image.');
    });
  }
  S.mount = function (host, spec) {
    if (!host || !spec || typeof spec.build !== 'function') return null;
    var st = host.__edsg || (host.__edsg = {});
    st.spec = spec;
    host.innerHTML = shell(st);
    if (!st.bound) {
      st.bound = true;
      host.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-sg-act]') : null;
        if (!b || !host.contains(b)) return;
        ev.preventDefault(); ev.stopPropagation();
        act(host, host.__edsg, b.getAttribute('data-sg-act'), b.getAttribute('data-v'));
      });
    }
    draw(host, st);
    return st;
  };

  /* ================================================================= DATA
     The artifacts the browser builders read, fetched once per ten minutes
     and shared by every block on the page. */
  S.FILES = { basketball: '/basketball/slate.json', ufc: '/model_loop/published/ufc/current.json', ncaam_teams: '/basketball/ncaam_research/published/index.json' };
  var DATA = {};
  S.load = function (k) {
    var d = DATA[k], now = Date.now();
    if (d && (d.p && !d.at || now - d.at < 10 * 60000)) return d.p;
    var url = S.FILES[k] + '?v=' + Math.floor(now / 600000);
    var p = fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(S.FILES[k] + ' answered HTTP ' + r.status); return r.json(); });
    DATA[k] = { p: p, at: 0 };
    p.then(function () { DATA[k].at = Date.now(); }, function () { delete DATA[k]; });
    return p;
  };
  /* the lab slate's game for a Today's Games event: ESPN's id, and the same two teams on the same sides */
  S.labGame = function (slate, league, e) {
    var L = slate && slate.schema === 'edgedesk_lab_slate_v1' && slate.leagues ? slate.leagues[league] : null;
    if (!L || !e) return { ok: false, message: 'EdgeDesk’s basketball slate has no ' + (S.LEAGUES[league] ? S.LEAGUES[league].label : league) + ' league.' };
    var g = (L.games || []).filter(function (x) { return String(x.game_id) === String(e.provider_id); })[0];
    if (!g) return { ok: false, L: L, message: 'EdgeDesk has not priced this game yet: its basketball slate prices the games in the next ' + (slate.horizon_hours || 72) + ' hours, and the graphic appears once this one is on it.' };
    var hid = e.home && e.home.id != null ? String(e.home.id) : null, aid = e.away && e.away.id != null ? String(e.away.id) : null;
    if (hid && aid && g.home_id && g.away_id && (String(g.home_id) !== hid || String(g.away_id) !== aid)) {
      /* at a neutral site under the home-games-only intercept (basketball/walkforward.js interceptOn) the model
         prices the two teams the same whichever is listed first, so the slate's game is read with the schedule's
         sides. Anywhere else the sides decide home court, and a disagreement is not drawn over */
      var same = String(g.home_id) === aid && String(g.away_id) === hid;
      if (same && g.neutral === true && /home_intercept/.test(str(L.calibration_version))) return { ok: true, g: S.flipGame(g), L: L, flipped: true };
      return { ok: false, L: L, message: 'The schedule and EdgeDesk’s slate list this game’s sides the other way round, so no graphic is drawn.' };
    }
    return { ok: true, g: g, L: L };
  };
  /* a lab slate game with its home and away sides exchanged: every price and input moves to its team, and a
     line priced for the home side at L is the same line for the other side at −L */
  S.flipGame = function (g) {
    var f = JSON.parse(JSON.stringify(g)), P = f.prices || {};
    function sw(o, a, b) { if (o) { var t = o[a]; o[a] = o[b]; o[b] = t; } }
    function neg(v) { return v == null ? v : (v === 0 ? 0 : -v); }
    sw(f, 'home', 'away'); sw(f, 'home_id', 'away_id');
    if (P.moneyline) { sw(P.moneyline, 'home', 'away'); sw(P.moneyline, 'fair_home', 'fair_away'); }
    if (P.spread) {
      P.spread.projected_margin = neg(P.spread.projected_margin); P.spread.fair_home_line = neg(P.spread.fair_home_line);
      var ln = {};
      Object.keys(P.spread.lines || {}).forEach(function (k) { var o = P.spread.lines[k]; ln[String(neg(Number(k)))] = { home_cover: o.away_cover, push: o.push, away_cover: o.home_cover, fair_home: o.fair_away, fair_away: o.fair_home }; });
      if (P.spread.lines) P.spread.lines = ln;
    }
    var I = f.inputs || {};
    sw(I.back_to_back, 'home', 'away'); sw(I.games_this_season, 'home', 'away');
    return f;
  };
  /* one team's row in the men's research index (ESPN's id), or null */
  S.teamStats = function (index, id) {
    if (!index || index.schema !== 'edgedesk_ncaam_index_v1' || id == null) return null;
    return (index.teams || []).filter(function (t) { return String(t.id) === String(id); })[0] || null;
  };
  /* a Today's Games event's graphic, built from the sport's own artifact (opts: { now, market, grade }) */
  S.forEvent = function (e, opts) {
    opts = opts || {};
    if (!e) return Promise.resolve({ ok: false, message: 'no game' });
    if (e.sport === 'ncaam' || e.sport === 'ncaaw' || e.sport === 'wnba') {
      /* the men's research index adds last season's ratings; the graphic draws without them when it cannot be read */
      var idx = e.sport === 'ncaam' ? S.load('ncaam_teams').then(null, function () { return null; }) : Promise.resolve(null);
      return Promise.all([S.load('basketball'), idx]).then(function (got) {
        var slate = got[0], index = got[1];
        var hit = S.labGame(slate, e.sport, e);
        if (!hit.ok) return hit;
        var stats = index ? { season: index.season, of: (index.teams || []).length, home: S.teamStats(index, hit.g.home_id), away: S.teamStats(index, hit.g.away_id) } : null;
        return S.basketball(hit.g, hit.L, { league: e.sport, now: opts.now, generated_at: slate.generated_at, teams: { home: e.home, away: e.away }, venue: e.venue, tbd: e.time_tbd,
          context: (e.notes || [])[0] ? up(e.notes[0]) : '', market: opts.market, grade: opts.grade, exhibition: !!(hit.g.exhibition || hit.g.event === 'exhibition'), stats: stats });
      });
    }
    if (e.sport === 'mma') {
      return S.load('ufc').then(function (cur) {
        var bouts = S.cardBouts(cur, e.provider_id);
        if (!bouts.length) return { ok: false, message: 'EdgeDesk’s UFC model has not priced this card yet.' };
        var hid = e.home && String(e.home.id), aid = e.away && String(e.away.id);
        var b = bouts.filter(function (x) { var i = [String(x.fighter_a.id), String(x.fighter_b.id)]; return i.indexOf(hid) >= 0 && i.indexOf(aid) >= 0; })[0] || bouts[bouts.length - 1];
        var rec = {}; if (e.home && e.home.record) rec[hid] = e.home.record; if (e.away && e.away.record) rec[aid] = e.away.record;
        return S.ufc(opts.bout ? (bouts.filter(function (x) { return x.bout_id === opts.bout; })[0] || b) : b, { now: opts.now, generated_at: cur.generated_at, version: cur.served && cur.served.version, records: rec, venue: e.venue, title: e.title });
      });
    }
    return Promise.resolve({ ok: false, message: 'This sport’s graphic is on its research page.' });
  };
  /* the served model's bouts on one ESPN card, in the card's own order (the main event last) */
  S.cardBouts = function (cur, eventId) {
    if (!cur || cur.schema !== 'edgedesk_model_loop_ufc_current_v1') return [];
    return (cur.bouts || []).filter(function (b) { return b && (eventId == null || String(b.event_id) === String(eventId)) && b.fighter_a && b.fighter_b && num(b.p_a) != null; });
  };
  S.SPORTS_WITH_BLOCK = { ncaam: 1, ncaaw: 1, wnba: 1, mma: 1 };
  /* a card's main event: the bout between the two headliners (ids) when given,
     else the bout whose two surnames the card's own name carries */
  S.mainEvent = function (list, ids) {
    var by = function (f) { return (list || []).filter(f)[0] || null; };
    if (ids && ids[0] != null && ids[1] != null) {
      var m = by(function (b) { var i = [String(b.fighter_a.id), String(b.fighter_b.id)]; return i.indexOf(String(ids[0])) >= 0 && i.indexOf(String(ids[1])) >= 0; });
      if (m) return m;
    }
    function norm(t) { return str(t).normalize ? str(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : str(t).toLowerCase(); }
    return by(function (b) { var ev = norm(b.event); return ev.indexOf(norm(surname(b.fighter_a.name))) >= 0 && ev.indexOf(norm(surname(b.fighter_b.name))) >= 0; });
  };

  /* ============================================================ A UFC CARD
     mountCard(host, o): every bout the served UFC Elo prices on one card (or
     on every upcoming card), a chip per bout and the chosen bout's graphic
     under them. o: { eventId (null: every card still to come), bout (the
     chip to open; else `main`, the card's two headliners' ids, else the
     last bout listed), records: { fighter id: 'W-L-D' }, venue, card (its
     name), heading (the block's), link (bout id → URL), now, onReady (called
     with the number of bouts found) } */
  S.mountCard = function (host, o) {
    if (!host) return;
    o = o || {};
    host.innerHTML = '<div class="sg-card"><div class="gv-skel" style="height:40px"></div></div>';
    S.load('ufc').then(function (cur) {
      var now = num(o.now) || Date.now();
      var bouts = S.cardBouts(cur, o.eventId).filter(function (b) { return o.eventId != null || Date.parse(b.start) > now - 6 * 3600000; });
      if (typeof o.onReady === 'function') try { o.onReady(bouts.length); } catch (_) { /* the page's own */ }
      if (!bouts.length) { host.innerHTML = o.eventId != null ? '<p class="sg-note">EdgeDesk’s UFC model has not priced this card yet.</p>' : ''; return; }
      var cards = {}, order = [];
      bouts.forEach(function (b) { if (!cards[b.event_id]) { cards[b.event_id] = []; order.push(b.event_id); } cards[b.event_id].push(b); });
      /* each card's main event first: the two headliners the schedule names, else the two surnames in the card's name ("Moicano vs. Nolan") */
      order.forEach(function (ev) {
        var list = cards[ev], m = S.mainEvent(list, ev === String(o.eventId) ? o.main : null);
        if (m) cards[ev] = [m].concat(list.filter(function (b) { return b !== m; }));
      });
      var pick = bouts.filter(function (b) { return b.bout_id === o.bout; })[0] || cards[order[0]][0];
      var chips = order.map(function (ev) {
        return (order.length > 1 ? '<div class="sg-evt">' + esc(cards[ev][0].event || 'UFC') + ' · ' + esc(S.dateText(cards[ev][0].start).split(' • ')[0]) + '</div>' : '')
          + '<div class="sg-chips" role="group" aria-label="Bouts">' + cards[ev].map(function (b, i) {
            var on = b.bout_id === pick.bout_id, dis = b.guard && b.guard.status === 'DISAGREES';
            return '<button type="button" class="sg-chip' + (on ? ' on' : '') + (dis ? ' dis' : '') + '" aria-pressed="' + on + '" data-sg-bout="' + esc(b.bout_id) + '" title="' + esc(b.weight_class || '') + (dis ? ' · model disagrees with market' : '') + '">' + (i === 0 && S.mainEvent([b], null) ? '<b>Main</b> ' : '') + esc(surname(b.fighter_a.name)) + ' v ' + esc(surname(b.fighter_b.name)) + '</button>';
          }).join('') + '</div>';
      }).join('');
      host.innerHTML = '<div class="sg-card">' + chips + '<div data-sg-slot></div></div>';
      if (!host.__sgcard) {
        host.__sgcard = true;
        host.addEventListener('click', function (ev) {
          var c = ev.target && ev.target.closest ? ev.target.closest('[data-sg-bout]') : null;
          if (!c || !host.contains(c)) return;
          ev.preventDefault(); ev.stopPropagation();
          S.mountCard(host, Object.assign({}, host.__sgopts, { bout: c.getAttribute('data-sg-bout'), focus: true }));
        });
      }
      host.__sgopts = o;
      /* the chips were redrawn: keep the keyboard on the one just chosen */
      if (o.focus) { var f = host.querySelector('[data-sg-bout="' + pick.bout_id + '"]'); if (f) try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); } }
      S.mount(host.querySelector('[data-sg-slot]'), { id: pick.bout_id, title: o.heading || null,
        link: typeof o.link === 'function' ? o.link(pick.bout_id) : o.link,
        build: function () { return S.ufc(pick, { now: now, generated_at: cur.generated_at, version: cur.served && cur.served.version, records: o.records || {}, venue: o.venue, title: o.card || pick.event }); } });
    }, function (e) {
      if (typeof o.onReady === 'function') try { o.onReady(0); } catch (_) { /* the page's own */ }
      host.innerHTML = '<p class="sg-note">The UFC model file could not be read (' + esc((e && e.message) || e) + '), so no fight graphic is drawn.</p>';
    });
  };
  S._lum = lum;
  S.GG = GG;
  return S;
});
