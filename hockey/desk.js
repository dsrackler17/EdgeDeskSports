/*__EDNHLDESK_START__*/
/* ===========================================================================
   EdgeDesk NHL ON THE DESK — NHL questions answered from the published slate
   (hockey/slate.json), deterministically, with no model call.

   ONE FILE, TWO HOSTS. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts (nhlTurn)
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

     "What's your price on Bruins at Leafs?" · "Is Detroit -140 any good
     tonight?" · "NHL puck line for the Penguins" · "Best NHL bet tonight?"

   What it says: my fair moneyline, puck line and total for the game, the
   goalie situation and how far it moves the number, the record behind the
   probabilities, and — for a quoted price — the break-even, my probability
   and the EV at that price. What it never says: that anything is a bet.
   NHL value claims are off until the model beats closing prices, and the
   answer says so in every case. Research, not picks.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDNHLDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_nhl_desk_v1';
  var SLATE_SCHEMA = 'edgedesk_nhl_slate_v1';
  /* abbreviation → names a reader uses. `ambiguous` nicknames are also another
     league's (Jets, Kings, Panthers, Rangers, Stars, Wild?), so they count only
     with hockey context or an NHL game on screen. Kept in step with
     hockey/data/teams.json by tools/hockey/nhl_desk.test.js. */
  var CLUBS = {
    ANA: ['anaheim ducks', 'ducks', 'anaheim'], BOS: ['boston bruins', 'bruins'], BUF: ['buffalo sabres', 'sabres'], CAR: ['carolina hurricanes', 'hurricanes', 'canes'],
    CBJ: ['columbus blue jackets', 'blue jackets', 'columbus'], CGY: ['calgary flames', 'flames', 'calgary'], CHI: ['chicago blackhawks', 'blackhawks'], COL: ['colorado avalanche', 'avalanche', 'avs'],
    DAL: ['dallas stars'], DET: ['detroit red wings', 'red wings'], EDM: ['edmonton oilers', 'oilers', 'edmonton'], FLA: ['florida panthers'],
    LAK: ['los angeles kings', 'la kings'], MIN: ['minnesota wild'], MTL: ['montreal canadiens', 'canadiens', 'habs', 'montreal'], NJD: ['new jersey devils', 'devils'],
    NSH: ['nashville predators', 'predators', 'preds'], NYI: ['new york islanders', 'islanders', 'isles'], NYR: ['new york rangers'], OTT: ['ottawa senators', 'senators', 'sens', 'ottawa'],
    PHI: ['philadelphia flyers', 'flyers'], PIT: ['pittsburgh penguins', 'penguins', 'pens'], SEA: ['seattle kraken', 'kraken'], SJS: ['san jose sharks', 'sharks'],
    STL: ['st louis blues', 'blues'], TBL: ['tampa bay lightning', 'lightning', 'bolts'], TOR: ['toronto maple leafs', 'maple leafs', 'leafs'], UTA: ['utah mammoth', 'mammoth', 'utah hockey club'],
    VAN: ['vancouver canucks', 'canucks', 'vancouver'], VGK: ['vegas golden knights', 'golden knights', 'knights'], WPG: ['winnipeg jets', 'winnipeg'], WSH: ['washington capitals', 'capitals', 'caps']
  };
  /* nicknames another league shares, and city names (Detroit is also the Lions,
     Pistons and Tigers): they count only with hockey context or an NHL game on screen */
  var AMBIGUOUS = { NYR: ['rangers', 'ny rangers'], LAK: ['kings', 'los angeles', 'la'], WPG: ['jets'], FLA: ['panthers', 'florida'], DAL: ['stars', 'dallas'], MIN: ['wild', 'minnesota'],
    BOS: ['boston'], BUF: ['buffalo'], CAR: ['carolina'], CHI: ['chicago'], COL: ['colorado'], DET: ['detroit'], NJD: ['new jersey'], NSH: ['nashville'],
    PHI: ['philadelphia', 'philly'], PIT: ['pittsburgh'], SEA: ['seattle'], SJS: ['san jose'], STL: ['st louis'], TBL: ['tampa bay', 'tampa'], TOR: ['toronto'],
    UTA: ['utah'], VGK: ['vegas'], WSH: ['washington'], NYI: ['ny islanders'] };
  var HOCKEY = /\b(nhl|hockey|puck ?line|goalie|goaltender|power ?play|shootout|60[- ]minute|regulation)\b/i;
  var PRICE_WORDS = /\b(price|odds|line|lines|fair|moneyline|ml|puck ?line|total|over|under|favou?rite|underdog|worth|value|bet|edge|who wins|chance|probability|preview|research)\b/i;
  var SLATE_WIDE = /\b(best|top|any|which|what)\b[^?]*\b(bets?|plays?|games?|edges?|value|opportunit(y|ies))\b|\b(slate|tonight|today|card)\b/i;

  function norm(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'.]/g, '').replace(/[^a-z0-9+\-]+/g, ' ').trim(); }
  function has(qn, name) { return (' ' + qn + ' ').indexOf(' ' + name + ' ') >= 0; }
  function pct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }
  function am(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Math.round(v); }
  function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }

  /** the clubs a question names: [{abbr, ambiguous}] in order of appearance */
  function clubsIn(q, screenIsNhl) {
    var qn = norm(q), out = [], hockey = HOCKEY.test(q) || !!screenIsNhl;
    var hits = [];
    Object.keys(CLUBS).forEach(function (a) { CLUBS[a].forEach(function (n) { var i = (' ' + qn + ' ').indexOf(' ' + n + ' '); if (i >= 0) hits.push({ abbr: a, at: i, len: n.length, amb: false }); }); });
    Object.keys(AMBIGUOUS).forEach(function (a) { AMBIGUOUS[a].forEach(function (n) { var i = (' ' + qn + ' ').indexOf(' ' + n + ' '); if (i >= 0 && hockey) hits.push({ abbr: a, at: i, len: n.length, amb: true }); }); });
    /* a bare abbreviation (DET, TOR) counts only with hockey context */
    if (hockey) Object.keys(CLUBS).forEach(function (a) { var i = (' ' + String(q).toUpperCase().replace(/[^A-Z0-9]+/g, ' ') + ' ').indexOf(' ' + a + ' '); if (i >= 0) hits.push({ abbr: a, at: i, len: 3, amb: false }); });
    hits.sort(function (x, y) { return x.at - y.at || y.len - x.len; });
    hits.forEach(function (h) { if (!out.some(function (o) { return o.abbr === h.abbr; })) out.push({ abbr: h.abbr, ambiguous: h.amb }); });
    return out;
  }

  /** is this an NHL question? → { intent: 'NHL_GAME'|'NHL_SLATE', clubs, quote } or null */
  function classify(q, ctx) {
    q = String(q || '');
    if (!q || q.length > 400) return null;
    var screenIsNhl = ctx && ctx.screen_panel === 'nhl';
    var clubs = clubsIn(q, screenIsNhl);
    var hockey = HOCKEY.test(q);
    if (!clubs.length && !hockey && !(screenIsNhl && PRICE_WORDS.test(q))) return null;
    /* a cross-sport question belongs to the desk's all-sports scan, not here */
    if (/\b(all sports|across (all )?sports|every sport|any sport|all leagues)\b/i.test(q)) return null;
    /* another league named outright is not ours */
    if (/\b(nfl|football|nba|basketball|mlb|baseball|ufc|mma|soccer|tennis)\b/i.test(q) && !hockey) return null;
    var quote = null;
    var m = /([+\-−–]\s?\d{3,4})\b/.exec(q.replace(/(^|\s)([+\-])?1\.5\b/g, ' '));
    if (m) quote = { american: Number(m[1].replace(/[−–]/g, '-').replace(/\s/g, '')) };
    if (quote && /[\-−–]\s?1\.5\b/.test(q)) quote.pl = 'minus'; else if (quote && /\+\s?1\.5\b/.test(q)) quote.pl = 'plus';
    if (quote && (quote.pl || /puck ?line/i.test(q))) quote.market = 'puck_line';
    else if (quote && /\b(over|under|total)\b/i.test(q)) {
      quote.market = 'total';
      var tm = /\b(over|under)\s*(\d+(?:\.5)?)\b/i.exec(q);
      if (tm) { quote.side = tm[1].toLowerCase(); quote.line = Number(tm[2]); }
    }
    else if (quote) quote.market = 'moneyline';
    if (!clubs.length && (hockey || screenIsNhl) && (SLATE_WIDE.test(q) || !(ctx && ctx.game_id))) return { intent: 'NHL_SLATE', clubs: [], quote: null };
    return { intent: 'NHL_GAME', clubs: clubs, quote: quote };
  }

  /** the game a question is about: both clubs → that game; one club → its next game; none → the game on screen */
  function resolveGame(cls, slate, subject, now) {
    var games = (slate && slate.games || []).filter(function (g) { return !(Date.parse(g.start_utc) <= now); });
    var ab = cls.clubs.map(function (c) { return c.abbr; });
    var pick = null, via = null;
    if (ab.length >= 2) { pick = games.filter(function (g) { return ab.indexOf(g.home) >= 0 && ab.indexOf(g.away) >= 0; })[0] || null; via = 'both clubs'; }
    /* two clubs named and no such game: say so, never price a different game */
    if (!pick && ab.length === 1) { pick = games.filter(function (g) { return g.home === ab[0] || g.away === ab[0]; })[0] || null; via = 'the club\'s next game'; }
    if (!pick && !ab.length && subject && subject.game_id) { pick = games.filter(function (g) { return String(g.game_id) === String(subject.game_id); })[0] || null; via = 'screen'; }
    return { game: pick, via: pick ? via : null, clubs: ab };
  }

  function priceCheck(g, quote, namedSide) {
    if (!quote || !quote.american) return null;
    var d = amToDec(quote.american); if (!d) return { error: 'that is not an American price' };
    var p = null, push = 0, label = null;
    var homeFav = g.prices.moneyline.home >= 0.5, fav = homeFav ? 'home' : 'away', dog = homeFav ? 'away' : 'home';
    if (quote.market === 'moneyline') {
      /* the side the question names; otherwise the favourite takes a minus price */
      var side = namedSide || (quote.american < 0 ? fav : dog);
      p = g.prices.moneyline[side]; label = g[side] + ' moneyline';
    } else if (quote.market === 'puck_line') {
      /* named side and sign when given; otherwise the favourite gives 1.5 at a plus price */
      var s = namedSide || (quote.pl === 'plus' ? dog : quote.pl === 'minus' ? fav : quote.american > 0 ? fav : dog);
      var minus = quote.pl ? quote.pl === 'minus' : s === fav;
      p = g.prices.puck_line[s + (minus ? '_minus_1_5' : '_plus_1_5')];
      label = g[s] + (minus ? ' −1.5' : ' +1.5');
    } else if (quote.market === 'total' && quote.side && quote.line != null) {
      var tl = g.prices.total.lines[String(quote.line)];
      if (!tl) return { error: 'I price totals from 5 to 7; ' + quote.line + ' is outside that sheet' };
      p = tl[quote.side]; push = tl.push || 0; label = quote.side + ' ' + quote.line;
    } else return null;
    var be = (1 - push) / d, ev = p * d - (1 - push);
    return { label: label, american: quote.american, break_even: Math.round(be * 10000) / 10000, probability: p, push: push || 0, ev: Math.round(ev * 10000) / 10000 };
  }

  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return 'time unknown';
    try { return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function recordLine(slate) {
    var ml = slate.record && slate.record.moneyline;
    var basis = ml ? 'My moneyline is validated against outcomes on ' + (ml.n || 0).toLocaleString('en-US') + ' held-out games' : 'My moneyline has a held-out record';
    return basis + ' but has not been tested against closing prices, so this is a fair line, not a value call. Research, not picks.';
  }

  function answerGame(cls, slate, res, now) {
    var g = res.game;
    var m = g.prices.moneyline, pl = g.prices.puck_line, t = g.prices.total;
    var fav = m.home >= 0.5 ? 'home' : 'away', dog = fav === 'home' ? 'away' : 'home';
    var plFav = fav === 'home' ? pl.fair_home_minus_1_5 : pl.fair_away_minus_1_5, plFavP = fav === 'home' ? pl.home_minus_1_5 : pl.away_minus_1_5;
    var nearL = t.lines[String(t.fair_line + 0.5)] ? String(t.fair_line + 0.5) : t.lines['6.5'] ? '6.5' : Object.keys(t.lines)[0];
    var tl = t.lines[nearL];
    var gH = g.goalies.home[0], gA = g.goalies.away[0];
    var sc = g.goalies.scenarios || [];
    var spread = sc.length ? Math.round((Math.max.apply(null, sc.map(function (s) { return s.p_home; })) - Math.min.apply(null, sc.map(function (s) { return s.p_home; }))) * 1000) / 10 : 0;
    var lines = [];
    lines.push(g.away + ' at ' + g.home + ', ' + when(g.start_utc) + '. My fair moneyline: ' + g[fav] + ' ' + am(m['fair_' + fav]) + ' (' + pct(m[fav]) + '), ' + g[dog] + ' ' + am(m['fair_' + dog]) + '.');
    lines.push('Puck line: ' + g[fav] + ' −1.5 ' + am(plFav) + ' (' + pct(plFavP) + '). Total: fair line ' + t.fair_line + ', expected ' + t.expected + ' goals; over ' + nearL + ' ' + am(tl.fair_over) + ' (' + pct(tl.over) + '). Overtime ' + pct(g.prices.p_overtime) + '.');
    lines.push('Goalies are ' + String(g.goalies.certainty).replace(/_/g, ' ').toLowerCase() + (gH && gA ? ' (' + (gH.name || 'unknown') + ' ' + Math.round(gH.p_start * 100) + '% for ' + g.home + ', ' + (gA.name || 'unknown') + ' ' + Math.round(gA.p_start * 100) + '% for ' + g.away + ')' : '') + '; the realistic pairings move ' + g.home + '\'s chance by up to ' + spread + ' points.');
    /* why the number is what it is: the slate's exact decomposition (hockey/model/explain.js), never paraphrased into new numbers */
    var ex = g.explanation, why = null;
    if (ex && ex.factors && ex.factors.length) {
      var top = ex.factors.filter(function (f) { return Math.abs(f.pp) >= 0.3; }).slice(0, 3);
      why = top.map(function (f) { return (f.team ? f.team + '\'s ' : '') + f.label.split(' (')[0] + ' ' + (f.pp > 0 ? '+' : '−') + Math.abs(f.pp).toFixed(1) + ' pts for ' + g.home; });
      if (why.length) lines.push('Why: two league-average clubs at a neutral rink would put ' + g.home + ' at ' + pct(ex.baseline.p_home) + '; the biggest factors in my model are ' + why.join(', ') + ' (an exact decomposition; the factors add up to ' + pct(ex.published.p_home) + ').');
    }
    var named = cls.clubs.length ? (cls.clubs[0].abbr === g.home ? 'home' : cls.clubs[0].abbr === g.away ? 'away' : null) : null;
    var pc = priceCheck(g, cls.quote, cls.clubs.length === 1 || (cls.quote && cls.clubs.length >= 1) ? named : null);
    if (pc && !pc.error) lines.push('At ' + am(pc.american) + ' on ' + pc.label + ' the break-even is ' + pct(pc.break_even) + ' and my number is ' + pct(pc.probability) + ', so ' + (pc.ev > 0 ? 'the EV at that price would be +' : 'the EV at that price is ') + pct(pc.ev) + ' per unit — but NHL value claims are off, so I am not calling it a bet.');
    else if (pc && pc.error) lines.push('I could not read that price (' + pc.error + ').');
    lines.push(recordLine(slate));
    lines.push('What could change it: ' + g.invalidators.slice(0, 2).join(' ').replace(/\.\s*$/, '') + '.');
    return { text: lines.join(' '), block: { intent: 'NHL_GAME', game_id: g.game_id, home: g.home, away: g.away, start_utc: g.start_utc, source: 'hockey/slate.json', slate_generated_at: slate.generated_at, resolved_via: res.via, prices: { moneyline: m, puck_line: pl, total: { expected: t.expected, fair_line: t.fair_line } }, goalies: g.goalies.certainty, price_check: pc || null, explanation: ex ? { baseline_p_home: ex.baseline.p_home, factors: ex.factors.slice(0, 6).map(function (f) { return { team: f.team, factor: f.label, pp: f.pp }; }), exact: !!(ex.check && ex.check.exact) } : null, value_claims: slate.readiness && slate.readiness.value_claims } };
  }

  function answerSlate(slate, now) {
    var games = (slate.games || []).filter(function (g) { return !(Date.parse(g.start_utc) <= now); });
    var horizon = now + 36 * 3600e3;
    var soon = games.filter(function (g) { return Date.parse(g.start_utc) <= horizon; });
    var list = (soon.length ? soon : games).slice(0, 8);
    var lines = [];
    lines.push('PASS on the NHL: I price every game myself, but no NHL price can be called an edge yet — ' + ((slate.readiness && slate.readiness.value_claims && slate.readiness.value_claims.reasons) || []).join('; ') + '.');
    if (list.length) lines.push('My fair moneylines for the next games: ' + list.map(function (g) { var fav = g.prices.moneyline.home >= 0.5 ? 'home' : 'away'; return g.away + ' at ' + g.home + ' — ' + g[fav] + ' ' + am(g.prices.moneyline['fair_' + fav]) + ', total ' + g.prices.total.fair_line; }).join('; ') + '.');
    else lines.push('There are no NHL games on my slate in the next ' + (slate.horizon_hours || 72) + ' hours.');
    lines.push('Name a game for its full sheet, or give me a price ("Is Detroit −140 good?") and I will show the break-even against my number.');
    lines.push(recordLine(slate));
    return { text: lines.join(' '), block: { intent: 'NHL_SLATE', source: 'hockey/slate.json', slate_generated_at: slate.generated_at, games: list.map(function (g) { return { game_id: g.game_id, home: g.home, away: g.away, start_utc: g.start_utc, fair_home: g.prices.moneyline.fair_home, fair_away: g.prices.moneyline.fair_away, fair_total: g.prices.total.fair_line }; }), value_claims: slate.readiness && slate.readiness.value_claims } };
  }

  /** the whole turn: q, the slate, the on-screen subject, now → { text, block } or null */
  function answer(q, slate, ctx, now) {
    var cls = classify(q, ctx);
    if (!cls) return null;
    if (!slate || slate.schema !== SLATE_SCHEMA || !Array.isArray(slate.games)) return { text: 'My NHL slate could not be read just now, so I have no NHL price to give. Nothing is shown in its place.', block: { intent: 'NHL_UNAVAILABLE', source: 'hockey/slate.json' } };
    if (cls.intent === 'NHL_SLATE') return answerSlate(slate, now);
    var res = resolveGame(cls, slate, ctx && ctx.game_id ? { game_id: ctx.game_id } : null, now);
    if (!res.game) {
      if (!cls.clubs.length) return answerSlate(slate, now);
      return { text: 'I have no upcoming game ' + (cls.clubs.length >= 2 ? 'between ' + cls.clubs.map(function (c) { return c.abbr; }).join(' and ') : 'for ' + cls.clubs[0].abbr) + ' on my NHL slate (the next ' + (slate.horizon_hours || 72) + ' hours). ' + recordLine(slate), block: { intent: 'NHL_GAME', game_id: null, clubs: res.clubs, source: 'hockey/slate.json', slate_generated_at: slate.generated_at } };
    }
    return answerGame(cls, slate, res, now);
  }

  return { VERSION: VERSION, SLATE_SCHEMA: SLATE_SCHEMA, CLUBS: CLUBS, AMBIGUOUS: AMBIGUOUS, classify: classify, clubsIn: clubsIn, resolveGame: resolveGame, priceCheck: priceCheck, answer: answer };
});
/*__EDNHLDESK_END__*/
