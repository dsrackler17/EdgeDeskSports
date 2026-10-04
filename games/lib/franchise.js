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
  /* the derived player profile (profile_v1) — the same pure function the SQL
     restates, so a card can show more than its four stored ratings */
  var PR = root.EDProfile || (typeof require === 'function' ? require('./gridiron/profile.js') : null);

  /* ── THE SCHEMA THIS BUILD EXPECTS ──────────────────────────────────────
     supabase/games_social.sql and supabase/games_franchise.sql are pasted
     and re-run rather than migrated, and for eight phases nothing could say
     WHICH of them a database had: a project three phases behind looked
     exactly like a current one until a page called a function that was not
     there. Every phase now records itself in games_schema_log, and this is
     what the repository expects to find. games_schema() reports what is
     actually installed; the status page compares the two and names the gap.

     Pinned to the SQL by tools/games/franchise.test.js — a new phase that
     forgets to record itself, or a number that drifts, goes red.

     The names are the SAME STRINGS the files pass to games_schema_note(),
     in order, so a database that is behind can be told what it is missing
     BY NAME rather than by a number nobody can decode. The count is the
     length of the list, so adding a phase is one line here. */
  var SCHEMA_PHASES = {
    social: [
      'Head-to-Head, Groups, ratings and the activity feed'
    ],
    franchise: [
      'the franchise, the roster, the ledger and the achievements',
      'the weekly game: the schedule, the simulator and the season',
      'franchise vs franchise: challenges, rivalries and the ladder',
      'the offseason, the facilities and the Trophy Room',
      'the draft and the market',
      'conferences and playoffs',
      'injuries, the bowl and trades',
      'the coaching staff',
      'the scouting department',
      'the development program and the league',
      'the rank and the packs',
      'the long haul: careers and a building you can staff',
      'the drives you call',
      'key moments',
      'both sides of the ball',
      'the playbook',
      'the player universe: profiles, tiers, bodies and home towns',
      'the Vault: packs you hold, odds you can read, and a card that remembers',
      'the lineup, chemistry, and the Exchange',
      'the pull record: every pack you opened and the best of them',
      'the game you hold counts: live results, careers, and the Game Day pack',
      'the card is not the man: identity, edition, instance, ownership',
      'the living season: rankings, award races, the title game',
      'one door, once: operation keys and the answer to did it happen',
      'what a carry was: yards before and after contact, breaks and stuffs'
    ]
  };
  var SCHEMA = { social: SCHEMA_PHASES.social.length, franchise: SCHEMA_PHASES.franchise.length };
  /* 'franchise' -> 'supabase/games_franchise.sql' — what to paste to fix a gap */
  var SCHEMA_FILES = { social: 'supabase/games_social.sql', franchise: 'supabase/games_franchise.sql' };

  /* ── the economy, economy_v2 — the same table franchise_economy() returns ── */
  var ECONOMY_VERSION = 'economy_v2';
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
    import_unverified_pick5:    { xp: 75 },
    /* THE GAME YOU HOLD (Phase 21): a live game finished, won, and what the
       performance was worth — capped a day, scaled by the tier */
    live_game:     { xp: 60, tc: 25 },
    live_win:      { xp: 40, tc: 25, cp: 1 },
    live_perf:     { tc_per_td: 3, tc_per_100: 4, tc_max: 30, xp_per_100: 5, xp_max: 40 },
    live_cap:      { per_day: 5 },
    live_tier:     { rookie: 0.6, pro: 1, allpro: 1.15, legend: 1.3 }
  };
  /* what one live game pays, before the daily cap, exactly as the server
     rounds it (half up on a positive number) */
  function liveRewards(g) {
    g = g || {};
    var won = (g.score_for | 0) > (g.score_against | 0), tier = ECONOMY.live_tier[g.difficulty] || 1;
    var xp = ECONOMY.live_game.xp, tc = ECONOMY.live_game.tc, cp = 0;
    if (won) { xp += ECONOMY.live_win.xp; tc += ECONOMY.live_win.tc; cp = ECONOMY.live_win.cp; }
    var hundreds = Math.floor(Math.max(0, g.yards | 0) / 100);
    tc += Math.min(ECONOMY.live_perf.tc_max, (g.touchdowns | 0) * ECONOMY.live_perf.tc_per_td + hundreds * ECONOMY.live_perf.tc_per_100);
    xp += Math.min(ECONOMY.live_perf.xp_max, hundreds * ECONOMY.live_perf.xp_per_100);
    return { xp: Math.round(xp * tier), tc: Math.round(tc * tier), cp: cp, tier: tier, won: won };
  }
  /* ONE MAN'S LINE FROM A LIVE GAME, in the keys his career already uses
     (statsLine reads them), so a game played with thumbs and a game the
     server simulated add up in the same columns. Nothing negative; a man
     with no line and no snap has no entry. */
  function liveLine(pos, m) {
    m = m || {};
    var o = {};
    function put(k, v) { v = Math.max(0, v | 0); if (v > 0) o[k] = v; }
    /* ── WHAT A CARRY WAS, not only how far it went (rush_v1) ───────────
       Yards before contact, yards after it, tackles broken, carries the
       front stopped and carries that went twenty. Whole numbers only,
       because a career sheet sums them across a hundred games and the
       server will not take a fraction. A back who gains four a carry with
       three of them after contact is a different card from one who gains
       four untouched, and until now nothing in the game could say so. */
    function carried(m) {
      put('ybc', Math.round(m.ybc || 0)); put('yac', Math.round(m.yac || 0));
      put('brk', m.brk); put('stuffed', m.stuffed); put('expl', m.expl);
    }
    switch (pos) {
      case 'QB': put('att', m.pa); put('cmp', m.pc); put('yds', m.py); put('td', m.ptd); put('int', m.pint);
                 put('car', m.car); put('rush_yds', m.ry); put('rush_td', m.rtd); carried(m); break;
      case 'RB': put('car', m.car); put('yds', m.ry); put('td', m.rtd); put('rec', m.rec); put('rec_yds', m.recy); put('rec_td', m.rectd); carried(m); break;
      case 'WR': case 'TE': put('rec', m.rec); put('yds', m.recy); put('td', m.rectd); put('car', m.car); put('rush_yds', m.ry); carried(m); break;
      case 'K': put('fg', m.fg); put('fga', m.fga); put('xp', m.xp); break;
      case 'P': case 'OL': break;
      default: put('tkl', m.tkl); put('sacks', m.sack); put('int', m.int); put('tfl', m.tfl); put('pd', m.pd);
               put('stuff', m.stuff); break;
    }
    if (!Object.keys(o).length && !m.played) return null;
    o.games = 1;
    return o;
  }
  var CURRENCIES = {
    xp: { key: 'xp', label: 'Research XP', short: 'XP', field: 'xp',
      means: 'Experience, earned by playing and by reading the real games. Levels follow the published curve.' },
    sp: { key: 'sp', label: 'Scouting Points', short: 'SP', field: 'scouting_points',
      means: 'Earned by Price It accuracy. Spent on scouting reports and prospects.' },
    tc: { key: 'tc', label: 'Credits', short: 'TC', field: 'team_credits',
      means: 'Earned by playing. Spent on signings, upgrades and the Exchange. Never bought.' },
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
    { key: 'forest',  label: 'Forest',  primary: '#7cc142', secondary: '#123326', ink: '#06231a' },
    { key: 'navy',    label: 'Navy',    primary: '#2fa79a', secondary: '#12203a', ink: '#061a3a' },
    { key: 'crimson', label: 'Crimson', primary: '#e2664b', secondary: '#3a1611', ink: '#2a0c08' },
    { key: 'gold',    label: 'Gold',    primary: '#d9a441', secondary: '#3a2a0e', ink: '#2a1c06' },
    { key: 'slate',   label: 'Slate',   primary: '#a9b6c9', secondary: '#252b36', ink: '#12161d' },
    { key: 'violet',  label: 'Violet',  primary: '#d274b0', secondary: '#261c40', ink: '#170f2a' },
    { key: 'teal',    label: 'Teal',    primary: '#3fc1b8', secondary: '#0f2f2d', ink: '#06211f' },
    { key: 'orange',  label: 'Orange',  primary: '#f28c38', secondary: '#3a230e', ink: '#2a1706' },
    { key: 'maroon',  label: 'Maroon',  primary: '#b8405a', secondary: '#33121a', ink: '#240b11' },
    { key: 'black',   label: 'Black',   primary: '#f1ebdf', secondary: '#221c15', ink: '#100e0a' }
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
    next_man_up:    { name: 'Next Man Up' },
    staff_first:    { name: 'A Staff' },
    staff_full:     { name: 'Full Building' },
    staff_100:      { name: 'Coordinator' },
    staff_250:      { name: 'Veteran Staff' },
    staff_1000:     { name: 'Hall of Fame' }
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

  /* ── the weekly game, sim_v4 — the published shape of the simulator ────
     The simulator runs on the server and nowhere else. These are the
     numbers it publishes so a pregame can say what is in play: home field,
     how much this week's preparation swings, and the scheme matchup table
     (offense against defense, in rating points for the offense). The
     table is pinned to franchise_scheme_edges() by the test suite. */
  var SIM_VERSION = 'sim_v4';
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
  /* THE GAMES IN YOUR HANDS: what he has done in the live games you played
     him in, kept apart from the season's simulated line */
  function handsLine(p) {
    var c = (p && p.live_stats) || {};
    if (!c.games) return '';
    return statsLine(p && p.position, c, { games: true });
  }
  /* MILESTONE BADGES. Marks a career earns and keeps — never a change to the
     rarity or the tier, which are what he was rolled at. Counted over the
     simulated career and the games in your hands together, because both are
     his. Pure: a card in, a list out. */
  var BADGES = [
    { key: 'games_100', label: '100 games', test: function (t) { return t.games >= 100; } },
    { key: 'yards_1000', label: '1,000 yards', test: function (t, pos) { return SKILL[pos] && t.yards >= 1000 && t.yards < 5000; } },
    { key: 'yards_5000', label: '5,000 yards', test: function (t, pos) { return SKILL[pos] && t.yards >= 5000; } },
    { key: 'td_100', label: '100 touchdowns', test: function (t, pos) { return SKILL[pos] && t.td >= 100; } },
    { key: 'tkl_250', label: '250 tackles', test: function (t, pos) { return DEF[pos] && t.tkl >= 250; } },
    { key: 'sacks_25', label: '25 sacks', test: function (t, pos) { return DEF[pos] && t.sacks >= 25; } },
    { key: 'int_10', label: '10 interceptions', test: function (t, pos) { return DEF[pos] && t.int >= 10; } },
    { key: 'fg_50', label: '50 field goals', test: function (t, pos) { return pos === 'K' && t.fg >= 50; } }
  ];
  var SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 }, DEF = { DL: 1, LB: 1, CB: 1, S: 1 };
  function careerTotals(p) {
    var a = (p && p.career_stats) || {}, b = (p && p.live_stats) || {};
    function n(k) { return (+a[k] || 0) + (+b[k] || 0); }
    return { games: n('games'), yards: n('yds') + n('rush_yds') + n('rec_yds'), td: n('td') + n('rush_td') + n('rec_td'),
             tkl: n('tkl'), sacks: n('sacks'), int: n('int'), fg: n('fg') };
  }
  function badges(p) {
    if (!p) return [];
    var t = careerTotals(p), out = [];
    BADGES.forEach(function (b) { if (b.test(t, p.position)) out.push({ key: b.key, label: b.label }); });
    /* honours the server derives: a bowl won while he was on the roster */
    (p.honours || []).forEach(function (h) {
      if (h && h.kind === 'champion') out.push({ key: 'champion_' + h.season, label: 'Championship roster', detail: h.label || ('Season ' + h.season) });
    });
    return out;
  }
  /* WHY A RATING MOVED, said from what the line knows: his age at the time
     and which way it went */
  function evolutionReason(h) {
    if (!h || h.kind !== 'ratings') return '';
    var up = (h.after | 0) > (h.before | 0), age = h.age | 0;
    if (up) return age && age <= 24 ? 'growth: a young man developing' : age && age >= 30 ? 'a late bloom' : 'form: the work is showing';
    return age && age >= 31 ? 'age: the legs go first' : age && age <= 24 ? 'a setback in his development' : 'form: a rough stretch';
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
  /* ── the profile, on the client ──────────────────────────────────────────
     The server sends `profile`, `tier`, `potential_tier`, `body` and
     `hometown` on every card it returns; a card that arrived without them (an
     older snapshot, a generated opponent) gets the same answers from the same
     pure function here. */
  function profileOf(p) {
    if (!p) return null;
    if (p.profile && p.profile.spd != null) return p.profile;
    return PR ? PR.profile(p) : null;
  }
  function tierOf(p) {
    if (!p) return null;
    if (p.tier && PR) { var i; for (i = 0; i < PR.TIERS.length; i++) if (PR.TIERS[i].key === p.tier) return PR.TIERS[i]; }
    return PR ? PR.tierOf(p.overall) : null;
  }
  function potentialTierOf(p) { return (p && p.potential_tier) || (PR ? PR.potentialOf(p) : 'normal'); }
  function potentialWord(p) { var k = potentialTierOf(p); return (PR && PR.POTENTIAL_NAMES[k]) || k; }
  function hometownOf(p) { return (p && p.hometown) || (PR && p ? PR.hometown(p) : ''); }
  function bodyOf(p) { return (p && p.body) || (PR && p ? PR.body(p) : null); }
  /* the universal six, labelled, for a card's second row */
  function universalRatings(p) {
    var pf = profileOf(p);
    if (!pf || !PR) return [];
    return PR.UNIVERSAL.map(function (k) { return { key: k, label: PR.LABELS[k], name: PR.NAMES[k], value: pf[k] }; });
  }
  /* the position's own words, labelled */
  function specificRatings(p) {
    var pf = profileOf(p);
    if (!pf || !PR) return [];
    return (PR.SPECIFIC[p.position] || []).map(function (k) { return { key: k, label: PR.LABELS[k], name: PR.NAMES[k], value: pf[k] }; });
  }

  /* ── WHAT THE CARD DOES IN THE RUN GAME (rush_v1) ────────────────────
     Two halves, and they answer different questions.

     WHAT HE IS: break tackle and vision are not printed on the card — they
     are derived from the ratings that are (BTK from power and elusiveness,
     VIS from elusiveness and hands) and they are precisely the two numbers
     the live engine reads when a defender arrives in the backfield. A pack
     that hands you a 95 ELU back has handed you a man who gets out of
     contact he had no business getting out of, and until now nothing on the
     card said so.

     WHAT HE HAS DONE: yards after contact a carry, the share of his carries
     the front stopped, and the share that went twenty — earned in the games
     you played him in, never in the simulated season, and shown only once
     there are enough carries for the rate to mean anything. */
  var RUN_MIN_CAR = 12;
  function runProfile(p) {
    if (!p || !CARRIES[p.position]) return null;
    var pf = profileOf(p), c = (p && p.live_stats) || {};
    var car = +c.car || 0;
    var traits = [], rates = [];
    if (pf && PR) {
      ['btk', 'vis'].forEach(function (k) {
        if (pf[k] == null) return;
        traits.push({ key: k, label: PR.LABELS[k], name: PR.NAMES[k], value: pf[k] | 0, word: gradeWord(pf[k]) });
      });
    }
    if (car >= RUN_MIN_CAR) {
      rates.push({ key: 'yac', label: 'YAC', name: 'Yards after contact, a carry',
        value: Math.round(10 * (+c.yac || 0) / car) / 10, unit: '' });
      rates.push({ key: 'expl', label: 'EXPL', name: 'Carries of twenty yards or more',
        value: Math.round(1000 * (+c.expl || 0) / car) / 10, unit: '%' });
      rates.push({ key: 'stuffed', label: 'STUFF', name: 'Carries the front stopped at or behind the line',
        value: Math.round(1000 * (+c.stuffed || 0) / car) / 10, unit: '%' });
      if (+c.brk) rates.push({ key: 'brk', label: 'BRK', name: 'Tackles broken, a carry',
        value: Math.round(100 * (+c.brk || 0) / car) / 100, unit: '' });
    }
    if (!traits.length && !rates.length) return null;
    return { traits: traits, rates: rates, carries: car, enough: car >= RUN_MIN_CAR, min: RUN_MIN_CAR };
  }
  var CARRIES = { RB: true, QB: true, WR: true, TE: true };
  function gradeWord(v) {
    v = v | 0;
    return v >= 92 ? 'Elite' : v >= 84 ? 'Strong' : v >= 74 ? 'Solid' : v >= 62 ? 'Fair' : 'Poor';
  }

  function playerCard(p, o) {
    o = o || {};
    if (!p) return '';
    var rar = RARITY[p.rarity] || RARITY.common, tr = traitOf(p), starter = isStarter(p);
    /* a man on the table is not "out": he is not on the roster yet, which is
       a different thing from being hurt */
    var hurt = p.status === 'pack' ? false : !isAvailable(p), hurtLine = hurt ? injuryLine(p) : '';
    var tier = tierOf(p), home = hometownOf(p), body = bodyOf(p);
    var attrs = keyRatings(p).map(function (a) {
      return '<div class="pc-a"><span class="k">' + esc(a.label) + '</span><b>' + (a.value == null ? '—' : a.value) + '</b></div>';
    }).join('');
    var uni = universalRatings(p).map(function (a) {
      return '<span class="pc-u" title="' + esc(a.name) + '"><i>' + esc(a.label) + '</i><b>' + esc(a.value) + '</b></span>';
    }).join('');
    return '<article class="pc pc-' + esc(rar.key) + (tier ? ' pc-tier-' + esc(tier.key) : '') + (starter ? ' pc-start' : '') + (hurt ? ' pc-hurt' : '') + (o.compact ? ' pc-compact' : '')
      + '" data-player="' + esc(p.id) + '" data-position="' + esc(p.position) + '" data-depth="' + (p.depth | 0) + '">'
      + '<div class="pc-top"><span class="pc-num mono">#' + (p.jersey == null ? '—' : p.jersey) + '</span>'
      + '<span class="pc-pos">' + esc(p.position) + '</span>'
      + (tier ? '<span class="pc-tier">' + esc(tier.name) + '</span>' : '')
      + '<span class="pc-rar">' + esc(rar.label) + '</span>'
      + (starter ? '<span class="pc-st">' + (STARTERS[p.position] > 1 ? esc(p.position) + (p.depth | 0) : 'Starter') + '</span>' : '')
      + (hurt ? '<span class="pc-out">Out</span>' : '')
      + '</div>'
      + '<div class="pc-name">' + esc(fullName(p)) + '</div>'
      + '<div class="pc-arch">' + esc(p.position) + ' <span class="sep">|</span> ' + esc(p.archetype || '') + '</div>'
      + '<div class="pc-ovr"><b class="mono">' + (p.overall | 0) + '</b><span>OVR</span></div>'
      + '<div class="pc-attrs">' + attrs + '</div>'
      + (uni ? '<div class="pc-uni">' + uni + '</div>' : '')
      + (function () {
          var rp = runProfile(p);
          if (!rp) return '';
          return '<div class="pc-run">'
            + rp.traits.map(function (a) {
                return '<span class="pc-r" title="' + esc(a.name) + '"><i>' + esc(a.label) + '</i><b>' + a.value + '</b><em>' + esc(a.word) + '</em></span>';
              }).join('')
            + rp.rates.map(function (a) {
                return '<span class="pc-r pc-r-earned" title="' + esc(a.name) + '"><i>' + esc(a.label) + '</i><b>' + a.value + esc(a.unit) + '</b></span>';
              }).join('')
            + (rp.enough ? '' : '<span class="pc-r pc-r-wait">' + rp.carries + ' of ' + rp.min + ' carries</span>')
            + '</div>';
        })()
      + (tr ? '<div class="pc-trait"><span class="k">Trait</span><b>' + esc(tr.name) + '</b><span class="d">' + esc(tr.desc || '') + '</span></div>'
            : '<div class="pc-trait none"><span class="k">Trait</span><span class="d">None yet</span></div>')
      + '<div class="pc-meta">Age ' + (p.age | 0) + ' <span class="sep">·</span> POT ' + (p.potential | 0)
      + ' <span class="sep">·</span> ' + esc(DEV_TIERS[p.dev_tier] || p.dev_tier || '')
      + (p.potential != null ? ' <span class="sep">·</span> ' + esc(potentialWord(p)) : '')
      + (body || home ? '<span class="pc-bio">' + (body ? esc(body.height) + ' · ' + esc(body.weight_lb) + ' lb' : '')
          + (home ? (body ? ' · ' : '') + esc(home) : '') + '</span>' : '')
      + '</div>'
      + (hurt ? '<div class="pc-injury"><span class="k">Unavailable</span>' + esc(hurtLine) + '</div>' : '')
      + '<div class="pc-acq"><span class="k">Acquired</span>' + esc(acquiredLine(p)) + '</div>'
      + (seasonLine(p) ? '<div class="pc-career"><span class="k">This season</span>' + esc(seasonLine(p)) + '</div>' : '')
      + '<div class="pc-career"><span class="k">Career</span>' + esc(careerLine(p)) + '</div>'
      + (handsLine(p) ? '<div class="pc-career pc-hands"><span class="k">In your hands</span>' + esc(handsLine(p)) + '</div>' : '')
      + (function () { var bs = badges(p); return bs.length ? '<div class="pc-badges">' + bs.map(function (b) { return '<i class="pc-badge" title="' + esc(b.detail || b.label) + '">' + esc(b.label) + '</i>'; }).join('') + '</div>' : ''; })()
      + (o.fit && (o.fit.scheme || o.fit.matchup) ? '<div class="pc-fit">'
          + (o.fit.scheme ? '<span class="' + (o.fit.scheme.value > 0 ? 'up' : o.fit.scheme.value < 0 ? 'dn' : '') + '"><i>Scheme</i>' + esc(o.fit.scheme.word) + (o.fit.scheme.value ? ' (' + (o.fit.scheme.value > 0 ? '+' : '') + esc(o.fit.scheme.value) + ')' : '') + '</span>' : '')
          + (o.fit.matchup ? '<span class="' + (o.fit.matchup.value > 0 ? 'up' : o.fit.matchup.value < 0 ? 'dn' : '') + '"><i>Saturday</i>' + esc(o.fit.matchup.word) + (o.fit.matchup.value ? ' (' + (o.fit.matchup.value > 0 ? '+' : '') + esc(o.fit.matchup.value) + ')' : '') + '</span>' : '')
          + '</div>' : '')
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
  var OFFSEASON_VERSION = 'offseason_v2';
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

  /* ── THE COACHING STAFF (Phase 8) ───────────────────────────────────────
     Where Coach Points go, forever. Two curves and nothing else:

       cost(L → L+1) = 1 + floor((L − 1) / 10)      a CP, +1 every ten levels
       effect(L)     = cap × ln(L) / ln(1000)       a tenfold is another third

     Both are restated here for display — what a level will cost before it is
     bought, what a coach is worth — and pinned to the SQL by
     tools/games/franchise.test.js. The server hires, levels and scores. */
  var STAFF_VERSION = 'staff_v2';
  var STAFF = {
    max_level: 1000, hire_cost: 12, cost_base: 1, cost_step: 10,
    /* staff_v2 (Phase 12). Measured over sixty seasons: Coach Points came
       only from winning and made 10.4 a season, against a building where
       one seat at level 100 costs 540 — the measured franchise finished
       sixty years with ONE coach at level 99 and three empty chairs. The
       rank pays the building now, and a replacement arrives at what the
       franchise's reputation commands rather than at level one, so firing
       somebody is a decision instead of a trap. */
    rank_cp_base: 20, rank_cp_step: 2,
    hire_level_max: 60, hire_per_rank: 0.5, hire_per_standing: 10,
    specialty_every: 25, specialty_max: 10, promote_max: 100,
    seats: [
      { key: 'head',    name: 'Head Coach',             means: 'Steadies the fourth quarter and overtime', cap: 2.5, sort: 1 },
      { key: 'offense', name: 'Offensive Coordinator',  means: 'Adds to the offense in every game', cap: 3.0, sort: 2 },
      { key: 'defense', name: 'Defensive Coordinator',  means: 'Adds to the defense in every game', cap: 3.0, sort: 3 },
      { key: 'trainer', name: 'Head Trainer',           means: 'Cuts the chance a game costs somebody, and grows the young faster', cap: 1.0, sort: 4 }
    ],
    grades: [
      { at: 1, name: 'Rookie' }, { at: 25, name: 'Assistant' }, { at: 100, name: 'Coordinator' },
      { at: 250, name: 'Veteran' }, { at: 500, name: 'Legend' }, { at: 1000, name: 'Hall of Fame' }
    ]
  };
  /* what the next level costs */
  function staffCost(level) {
    var L = Math.max(1, Math.min(STAFF.max_level, level | 0));
    return STAFF.cost_base + Math.floor((L - 1) / STAFF.cost_step);
  }
  /* what the whole climb from one level to another costs */
  function staffCostBetween(from, to) {
    var a = Math.max(1, from | 0), b = Math.min(STAFF.max_level, to | 0), n = 0, L;
    for (L = a; L < b; L++) n += staffCost(L);
    return n;
  }
  /* how many levels a purse buys from here, and what they cost */
  function staffAfford(level, cp) {
    var L = Math.max(1, level | 0), left = Math.max(0, cp | 0), n = 0, spent = 0, step;
    while (L + n < STAFF.max_level && n < STAFF.promote_max) {
      step = staffCost(L + n);
      if (spent + step > left) break;
      spent += step; n++;
    }
    return { levels: n, cost: spent };
  }
  /* what a level is worth: every tenfold is another third of the cap */
  function staffEffect(level, cap) {
    var L = Math.max(1, Math.min(STAFF.max_level, level | 0));
    return Math.round((+cap || 0) * Math.log(L) / Math.log(STAFF.max_level) * 1000) / 1000;
  }
  function staffGrade(level) {
    var L = Math.max(1, level | 0), out = STAFF.grades[0].name;
    STAFF.grades.forEach(function (g) { if (g.at <= L) out = g.name; });
    return out;
  }
  /* what a rank pays the building: 20, and two more for every rank held */
  function rankCoachPoints(rank) {
    return STAFF.rank_cp_base + STAFF.rank_cp_step * Math.max(0, (rank | 0) - 1);
  }
  /* the level a new coach arrives at — what your reputation commands */
  function staffHireLevel(rank, standing) {
    return Math.max(1, Math.min(STAFF.hire_level_max,
      1 + Math.floor(Math.max(0, (rank | 0) - 1) * STAFF.hire_per_rank)
        + Math.floor(Math.max(0, standing | 0) / STAFF.hire_per_standing)));
  }
  /* CAREER (Phase 12): the founding roster is spread evenly across these
     ages so about three men retire every season instead of twenty-seven in
     seven — the cliff a sixty-season measurement fell off. */
  var CAREER_VERSION = 'career_v1';
  var CAREER = { found_age_min: 21, found_age_max: 32,
                 retire_age: 35, retire_fade_age: 33, retire_fade_under: 55 };

  /* ── THE DRIVES YOU CALL (Phase 13, snap_v1) ─────────────────────────────
     Everything under this game was deeper than the game it is named after,
     except the part your hands do: Game Day was one button and the page said
     so — "Simulated on the server from your roster, your scheme, the opponent
     and this week's preparation." You never played a down.

     Now the weekly game is a dozen decisions, one a possession. A CALL IS A
     DECISION, NEVER A RESULT: the page sends 'air', never 'touchdown', and
     the server resolves the drive from the game's own seed, the roster, the
     opponent and the call. These numbers are presentation — the same table
     franchise_snaps() returns, pinned to it by tools/games/franchise.test.js.

     Quick play stays: a game played that way is a game called Balanced the
     whole way through. */
  var SNAP_VERSION = 'snap_v1';
  var SNAPS = {
    'default': 'balanced',
    calls: [
      { key: 'ground', name: 'Ground',
        means: 'Lean on the backs and the line. Safer, slower, fewer scores.',
        pass: -0.22, td: -0.025, turnover: -0.075, edge: 0 },
      { key: 'balanced', name: 'Balanced',
        means: 'Your scheme\'s own shape. What quick play calls.',
        pass: 0, td: 0, turnover: 0, edge: 0 },
      { key: 'air', name: 'Air it out',
        means: 'Lean on the quarterback and the receivers. More scores, more risk.',
        pass: 0.20, td: 0.030, turnover: 0.095, edge: 0 },
      { key: 'shot', name: 'Take a shot',
        means: 'Everything at once: the best chance of seven, and of handing it back.',
        pass: 0.28, td: 0.060, turnover: 0.190, edge: 0 }
    ]
  };
  /* one call by key, defaulting to the scheme's own shape */
  function snapCall(key) {
    var out = null, def = null;
    SNAPS.calls.forEach(function (c) {
      if (c.key === key) out = c;
      if (c.key === SNAPS['default']) def = c;
    });
    return out || def;
  }
  /* "Ground · 4th possession of 12" */
  function snapLine(key, n, of) {
    var c = snapCall(key) || {};
    return c.name + ' · ' + ordinal(n | 0) + ' possession of ' + (of | 0);
  }
  function ordinal(n) {
    var t = n % 100, o = n % 10;
    return n + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }
  /* what a drive did, in the words a scoreboard uses */
  function driveLine(d) {
    d = obj(d);
    var who = d.side === 'me' ? 'You' : 'They';
    var what = d.outcome === 'td' ? 'score a touchdown'
             : d.outcome === 'fg' ? 'kick a field goal'
             : d.outcome === 'fg_miss' ? 'miss the field goal'
             : d.outcome === 'turnover' ? 'give it away'
             : 'punt it away';
    return who + ' ' + what + ' — ' + (d.plays | 0) + ' plays, ' + (d.yds | 0) + ' yards';
  }

  /* ── KEY MOMENTS (Phase 14, moment_v1) ───────────────────────────────────
     Measured before it was written. Fifteen hundred games between two
     IDENTICAL sides: by the last possession only 44% are within a score, and
     the average gap runs 2.9 → 7.0 → 9.9 → 12.3. You call twelve possessions
     and more than half the late ones are taps on a game already over.

     The first fix I tried was wrong: late urgency for the trailing side moved
     the margin from 12.3 to 11.9 and the live finishes from 43.9% to 44.1%.
     Pushing buys variance, not points. And it SHOULD NOT close the gap — real
     football averages eleven or twelve points of margin too. The football is
     not broken; the game just never knew which possessions mattered.

     So nothing here touches how a drive resolves. The stake is computed from
     the running score the simulator already keeps — a hundred and twenty
     seeded games play out identically before and after this phase. */
  var MOMENT_VERSION = 'moment_v1';
  var MOMENTS = { key_stake: 0.50, one_score: 8, close: 3, late: 4, dead: 21 };

  /* WHAT IS AT STAKE ON ONE POSSESSION, in [0, 1]. Two halves, each obviously
     right on its own, multiplied together: nothing is at stake in the first
     quarter of a tied game, and nothing is at stake three scores down.
     Pinned number for number to franchise_stake() by the test file. */
  function stake(gap, left) {
    var l = left | 0;
    if (l <= 0) return 0;
    var late = MOMENTS.late;
    var lateness = Math.max(0, Math.min(1, (late + 1 - Math.min(late + 1, l)) / late));
    var closeness = Math.max(0, Math.min(1,
      1 - Math.max(0, Math.abs(gap | 0) - MOMENTS.close) / (MOMENTS.dead - MOMENTS.close)));
    return Math.round(lateness * closeness * 1000) / 1000;
  }
  function isKey(s) { return (+s || 0) >= MOMENTS.key_stake; }
  /* "Down 4 with two to play" — what a possession is worth, in words */
  function stakeLine(gap, left) {
    var g = gap | 0, l = left | 0;
    if (l <= 0) return '';
    var where = g === 0 ? 'Tied' : (g > 0 ? 'Up ' : 'Down ') + Math.abs(g);
    return where + ' with ' + (l === 1 ? 'one possession left' : l + ' to play');
  }
  /* the one line a moment is worth telling somebody */
  function momentLine(m) {
    m = obj(m);
    var what = m.outcome === 'td' ? 'a touchdown' : m.outcome === 'fg' ? 'a field goal'
             : m.outcome === 'fg_miss' ? 'a missed kick' : m.outcome === 'turnover' ? 'a giveaway'
             : 'a punt';
    var c = m.call ? (snapCall(m.call) || {}).name : null;
    return (c ? c + ' — ' : '') + what + ', ' + (m.me | 0) + '–' + (m.op | 0);
  }

  /* ── BOTH SIDES OF THE BALL (Phase 15) ───────────────────────────────────
     Measured first, and the measurement was damning: called every possession
     the same way, a team got 10.95 possessions a side whether it ground the
     ball out or threw it on every down — identical to two decimal places,
     because possessions were drawn once before a snap from two scheme labels
     and a dice roll. And you only ever played half the game.

     THE CLOCK (clock_v1). No set number of plays: sixty minutes, and
     possessions are what fits inside them. The ball on the ground keeps the
     clock moving, the ball in the air stops it — so grinding now yields 10.57
     possessions a side and shooting 12.08, with ranges of 8–13 and 10–15.

     DEFENSE (defense_v1). You call their possessions too. The read is worth
     about four points of margin either way, and which front is right depends
     entirely on the team you are playing. */
  var CLOCK_VERSION = 'clock_v1';
  var CLOCK = {
    quarters: 4, quarter_seconds: 900,
    run_seconds: 38, pass_seconds: 19, score_seconds: 18, change_seconds: 12,
    nominal_drive: 175, hurry_from: 300, hurry_tempo: 0.62, grind_tempo: 1.15, ot_rounds: 2
  };
  /* "Q2 · 2:35" — what the clock says, from seconds left in the game. The
     quarter is worked out from time ELAPSED, the same way the simulator does
     it, rather than from time remaining, which gets the opening kickoff
     wrong. */
  function clockLine(secsLeft) {
    var total = CLOCK.quarters * CLOCK.quarter_seconds;
    var s = Math.max(0, Math.min(total, secsLeft | 0));
    var q = Math.min(CLOCK.quarters, 1 + Math.floor((total - s) / CLOCK.quarter_seconds));
    var inQ = s - (CLOCK.quarters - q) * CLOCK.quarter_seconds;
    var m = Math.floor(inQ / 60), ss = inQ % 60;
    return { q: q, label: m + ':' + (ss < 10 ? '0' : '') + ss };
  }
  /* what a drive costs the clock — the same arithmetic franchise_drive_seconds does */
  function driveSeconds(plays, passShare, outcome, tempo) {
    var p = Math.max(1, plays | 0), ps = passShare == null ? 0.5 : +passShare;
    var t = Math.max(0.4, Math.min(2.0, tempo == null ? 1 : +tempo));
    var v = p * (ps * CLOCK.pass_seconds + (1 - ps) * CLOCK.run_seconds) * t
          + (outcome === 'td' || outcome === 'fg' ? CLOCK.score_seconds : CLOCK.change_seconds);
    return Math.max(12, Math.round(v));
  }

  /* THE FOUR FRONTS. Each number is split by whether the ball is on the
     ground or in the air, and weighted by the offense's own pass share —
     their call already in it. Guess right and you take it away. */
  var DEFENSE_VERSION = 'defense_v1';
  var FRONTS = {
    'default': 'base',
    calls: [
      { key: 'stack', name: 'Stack the box',
        means: 'Crowd the line. Murder on the run — and they can go over the top of it.',
        td_vs_run: -0.060, td_vs_pass: 0.050, to_vs_run: 0.035, to_vs_pass: -0.020 },
      { key: 'base', name: 'Base',
        means: 'Play it honest. What quick play calls.',
        td_vs_run: 0, td_vs_pass: 0, to_vs_run: 0, to_vs_pass: 0 },
      { key: 'cover', name: 'Cover deep',
        means: 'Take the pass away. They can run it down your throat instead.',
        td_vs_run: 0.050, td_vs_pass: -0.060, to_vs_run: -0.020, to_vs_pass: 0.035 },
      { key: 'blitz', name: 'Blitz',
        means: 'Send them. The best chance of taking it away, and of being taken apart.',
        td_vs_run: 0.030, td_vs_pass: 0.040, to_vs_run: 0.080, to_vs_pass: 0.095 }
    ]
  };
  function frontCall(key) {
    var out = null, def = null;
    FRONTS.calls.forEach(function (c) {
      if (c.key === key) out = c;
      if (c.key === FRONTS['default']) def = c;
    });
    return out || def;
  }
  /* which side of the ball a call belongs to — the two tables never share a
     key, so a call names its own side and the server refuses a wrong one */
  function callSide(key) {
    var side = null;
    SNAPS.calls.forEach(function (c) { if (c.key === key) side = 'off'; });
    FRONTS.calls.forEach(function (c) { if (c.key === key) side = 'def'; });
    return side;
  }
  /* the table for whichever side of the ball this possession is on */
  function callsFor(side) { return side === 'def' ? FRONTS.calls : SNAPS.calls; }

  /* ── THE PLAYBOOK (Phase 16, playbook_v1) ────────────────────────────────
     Measured first: four calls was the ENTIRE offensive vocabulary, identical
     for every franchise in the game — franchise_snaps() takes no argument, so
     an Air Raid and a Power-Run team called from the same menu. There were no
     formations and no trick plays, and eight thousand drives said a touchdown
     drive was 55 to 85 yards EVERY TIME: there was no such thing as a big
     play.

     A play SPECIALISES a call rather than replacing it — every play names one
     of the four and inherits its numbers exactly as Phase 13 measured them —
     so nothing tuned there is thrown away and quick play is still Balanced. */
  var PLAYBOOK_VERSION = 'playbook_v1';

  /* `tell` is what lining up in a set says to the defense: -1 screams run,
     +1 screams pass. It is the whole reason a trick play works — measured,
     the I-Formation draws a stacked box 55.6% of the time and Empty 2.4%. */
  var FORMATIONS = [
    { key: 'i_form', name: 'I-Formation', tell: -0.75,
      means: 'Two backs, tight ends, everybody close. It says run before the snap.' },
    { key: 'single', name: 'Singleback', tell: -0.25,
      means: 'One back, balanced personnel. It says nothing much, which is its own virtue.' },
    { key: 'gun', name: 'Shotgun', tell: 0.45,
      means: 'Quarterback off the line, receivers spread. It leans pass and keeps the run.' },
    { key: 'empty', name: 'Empty', tell: 0.90,
      means: 'Five out, nobody in the backfield. Everyone in the stadium knows what this is.' },
    { key: 'wildcat', name: 'Wildcat', tell: -0.90,
      means: 'The ball to a back directly. No quarterback on the field, and they can see that.' }
  ];

  var PLAYS = [
    { key: 'iso', name: 'Iso', formation: 'i_form', type: 'run', call: 'ground',
      td: 0.0, turnover: -0.010, explosive: 0.0,
      means: 'Lead back through the hole. Nothing clever, nothing lost.' },
    { key: 'power_o', name: 'Power O', formation: 'i_form', type: 'run', call: 'ground',
      td: 0.010, turnover: 0.0, explosive: 0.05,
      means: 'Pull the guard and follow him. The short-yardage answer.' },
    { key: 'play_action', name: 'Play-action deep', formation: 'i_form', type: 'pass', call: 'air',
      td: 0.030, turnover: 0.015, explosive: 0.30,
      means: 'Sell the run from a run look, then throw over the top of it.' },
    { key: 'flea_flicker', name: 'Flea flicker', formation: 'i_form', type: 'trick', call: 'shot',
      td: 0.110, turnover: 0.090, explosive: 0.55,
      means: 'Hand it off, get it back, throw it deep. Ruin against a stacked box.' },
    { key: 'inside_zone', name: 'Inside zone', formation: 'single', type: 'run', call: 'ground',
      td: 0.0, turnover: 0.0, explosive: 0.05,
      means: 'The play every team has. It works often enough and loses nothing.' },
    { key: 'curl_flat', name: 'Curl-flat', formation: 'single', type: 'pass', call: 'balanced',
      td: 0.0, turnover: -0.015, explosive: 0.0,
      means: 'Two receivers, high and low, and an easy read. Safe football.' },
    { key: 'hb_screen', name: 'Screen', formation: 'single', type: 'pass', call: 'balanced',
      td: 0.015, turnover: 0.020, explosive: 0.25,
      means: 'Let them come, then throw behind them. Murder on a blitz.' },
    { key: 'hb_pass', name: 'Halfback pass', formation: 'single', type: 'trick', call: 'shot',
      td: 0.100, turnover: 0.100, explosive: 0.50,
      means: 'Give it to the back and let him throw it. He is not a quarterback.' },
    { key: 'draw', name: 'Draw', formation: 'gun', type: 'run', call: 'balanced',
      td: 0.010, turnover: -0.010, explosive: 0.20,
      means: 'Wait for them to drop, then run through where they were.' },
    { key: 'mesh', name: 'Mesh', formation: 'gun', type: 'pass', call: 'air',
      td: 0.0, turnover: -0.020, explosive: 0.05,
      means: 'Crossers underneath. Somebody is always open, nobody is ever deep.' },
    { key: 'four_verts', name: 'Four verticals', formation: 'gun', type: 'pass', call: 'shot',
      td: 0.015, turnover: 0.010, explosive: 0.40,
      means: 'Everybody runs. Somebody wins, or nobody does.' },
    { key: 'qb_keep', name: 'Quarterback keep', formation: 'gun', type: 'run', call: 'ground',
      td: 0.015, turnover: 0.010, explosive: 0.15,
      means: 'He pulls it and goes. Worth what your quarterback is worth on his feet.' },
    { key: 'double_reverse', name: 'Double reverse', formation: 'gun', type: 'trick', call: 'ground',
      td: 0.085, turnover: 0.110, explosive: 0.45,
      means: 'Across, back across, and gone — if nobody stayed home.' },
    { key: 'quick_slants', name: 'Quick slants', formation: 'empty', type: 'pass', call: 'air',
      td: 0.010, turnover: -0.025, explosive: 0.10,
      means: 'Out of his hands before anyone gets there. The blitz-beater.' },
    { key: 'smash', name: 'Smash', formation: 'empty', type: 'pass', call: 'air',
      td: 0.020, turnover: 0.0, explosive: 0.20,
      means: 'Corner and hitch against the same defender. Pick your half.' },
    { key: 'deep_shot', name: 'Deep shot', formation: 'empty', type: 'pass', call: 'shot',
      td: 0.020, turnover: 0.020, explosive: 0.55,
      means: 'One receiver, one defender, one throw.' },
    { key: 'qb_draw', name: 'Quarterback draw', formation: 'empty', type: 'trick', call: 'ground',
      td: 0.090, turnover: 0.075, explosive: 0.35,
      means: 'Five receivers out and he runs it himself. Nobody is left in the box.' },
    { key: 'wildcat_power', name: 'Wildcat power', formation: 'wildcat', type: 'run', call: 'ground',
      td: 0.020, turnover: 0.0, explosive: 0.10,
      means: 'An extra blocker where the quarterback used to be.' },
    { key: 'jet_sweep', name: 'Jet sweep', formation: 'wildcat', type: 'run', call: 'ground',
      td: 0.015, turnover: 0.015, explosive: 0.30,
      means: 'Full speed to the edge. All of it or none of it.' },
    { key: 'wildcat_pass', name: 'Wildcat pass', formation: 'wildcat', type: 'trick', call: 'shot',
      td: 0.120, turnover: 0.115, explosive: 0.60,
      means: 'The back pulls up and throws. Against eight in the box it is a touchdown.' }
  ];

  /* WHICH FORMATIONS A SCHEME CARRIES — what makes a playbook a playbook. */
  var PLAYBOOK_SETS = {
    power_run: ['i_form', 'single', 'wildcat', 'gun'],
    option:    ['i_form', 'single', 'wildcat', 'gun'],
    pro_style: ['i_form', 'single', 'gun', 'empty'],
    spread:    ['single', 'gun', 'empty', 'wildcat'],
    air_raid:  ['gun', 'empty', 'single']
  };
  function playbookSets(scheme) { return PLAYBOOK_SETS[scheme] || PLAYBOOK_SETS.pro_style; }
  function formation(key) {
    var out = null;
    FORMATIONS.forEach(function (f) { if (f.key === key) out = f; });
    return out;
  }
  function play(key) {
    var out = null, def = null;
    PLAYS.forEach(function (p) {
      if (p.key === key) out = p;
      if (p.key === 'inside_zone') def = p;
    });
    return out || def;
  }
  function playAllowed(scheme, key) {
    var p = null;
    PLAYS.forEach(function (x) { if (x.key === key) p = x; });
    return !!p && playbookSets(scheme).indexOf(p.formation) >= 0;
  }
  /* the book one franchise actually has, grouped the way a page draws it */
  function playbook(scheme) {
    var sets = playbookSets(scheme), out = [];
    FORMATIONS.forEach(function (f) {
      if (sets.indexOf(f.key) < 0) return;
      out.push({ key: f.key, name: f.name, tell: f.tell, means: f.means,
                 plays: PLAYS.filter(function (p) { return p.formation === f.key; }) });
    });
    return out;
  }
  /* "Says run" / "Says pass" / "Says nothing" — what lining up here tells them */
  function tellLine(tell) {
    var t = +tell || 0;
    if (t <= -0.6) return 'Screams run';
    if (t <= -0.15) return 'Leans run';
    if (t < 0.15) return 'Says nothing';
    if (t < 0.6) return 'Leans pass';
    return 'Screams pass';
  }
  /* what a play did, in the words a play-by-play uses */
  function playLine(d) {
    d = obj(d);
    var p = d.play ? play(d.play) : null;
    if (!p) return '';
    var fm = formation(p.formation);
    return p.name + (fm ? ' · ' + fm.name : '')
      + (d.trick && d.fooled != null ? (d.fooled >= 0.7 ? ' · they bought it' : d.fooled <= 0.3 ? ' · they read it' : '') : '')
      + (d.big ? ' · broke one' : '');
  }

  function staffSpecialtyCount(level) {
    return Math.min(STAFF.specialty_max, Math.floor(Math.max(1, level | 0) / STAFF.specialty_every));
  }
  function staffSeat(key) {
    var out = null;
    STAFF.seats.forEach(function (s) { if (s.key === key) out = s; });
    return out;
  }
  /* "Coordinator · level 137 of 1000 · +2.1 offense" */
  function staffLine(seat) {
    seat = obj(seat);
    if (!seat.filled) return 'Empty · ' + STAFF.hire_cost + ' CP to hire';
    var s = staffSeat(seat.seat) || {};
    return (seat.grade || staffGrade(seat.level)) + ' · level ' + (seat.level | 0) + ' of ' + STAFF.max_level
      + (seat.effect ? ' · +' + seat.effect + (s.key === 'trainer' ? '' : ' ' + (s.key === 'defense' ? 'defense' : s.key === 'offense' ? 'offense' : 'late game')) : '');
  }
  /* ── THE RANK AND THE PACKS (Phase 11) ──────────────────────────────────
     What playing a lot is worth. Everything else in this game is paid for by
     being GOOD at something — Scouting Points by pricing well, Coach Points
     by winning, the standing by beating better clubs. Nothing was paid for by
     turning up, and the number that measured turning up (the franchise level,
     off XP) decided nothing and stopped at 30.

     The rank counts activity, never caps, and pays in players. Everything
     here is presentation, pinned to the SQL by tools/games/franchise.test.js.
     THE SERVER COUNTS, ROLLS AND KEEPS. Nothing is purchasable: a pack is
     earned by playing and by nothing else. */
  var RANK_VERSION = 'rank_v1';
  /* PACKS_VERSION lives with the Vault below: the rank's cache is one kind of
     pack now, and packs_v2 says what every kind holds. */
  var RANKS = {
    cost_base: 15, cost_step: 3, pack_size: 3, pack_keep: 1,
    floor_below: 10, edge_base: 2, edge_per_rank: 0.3, edge_max: 14,
    weights: { weekly_game: 3, bowl_bid: 3, conf_game: 3, fc_played: 2,
               price_it: 1, drill_daily: 1, research_open: 1,
               pick5_card: 2, season_complete: 5, live_game: 2 }
  };
  /* what the next rank costs: 15, and three more every time */
  function rankCost(rank) { return RANKS.cost_base + RANKS.cost_step * Math.max(0, (rank | 0) - 1); }
  /* the points it takes to stand at a rank — the sum of every step below it */
  function rankAt(rank) {
    var n = Math.max(1, rank | 0), total = 0, r;
    for (r = 1; r < n; r++) total += rankCost(r);
    return total;
  }
  /* and the rank a pile of points buys */
  function rankFor(points) {
    var p = Math.max(0, points | 0), r = 1;
    while (rankAt(r + 1) <= p) r++;
    return r;
  }
  /* how far above your own team a pack can reach, at a rank */
  function rankEdge(rank) {
    return Math.min(RANKS.edge_max,
      RANKS.edge_base + Math.floor(RANKS.edge_per_rank * Math.max(0, (rank | 0) - 1)));
  }
  /* the band a pack would hold for a team of this overall, at this rank */
  function packBand(teamOverall, rank) {
    var o = teamOverall | 0, low = Math.max(40, o - RANKS.floor_below);
    /* a team below the floor would otherwise be handed a ceiling under it */
    return [low, Math.max(low, Math.min(99, o + rankEdge(rank)))];
  }
  /* what one activity is worth toward the next rank */
  function rankWeight(kind) { return RANKS.weights[kind] || 0; }
  /* "Rank 12 · 318 of 354" */
  function rankLine(rep) {
    rep = obj(rep);
    return 'Rank ' + (rep.rank | 0) + ' · ' + (rep.points | 0) + ' of ' + (rep.next_at | 0);
  }

  /* ── THE DEVELOPMENT PROGRAM AND THE LEAGUE (Phase 10) ───────────────────
     Measured before it was written. Over ten seasons of a franchise doing
     everything right, team overall went 69 → 71 and the record never moved,
     for two reasons that had to be fixed together:

       a player's ceiling was set at birth and nothing could raise it — 76%
       of a season-ten roster sat exactly at its potential, and the finest 42
       players the generator could ever roll would have rated 78;

       and every opponent was rated FROM YOUR OWN TEAM OVERALL, so the league
       was a rubber band and a better roster could not win one extra game.

     So: a program that raises a man's ceiling, paid for with the Scouting
     Points nobody could spend, graded on the football he actually played —
     and twenty-four clubs with ratings of their own to spend it against.

     Everything here is presentation and pinned to the SQL by
     tools/games/franchise.test.js. THE SERVER GRADES, LIFTS AND SCHEDULES. */
  var DEVELOPMENT_VERSION = 'development_v1';
  var DEVELOPMENT = {
    slots_base: 2, slots_per_rank: 10, cap: 15, cost_base: 100, cost_step: 15,
    lift_base: 1, lift_span: 5, age_full: 26, age_half: 29,
    grade: { available: 40, record: 30, impact: 30 }
  };
  /* what the next program costs a man who has already been given this much */
  function devCost(developed) {
    var d = Math.max(0, Math.min(DEVELOPMENT.cap, developed | 0));
    return DEVELOPMENT.cost_base + DEVELOPMENT.cost_step * d;
  }
  /* what a grade is worth at an age: +1 to +6, halved from 27, nothing at 30 */
  function devLift(grade, age) {
    var g = Math.max(0, Math.min(100, grade | 0));
    var raw = DEVELOPMENT.lift_base + Math.round(DEVELOPMENT.lift_span * g / 100);
    if ((age | 0) > DEVELOPMENT.age_half) return 0;
    if ((age | 0) > DEVELOPMENT.age_full) return Math.max(1, Math.floor(raw / 2));
    return raw;
  }
  /* how many places an offseason has: two, one per Training Center level, and
     one for every ten ranks of having played (rank_v1) — a franchise that has
     been at it for years has a bigger department, which is what pays for the
     rebuild when a founding roster ages out together */
  function devSlots(training, rank) {
    return DEVELOPMENT.slots_base + Math.max(0, Math.min(3, training | 0))
      + Math.floor(Math.max(1, rank | 0) / DEVELOPMENT.slots_per_rank);
  }
  /* "Ever-present on a winning team" — what a grade means, in words */
  function devGradeLine(g) {
    g = obj(g);
    var n = g.grade | 0;
    return (n >= 80 ? 'A season that earns the most a program can give'
      : n >= 60 ? 'A good season'
      : n >= 40 ? 'A part season'
      : n >= 20 ? 'Barely played' : 'He did not play')
      + ' · ' + (g.played | 0) + ' of ' + (g.games | 0) + ' games';
  }

  var LEAGUE_VERSION = 'league_v1';
  var LEAGUE = { standing_start: 40, standing_min: 0, standing_max: 100,
                 win_base: 2, loss_base: -3, edge_per_point: 0.20, rival_multiplier: 2 };
  /* what a standing faces: the rating at the middle of the slate it draws */
  function leagueFacing(standing) {
    return 48 + Math.round(Math.max(0, Math.min(100, standing | 0)) * 0.34);
  }
  /* the gap between where you stand and what a club rates */
  function leagueGap(standing, strength) { return (strength | 0) - leagueFacing(standing); }
  /* what a result moves the standing — the same arithmetic the server does */
  /* ROUNDED FIRST, THEN DOUBLED — the same order the SQL uses, so a rival
     result is exactly twice an ordinary one rather than twice-then-rounded. */
  function standingDelta(result, standing, strength, rival) {
    var gap = leagueGap(standing, strength), n;
    if (result === 'W') n = Math.max(1, LEAGUE.win_base + LEAGUE.edge_per_point * gap);
    else if (result === 'L') n = Math.min(-1, LEAGUE.loss_base + LEAGUE.edge_per_point * gap);
    else return 0;
    return Math.round(n) * (rival ? LEAGUE.rival_multiplier : 1);
  }
  /* where a standing puts you, in words */
  function standingName(standing) {
    var n = Math.max(0, Math.min(100, standing | 0));
    return n >= 85 ? 'Among the best in the league'
      : n >= 65 ? 'In the upper half'
      : n >= 40 ? 'Mid-table'
      : n >= 20 ? 'Lower half' : 'Bottom of the league';
  }

  /* ── THE SCOUTING DEPARTMENT (Phase 9) ───────────────────────────────────
     What reading real football well is worth. The average Price It score
     over the last twenty VERIFIED pricings, pulled toward a neutral 50 in
     proportion to how far short of twenty the record is — so a new franchise
     starts in the middle, and the twentieth pricing is worth more than the
     first.

     Everything the grade buys is in the draft window and is decided ONCE,
     when the window opens: the band an unscouted prospect is shown in, what
     a report costs, how much POTENTIAL the class carries, and an extra pick
     at the top. The ends are chosen so that a NEUTRAL grade is exactly the
     game as it was before this phase — band 11, report 20 SP, no lift.

     The four curves are restated here so a page can say what the next grade
     is worth without a round trip, and pinned to the SQL by
     tools/games/franchise.test.js. THE SERVER GRADES; nothing here decides
     a band, a price or a class. */
  var SCOUTING_VERSION = 'scouting_v1';
  var SCOUTING = {
    window: 20, neutral: 50, ceiling: 6, extra_pick: 90,
    band: { wide: 18, tight: 4 }, report: { dear: 28, cheap: 12 },
    grades: [
      { key: 'unrated',  name: 'Unrated',           min: 0,
        means: 'No read on these games yet. The widest band, the dearest report.' },
      { key: 'regional', name: 'Regional scout',    min: 40,
        means: 'Where a franchise with no record starts.' },
      { key: 'area',     name: 'Area scout',        min: 55,
        means: 'A tighter band, a cheaper report, and the first points of upside.' },
      { key: 'national', name: 'National scout',    min: 68,
        means: 'Reading games well. The class starts to carry real potential.' },
      { key: 'director', name: 'Scouting director', min: 80,
        means: 'Four of six points of ceiling, and a report for little.' },
      { key: 'war_room', name: 'War room',          min: 90,
        means: 'The tightest band, the cheapest report, the whole ceiling — and one more draft pick.' }
    ]
  };
  function scoutClamp(score) { return Math.max(0, Math.min(100, Math.round(+score || 0))); }
  /* which grade a number is */
  function scoutGradeOf(score) {
    var n = scoutClamp(score), out = SCOUTING.grades[0];
    SCOUTING.grades.forEach(function (g) { if (g.min <= n) out = g; });
    return out;
  }
  /* the next grade up, and how far off it is — the only motivating line here */
  function scoutNext(score) {
    var n = scoutClamp(score), out = null;
    SCOUTING.grades.forEach(function (g) { if (out === null && g.min > n) out = g; });
    return out === null ? null : { key: out.key, name: out.name, at: out.min, need: out.min - n };
  }
  /* the band an unscouted prospect is shown in: 18 points at 0, 11 at
     neutral, 4 at the top — the same straight line the SQL walks */
  function scoutBand(score) {
    return Math.max(SCOUTING.band.tight,
      SCOUTING.band.wide - Math.round((SCOUTING.band.wide - SCOUTING.band.tight) * scoutClamp(score) / 100));
  }
  /* what a report costs: 28 Scouting Points down to 12, through 20 at neutral */
  function scoutCost(score) {
    return Math.max(SCOUTING.report.cheap,
      SCOUTING.report.dear - Math.round((SCOUTING.report.dear - SCOUTING.report.cheap) * scoutClamp(score) / 100));
  }
  /* how much POTENTIAL the department finds — never overall, and never below
     zero: a bad department misses, it does not make players worse */
  function scoutLift(score) {
    return Math.max(0, Math.round(SCOUTING.ceiling
      * Math.max(0, scoutClamp(score) - SCOUTING.neutral) / (100 - SCOUTING.neutral)));
  }
  /* the grade a record of n pricings averaging avg would be, before the
     window has filled — the preview a page shows next to "twenty pricings
     settle it" */
  function scoutScore(count, avg) {
    var n = Math.max(0, Math.min(SCOUTING.window, count | 0));
    return scoutClamp((scoutClamp(avg) * n + SCOUTING.neutral * (SCOUTING.window - n)) / SCOUTING.window);
  }
  /* "War room · 94 · 18 of 20 priced" */
  function scoutLine(sc) {
    sc = obj(sc);
    var g = sc.grade_name || scoutGradeOf(sc.score).name;
    return g + ' · ' + scoutClamp(sc.score)
      + ' · ' + Math.min(SCOUTING.window, sc.priced | 0) + ' of ' + SCOUTING.window + ' priced';
  }

  /* how far into the thousand a level is, for a bar that is honest about a
     long climb: the COST spent, not the level, because the level is not linear */
  function staffProgress(level) {
    var spent = staffCostBetween(1, Math.max(1, level | 0));
    return { spent: spent, total: staffCostBetween(1, STAFF.max_level),
      pct: Math.max(0, Math.min(100, Math.round(1000 * spent / staffCostBetween(1, STAFF.max_level)) / 10)) };
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
      if (!r.ok && r.status === 404) { _deployed = false; r.error = 'not_deployed'; r.message = 'Franchise services are temporarily unavailable.'; }
      else if (r.ok) _deployed = true;
      /* resume_v1: the transport is the only thing that knows whether the
         request left the building, so the state is set here and nowhere else */
      if (typeof setNet === 'function') setNet(r.ok ? NET.SYNCED : (r.error === 'unreachable' ? NET.OFFLINE : _net));
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
    return once('start_season').then(function (r) {
      if (r.ok && r.data && r.data.home) remember(r.data.home);
      return r;
    });
  }
  function playWeek() {
    return once('play_week').then(function (r) {
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

  /* THE COACHING STAFF (Phase 8). One read for the building; hire, promote
     and fire each send a seat and the identity and nothing else. Never
     queued — spending Coach Points must see its answer. */
  /* THE DEVELOPMENT PROGRAM (Phase 10). The board is one read; a program
     sends a player id and the identity and nothing else — the server grades
     the season out of its own boxes, decides the lift, prices it and takes
     the Scouting Points. Never queued: spending must see its answer. */
  /* THE RANK AND THE PACKS (Phase 11). The board is one read; opening sends
     the identity and nothing else, and keeping sends a player id. The server
     counts the rank, rolls the three men and decides the band. Never queued:
     opening a pack must see its answer. */
  /* ── THE VAULT (packs_v2) ─────────────────────────────────────────────────
     The pack table, mirrored for display; the SQL's franchise_pack_defs() is
     what applies, and the parity test pins these names to it. */
  /* THE CARD IS NOT THE MAN (cards_v1): the athlete, the edition, the
     instance, who holds it and where it plays are separate things on the
     server, and this is the version of that separation. */
  var CARDS_VERSION = 'cards_v1';
  var PACKS_VERSION = 'packs_v4';
  var PACKS = {
    gridiron_cache:     { name: 'Gridiron Cache', art: 'cache', size: 3, keep: 1, earned: 'every rank you reach' },
    rookie_cache:       { name: 'Rookie Cache', art: 'rookie', size: 3, keep: 1, earned: 'founding the franchise' },
    postseason_pack:    { name: 'Postseason Pack', art: 'postseason', size: 3, keep: 1, earned: 'a season seen out' },
    championship_vault: { name: 'Championship Vault', art: 'vault', size: 4, keep: 2, earned: 'a bowl won' },
    scouts_find:        { name: "Scout's Find", art: 'scout', size: 2, keep: 1, earned: 'three Price Its scoring 80 or better in one week' },
    gameday_pack:       { name: 'Game Day Pack', art: 'gameday', size: 3, keep: 1, earned: 'five live games finished at Pro or harder' },
    /* THE PROGRAMS (packs_v4): what the games in your hands add up to. Each
       draws from its own pool and dresses its own room. */
    speed_lab:          { name: 'Speed Lab', art: 'speed', size: 3, keep: 1, earned: 'every 1,500 live yards in your hands at Pro or harder' },
    trench_unit:        { name: 'Trench Unit', art: 'trench', size: 3, keep: 1, earned: 'three live games at Pro or harder holding them to ten points or fewer' },
    primetime_vault:    { name: 'Primetime Vault', art: 'primetime', size: 4, keep: 1, earned: 'five live wins at Pro or harder' }
  };
  function packDef(kind) { return PACKS[kind] || { name: kind, art: 'cache', size: 3, keep: 1, earned: '' }; }
  /* WHAT A PASSED MAN IS WORTH. Never silently gone: a man passed over in a
     pack is scouted, and the department books scouting points by his tier.
     A mirror of franchise_pack_defs()->'pass_sp'; the SQL credits it. */
  var PASS_SP = { prospect: 3, starter: 5, impact: 8, prime: 15, elite: 30, apex: 60, legend: 120, mythic: 250 };
  function passValue(men) {
    var sum = 0;
    (men || []).forEach(function (m) { if (!m || m.kept) return; sum += PASS_SP[m.tier || (PR && PR.tierOf ? PR.tierOf(m.overall | 0).key : 'starter')] || 0; });
    return sum;
  }
  /* WHICH ARCHETYPES A SCHEME LOVES: a mirror of franchise_scheme_fit(), the
     table the server's chemistry applies, -2 to +2, unlisted is 0. The
     parity test holds this to the SQL. */
  var SCHEME_FIT = {
      offense: {
        air_raid: { 'QB': { 'Gunslinger': 2, 'Field General': 1, 'Game Manager': -1 }, 'WR': { 'Deep Threat': 2, 'Route Runner': 1, 'Route Technician': 1, 'Slot Weapon': 1, 'Possession': -1, 'Possession Receiver': -1 }, 'TE': { 'Seam Stretcher': 2, 'Move TE': 1, 'In-Line': -1 }, 'RB': { 'Receiving Back': 2, 'Power Back': -1 }, 'OL': { 'Pass Protector': 2, 'Road Grader': -1 } },
        spread: { 'QB': { 'Scrambler': 2, 'Improviser': 2, 'Game Manager': -1 }, 'WR': { 'Slot Weapon': 2, 'Deep Threat': 1, 'Route Runner': 1 }, 'TE': { 'Move TE': 2, 'In-Line': -1 }, 'RB': { 'Elusive Back': 2, 'Receiving Back': 1, 'Power Back': -1 }, 'OL': { 'Technician': 2, 'Pass Protector': 1 } },
        pro_style: { 'QB': { 'Field General': 2, 'Game Manager': 1, 'Scrambler': -1 }, 'WR': { 'Possession': 1, 'Possession Receiver': 1, 'Route Runner': 1, 'Route Technician': 1 }, 'TE': { 'In-Line': 1, 'Move TE': 1 }, 'RB': { 'Workhorse': 2, 'Power Back': 1 }, 'OL': { 'Technician': 1, 'Pass Protector': 1, 'Road Grader': 1 } },
        power_run: { 'QB': { 'Game Manager': 2, 'Field General': 1, 'Gunslinger': -1 }, 'WR': { 'Physical Target': 2, 'Possession': 1, 'Possession Receiver': 1, 'Deep Threat': -1 }, 'TE': { 'In-Line': 2, 'Seam Stretcher': -1 }, 'RB': { 'Power Back': 2, 'Workhorse': 2, 'Elusive Back': -1 }, 'OL': { 'Road Grader': 2, 'Pass Protector': -1 } },
        option: { 'QB': { 'Scrambler': 2, 'Improviser': 1, 'Gunslinger': -1, 'Game Manager': -1 }, 'WR': { 'Deep Threat': 1, 'Physical Target': 1 }, 'TE': { 'In-Line': 1, 'Move TE': 1 }, 'RB': { 'Elusive Back': 2, 'Workhorse': 1 }, 'OL': { 'Road Grader': 2, 'Technician': 1, 'Pass Protector': -1 } },
        west_coast: { 'QB': { 'Game Manager': 2, 'Field General': 1, 'Gunslinger': -1 }, 'WR': { 'Route Runner': 2, 'Route Technician': 2, 'Possession': 1, 'Slot Weapon': 1, 'Deep Threat': -1 }, 'TE': { 'Move TE': 2, 'Seam Stretcher': 1 }, 'RB': { 'Receiving Back': 2, 'Elusive Back': 1 }, 'OL': { 'Technician': 2, 'Pass Protector': 1 } }
      },
      defense: {
        four_three: { 'DL': { 'Edge Rusher': 1, 'Run Stopper': 1, 'Balanced': 1, 'Hybrid': 1 }, 'LB': { 'Run Stopper': 1, 'Hybrid': 1 }, 'CB': { 'Coverage': 1, 'Hybrid': 1 }, 'S': { 'Coverage': 1, 'Run Stopper': 1 } },
        three_four: { 'DL': { 'Run Stopper': 2, 'Power Rusher': 1, 'Speed Rusher': -1 }, 'LB': { 'Hybrid': 2, 'Coverage': 1, 'Run Stopper': 1 }, 'CB': { 'Coverage': 1 }, 'S': { 'Ball Hawk': 1, 'Coverage': 1 } },
        press_man: { 'DL': { 'Edge Rusher': 2, 'Speed Rusher': 2, 'Run Stopper': -1 }, 'LB': { 'Coverage': 1 }, 'CB': { 'Shutdown': 2, 'Press Specialist': 2, 'Zone Specialist': -2, 'Ball Hawk': -1 }, 'S': { 'Coverage': 2, 'Run Stopper': -1 } },
        zone: { 'DL': { 'Hybrid': 1, 'Balanced': 1, 'Run Stopper': 1 }, 'LB': { 'Coverage': 2, 'Hybrid': 1, 'Run Stopper': -1 }, 'CB': { 'Zone Specialist': 2, 'Ball Hawk': 2, 'Press Specialist': -2 }, 'S': { 'Ball Hawk': 2, 'Coverage': 1 } },
        blitz_heavy: { 'DL': { 'Speed Rusher': 2, 'Edge Rusher': 2, 'Power Rusher': 1, 'Run Stopper': -1 }, 'LB': { 'Run Stopper': 1, 'Hybrid': 2, 'Coverage': -1 }, 'CB': { 'Shutdown': 1, 'Press Specialist': 1, 'Coverage': 1 }, 'S': { 'Run Stopper': 1, 'Ball Hawk': 1 } },
        bend_dont_break: { 'DL': { 'Run Stopper': 2, 'Balanced': 1, 'Speed Rusher': -1 }, 'LB': { 'Coverage': 2, 'Run Stopper': 1 }, 'CB': { 'Zone Specialist': 1, 'Coverage': 2, 'Press Specialist': -1 }, 'S': { 'Coverage': 2, 'Ball Hawk': 1 } }
      }
    };
  function schemeFit(side, scheme, position, archetype) {
    var t = SCHEME_FIT[side] && SCHEME_FIT[side][scheme] && SCHEME_FIT[side][scheme][position];
    return t && archetype && t[archetype] != null ? t[archetype] : 0;
  }
  var OFFENSE_POS = { QB: 1, RB: 1, WR: 1, TE: 1, OL: 1 };
  /* SATURDAY'S MATCHUP: what the opponent's scheme does to a man's archetype,
     -2 to +2, unlisted is 0. An offensive man is read against their defence,
     a defensive man against their offence. A small, original table; the
     parity test holds every archetype in it to one the scheme table knows. */
  var MATCHUP_FIT = {
    /* their defence, and your offensive men */
    vs_defense: {
      press_man:       { WR: { 'Deep Threat': 2, 'Route Technician': 1, 'Route Runner': 1, 'Possession': -1, 'Possession Receiver': -1 }, RB: { 'Receiving Back': 1 }, TE: { 'Seam Stretcher': 1 }, QB: { 'Gunslinger': 1 } },
      zone:            { WR: { 'Route Runner': 1, 'Route Technician': 1, 'Slot Weapon': 1, 'Deep Threat': -1 }, TE: { 'Seam Stretcher': 1, 'Move TE': 1 }, QB: { 'Field General': 1, 'Gunslinger': -1 } },
      blitz_heavy:     { OL: { 'Pass Protector': 2, 'Road Grader': -1 }, QB: { 'Improviser': 1, 'Scrambler': 1, 'Game Manager': -1 }, RB: { 'Receiving Back': 1 }, WR: { 'Deep Threat': 1 } },
      three_four:      { RB: { 'Elusive Back': 1, 'Power Back': -1 }, OL: { 'Road Grader': 1, 'Technician': 1 }, TE: { 'In-Line': -1 } },
      four_three:      { RB: { 'Workhorse': 1 }, OL: { 'Technician': 1 }, WR: { 'Slot Weapon': 1 } },
      bend_dont_break: { WR: { 'Possession': 1, 'Possession Receiver': 1, 'Deep Threat': -1 }, TE: { 'In-Line': 1 }, RB: { 'Workhorse': 1, 'Power Back': 1 }, QB: { 'Game Manager': 1 } }
    },
    /* their offence, and your defensive men */
    vs_offense: {
      air_raid:   { CB: { 'Coverage': 1, 'Shutdown': 1, 'Zone Specialist': 1, 'Press Specialist': 1 }, S: { 'Ball Hawk': 1, 'Coverage': 1, 'Run Stopper': -1 }, DL: { 'Speed Rusher': 1, 'Edge Rusher': 1, 'Run Stopper': -1 }, LB: { 'Coverage': 1, 'Run Stopper': -1 } },
      spread:     { LB: { 'Hybrid': 1, 'Coverage': 1, 'Run Stopper': -1 }, CB: { 'Zone Specialist': 1, 'Coverage': 1 }, DL: { 'Speed Rusher': 1 }, S: { 'Coverage': 1 } },
      pro_style:  { LB: { 'Hybrid': 1 }, S: { 'Coverage': 1 }, DL: { 'Balanced': 1 } },
      power_run:  { DL: { 'Run Stopper': 2, 'Power Rusher': 1, 'Speed Rusher': -1 }, LB: { 'Run Stopper': 1, 'Coverage': -1 }, S: { 'Run Stopper': 1, 'Ball Hawk': -1 }, CB: { 'Coverage': -1 } },
      option:     { LB: { 'Hybrid': 1, 'Run Stopper': 1 }, DL: { 'Run Stopper': 1, 'Edge Rusher': 1 }, S: { 'Run Stopper': 1 }, CB: { 'Ball Hawk': -1 } },
      west_coast: { CB: { 'Zone Specialist': 1, 'Press Specialist': -1 }, LB: { 'Coverage': 1 }, S: { 'Coverage': 1 }, DL: { 'Power Rusher': 1 } }
    }
  };
  /* THE SCOUTING REPORT: two or three edges and a worry or two for Saturday,
     read off your starters against their schemes — the research a coach does
     on Tuesday, said in a few lines. Pure: the roster, the franchise and the
     opponent in; nothing decided. */
  function scoutingReport(players, franchise, opp) {
    if (!players || !franchise || !opp) return null;
    var rows = [];
    (players || []).forEach(function (p) {
      if (!p || (p.status && p.status !== 'active') || !isStarter(p)) return;
      var m = matchupFit(p, opp), f = fitFor(p, franchise);
      if (!m) return;
      var score = m.value * 2 + (f ? f.value : 0);
      rows.push({ id: p.id, name: fullName(p).trim(), position: p.position, archetype: p.archetype || '', overall: p.overall | 0,
                  matchup: m, scheme: f, score: score });
    });
    rows.sort(function (a, b) { return b.score - a.score || b.overall - a.overall; });
    var edges = rows.filter(function (r) { return r.matchup.value > 0; }).slice(0, 3);
    var worries = rows.filter(function (r) { return r.matchup.value < 0; }).sort(function (a, b) { return a.score - b.score; }).slice(0, 2);
    function line(r) {
      return r.position + ' ' + r.name + ' — ' + (r.archetype || r.position) + ' against ' + schemeWord(r.matchup.against) + (r.matchup.value > 0 ? ': the matchup is his' : ': a long afternoon');
    }
    return {
      opponent: { offense: opp.offense, defense: opp.defense, line: 'They run ' + schemeWord(opp.offense) + ' and play ' + schemeWord(opp.defense) + '.' },
      edges: edges.map(function (r) { return { id: r.id, position: r.position, name: r.name, value: r.matchup.value, text: line(r) }; }),
      worries: worries.map(function (r) { return { id: r.id, position: r.position, name: r.name, value: r.matchup.value, text: line(r) }; }),
      starters: rows.length
    };
  }
  var SCHEME_WORDS = { air_raid: 'an air raid', spread: 'a spread', pro_style: 'a pro-style offence', power_run: 'a power run game', option: 'an option offence', west_coast: 'a West Coast offence',
    four_three: 'a 4-3', three_four: 'a 3-4', press_man: 'press man', zone: 'zone', blitz_heavy: 'a blitz-heavy defence', bend_dont_break: 'a bend-don\'t-break defence' };
  function schemeWord(k) { return SCHEME_WORDS[k] || String(k || '').replace(/_/g, ' '); }
  function matchupFit(man, opp) {
    if (!man || !opp || man.position === 'K' || man.position === 'P') return null;
    var off = !!OFFENSE_POS[man.position];
    var theirs = off ? opp.defense : opp.offense;
    if (!theirs) return null;
    var t = MATCHUP_FIT[off ? 'vs_defense' : 'vs_offense'][theirs];
    var v = t && t[man.position] && man.archetype && t[man.position][man.archetype] != null ? t[man.position][man.archetype] : 0;
    return { value: v, against: theirs, word: (v > 0 ? 'Edge' : v < 0 ? 'Tough day' : 'Even') + ' vs ' + schemeWord(theirs) };
  }
  function fitFor(man, franchise) {
    if (!man || !franchise) return null;
    var side = OFFENSE_POS[man.position] ? 'offense' : 'defense';
    var scheme = side === 'offense' ? franchise.offense : franchise.defense;
    if (!scheme || man.position === 'K' || man.position === 'P') return null;
    var v = schemeFit(side, scheme, man.position, man.archetype);
    return { side: side, scheme: scheme, value: v, word: v >= 2 ? 'Built for your scheme' : v > 0 ? 'Fits your scheme' : v <= -2 ? 'Fights your scheme' : v < 0 ? 'Not your scheme\'s man' : 'Neutral in your scheme' };
  }
  /* the board: every sealed pack with its odds, the one on the table, the men kept */
  function packsBoard() { return rpc('franchise_packs_board', withSecret({})); }
  /* MY PULLS: every pack ever opened, the men as they were pulled, the best of them (Phase 20) */
  var PULLS_VERSION = 'pulls_v1';
  function pulls() { return rpc('franchise_pulls', withSecret({})); }
  /* open one pack by id — the server rolls it, writes it, and only then answers */
  function packOpenId(id) { return once('pack_open_id', String(id || '')).then(moveThen); }
  /* one man, whole: profile, history, career, the pack he came from */
  function card(id) { return rpc('franchise_card', withSecret({ p_player: String(id || '') })); }

  /* ── THE LINEUP, CHEMISTRY AND THE EXCHANGE (Phase 19) ───────────────────
     Mirrors for display; the SQL's franchise_lineup_rules(),
     franchise_chemistry_rules() and franchise_exchange_rules() are what
     apply, and the parity test pins these to them. */
  var LINEUP_VERSION = 'lineup_v1';
  var CHEMISTRY_VERSION = 'chemistry_v1';
  var CHEMISTRY = { per_point: 2, scale: 8, tenure_games: 8, new_games: 3, new_cap: 4,
    core: { line: 2, secondary: 2, passing: 2 }, fit_range: [-2, 2] };
  var EXCHANGE_VERSION = 'exchange_v1';
  var EXCHANGE = { currency: 'tc', fee_pct: 5, min_price: 50, max_price: 50000, max_open: 5, expires_days: 7,
    comps_days: 60, comps_band: 2, comps_shown: 12 };
  /* the fee, exactly as the SQL rounds it: up */
  function exchangeFee(price) { return Math.ceil((+price || 0) * EXCHANGE.fee_pct / 100); }
  /* what chemistry says, in a sentence: the score and the biggest reason */
  function chemistryLine(side) {
    if (!side) return '';
    var s = side.score | 0, why = [];
    if ((side.fit || 0) > 0) why.push('the scheme fits'); else if ((side.fit || 0) < 0) why.push('the scheme fights the men in it');
    if ((side.settled || 0) >= 8) why.push('a settled eleven'); else if ((side.settled || 0) > 0) why.push(side.settled + ' settled');
    if ((side.core || 0) > 0) why.push('whole units grown together');
    if ((side.new || 0) > 0) why.push(side.new + ' still learning the calls');
    if ((side.leaders || 0) > 0) why.push((side.leaders | 0) + ' leader' + (side.leaders === 1 ? '' : 's'));
    return s + (why.length ? ' · ' + why.join(', ') : '');
  }
  function chemistryWord(score) {
    score = score | 0;
    return score >= 85 ? 'Locked in' : score >= 70 ? 'Settled' : score >= 55 ? 'Finding it' : score >= 45 ? 'Neutral' : score >= 30 ? 'Unsettled' : 'At odds';
  }
  function lineupBest() { return rpc('franchise_lineup_best', withSecret({})); }
  function exchangeBrowse(o) {
    o = o || {};
    return rpc('franchise_exchange_browse', withSecret({
      p_position: o.position || null, p_min: o.min == null ? null : (o.min | 0), p_max: o.max == null ? null : (o.max | 0),
      p_sort: o.sort || 'newest', p_query: o.query || null, p_limit: o.limit || 40, p_offset: o.offset || 0 }));
  }
  function exchangeList(playerId, price) { return rpc('franchise_exchange_list', withSecret({ p_player: String(playerId || ''), p_price: price | 0 })); }
  function exchangeWithdraw(listingId) { return rpc('franchise_exchange_withdraw', withSecret({ p_listing: String(listingId || '') })); }
  /* a LISTING ID and nothing else: the price and the balance are the server's */
  /* ── BUYING A CARD, ONCE ─────────────────────────────────────────────────
     A purchase carries an OPERATION KEY: a name for this attempt, made once
     and kept on the device until the server has answered. A connection that
     drops mid-buy is retried with the same key and the server hands back the
     purchase it already made rather than making a second one. Nothing here
     decides whether it worked — `marketOp` asks. */
  var OP_N = 0;
  function opKey(kind, ref) {
    var k = 'ed_op:' + kind + ':' + ref, v = null;
    try { v = localStorage.getItem(k); } catch (_) {}
    if (!v) {
      /* a name for this attempt, from the platform's own id source — never a
         roll: the client decides nothing about the outcome, only what to
         call the question it is asking */
      var uniq = null;
      try { uniq = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : null; } catch (_) {}
      if (!uniq) {
        try {
          var a4 = new Uint8Array(8); root.crypto.getRandomValues(a4);
          uniq = Array.prototype.map.call(a4, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
        } catch (_) { uniq = Date.now().toString(36) + ':' + (OP_N++); }
      }
      v = kind + ':' + ref + ':' + uniq;
      try { localStorage.setItem(k, v); } catch (_) {}
    }
    return v;
  }
  function opDone(kind, ref) { try { localStorage.removeItem('ed_op:' + kind + ':' + ref); } catch (_) {} }

  /* ── THE CONNECTION, SAID OUT LOUD (resume_v1) ─────────────────────────
     Four states and no fifth. A page never decides for itself that something
     worked; it shows what the connection is doing and what the server said.

       synced        the last thing asked was answered
       offline       the request never reached anybody
       reconnecting  it may have landed — we are asking the server what it did
       retry         the server says it did not happen; asking again is safe   */
  var RESUME_VERSION = 'resume_v1';
  var NET = { SYNCED: 'synced', OFFLINE: 'offline', RECONNECTING: 'reconnecting', RETRY: 'retry' };
  var NET_WORDS = { synced: 'Synced', offline: 'Offline', reconnecting: 'Reconnecting…', retry: 'Not sent — try again' };
  var _net = NET.SYNCED, _netFns = [];
  function net() { return _net; }
  function netWord(s) { return NET_WORDS[s || _net] || ''; }
  function onNet(fn) {
    if (typeof fn !== 'function') return function () {};
    _netFns.push(fn);
    return function () { var i = _netFns.indexOf(fn); if (i >= 0) _netFns.splice(i, 1); };
  }
  function setNet(s) {
    if (s === _net) return _net;
    _net = s;
    _netFns.forEach(function (fn) { try { fn(s); } catch (_) {} });
    try { document.dispatchEvent(new CustomEvent('edgames:net', { detail: { state: s } })); } catch (_) {}
    return _net;
  }

  /* ── ONE DOOR, ONCE ────────────────────────────────────────────────────
     Everything that hands out value goes through here. The key is made
     BEFORE the request and kept until the server confirms, so a retry is the
     same operation rather than a new one.

     AND WHEN THE CONNECTION GOES, THE CLIENT DOES NOT GUESS. It asks the
     server what it did with the key. Completed comes back with the original
     result; not completed comes back as something safe to ask again. There
     is no third answer and nothing is ever invented here. */
  function once(kind, ref) {
    var r0 = ref == null ? '-' : String(ref), key = opKey(kind, r0);
    return rpc('franchise_once', withSecret({ p_kind: kind, p_op: key, p_ref: ref == null ? null : String(ref) }))
      .then(function (r) {
        if (r.ok) {
          opDone(kind, r0); setNet(NET.SYNCED);
          var d = r.data || {};
          return { ok: true, data: d.result || null, already: !!d.already, op: key };
        }
        if (r.error !== 'unreachable') { opDone(kind, r0); setNet(NET.SYNCED); return r; }
        setNet(NET.RECONNECTING);
        return rpc('franchise_op', withSecret({ p_op: key })).then(function (o) {
          if (o.ok && o.data && o.data.state === 'completed') {
            opDone(kind, r0); setNet(NET.SYNCED);
            return { ok: true, data: o.data.result || null, already: true, op: key, recovered: true };
          }
          if (o.ok) {
            setNet(NET.RETRY);
            return { ok: false, error: 'not_completed', state: 'not_completed', op: key,
              message: 'That did not reach the server. Nothing was spent — try again.' };
          }
          setNet(NET.OFFLINE);
          return { ok: false, error: 'unreachable', state: 'unknown', op: key,
            message: 'Still offline. Nothing is lost — this finishes when you are back.' };
        });
      });
  }
  /* what the server did with one key, asked directly */
  function opState(kind, ref) {
    return rpc('franchise_op', withSecret({ p_op: opKey(kind, ref == null ? '-' : String(ref)) }));
  }
  /* the pack already sitting on the table, if a reveal was interrupted */
  function packPending() { return rpc('franchise_pack_pending', withSecret({})); }
  function exchangeBuy(listingId) {
    var id = String(listingId || ''), op = opKey('buy', id);
    return rpc('franchise_exchange_buy', withSecret({ p_listing: id, p_op: op })).then(function (r) {
      if (r && r.ok) opDone('buy', id);
      return r;
    }).then(moveThen);
  }
  /* WHAT HAPPENED TO THAT PURCHASE. Never "maybe": completed, or not. */
  function marketOp(listingId) {
    var id = String(listingId || '');
    return rpc('franchise_market_op', withSecret({ p_op: opKey('buy', id) })).then(function (r) {
      if (r && r.ok && r.data && r.data.state === 'completed') opDone('buy', id);
      return r;
    });
  }
  /* one card instance, whole: the athlete, the edition, who has held it and
     where it plays — assembled by the server from the separate tables */
  function cardEntity(cardId) { return rpc('franchise_card_entity', { p_card: String(cardId || '') }); }
  /* how a card came to be in a pair of hands, said in words */
  var CARD_WORDS = { founding_roster: 'Founding roster', offseason_rookie: 'Signed as a rookie', draft: 'Drafted', free_agent: 'Signed in free agency',
                     pack: 'Kept from a pack', market: 'Bought on the Exchange', trade: 'Traded for', migration: 'Minted from the record' };
  function cardsWord(k) { return CARD_WORDS[k] || String(k || '').replace(/_/g, ' '); }
  function cardMarket(cardId) { return rpc('franchise_card_market', { p_card: String(cardId || '') }); }

  /* ── the living season, season_v1 ──────────────────────────────────────
     Three reads, and only reads: the server writes the weekly snapshot when
     a game finishes, so a page cannot ask for a ranking that flatters it.  */
  var SEASON_VERSION = 'season_v1';
  /* the power model, mirrored for display — franchise_season_rules() is what
     applies; this is so a page can print the terms without a round trip */
  var SEASON_RULES = { win_pct: 26, margin_cap: 21, margin: 10, sos: 8, form: 6,
                       quality_win: 3.0, bad_loss: -3.5, home_road: 1.5, unplayed_pull: 0.35 };
  /* the ten races, in the order the server runs them, so a page can lay them
     out before the first one is scored */
  var AWARDS = [
    { key: 'poy',    name: 'Player of the Year' },
    { key: 'opoy',   name: 'Offensive Player of the Year' },
    { key: 'dpoy',   name: 'Defensive Player of the Year' },
    { key: 'qb',     name: 'Quarterback of the Year' },
    { key: 'rb',     name: 'Back of the Year' },
    { key: 'wr',     name: 'Receiver of the Year' },
    { key: 'rush',   name: 'Pass Rusher of the Year' },
    { key: 'db',     name: 'Defensive Back of the Year' },
    { key: 'rook',   name: 'Rookie of the Year' },
    { key: 'clutch', name: 'Clutch Player of the Year' }
  ];
  function rankings() { return rpc('franchise_rankings', withSecret({})); }
  function awards() { return rpc('franchise_awards', withSecret({})); }
  function championship() { return rpc('franchise_championship', withSecret({})); }
  /* a movement, said the way a broadcast says it */
  function moveWord(n) {
    if (n == null) return 'new';
    if (n > 0) return 'up ' + n;
    if (n < 0) return 'down ' + (-n);
    return 'even';
  }
  function exchangeComps(position, overall) { return rpc('franchise_exchange_comps', { p_position: String(position || ''), p_overall: overall | 0 }); }
  function exchangeHistory(limit) { return rpc('franchise_exchange_history', withSecret({ p_limit: limit || 20 })); }

  function ranks() { return rpc('franchise_rank_board', withSecret({})); }
  function packOpen() { return once('pack_open').then(moveThen); }
  function packKeep(player) {
    return once('pack_keep', String(player || '')).then(moveThen);
  }
  /* turn the whole pack down. The rank is spent either way — that is what
     makes it a decision — but a pack must never be able to block the rest. */
  function packPass() { return rpc('franchise_pack_pass', withSecret({})).then(moveThen); }

  /* THE DRIVES YOU CALL (Phase 13). Opening resolves nothing: it says how
     many possessions the game holds, what the four calls do, and every drive
     already played. Calling sends a CALL and never a result — the server
     re-runs its own seeded simulator over the calls made so far, so every
     drive already played comes back identical and the new one is added, and
     a replayed request cannot change a drive that has already happened.
     The last call comes back with the finished game, the same shape quick
     play returns. Never queued: a possession must see its answer. */
  function gameOpen() { return rpc('franchise_game_open', withSecret({})); }
  function gameCall(call) {
    return rpc('franchise_game_call', withSecret({ p_call: String(call || '') })).then(function (r) {
      /* a finished game is a move like any other — the rewards, the standing
         and the achievements land through the same door quick play uses */
      return obj(r).complete ? moveThen(r) : r;
    });
  }

  /* KEY MOMENTS (Phase 14). Playing a decided game out is quick play for the
     possessions that are left — the server calls the published default for
     each and finishes through the same door. The reel is a read: the moments
     this franchise actually played, derived from the boxes already stored. */
  function gameFinish() {
    return rpc('franchise_game_finish', withSecret({})).then(moveThen);
  }
  function reel(limit) {
    return rpc('franchise_reel', withSecret({ p_limit: Math.max(1, Math.min(100, limit | 0 || 20)) }));
  }

  function development() { return rpc('franchise_development_board', withSecret({})); }
  function develop(player) {
    return rpc('franchise_develop', withSecret({ p_player: String(player || '') })).then(moveThen);
  }

  function staff() { return rpc('franchise_staff_board', withSecret({})); }
  function staffHire(seat) {
    return rpc('franchise_staff_hire', withSecret({ p_seat: String(seat || '') })).then(moveThen);
  }
  function staffPromote(seat, levels) {
    return rpc('franchise_staff_promote', withSecret({ p_seat: String(seat || ''), p_levels: levels | 0 })).then(moveThen);
  }
  function staffFire(seat) { return rpc('franchise_staff_fire', withSecret({ p_seat: String(seat || '') })); }

  /* WHAT THIS DATABASE HAS. Open to anon, and safe to call before anything
     else: it names phases and dates and nothing about anybody. */
  function schema() { return rpc('games_schema', {}); }
  /* WHAT IS MISSING between what is installed and what this build wants.
     Every gap carries the FILE to paste and the NAME of each phase it is
     short, because "franchise 5" is not an instruction and "the draft and
     the market — paste supabase/games_franchise.sql" is. */
  function schemaGap(found) {
    found = obj(found);
    var out = [];
    ['social', 'franchise'].forEach(function (k) {
      var have = found[k] | 0, want = SCHEMA[k] | 0;
      if (have < want) {
        out.push({ layer: k, have: have, want: want, behind: want - have,
          file: SCHEMA_FILES[k],
          /* phases have + 1 .. want, named; the list is 0-indexed */
          missing: SCHEMA_PHASES[k].slice(have, want).map(function (name, i) {
            return { phase: have + 1 + i, name: name };
          }) });
      }
    });
    return { ok: out.length === 0, behind: out,
      /* an old build against a NEWER database is fine and worth not crying about */
      ahead: (found.franchise | 0) > SCHEMA.franchise || (found.social | 0) > SCHEMA.social };
  }

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
  /* WHEN A FAILED CALL IS WORTH KEEPING. The queue is for a call the server
     never ANSWERED. It is not a place to keep one the server has refused.

     No status at all means the request never arrived — offline, timed out,
     or this build has no endpoint configured. A 5xx means it arrived and the
     server broke. A 404 means the layer is not deployed yet, and one day it
     will be. All three are worth replaying.

     Anything else is the server having read THIS call and said no, and the
     same payload cannot get a different answer on the next boot. Keeping it
     would jam the queue for the life of the account: measured before this
     was written, a drill run offline and reconnected two days later — past
     the day window a drill is honest inside — was retried on every boot for
     ever, and the office read "1 reward waiting to sync" for ever with it. */
  function retryable(r) {
    if (!r.status) return true;
    return r.status >= 500 || r.status === 404;
  }
  function queued(key) {
    if (!ST) return false;
    return ST.franchiseQueue().some(function (q) { return q.key === key; });
  }
  function record(fn, args, key) {
    if (!hasFranchise()) return Promise.resolve({ ok: false, error: 'no_franchise', skipped: true });
    return rpc(fn, withSecret(args)).then(function (r) {
      if (r.ok) {
        if (ST) ST.dequeueFranchise(key);
        if (r.data && r.data.totals) touchTotals(r.data.totals);
        return r;
      }
      if (retryable(r)) {
        if (ST) ST.queueFranchise({ key: key, fn: fn, args: args });
        return { ok: false, queued: true, error: r.error, message: r.message };
      }
      var was = queued(key);
      if (ST) ST.dequeueFranchise(key);
      return { ok: false, dropped: was, error: r.error, message: r.message };
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
  /* THE GAME YOU HOLD, filed (Phase 21). The key is the game's own — its
     seed and the moment it started — so a replayed request credits nothing
     twice and a game resumed from its save still files as itself. The server
     checks the shape, credits by its table, and says what moved. */
  function recordLiveGame(key, game) {
    return record('franchise_record_live_game', { p_key: String(key || ''), p_game: game || {} }, 'live:' + key);
  }

  /* Replay whatever the server has not confirmed. Sequential, so a burst of
     replays cannot race each other; each one dequeues itself on success. */
  function sync() {
    if (!hasFranchise() || !ST) return Promise.resolve({ replayed: 0, dropped: 0 });
    var q = ST.franchiseQueue(), i = 0, done = 0, gone = 0;
    function step() {
      if (i >= q.length) return Promise.resolve({ replayed: done, dropped: gone });
      var item = q[i++];
      return record(item.fn, item.args, item.key).then(function (r) {
        if (r.ok) done++; else if (r.dropped) gone++;
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
        return sync().then(function (s) { return { state: state(), home: h, synced: s.replayed, dropped: s.dropped, claimed: h !== r }; });
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
    runProfile: runProfile,
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
    SCHEMA: SCHEMA, SCHEMA_PHASES: SCHEMA_PHASES, SCHEMA_FILES: SCHEMA_FILES,
    schema: schema, schemaGap: schemaGap,
    development: development, develop: develop,
    RANK_VERSION: RANK_VERSION, RANKS: RANKS,
    rankCost: rankCost, rankAt: rankAt, rankFor: rankFor, rankEdge: rankEdge,
    packBand: packBand, rankWeight: rankWeight, rankLine: rankLine,
    ranks: ranks, packOpen: packOpen, packKeep: packKeep, packPass: packPass,
    badges: badges, careerTotals: careerTotals, handsLine: handsLine, evolutionReason: evolutionReason, BADGES: BADGES,
    MATCHUP_FIT: MATCHUP_FIT, matchupFit: matchupFit, schemeWord: schemeWord, scoutingReport: scoutingReport,
    PACKS_VERSION: PACKS_VERSION, PACKS: PACKS, packDef: packDef, PASS_SP: PASS_SP, passValue: passValue, SCHEME_FIT: SCHEME_FIT, schemeFit: schemeFit, fitFor: fitFor, packsBoard: packsBoard, pulls: pulls, PULLS_VERSION: PULLS_VERSION, packOpenId: packOpenId, card: card,
    LINEUP_VERSION: LINEUP_VERSION, CHEMISTRY_VERSION: CHEMISTRY_VERSION, CHEMISTRY: CHEMISTRY, chemistryLine: chemistryLine, chemistryWord: chemistryWord,
    lineupBest: lineupBest,
    EXCHANGE_VERSION: EXCHANGE_VERSION, EXCHANGE: EXCHANGE, exchangeFee: exchangeFee,
    exchangeBrowse: exchangeBrowse, exchangeList: exchangeList, exchangeWithdraw: exchangeWithdraw, exchangeBuy: exchangeBuy,
    exchangeComps: exchangeComps, exchangeHistory: exchangeHistory,
    marketOp: marketOp, cardEntity: cardEntity, cardMarket: cardMarket, opKey: opKey, opDone: opDone, cardsWord: cardsWord, CARD_WORDS: CARD_WORDS,
    CARDS_VERSION: CARDS_VERSION,
    rankings: rankings, awards: awards, championship: championship,
    once: once, opState: opState, packPending: packPending,
    net: net, onNet: onNet, netWord: netWord, NET: NET, RESUME_VERSION: RESUME_VERSION,
    AWARDS: AWARDS, SEASON_VERSION: SEASON_VERSION, SEASON_RULES: SEASON_RULES, moveWord: moveWord,
    DEVELOPMENT_VERSION: DEVELOPMENT_VERSION, DEVELOPMENT: DEVELOPMENT,
    devCost: devCost, devLift: devLift, devSlots: devSlots, devGradeLine: devGradeLine,
    LEAGUE_VERSION: LEAGUE_VERSION, LEAGUE: LEAGUE, leagueFacing: leagueFacing, leagueGap: leagueGap,
    standingDelta: standingDelta, standingName: standingName,
    SCOUTING_VERSION: SCOUTING_VERSION, SCOUTING: SCOUTING, scoutGradeOf: scoutGradeOf, scoutNext: scoutNext,
    scoutBand: scoutBand, scoutCost: scoutCost, scoutLift: scoutLift, scoutScore: scoutScore, scoutLine: scoutLine,
    CAREER_VERSION: CAREER_VERSION, CAREER: CAREER,
    SNAP_VERSION: SNAP_VERSION, SNAPS: SNAPS, snapCall: snapCall, snapLine: snapLine,
    MOMENT_VERSION: MOMENT_VERSION, MOMENTS: MOMENTS, stake: stake, isKey: isKey,
    CLOCK_VERSION: CLOCK_VERSION, CLOCK: CLOCK, clockLine: clockLine, driveSeconds: driveSeconds,
    PLAYBOOK_VERSION: PLAYBOOK_VERSION, FORMATIONS: FORMATIONS, PLAYS: PLAYS,
    playbookSets: playbookSets, playbook: playbook, play: play, formation: formation,
    playAllowed: playAllowed, tellLine: tellLine, playLine: playLine,
    DEFENSE_VERSION: DEFENSE_VERSION, FRONTS: FRONTS, frontCall: frontCall,
    callSide: callSide, callsFor: callsFor,
    stakeLine: stakeLine, momentLine: momentLine, gameFinish: gameFinish, reel: reel,
    driveLine: driveLine, gameOpen: gameOpen, gameCall: gameCall,
    rankCoachPoints: rankCoachPoints, staffHireLevel: staffHireLevel,
    STAFF_VERSION: STAFF_VERSION, STAFF: STAFF, staffCost: staffCost, staffCostBetween: staffCostBetween,
    staffAfford: staffAfford, staffEffect: staffEffect, staffGrade: staffGrade,
    staffSpecialtyCount: staffSpecialtyCount, staffSeat: staffSeat, staffLine: staffLine,
    staffProgress: staffProgress,
    staff: staff, staffHire: staffHire, staffPromote: staffPromote, staffFire: staffFire,
    conference: conference, conferenceCreate: conferenceCreate, conferencePeek: conferencePeek,
    conferenceJoin: conferenceJoin, conferenceLeave: conferenceLeave, conferenceStart: conferenceStart,
    conferenceAdvance: conferenceAdvance, conferenceGame: conferenceGame,
    spForScore: spForScore, tcForScore: tcForScore, tcForDrill: tcForDrill, rewardsFor: rewardsFor,
    xpForLevel: xpForLevel, levelFor: levelFor, levelInfo: levelInfo,
    fullName: fullName, keyRatings: keyRatings, isStarter: isStarter, traitOf: traitOf,
    profileOf: profileOf, tierOf: tierOf, potentialTierOf: potentialTierOf, potentialWord: potentialWord,
    hometownOf: hometownOf, bodyOf: bodyOf, universalRatings: universalRatings, specificRatings: specificRatings,
    PROFILE_VERSION: PR ? PR.VERSION : null, TIERS: PR ? PR.TIERS : [],
    careerLine: careerLine, acquiredLine: acquiredLine, playerCard: playerCard, groups: groups,
    weakest: weakest, strongest: strongest, logoSvg: logoSvg, themeVars: themeVars, identity: identity,
    prep: prep, preview: preview, historyPayload: historyPayload, esc: esc, fmt: fmt,
    deployed: deployed, user: user, signedIn: signedIn, secret: secret, snapshot: snapshot, hasFranchise: hasFranchise,
    owner: owner, state: state, claim: claim,
    home: home, roster: roster, ledger: ledger, pick5Mine: pick5Mine, create: create, importHistory: importHistory,
    setStarter: setStarter, record: record, recordPriceIt: recordPriceIt, submitPick5: submitPick5,
    recordDrill: recordDrill, recordResearch: recordResearch, recordLiveGame: recordLiveGame, liveRewards: liveRewards, liveLine: liveLine,
    sync: sync, boot: boot, forget: forget
  };
  root.EDFranchise = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
