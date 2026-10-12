/*__EDORCH_START__*/
/* ===========================================================================
   EdgeDesk RESEARCH ORCHESTRATOR (EDORCH) — the plan for one question, before
   any work is done. docs/research-engine/ARCHITECTURE.md §2–§3

   WHAT IT DOES
     plan(question, ctx) classifies the question (sport, league, teams,
     players, event), sets its complexity, lists the datasets it needs and how
     fresh each must be, decides whether external research is needed and why,
     names the calculations, estimates cost and time, and chooses the cheapest
     path that can answer it reliably:

       DATABASE            a stored value                      $0 external
       ENGINE              deterministic computation           $0 external
       ENGINE_RESEARCH     research from internal + free feeds $0 external
       ENGINE_SEARCH       + a search provider (off by default) ≈ $0.01–0.13
       MODEL_DESK          conversation the routes do not cover (existing desk)
       UNSUPPORTED         what EdgeDesk cannot answer; said so, $0

   It is PURE: no network, no clock unless given, no model. The host streams
   the plan as a "plan" event before the work starts; each "progress" event
   then names a stage, so planned and actual sit side by side. A planned step
   that cannot run (a provider off, a budget spent) is in the plan as
   "unavailable" with the reason — never silently dropped, never faked.

   THE RULES
     - A question that a dataset answers never plans a paid call.
     - External search is planned only when the question needs reporting the
       datasets cannot hold (news, a status since the last report, a coaching
       change), AND it is then marked runnable only when a provider is
       configured, enabled, paid research is authorised and the budget allows.
     - Estimates are labelled estimates. Actual cost comes from the ledger.

   Browser/Node/Deno: UMD, ES5, no dependencies. Inlined into
   supabase/functions/edgedesk_ai/index.ts by tools/presentation/inline.js.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDORCH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_orchestrator_v1';

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r4(x) { return Math.round(x * 10000) / 10000; }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!s[k]) { s[k] = 1; o.push(x); } }); return o; }

  /* ---------------- entities ---------------- */
  /* [code, full name, words that name it alone]. A word in two clubs ("Giants") names neither on its own. */
  var NFL = [
    ['ARI', 'Arizona Cardinals', ['cardinals', 'arizona']], ['ATL', 'Atlanta Falcons', ['falcons', 'atlanta']], ['BAL', 'Baltimore Ravens', ['ravens', 'baltimore']],
    ['BUF', 'Buffalo Bills', ['bills', 'buffalo']], ['CAR', 'Carolina Panthers', ['panthers', 'carolina']], ['CHI', 'Chicago Bears', ['bears']], ['CIN', 'Cincinnati Bengals', ['bengals', 'cincinnati']],
    ['CLE', 'Cleveland Browns', ['browns']], ['DAL', 'Dallas Cowboys', ['cowboys', 'dallas']], ['DEN', 'Denver Broncos', ['broncos', 'denver']], ['DET', 'Detroit Lions', ['lions', 'detroit']],
    ['GB', 'Green Bay Packers', ['packers', 'green bay']], ['HOU', 'Houston Texans', ['texans']], ['IND', 'Indianapolis Colts', ['colts', 'indianapolis']], ['JAX', 'Jacksonville Jaguars', ['jaguars', 'jacksonville', 'jags']],
    ['KC', 'Kansas City Chiefs', ['chiefs']], ['LV', 'Las Vegas Raiders', ['raiders', 'las vegas']], ['LAC', 'Los Angeles Chargers', ['chargers']], ['LAR', 'Los Angeles Rams', ['rams']],
    ['MIA', 'Miami Dolphins', ['dolphins']], ['MIN', 'Minnesota Vikings', ['vikings']], ['NE', 'New England Patriots', ['patriots', 'new england', 'pats']], ['NO', 'New Orleans Saints', ['saints', 'new orleans']],
    ['NYG', 'New York Giants', []], ['NYJ', 'New York Jets', ['jets']], ['PHI', 'Philadelphia Eagles', ['eagles']], ['PIT', 'Pittsburgh Steelers', ['steelers']],
    ['SF', 'San Francisco 49ers', ['49ers', 'niners']], ['SEA', 'Seattle Seahawks', ['seahawks', 'seattle']], ['TB', 'Tampa Bay Buccaneers', ['buccaneers', 'bucs']], ['TEN', 'Tennessee Titans', ['titans']],
    ['WAS', 'Washington Commanders', ['commanders']]
  ];
  var MLB = [
    ['ARI', 'Arizona Diamondbacks', ['diamondbacks', 'dbacks', 'd-backs']], ['ATL', 'Atlanta Braves', ['braves']], ['BAL', 'Baltimore Orioles', ['orioles']], ['BOS', 'Boston Red Sox', ['red sox']],
    ['CHC', 'Chicago Cubs', ['cubs']], ['CWS', 'Chicago White Sox', ['white sox']], ['CIN', 'Cincinnati Reds', ['reds']], ['CLE', 'Cleveland Guardians', ['guardians']],
    ['COL', 'Colorado Rockies', ['rockies']], ['DET', 'Detroit Tigers', ['tigers']], ['HOU', 'Houston Astros', ['astros']], ['KC', 'Kansas City Royals', ['royals']],
    ['LAA', 'Los Angeles Angels', ['angels']], ['LAD', 'Los Angeles Dodgers', ['dodgers']], ['MIA', 'Miami Marlins', ['marlins']], ['MIL', 'Milwaukee Brewers', ['brewers']],
    ['MIN', 'Minnesota Twins', ['twins']], ['NYM', 'New York Mets', ['mets']], ['NYY', 'New York Yankees', ['yankees']], ['ATH', 'Athletics', ['athletics', "a's"]],
    ['PHI', 'Philadelphia Phillies', ['phillies']], ['PIT', 'Pittsburgh Pirates', ['pirates']], ['SD', 'San Diego Padres', ['padres']], ['SF', 'San Francisco Giants', []],
    ['SEA', 'Seattle Mariners', ['mariners']], ['STL', 'St. Louis Cardinals', []], ['TB', 'Tampa Bay Rays', ['rays']], ['TEX', 'Texas Rangers', ['rangers']],
    ['TOR', 'Toronto Blue Jays', ['blue jays', 'jays']], ['WSH', 'Washington Nationals', ['nationals', 'nats']]
  ];
  /** A club's full name from its code ("KC" → "Kansas City Chiefs"), or null. */
  function teamByCode(sport, code) {
    var list = sport === 'baseball_mlb' ? MLB : NFL, c = str(code).toUpperCase();
    for (var i = 0; i < list.length; i++) if (list[i][0] === c) return list[i][1];
    return null;
  }
  function rx(w) { return new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9])', 'i'); }
  function teamsIn(q, list, sport) {
    var lq = str(q).toLowerCase(), out = [];
    list.forEach(function (t) {
      var hit = rx(t[1].toLowerCase()).test(lq) || t[2].some(function (w) { return rx(w).test(lq); });
      if (hit) out.push({ sport: sport, code: t[0], name: t[1] });
    });
    return out;
  }
  var SPORT_WORDS = [
    ['americanfootball_nfl', /\b(nfl|pro football)\b/i], ['americanfootball_ncaaf', /\b(cfb|ncaaf|college football|fbs)\b/i], ['baseball_mlb', /\b(mlb|baseball)\b/i],
    ['mma_mixed_martial_arts', /\b(ufc|mma)\b/i]
  ];
  var UNSUPPORTED_SPORTS = [['NBA', /\b(nba|basketball)\b/i], ['WNBA', /\bwnba\b/i], ['NHL', /\b(nhl|hockey)\b/i], ['college basketball', /\b(ncaab|college basketball|march madness)\b/i],
    ['soccer', /\b(soccer|premier league|la liga|mls|champions league)\b/i], ['tennis', /\b(tennis|atp|wta)\b/i], ['golf', /\b(golf|pga)\b/i]];
  var LEAGUE = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'College football (FBS)', baseball_mlb: 'MLB', mma_mixed_martial_arts: 'UFC' };

  /** Sport, league, teams, players and event. ctx.game: the game the reader has open; ctx.known_players: names on file. */
  function entities(q, ctx) {
    ctx = ctx || {};
    var said = SPORT_WORDS.filter(function (s) { return s[1].test(q); }).map(function (s) { return s[0]; });
    var unsupported = UNSUPPORTED_SPORTS.filter(function (s) { return s[1].test(q); }).map(function (s) { return s[0]; });
    var nfl = teamsIn(q, NFL, 'americanfootball_nfl'), mlb = teamsIn(q, MLB, 'baseball_mlb');
    var sport = (ctx.game && ctx.game.sport) || (said.length === 1 ? said[0] : null);
    var teams;
    if (sport === 'americanfootball_nfl') teams = nfl;
    else if (sport === 'baseball_mlb') teams = mlb;
    else if (nfl.length && !mlb.length) { teams = nfl; sport = sport || 'americanfootball_nfl'; }
    else if (mlb.length && !nfl.length) { teams = mlb; sport = sport || 'baseball_mlb'; }
    else teams = nfl.concat(mlb);
    var known = Array.isArray(ctx.known_players) ? ctx.known_players : [];
    var players = known.filter(function (p) { return p && p.name && rx(String(p.name).toLowerCase()).test(str(q).toLowerCase()); })
      .map(function (p) { return { name: p.name, team: p.team || null, position: p.position || null, resolved: true }; });
    /* a player resolved to a club names that club when the question names none */
    if (!teams.length && players.length) {
      var pc = players.map(function (p) { return p.team; }).filter(Boolean);
      var lex = sport === 'baseball_mlb' ? MLB : NFL;
      pc.forEach(function (code) { var t = lex.filter(function (x) { return x[0] === String(code).toUpperCase(); })[0]; if (t && !teams.some(function (y) { return y.code === t[0]; })) teams.push({ sport: sport || (lex === MLB ? 'baseball_mlb' : 'americanfootball_nfl'), code: t[0], name: t[1], via: 'player' }); });
      if (teams.length && !sport) sport = teams[0].sport;
    }
    var event = ctx.game && ctx.game.game_id ? { kind: 'GAME', game_id: String(ctx.game.game_id), sport: ctx.game.sport || sport, label: ctx.game.label || null, source: 'the game open on screen' }
      : teams.length === 2 ? { kind: 'MATCHUP', teams: teams.map(function (t) { return t.name; }), sport: sport, source: 'two teams named in the question' }
        : teams.length === 1 ? { kind: 'TEAM', team: teams[0].name, sport: sport, source: 'one team named' }
          : said.length || /\b(slate|tonight|today|this week(end)?|every|all)\b/i.test(q) ? { kind: 'SLATE', sport: sport, source: 'a slate question' } : { kind: 'NONE' };
    return { sports_named: said, unsupported_sports: unsupported, sport: sport, league: sport ? LEAGUE[sport] || sport : null, teams: teams, players: players, event: event };
  }

  /* ---------------- what kind of question ---------------- */
  var RX = {
    news: /\b(news|latest|breaking|update[ds]?|reports?(ed)?|rumou?rs?|since (this morning|yesterday|last night|the last)|today'?s (injury )?report|just (announced|ruled|listed)|coach (said|says)|press conference|beat writer)\b/i,
    offData: /\b(suspen\w+|trade[ds]?|traded|signed|released|fired|hired|coaching change|new (coach|coordinator|play-?caller)|holdout|arrest\w*|weather delay|postpone\w*)\b/i,
    deep: /\b(investigat\w*|deep|adversarial|audit|dig into|thorough|every angle|research (this|that|the) game|why does (edgedesk|the model|it) (disagree|differ))\b/i,
    lookup: /^(when|what time|where|who|what'?s|what is|is)\b[^?]{0,80}\b(play|playing|kick ?off|start(s|ing)?|spread|line|total|odds|price|starter|starting|probable|status|injur\w*|out|questionable|ready)\b/i,
    future: /\b(who will win|will (they|he|she|it) win|guarantee\w*|lock of the|sure thing|can'?t lose|100%)\b/i,
    calibration: /\b(calibrat\w*|accura\w*|track record|how (good|well) (is|has|does) (the )?model|brier|log loss|closing line value|clv|hit rate)\b/i,
    staking: /\b(how (much|many)|units?|stake|kelly|bet size|sizing|bankroll)\b/i
  };
  /* route (from the host) -> base complexity, path, datasets, calculations */
  var ROUTES = {
    LINES: { c: 'LOOKUP', path: 'DATABASE', d: ['market', 'fair_sheets'], k: ['implied_probability', 'fair_odds'] },
    PROPS: { c: 'LOOKUP', path: 'DATABASE', d: ['props_board'], k: ['implied_probability', 'fair_odds'] },
    COVERAGE: { c: 'LOOKUP', path: 'DATABASE', d: ['market_coverage'], k: [] },
    OUTAGE: { c: 'LOOKUP', path: 'DATABASE', d: ['market_coverage'], k: [] },
    READINESS: { c: 'STANDARD', path: 'ENGINE', d: ['schedule', 'projections', 'market'], k: ['market_freshness'] },
    MATCHUP_EDGE: { c: 'STANDARD', path: 'ENGINE', d: ['team_ratings'], k: ['unit_mismatch'] },
    VENUE_COMPARE: { c: 'STANDARD', path: 'ENGINE', d: ['venue_fees'], k: ['fee_schedule'] },
    CONTRACT: { c: 'STANDARD', path: 'ENGINE', d: ['market', 'venue_fees'], k: ['implied_probability', 'devig', 'fair_odds', 'expected_value', 'max_price', 'market_freshness'] },
    PRICE: { c: 'STANDARD', path: 'ENGINE', d: ['market'], k: ['implied_probability', 'devig', 'fair_odds', 'expected_value', 'max_price', 'market_freshness'] },
    EXPLAIN_EV: { c: 'STANDARD', path: 'ENGINE', d: ['market', 'venue_fees'], k: ['implied_probability', 'devig', 'expected_value'] },
    BETS: { c: 'STANDARD', path: 'ENGINE', d: ['your_bets'], k: ['history_summary'] },
    SCAN: { c: 'INVESTIGATION', path: 'ENGINE_RESEARCH', d: ['schedule', 'market', 'projections', 'injuries', 'validation'], k: ['implied_probability', 'devig', 'fair_odds', 'expected_value', 'max_price', 'spread_discrepancy', 'market_freshness', 'sensitivity'] },
    RESEARCH_SLATE: { c: 'INVESTIGATION', path: 'ENGINE_RESEARCH', d: ['schedule', 'market', 'projections', 'injuries', 'team_ratings', 'validation'], k: ['spread_discrepancy', 'total_discrepancy', 'implied_probability', 'devig', 'fair_odds', 'expected_value', 'max_price', 'market_freshness', 'sensitivity'] },
    GAME_RESEARCH: { c: 'INVESTIGATION', path: 'ENGINE_RESEARCH', d: ['schedule', 'market', 'projections', 'injuries', 'team_ratings', 'weather', 'validation'], k: ['spread_discrepancy', 'total_discrepancy', 'implied_probability', 'devig', 'fair_odds', 'expected_value', 'max_price', 'market_freshness', 'sensitivity'] },
    /* "is X playing?" / "who starts for Y?": one player's (or one club's starter's) status from the sources EdgeDesk reads */
    AVAILABILITY: { c: 'STANDARD', path: 'ENGINE_RESEARCH', d: ['schedule', 'injuries', 'desk_notes'], k: ['source_freshness', 'source_conflicts'] }
  };
  /* dataset -> what it is, where it lives, how fresh it must be */
  var DATASETS = {
    market: { label: 'captured book prices', source: 'supabase:signals, book_quotes', freshness: 'a pregame price counts as current for 60 min; a reference line is never a price' },
    fair_sheets: { label: 'published fair-line sheets', source: 'football/*/fair sheets', freshness: 'the nightly build' },
    props_board: { label: 'player props board', source: 'supabase:props', freshness: 'the latest capture' },
    market_coverage: { label: 'which sports have captured prices', source: 'supabase:signals', freshness: 'the last 3 days' },
    schedule: { label: 'schedules', source: 'football/nfl/slate.json, football/fbs/slate.json, supabase:games', freshness: 'the nightly build' },
    projections: { label: 'EdgeDesk projections', source: 'football/nfl/slate.json, football/fbs/slate.json, mlb_game_cards', freshness: 'the nightly build (≤ 36 h)' },
    injuries: { label: 'injury report and depth charts', source: 'football/matchup/metrics.json (nflverse); live nflverse feed at L3', freshness: '≤ 24 h, ≤ 6 h inside a day of kickoff' },
    team_ratings: { label: 'unit efficiency ratings (EPA)', source: 'football/nfl/slate.json teams', freshness: 'weekly' },
    weather: { label: 'forecast and venue', source: 'football/nfl/slate.json forecast (open-meteo)', freshness: '≤ 12 h' },
    validation: { label: 'model validation tiers', source: 'football/validation/pricing_*.json', freshness: 'per build' },
    venue_fees: { label: 'venue fee schedules', source: 'lib/edgedesk_fairodds.js VENUES', freshness: 'versioned with the code' },
    your_bets: { label: 'your recorded bets', source: 'supabase:portfolio_positions (your rows only)', freshness: 'as recorded' },
    calibration_history: { label: 'graded predictions', source: 'supabase:research_runs + research_run_outcomes', freshness: 'graded after each event' },
    external_reporting: { label: 'current reporting from official and credible sources', source: 'search provider', freshness: 'minutes; each finding carries its publication time' },
    desk_notes: { label: 'the desk\'s notebook (reports a person recorded, each with a source and a time)', source: 'football/notes/current.json', freshness: 'each note carries its publication time and an expiry' }
  };
  var CALC = {
    implied_probability: 'implied probability from the price', devig: 'vig removal (two-sided no-vig)', fair_odds: 'fair odds from the fair probability',
    expected_value: 'expected value per $1, fees included', max_price: 'maximum acceptable price', spread_discrepancy: 'model spread minus market spread',
    total_discrepancy: 'model total minus market total', market_freshness: 'quote age against the freshness rule', sensitivity: 'EV with the fair one point lower',
    unit_mismatch: 'offense rating plus opposing defense rating', fee_schedule: 'each venue\'s own fee rule', history_summary: 'your results by bet type',
    calibration: 'Brier score, log loss and closing-line value over graded predictions',
    source_freshness: 'each report\'s age against the limit for its topic and the time to kickoff', source_conflicts: 'sources that disagree about one player, resolved by tier and recency or left unresolved'
  };
  /* estimates per step (labelled estimates; the ledger records the actual) */
  var EST = {
    FIND_EVENTS: { ms: 400, usd: 0 }, COMPARE_PRICES: { ms: 300, usd: 0 }, RETRIEVE_STATS: { ms: 600, usd: 0 }, VERIFY_INJURIES: { ms: 200, usd: 0 },
    CALCULATE: { ms: 50, usd: 0 }, AUDIT: { ms: 400, usd: 0 }, CHALLENGE: { ms: 20, usd: 0 }, EXPLAIN: { ms: 30, usd: 0 }, READ_HISTORY: { ms: 300, usd: 0 }, ANALYZE_HISTORY: { ms: 50, usd: 0 },
    LOOKUP: { ms: 250, usd: 0 }, MODEL_DESK: { ms: 6000, usd: 0.012 }
  };
  /* search providers: estimates from docs/research-engine/PROVIDERS.md §3 */
  var SEARCH = {
    claude_web_search: { label: 'Claude web search (official and credible domains)', ms: 12000, usd_by_model: { 'claude-opus-5-5': 0.084, 'claude-sonnet-5-5': 0.057, 'claude-haiku-5-5': 0.031 }, usd_default: 0.084 },
    perplexity_search: { label: 'Perplexity Search API', ms: 1500, usd: 0.010 }
  };

  function step(id, stage, label, extra) { var e = EST[stage] || { ms: 100, usd: 0 }; return Object.assign({ id: id, stage: stage, label: label, est_ms: e.ms, est_usd: e.usd, status: 'planned', why: null }, extra || {}); }

  /**
   * The plan. ctx:
   *   route         the host's route for this question (quantRouteOf / turn detectors), or null
   *   game          { sport, game_id, label } the game the reader has open
   *   known_players [{ name, team, position }]
   *   providers     { claude_web_search: { configured, enabled, model }, perplexity_search: { configured, enabled } }
   *   paid_ok       EDGEDESK_RESEARCH_PAID_OK
   *   budget        { per_request_usd, remaining_today_usd }
   *   research_enabled  the research chain is on (EDGEDESK_RESEARCH)
   */
  function plan(question, ctx) {
    ctx = ctx || {};
    var q = str(question).replace(/\s+/g, ' ').trim();
    var ent = entities(q, ctx);
    var route = ctx.route || null;
    var base = route && ROUTES[route] ? ROUTES[route] : null;
    var why = [];
    var complexity, path, datasets, calcs;
    if (!q) return { schema: VERSION, question: q, classification: { complexity: 'NONE' }, path: 'UNSUPPORTED', steps: [], estimate: { usd: 0, ms: 0 }, why: ['no question'] };
    if (ent.unsupported_sports.length && !ent.sport) {
      return finish({ q: q, ent: ent, route: route, complexity: 'LOOKUP', path: 'UNSUPPORTED', datasets: [], calcs: [], steps: [step('s1', 'EXPLAIN', 'Say which sports EdgeDesk covers')],
        why: [ent.unsupported_sports.join(', ') + ' ' + (ent.unsupported_sports.length === 1 ? 'is' : 'are') + ' not covered by EdgeDesk\'s models or captured prices'], external: none('the sport is not covered'), ctx: ctx });
    }
    if (RX.future.test(q) && !base) {
      return finish({ q: q, ent: ent, route: route, complexity: 'LOOKUP', path: 'UNSUPPORTED', datasets: [], calcs: [], steps: [step('s1', 'EXPLAIN', 'Explain what EdgeDesk can measure instead')],
        why: ['an outcome cannot be known before the event; EdgeDesk reports probabilities and prices, never a guarantee'], external: none('nothing to search for'), ctx: ctx });
    }
    if (base) { complexity = base.c; path = base.path; datasets = base.d.slice(); calcs = base.k.slice(); why.push('the ' + route.toLowerCase().replace(/_/g, ' ') + ' route answers it from EdgeDesk\'s own data'); }
    else if (RX.calibration.test(q)) { complexity = 'STANDARD'; path = 'ENGINE'; route = 'CALIBRATION'; datasets = ['calibration_history', 'validation']; calcs = ['calibration']; why.push('model performance comes from graded predictions, not from a model\'s opinion'); }
    else if (RX.lookup.test(q) && (ent.teams.length || ent.event.kind === 'GAME')) { complexity = 'LOOKUP'; path = 'DATABASE'; route = 'LOOKUP'; datasets = /spread|line|odds|price|total/i.test(q) ? ['market', 'schedule'] : /injur|status|out|questionable|starter|probable/i.test(q) ? ['injuries', 'schedule'] : ['schedule']; calcs = /spread|line|odds|price/i.test(q) ? ['implied_probability', 'market_freshness'] : []; why.push('a stored value answers it'); }
    else { complexity = 'STANDARD'; path = 'MODEL_DESK'; datasets = ent.event.kind !== 'NONE' ? ['schedule', 'projections', 'injuries'] : []; calcs = []; why.push('conversation the research routes do not cover goes to the existing desk, under the daily allowance'); }
    if (RX.deep.test(q) && complexity !== 'INVESTIGATION' && path !== 'UNSUPPORTED' && path !== 'MODEL_DESK') { complexity = 'INVESTIGATION'; why.push('the question asks for an investigation'); }
    if (route === 'SCAN' && /\btonight\b|\btoday\b/i.test(q)) why.push('the window is narrow, so the scan may find nothing to research');
    if (RX.staking.test(q)) why.push('stake sizing is answered by the staking engine, never by research');

    /* external research: needed only for reporting the datasets cannot hold */
    var needSearch = (RX.news.test(q) || RX.offData.test(q)) && path !== 'UNSUPPORTED';
    var external = needSearch ? searchDecision(q, ctx) : none(path === 'MODEL_DESK' ? 'no research question detected' : 'EdgeDesk\'s datasets hold what this question needs');
    var routeHint = route;
    if (needSearch) {
      datasets.push('external_reporting'); if (complexity === 'LOOKUP') complexity = 'STANDARD';
      why.push('the question asks about reporting newer than EdgeDesk\'s datasets');
      /* no research route covers it: the NEWS route reads the datasets, searches when allowed, and cross-checks */
      if (!base) { routeHint = 'NEWS'; if (datasets.indexOf('injuries') < 0) datasets.unshift('injuries'); }
      path = external.runnable ? 'ENGINE_SEARCH' : (base ? path : 'ENGINE_RESEARCH');
      if (!external.runnable) why.push('no search provider can run, so the answer uses the datasets and says how old they are');
    }

    /* steps, in the order the work actually happens (stage keys = the progress events') */
    var s = [], n = 0, id = function () { return 's' + (++n); };
    if (routeHint === 'NEWS') { s.push(step(id(), 'FIND_EVENTS', 'Resolve ' + (ent.event.kind !== 'NONE' ? eventLabel(ent) : 'the team or player'))); s.push(step(id(), 'RETRIEVE_STATS', 'Read EdgeDesk\'s injury report and depth charts, with their retrieval times')); s.push(step(id(), 'VERIFY_INJURIES', 'Cross-check any report against the official injury report')); }
    else if (path === 'DATABASE') { s.push(step(id(), 'LOOKUP', 'Read the stored value' + (ent.event.kind !== 'NONE' ? ' for ' + eventLabel(ent) : ''))); if (calcs.length) s.push(step(id(), 'CALCULATE', 'Convert the price and check its age')); }
    else if (path === 'MODEL_DESK') s.push(step(id(), 'MODEL_DESK', 'Answer with the desk (EdgeDesk data in its packet)'));
    else if (route === 'BETS') { s.push(step(id(), 'READ_HISTORY', 'Read your recorded bets')); s.push(step(id(), 'ANALYZE_HISTORY', 'Summarise results by bet type')); }
    else if (route === 'MATCHUP_EDGE') { s.push(step(id(), 'RETRIEVE_STATS', 'Read unit efficiency ratings')); }
    else if (route === 'CALIBRATION') { s.push(step(id(), 'RETRIEVE_STATS', 'Read graded predictions and the validation build')); s.push(step(id(), 'CALCULATE', 'Brier score, log loss and closing-line value')); }
    else if (route === 'VENUE_COMPARE' || route === 'CONTRACT' || route === 'PRICE' || route === 'EXPLAIN_EV') { s.push(step(id(), 'COMPARE_PRICES', 'Read the captured market for the selection')); s.push(step(id(), 'CALCULATE', 'Price it: implied, no-vig fair, fees, EV')); }
    else if (route === 'AVAILABILITY') { s.push(step(id(), 'FIND_EVENTS', 'Find ' + (ent.players.length ? ent.players[0].name + '\'s' : 'the club\'s') + ' next game')); s.push(step(id(), 'RETRIEVE_STATS', 'Read the injury report, the depth chart and the desk\'s notes, with their times')); s.push(step(id(), 'VERIFY_INJURIES', 'Cross-check the sources and flag any disagreement')); }
    else if (route === 'READINESS') { s.push(step(id(), 'FIND_EVENTS', 'Find the games in the window')); s.push(step(id(), 'COMPARE_PRICES', 'Check which games have a verified market')); }
    else if (path !== 'UNSUPPORTED') {
      s.push(step(id(), 'FIND_EVENTS', 'Find ' + (ent.event.kind === 'GAME' ? 'the game' : 'the games in the window')));
      if (complexity === 'INVESTIGATION' || ent.event.kind === 'GAME') { s.push(step(id(), 'RETRIEVE_STATS', 'Read projections, ratings and the injury report')); s.push(step(id(), 'VERIFY_INJURIES', 'Cross-check availability between sources')); }
      s.push(step(id(), 'COMPARE_PRICES', 'Re-read the market at every book'));
      s.push(step(id(), 'CALCULATE', 'Fair probability, EV, maximum price, sensitivity'));
      s.push(step(id(), 'AUDIT', 'Adversarial audit on a fresh price'));
      s.push(step(id(), 'CHALLENGE', 'Challenge the conclusion: stale data, sample size, missing players, alternatives'));
    }
    if (needSearch) {
      /* the search runs after the datasets are read and before anything is cross-checked or priced */
      var at = s.findIndex(function (x) { return x.stage === 'VERIFY_INJURIES' || x.stage === 'COMPARE_PRICES' || x.stage === 'CALCULATE'; });
      var sp = external.provider ? SEARCH[external.provider] : null;
      var ss = step('sx', 'SEARCH', external.provider ? 'Search ' + sp.label : 'Search current reporting', { provider: external.provider, est_ms: sp ? sp.ms : 0, est_usd: external.est_usd || 0, status: external.runnable ? 'planned' : 'unavailable', why: external.runnable ? null : external.why });
      s.splice(at < 0 ? s.length : at, 0, ss);
      s.forEach(function (x, i) { x.id = 's' + (i + 1); });
    }
    if (path !== 'MODEL_DESK') s.push(step('s' + (s.length + 1), 'EXPLAIN', 'Write the answer from the verified result'));
    return finish({ q: q, ent: ent, route: routeHint, complexity: complexity, path: path, datasets: uniq(datasets), calcs: uniq(calcs), steps: s, why: why, external: external, ctx: ctx });
  }
  function eventLabel(ent) { var e = ent.event; return e.kind === 'GAME' ? (e.label || 'the game open') : e.kind === 'MATCHUP' ? e.teams.join(' vs ') : e.kind === 'TEAM' ? e.team : 'the slate'; }
  function none(why) { return { needed: false, runnable: false, provider: null, why: why, est_usd: 0 }; }
  /** Which search provider would run, or why none can. Cheapest runnable first when the question is a lookup; the deep adapter for an investigation. */
  function searchDecision(q, ctx) {
    var pv = ctx.providers || {}, paid = !!ctx.paid_ok, b = ctx.budget || {};
    var cands = [];
    ['perplexity_search', 'claude_web_search'].forEach(function (k) {
      var p = pv[k] || {};
      var usd = k === 'claude_web_search' ? (SEARCH[k].usd_by_model[p.model] != null ? SEARCH[k].usd_by_model[p.model] : SEARCH[k].usd_default) : SEARCH[k].usd;
      var blocked = !p.configured ? SEARCH[k].label + ' has no API key configured'
        : !p.enabled ? SEARCH[k].label + ' is not enabled by the operator (research_provider_quota)'
          : p.schema_verified === false ? SEARCH[k].label + '\'s response schema has not been verified with a live key (tools/research/providers_live.js)'
          : !paid ? 'paid research is not authorised (EDGEDESK_RESEARCH_PAID_OK)'
            : num(b.per_request_usd) != null && usd > num(b.per_request_usd) ? 'the estimate ($' + usd.toFixed(3) + ') is over the per-request budget ($' + num(b.per_request_usd).toFixed(2) + ')'
              : num(b.remaining_today_usd) != null && usd > num(b.remaining_today_usd) ? 'today\'s research budget is spent' : null;
      cands.push({ provider: k, usd: usd, blocked: blocked });
    });
    var deep = RX.deep.test(q) || RX.offData.test(q);
    var order = deep ? ['claude_web_search', 'perplexity_search'] : ['perplexity_search', 'claude_web_search'];
    for (var i = 0; i < order.length; i++) { var c = cands.filter(function (x) { return x.provider === order[i]; })[0]; if (!c.blocked) return { needed: true, runnable: true, provider: c.provider, why: (deep ? 'an investigation: the deep adapter reads pages and quotes them' : 'a lookup: raw results are enough') , est_usd: c.usd }; }
    return { needed: true, runnable: false, provider: null, why: 'no search provider can run: ' + cands.map(function (c) { return c.blocked; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join('; ') + '. The answer uses EdgeDesk\'s datasets and says how old they are.', est_usd: 0 };
  }
  function finish(o) {
    var runnable = o.steps.filter(function (x) { return x.status === 'planned'; });
    var ms = runnable.reduce(function (a, x) { return a + (x.est_ms || 0); }, 0), usd = runnable.reduce(function (a, x) { return a + (x.est_usd || 0); }, 0);
    return {
      schema: VERSION, question: o.q,
      classification: {
        sport: o.ent.sport, league: o.ent.league, sports_named: o.ent.sports_named, unsupported_sports: o.ent.unsupported_sports,
        teams: o.ent.teams, players: o.ent.players, event: o.ent.event, complexity: o.complexity, route: o.route
      },
      path: o.path,
      datasets: o.datasets.map(function (k) { var d = DATASETS[k] || { label: k, source: k, freshness: '—' }; return { key: k, label: d.label, source: d.source, freshness: d.freshness }; }),
      calculations: o.calcs.map(function (k) { return { key: k, label: CALC[k] || k }; }),
      external: o.external,
      steps: o.steps,
      estimate: { usd: r4(usd), ms: Math.round(ms), basis: 'estimates (docs/research-engine/PROVIDERS.md §3); the ledger records actual cost' },
      why: o.why
    };
  }

  /** Planned vs actual: each planned step's final status from the progress events the run emitted. */
  function reconcile(p, events) {
    var by = {};
    (events || []).forEach(function (e) { if (e && e.type === 'progress' && e.stage) by[e.stage] = e; });
    return (p && p.steps || []).map(function (s) {
      var e = by[s.stage];
      return { id: s.id, stage: s.stage, label: s.label, planned: s.status, actual: e ? e.status : (s.status === 'unavailable' ? 'unavailable' : 'not_run'), detail: e ? e.detail : s.why };
    });
  }

  return { VERSION: VERSION, plan: plan, entities: entities, teamByCode: teamByCode, reconcile: reconcile, DATASETS: DATASETS, CALC: CALC, SEARCH: SEARCH, ROUTES: ROUTES };
});
/*__EDORCH_END__*/
