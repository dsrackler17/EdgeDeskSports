/* ===========================================================================
   EdgeDesk Games — the franchise, on the client.

   THE SERVER IS THE SOURCE OF TRUTH. supabase/games_franchise.sql generates
   the roster, scores every Price It against its own copy of the board,
   settles every card, and writes every credit to a ledger keyed once. This
   file never decides a reward; it SHOWS the published table, asks the server
   to apply it, and remembers the last answer so the HQ paints before the
   network does.

   What lives here, and why:

     * the economy table and the identity option lists, mirrored from the SQL
       so a page can render them without a round trip — and pinned to the SQL
       by tools/games/franchise.test.js, so they cannot drift apart quietly;
     * a preview of what an anonymous envelope would be worth, for the one
       honest sentence the conversion moment needs ("you have earned …");
     * the history payload a sign-up hands to franchise_import_history();
     * player-card and franchise-mark presentation, pure functions of a row;
     * the RPC client, a cached snapshot, and a queue of rewards the server
       has not confirmed yet (offline, or a request that failed) — replayed
       on the next boot, each one idempotent on the server.

   NOTHING HERE PRICES A GAME. Every number about a real matchup came out of
   the committed artifact, and the server keeps its own copy of it.
   =========================================================================== */
(function (root) {
  'use strict';

  var S = root.EDGamesSocial || (typeof require === 'function' ? require('./social.js') : null);
  var ST = root.EDGamesStore || (typeof require === 'function' ? require('./store.js') : null);
  var W = root.EDGamesWeek || (typeof require === 'function' ? require('./week.js') : null);

  /* ── the economy, economy_v1 — the same table franchise_economy() returns ── */
  var ECONOMY_VERSION = 'economy_v1';
  var ECONOMY = {
    price_it:      { xp: 50, sp_base: 5, sp_per_score: 0.35, tc_base: 10, tc_per_ten: 1 },
    pick5_card:    { xp: 75, tc: 25 },
    pick5_correct: { xp: 10, tc: 15 },
    pick5_perfect: { xp: 150, tc: 200 },
    drill_daily:   { xp: 40, tc_per_correct: 3, tc_max: 30 },
    research_open: { xp: 15, cap_per_week: 10 },
    h2h_locked:    { xp: 40, cp: 1 },
    h2h_win:       { xp: 20, cp: 2 },
    founded:       { tc: 100 },
    /* the weekly game (Phase 2): playing it, winning it, beating the
       rival, finishing a season */
    weekly_game:   { xp: 100, tc: 40 },
    weekly_win:    { xp: 60, tc: 60, cp: 2 },
    rival_win:     { xp: 50, cp: 1 },
    season_complete: { xp: 250, tc: 150 },
    /* franchise vs franchise (Phase 3): a challenge played, won, and won
       against a team rated five or more higher */
    fc_played:     { xp: 60, tc: 30 },
    fc_win:        { xp: 40, tc: 40, cp: 2 },
    fc_upset:      { xp: 40, cp: 1 },
    /* the conference (Phase 6): a round played, a round won, a playoff game
       won on top of it, and the title */
    conf_game:     { xp: 80, tc: 35 },
    conf_win:      { xp: 50, tc: 50, cp: 2 },
    conf_playoff:  { xp: 100, cp: 1 },
    conf_title:    { xp: 400, tc: 300, cp: 10 },
    /* the bowl (Phase 7): the ninth game a winning season earns, and taking it */
    bowl_game:     { xp: 150, tc: 60 },
    bowl_win:      { xp: 300, tc: 200, cp: 5 },
    import_unverified_price_it: { xp: 50 },
    import_unverified_pick5:    { xp: 75 }
  };
  var CURRENCIES = {
    xp: { key: 'xp', label: 'XP', short: 'XP', field: 'xp',
      means: 'Franchise experience. Levels follow the published curve.' },
    sp: { key: 'sp', label: 'Scouting Points', short: 'SP', field: 'scouting_points',
      means: 'Earned by Price It accuracy. Spent on scouting reports and prospects.' },
    tc: { key: 'tc', label: 'Team Credits', short: 'TC', field: 'team_credits',
      means: 'Earned by playing. Spent on ordinary upgrades and progression.' },
    cp: { key: 'cp', label: 'Coach Points', short: 'CP', field: 'coach_points',
      means: 'Earned in competition. Spent on scheme and facility progression.' }
  };

  /* integer arithmetic on purpose: 90 × 0.35 is 31.499999… in a float and
     31.50 in the server's numeric, and the two must round the same way */
  function spForScore(score) { return ECONOMY.price_it.sp_base + Math.round(((+score || 0) * 35) / 100); }
  function tcForScore(score) { return ECONOMY.price_it.tc_base + Math.floor((+score || 0) / 10) * ECONOMY.price_it.tc_per_ten; }
  function tcForDrill(correct) { return Math.min(ECONOMY.drill_daily.tc_max, (correct | 0) * ECONOMY.drill_daily.tc_per_correct); }

  /* What ONE real thing is worth, by the table. Display only. */
  function rewardsFor(kind, o) {
    o = o || {};
    switch (kind) {
      case 'price_it': return { xp: ECONOMY.price_it.xp, sp: spForScore(o.score), tc: tcForScore(o.score) };
      case 'pick5_card': return { xp: ECONOMY.pick5_card.xp, tc: ECONOMY.pick5_card.tc };
      case 'pick5_correct': return { xp: ECONOMY.pick5_correct.xp, tc: ECONOMY.pick5_correct.tc };
      case 'pick5_perfect': return { xp: ECONOMY.pick5_perfect.xp, tc: ECONOMY.pick5_perfect.tc };
      case 'drill_daily': return { xp: ECONOMY.drill_daily.xp, tc: tcForDrill(o.correct) };
      case 'research_open': return { xp: ECONOMY.research_open.xp };
      case 'h2h_locked': return { xp: ECONOMY.h2h_locked.xp, cp: ECONOMY.h2h_locked.cp };
      case 'h2h_win': return { xp: ECONOMY.h2h_win.xp, cp: ECONOMY.h2h_win.cp };
      case 'founded': return { tc: ECONOMY.founded.tc };
      case 'weekly_game': return { xp: ECONOMY.weekly_game.xp, tc: ECONOMY.weekly_game.tc };
      case 'weekly_win': return { xp: ECONOMY.weekly_win.xp, tc: ECONOMY.weekly_win.tc, cp: ECONOMY.weekly_win.cp };
      case 'rival_win': return { xp: ECONOMY.rival_win.xp, cp: ECONOMY.rival_win.cp };
      case 'season_complete': return { xp: ECONOMY.season_complete.xp, tc: ECONOMY.season_complete.tc };
      case 'fc_played': return { xp: ECONOMY.fc_played.xp, tc: ECONOMY.fc_played.tc };
      case 'fc_win': return { xp: ECONOMY.fc_win.xp, tc: ECONOMY.fc_win.tc, cp: ECONOMY.fc_win.cp };
      case 'fc_upset': return { xp: ECONOMY.fc_upset.xp, cp: ECONOMY.fc_upset.cp };
      case 'conf_game': return { xp: ECONOMY.conf_game.xp, tc: ECONOMY.conf_game.tc };
      case 'conf_win': return { xp: ECONOMY.conf_win.xp, tc: ECONOMY.conf_win.tc, cp: ECONOMY.conf_win.cp };
      case 'conf_playoff': return { xp: ECONOMY.conf_playoff.xp, cp: ECONOMY.conf_playoff.cp };
      case 'conf_title': return { xp: ECONOMY.conf_title.xp, tc: ECONOMY.conf_title.tc, cp: ECONOMY.conf_title.cp };
      case 'bowl_game': return { xp: ECONOMY.bowl_game.xp, tc: ECONOMY.bowl_game.tc };
      case 'bowl_win': return { xp: ECONOMY.bowl_win.xp, tc: ECONOMY.bowl_win.tc, cp: ECONOMY.bowl_win.cp };
    }
    return {};
  }

  /* ── the level curve: the War Room's, restated once ──────────────────── */
  var MAX_LEVEL = 30;
  function xpForLevel(L) { L = Math.max(1, Math.min(MAX_LEVEL, L | 0)); return 25 * (L - 1) * (L + 2); }
  function levelFor(xp) {
    xp = Math.max(0, +xp || 0);
    var L = 1;
    while (L < MAX_LEVEL && xp >= xpForLevel(L + 1)) L++;
    return L;
  }
  function levelInfo(xp) {
    xp = Math.max(0, +xp || 0);
    var L = levelFor(xp), at = xpForLevel(L), nxt = L < MAX_LEVEL ? xpForLevel(L + 1) : null;
    return { level: L, xp: xp, at: at, next: nxt,
      remaining: nxt == null ? 0 : nxt - xp,
      pct: nxt == null ? 100 : Math.max(0, Math.min(100, Math.round(100 * (xp - at) / (nxt - at)))) };
  }

  /* ── identity: the option lists, exactly the SQL's check constraints ─── */
  var LOGOS = [
    { key: 'star',   label: 'Star' },   { key: 'bolt',   label: 'Bolt' },
    { key: 'shield', label: 'Shield' }, { key: 'wolf',   label: 'Wolf' },
    { key: 'horn',   label: 'Horn' },   { key: 'anchor', label: 'Anchor' },
    { key: 'arrow',  label: 'Arrow' },  { key: 'flame',  label: 'Flame' },
    { key: 'crown',  label: 'Crown' },  { key: 'wing',   label: 'Wing' },
    { key: 'gear',   label: 'Gear' },   { key: 'wave',   label: 'Wave' },
    { key: 'peak',   label: 'Peak' },   { key: 'eagle',  label: 'Eagle' },
    { key: 'bull',   label: 'Bull' },   { key: 'spear',  label: 'Spear' }
  ];
  var THEMES = [
    { key: 'forest',  label: 'Forest',  primary: '#3fb883', secondary: '#123326', ink: '#06231a' },
    { key: 'navy',    label: 'Navy',    primary: '#5c9dff', secondary: '#12203a', ink: '#061a3a' },
    { key: 'crimson', label: 'Crimson', primary: '#e2664b', secondary: '#3a1611', ink: '#2a0c08' },
    { key: 'gold',    label: 'Gold',    primary: '#d9a441', secondary: '#3a2a0e', ink: '#2a1c06' },
    { key: 'slate',   label: 'Slate',   primary: '#a9b6c9', secondary: '#252b36', ink: '#12161d' },
    { key: 'violet',  label: 'Violet',  primary: '#9d7bff', secondary: '#261c40', ink: '#170f2a' },
    { key: 'teal',    label: 'Teal',    primary: '#3fc1b8', secondary: '#0f2f2d', ink: '#06211f' },
    { key: 'orange',  label: 'Orange',  primary: '#f28c38', secondary: '#3a230e', ink: '#2a1706' },
    { key: 'maroon',  label: 'Maroon',  primary: '#b8405a', secondary: '#33121a', ink: '#240b11' },
    { key: 'black',   label: 'Black',   primary: '#e9edf4', secondary: '#1a1e27', ink: '#0b0d11' }
  ];
  var OFFENSES = [
    { key: 'air_raid',   label: 'Air Raid',   blurb: 'Four wide, quick reads, the ball in the air.' },
    { key: 'spread',     label: 'Spread',     blurb: 'Tempo and space; the quarterback runs too.' },
    { key: 'pro_style',  label: 'Pro Style',  blurb: 'Under center, play-action, a tight end who blocks.' },
    { key: 'power_run',  label: 'Power Run',  blurb: 'Gap scheme, pulling guards, a back who finishes.' },
    { key: 'option',     label: 'Option',     blurb: 'Reads at the mesh point; the defense chooses wrong.' },
    { key: 'west_coast', label: 'West Coast', blurb: 'Short timing throws that move the chains.' }
  ];
  var DEFENSES = [
    { key: 'four_three',      label: '4–3',              blurb: 'Four down, three backers, gaps accounted for.' },
    { key: 'three_four',      label: '3–4',              blurb: 'Two-gap linemen and edge backers who rush.' },
    { key: 'press_man',       label: 'Press Man',        blurb: 'Corners at the line; trust them or don’t.' },
    { key: 'zone',            label: 'Zone',             blurb: 'Eyes on the quarterback, hats to the ball.' },
    { key: 'blitz_heavy',     label: 'Blitz Heavy',      blurb: 'Bring six and live with the answer.' },
    { key: 'bend_dont_break', label: 'Bend, Don’t Break', blurb: 'Give up yards, not points.' }
  ];
  function optionOf(list, key) { var i; for (i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }

  /* ── players: positions, attributes, rarity ──────────────────────────── */
  var POSITIONS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P'];
  var POSITION_NAMES = { QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end',
    OL: 'Offensive line', DL: 'Defensive line', LB: 'Linebacker', CB: 'Cornerback', S: 'Safety',
    K: 'Kicker', P: 'Punter' };
  var STARTERS = { QB: 1, RB: 1, WR: 3, TE: 1, OL: 5, DL: 4, LB: 3, CB: 2, S: 2, K: 1, P: 1 };
  var SIDE = { QB: 'offense', RB: 'offense', WR: 'offense', TE: 'offense', OL: 'offense',
    DL: 'defense', LB: 'defense', CB: 'defense', S: 'defense', K: 'special', P: 'special' };
  var ATTR_ORDER = {
    QB: ['arm', 'acc', 'iq', 'spd'], RB: ['spd', 'pwr', 'elu', 'hnd'], WR: ['spd', 'rte', 'hnd', 'iq'],
    TE: ['hnd', 'blk', 'rte', 'spd'], OL: ['pbk', 'rbk', 'str', 'iq'], DL: ['prs', 'rst', 'str', 'spd'],
    LB: ['tkl', 'cov', 'spd', 'iq'], CB: ['cov', 'spd', 'tkl', 'bhk'], S: ['cov', 'tkl', 'bhk', 'iq'],
    K: ['pwr', 'acc', 'clu', 'con'], P: ['pwr', 'acc', 'clu', 'con']
  };
  var ATTRS = {
    arm: 'ARM', acc: 'ACC', iq: 'IQ', spd: 'SPD', pwr: 'PWR', elu: 'ELU', hnd: 'HND', rte: 'RTE',
    blk: 'BLK', pbk: 'PBK', rbk: 'RBK', str: 'STR', prs: 'PRS', rst: 'RST', tkl: 'TKL', cov: 'COV',
    bhk: 'BHK', clu: 'CLU', con: 'CON'
  };
  var ATTR_NAMES = {
    arm: 'Arm strength', acc: 'Accuracy', iq: 'Football IQ', spd: 'Speed', pwr: 'Power', elu: 'Elusiveness',
    hnd: 'Hands', rte: 'Route running', blk: 'Blocking', pbk: 'Pass blocking', rbk: 'Run blocking',
    str: 'Strength', prs: 'Pass rush', rst: 'Run stop', tkl: 'Tackling', cov: 'Coverage',
    bhk: 'Ball skills', clu: 'Clutch', con: 'Consistency'
  };
  var RARITY = {
    common:   { key: 'common',   label: 'Common',   rank: 0 },
    uncommon: { key: 'uncommon', label: 'Uncommon', rank: 1 },
    rare:     { key: 'rare',     label: 'Rare',     rank: 2 },
    elite:    { key: 'elite',    label: 'Elite',    rank: 3 }
  };
  var DEV_TIERS = { normal: 'Steady', quick: 'Quick', star: 'Star', superstar: 'Superstar' };
  /* the achievement definitions the SQL seeds, by id, so a reveal can name
     one the moment the server awards it; an id not listed here shows as
     its words */
  var ACHIEVEMENTS = {
    founder_2026:  { name: 'Founder Season 2026', exclusive: 2026 },
    first_price:   { name: 'First Scout' },
    market_master: { name: 'Market Master' },
    first_card:    { name: 'First Card' },
    perfect_card:  { name: 'Perfect Card' },
    first_h2h_win: { name: 'First Head-to-Head' },
    first_win:      { name: 'First Win' },
    bragging_rights: { name: 'Bragging Rights' },
    shutout:        { name: 'Shutout' },
    first_season:   { name: 'A Full Season' },
    winning_season: { name: 'Winning Season' },
    perfect_season: { name: 'Perfect Season' },
    fc_first:       { name: 'Exhibition Debut' },
    fc_first_win:   { name: 'Beat a Friend' },
    fc_upset:       { name: 'Giant Killer' },
    fc_three:       { name: 'Three Straight' },
    first_upgrade:  { name: 'Groundbreaking' },
    breakout:       { name: 'Breakout' },
    farewell:       { name: 'Farewell' },
    draft_day:      { name: 'Draft Day' },
    full_scout:     { name: 'Scouted the Class' },
    gut_call:       { name: 'Gut Call' },
    first_signing:  { name: 'Open for Business' },
    conf_first:     { name: 'League of Friends' },
    conf_top:       { name: 'Top Seed' },
    conf_post:      { name: 'Postseason' },
    conf_title:     { name: 'Champion' },
    conf_two:       { name: 'Two Rings' },
    bowl_bid:       { name: 'Bowl Bid' },
    bowl_win:       { name: 'Bowl Winner' },
    trade_first:    { name: 'The Deal' },
    next_man_up:    { name: 'Next Man Up' }
  };
  function achievementName(id) {
    var a = ACHIEVEMENTS[id];
    return a ? a.name : String(id || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  /* display only — the server computes the team rating with these weights */
  var RATING_WEIGHTS = {
    offense: { QB: 0.30, RB: 0.12, WR: 0.22, TE: 0.08, OL: 0.28 },
    defense: { DL: 0.30, LB: 0.22, CB: 0.28, S: 0.20 },
    special: { K: 0.50, P: 0.50 },
    overall: { offense: 0.45, defense: 0.45, special: 0.10 }
  };

  /* ── the weekly game, sim_v1 — the published shape of the simulator ────
     The simulator runs on the server and nowhere else. These are the
     numbers it publishes so a pregame can say what is in play: home field,
     how much this week's preparation swings, and the scheme matchup table
     (offense against defense, in rating points for the offense). The
     table is pinned to franchise_scheme_edges() by the test suite. */
  var SIM_VERSION = 'sim_v1';
  var HOME_EDGE = 1.5;
  var PREP_SWING = 3;                       /* preparation 0 → −3, 100 → +3 */
  var SCHEME_EDGES = {
    air_raid:   { four_three: 0, three_four: 0,  press_man: -2, zone: 1,  blitz_heavy: 2,  bend_dont_break: -1 },
    spread:     { four_three: 0, three_four: -1, press_man: 1,  zone: 0,  blitz_heavy: 1,  bend_dont_break: -1 },
    pro_style:  { four_three: 0, three_four: 1,  press_man: 0,  zone: 1,  blitz_heavy: -2, bend_dont_break: 1 },
    power_run:  { four_three: 1, three_four: -2, press_man: 2,  zone: 0,  blitz_heavy: -1, bend_dont_break: 1 },
    option:     { four_three: -1, three_four: 1, press_man: 1,  zone: -2, blitz_heavy: 1,  bend_dont_break: 0 },
    west_coast: { four_three: 0, three_four: 0,  press_man: -1, zone: -1, blitz_heavy: 1,  bend_dont_break: 1 }
  };
  function schemeEdge(offense, defense) {
    var row = SCHEME_EDGES[offense];
    return row && row[defense] != null ? row[defense] : 0;
  }
  function prepAdj(preparation) {
    var p = Math.max(0, Math.min(100, +preparation || 0));
    return Math.round(((p - 50) / 50) * PREP_SWING * 100) / 100;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { n = Math.round(+n || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function fullName(p) { return ((p && p.first_name) || '') + ' ' + ((p && p.last_name) || ''); }
  function keyRatings(p) {
    var order = ATTR_ORDER[p && p.position] || [], r = (p && p.ratings) || {};
    return order.map(function (k) { return { key: k, label: ATTRS[k], name: ATTR_NAMES[k], value: r[k] == null ? null : (r[k] | 0) }; });
  }
  function isStarter(p) { return !!p && (p.depth | 0) >= 1 && (p.depth | 0) <= (STARTERS[p.position] || 1); }
  function traitOf(p) { var t = p && p.traits; return (Array.isArray(t) && t.length) ? t[0] : null; }
  /* A stat object as one line, by position. The keys are the ones the
     simulator writes (franchise_sim_lines); a card's career and season
     lines are the sums of its box scores. */
  function statsLine(pos, c, o) {
    c = c || {}; o = o || {};
    var bits = [];
    function n(k) { return c[k] == null ? 0 : +c[k] || 0; }
    switch (pos) {
      case 'QB':
        if (c.att != null || c.yds != null) bits.push(n('cmp') + '/' + n('att') + ', ' + fmt(n('yds')) + ' yds');
        if (n('td')) bits.push(n('td') + ' TD');
        if (n('int')) bits.push(n('int') + ' INT');
        if (n('rush_yds') >= 20 || n('rush_td')) bits.push(fmt(n('rush_yds')) + ' rush yds' + (n('rush_td') ? ', ' + n('rush_td') + ' rush TD' : ''));
        break;
      case 'RB':
        if (c.car != null || c.yds != null) bits.push(n('car') + ' car, ' + fmt(n('yds')) + ' yds');
        if (n('td')) bits.push(n('td') + ' TD');
        if (n('rec')) bits.push(n('rec') + ' rec, ' + fmt(n('rec_yds')) + ' yds' + (n('rec_td') ? ', ' + n('rec_td') + ' TD' : ''));
        break;
      case 'WR': case 'TE':
        if (c.rec != null || c.yds != null) bits.push(n('rec') + ' rec, ' + fmt(n('yds')) + ' yds');
        if (n('td')) bits.push(n('td') + ' TD');
        break;
      case 'DL': case 'LB': case 'CB': case 'S':
        if (c.tkl != null) bits.push(n('tkl') + ' tkl');
        if (n('sacks')) bits.push(n('sacks') + (n('sacks') === 1 ? ' sack' : ' sacks'));
        if (n('int')) bits.push(n('int') + ' INT');
        break;
      case 'K':
        if (c.fga != null) bits.push(n('fg') + '/' + n('fga') + ' FG');
        if (n('xp')) bits.push(n('xp') + ' PAT');
        break;
      case 'P':
        if (c.punts != null) bits.push(n('punts') + ' punts' + (n('punts') && c.punt_yds != null ? ', ' + (n('punt_yds') / n('punts')).toFixed(1) + ' avg' : ''));
        break;
      case 'OL':
        if (c.games != null) bits.push('started');
        break;
    }
    if (o.games && c.games != null) bits.push(n('games') + ' GP');
    return bits.join(', ');
  }
  function careerLine(p) {
    var c = (p && p.career_stats) || {};
    var line = statsLine(p && p.position, c, { games: true });
    return line || ('Career begins ' + (p && p.acquired_season ? p.acquired_season : ''));
  }
  function seasonLine(p) {
    var c = (p && p.season_stats) || {};
    if (c.games == null) return '';
    return statsLine(p && p.position, c, { games: true });
  }
  var SOURCES = { founding_roster: 'Founder roster', offseason_rookie: 'Rookie', draft: 'Drafted',
                  free_agent: 'Free agent', trade: 'Traded for' };
  function acquiredLine(p) {
    if (!p) return '';
    var src = SOURCES[p.acquired_source] || String(p.acquired_source || '').replace(/_/g, ' ');
    return src + (p.acquired_season ? ' · ' + p.acquired_season : '') + (p.acquired_detail && p.acquired_detail !== src ? ' · ' + p.acquired_detail : '');
  }

  /* THE PLAYER CARD. A pure function of a row: collectible, readable on a
     phone, and consistent with its own numbers (the overall is the mean of
     the four attributes shown). */
  function playerCard(p, o) {
    o = o || {};
    if (!p) return '';
    var rar = RARITY[p.rarity] || RARITY.common, tr = traitOf(p), starter = isStarter(p);
    var hurt = !isAvailable(p), hurtLine = hurt ? injuryLine(p) : '';
    var attrs = keyRatings(p).map(function (a) {
      return '<div class="pc-a"><span class="k">' + esc(a.label) + '</span><b>' + (a.value == null ? '—' : a.value) + '</b></div>';
    }).join('');
    return '<article class="pc pc-' + esc(rar.key) + (starter ? ' pc-start' : '') + (hurt ? ' pc-hurt' : '') + (o.compact ? ' pc-compact' : '')
      + '" data-player="' + esc(p.id) + '" data-position="' + esc(p.position) + '" data-depth="' + (p.depth | 0) + '">'
      + '<div class="pc-top"><span class="pc-num mono">#' + (p.jersey == null ? '—' : p.jersey) + '</span>'
      + '<span class="pc-pos">' + esc(p.position) + '</span>'
      + '<span class="pc-rar">' + esc(rar.label) + '</span>'
      + (starter ? '<span class="pc-st">' + (STARTERS[p.position] > 1 ? esc(p.position) + (p.depth | 0) : 'Starter') + '</span>' : '')
      + (hurt ? '<span class="pc-out">Out</span>' : '')
      + '</div>'
      + '<div class="pc-name">' + esc(fullName(p)) + '</div>'
      + '<div class="pc-arch">' + esc(p.position) + ' <span class="sep">|</span> ' + esc(p.archetype || '') + '</div>'
      + '<div class="pc-ovr"><b class="mono">' + (p.overall | 0) + '</b><span>OVR</span></div>'
      + '<div class="pc-attrs">' + attrs + '</div>'
      + (tr ? '<div class="pc-trait"><span class="k">Trait</span><b>' + esc(tr.name) + '</b><span class="d">' + esc(tr.desc || '') + '</span></div>'
            : '<div class="pc-trait none"><span class="k">Trait</span><span class="d">None yet</span></div>')
      + '<div class="pc-meta">Age ' + (p.age | 0) + ' <span class="sep">·</span> POT ' + (p.potential | 0)
      + ' <span class="sep">·</span> ' + esc(DEV_TIERS[p.dev_tier] || p.dev_tier || '') + '</div>'
      + (hurt ? '<div class="pc-injury"><span class="k">Unavailable</span>' + esc(hurtLine) + '</div>' : '')
      + '<div class="pc-acq"><span class="k">Acquired</span>' + esc(acquiredLine(p)) + '</div>'
      + (seasonLine(p) ? '<div class="pc-career"><span class="k">This season</span>' + esc(seasonLine(p)) + '</div>' : '')
      + '<div class="pc-career"><span class="k">Career</span>' + esc(careerLine(p)) + '</div>'
      + (o.actions ? '<div class="pc-actions">' + o.actions + '</div>' : '')
      + '</article>';
  }

  /* Group a roster by position in canonical order, starters first. */
  function groups(players) {
    var by = {}, out = [];
    (players || []).forEach(function (p) { (by[p.position] = by[p.position] || []).push(p); });
    POSITIONS.forEach(function (pos) {
      if (!by[pos]) return;
      by[pos].sort(function (a, b) { return (a.depth - b.depth) || (b.overall - a.overall); });
      out.push({ position: pos, name: POSITION_NAMES[pos], side: SIDE[pos], starters: STARTERS[pos], players: by[pos] });
    });
    return out;
  }

  /* A weak spot: the lowest-rated starting group, by the server's numbers. */
  function weakest(rating) {
    var g = rating && rating.groups, best = null, k;
    if (!g) return null;
    for (k in g) if (g.hasOwnProperty(k) && (!best || g[k] < g[best])) best = k;
    return best ? { position: best, name: POSITION_NAMES[best], value: g[best] } : null;
  }
  function strongest(rating) {
    var g = rating && rating.groups, best = null, k;
    if (!g) return null;
    for (k in g) if (g.hasOwnProperty(k) && (!best || g[k] > g[best])) best = k;
    return best ? { position: best, name: POSITION_NAMES[best], value: g[best] } : null;
  }

  /* ── the franchise mark ──────────────────────────────────────────────── */
  var MARKS = {
    star:   'M16 3l3.6 7.6 8.4 1-6.2 5.7 1.7 8.3L16 21.5l-7.5 4.1 1.7-8.3-6.2-5.7 8.4-1z',
    bolt:   'M18 2L7 18h7l-2 12 11-17h-7z',
    shield: 'M16 3l10 4v8c0 7-4.5 11.5-10 14C10.5 26.5 6 22 6 15V7z',
    wolf:   'M6 6l5 5h10l5-5v9c0 6-4 10-10 12C10 25 6 21 6 15zM12 16h3v3h-3zM17 16h3v3h-3z',
    horn:   'M4 20c0-8 6-14 14-14h10v6h-8c-5 0-8 3-8 8v6H4z',
    anchor: 'M16 3a3 3 0 110 6 3 3 0 010-6zm-1 7h2v14a8 8 0 006-5h3a11 11 0 01-20 0h3a8 8 0 006 5z',
    arrow:  'M16 3l9 10h-5v16h-8V13H7z',
    flame:  'M16 3c1 6 7 8 7 15a7 7 0 01-14 0c0-3 2-5 2-5 0 3 2 4 2 4 0-6 3-9 3-14z',
    crown:  'M4 10l7 6 5-9 5 9 7-6-3 16H7z',
    wing:   'M4 18c8-2 14-8 24-12-2 8-8 14-16 18-2 1-4 0-4-2 3-1 6-3 8-5-5 2-9 2-12 1z',
    gear:   'M16 6a10 10 0 110 20 10 10 0 010-20zm0 6a4 4 0 100 8 4 4 0 000-8zM14 2h4v4h-4zM14 26h4v4h-4zM2 14h4v4H2zM26 14h4v4h-4z',
    wave:   'M2 20c4 0 4-6 8-6s4 6 8 6 4-6 8-6 4 6 6 6v6H2z',
    peak:   'M2 27L12 7l5 9 3-5 10 16z',
    eagle:  'M16 4l3 7h9l-7 5 3 8-8-5-8 5 3-8-7-5h9z',
    bull:   'M4 6c3 4 6 6 8 6h8c2 0 5-2 8-6-1 6-4 9-6 10v7a6 6 0 01-12 0v-7c-2-1-5-4-6-10z',
    spear:  'M27 5l-4 1-12 12-3-3-4 4 6 6 4-4-3-3L23 6z'
  };
  function logoSvg(key, size, theme) {
    var d = MARKS[key] || MARKS.star, t = optionOf(THEMES, theme) || THEMES[0];
    size = size || 40;
    return '<svg class="fr-mark" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
      + '<rect width="32" height="32" rx="8" fill="' + t.secondary + '"/>'
      + '<path d="' + d + '" fill="' + t.primary + '"/></svg>';
  }
  function themeVars(theme) {
    var t = optionOf(THEMES, theme) || THEMES[0];
    return '--fr-primary:' + t.primary + ';--fr-secondary:' + t.secondary + ';--fr-ink:' + t.ink;
  }
  function identity(f) {
    f = f || {};
    return {
      logo: optionOf(LOGOS, f.logo), theme: optionOf(THEMES, f.theme),
      offense: optionOf(OFFENSES, f.offense), defense: optionOf(DEFENSES, f.defense),
      title: ((f.city || '') + ' ' + (f.name || '')).trim()
    };
  }

  /* ── this week's preparation, from the home read model ───────────────────
     Preparation is capped at 100 and is a READ of what the player did this
     football week — it never changes a roster rating. Phase 2 moves the
     authoritative number to the server; this is the published shape. */
  var PREP_VERSION = 'prep_v1';
  function prep(week) {
    week = week || {};
    var priced = week.price_it | 0, drills = week.drills | 0, research = week.research | 0;
    var scouting = Math.min(100, Math.round(priced / 3 * 100));
    var preparation = Math.min(100, Math.round(
      40 * Math.min(1, priced / 3) + 25 * (week.pick5_submitted ? 1 : 0)
      + 20 * Math.min(1, drills) + 15 * Math.min(1, research / 2)));
    var iq = week.price_it_avg_score == null ? null : Math.max(0, Math.min(100, Math.round(+week.price_it_avg_score)));
    return { version: PREP_VERSION, scouting: scouting, preparation: preparation, market_iq: iq };
  }

  /* ── the weekly game, on the client ─────────────────────────────────────
     Pure reads of the home read model: where the season stands, who is
     next, when the game opens, and how a result is said. Nothing here
     decides a result; the server has already decided it or not yet. */
  function opponentTitle(opp) { opp = opp || {}; return ((opp.city || '') + ' ' + (opp.name || '')).trim(); }
  function matchupLine(game) { return game ? ((game.home ? 'vs ' : 'at ') + opponentTitle(game.opponent)) : ''; }
  function resultLine(game) {
    if (!game || game.status !== 'final') return '';
    return (game.result || '') + ' ' + (game.score_for | 0) + '–' + (game.score_against | 0) + (game.ot ? ' (OT)' : '');
  }
  /* how long until a game opens, said plainly */
  function opensIn(iso, nowMs) {
    var t = Date.parse(String(iso || '').replace(' ', 'T')), now = nowMs || Date.now();
    if (!isFinite(t)) return { ms: 0, days: 0, hours: 0, open: false, label: '' };
    var ms = t - now;
    if (ms <= 0) return { ms: 0, days: 0, hours: 0, open: true, label: 'open now' };
    var hours = Math.ceil(ms / 3600000), days = Math.ceil(ms / 86400000);
    return { ms: ms, days: days, hours: hours, open: false,
      label: hours <= 24 ? ('opens in ' + hours + (hours === 1 ? ' hour' : ' hours')) : ('opens in ' + days + ' days') };
  }
  /* Where the franchise stands, for a page deciding what to show:
       'preseason'  the season has no schedule yet (start it)
       'ready'      the next game has opened — play it
       'waiting'    the next game opens on its Saturday
       'complete'   the season is over — start the next one
       'between'    no game is scheduled (should not happen; say so) */
  function gamePhase(snap, nowMs) {
    if (!snap || !snap.franchise) return null;
    var ss = snap.season || {}, ng = snap.next_game || null, now = nowMs || Date.now();
    if (ss.status === 'preseason') return { phase: 'preseason', game: null, season: ss };
    if (ss.status === 'complete') return { phase: 'complete', game: null, season: ss };
    if (!ng) return { phase: 'between', game: null, season: ss };
    var o = opensIn(ng.opens_at, now), open = ng.open === true || o.open;
    /* the bowl is the ninth game a winning season earned (Phase 7): the same
       phase as any other, named differently */
    return { phase: open ? 'ready' : 'waiting', game: ng, season: ss, opens: o, bowl: !!ng.bowl };
  }
  /* what a pregame can say about the matchup, from the published numbers */
  function matchupEdges(f, game, prep) {
    if (!f || !game || !game.opponent) return null;
    var opp = game.opponent, p = prep && prep.preparation != null ? prep.preparation : 0;
    return {
      home: game.home ? HOME_EDGE : 0,
      prep: p, prep_adj: prepAdj(p),
      scheme_offense: schemeEdge(f.offense, opp.defense),
      scheme_defense: schemeEdge(opp.offense, f.defense),
      offense: optionOf(OFFENSES, f.offense), defense: optionOf(DEFENSES, f.defense),
      opp_offense: optionOf(OFFENSES, opp.offense), opp_defense: optionOf(DEFENSES, opp.defense)
    };
  }
  /* the text a result is shared as: factual, no claim */
  function gameShareText(f, game, season) {
    if (!f || !game) return '';
    var me = ((f.city || '') + ' ' + (f.name || '')).trim().toUpperCase(), opp = opponentTitle(game.opponent);
    var L = [];
    if (game.status === 'final') {
      L.push(me + ' ' + (game.score_for | 0) + ', ' + opp + ' ' + (game.score_against | 0) + (game.ot ? ' (OT)' : ''));
    } else {
      L.push(me + ' ' + matchupLine(game));
    }
    L.push('EdgeDesk ' + ((season && season.label) || 'Season I') + ' · Week ' + (game.week | 0) + (game.rival ? ' · Rivalry game' : ''));
    if (game.potg && game.potg.name) L.push('Player of the game: ' + game.potg.name + ', ' + game.potg.position + ' — ' + statsLine(game.potg.position, game.potg.stats));
    if (season && game.status === 'final') L.push('Now ' + (season.wins | 0) + '–' + (season.losses | 0) + (season.ties ? '–' + season.ties : '') + '.');
    L.push('');
    L.push('Found yours:');
    L.push('EdgeDesk Games');
    return L.join('\n');
  }

  /* ── franchise vs franchise ─────────────────────────────────────────────
     A challenge is a link; the franchise that opens it plays it at once,
     on the server. These say the invite, the result and a record plainly. */
  var LADDER_START = 1500, LADDER_K = 24;
  function recordLine(r) { r = r || {}; return (r.wins | 0) + '–' + (r.losses | 0) + (r.ties ? '–' + r.ties : ''); }
  function challengeUrl(token) {
    var o = (root.location && root.location.origin) || 'https://edgedesksports.com';
    return o + '/games/gameday/?fc=' + encodeURIComponent(String(token || ''));
  }
  /* the invite, as text: who is calling, how good they are, and the door */
  function challengeInviteText(f, ch) {
    var me = f ? ((f.city || '') + ' ' + (f.name || '')).trim() : 'My franchise';
    var L = [];
    L.push('The ' + me + (f && f.overall != null ? ' (OVR ' + f.overall + (f.record ? ', ' + recordLine(f.record) : '') + ')' : '') + ' challenge your franchise.');
    if (ch && ch.note) L.push('“' + ch.note + '”');
    L.push('One game, on the server, from both rosters. No account needed — found a franchise free and play it here:');
    return L.join('\n');
  }
  /* the result, as text, from my side */
  function challengeShareText(ch) {
    if (!ch || !ch.me) return '';
    var me = ((ch.me.city || '') + ' ' + (ch.me.name || '')).trim().toUpperCase(), them = ch.them ? ((ch.them.city || '') + ' ' + (ch.them.name || '')).trim() : 'a franchise';
    var L = [];
    if (ch.status === 'FINAL') {
      L.push(me + ' ' + (ch.score_for | 0) + ', ' + them + ' ' + (ch.score_against | 0) + (ch.ot ? ' (OT)' : ''));
      L.push('EdgeDesk franchise challenge · neutral field');
      if (ch.potg && ch.potg.name) L.push('Player of the game: ' + ch.potg.name + ', ' + ch.potg.position + ' — ' + statsLine(ch.potg.position, ch.potg.stats));
      if (ch.rating_delta != null) L.push('Ladder: ' + (ch.rating_delta > 0 ? '+' : '') + ch.rating_delta);
    } else {
      L.push(me + ' challenge ' + them + '.');
    }
    L.push('');
    L.push('EdgeDesk Games');
    return L.join('\n');
  }

  /* ── the anonymous envelope: what it would be worth, and its payload ──── */
  /* ── THE OFFSEASON AND THE FACILITIES (Phase 4) ─────────────────────────
     Mirrors of franchise_facilities() and franchise_offseason() in the SQL,
     for display only: the client shows a price, the server charges it; the
     client explains a report, the server wrote it. Pinned to the SQL by
     tools/games/franchise.test.js. */
  var FACILITIES_VERSION = 'facilities_v1';
  var FACILITIES = {
    training:     { name: 'Training Center', currency: 'tc', costs: [300, 600, 1000], per_level: 1,
                    effect: '+1 development a level for players 26 and under, each offseason; veterans fade slower at levels 2 and 3' },
    film:         { name: 'Film Room',       currency: 'cp', costs: [6, 12, 20],      per_level: 0.5,
                    effect: '+0.5 offense and defense in every game' },
    conditioning: { name: 'Conditioning',    currency: 'tc', costs: [300, 600, 1000], per_level: 0.5,
                    effect: '+0.5 in the fourth quarter and overtime' },
    stadium:      { name: 'Stadium',         currency: 'cp', costs: [6, 12, 20],      per_level: 0.25,
                    effect: '+0.25 home field in season games' }
  };
  var FACILITY_ORDER = ['training', 'film', 'conditioning', 'stadium'];
  /* one facility as a page shows it: the level, what the next one costs,
     and whether what is on hand covers it. The server decides again. */
  function facilityState(key, facilities, resources) {
    var spec = FACILITIES[key];
    if (!spec) return null;
    var level = Math.max(0, Math.min(spec.costs.length, obj(facilities)[key] | 0));
    var top = level >= spec.costs.length, cost = top ? null : spec.costs[level];
    var cur = CURRENCIES[spec.currency], have = obj(resources)[cur.field] | 0;
    return { key: key, name: spec.name, currency: spec.currency, unit: cur.short, level: level, max: spec.costs.length, top: top,
      cost: cost, have: have, affordable: !top && have >= cost, short: top ? 0 : Math.max(0, cost - have),
      effect: spec.effect, bonus: spec.per_level * level, next_bonus: top ? null : spec.per_level * (level + 1) };
  }
  function facilityStates(facilities, resources) {
    return FACILITY_ORDER.map(function (k) { return facilityState(k, facilities, resources); });
  }
  function facilityLine(key, level) {
    var spec = FACILITIES[key];
    return spec ? spec.name + ' · level ' + (level | 0) + ' of ' + spec.costs.length : '';
  }
  var OFFSEASON_VERSION = 'offseason_v1';
  /* the retirement rule, as the SQL applies it: at 35, or at 33 and under 55 */
  var RETIRE_AGE = 35, FADE_AGE = 33, FADE_OVERALL = 55;
  function roman(n) {
    n = n | 0; if (n <= 0 || n >= 4000) return String(n);
    var t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']], out = '', i;
    for (i = 0; i < t.length; i++) while (n >= t[i][0]) { out += t[i][1]; n -= t[i][0]; }
    return out;
  }
  /* the offseason report in one sentence: who improved, who declined, who
     retired, who was signed. Every number is the server's. */
  function offseasonLine(rep) {
    rep = obj(rep); var s = obj(rep.summary), bits = [];
    if (rep.after_season == null) return '';
    bits.push((s.improved | 0) + ' improved');
    bits.push((s.declined | 0) + ' declined');
    if (s.retired | 0) bits.push((s.retired | 0) + ' retired');
    if (s.signed | 0) bits.push((s.signed | 0) + ' rookie' + ((s.signed | 0) === 1 ? '' : 's') + ' signed');
    var out = 'Offseason after Season ' + roman(rep.after_season) + ': ' + bits.join(', ') + '.';
    if ((s.biggest | 0) >= 4) out += ' Biggest leap +' + (s.biggest | 0) + '.';
    return out;
  }
  /* the Trophy Room as text: the identity, the seasons, the record, the
     wall — and no claim about anything but a free game */
  function trophyShareText(t) {
    t = obj(t); var f = obj(t.franchise), r = obj(t.record), ach = arr(t.achievements).filter(function (a) { return a && a.earned; });
    var lines = [((f.city || '') + ' ' + (f.name || '')).trim().toUpperCase()];
    lines.push('Founded ' + (f.founded_season || '') + ' · ' + (r.seasons | 0) + ' season' + ((r.seasons | 0) === 1 ? '' : 's') + ' · ' + recordLine(r) + ' all-time');
    var w = ach.length + ' achievement' + (ach.length === 1 ? '' : 's');
    if (t.rival && t.rival.name) w += ' · Rival series ' + recordLine(t.rival);
    if (t.ladder && t.ladder.games) w += ' · Ladder ' + (t.ladder.rating | 0);
    lines.push(w);
    var qb = arr(obj(t.leaders).passing)[0];
    if (qb && qb.yds) lines.push('Career passing: ' + qb.name + ', ' + fmt(qb.yds) + ' yds');
    lines.push('', 'EdgeDesk Games');
    return lines.join('\n');
  }

  /* ── THE DRAFT AND THE MARKET (Phase 5) ─────────────────────────────────
     Mirrors of franchise_market() in the SQL, for display: the client shows
     a price and a range, the server charges, hides and reveals. Pinned to
     the SQL by tools/games/franchise.test.js. */
  var MARKET_VERSION = 'market_v1';
  var MARKET = { scout_sp: 20, picks: 2, class_size: 10, agents: 6, roster_max: 42, roster_min: 38,
                 signing: { floor: 100, per_point: 20, over: 55 } };
  /* a free agent's asking price, as the server sets it */
  function signingCost(overall) {
    return Math.max(MARKET.signing.floor, ((overall | 0) - MARKET.signing.over) * MARKET.signing.per_point);
  }
  /* what a card says under an unscouted prospect: the range, and that the
     rest is for sale */
  function rangeLine(p) {
    p = obj(p); var r = arr(p.range);
    return r.length === 2 ? 'OVR ' + r[0] + '–' + r[1] + ' · potential unknown' : '';
  }
  /* one line for a prospect or a free agent: position, age, archetype,
     then what is known */
  function prospectLine(p) {
    p = obj(p);
    var head = [p.position, p.age != null ? p.age : null, p.archetype].filter(function (x) { return x != null && x !== ''; }).join(' · ');
    if (p.overall == null) return head + (p.range ? ' · ' + rangeLine(p) : '');
    return head + ' · OVR ' + p.overall + (p.potential != null ? ' · potential ' + p.potential : '')
      + (p.dev_tier && DEV_TIERS[p.dev_tier] ? ' · ' + DEV_TIERS[p.dev_tier] : '');
  }
  /* the roster's room, from the board or the home snapshot */
  function rosterRoom(m) {
    m = obj(m); var active = m.active | 0, max = m.max || MARKET.roster_max, min = m.min || MARKET.roster_min;
    return { active: active, max: max, min: min, room: Math.max(0, max - active), full: active >= max, floor: active <= min };
  }

  /* ── CONFERENCES AND PLAYOFFS (Phase 6) ─────────────────────────────────
     A league of friends with standings of its own. Everything here is
     presentation: the shape of the competition, mirrored from
     franchise_conference_config() so a page can say the rules without a
     round trip, and pinned to the SQL by tools/games/franchise.test.js. The
     server draws every schedule, plays every round and decides every seed. */
  var CONFERENCE_VERSION = 'conference_v1';
  var CONFERENCE = { name_max: 32, min_teams: 4, max_teams: 12, start_min: 4, rounds_max: 7,
                     playoff_teams: 4, playoff_small: 2, playoff_large_from: 6, ladder_k: LADDER_K };
  var CONFERENCE_STATUS = {
    forming:  { label: 'Forming',     means: 'Waiting for franchises. The commissioner starts the season.' },
    regular:  { label: 'In season',   means: 'One round a football week, on Saturday.' },
    playoffs: { label: 'Playoffs',    means: 'The bracket is set. Win or go home.' },
    complete: { label: 'Decided',     means: 'The title is on the record. A new season may be started.' }
  };
  var ROUND_NAMES = { regular: 'Round', semifinal: 'Semifinal', final: 'The final' };
  /* how many make the bracket in a conference of n, the server's rule */
  function playoffTeams(n) {
    return (n | 0) >= CONFERENCE.playoff_large_from ? CONFERENCE.playoff_teams : CONFERENCE.playoff_small;
  }
  /* the invite link, the same shape a challenge uses */
  function conferenceUrl(token) {
    var o = (root.location && root.location.origin) || 'https://edgedesksports.com';
    return o + '/games/conference/?join=' + encodeURIComponent(String(token || ''));
  }
  function conferenceInviteText(c, me) {
    var L = [], nm = obj(c).name || 'my conference';
    L.push('Bring your franchise to ' + nm + '.');
    if (me && me.name) L.push('The ' + ((me.city || '') + ' ' + me.name).trim() + (me.overall != null ? ' (OVR ' + me.overall + ')' : '') + ' are already in.');
    L.push('A round a week, everybody plays everybody, and a bracket at the end. No account needed — found a franchise free and join here:');
    return L.join('\n');
  }
  /* what a round is called: "Round 3", "Semifinal", "The final" */
  function roundName(g) {
    g = obj(g);
    return g.kind && g.kind !== 'regular' ? (ROUND_NAMES[g.kind] || 'Playoff') : 'Round ' + (g.round | 0);
  }
  /* one line for a game on the schedule, from a viewer's side when it has
     one: "Round 3 · beat the Comets 24–17" or "Semifinal · Outlaws v Comets" */
  function conferenceGameLine(g, meId) {
    g = obj(g);
    var a = obj(g.a), b = obj(g.b), mine = meId && (a.id === meId || b.id === meId);
    var head = roundName(g);
    if (g.status !== 'final') return head + ' · ' + (a.name || '?') + ' v ' + (b.name || '?');
    if (!mine) return head + ' · ' + (a.name || '?') + ' ' + (g.score_a | 0) + ', ' + (b.name || '?') + ' ' + (g.score_b | 0) + (g.ot ? ' (OT)' : '');
    var meA = a.id === meId, my = meA ? (g.score_a | 0) : (g.score_b | 0), their = meA ? (g.score_b | 0) : (g.score_a | 0);
    var them = (meA ? b : a).name || 'them';
    var verb = my > their ? 'beat' : my < their ? 'lost to' : 'drew with';
    return head + ' · ' + verb + ' the ' + them + ' ' + my + '–' + their + (g.ot ? ' (OT)' : '');
  }
  /* a standings row as one line: "3–1 · +34" */
  function standingLine(row) {
    row = obj(row);
    var d = (row.diff | 0);
    return recordLine(row) + ' · ' + (d > 0 ? '+' : '') + d;
  }
  /* what the page should say is next: a round waiting to be played, a round
     that has not opened, or the state the conference is resting in */
  function conferencePhase(board) {
    board = obj(board);
    var c = obj(board.conference);
    if (!board.conference) return { phase: 'none', label: 'No conference yet' };
    if (c.status === 'forming') return { phase: 'forming', label: 'Forming', needs: board.needs | 0 };
    if (c.status === 'complete') return { phase: 'complete', label: 'Decided', champion: c.champion || null };
    if (board.ready) return { phase: 'ready', label: 'A round is waiting' };
    return { phase: 'waiting', label: 'Next round', opens_at: c.next_opens_at || null };
  }
  /* ── INJURIES, THE BOWL AND TRADES (Phase 7) ────────────────────────────
     Three published tables, mirrored from the SQL for display only. The
     server draws every injury, schedules every bowl and checks every trade;
     nothing here decides any of it. Pinned to the SQL by
     tools/games/franchise.test.js. */
  var INJURY_VERSION = 'injury_v1';
  var INJURY = {
    base: 0.22, per_conditioning: 0.03, iron_man: 0.5, starter_weight: 2.0,
    exposure: { QB: 0.8, RB: 1.6, WR: 1.0, TE: 0.9, OL: 1.2, DL: 1.3, LB: 1.2, CB: 1.0, S: 0.9, K: 0.05, P: 0.05 },
    severity: [
      { key: 'knock',    name: 'Knock',    games: 1, p: 0.45 },
      { key: 'strain',   name: 'Strain',   games: 2, p: 0.30 },
      { key: 'sprain',   name: 'Sprain',   games: 3, p: 0.18 },
      { key: 'fracture', name: 'Fracture', games: 5, p: 0.07 }
    ]
  };
  var BOWL_VERSION = 'bowl_v1';
  var BOWL = { qualify: 'more wins than losses', games: 1, edge_base: 2, edge_per_win: 1, edge_max: 8 };
  var TRADE_VERSION = 'trade_v1';
  var TRADE = { max_per_side: 3, expires_days: 7 };

  /* the chance a game costs a franchise somebody, at a level of Conditioning */
  function injuryChance(conditioning) {
    return Math.max(0, Math.round((INJURY.base - INJURY.per_conditioning * (conditioning | 0)) * 100) / 100);
  }
  /* can this player take the field? The SERVER says so on the row; this is
     the fallback for a row that predates the field. */
  function isAvailable(p) {
    p = obj(p);
    if (p.available != null) return !!p.available;
    if (p.status && p.status !== 'active') return false;
    if (!p.injured_until) return true;
    var t = Date.parse(String(p.injured_until).replace(' ', 'T'));
    return !isFinite(t) || t <= Date.now();
  }
  /* "Sprain · out 3 games" — empty for a fit player */
  function injuryLine(p) {
    p = obj(p);
    if (isAvailable(p)) return '';
    var i = obj(p.injury);
    var g = i.games | 0;
    return (i.name || 'Out') + (g ? ' · out ' + g + ' game' + (g === 1 ? '' : 's') : '');
  }
  /* the bowl rule, the server's, restated for the page that promises it */
  function bowlEarned(wins, losses) { return (wins | 0) > (losses | 0); }
  /* how a season stands against the bowl: earned, or how many wins short */
  function bowlWatch(season) {
    season = obj(season);
    var w = season.wins | 0, l = season.losses | 0, played = w + l + (season.ties | 0);
    var left = Math.max(0, (season.weeks | 0) - played);
    return { earned: bowlEarned(w, l), wins: w, losses: l, left: left,
      /* the wins still needed to finish above .500 if every remaining game
         were won or lost; null once it can no longer be reached */
      need: bowlEarned(w, l) ? 0 : (w + left > l ? (l - w) + 1 : null) };
  }
  /* "two out, one in", from the viewer's side of an offer */
  function tradeSummary(t) {
    t = obj(t);
    var out = arr(t.give).length, ins = arr(t.get).length;
    return out + ' out, ' + ins + ' in';
  }

  /* the title, as text */
  function titleShareText(t, me) {
    t = obj(t);
    var nm = me ? ((me.city || '') + ' ' + (me.name || '')).trim().toUpperCase() : 'MY FRANCHISE';
    var L = [];
    L.push(nm + ' — ' + (t.conference || 'conference') + ' champions, ' + (t.label || ''));
    if (t.runner_up && t.runner_up.name) L.push('Beat the ' + t.runner_up.name + ' in the final.');
    L.push('');
    L.push('EdgeDesk Games');
    return L.join('\n');
  }

  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' ? v : {}; }
  function vals(o) { o = obj(o); var out = [], k; for (k in o) if (o.hasOwnProperty(k)) out.push(o[k]); return out; }
  function uniqueResults(s) {
    var seen = {}, out = [];
    arr(obj(s.price_it).results).forEach(function (r) {
      if (!r || r.game_id == null || seen[String(r.game_id)]) return;
      seen[String(r.game_id)] = true; out.push(r);
    });
    return out;
  }

  /* An estimate, not a promise: the server credits Scouting Points and Team
     Credits only for games it can still verify (kickoff ahead), and XP for
     the rest. `week` is this football week; `all` is the whole envelope. */
  function preview(s, nowMs) {
    s = s || (ST ? ST.read() : {});
    var wk = W ? W.weekKey(nowMs) : null;
    function tally(filter) {
      var t = { xp: 0, sp: 0, tc: 0, games: 0, price_it: 0, cards: 0, drills: 0, research: 0 };
      uniqueResults(s).forEach(function (r) {
        if (!filter(r.week)) return;
        var rw = rewardsFor('price_it', { score: r.score });
        t.xp += rw.xp; t.sp += rw.sp; t.tc += rw.tc; t.games++; t.price_it++;
      });
      vals(obj(s.pick5).cards).forEach(function (c) {
        if (!c || !c.submitted_at || !filter(c.week)) return;
        var rw = rewardsFor('pick5_card');
        t.xp += rw.xp; t.tc += rw.tc; t.games++; t.cards++;
        arr(c.selections).forEach(function (sel) {
          if (sel && sel.result === 'win') { var w = rewardsFor('pick5_correct'); t.xp += w.xp; t.tc += w.tc; }
        });
      });
      vals(obj(obj(s.drill).daily)).forEach(function (d) {
        if (!d || !filter(d.week)) return;
        var rw = rewardsFor('drill_daily', { correct: d.correct });
        t.xp += rw.xp; t.tc += rw.tc; t.games++; t.drills++;
      });
      var n = 0;
      vals(obj(obj(s.research).opens)).forEach(function (o) {
        if (!o || !filter(o.week)) return;
        n++; t.research++;
        if (n <= ECONOMY.research_open.cap_per_week) t.xp += ECONOMY.research_open.xp;
      });
      return t;
    }
    return {
      version: ECONOMY_VERSION,
      week: tally(function (w) { return wk == null || w === wk; }),
      all: tally(function () { return true; })
    };
  }

  /* The payload franchise_import_history() accepts. Small on purpose: only
     the fields the server needs to re-derive a result from its own board. */
  function historyPayload(s) {
    s = s || (ST ? ST.read() : {});
    var price = uniqueResults(s).slice(-200).map(function (r) {
      return { game_id: String(r.game_id), user_spread: r.user_spread, at: r.at || null };
    });
    var cards = vals(obj(s.pick5).cards).filter(function (c) { return c && c.submitted_at; })
      .sort(function (a, b) { return String(b.week).localeCompare(String(a.week)); }).slice(0, 30)
      .map(function (c) {
        return { week: c.week, submitted_at: c.submitted_at,
          selections: arr(c.selections).map(function (sel) {
            return { game_id: String(sel.game_id), pick: sel.pick, market_spread: sel.market_spread == null ? null : sel.market_spread };
          }) };
      });
    var drills = vals(obj(obj(s.drill).daily)).sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); })
      .slice(0, 60).map(function (d) {
        return { day: d.day, rounds: d.rounds | 0, correct: d.correct | 0, total: d.total | 0, seed: d.seed || null };
      });
    var research = vals(obj(obj(s.research).opens)).sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
      .slice(0, 100).map(function (o) { return { game_id: String(o.game_id), at: o.at || null }; });
    return { v: 1, economy: ECONOMY_VERSION, price_it: price, pick5: cards, drill: drills, research: research };
  }

  /* ── the client ──────────────────────────────────────────────────────── */
  var _deployed = null;          /* null = unknown, false = the SQL is not applied */
  function deployed() { return _deployed; }

  /* A TEAM BEFORE AN ACCOUNT. A signed-out player is identified by the same
     device secret the social layer generates for anonymous Head-to-Head
     play (games/lib/social.js secret()); the server keeps only its hash.
     Every call carries it when there is no session, and none when there
     is — an account beats a secret everywhere. */
  function secret() { try { return (S && !signedIn()) ? S.secret() : null; } catch (_) { return null; } }
  function withSecret(args) {
    args = args || {};
    if (!signedIn()) args.p_secret = secret();
    return args;
  }
  /* the cache key: the account, or the device */
  function cacheKey() { var u = user(); return u ? u.id : 'anon'; }

  function rpc(fn, args) {
    if (!S) return Promise.resolve({ ok: false, error: 'not_configured', message: 'The franchise layer is not configured in this build.' });
    return S.rpc(fn, args).then(function (r) {
      if (!r.ok && r.status === 404) { _deployed = false; r.error = 'not_deployed'; r.message = 'The franchise layer has not been deployed yet.'; }
      else if (r.ok) _deployed = true;
      return r;
    });
  }

  function user() { return S ? S.user() : null; }
  function signedIn() { return !!user(); }

  /* the last home read model for THIS account (or this device), from the store */
  function snapshot() { return ST ? ST.franchiseSnapshot(cacheKey()) : null; }
  function hasFranchise() { return !!snapshot(); }
  /* 'account' once claimed, 'device' while it lives on the secret, null if none */
  function owner() { var s = snapshot(); return s && s.franchise ? (s.franchise.owner || 'account') : null; }

  /* Where the player stands, for a page deciding what to render:
       'franchise'     they own one (on the account, or on this device)
       'no_franchise'  they do not — founding needs no account
       'not_deployed'  the SQL is not applied to this project */
  function state() {
    if (_deployed === false) return 'not_deployed';
    return hasFranchise() ? 'franchise' : 'no_franchise';
  }

  function remember(home) {
    if (ST) ST.setFranchiseSnapshot(home || null, cacheKey());
    return home;
  }

  /* HOME. Fetches, caches, and resolves to { ok, data, cached }. When the
     network fails and a snapshot exists, the snapshot is returned marked
     `cached` — a stale HQ beats a blank one, as long as it says so. */
  function home() {
    if (!signedIn() && !secret()) return Promise.resolve({ ok: false, error: 'no_identity', data: null });
    return rpc('franchise_home', withSecret({})).then(function (r) {
      if (r.ok) {
        /* the store holds ONE snapshot. An account that owns nothing must
           not erase the device's snapshot sitting there — that is exactly
           what boot() is about to claim. Only a stale copy under the SAME
           key is cleared. */
        if (r.data) remember(r.data); else if (ST && ST.franchiseSnapshot(cacheKey())) ST.setFranchiseSnapshot(null, cacheKey());
        return { ok: true, data: r.data || null, cached: false };
      }
      var snap = snapshot();
      if (snap && r.error !== 'not_deployed') return { ok: true, data: snap, cached: true, fetched_at: ST ? ST.franchiseFetchedAt() : null, error: r.error };
      return { ok: false, error: r.error, message: r.message, data: null };
    });
  }
  function roster() { return rpc('franchise_roster', withSecret({})); }
  function ledger(limit) { return rpc('franchise_ledger_recent', withSecret({ p_limit: limit || 50 })); }
  function pick5Mine(week) { return rpc('franchise_pick5_mine', withSecret({ p_week_key: week || null })); }

  function create(f) {
    f = f || {};
    if (!signedIn() && !secret()) return Promise.resolve({ ok: false, error: 'no_identity',
      message: 'This browser cannot keep a device secret, so a franchise here needs an account.' });
    return rpc('franchise_create', withSecret({
      p_name: f.name, p_city: f.city, p_abbr: String(f.abbr || '').toUpperCase(),
      p_logo: f.logo, p_theme: f.theme, p_offense: f.offense, p_defense: f.defense
    })).then(function (r) { if (r.ok && r.data) remember(r.data); return r; });
  }
  function importHistory(payload) {
    return rpc('franchise_import_history', withSecret({ p_history: payload || historyPayload() }));
  }
  function setStarter(playerId, slot) { return rpc('franchise_set_starter', withSecret({ p_player: playerId, p_slot: slot | 0 })); }

  /* THE WEEKLY GAME. Playing is an action, not a record: it is never
     queued, because a player must see the result the moment it exists.
     The server refuses a game that has not opened and plays each exactly
     once; the snapshot is refreshed from the server afterwards. */
  function startSeason() {
    return rpc('franchise_start_season', withSecret({})).then(function (r) {
      if (r.ok && r.data && r.data.home) remember(r.data.home);
      return r;
    });
  }
  function playWeek() {
    return rpc('franchise_play_week', withSecret({})).then(function (r) {
      if (r.ok && r.data && r.data.totals) touchTotals(r.data.totals);
      return r;
    });
  }
  function schedule(number) { return rpc('franchise_schedule', withSecret({ p_number: number == null ? null : (number | 0) })); }
  function game(id) { return rpc('franchise_game', withSecret({ p_game: String(id) })); }

  /* FRANCHISE VS FRANCHISE. The link is the key: peeking works with or
     without a franchise (the landing must work before one exists);
     accepting plays the game on the server at once and is never queued. */
  function challengeCreate(note) { return rpc('franchise_challenge_create', withSecret({ p_note: note || null })); }
  function challengePeek(token) { return rpc('franchise_challenge_peek', withSecret({ p_token: String(token || '') })); }
  function challengeAccept(token) {
    return rpc('franchise_challenge_accept', withSecret({ p_token: String(token || '') })).then(function (r) {
      if (r.ok && r.data && r.data.totals) touchTotals(r.data.totals);
      return r;
    });
  }
  function challengeCancel(id) { return rpc('franchise_challenge_cancel', withSecret({ p_id: String(id) })); }
  function challengesMine(limit) { return rpc('franchise_challenges_mine', withSecret({ p_limit: limit || 20 })); }
  function ladder(limit) { return rpc('franchise_ladder', withSecret({ p_limit: limit || 25 })); }
  function h2hContext(token) { return rpc('franchise_h2h_context', { p_token: String(token || '') }); }

  /* THE FACILITIES AND THE TROPHY ROOM (Phase 4). An upgrade is asked for
     by name and nothing else; the server reads the level, the price and
     what is on hand, and writes the one debit. Never queued — a player
     spending must see the answer. The snapshot is kept current from the
     answer so the HQ and the office agree without another read. */
  function upgrade(facility) {
    return rpc('franchise_upgrade', withSecret({ p_facility: String(facility || '') })).then(function (r) {
      if (r.ok && r.data) {
        var snap = snapshot();
        if (snap) {
          if (r.data.totals) snap.resources = r.data.totals;
          if (r.data.facilities) snap.facilities = r.data.facilities;
          remember(snap);
        }
      }
      return r;
    });
  }
  function trophies() { return rpc('franchise_trophies', withSecret({})); }

  /* THE CONFERENCE (Phase 6). The board is one read. Creating, joining,
     leaving, starting a season and advancing one each send a name or a
     token and the identity and nothing else: the server draws the
     schedule, plays the round, seeds the bracket and crowns the champion.
     None of these is ever queued — a player who presses "play the round"
     must see what happened. */
  function conference() { return rpc('franchise_conference_board', withSecret({})); }
  function conferenceCreate(name) {
    return rpc('franchise_conference_create', withSecret({ p_name: String(name || '') }));
  }
  function conferencePeek(token) { return rpc('franchise_conference_peek', withSecret({ p_token: String(token || '') })); }
  function conferenceJoin(token) { return rpc('franchise_conference_join', withSecret({ p_token: String(token || '') })); }
  function conferenceLeave() { return rpc('franchise_conference_leave', withSecret({})); }
  function conferenceStart() { return rpc('franchise_conference_start', withSecret({})); }
  function conferenceAdvance() {
    return rpc('franchise_conference_advance', withSecret({})).then(function (r) {
      if (r.ok && r.data && r.data.totals) touchTotals(r.data.totals);
      return r;
    });
  }
  function conferenceGame(id) { return rpc('franchise_conference_game', withSecret({ p_game: String(id) })); }

  /* TRADES (Phase 7). The board is one read; an offer, an answer and a
     withdrawal each send ids and the identity and nothing else — the server
     decides whether the deal is legal, moves the players and writes the
     record. Never queued: a deal must see its answer. */
  function tradePartners() { return rpc('franchise_trade_partners', withSecret({})); }
  function tradesMine(limit) { return rpc('franchise_trades_mine', withSecret({ p_limit: limit || 20 })); }
  function tradeOffer(other, give, get, note) {
    return rpc('franchise_trade_offer', withSecret({
      p_other: String(other || ''), p_give: (give || []).map(String), p_get: (get || []).map(String),
      p_note: note || null }));
  }
  function tradeRespond(id, accept) {
    return rpc('franchise_trade_respond', withSecret({ p_trade: String(id || ''), p_accept: !!accept }));
  }
  function tradeWithdraw(id) { return rpc('franchise_trade_withdraw', withSecret({ p_trade: String(id || '') })); }

  /* THE DRAFT AND THE MARKET (Phase 5). The board is one read; a report, a
     pick, a signing and a release each send a player id and the identity
     and nothing else — the server prices, hides, reveals, counts the picks
     and holds the roster's ceiling and floor. Never queued: spending and
     an irreversible cut must see their answer. The snapshot's resources
     follow the answer. */
  function market() { return rpc('franchise_market_board', withSecret({})); }
  function moveThen(r) {
    if (r.ok && r.data && r.data.totals) touchTotals(r.data.totals);
    return r;
  }
  function scout(playerId) { return rpc('franchise_scout', withSecret({ p_player: String(playerId || '') })).then(moveThen); }
  function draft(playerId) { return rpc('franchise_draft', withSecret({ p_player: String(playerId || '') })).then(moveThen); }
  function sign(playerId) { return rpc('franchise_sign', withSecret({ p_player: String(playerId || '') })).then(moveThen); }
  function release(playerId) { return rpc('franchise_release', withSecret({ p_player: String(playerId || '') })); }

  /* CLAIM the device's franchise into the account just signed in. Proof is
     the secret; the server refuses if the account already owns one, and
     says so. The cache moves with it. */
  function claim() {
    var sec = null; try { sec = S ? S.secret() : null; } catch (_) {}
    if (!signedIn() || !sec) return Promise.resolve({ ok: false, error: 'no_identity' });
    return rpc('franchise_claim', { p_secret: sec }).then(function (r) {
      if (r.ok && r.data) {
        if (ST) ST.setFranchiseSnapshot(null, 'anon');
        if (r.data.home) remember(r.data.home);
        return { ok: true, claimed: !!r.data.claimed, reason: r.data.reason || null, data: r.data.home || null };
      }
      return r;
    });
  }

  /* A REWARD CALL. Signed in with a franchise: ask the server; if it cannot
     be reached, queue the call and replay it on the next boot. Anonymous or
     no franchise: nothing to do, and the page says so. Resolves to the RPC
     result, or { ok:false, queued:true }. Every call is idempotent on the
     server, so a replay after a partial failure cannot double-credit. */
  function record(fn, args, key) {
    if (!hasFranchise()) return Promise.resolve({ ok: false, error: 'no_franchise', skipped: true });
    return rpc(fn, withSecret(args)).then(function (r) {
      if (r.ok) {
        if (ST) ST.dequeueFranchise(key);
        if (r.data && r.data.totals) touchTotals(r.data.totals);
        return r;
      }
      if (r.error === 'unreachable' || r.error === 'timeout' || (r.status && r.status >= 500)) {
        if (ST) ST.queueFranchise({ key: key, fn: fn, args: args });
        return { ok: false, queued: true, error: r.error, message: r.message };
      }
      return r;
    });
  }
  /* keep the cached snapshot's resources current between home() calls */
  function touchTotals(totals) {
    var snap = snapshot();
    if (!snap || !totals) return;
    snap.resources = totals;
    remember(snap);
  }

  function recordPriceIt(gameId, userSpread) {
    return record('franchise_record_price_it', { p_game_id: String(gameId), p_user_spread: userSpread }, 'price_it:' + gameId);
  }
  function submitPick5(weekKey, selections) {
    return record('franchise_submit_pick5', { p_week_key: weekKey, p_selections: (selections || []).map(function (s) {
      return { game_id: String(s.game_id), pick: s.pick };
    }) }, 'pick5:' + weekKey);
  }
  function recordDrill(rec) {
    rec = rec || {};
    return record('franchise_record_drill', { p_day_key: rec.day, p_rounds: rec.rounds | 0, p_correct: rec.correct | 0,
      p_total: rec.total | 0, p_seed: rec.seed || null }, 'drill:' + rec.day);
  }
  function recordResearch(gameId) {
    return record('franchise_record_research', { p_game_id: String(gameId) }, 'research:' + gameId);
  }

  /* Replay whatever the server has not confirmed. Sequential, so a burst of
     replays cannot race each other; each one dequeues itself on success. */
  function sync() {
    if (!hasFranchise() || !ST) return Promise.resolve({ replayed: 0 });
    var q = ST.franchiseQueue(), i = 0, done = 0;
    function step() {
      if (i >= q.length) return Promise.resolve({ replayed: done });
      var item = q[i++];
      return record(item.fn, item.args, item.key).then(function (r) {
        if (r.ok) done++;
        return step();
      });
    }
    return step();
  }

  /* On every page boot, after the endpoint is configured: refresh the
     snapshot (the account's, or the device's), claim a device franchise
     into an account that has just signed in and owns none, then replay the
     queue. A browser with neither a session nor a secret has nothing to ask. */
  function boot() {
    if (!signedIn() && !secret()) {
      if (ST) { try { ST.clearFranchise(); } catch (_) {} }
      return Promise.resolve({ state: 'no_franchise' });
    }
    return home().then(function (r) {
      var next = Promise.resolve(r);
      if (signedIn() && r.ok && !r.data) {
        var sec = null; try { sec = S ? S.secret() : null; } catch (_) {}
        if (sec && ST && ST.franchiseSnapshot('anon')) {
          next = claim().then(function (c) { return (c.ok && c.claimed) ? home() : r; });
        }
      }
      return next.then(function (h) {
        return sync().then(function (s) { return { state: state(), home: h, synced: s.replayed, claimed: h !== r }; });
      });
    });
  }

  /* After sign-out: the session is gone, so is the cache; the next boot
     asks again with the device secret. */
  function forget() { if (ST) ST.clearFranchise(); }

  var API = {
    ECONOMY_VERSION: ECONOMY_VERSION, ECONOMY: ECONOMY, CURRENCIES: CURRENCIES, MAX_LEVEL: MAX_LEVEL,
    LOGOS: LOGOS, THEMES: THEMES, OFFENSES: OFFENSES, DEFENSES: DEFENSES, optionOf: optionOf,
    POSITIONS: POSITIONS, POSITION_NAMES: POSITION_NAMES, STARTERS: STARTERS, SIDE: SIDE,
    ATTR_ORDER: ATTR_ORDER, ATTRS: ATTRS, ATTR_NAMES: ATTR_NAMES, RARITY: RARITY, DEV_TIERS: DEV_TIERS,
    ACHIEVEMENTS: ACHIEVEMENTS, achievementName: achievementName,
    RATING_WEIGHTS: RATING_WEIGHTS, PREP_VERSION: PREP_VERSION,
    SIM_VERSION: SIM_VERSION, HOME_EDGE: HOME_EDGE, PREP_SWING: PREP_SWING, SCHEME_EDGES: SCHEME_EDGES,
    schemeEdge: schemeEdge, prepAdj: prepAdj, statsLine: statsLine, seasonLine: seasonLine,
    opponentTitle: opponentTitle, matchupLine: matchupLine, resultLine: resultLine, opensIn: opensIn,
    gamePhase: gamePhase, matchupEdges: matchupEdges, gameShareText: gameShareText,
    startSeason: startSeason, playWeek: playWeek, schedule: schedule, game: game,
    LADDER_START: LADDER_START, LADDER_K: LADDER_K, recordLine: recordLine, challengeUrl: challengeUrl,
    challengeInviteText: challengeInviteText, challengeShareText: challengeShareText,
    challengeCreate: challengeCreate, challengePeek: challengePeek, challengeAccept: challengeAccept, challengeCancel: challengeCancel,
    challengesMine: challengesMine, ladder: ladder, h2hContext: h2hContext,
    FACILITIES_VERSION: FACILITIES_VERSION, FACILITIES: FACILITIES, FACILITY_ORDER: FACILITY_ORDER,
    facilityState: facilityState, facilityStates: facilityStates, facilityLine: facilityLine,
    OFFSEASON_VERSION: OFFSEASON_VERSION, RETIRE_AGE: RETIRE_AGE, FADE_AGE: FADE_AGE, FADE_OVERALL: FADE_OVERALL,
    roman: roman, offseasonLine: offseasonLine, trophyShareText: trophyShareText, upgrade: upgrade, trophies: trophies,
    MARKET_VERSION: MARKET_VERSION, MARKET: MARKET, signingCost: signingCost, rangeLine: rangeLine, prospectLine: prospectLine,
    rosterRoom: rosterRoom, market: market, scout: scout, draft: draft, sign: sign, release: release,
    CONFERENCE_VERSION: CONFERENCE_VERSION, CONFERENCE: CONFERENCE, CONFERENCE_STATUS: CONFERENCE_STATUS,
    ROUND_NAMES: ROUND_NAMES, playoffTeams: playoffTeams, conferenceUrl: conferenceUrl,
    conferenceInviteText: conferenceInviteText, roundName: roundName, conferenceGameLine: conferenceGameLine,
    standingLine: standingLine, conferencePhase: conferencePhase, titleShareText: titleShareText,
    INJURY_VERSION: INJURY_VERSION, INJURY: INJURY, injuryChance: injuryChance,
    isAvailable: isAvailable, injuryLine: injuryLine,
    BOWL_VERSION: BOWL_VERSION, BOWL: BOWL, bowlEarned: bowlEarned, bowlWatch: bowlWatch,
    TRADE_VERSION: TRADE_VERSION, TRADE: TRADE, tradeSummary: tradeSummary,
    tradePartners: tradePartners, tradesMine: tradesMine, tradeOffer: tradeOffer,
    tradeRespond: tradeRespond, tradeWithdraw: tradeWithdraw,
    conference: conference, conferenceCreate: conferenceCreate, conferencePeek: conferencePeek,
    conferenceJoin: conferenceJoin, conferenceLeave: conferenceLeave, conferenceStart: conferenceStart,
    conferenceAdvance: conferenceAdvance, conferenceGame: conferenceGame,
    spForScore: spForScore, tcForScore: tcForScore, tcForDrill: tcForDrill, rewardsFor: rewardsFor,
    xpForLevel: xpForLevel, levelFor: levelFor, levelInfo: levelInfo,
    fullName: fullName, keyRatings: keyRatings, isStarter: isStarter, traitOf: traitOf,
    careerLine: careerLine, acquiredLine: acquiredLine, playerCard: playerCard, groups: groups,
    weakest: weakest, strongest: strongest, logoSvg: logoSvg, themeVars: themeVars, identity: identity,
    prep: prep, preview: preview, historyPayload: historyPayload, esc: esc, fmt: fmt,
    deployed: deployed, user: user, signedIn: signedIn, secret: secret, snapshot: snapshot, hasFranchise: hasFranchise,
    owner: owner, state: state, claim: claim,
    home: home, roster: roster, ledger: ledger, pick5Mine: pick5Mine, create: create, importHistory: importHistory,
    setStarter: setStarter, record: record, recordPriceIt: recordPriceIt, submitPick5: submitPick5,
    recordDrill: recordDrill, recordResearch: recordResearch, sync: sync, boot: boot, forget: forget
  };
  root.EDFranchise = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
