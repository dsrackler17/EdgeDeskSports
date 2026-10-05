#!/usr/bin/env node
/* ===========================================================================
   supabase/home_board.sql, AGAINST A REAL POSTGRESQL, AS A SIGNED-OUT VISITOR.

   Builds research-state rows from the COMMITTED slate (football/cfb_terminal/
   board.json for college, football/nfl/slate.json for the NFL, and each
   game's props block from football/props/<league>/summary.json through
   lib/edgedesk_opportunity.js stateProps — the same object the research
   state job stores), applies the file twice, and proves:

     1  a signed-out visitor can call public_home_board() and nothing else:
        not the research state, not the builder, not the cache;
     2  the answer is a SUBSET: no priority reasoning, no drivers, no movement,
        no personal data, at most 8 games and 3 props a game;
     3  the four public words come from the state's own fields (RESEARCH only
        for a research-grade game, PASS for agreement, DATA_INCOMPLETE for no
        market / not priced / a fault / a stale capture, WATCH otherwise);
     4  only upcoming games; the counts are counts of those rows;
     5  a second call inside a minute is the cached answer;
     6  an admin-public sample game is flagged, and only that one;
     7  an empty slate is an empty, successful answer.

   With --write-fixture it saves the anonymous answer to
   tools/home/fixtures/public_home_board.json for the page tests.

   Run: node tools/home/home_sql.test.js [--write-fixture]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../personal/_pg.js');

const T = PG.kit('home board SQL');
const chk = T.chk;
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'home_board.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('the public words are never a pick', !/'(BET|LOCK|PICK)'/.test(SQL.replace(/--.*$/gm, '')));

/* ── the committed slate, as research-state rows ───────────────────────── */
global.window = global.window || global;
['research_core.js', 'edgedesk_vocab.js', 'edgedesk_market.js', 'edgedesk_decision.js', 'edgedesk_bankroll.js', 'research_priority.js', 'edgedesk_props.js']
  .forEach((f) => require(path.join(ROOT, 'lib', f)));
const OPP = require(path.join(ROOT, 'lib', 'edgedesk_opportunity.js'));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const CFB = readJson('football/cfb_terminal/board.json');
const NFL = readJson('football/nfl/slate.json');
const SUM = { nfl: readJson('football/props/nfl/summary.json'), cfb: readJson('football/props/cfb/summary.json') };
const NOW = Date.now();
/* the committed files are a snapshot: move every kickoff so the slate is
   upcoming relative to the test's clock, keeping each game's order */
const firstKick = Math.min(...CFB.rows.map((r) => Date.parse(r.kickoff)).filter(isFinite), ...NFL.games.map((g) => Date.parse(g.kickoff)).filter(isFinite));
const shift = (NOW + 6 * 3600e3) - firstKick;
const kick = (t) => new Date(Date.parse(t) + shift).toISOString();

function propsBlock(lg, gid) {
  const ev = SUM[lg] && SUM[lg].events ? SUM[lg].events[gid] : null;
  if (!ev) return null;
  return OPP.stateProps(Object.assign({}, ev, { summary_generated_at: SUM[lg].generated_at }));
}
const rows = [];
CFB.rows.forEach((r) => {
  const b = r.bettor || {}, q = b.quote || {};
  const status = String(r.status || '').replace(/_/g, ' ');
  const fairHome = typeof r.fair_home_margin === 'number' ? -r.fair_home_margin : null;
  rows.push({
    game_key: 'cfb|' + r.game_id, sport: 'cfb', game_id: String(r.game_id), home: r.home, away: r.away, kickoff_at: kick(r.kickoff),
    status, projected: fairHome != null, fair_home_line: fairHome, fair_total: null,
    market_home_line: r.market_home_line == null ? null : r.market_home_line, market_kind: r.market_home_line == null ? null : 'live',
    /* a captured market is 25 minutes old at the test's clock */
    market_book: q.sportsbook || b.book || null, market_captured_at: r.market_home_line != null ? new Date(NOW - 25 * 60e3).toISOString() : null,
    market_stale: r.market_stale === true, gap_pts: typeof r.gap === 'number' ? r.gap : null,
    reliability_score: typeof r.reliability === 'number' ? r.reliability : null, research_label: r.research_status || null,
    research_grade: r.research_status === 'WORTH_RESEARCHING' || r.research_status === 'VERIFIED_MAJOR',
    key_reason: r.status_reason || null,
    state: { fair: { text: r.fair }, market: { text: r.market, books: r.books }, gap: { toward: r.gap_toward === r.home ? 'home' : (r.gap_toward === r.away ? 'away' : null) },
      priority: { uncertainty: (r.uncertainty_why || []).slice(0, 3), why_text: 'PRIVATE ranking reasoning' }, drivers: [{ text: 'PRIVATE driver', points: 1 }],
      movement: { spread_moved: 1 }, props: propsBlock('cfb', String(r.game_id)) }
  });
});
NFL.games.forEach((g) => {
  const ref = g.reference_market || {};
  const gap = typeof g.model_home_line === 'number' && typeof ref.home_line === 'number' ? Math.round(Math.abs(g.model_home_line - ref.home_line) * 10) / 10 : null;
  rows.push({
    game_key: 'nfl|' + g.game_id, sport: 'nfl', game_id: g.game_id, home: g.home_team, away: g.away_team, kickoff_at: kick(g.kickoff),
    status: gap == null ? 'NO MARKET' : (gap >= 2 ? 'INVESTIGATE' : 'AGREEMENT'), projected: typeof g.model_home_line === 'number',
    fair_home_line: g.model_home_line, fair_total: g.model_fair_total, market_home_line: ref.home_line == null ? null : ref.home_line, market_total: ref.total,
    market_kind: ref.home_line == null ? null : 'consensus', market_book: null, market_captured_at: null, market_stale: false, gap_pts: gap,
    win_prob_home: g.model_home_win_prob, research_label: null, research_grade: false, key_reason: null,
    state: { fair: {}, market: {}, gap: {}, priority: { uncertainty: g.qb_known === false ? ['starting quarterback not confirmed'] : [] }, props: propsBlock('nfl', g.game_id) }
  });
});

/* A PROBE GAME with a real props block (tools/home/fixtures/props_block.json),
   research-grade with a fresh market, so the board always carries props and
   their fields are checked whatever the committed slate holds today (on a
   day when only one game has prop opportunities, none reach the top eight). */
const PROBE = readJson('tools/home/fixtures/props_block.json');
rows.push({
  game_key: 'cfb|probe-' + PROBE.game_id, sport: 'cfb', game_id: 'probe-' + PROBE.game_id, home: PROBE.home, away: PROBE.away, kickoff_at: new Date(NOW + 3 * 3600e3).toISOString(),
  status: 'RESEARCH', projected: true, fair_home_line: -7.5, fair_total: null, market_home_line: -2.5, market_kind: 'live', market_book: 'draftkings',
  market_captured_at: new Date(NOW - 25 * 60e3).toISOString(), market_stale: false, gap_pts: 5, reliability_score: 80, research_label: 'WORTH_RESEARCHING',
  research_grade: true, key_reason: null, state: { fair: {}, market: {}, gap: {}, priority: { uncertainty: [] }, props: PROBE.props }
});

const db = PG.start('homeboard');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }
const lit = PG.lit;
function insertRows(list) {
  if (!list.length) return;
  db.service('insert into public.game_research_state (game_key, sport, game_id, home, away, kickoff_at, status, projected, fair_home_line, fair_total, market_home_line, market_total, market_kind, market_book, market_captured_at, market_stale, gap_pts, win_prob_home, reliability_score, research_label, research_grade, key_reason, state, state_hash, computed_at) values '
    + list.map((r) => '(' + [lit(r.game_key), lit(r.sport), lit(r.game_id), lit(r.home), lit(r.away), lit(r.kickoff_at) + '::timestamptz', lit(r.status), r.projected ? 'true' : 'false',
      r.fair_home_line == null ? 'null' : r.fair_home_line, r.fair_total == null ? 'null' : r.fair_total, r.market_home_line == null ? 'null' : r.market_home_line,
      r.market_total == null ? 'null' : r.market_total, lit(r.market_kind), lit(r.market_book), r.market_captured_at ? lit(r.market_captured_at) + '::timestamptz' : 'null',
      r.market_stale ? 'true' : 'false', r.gap_pts == null ? 'null' : r.gap_pts, r.win_prob_home == null ? 'null' : r.win_prob_home,
      r.reliability_score == null ? 'null' : r.reliability_score, lit(r.research_label), r.research_grade ? 'true' : 'false', lit(r.key_reason),
      lit(JSON.stringify(Object.assign({ game_key: r.game_key }, r.state))) + '::jsonb', lit('h-' + r.game_key), 'now()'].join(', ') + ')').join(',\n') + ';');
}

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
    .forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  let out = db.applyFileAtomic(FILE);
  chk('the migration applies', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out), out.slice(-600));

  /* 7 · an empty slate */
  let r = JSON.parse(db.anon('select public.public_home_board();'));
  chk('an empty slate is an empty, successful answer', r.ok === true && Array.isArray(r.games) && r.games.length === 0 && r.counts.games_analyzed === 0, r);
  db.sql('delete from public.public_home_board_cache;');

  /* the slate, plus one game that has already kicked off */
  insertRows(rows);
  insertRows([{ game_key: 'cfb|started', sport: 'cfb', game_id: 'started', home: 'Past', away: 'Game', kickoff_at: new Date(NOW - 3600e3).toISOString(), status: 'RESEARCH',
    projected: true, fair_home_line: -7, market_home_line: -3, gap_pts: 4, research_grade: true, market_captured_at: new Date(NOW - 7200e3).toISOString(), state: {} }]);
  const inWindow = (x) => { const k = Date.parse(x.kickoff_at); return k > NOW && k < NOW + 8 * 864e5; };
  const upcoming = rows.filter(inWindow).length;

  /* 1 · who may call what */
  let err = db.mustFail(() => db.anon('select count(*) from public.game_research_state;'));
  chk('a signed-out visitor still cannot read the research state', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.anon('select public.public_home_board_build();'));
  chk('nor call the builder directly', !!err && /permission denied/.test(err), err);
  err = db.mustFail(() => db.anon('select * from public.public_home_board_cache;'));
  chk('nor read the cache', !!err && /permission denied/.test(err), err);
  r = JSON.parse(db.anon('select public.public_home_board();'));
  chk('but can call the board', r.ok === true && r.schema === 'edgedesk_home_board/1', r);

  /* 2 · a subset */
  const txt = JSON.stringify(r);
  /* the private research-state FIELDS must not leave the database. Match them
     as JSON keys: a public sentence may say "open-to-close movement" (the
     pricing explanation does), and that is not the movement blob */
  const leaked = ['movement', 'drivers', 'state_hash', 'priority_why'].filter((k) => txt.indexOf('"' + k + '":') >= 0);
  chk('no priority reasoning, driver, movement or research-state blob leaves the database',
    txt.indexOf('PRIVATE') < 0 && leaked.length === 0, leaked);
  chk('at most 8 games', r.games.length > 0 && r.games.length <= 8, r.games.length);
  chk('at most 3 props a game', r.games.every((g) => !g.props || !g.props.top || g.props.top.length <= 3));
  const withProps = r.games.filter((g) => g.props && g.props.top && g.props.top.length);
  chk('the probe game\'s props reach the board', withProps.some((g) => /^cfb\|probe-/.test(g.game_key)), r.games.map((g) => g.game_key));
  chk('props carry the fields the page prints (price, capture time, projection, probability, EV, decision)', withProps.length > 0 && withProps.every((g) => g.props.top.every((p) =>
    p.player && p.player.name && p.market && p.selection && p.price && p.price.captured_at && p.projection && typeof p.ev === 'number' && p.decision)), JSON.stringify((withProps[0] && withProps[0].props.top[0]) || null).slice(0, 400));

  /* 3 · the four words */
  const words = new Set(r.games.map((g) => g.status));
  chk('every status is one of the four public words', [...words].every((w) => ['RESEARCH', 'WATCH', 'PASS', 'DATA_INCOMPLETE'].includes(w)), [...words]);
  const all = JSON.parse(db.service('select public.public_home_board_build();'));
  chk('research first: the board opens with a research-grade game when one exists',
    !rows.some((x) => x.research_grade && x.market_home_line != null && !x.market_stale) || all.games[0].status === 'RESEARCH', all.games.map((g) => g.status));
  const st = (k) => db.sql(`select public.ed_public_status(${k});`);
  chk('RESEARCH needs the state\'s own research grade', st("true,'RESEARCH','WORTH_RESEARCHING',true,-3.5,false,4.2") === 'RESEARCH' && st("true,'RESEARCH','WORTH_RESEARCHING',false,-3.5,false,4.2") === 'WATCH');
  chk('agreement is PASS', st("true,'AGREEMENT',null,false,-3,false,0.5") === 'PASS' && st("true,'RESEARCH','MARKET_ALIGNED',false,-3,false,1.8") === 'PASS');
  chk('no market, not priced, a fault or a stale capture is DATA_INCOMPLETE',
    st("true,'NO MARKET',null,false,null,null,null") === 'DATA_INCOMPLETE' && st("false,'NOT PRICED',null,false,-3,false,2") === 'DATA_INCOMPLETE'
    && st("true,'DATA FAULT',null,false,-3,false,25") === 'DATA_INCOMPLETE' && st("true,'RESEARCH','WORTH_RESEARCHING',true,-3,true,4") === 'DATA_INCOMPLETE');
  chk('an unverified large gap is WATCH, never RESEARCH', st("true,'INVESTIGATE','INVESTIGATE',false,-3,false,8") === 'WATCH');
  chk('a DATA_INCOMPLETE game says why', all.games.filter((g) => g.status === 'DATA_INCOMPLETE').every((g) => typeof g.status_note === 'string' && g.status_note.length > 10));

  /* 3b · the signed-in first-run screen judges game_research_state rows in
     the browser (lib/edgedesk_home.js publicStatus / incompleteReason); it
     must say exactly what the database says, for every combination */
  const HOME = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
  const combos = [];
  [true, false].forEach((pj) => ['RESEARCH', 'AGREEMENT', 'INVESTIGATE', 'NO MARKET', 'DATA FAULT', 'NOT PRICED', 'STALE QUOTE', 'THIN DATA', 'research', null].forEach((stx) =>
    ['WORTH_RESEARCHING', 'MARKET_ALIGNED', 'NEAR_PICKEM', 'LIMITED_DATA', 'LOW_RELIABILITY', null].forEach((lb) => [true, false].forEach((gr) =>
      [[-3.5, false, 4.2], [-3, false, 1.2], [null, false, null], [-3, true, 5]].forEach((m) => combos.push([pj, stx, lb, gr].concat(m)))))));
  const sqlOut = db.sql('select string_agg(public.ed_public_status(p, s, l, g, m, st, gp) || \'|\' || public.ed_public_incomplete_reason(p, s, m, st), E\'\\n\' order by i) from (values '
    + combos.map((c, i) => '(' + i + ', ' + c[0] + ', ' + lit(c[1]) + ', ' + lit(c[2]) + ', ' + c[3] + ', ' + (c[4] == null ? 'null::numeric' : c[4] + '::numeric') + ', ' + c[5] + ', ' + (c[6] == null ? 'null::numeric' : c[6] + '::numeric') + ')').join(', ')
    + ') v(i, p, s, l, g, m, st, gp);').split('\n');
  const drift = combos.map((c, i) => [c, HOME.publicStatus(c[0], c[1], c[2], c[3], c[4], c[5], c[6]) + '|' + HOME.incompleteReason(c[0], c[1], c[4], c[5]), sqlOut[i]]).filter((x) => x[1] !== x[2]);
  chk('the browser\'s status rule is the database\'s, word for word (' + combos.length + ' combinations)', sqlOut.length === combos.length && drift.length === 0, drift.slice(0, 3));

  /* 4 · upcoming only, and counts are counts */
  chk('the window is upcoming games inside 8 days', rows.some((x) => !inWindow(x)) ? all.counts.games_on_slate < rows.length : true);
  chk('a game that has kicked off is not on the board', txt.indexOf('cfb|started') < 0 && JSON.stringify(all).indexOf('cfb|started') < 0);
  chk('games on slate counts the upcoming rows', all.counts.games_on_slate === upcoming, [all.counts.games_on_slate, upcoming]);
  chk('the four statuses add up to the slate',
    all.counts.game_research + all.counts.watching + all.counts.passes + all.counts.data_incomplete === all.counts.games_on_slate, all.counts);
  chk('game research is the research-grade rows with a current market',
    all.counts.game_research === rows.filter(inWindow).filter((x) => x.projected && x.research_grade && x.market_home_line != null && !x.market_stale && !['NO MARKET', 'DATA FAULT', 'STALE QUOTE', 'THIN DATA', 'AWAITING DATA', 'NOT PRICED'].includes(String(x.status).toUpperCase())).length, all.counts);
  chk('props tracked is the sum of the props blocks',
    all.counts.props_tracked === rows.filter(inWindow).reduce((a, x) => a + (x.state.props && typeof x.state.props.total_props === 'number' ? x.state.props.total_props : 0), 0), all.counts.props_tracked);
  chk('freshness times are real timestamps', !!all.times.model_updated_at && isFinite(Date.parse(all.times.model_updated_at)));
  chk('without the capture tables, quote counts are null — never zero', all.counts.sportsbook_quotes == null);

  /* 5 · the cache */
  db.sql('delete from public.public_home_board_cache;');
  const a1 = JSON.parse(db.anon('select public.public_home_board();'));
  const a2 = JSON.parse(db.anon('select public.public_home_board();'));
  chk('the first call builds, the second inside a minute reads the cache', a1.cached === false && a2.cached === true && a1.as_of === a2.as_of, [a1.cached, a2.cached]);
  db.sql(`update public.public_home_board_cache set built_at = now() - interval '2 minutes';`);
  const a3 = JSON.parse(db.anon('select public.public_home_board();'));
  chk('a cache older than a minute is rebuilt', a3.cached === false);

  /* 6 · public samples */
  const sampleKey = all.games[0].game_key;
  db.sql(`insert into public.public_sample_games (game_key, enabled) values (${lit(sampleKey)}, true) on conflict (game_key) do update set enabled = true;
          delete from public.public_home_board_cache;`);
  const s1 = JSON.parse(db.anon('select public.public_home_board();'));
  chk('an admin-public sample game is flagged for a public link, and only that one',
    s1.games.filter((g) => g.sample === true).map((g) => g.game_key).join() === sampleKey, s1.games.map((g) => [g.game_key, g.sample]));

  if (process.argv.indexOf('--write-fixture') >= 0) {
    db.sql(`delete from public.public_sample_games; delete from public.public_home_board_cache;`);
    const fx = JSON.parse(db.anon('select public.public_home_board();'));
    fx.fixture_note = 'tools/home/home_sql.test.js --write-fixture: the real public_home_board() over research-state rows built from the committed slate, kickoffs shifted to ' + new Date(NOW).toISOString() + ' + 6 h';
    fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'fixtures', 'public_home_board.json'), JSON.stringify(fx, null, 1) + '\n');
    console.log('wrote tools/home/fixtures/public_home_board.json (' + fx.games.length + ' games)');
  }
} catch (e) {
  chk('the live layer ran', false, String(e.message).slice(0, 1500) + ' ' + String(e.stack).split('\n').slice(1, 4).join(' / '));
} finally {
  db.stop();
}
process.exit(T.done());
