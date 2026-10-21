/* ===========================================================================
   EdgeDesk NBA MATCHUP GRAPHIC — the football research graphic's template
   (lib/edgedesk_game_graphic.js), filled from one NBA game as nba/slate.json
   priced it. Browser: window.EDNBAGraphic. Node: require().
   docs/engine/NBA.md §10

   content(game, opts) → { ok, content } in the shape EDGameGraphic.layout
   draws, so the NBA picture is the football picture: the EdgeDesk lockup, both
   teams as monogram badges in their colours, three model panels (fair spread,
   projected score, fair total), a market or model-detail strip, what to watch
   for, and the footer.

   THE RULES (the football graphic's, applied to basketball)
     * Every number is the slate's own, from its one distribution: the fair
       spread and fair total (the half-point lines nearest 50/50), the
       moneyline and its win probabilities, each team's expected points
       (overtime included) and the 80% margin range. Nothing is re-estimated.
     * The market strip appears only for a price captured in the last 180
       minutes from a named book, before tip-off, labelled as the reference
       it is. Its gaps set the book's line beside the fair line printed on the
       graphic, so a reader compares two numbers they can see. Otherwise the
       strip is EdgeDesk's own detail: the 80% range, the model moneyline and
       overtime. Never an empty box, never a made-up price.
     * What to watch for is the slate's own evidence: each offence against
       this defence, the ridge model's largest factor, rest or pace, and who
       is playing — from the league's injury report when the card has read
       one, and otherwise a plain statement that no report is in the graphic
       (never last season's rotation presented as tonight's). Each line names
       its team and its size.
     * Research, not picks: the copy rule (EDGameGraphic.BANNED) runs over
       every string.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDNBAGraphic = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var ROOT = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : {});
  var N = { VERSION: 'edgedesk_nba_graphic/1', TEMPLATE: 'nba_matchup_v1', MARKET_LIVE_MIN: 180 };
  N.BANNED = /(bet this|\blocks?\b|guarantee|\bsmash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing)/i;

  /* Team identity is presentation: a monogram in the team's colours (no logo:
     EdgeDesk holds no licence for one). Keys are ESPN's abbreviations, as the
     slate carries them. [nickname, fill, ring, text on fill] */
  N.TEAMS = {
    ATL: ['Hawks', '#E03A3E', '#C1D32F'], BOS: ['Celtics', '#007A33', '#BA9653'], BKN: ['Nets', '#1C1C1C', '#E8E8E8'],
    CHA: ['Hornets', '#1D1160', '#00788C'], CHI: ['Bulls', '#CE1141', '#E8E8E8'], CLE: ['Cavaliers', '#860038', '#FDBB30'],
    DAL: ['Mavericks', '#00538C', '#B8C4CA'], DEN: ['Nuggets', '#0E2240', '#FEC524'], DET: ['Pistons', '#C8102E', '#1D42BA'],
    GS: ['Warriors', '#1D428A', '#FFC72C'], HOU: ['Rockets', '#CE1141', '#C4CED4'], IND: ['Pacers', '#002D62', '#FDBB30'],
    LAC: ['Clippers', '#C8102E', '#1D428A'], LAL: ['Lakers', '#552583', '#FDB927'], MEM: ['Grizzlies', '#5D76A9', '#12173F'],
    MIA: ['Heat', '#98002E', '#F9A01B'], MIL: ['Bucks', '#00471B', '#EEE1C6'], MIN: ['Timberwolves', '#0C2340', '#78BE20'],
    NO: ['Pelicans', '#0C2340', '#C8102E'], NY: ['Knicks', '#006BB6', '#F58426'], OKC: ['Thunder', '#007AC1', '#EF3B24'],
    ORL: ['Magic', '#0077C0', '#C4CED4'], PHI: ['76ers', '#006BB6', '#ED174C'], PHX: ['Suns', '#1D1160', '#E56020'],
    POR: ['Trail Blazers', '#E03A3E', '#E8E8E8'], SAC: ['Kings', '#5A2D81', '#63727A'], SA: ['Spurs', '#1C1C1C', '#C4CED4'],
    TOR: ['Raptors', '#CE1141', '#A1A1A4'], UTAH: ['Jazz', '#4E2A84', '#E8E8E8'], WSH: ['Wizards', '#002B5C', '#E31837']
  };
  var SEASON_LABEL = { R: 'REGULAR SEASON', P: 'PLAYOFFS' };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function str(x) { return x == null ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function am(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v)); }
  function one(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  /* a line as printed: half points, a sign, PK at zero */
  function line(v) { v = num(v); if (v == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '−') + one(Math.abs(v)); }

  /* whole percents that add to 100 (largest remainder), as the football graphic prints them */
  N.split100 = function (pHome) {
    var h = pHome * 100, a = 100 - h, fh = Math.floor(h), fa = Math.floor(a);
    if (fh + fa < 100) { if (h - fh >= a - fa) fh++; else fa++; }
    return { home: fh, away: fa };
  };

  var ET = null;
  try { ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { ET = null; }
  N.dateText = function (iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return 'DATE TBA';
    if (!ET || typeof ET.formatToParts !== 'function') return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    var p = {}; ET.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
    return up(p.weekday + ', ' + p.month + ' ' + p.day) + ' • ' + p.hour + ':' + p.minute + ' ' + up(p.dayPeriod) + ' ET';
  };
  function GG() { if (ROOT.EDGameGraphic) return ROOT.EDGameGraphic; try { return require('./edgedesk_game_graphic.js'); } catch (_) { return null; } }
  /* a book as the football graphic names it ('Draft Kings' from the scoreboard is DraftKings) */
  function bookName(b) { var G = GG(), k = str(b).toLowerCase().replace(/[^a-z_]/g, ''); return (G && G.BOOKS && G.BOOKS[k]) || str(b); }
  function stamp(iso) { var G = GG(); return (G && G.stamp ? G.stamp(iso) : null) || str(iso).slice(0, 16).replace('T', ' ') + ' UTC'; }

  /* t: the slate's team ({ name, abbr }) */
  N.team = function (t, opts) {
    var ab = up((t && (t.abbr || t.name)) || '?'), T = N.TEAMS[ab] || [null, '#3b4a6b', '#8aa0c8'], name = str(t && t.name) || ab;
    var rec = opts && opts.records ? opts.records[ab] : null;
    return { name: up(name), short: up(T[0] || name.split(' ').pop()), abbr: ab, color: T[1], alt: T[2], on: T[3] || '#ffffff', bar: lum(T[1]) < 0.08 ? T[2] : T[1], record: rec ? '(' + rec + ')' : '', rank: '' };
  };
  function rgb(h) { h = str(h).replace('#', ''); return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }) : [0.3, 0.3, 0.4]; }
  function lum(h) { var c = rgb(h).map(function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function near(a, b) { var x = rgb(a), y = rgb(b); return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) < 0.35; }
  N._lum = lum;
  function cap(t) { t = str(t); return t.charAt(0).toUpperCase() + t.slice(1); }
  function nick(T) { return T.short.charAt(0) + T.short.slice(1).toLowerCase().replace(/(\s)(\w)/g, function (m, a, b) { return a + b.toUpperCase(); }); }

  /* ---- what to watch for: the slate's own evidence, each naming a team and a size */
  function scoring(g, H, A) {
    var M = g.matchup || {}, ph = num(M.home_offence_vs_away_defence), pa = num(M.away_offence_vs_home_defence), lg = num(M.league_efficiency);
    if (ph == null || pa == null) return null;
    return { icon: 'hoop', title: 'SCORING MATCHUP', text: H.abbr + ' offence vs ' + A.abbr + ' defence ' + one(ph) + ' pts per 100; ' + A.abbr + ' vs ' + H.abbr + ' ' + one(pa) + (lg != null ? ' (league ' + one(lg) + ')' : '') };
  }
  var DATA_STATE = ['proj_stale', 'gp_h', 'gp_a', 'kal_sd'];
  function topFactor(g, H, A) {
    /* a matchup factor, not a note on the data's state (a carried rotation, games played, rating spread) */
    var x = (g.explanation || []).filter(function (e) { return DATA_STATE.indexOf(e.feature) < 0 && e.kind !== 'reconciliation'; }).sort(function (a, b) { return Math.abs(num(b.points_toward_home) || 0) - Math.abs(num(a.points_toward_home) || 0); })[0];
    var v = x ? num(x.points_toward_home) : null;
    if (v == null || Math.abs(v) < 0.3) return null;
    return { icon: 'bolt', title: 'BIGGEST MODEL FACTOR', text: cap(str(x.label)) + ': ' + Math.abs(v).toFixed(1) + ' pts toward ' + (v >= 0 ? H.abbr : A.abbr) };
  }
  function restOrPace(g, H, A) {
    var M = g.matchup || {}, S = M.schedule || {}, h = S.home || {}, a = S.away || {};
    var rh = num(h.rest_days), ra = num(a.rest_days);
    if (h.back_to_back || a.back_to_back) {
      var both = h.back_to_back && a.back_to_back;
      return { icon: 'clock', title: 'REST', text: both ? 'Both teams on a back-to-back' : (h.back_to_back ? H.abbr : A.abbr) + ' on a back-to-back; ' + (h.back_to_back ? A.abbr + ' ' + (ra == null ? '—' : ra) : H.abbr + ' ' + (rh == null ? '—' : rh)) + ' days rest' };
    }
    if (rh != null && ra != null && Math.abs(rh - ra) >= 2) return { icon: 'clock', title: 'REST', text: (rh > ra ? H.abbr : A.abbr) + ' rested ' + Math.max(rh, ra) + ' days, ' + (rh > ra ? A.abbr : H.abbr) + ' ' + Math.min(rh, ra) };
    var p = num(M.pace), lp = num(M.league_pace);
    if (p == null) return null;
    var d = lp != null ? p - lp : 0;
    return { icon: 'run', title: 'PACE', text: 'Expected ' + one(p) + ' possessions' + (lp != null ? ' vs league ' + one(lp) + (Math.abs(d) < 0.5 ? ': an average pace' : ': ' + one(Math.abs(d)) + (d > 0 ? ' more, a faster game' : ' fewer, a slower game')) : '') };
  }
  /* an ISO time as the report is read on the card: "5:30 PM ET" */
  var ETT = null;
  try { ETT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { ETT = null; }
  function etTime(iso) { var t = Date.parse(iso); if (!isFinite(t)) return ''; return ETT ? ETT.format(new Date(t)) + ' ET' : new Date(t).toISOString().slice(11, 16) + ' UTC'; }
  function surname(n) { var p = str(n).replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(' '); return p.length > 1 ? p.slice(1).join(' ') : str(n); }
  /* WHO IS PLAYING: the league's injury report as the card read it (opts.injury, the
     rpc/nba_injury_card answer). Without a current report it says so, with the check
     time; it never presents last season's rotation as tonight's. */
  function playing(g, H, A, inj) {
    if (inj && inj.state) {
      if (inj.state === 'AVAILABLE' || inj.state === 'FALLBACK' || inj.state === 'PREGAME') {
        var rows = inj.statuses || [], ns = inj.not_submitted || [];
        var part = function (T) {
          if (ns.some(function (x) { return x.team_abbr === T.abbr || nbaId(x.team_id) === T.abbr; })) return T.abbr + ' report not yet submitted';
          var o = rows.filter(function (x) { return x.status === 'OUT' && (x.team_abbr === T.abbr); }).map(function (x) { return surname(x.player_name); });
          return o.length ? T.abbr + ' out: ' + o.slice(0, 4).join(', ') + (o.length > 4 ? ' +' + (o.length - 4) : '') : null;
        };
        var parts = [part(A), part(H)].filter(Boolean), q = rows.filter(function (x) { return x.status === 'QUESTIONABLE' || x.status === 'DOUBTFUL' || x.status === 'UNKNOWN'; }).length;
        var pub = inj.report && (inj.report.latest_seen_published_at || inj.report.published_at);
        var src = inj.state === 'FALLBACK' ? 'ESPN fallback' : 'NBA report' + (pub ? ' ' + etTime(pub) : '');
        return { icon: 'people', title: 'WHO IS PLAYING', text: (parts.length ? parts.join('; ') : 'No ' + A.abbr + ' or ' + H.abbr + ' player listed out') + (q ? '; ' + q + ' uncertain' : '') + ' · ' + src };
      }
      return { icon: 'people', title: 'WHO IS PLAYING', text: A.abbr + '–' + H.abbr + ': injury report not yet available' + (inj.last_check_at ? ' · checked ' + etTime(inj.last_check_at) : '') };
    }
    var sc = (g.scenarios || []).filter(function (x) { return x.kind === 'sits' && num(x.delta_p_home) != null; })
      .sort(function (a, b) { return Math.abs(b.delta_p_home) - Math.abs(a.delta_p_home); })[0];
    var sits = sc ? { icon: 'people', title: 'WHO IS PLAYING', text: 'If ' + sc.player + ' sits: ' + sc.team + ' win chance ' + (sc.delta_p_home * (sc.team === H.abbr ? 100 : -100) <= 0 ? '−' : '+') + (Math.abs(sc.delta_p_home) * 100).toFixed(1) + ' pts' } : null;
    /* no report read for this graphic: a big absence first; otherwise say the report is not in it, never that the old rotation is tonight's */
    if (sits && Math.abs(sc.delta_p_home) >= 0.02) return sits;
    if (g.uncertainty && g.uncertainty.rotation_stale) return { icon: 'people', title: 'WHO IS PLAYING', text: 'No injury report read for this graphic; the price carries each team’s last rotation' };
    return sits;
  }
  var ESPN_ABBR = { 1: 'ATL', 2: 'BOS', 3: 'NO', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GS', 10: 'HOU', 11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NY', 19: 'ORL', 20: 'PHI', 21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SA', 25: 'OKC', 26: 'UTAH', 27: 'WSH', 28: 'TOR', 29: 'MEM', 30: 'CHA' };
  function nbaId(id) { return ESPN_ABBR[String(id)] || null; }

  function imp(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  /* the book's line beside the fair line on the graphic: a gap in points, or agreement */
  function gapText(kind, fair, book, H, A) {
    var d = Math.round((fair - book) * 10) / 10;
    if (kind === 'spread') return d === 0 ? 'Spread: EdgeDesk and the market agree' : 'Spread: EdgeDesk ' + Math.abs(d).toFixed(1) + ' pts toward ' + (d < 0 ? H.abbr : A.abbr);
    return d === 0 ? 'Total: EdgeDesk and the market agree' : 'Total: EdgeDesk ' + Math.abs(d).toFixed(1) + ' pts ' + (d > 0 ? 'higher' : 'lower');
  }
  function marketStrip(mk, g, H, A, now) {
    if (!mk || !mk.book) return null;
    var t = Date.parse(mk.captured_at), start = Date.parse(g.start_utc);
    if (!isFinite(t) || now - t > N.MARKET_LIVE_MIN * 60000 || t > now + 5 * 60000 || (isFinite(start) && t >= start)) return null;
    var P = g.price, ml = mk.moneyline || {}, tot = mk.total || {}, sp = mk.spread || {};
    var out = { title: 'MARKET SNAPSHOT', meta: bookName(mk.book) + (mk.source === 'espn_scoreboard' ? ' via ESPN · reference' : '') + ' · ' + stamp(mk.captured_at), vs: [] };
    var hp = sp.home ? num(sp.home.point) : null, ap = sp.away ? num(sp.away.point) : null;
    if (hp != null && ap != null && Math.abs(hp + ap) < 1e-9) {
      out.home_spread = line(hp); out.away_spread = line(ap);
      out.vs.push(gapText('spread', num(P.spread.fair_line_home), hp, H, A));
    }
    if (num(tot.point) != null) {
      out.total = one(num(tot.point));
      if (num(tot.over) != null && num(tot.under) != null) out.total_prices = 'O ' + am(tot.over) + ' · U ' + am(tot.under);
      out.vs.push(gapText('total', num(P.total.fair_line), num(tot.point), H, A));
    }
    if (num(ml.home) != null && num(ml.away) != null) {
      out.home_ml = am(ml.home); out.away_ml = am(ml.away);
      var ih = imp(ml.home), ia = imp(ml.away);
      if (ih && ia) { var nv = N.split100(ih / (ih + ia)); out.no_vig = { home: nv.home + '%', away: nv.away + '%' }; }
    }
    if (!out.home_ml && !out.total && !out.home_spread) return null;
    out.vs = out.vs.slice(0, 2);
    out.note = mk.source === 'espn_scoreboard' ? 'A REFERENCE PRICE · NOT A VERIFIED QUOTE' : null;
    return out;
  }
  /* the 80% range of the final margin, in words, as football prints it */
  function rangeWords(iv, H, A) {
    if (!Array.isArray(iv) || iv.length < 2 || num(iv[0]) == null || num(iv[1]) == null) return null;
    function w(v) { var r = Math.round(v); return r === 0 ? 'A TIE' : (r > 0 ? H.abbr : A.abbr) + ' BY ' + Math.abs(r); }
    return [w(num(iv[0])), 'TO ' + w(num(iv[1]))];
  }

  /**
   * game: one nba/slate.json game. opts: { now, generated_at (the slate's),
   * model_id, records: { ABBR: 'W-L' }, venue, market (a captured price:
   * book, source, captured_at, moneyline, spread, total), grade
   * (lib/edgedesk_grade_ui entry), validation, frozen_at (a started game: the
   * slate that last priced it before tip), injury (the rpc/nba_injury_card
   * answer: who is out on the league's report, or why there is no report) }
   */
  N.content = function (g, opts) {
    opts = opts || {};
    var P = g && g.price;
    if (!g || !g.home || !g.away || !P || !P.moneyline || !P.spread || !P.total || !P.expected) return { ok: false, reason: 'no_spec', message: 'EdgeDesk holds no NBA price for this game.' };
    var now = num(opts.now) || Date.now(), H = N.team(g.home, opts), A = N.team(g.away, opts);
    if (near(A.bar, H.bar)) A.bar = A.bar === A.alt ? A.color : A.alt;
    if (near(A.bar, H.bar) || lum(A.bar) < 0.03) A.bar = '#9aa6bf';
    var pH = num(P.moneyline.home), wp = N.split100(pH), favH = pH >= 0.5;
    var fl = num(P.spread.fair_line_home), sideT = fl == null || fl === 0 ? null : (fl < 0 ? H : A);
    var ex = P.expected, start = Date.parse(g.start_utc), started = !!opts.frozen_at || (isFinite(start) && now >= start);
    var c = {
      template: N.TEMPLATE, league: 'nba', league_label: 'NBA', week_label: SEASON_LABEL[g.type] || '', surface: 'court',
      snapshot_id: null, away: A, home: H,
      date: N.dateText(g.start_utc), venue: up(opts.venue || ''), context: g.neutral ? 'NEUTRAL SITE' : '',
      started: started, model_available: true, reason: null,
      labels: { center_sub: 'EXPECTED POINTS · OT INCLUDED' },
      spread_team: sideT ? sideT.short : 'PICK’EM', spread_value: line(fl == null ? null : -Math.abs(fl)), spread_text: sideT ? sideT.abbr + ' ' + line(-Math.abs(fl)) : 'PK',
      win: { away: wp.away + '%', home: wp.home + '%', away_pct: wp.away, home_pct: wp.home }, fav_side: favH ? 'home' : 'away',
      scores: { away: one(num(ex.away)), home: one(num(ex.home)), big: true },
      total: one(num(P.total.fair_line)),
      total_sub: { label: 'EXPECTED POINTS', text: num(ex.total).toFixed(2) + ' PTS' },
      points: { away: one(num(ex.away)), home: one(num(ex.home)) },
      fair_ml: { away: am(P.moneyline.away_american), home: am(P.moneyline.home_american) }
    };
    /* the strip: a recent named-book price before tip, or EdgeDesk's own detail */
    c.market = marketStrip(opts.market, g, H, A, now);
    if (!c.market) {
      var cells = [], rg = rangeWords(P.margin_interval_80, H, A);
      if (rg) cells.push({ k: '80% OUTCOME RANGE', v: rg, s: 'final margin, 8 in 10 games' });
      cells.push({ k: 'MODEL MONEYLINE', v: [A.abbr + ' ' + c.fair_ml.away, H.abbr + ' ' + c.fair_ml.home], s: 'model estimate · not a price' });
      if (num(P.p_overtime) != null) cells.push({ k: 'OVERTIME', v: [Math.round(P.p_overtime * 1000) / 10 + '%'], s: 'chance it is tied after 48 minutes' });
      c.detail = { title: 'EDGEDESK MODEL DETAIL', note: 'No recent sportsbook price is shown. Every number here is EdgeDesk’s own.', cells: cells.slice(0, 3) };
    }
    c.insights = [scoring(g, H, A), topFactor(g, H, A), restOrPace(g, H, A), playing(g, H, A, opts.injury)].filter(Boolean).slice(0, 4);
    var gr = opts.grade;
    c.confidence = gr && gr.letter && gr.letter !== 'INSUFFICIENT' ? 'RESEARCH GRADE ' + gr.letter + ' · ' + gr.score + '/100' : 'MONEYLINE: ' + up(str(opts.validation || 'OUTCOME_VALIDATED').replace(/_/g, ' '));
    var early = !!(g.uncertainty && g.uncertainty.early_season);
    c.status = started ? 'PREGAME SNAPSHOT · RESEARCH ONLY' : (early ? 'EARLY SEASON · RESEARCH ONLY' : 'MODEL: ACTIVE · RESEARCH ONLY');
    c.status_tone = !started && early ? 'warn' : 'ok';
    c.fault = null;
    var built = opts.frozen_at || opts.generated_at || g.predicted_at;
    c.snapshot_line = (started ? 'PREGAME SNAPSHOT · ' : 'SNAPSHOT ') + (built ? stamp(built) : '') + (opts.model_id || g.model ? ' · ' + (opts.model_id || g.model) : '') + ' · edgedesksports.com';
    c.tagline = 'RESEARCH NOT PICKS.';
    c.alt = 'EdgeDesk research graphic: ' + cap(nick(A)) + ' at ' + cap(nick(H)) + ', ' + c.date + '. EdgeDesk projects ' + A.abbr + ' ' + c.scores.away + ', ' + H.abbr + ' ' + c.scores.home
      + ' (expected points); fair spread ' + c.spread_text + '; fair total ' + c.total + '; model win probability ' + A.abbr + ' ' + c.win.away + ', ' + H.abbr + ' ' + c.win.home + '. '
      + (c.market ? 'Market snapshot (' + c.market.meta + '): ' + [c.market.home_spread ? 'spread ' + H.abbr + ' ' + c.market.home_spread : null, c.market.total ? 'total ' + c.market.total : null, c.market.home_ml ? 'moneyline ' + A.abbr + ' ' + c.market.away_ml + ', ' + H.abbr + ' ' + c.market.home_ml : null].filter(Boolean).join('; ') + '. ' + c.market.vs.join('. ') + (c.market.vs.length ? '. ' : '') : '')
      + (c.insights.length ? 'What to watch: ' + c.insights.map(function (i) { return i.text; }).join('; ') + '. ' : '') + c.confidence + '. Research, not picks.';
    var strings = [];
    (function walk(v) { if (v == null) return; if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); }); })(c);
    if (strings.some(function (t) { return N.BANNED.test(t); })) return { ok: false, reason: 'copy_rule', message: 'This graphic would break EdgeDesk’s research-only wording rules, so it is not made.' };
    return { ok: true, content: c };
  };
  /* the cache key: the slate that priced the game, the price shown, the grade, the records and venue */
  N.key = function (g, opts) {
    opts = opts || {};
    var mk = opts.market && opts.market.captured_at ? [opts.market.book, opts.market.captured_at].join('/') : 'model-only';
    var inj = opts.injury ? [opts.injury.state, opts.injury.report ? opts.injury.report.id : '', opts.injury.last_check_at || '', (opts.injury.statuses || []).length].join(':') : '';
    return [N.TEMPLATE, g && g.game_id, opts.frozen_at || opts.generated_at || (g && g.predicted_at) || '', mk, opts.grade ? opts.grade.letter + opts.grade.score : '', opts.records ? JSON.stringify(opts.records) : '', opts.venue || '', inj].join('|');
  };
  N.fileName = function (c, format) {
    function slug(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    return 'edgedesk-nba-' + slug(c.away.short) + '-at-' + slug(c.home.short) + '-' + (format || 'square') + '.png';
  };
  /* browser: draw it with the football renderer (layout, canvas, PNG, cache) */
  N.render = function (g, opts, format) {
    var G = GG();
    if (!G || !G.renderContent) return Promise.reject({ ok: false, message: 'the graphic renderer is not loaded' });
    var ct = N.content(g, opts);
    if (!ct.ok) return Promise.reject(ct);
    return G.renderContent(ct.content, N.key(g, opts), format, { now: opts && opts.now }).then(function (r) { r.file_name = N.fileName(ct.content, r.format); return r; });
  };
  N.GG = GG;
  return N;
});
