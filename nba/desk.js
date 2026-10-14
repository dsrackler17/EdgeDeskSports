/*__EDNBADESK_START__*/
/* ===========================================================================
   EdgeDesk NBA ON THE DESK — NBA questions answered from the published slate
   (nba/slate.json), deterministically, with no model call.

   ONE FILE, TWO HOSTS. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts (nbaTurn)
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

     "What's your price on Celtics at Knicks?" · "Is Denver -6.5 -110 any
     good?" · "Lakers moneyline +140" · "Over 228.5 in the Warriors game?" ·
     "Best NBA bet tonight?"

   What it says: my fair moneyline, spread and total for the game from one
   distribution, who is projected to play and how far one player moves the
   number, the record status, and — for a quoted price — the break-even, my
   probability at that exact line (pushes priced) and the EV. What it never
   says: that anything is a bet. NBA value claims are off until the model is
   tested against closing prices, and every answer says so. Research, not picks.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDNBADesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_nba_desk_v1';
  var SLATE_SCHEMA = 'edgedesk_nba_slate_v1';
  /* team id (ESPN) → names a reader uses. Kept in step with nba/data/teams.json
     by tools/nba/nba.test.js. */
  var TEAMS = {
    1: ['atlanta hawks', 'hawks'], 2: ['boston celtics', 'celtics'], 3: ['new orleans pelicans', 'pelicans', 'pels'], 4: ['chicago bulls', 'bulls'],
    5: ['cleveland cavaliers', 'cavs'], 6: ['dallas mavericks', 'mavericks', 'mavs'], 7: ['denver nuggets', 'nuggets'], 8: ['detroit pistons', 'pistons'],
    9: ['golden state warriors', 'warriors', 'dubs', 'golden state'], 10: ['houston rockets', 'rockets'], 11: ['indiana pacers', 'pacers'], 12: ['la clippers', 'los angeles clippers', 'clippers'],
    13: ['los angeles lakers', 'la lakers', 'lakers'], 14: ['miami heat'], 15: ['milwaukee bucks', 'bucks'], 16: ['minnesota timberwolves', 'timberwolves', 't wolves'],
    17: ['brooklyn nets', 'nets'], 18: ['new york knicks', 'knicks'], 19: ['orlando magic'], 20: ['philadelphia 76ers', '76ers', 'sixers'],
    21: ['phoenix suns', 'suns'], 22: ['portland trail blazers', 'trail blazers', 'blazers'], 23: ['sacramento kings'], 24: ['san antonio spurs', 'spurs'],
    25: ['oklahoma city thunder', 'thunder', 'okc'], 26: ['utah jazz', 'jazz'], 27: ['washington wizards', 'wizards'], 28: ['toronto raptors', 'raptors'],
    29: ['memphis grizzlies', 'grizzlies', 'grizz'], 30: ['charlotte hornets', 'hornets']
  };
  /* names another league or plain English shares (Kings are also LA's hockey team;
     heat and magic are words; Cavaliers is Virginia; cities field several teams):
     they count only with basketball context or an NBA game on screen */
  var AMBIGUOUS = { 14: ['heat', 'miami'], 19: ['magic', 'orlando'], 23: ['kings', 'sacramento'], 16: ['wolves', 'minnesota'], 5: ['cavaliers', 'cleveland'],
    1: ['atlanta'], 2: ['boston'], 3: ['new orleans'], 4: ['chicago'], 6: ['dallas'], 7: ['denver'], 8: ['detroit'], 10: ['houston'], 11: ['indiana'],
    15: ['milwaukee'], 17: ['brooklyn'], 18: ['new york'], 20: ['philadelphia', 'philly'], 21: ['phoenix'], 22: ['portland'], 24: ['san antonio'],
    26: ['utah'], 27: ['washington'], 28: ['toronto'], 29: ['memphis'], 30: ['charlotte'] };
  var HOOPS = /\b(nba|basketball|hoops|tip[- ]?off|first half|1h|first quarter|1q|rebounds?|assists?|three[- ]pointers?|double[- ]double)\b/i;
  var PRICE_WORDS = /\b(price|odds|line|lines|fair|moneyline|ml|spread|total|over|under|favou?rite|underdog|worth|value|bet|edge|who wins|chance|probability|preview|research|cover)\b/i;
  var SLATE_WIDE = /\b(best|top|any|which|what)\b[^?]*\b(bets?|plays?|games?|edges?|value|opportunit(y|ies))\b|\b(slate|tonight|today|card)\b/i;

  function norm(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'.]/g, '').replace(/[^a-z0-9+\-]+/g, ' ').trim(); }
  function pct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }
  function am(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Math.round(v); }
  function ln(v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); }
  function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }

  /** the teams a question names: [{id, ambiguous}] in order of appearance */
  function teamsIn(q, screenIsNba) {
    var qn = norm(q), hoops = HOOPS.test(q) || !!screenIsNba, hits = [];
    Object.keys(TEAMS).forEach(function (id) { TEAMS[id].forEach(function (n) { var i = (' ' + qn + ' ').indexOf(' ' + n + ' '); if (i >= 0) hits.push({ id: String(id), at: i, len: n.length, amb: false }); }); });
    if (hoops) Object.keys(AMBIGUOUS).forEach(function (id) { AMBIGUOUS[id].forEach(function (n) { var i = (' ' + qn + ' ').indexOf(' ' + n + ' '); if (i >= 0) hits.push({ id: String(id), at: i, len: n.length, amb: true }); }); });
    hits.sort(function (x, y) { return x.at - y.at || y.len - x.len; });
    var out = []; hits.forEach(function (h) { if (!out.some(function (o) { return o.id === h.id; })) out.push({ id: h.id, ambiguous: h.amb }); });
    return out;
  }

  /** is this an NBA question? → { intent: 'NBA_GAME'|'NBA_SLATE', teams, quote } or null */
  function classify(q, ctx) {
    q = String(q || '');
    if (!q || q.length > 400) return null;
    var screenIsNba = ctx && ctx.screen_panel === 'nba';
    var teams = teamsIn(q, screenIsNba);
    var hoops = HOOPS.test(q);
    if (!teams.length && !hoops && !(screenIsNba && PRICE_WORDS.test(q))) return null;
    if (/\b(all sports|across (all )?sports|every sport|any sport|all leagues)\b/i.test(q)) return null;
    /* another league named outright is not ours (college basketball included) */
    if (/\b(nfl|football|nhl|hockey|mlb|baseball|ufc|mma|soccer|tennis|wnba|ncaa|college|march madness)\b/i.test(q)) return null;
    var quote = null;
    var spreadM = /([+\-−–])\s?(\d{1,2}(?:\.5)?)\s+([+\-−–]\s?\d{3,4})\b/.exec(q);
    var totalM = /\b(over|under|o|u)\s*(\d{3}(?:\.5)?)\b(?:\s+([+\-−–]\s?\d{3,4}))?/i.exec(q);
    if (totalM && Number(totalM[2]) >= 150) quote = { market: 'total', side: /^o/i.test(totalM[1]) ? 'over' : 'under', line: Number(totalM[2]), american: totalM[3] ? Number(totalM[3].replace(/[−–]/g, '-').replace(/\s/g, '')) : -110, assumed_price: !totalM[3] };
    else if (spreadM) quote = { market: 'spread', line: Number((spreadM[1].replace(/[−–]/g, '-')) + spreadM[2]), american: Number(spreadM[3].replace(/[−–]/g, '-').replace(/\s/g, '')) };
    else { var m = /([+\-−–]\s?\d{3,4})\b/.exec(q); if (m) quote = { market: 'moneyline', american: Number(m[1].replace(/[−–]/g, '-').replace(/\s/g, '')) }; }
    if (!teams.length && (hoops || screenIsNba) && (SLATE_WIDE.test(q) || !(ctx && ctx.game_id))) return { intent: 'NBA_SLATE', teams: [], quote: null };
    return { intent: 'NBA_GAME', teams: teams, quote: quote };
  }

  function resolveGame(cls, slate, subject, now) {
    var games = (slate && slate.games || []).filter(function (g) { return !(Date.parse(g.start_utc) <= now); });
    var ids = cls.teams.map(function (t) { return t.id; }); var pick = null, via = null;
    if (ids.length >= 2) { pick = games.filter(function (g) { return ids.indexOf(String(g.home.id)) >= 0 && ids.indexOf(String(g.away.id)) >= 0; })[0] || null; via = 'both teams'; }
    if (!pick && ids.length === 1) { pick = games.filter(function (g) { return String(g.home.id) === ids[0] || String(g.away.id) === ids[0]; })[0] || null; via = 'the team\'s next game'; }
    if (!pick && !ids.length && subject && subject.game_id) { pick = games.filter(function (g) { return String(g.game_id) === String(subject.game_id); })[0] || null; via = 'screen'; }
    return { game: pick, via: pick ? via : null, teams: ids };
  }

  /** a quoted price against the sheet: moneyline, a spread line on the ladder, a total line on the ladder */
  function priceCheck(g, quote, namedSide) {
    if (!quote || quote.american == null) return null;
    var d = amToDec(quote.american); if (!d) return { error: 'that is not an American price' };
    var p = g.price; var homeFav = p.moneyline.home >= 0.5; var side, win = null, push = 0, label = null;
    if (quote.market === 'moneyline') {
      side = namedSide || (quote.american < 0 ? (homeFav ? 'home' : 'away') : (homeFav ? 'away' : 'home'));
      win = p.moneyline[side]; label = (g[side].abbr || g[side].name) + ' moneyline';
    } else if (quote.market === 'spread') {
      side = namedSide || (quote.line < 0 ? (homeFav ? 'home' : 'away') : (homeFav ? 'away' : 'home'));
      var homeLine = side === 'home' ? quote.line : -quote.line;
      var row = (p.spread.ladder || []).filter(function (x) { return x.line_home === homeLine; })[0];
      if (!row) return { error: 'my spread sheet runs ' + ln(p.spread.ladder[0].line_home) + ' to ' + ln(p.spread.ladder[p.spread.ladder.length - 1].line_home) + ' for the home side; ' + ln(quote.line) + ' is outside it' };
      win = side === 'home' ? row.win : row.lose; push = row.push || 0; label = (g[side].abbr || g[side].name) + ' ' + ln(quote.line);
    } else if (quote.market === 'total') {
      var tr = (p.total.ladder || []).filter(function (x) { return x.line === quote.line; })[0];
      if (!tr) return { error: 'my total sheet runs ' + p.total.ladder[0].line + ' to ' + p.total.ladder[p.total.ladder.length - 1].line + '; ' + quote.line + ' is outside it' };
      win = tr[quote.side].win; push = tr[quote.side].push || 0; label = quote.side + ' ' + quote.line;
    } else return null;
    var be = (1 - push) / d, ev = win * d - (1 - push);
    return { label: label, american: quote.american, assumed_price: !!quote.assumed_price, break_even: Math.round(be * 10000) / 10000, probability: win, push: push, ev: Math.round(ev * 10000) / 10000 };
  }

  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return 'time unknown';
    try { return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function recordLine(slate) {
    var r = slate.model && slate.model.record, sel = r && r.selection;
    var basis = sel ? 'My model (' + slate.model.label + ') was chosen on ' + (sel.n || 0).toLocaleString('en-US') + ' held-out games' + (/SEALED/.test(r.status || '') ? ', with the later test seasons still sealed' : '') : 'My model has a held-out record';
    return basis + '; it has never been tested against closing prices, so this is a fair line, not a value call. Research, not picks.';
  }

  function answerGame(cls, slate, res) {
    var g = res.game, p = g.price; var H = g.home.abbr || g.home.name, A = g.away.abbr || g.away.name;
    var fav = p.moneyline.home >= 0.5 ? 'home' : 'away', dog = fav === 'home' ? 'away' : 'home';
    var F = fav === 'home' ? H : A, Dg = fav === 'home' ? A : H;
    var favLine = fav === 'home' ? p.spread.fair_line_home : -p.spread.fair_line_home;
    var lines = [];
    lines.push(A + ' at ' + H + ', ' + when(g.start_utc) + '. My fair moneyline: ' + F + ' ' + am(p.moneyline[fav + '_american']) + ' (' + pct(p.moneyline[fav]) + '), ' + Dg + ' ' + am(p.moneyline[dog + '_american']) + '.');
    lines.push('Fair spread ' + F + ' ' + ln(favLine) + ', fair total ' + p.total.fair_line + ' (expected ' + A + ' ' + p.expected.away + ' – ' + p.expected.home + ' ' + H + '); overtime ' + pct(p.p_overtime) + '.');
    var big = (g.scenarios || []).filter(function (s) { return s.kind === 'sits'; }).sort(function (a, b) { return Math.abs(b.delta_p_home) - Math.abs(a.delta_p_home); })[0];
    lines.push('Availability is projected from each team\'s previous game (no injury report is in the price)' + (big ? '; the biggest single swing: if ' + big.player + ' sits, ' + H + '\'s chance moves ' + (big.delta_p_home > 0 ? '+' : '') + (Math.round(big.delta_p_home * 1000) / 10) + ' points' : '') + '.');
    var named = cls.teams.length ? (cls.teams[0].id === String(g.home.id) ? 'home' : cls.teams[0].id === String(g.away.id) ? 'away' : null) : null;
    var pc = priceCheck(g, cls.quote, named);
    if (pc && !pc.error) lines.push('At ' + am(pc.american) + (pc.assumed_price ? ' (assumed: no price was given)' : '') + ' on ' + pc.label + ' the break-even is ' + pct(pc.break_even) + ' and my number is ' + pct(pc.probability) + (pc.push ? ' with a ' + pct(pc.push) + ' push' : '') + ', so the EV at that price is ' + (pc.ev > 0 ? '+' : '') + pct(pc.ev) + ' per unit — but NBA value claims are off, so I am not calling it a bet.');
    else if (pc && pc.error) lines.push('I could not check that price (' + pc.error + ').');
    lines.push(recordLine(slate));
    if (g.reasons_to_pass && g.reasons_to_pass.length > 1) lines.push('Reasons to pass: ' + g.reasons_to_pass.slice(1, 3).join(' '));
    return { text: lines.join(' '), block: { intent: 'NBA_GAME', game_id: g.game_id, home: H, away: A, start_utc: g.start_utc, source: 'nba/slate.json', slate_generated_at: slate.generated_at, resolved_via: res.via,
      prices: { moneyline: p.moneyline, fair_spread_home: p.spread.fair_line_home, fair_total: p.total.fair_line, expected: p.expected }, price_check: pc || null, value_claims: slate.value_claims } };
  }

  function answerSlate(slate, now) {
    var games = (slate.games || []).filter(function (g) { return !(Date.parse(g.start_utc) <= now); }).slice(0, 8);
    var lines = ['PASS on the NBA: I price every game myself, but no NBA price can be called an edge yet — ' + slate.value_reason];
    if (games.length) lines.push('My fair lines for the next games: ' + games.map(function (g) { var p = g.price; var fav = p.moneyline.home >= 0.5 ? 'home' : 'away'; var fl = fav === 'home' ? p.spread.fair_line_home : -p.spread.fair_line_home; return (g.away.abbr || g.away.name) + ' at ' + (g.home.abbr || g.home.name) + ' — ' + (g[fav].abbr || g[fav].name) + ' ' + ln(fl) + ' / ' + am(p.moneyline[fav + '_american']) + ', total ' + p.total.fair_line; }).join('; ') + '.');
    else lines.push('There are no NBA games on my slate right now (' + slate.horizon + ').');
    lines.push('Name a game for its full sheet, or give me a price ("Is Boston −6.5 −110 good?") and I will show the break-even against my number.');
    lines.push(recordLine(slate));
    return { text: lines.join(' '), block: { intent: 'NBA_SLATE', source: 'nba/slate.json', slate_generated_at: slate.generated_at, games: games.map(function (g) { return { game_id: g.game_id, home: g.home.abbr, away: g.away.abbr, start_utc: g.start_utc, p_home: g.price.moneyline.home, fair_spread_home: g.price.spread.fair_line_home, fair_total: g.price.total.fair_line }; }), value_claims: slate.value_claims } };
  }

  function answer(q, slate, ctx, now) {
    var cls = classify(q, ctx);
    if (!cls) return null;
    if (!slate || slate.schema !== SLATE_SCHEMA || !Array.isArray(slate.games)) return { text: 'My NBA slate could not be read just now, so I have no NBA price to give. Nothing is shown in its place.', block: { intent: 'NBA_UNAVAILABLE', source: 'nba/slate.json' } };
    if (cls.intent === 'NBA_SLATE') return answerSlate(slate, now);
    var res = resolveGame(cls, slate, ctx && ctx.game_id ? { game_id: ctx.game_id } : null, now);
    if (!res.game) {
      if (!cls.teams.length) return answerSlate(slate, now);
      return { text: 'I have no upcoming game ' + (cls.teams.length >= 2 ? 'between those two teams' : 'for that team') + ' on my NBA slate (' + slate.horizon + '). ' + recordLine(slate), block: { intent: 'NBA_GAME', game_id: null, teams: res.teams, source: 'nba/slate.json', slate_generated_at: slate.generated_at } };
    }
    return answerGame(cls, slate, res);
  }

  return { VERSION: VERSION, SLATE_SCHEMA: SLATE_SCHEMA, TEAMS: TEAMS, AMBIGUOUS: AMBIGUOUS, classify: classify, teamsIn: teamsIn, resolveGame: resolveGame, priceCheck: priceCheck, answer: answer };
});
/*__EDNBADESK_END__*/
