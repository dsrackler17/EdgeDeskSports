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
    perfect_season: { name: 'Perfect Season' }
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
  function acquiredLine(p) {
    if (!p) return '';
    var src = p.acquired_source === 'founding_roster' ? 'Founder roster' : String(p.acquired_source || '').replace(/_/g, ' ');
    return src + (p.acquired_season ? ' · ' + p.acquired_season : '') + (p.acquired_detail && p.acquired_detail !== src ? ' · ' + p.acquired_detail : '');
  }

  /* THE PLAYER CARD. A pure function of a row: collectible, readable on a
     phone, and consistent with its own numbers (the overall is the mean of
     the four attributes shown). */
  function playerCard(p, o) {
    o = o || {};
    if (!p) return '';
    var rar = RARITY[p.rarity] || RARITY.common, tr = traitOf(p), starter = isStarter(p);
    var attrs = keyRatings(p).map(function (a) {
      return '<div class="pc-a"><span class="k">' + esc(a.label) + '</span><b>' + (a.value == null ? '—' : a.value) + '</b></div>';
    }).join('');
    return '<article class="pc pc-' + esc(rar.key) + (starter ? ' pc-start' : '') + (o.compact ? ' pc-compact' : '')
      + '" data-player="' + esc(p.id) + '" data-position="' + esc(p.position) + '" data-depth="' + (p.depth | 0) + '">'
      + '<div class="pc-top"><span class="pc-num mono">#' + (p.jersey == null ? '—' : p.jersey) + '</span>'
      + '<span class="pc-pos">' + esc(p.position) + '</span>'
      + '<span class="pc-rar">' + esc(rar.label) + '</span>'
      + (starter ? '<span class="pc-st">' + (STARTERS[p.position] > 1 ? esc(p.position) + (p.depth | 0) : 'Starter') + '</span>' : '')
      + '</div>'
      + '<div class="pc-name">' + esc(fullName(p)) + '</div>'
      + '<div class="pc-arch">' + esc(p.position) + ' <span class="sep">|</span> ' + esc(p.archetype || '') + '</div>'
      + '<div class="pc-ovr"><b class="mono">' + (p.overall | 0) + '</b><span>OVR</span></div>'
      + '<div class="pc-attrs">' + attrs + '</div>'
      + (tr ? '<div class="pc-trait"><span class="k">Trait</span><b>' + esc(tr.name) + '</b><span class="d">' + esc(tr.desc || '') + '</span></div>'
            : '<div class="pc-trait none"><span class="k">Trait</span><span class="d">None yet</span></div>')
      + '<div class="pc-meta">Age ' + (p.age | 0) + ' <span class="sep">·</span> POT ' + (p.potential | 0)
      + ' <span class="sep">·</span> ' + esc(DEV_TIERS[p.dev_tier] || p.dev_tier || '') + '</div>'
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
    return { phase: open ? 'ready' : 'waiting', game: ng, season: ss, opens: o };
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

  /* ── the anonymous envelope: what it would be worth, and its payload ──── */
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
