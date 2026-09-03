#!/usr/bin/env node
/* ===========================================================================
   Tests for FULL PICTURE — players to market price — as WIRED INTO app.html.

   The EDPIC block is cut out of app.html between its markers and run in a
   sandbox with stubbed globals (signal rows, the engine, the stat tables,
   the roster feeds). Under test: key players come from the stored stat
   leaders with the stored stat line as the reason; feeds give starters and
   rooms with their real status; a team the tables cannot match is reported;
   every priced side of every market is listed with its own price, fair,
   edge and verdict; the focal edge is marked; per-book quotes render; and
   the receipt carries the host and the buttons.

   Run: node tools/presentation/app_picture.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
function slice(a, b, label) { const i = APP.indexOf(a), j = APP.indexOf(b, i); if (i < 0 || j < 0) throw new Error('app.html no longer contains ' + label); return APP.slice(i, j + b.length); }
const block = slice('/*__EDPIC_START__*/', '/*__EDPIC_END__*/', 'the EDPIC block');

/* ---- wiring --------------------------------------------------------------- */
chk('the block sits after the card block and before the fabric', APP.indexOf('/*__EDCARD_END__*/') < APP.indexOf('/*__EDPIC_START__*/') && APP.indexOf('/*__EDPIC_END__*/') < APP.indexOf('/*__EDINT_MODULE_START__*/'));
chk('the receipt carries the picture host between the card and the full research', /var pic='<div class="rcpt-pic" id="'\+domid\+'_pic"><\/div>';\s*return card\?\(card\+pic\+'<div class="rcpt-full"/.test(APP));
chk('the strip and the receipt card offer Full picture', /label:'Full picture', onclick:"event\.stopPropagation\(\);EDPIC\.open\('"\+jsAttr\(domid\)\+"',true\)"/.test(APP) && /label:'Full picture', onclick:"event\.stopPropagation\(\);EDPIC\.open\('"\+jsAttr\(domid\)\+"'\)"/.test(APP));
chk('the picture CSS exists and collapses to one column on phones', /\.pic-teams\{display:grid;grid-template-columns:1fr 1fr/.test(APP) && /@media\(max-width:560px\)\{\.pic-teams\{grid-template-columns:1fr\}/.test(APP) && /\.pic-tblwrap\{overflow-x:auto/.test(APP));

/* ---- sandbox --------------------------------------------------------------- */
const rows = [
  { event_id: 'ev1', sport_key: 'americanfootball_nfl', market: 'spreads', selection: 'Chiefs', point: 3.5, home_team: 'Ravens', away_team: 'Chiefs', best_dec: 1.909, best_book: 'DraftKings', first_best_dec: 1.87, sharp_fair: 0.5556, consensus_fair: 0.55, edge: 0.031, n_books: 6, last_seen_at: new Date(Date.now() - 5 * 60000).toISOString(), commence_time: '2026-09-11T00:15:00Z' },
  { event_id: 'ev1', sport_key: 'americanfootball_nfl', market: 'spreads', selection: 'Ravens', point: -3.5, home_team: 'Ravens', away_team: 'Chiefs', best_dec: 1.87, best_book: 'FanDuel', first_best_dec: 1.909, sharp_fair: 0.4444, edge: -0.02, n_books: 6, last_seen_at: new Date().toISOString(), commence_time: '2026-09-11T00:15:00Z' },
  { event_id: 'ev1', sport_key: 'americanfootball_nfl', market: 'totals', selection: 'Over', point: 47.5, home_team: 'Ravens', away_team: 'Chiefs', best_dec: 1.95, best_book: 'BetMGM', first_best_dec: 1.95, sharp_fair: 0.50, edge: -0.025, n_books: 5, commence_time: '2026-09-11T00:15:00Z' },
  { event_id: 'ev1', sport_key: 'americanfootball_nfl', market: 'h2h', selection: 'Chiefs', point: null, home_team: 'Ravens', away_team: 'Chiefs', best_dec: 2.45, best_book: 'Bovada', first_best_dec: 2.3, consensus_fair: 0.42, edge: 0.029, n_books: 4, commence_time: '2026-09-11T00:15:00Z' },
  { event_id: 'ev2', sport_key: 'americanfootball_nfl', market: 'h2h', selection: 'Bills', point: null, home_team: 'Bills', away_team: 'Jets', best_dec: 1.5, best_book: 'DraftKings', sharp_fair: 0.7, edge: 0.05, n_books: 6, commence_time: '2026-09-08T00:15:00Z' },
];
const stats = [
  { league: 'NFL', team: 'Kansas City Chiefs', player: 'Patrick Mahomes', position: 'QB', stat_line: '2,431 yds · 19 TD', lead_cat: 'passing', lead_val: 2431, leads: { passing: 2431 } },
  { league: 'NFL', team: 'Kansas City Chiefs', player: 'Isiah Pacheco', position: 'RB', stat_line: '612 yds · 5 TD', lead_cat: 'rushing', lead_val: 612, leads: { rushing: 612 } },
  { league: 'NFL', team: 'Kansas City Chiefs', player: 'Travis Kelce', position: 'TE', stat_line: '701 yds · 6 TD', lead_cat: 'receiving', lead_val: 701, leads: { receiving: 701 } },
  { league: 'NFL', team: 'Kansas City Chiefs', player: 'Rashee Rice', position: 'WR', stat_line: '640 yds · 4 TD', lead_cat: null, lead_val: 640, leads: { receiving: 640 } },
  { league: 'NFL', team: 'Kansas City Chiefs', player: 'Nick Bolton', position: 'LB', stat_line: '88 tackles', lead_cat: 'tackles', lead_val: 88, leads: { tackles: 88 } },
  { league: 'NFL', team: 'Baltimore Ravens', player: 'Lamar Jackson', position: 'QB', stat_line: '2,102 yds · 17 TD', lead_cat: 'passing', lead_val: 2102, leads: { passing: 2102, rushing: 410 } },
  { league: 'NFL', team: 'Baltimore Ravens', player: 'Derrick Henry', position: 'RB', stat_line: '890 yds · 9 TD', lead_cat: 'rushing', lead_val: 890, leads: { rushing: 890 } },
];
function sandbox(over) {
  over = over || {};
  const win = { EDPRES: P, EDGES: over.rows || rows, RCPT: {} };
  win.window = win;
  const calls = [];
  const ctx = {
    window: win, document: { getElementById: function (id) { return (over.dom || {})[id] || null; } }, console, Date, JSON, Math, Object, Array, String, Number, RegExp, Promise, encodeURIComponent, setTimeout,
    sbGet: async function (q) { calls.push(q); if (over.sbGet) return over.sbGet(q); return []; },
    fetch: async function (url) { calls.push('fetch ' + url); if (over.fetch) return over.fetch(url); return { ok: false, status: 404 }; },
    EDAI: { evidence: function (r) { return over.evidence ? over.evidence(r) : { dverdict: r.edge > 0.03 ? 'BET' : r.edge > 0 ? 'LEAN' : 'PASS', toPlayAm: r.edge > 0 ? -118 : null }; } },
    isTrusted: function (b) { return !/bovada/i.test(b || ''); },
    selLabel: function (r) { return r.market === 'totals' ? r.selection + ' ' + r.point : r.market === 'spreads' ? r.selection + ' ' + (r.point > 0 ? '+' : '') + r.point : r.selection + ' ML'; },
    mktLabel: function (m) { return m === 'h2h' ? 'ML' : m === 'spreads' ? 'Spread' : 'Total'; },
    whenLabel: function () { return 'Thu, Sep 10, 8:15 PM'; }, ago: function () { return '5m ago'; },
    mlbLookup: over.mlbLookup, fbEspnData: over.fbEspnData, fbNflTeamCode: over.fbNflTeamCode, fbGameQbContext: over.fbGameQbContext, fbQbFreshLabel: function () { return 'QB rosters · nflverse'; },
    FB: over.FB, FB_NFL_NAMES: over.FB_NFL_NAMES, EDCfbP4: over.EDCfbP4,
  };
  ctx.globalThis = ctx; ctx.win = win;
  ['EDAI', 'FB', 'EDCfbP4'].forEach(k => { if (ctx[k]) win[k] = ctx[k]; });
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return { E: win.EDPIC, calls, win, ctx };
}
const focal = rows[0];

/* ---- key players ------------------------------------------------------------ */
{
  const { E } = sandbox();
  const ix = E.teamIndex(stats);
  chk('the board name resolves to the stored team by prefix', E.resolveTeam(ix, 'Kansas City Chiefs').team === 'Kansas City Chiefs' && E.resolveTeam(ix, 'Baltimore Ravens').team === 'Baltimore Ravens');
  chk('a team the tables do not carry resolves to nothing, never to a neighbour', E.resolveTeam(ix, 'Buffalo Bills') === null);
  chk('a short code cannot prefix-match its way into a team', E.resolveTeam(ix, 'KC') === null);
  chk('a mascot-only board name matches the one stored team that ends with it', E.resolveTeam(ix, 'Chiefs').team === 'Kansas City Chiefs');
  chk('an ambiguous suffix is a null, never a guess', E.resolveTeam(E.teamIndex([{ team: 'Miami (OH) RedHawks' }, { team: 'Miami Hurricanes' }, { team: 'Ohio State' }]), 'Miami') === null);
  const kc = E.keyPlayers(E.resolveTeam(ix, 'Kansas City Chiefs').rows, 'NFL', 4);
  chk('key players are the category leaders in priority order: passing, rushing, receiving, tackles', kc.map(k => k.player).join('|') === 'Patrick Mahomes|Isiah Pacheco|Travis Kelce|Nick Bolton', kc.map(k => k.player));
  chk('the reason is the stored category and stat line, nothing invented', kc[0].why === 'Team leader in passing yards (2,431) · 2,431 yds · 19 TD', kc[0].why);
  chk('the receiving leader is the higher value, not the first row', kc[2].player === 'Travis Kelce');
  const bal = E.keyPlayers(E.resolveTeam(ix, 'Baltimore Ravens').rows, 'NFL', 4);
  chk('a player is listed once even when he leads two categories', bal.length === 2 && bal[0].player === 'Lamar Jackson' && bal[1].player === 'Derrick Henry', bal.map(k => k.player));
  chk('no rows, no players', E.keyPlayers([], 'NFL', 4).length === 0);
  chk('ERA and WHIP leaders are the LOWEST values', (function () { const r = [{ player: 'A', leads: { era: 3.9 } }, { player: 'B', leads: { era: 2.4 } }]; return E.keyPlayers(r, 'MLB', 4)[0].player === 'B'; })());
  chk('a thin-table row with only a stat line still lists, honestly labelled', /On the stat sheet · 12 pts/.test(E.keyPlayers([{ player: 'X', stat_line: '12 pts', rank: 1 }], 'NBA', 4)[0].why));
  chk('the league comes from the sport key and unknown sports get none', E.leagueOf({ sport_key: 'americanfootball_ncaaf' }) === 'CFB' && E.leagueOf({ sport_key: 'baseball_mlb' }) === 'MLB' && E.leagueOf({ sport_key: 'soccer_epl' }) === null);
}

/* ---- the team block ---------------------------------------------------------- */
{
  const { E } = sandbox();
  const st = { rows: stats, index: E.teamIndex(stats) };
  const away = E.teamBlock(focal, 'NFL', 'away', st, null);
  chk('the away block names the team, marks it as the pick and lists its leaders with reasons', /pic-team pick/.test(away) && /Chiefs<span class="pic-side">away · the pick/.test(away) && /Patrick Mahomes/.test(away) && /Team leader in passing yards \(2,431\)/.test(away));
  chk('the block cites its source and row count', /stats_players · 5 rows/.test(away));
  const missing = E.teamBlock({ event_id: 'ev2', sport_key: 'americanfootball_nfl', home_team: 'Buffalo Bills', away_team: 'New York Jets', selection: 'Bills' }, 'NFL', 'home', st, null);
  chk('a team the tables cannot match says so and fills nothing', /No NFL stat rows matched “Buffalo Bills” in stats_players\. Nothing is filled in\./.test(missing) && !/pic-players/.test(missing), missing);
  const empty = E.teamBlock(focal, 'NFL', 'home', { rows: [], index: {} }, null);
  chk('an empty table names the table and the job', /stats_players is empty\. Run capture_stats/.test(empty));
  const err = E.teamBlock(focal, 'NFL', 'home', { rows: [], index: {}, error: 'HTTP 500' }, null);
  chk('an unreachable table is an outage, not an empty roster', /Player tables unreachable \(HTTP 500\)/.test(err));
  const props = { patrickmahomes: [{ market: 'passing_yards', line: 275.5, proj: 288.2, p_over: 61 }] };
  chk('a prop projection rides with its player, labelled MODEL', /passing yards o275\.5 · proj 288\.2 · 61% over <span class="unproven">MODEL<\/span>/.test(E.teamBlock(focal, 'NFL', 'away', st, props)));
  chk('a title cannot inject markup', E.teamBlock({ home_team: '<img src=x>', away_team: 'A' }, 'NFL', 'home', st, null).indexOf('<img') < 0);
}

/* ---- starters from the feeds --------------------------------------------------- */
{
  const FB = { nfl: { qbs: [{ name: 'Patrick Mahomes', team: 'KC' }], qbsByTeam: { KC: [{ name: 'Patrick Mahomes', team: 'KC' }, { name: 'Carson Wentz', team: 'KC' }], BAL: [{ name: 'Lamar Jackson', team: 'BAL' }] }, up: [{ g: { home_team: 'BAL', away_team: 'KC', home_qb_id: '00-1', away_qb_id: null } }] } };
  const sb = sandbox({ FB, fbNflTeamCode: function (t) { return { 'Kansas City Chiefs': 'KC', 'Baltimore Ravens': 'BAL', KC: 'KC', BAL: 'BAL' }[t] || null; }, FB_NFL_NAMES: {},
    fbGameQbContext: function () { return { home: { starter: { name: 'Lamar Jackson' }, learned: { n: 12, v: 0.08 }, room: [] }, away: { starter: null, room: FB.nfl.qbsByTeam.KC } }; } });
  const e = { event_id: 'ev1', sport_key: 'americanfootball_nfl', home_team: 'Baltimore Ravens', away_team: 'Kansas City Chiefs', selection: 'Kansas City Chiefs' };
  const home = sb.E.teamBlock(e, 'NFL', 'home', { rows: [], index: {} }, null);
  chk('a confirmed NFL starter is named with the schedule feed and the learned QB value as the reason', /Lamar Jackson.*STARTER/.test(home) && /confirmed by the schedule feed · EdgeDesk’s QB layer rates him above league-average passing over 12 learned starts/.test(home), home);
  const away = sb.E.teamBlock(e, 'NFL', 'away', { rows: [], index: {} }, null);
  chk('an unconfirmed side shows the active room and says the starter is unconfirmed', /Patrick Mahomes \/ Carson Wentz/.test(away) && /UNCONFIRMED/.test(away) && /starter not yet confirmed/.test(away), away);
  chk('the QB feed label is cited', /QB rosters · nflverse/.test(home));

  const mlb = sandbox({ mlbLookup: function () { return { home_pitcher_name: 'Tarik Skubal', home_pitcher_throws: 'L', away_pitcher_name: null, home_record: '61-40', away_record: '50-51' }; } });
  const me = { event_id: 'm1', sport_key: 'baseball_mlb', home_team: 'Detroit Tigers', away_team: 'Kansas City Royals', selection: 'Detroit Tigers' };
  const mh = mlb.E.teamBlock(me, 'MLB', 'home', { rows: [], index: {} }, null);
  const ma = mlb.E.teamBlock(me, 'MLB', 'away', { rows: [], index: {} }, null);
  chk('a probable pitcher is named as probable, never confirmed', /Tarik Skubal.*SP \(LHP\).*PROBABLE/.test(mh) && /probable, not confirmed/.test(mh), mh);
  chk('a missing probable is said, not filled', /Starter not posted/.test(ma) && /MISSING/.test(ma));
  chk('the MLB card record rides along', /MLB game card · 61-40/.test(mh));

  /* CFB: the repo's own ESPN roster file, matched on the mascot-suffixed board name. */
  const ROSTER_FILE = { schema: 'edgedesk_fbs_rosters_v2', requested_season: 2026, retrieved_at: '2026-09-01T00:00:00Z', teams: [
    { display_name: 'Ohio Bobcats', location: 'Ohio', nickname: 'Bobcats', abbreviation: 'OHIO', players: [
      { name: 'Nick Poulos', position: 'QB', class: 'Senior', jersey: '10', previous_school: '' }, { name: 'Matt Vezza', position: 'QB', class: 'Junior', jersey: '4', previous_school: 'Youngstown State' },
      { name: 'Hype Grand', position: 'QB', class: 'Freshman', jersey: '18', previous_school: '' }, { name: 'Levi Davis', position: 'QB', class: 'Freshman', jersey: '15', previous_school: '' }, { name: 'Big Guy', position: 'OL', class: 'Senior' } ] },
    { display_name: 'Ohio State Buckeyes', location: 'Ohio State', nickname: 'Buckeyes', abbreviation: 'OSU', players: [{ name: 'Julian Sayin', position: 'QB', class: 'Sophomore', jersey: '10' }] },
    { display_name: 'Nebraska Cornhuskers', location: 'Nebraska', nickname: 'Cornhuskers', abbreviation: 'NEB', players: [{ name: 'Dylan Raiola', position: 'QB', class: 'Sophomore', jersey: '15' }, { name: 'TJ Lateef', position: 'QB', class: 'Freshman', jersey: '9' }] },
    { display_name: 'Miami Hurricanes', location: 'Miami', nickname: 'Hurricanes', abbreviation: 'MIA', players: [{ name: 'Carson Beck', position: 'QB', class: 'Senior' }] },
    { display_name: 'Miami (OH) RedHawks', location: 'Miami (OH)', nickname: 'RedHawks', abbreviation: 'M-OH', players: [{ name: 'Dequan Finn', position: 'QB', class: 'Senior' }] },
    { display_name: 'Kicker U', location: 'Kicker U', nickname: 'K', abbreviation: 'KU', players: [{ name: 'Only Kicker', position: 'PK', class: 'Senior' }] },
  ] };
  const cfb = sandbox({ fetch: async function (url) { return /fbs_2026_espn\.json/.test(url) ? { ok: true, json: async function () { return ROSTER_FILE; } } : { ok: false, status: 404 }; } });
  const ce = { event_id: 'c1', sport_key: 'americanfootball_ncaaf', home_team: 'Nebraska Cornhuskers', away_team: 'Ohio Bobcats', selection: 'Ohio Bobcats', market: 'h2h' };
  chk('before the roster file loads the CFB side is simply absent, not wrong', cfb.E.rosterTeam('Ohio Bobcats') === null);
  cfb.E.loadRoster().then(function (R) {
    chk('the roster file loads from the repo path for the current season', R.season === 2026 && R.teams === 6 && cfb.calls.some(c => /^fetch football\/rosters\/fbs_2026_espn\.json/.test(c)), R);
    chk('a mascot-suffixed board name joins the roster on display_name', cfb.E.rosterTeam('Ohio Bobcats').location === 'Ohio' && cfb.E.rosterTeam('Nebraska Cornhuskers').location === 'Nebraska');
    chk('Ohio does not swallow Ohio State, and the school alone still matches', cfb.E.rosterTeam('Ohio State Buckeyes').location === 'Ohio State' && cfb.E.rosterTeam('Ohio State').location === 'Ohio State' && cfb.E.rosterTeam('Ohio').location === 'Ohio');
    chk('the two Miamis stay apart', cfb.E.rosterTeam('Miami Hurricanes').location === 'Miami' && cfb.E.rosterTeam('Miami (OH) RedHawks').location === 'Miami (OH)');
    chk('a bare ambiguous name is not guessed', cfb.E.rosterTeam('Miam') === null);
    const away = cfb.E.teamBlock(ce, 'CFB', 'away', { rows: [], index: {} }, null);
    chk('the CFB away side lists its QB room by class, with jersey and transfer origin, and claims no starter', /Nick Poulos/.test(away) && /Senior · #10/.test(away) && /Matt Vezza/.test(away) && /transfer in from Youngstown State/.test(away) && /no starter is claimed/.test(away) && !/Big Guy/.test(away) && /ROSTER/.test(away), away);
    chk('at most three quarterbacks, seniors first', (away.match(/pic-pn/g) || []).length === 3 && away.indexOf('Nick Poulos') < away.indexOf('Matt Vezza') && away.indexOf('Matt Vezza') < away.indexOf('Hype Grand') && !/Levi Davis/.test(away));
    chk('the away side is marked as the pick and cites the roster file', /pic-team pick/.test(away) && /ESPN roster · 2026 · Ohio Bobcats · 5 players/.test(away));
    const home = cfb.E.teamBlock(ce, 'CFB', 'home', { rows: [], index: {} }, null);
    chk('the CFB home side reads the same file', /Dylan Raiola/.test(home) && /Sophomore · #15/.test(home));
    const nq = cfb.E.teamBlock({ sport_key: 'americanfootball_ncaaf', home_team: 'Kicker U', away_team: 'Ohio Bobcats' }, 'CFB', 'home', { rows: [], index: {} }, null);
    chk('a roster with no QB says so, never invents one', /No quarterback listed/.test(nq) && /MISSING/.test(nq));
    const unk = cfb.E.teamBlock({ sport_key: 'americanfootball_ncaaf', home_team: 'Nowhere Tech', away_team: 'Ohio Bobcats' }, 'CFB', 'home', { rows: [], index: {} }, null);
    chk('a school missing from the file is reported by name', /no FBS team matched “Nowhere Tech”/.test(unk) && !/pic-players/.test(unk), unk);
    /* CFB stat leaders join on the school name the stat table stores. */
    const cst = [{ league: 'CFB', team: 'Ohio', player: 'Parker Navarro', position: 'QB', stat_line: '1,801 yds · 14 TD', lead_cat: 'passing', lead_val: 1801, leads: { passing: 1801 } },
      { league: 'CFB', team: 'Ohio State', player: 'Julian Sayin', position: 'QB', stat_line: '2,400 yds', lead_cat: 'passing', lead_val: 2400, leads: { passing: 2400 } },
      { league: 'CFB', team: 'Nebraska', player: 'Emmett Johnson', position: 'RB', stat_line: '712 yds · 6 TD', lead_cat: 'rushing', lead_val: 712, leads: { rushing: 712 } }];
    const st = { rows: cst, index: cfb.E.teamIndex(cst) };
    chk('“Ohio Bobcats” finds Ohio in the stat table, not Ohio State', cfb.E.resolveTeam(st.index, 'Ohio Bobcats').team === 'Ohio' && cfb.E.resolveTeam(st.index, 'Ohio State Buckeyes').team === 'Ohio State');
    const full = cfb.E.teamBlock(ce, 'CFB', 'away', st, null);
    chk('the CFB block carries both the QB room and the stat leader with the stat line as the reason', /Nick Poulos/.test(full) && /Parker Navarro/.test(full) && /Team leader in passing yards \(1,801\) · 1,801 yds · 14 TD/.test(full) && /stats_players · 1 rows/.test(full), full);
    const nb = cfb.E.teamBlock(ce, 'CFB', 'home', st, null);
    chk('Nebraska Cornhuskers finds Nebraska', /Emmett Johnson/.test(nb) && /Dylan Raiola/.test(nb));
    /* the stat-sheet QB leads the room, in one line, even when the class sort would have cut him */
    const deep = { display_name: 'Deep Room U', location: 'Deep Room U', nickname: 'D', abbreviation: 'DRU', players: [
      { name: 'Aaron Senior', position: 'QB', class: 'Senior', jersey: '1' }, { name: 'Bob Soph', position: 'QB', class: 'Sophomore', jersey: '2' }, { name: 'Carl Soph', position: 'QB', class: 'Sophomore', jersey: '3' }, { name: 'Zed Starter', position: 'QB', class: 'Sophomore', jersey: '4' } ] };
    cfb.E.ROSTER.index.display['deeproomu'] = deep;
    const dst = [{ league: 'CFB', team: 'Deep Room U', player: 'Zed Starter', position: 'QB', stat_line: '1,200 yds · 9 TD', lead_cat: 'passing', lead_val: 1200, leads: { passing: 1200 } }];
    const dr = cfb.E.teamBlock({ sport_key: 'americanfootball_ncaaf', home_team: 'Deep Room U', away_team: 'Ohio Bobcats' }, 'CFB', 'home', { rows: dst, index: cfb.E.teamIndex(dst) }, null);
    chk('the stat-sheet QB leads the room in ONE merged line and the room is still capped at three', dr.indexOf('Zed Starter') < dr.indexOf('Aaron Senior') && (dr.match(/Zed Starter/g) || []).length === 1 && /Team leader in passing yards \(1,200\) · 1,200 yds · 9 TD · Quarterback room · Sophomore · #4/.test(dr) && !/Carl Soph/.test(dr) && (dr.match(/pic-pn/g) || []).length === 3, dr);
    cfbDone();
  }).catch(function (e) { chk('CFB roster path does not throw', false, String(e && e.stack || e)); cfbDone(); });
  const bad = sandbox({ fetch: async function () { return { ok: false, status: 500 }; } });
  bad.E.loadRoster().then(function (R) {
    chk('an unreachable roster file is an outage in words', /roster file 500/.test(R.error) && /ESPN roster file unreachable/.test(bad.E.teamBlock(ce, 'CFB', 'home', { rows: [], index: {} }, null)));
  });
}
var cfbPending = 1; function cfbDone() { cfbPending--; }

/* ---- every priced market ----------------------------------------------------------- */
{
  const { E } = sandbox();
  const g = E.gameRows(focal);
  chk('every side of every market on the game is listed, and other games are not', g.length === 4 && g.every(r => r.event_id === 'ev1'));
  chk('markets are ordered ML, spread, total', g.map(r => r.market).join(',') === 'h2h,spreads,spreads,totals');
  const html = E.marketsHTML(focal, g);
  chk('each row carries best price and book, the fair line and its anchor, the edge, the verdict, open → now and books', /-110<span class="bk">DraftKings<\/span>/.test(html) && /-125<span class="bk">sharp<\/span>/.test(html) && /\+3\.1%/.test(html) && /<td class="v bet">BET<span class="bk">good to -118/.test(html) && /-115 → -110/.test(html) && /<td class="m">6<span class="bk">5m ago/.test(html), html.slice(0, 1200));
  chk('the other side of the spread is priced too, with its own negative edge and a PASS', /Ravens -3\.5/.test(html) && /-2\.0%/.test(html) && /<td class="v pass">PASS/.test(html));
  chk('the focal edge is marked and only it', (html.match(/this edge/g) || []).length === 1 && /<tr class="focal">.*Chiefs \+3\.5/.test(html));
  chk('a consensus-anchored fair is labelled consensus and an offshore best is flagged', /<span class="bk">consensus<\/span>/.test(html) && /Bovada · offshore/.test(html));
  chk('a game with nothing priced says so', /No priced market is on file/.test(E.marketsHTML({ event_id: 'zzz' }, [])));
  chk('a stub verdict cannot be upgraded by the table: the engine value is printed verbatim', (function () { const sb = sandbox({ evidence: function () { return { dverdict: 'WAIT', toPlayAm: -118 }; } }); return /<td class="v wait">WAIT<\/td>/.test(sb.E.marketsHTML(focal, sb.E.gameRows(focal))); })());
}

/* ---- every book ---------------------------------------------------------------------- */
{
  const { E } = sandbox();
  const b = E.booksHTML([{ book_title: 'DraftKings', dec: 1.909, fair: 0.52 }, { book_title: 'Pinnacle', dec: 1.87, fair: 0.5556, is_sharp: true }, { book_title: 'FanDuel', dec: 1.87, fair: 0.53 }]);
  chk('the best book is green, the sharp book starred, every quote carries its own fair', /class="bestbk"><td>DraftKings<\/td><td>-110<\/td><td>52\.0%/.test(b) && /class="sharpbk"><td>Pinnacle ★<\/td><td>-115<\/td><td>55\.6%/.test(b));
  chk('no stored quotes is said, not padded', /No per-book rows stored for this line yet/.test(E.booksHTML([])));
}

/* ---- the panel, opened through the receipt ----------------------------------------- */
{
  const dom = {};
  function el(id) { return dom[id] = dom[id] || { id, innerHTML: '', attrs: {}, classList: { has: false, contains() { return this.has; }, add() { this.has = true; } }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; } }; }
  el('t10_0'); el('t10_0_pic'); el('t10_0_books');
  const seen = [];
  const sb = sandbox({ dom, sbGet: async function (q) { seen.push(q); if (/^stats_players/.test(q)) return stats; if (/^book_quotes/.test(q)) return [{ book_title: 'DraftKings', dec: 1.909, fair: 0.52 }]; if (/^model_props/.test(q)) return [{ player: 'Patrick Mahomes', market: 'passing_yards', line: 275.5, proj: 288.2, p_over: 61 }]; return []; } });
  sb.win.RCPT['t10_0'] = focal;
  chk('pictureHTML assembles players, markets and books in one panel', (function () { const h = sb.E.pictureHTML(focal, { domid: 't10_0', rows: sb.E.gameRows(focal), stats: { rows: stats, index: sb.E.teamIndex(stats) } }); return /Full picture/.test(h) && /Key players/.test(h) && /Every priced market on this game/.test(h) && /Every book on this line/.test(h) && /Patrick Mahomes/.test(h) && /Lamar Jackson/.test(h) && /this edge/.test(h) && /id="t10_0_books"/.test(h); })());
  chk('a sport with no player tables still shows the pricing', (function () { const h = sb.E.pictureHTML({ event_id: 'ev1', sport_key: 'soccer_epl', home_team: 'A', away_team: 'B' }, { rows: [] }); return /no player tables for this sport/.test(h) && /Every priced market/.test(h); })());
  sb.E.open('t10_0').then(function () {
    chk('opening the picture opens the receipt row and fills the host', dom['t10_0'].classList.has === true && /Patrick Mahomes/.test(dom['t10_0_pic'].innerHTML) && /Chiefs \+3\.5/.test(dom['t10_0_pic'].innerHTML));
    chk('the stat query is scoped to the league; the prop query names the key players; the book query uses the signal key', seen.some(q => /^stats_players.*league=ilike\.NFL/.test(q)) && seen.some(q => /^model_props.*Patrick%20Mahomes/.test(q)) && seen.some(q => /^book_quotes.*sig_key=eq\.ev1%7Cspreads%7CChiefs%7C3\.5/.test(q)), seen);
    chk('the per-book table lands in its slot and the prop projection on its player', /DraftKings/.test(dom['t10_0_books'].innerHTML) && /passing yards o275\.5/.test(dom['t10_0_pic'].innerHTML));
    return sb.E.open('t10_0');
  }).then(function () {
    chk('a second tap closes the panel', dom['t10_0_pic'].innerHTML === '' && dom['t10_0_pic'].attrs['data-open'] === '0');
    (function wait() { if (cfbPending) return setTimeout(wait, 10); done(); })();
  }).catch(function (e) { chk('open() does not throw', false, String(e && e.stack || e)); done(); });
}
