#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — THE LIVING SEASON (season_v1), against a real
   PostgreSQL.

   A season used to be a record and a schedule. This suite holds the three
   things that were added to it to the standard the brief set:

     1  the power rating is NOT the standings, and every row says why
     2  the week takes its own snapshot, and movement is a fact
     3  the award races score PERFORMANCE, never an overall
     4  a rate beats volume, and a great man on a bad team is still great
     5  clutch is the one-score games, read out of their own box scores
     6  the ninth game is a bowl; a great season makes it the title game
     7  the most valuable man is the man who played best, not the best card
     8  the title is written into the record once, by the game itself

   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES, like the other SQL suites.

   Run: node tools/games/season_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5433 -U postgres" node tools/games/season_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_games_season_sqltest';
const LABEL = 'the living season';

function have(bin) { return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }
function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function psql(conn, args, opts) { return cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {})); }
function skip(why) {
  console.log('SKIP | ' + LABEL + ' | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) {
  const r = psql(c, ['-d', 'postgres', '-tAc', 'select 1']);
  if (r.status === 0 && String(r.stdout).trim() === '1') { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); } }
function eq(name, got, want) { chk(name, String(got) === String(want), 'got ' + got + ', want ' + want); }
function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
function die(msg, r) {
  console.log('FAIL | ' + LABEL + ' | ' + msg);
  ((r && (r.stderr || '')) + (r && (r.stdout || ''))).split('\n').filter(l => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 8).forEach(l => console.log('  × ' + l.trim()));
  drop(); process.exit(1);
}
function q(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  if (r.status !== 0) die('a query failed: ' + sql.slice(0, 160), r);
  return String(r.stdout).trim();
}
function qFail(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  return { ok: r.status === 0, out: String(r.stdout).trim(), err: String(r.stderr || '') };
}
function qj(sql, asOwner) { const t = q(sql, asOwner); try { return JSON.parse(t); } catch (e) { die('not JSON from: ' + sql.slice(0, 100) + ' → ' + t.slice(0, 160)); } }
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());
for (const [file, label] of [[SHIM, 'the Supabase shim'], [SOCIAL, 'games_social.sql'], [SCHEMA, 'games_franchise.sql']]) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) die(label + ' did not apply', r);
}

/* ── the season, played out ───────────────────────────────────────────── */
const SA = 'device-secret-seasonsuiteaaaaaaaaaaa';
q("select public.franchise_create('Foundry','Bethel','BET','gear','forest','power_run','press_man'," + lit(SA) + ")");
const A = q('select public.franchise_of(' + lit(SA) + ')', true);
q('select public.franchise_start_season(' + lit(SA) + ')');
const WEEKS = +q('select weeks from public.franchise_seasons where franchise_id = ' + lit(A) + '::uuid', true);
for (let w = 1; w <= WEEKS; w++) {
  q("select public.franchise_play_game(" + lit(A) + "::uuid, now() + interval '" + (w * 8) + " days')", true);
}
const rec = q("select wins||'-'||losses||'|'||week from public.franchise_seasons where franchise_id = " + lit(A) + '::uuid', true).split('|');
eq('the season played all the way out', rec[1], String(WEEKS));

/* ── 1-2. the snapshot the week takes for itself ───────────────────────── */
const snaps = +q('select count(*) from public.franchise_rank_weeks where franchise_id = ' + lit(A) + '::uuid', true);
chk('every week that finished a game wrote its own rankings snapshot', snaps === WEEKS, snaps + ' of ' + WEEKS);
eq('and its own award race', q('select count(*) from public.franchise_award_weeks where franchise_id = ' + lit(A) + '::uuid', true), String(snaps));
chk('the snapshot is taken by a DEFERRED trigger, so the season lines are already written',
  q("select t.tgdeferrable::text from pg_trigger t join pg_class c on c.oid = t.tgrelid"
    + " where c.relname = 'franchise_games' and t.tgname = 'franchise_games_snapshot'", true) === 'true');
const wk1 = qj('select rows from public.franchise_rank_weeks where franchise_id = ' + lit(A) + '::uuid order by week limit 1', true);
const wkN = qj('select rows from public.franchise_rank_weeks where franchise_id = ' + lit(A) + '::uuid order by week desc limit 1', true);
chk('a snapshot rates every club in the league, not only yours', wk1.length >= 8, wk1.length);
chk('the first week written has nothing to move against', wk1.every(r => r.previous === null || r.previous === undefined));
chk('a later week carries the previous rank and the movement between them',
  wkN.some(r => r.previous != null && r.movement != null), JSON.stringify(wkN[0]));
chk('movement is exactly the arithmetic of the two ranks',
  wkN.filter(r => r.previous != null).every(r => r.movement === r.previous - r.rank), 'movement disagrees with the ranks');

/* ── the rating is not the standings ──────────────────────────────────── */
const rk = qj('select public.franchise_rankings(' + lit(SA) + ')');
chk('the rankings name their model', rk.version === 'season_v1' && Array.isArray(rk.rows), rk.version);
chk('every row is ranked, rated, and says why it is there',
  rk.rows.every(r => r.rank > 0 && typeof r.rating === 'number' && Array.isArray(r.why) && r.why.length > 0),
  JSON.stringify(rk.rows[0]));
chk('the ranking is not a sort by record: two clubs on the same record are separated',
  (() => {
    const byRec = {};
    rk.rows.forEach(r => { const k = r.wins + '-' + r.losses; (byRec[k] = byRec[k] || []).push(r.rating); });
    return Object.keys(byRec).some(k => byRec[k].length > 1 && new Set(byRec[k]).size > 1);
  })(), 'no two clubs shared a record');
chk('the rating is not the roster either: evidence moved somebody off it',
  rk.rows.some(r => Math.abs(r.rating - r.roster) > 0.5), 'no club was moved by what it did');
const rules = qj('select public.franchise_season_rules()');
chk('the model is published term by term, so any number on the page can be checked',
  ['win_pct', 'margin_cap', 'margin', 'sos', 'form', 'quality_win', 'bad_loss', 'home_road'].every(k => rules.power[k] != null),
  JSON.stringify(rules.power));
chk('your own club is in the table and knows it is yours', rk.me && rk.me.mine === true, JSON.stringify(rk.me && rk.me.key));
chk('risers and fallers are read off the two snapshots, not invented',
  Array.isArray(rk.risers) && Array.isArray(rk.fallers)
  && rk.risers.every(r => r.movement > 0) && rk.fallers.every(r => r.movement < 0),
  rk.risers.length + ' up, ' + rk.fallers.length + ' down');
chk('the biggest jump is the biggest jump there was',
  !rk.biggest_jump || rk.risers.every(r => r.movement <= rk.biggest_jump.movement));
chk('the biggest drop is the biggest drop there was',
  !rk.biggest_drop || rk.fallers.every(r => r.movement >= rk.biggest_drop.movement));
chk('new in the top ten means it was outside it last week',
  rk.new_top_ten.every(r => r.rank <= 10 && r.previous > 10), JSON.stringify(rk.new_top_ten));

/* ── 3-4. the award races score performance ───────────────────────────── */
const aw = qj('select public.franchise_awards(' + lit(SA) + ')');
eq('there are ten races', aw.races.length, 10);
chk('every race the brief named is run',
  ['poy', 'opoy', 'dpoy', 'qb', 'rb', 'wr', 'rush', 'db', 'rook', 'clutch'].every(k => aw.races.some(r => r.key === k)),
  aw.races.map(r => r.key).join(','));
chk('no race lists more than five candidates', aw.races.every(r => r.candidates.length <= 5),
  aw.races.map(r => r.candidates.length).join(','));
const withCand = aw.races.filter(r => r.candidates.length > 0);
chk('a candidate carries his position, his season line, his team record and his score',
  withCand.length > 0 && withCand.every(r => r.candidates.every(c =>
    c.position && c.line && c.team_record && c.score >= 0 && c.score <= 100 && c.games > 0)),
  JSON.stringify(withCand[0] && withCand[0].candidates[0]));
chk('a race is ordered by the score and says so with a place',
  withCand.every(r => r.candidates.every((c, i) => c.place === i + 1)
    && r.candidates.every((c, i) => i === 0 || c.score <= r.candidates[i - 1].score)),
  'a race was out of order');
chk('the score prints the arithmetic that produced it',
  withCand.every(r => r.candidates.every(c => c.parts && Object.keys(c.parts).length > 0 && c.ref > 0)),
  JSON.stringify(withCand[0].candidates[0].parts));
chk('the quarterback race is quarterbacks and the pass-rush race is not',
  aw.races.find(r => r.key === 'qb').candidates.every(c => c.position === 'QB')
  && aw.races.find(r => r.key === 'db').candidates.every(c => ['CB', 'S'].indexOf(c.position) >= 0));
chk('the award watch names a leader per race with the line that leads it',
  aw.watch.length === withCand.length && aw.watch.every(w => w.leader && w.line && w.score >= 0),
  JSON.stringify(aw.watch[0]));
chk('the race says what it is scored over', withCand.every(r => /game/.test(r.basis)), JSON.stringify(withCand[0].basis));
chk('the scope of the race is stated rather than invented', /roster/.test(aw.scope || ''), aw.scope);

/* the score itself: a rate, blind to the card */
const big = qj("select public.franchise_award_score('RB','{\"games\":8,\"car\":160,\"yds\":1040,\"td\":11,\"rec\":20,\"rec_yds\":180}'::jsonb, 0.5, 70)");
const small = qj("select public.franchise_award_score('RB','{\"games\":8,\"car\":60,\"yds\":180,\"td\":1}'::jsonb, 0.5, 70)");
chk('the back who ran for a thousand outscores the back who ran for a hundred and eighty',
  big.score > small.score && big.score > 60, big.score + ' vs ' + small.score);
const volume = qj("select public.franchise_award_score('RB','{\"games\":16,\"car\":400,\"yds\":1300,\"td\":6}'::jsonb, 0.5, 70)");
const rate = qj("select public.franchise_award_score('RB','{\"games\":8,\"car\":130,\"yds\":900,\"td\":8}'::jsonb, 0.5, 70)");
chk('volume cannot win a race on its own: the better rate over half the carries wins',
  rate.score > volume.score, rate.score + ' vs ' + volume.score);
const winner = qj("select public.franchise_award_score('WR','{\"games\":8,\"rec\":56,\"yds\":900,\"td\":9}'::jsonb, 1.0, 70)");
const loser = qj("select public.franchise_award_score('WR','{\"games\":8,\"rec\":56,\"yds\":900,\"td\":9}'::jsonb, 0.0, 70)");
chk('the team matters, and matters a little: a perfect record is worth under a third',
  winner.score > loser.score && (winner.score - loser.score) / loser.score < 0.35,
  loser.score + ' → ' + winner.score);
eq('a man who did not play scores nothing', qj("select public.franchise_award_score('QB','{}'::jsonb, 1.0, 90)").score, 0);
chk('the score never reads an overall, an archetype or a name',
  q("select p.prosrc !~ 'overall|archetype|first_name' from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'franchise_award_score'", true) === 't');
chk('a quarterback is scored against quarterbacks and a corner against corners',
  qj("select public.franchise_award_refs()").QB === 30 && qj("select public.franchise_award_refs()").CB === 16);

/* the rookie race is rookies, by the record and not by a label */
const rook = aw.races.find(r => r.key === 'rook');
chk('every man in the rookie race is in his first season of football here',
  rook.candidates.every(c => c.rookie === true), JSON.stringify(rook.candidates.map(c => c.name)));

/* ── 5. clutch is the one-score games ─────────────────────────────────── */
const closeN = +q('select count(*) from public.franchise_games where franchise_id = ' + lit(A)
  + "::uuid and status = 'final' and abs(coalesce(score_for,0) - coalesce(score_against,0)) <= 8", true);
const clutch = aw.races.find(r => r.key === 'clutch');
chk('the clutch race counts the one-score games and says how many',
  clutch.basis === closeN + ' one-score game' + (closeN === 1 ? '' : 's'), clutch.basis + ' vs ' + closeN);
chk('a clutch candidate is scored only over those games',
  closeN === 0 ? clutch.candidates.length === 0 : clutch.candidates.every(c => c.games <= closeN && c.games > 0),
  JSON.stringify(clutch.candidates.map(c => c.games)));

/* ── 6. the ninth game ────────────────────────────────────────────────── */
const SB = 'device-secret-seasonsuitebbbbbbbbbbb';
const SC = 'device-secret-seasonsuiteccccccccccc';
q("select public.franchise_create('Anvils','Kirby','KRB','bolt','crimson','spread','zone'," + lit(SB) + ")");
q("select public.franchise_create('Wardens','Alder','ALD','shield','navy','pro_style','four_three'," + lit(SC) + ")");
const B = q('select public.franchise_of(' + lit(SB) + ')', true);
const C = q('select public.franchise_of(' + lit(SC) + ')', true);
q('select public.franchise_start_season(' + lit(SB) + ')');
q('select public.franchise_start_season(' + lit(SC) + ')');
/* B finishes 5–3: a bowl. C finishes 7–1: the title game. */
q('update public.franchise_seasons set wins = 5, losses = 3, week = weeks where franchise_id = ' + lit(B) + '::uuid', true);
q('update public.franchise_seasons set wins = 7, losses = 1, week = weeks where franchise_id = ' + lit(C) + '::uuid', true);
eq('a losing season earns nothing', q("select coalesce(public.franchise_schedule_bowl(" + lit(A)
  + "::uuid, 0, now())::text, 'none')", true), 'none');
const bowlB = q('select public.franchise_schedule_bowl(' + lit(B) + "::uuid, 1, now())", true);
const bowlC = q('select public.franchise_schedule_bowl(' + lit(C) + "::uuid, 1, now())", true);
chk('a winning season still earns its bowl', !!bowlB, bowlB);
eq('and a bowl is not the title game', q('select championship::text from public.franchise_games where id = ' + lit(bowlB) + '::uuid', true), 'false');
eq('losing at most once earns the title game', q('select championship::text from public.franchise_games where id = ' + lit(bowlC) + '::uuid', true), 'true');
eq('the title game has a name of its own',
  q("select opponent->>'bowl_name' from public.franchise_games where id = " + lit(bowlC) + '::uuid', true), 'The EdgeDesk Championship');
const bestUnplayed = q('select o.strength from public.franchise_opponents o where o.key not in'
  + ' (select opponent_key from public.franchise_games where franchise_id = ' + lit(C) + '::uuid and season_number = 1'
  + " and not championship) order by o.strength desc limit 1", true);
eq('the title opponent is the strongest club you never played, not a draw',
  q("select o.strength::text from public.franchise_games g join public.franchise_opponents o on o.key = g.opponent_key"
    + ' where g.id = ' + lit(bowlC) + '::uuid', true), bestUnplayed);
chk('scheduling it twice schedules one game',
  q('select public.franchise_schedule_bowl(' + lit(C) + "::uuid, 1, now())", true) === bowlC);
eq('and the record says a title was played for',
  q("select count(*) from public.franchise_activity where franchise_id = " + lit(C) + "::uuid and kind = 'title_bid'", true), '1');
const rule = qj('select public.franchise_championship(' + lit(SB) + ')');
chk('a club with a bowl but no title game is told the rule rather than shown a fake one',
  rule.scheduled === false && rule.earned === false && /ninth game/.test(rule.rule || ''), JSON.stringify(rule));

/* the pregame, which is not a bowl's pregame */
const pre = qj('select public.franchise_championship(' + lit(SC) + ')');
chk('the pregame carries both clubs, the path that got you here and the ratings',
  pre.scheduled === true && pre.played === false && pre.club.rating.overall > 0
  && pre.opponent.overall > 0 && Array.isArray(pre.path) && pre.path.length >= 8,
  JSON.stringify({ s: pre.scheduled, p: pre.path && pre.path.length }));
chk('it names the men playing by what they have done, and the game by where it turns',
  Array.isArray(pre.stars) && pre.key_matchup && /against/.test(pre.key_matchup.text) && /paper|level/.test(pre.edge),
  JSON.stringify(pre.key_matchup));
chk('the lineup is introduced', Array.isArray(pre.introductions) && pre.introductions.length >= 11
  && pre.introductions.every(i => i.name && i.position), (pre.introductions || []).length);
chk('the field is dressed for the title', pre.stadium && pre.stadium.dressing === 'title', JSON.stringify(pre.stadium));
chk('the award finalists shown are this season’s leaders, or none at all',
  Array.isArray(pre.finalists), JSON.stringify(pre.finalists));

/* ── 7-8. the man who won it, and the record of it ────────────────────── */
const men = q("select string_agg(id::text || '~' || first_name || ' ' || last_name || '~' || position || '~' || overall, '|')"
  + ' from (select * from public.game_players where franchise_id = ' + lit(C) + "::uuid and status = 'active'"
  + " and position in ('RB','WR') order by overall desc limit 2) x", true).split('|').map(s => s.split('~'));
const star = men[0], worker = men[1];
const box = JSON.stringify({
  final: { for: 31, against: 24 }, result: 'W',
  quarters: { for: [7, 7, 10, 7], against: [3, 7, 7, 7] }, scoring: [],
  players: [
    { id: star[0], name: star[1], position: star[2], jersey: 1, stats: { games: 1, car: 4, yds: 9, td: 0 }, impact: 0.75 },
    { id: worker[0], name: worker[1], position: worker[2], jersey: 2, stats: { games: 1, rec: 9, yds: 168, td: 3 }, impact: 23.2 }
  ]
});
chk('the best card in the game is the one with nothing to show for it',
  +star[3] > +worker[3], star[3] + ' vs ' + worker[3]);
q('update public.franchise_games set status = ' + lit('final') + ", played_at = now(), score_for = 31, score_against = 24,"
  + " result = 'W', box = " + lit(box) + '::jsonb where id = ' + lit(bowlC) + '::uuid', true);
const mvp = qj('select public.franchise_championship_mvp(' + lit(bowlC) + '::uuid)');
eq('the most valuable man is the man who played best', mvp.name, worker[1]);
chk('and the reason is what he did in the game', /168/.test(JSON.stringify(mvp.why)) && /box score/.test(mvp.basis),
  JSON.stringify(mvp.why));
chk('the man who did not win it is the higher-rated card', mvp.name !== star[1]);
chk('the MVP never consults an overall',
  q("select p.prosrc !~ 'overall' from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'franchise_championship_mvp'", true) === 't');

const post = qj('select public.franchise_championship(' + lit(SC) + ')');
chk('the postgame is the whistle, the headline, the celebration and the trophy',
  post.played === true && post.won === true && post.whistle === 'CHAMPIONS'
  && /31/.test(post.headline) && post.celebration.length >= 3 && post.trophy && post.trophy.name,
  JSON.stringify({ w: post.whistle, t: post.trophy && post.trophy.name }));
chk('with the man who won it, the season it capped, and the men who got you there',
  post.mvp && post.mvp.name === worker[1] && post.season_summary.record && Array.isArray(post.recognition),
  JSON.stringify(post.season_summary));
chk('the legacy line and the record book are written from the season, not composed',
  post.legacy && post.legacy.title === true && /champions/.test(post.legacy.line)
  && Array.isArray(post.record_book) && post.record_book.length >= 1,
  JSON.stringify(post.legacy));
eq('winning it is written into the record exactly once',
  q("select count(*) from public.franchise_activity where franchise_id = " + lit(C) + "::uuid and kind = 'title_win'", true), '1');
eq('and onto the wall exactly once',
  q("select count(*) from public.franchise_achievements where franchise_id = " + lit(C) + "::uuid and achievement_id = 'title_win'", true), '1');
chk('the record of it names the man who won it',
  q("select detail->>'mvp' from public.franchise_activity where franchise_id = " + lit(C)
    + "::uuid and kind = 'title_win'", true) === worker[1]);

/* ── the doors ────────────────────────────────────────────────────────── */
for (const fn of ['franchise_rankings_write(uuid)', 'franchise_awards_write(uuid)',
                  'franchise_power_rankings(uuid, integer)', 'franchise_award_races(uuid, integer)']) {
  eq('no client may write or compute ' + fn.split('(')[0] + ' for itself',
    q("select has_function_privilege('anon', 'public." + fn + "', 'execute')::text", true), 'false');
}
for (const fn of ['franchise_rankings(text)', 'franchise_awards(text)', 'franchise_championship(text)']) {
  eq('a page may read ' + fn.split('(')[0],
    q("select has_function_privilege('anon', 'public." + fn + "', 'execute')::text", true), 'true');
}
const other = qFail('select public.franchise_rankings(' + lit('device-secret-nobodyhereatallxxxxxxx') + ')');
chk('a secret that owns nothing is shown nothing', !other.ok || other.out === '' || other.out === 'null', other.out);

/* ── the snapshot does not double up ──────────────────────────────────── */
const before = q('select count(*) from public.franchise_rank_weeks where franchise_id = ' + lit(A) + '::uuid', true);
q('select public.franchise_rankings_write(' + lit(A) + '::uuid)', true);
q('select public.franchise_awards_write(' + lit(A) + '::uuid)', true);
eq('writing this week again replaces this week, it does not add one',
  q('select count(*) from public.franchise_rank_weeks where franchise_id = ' + lit(A) + '::uuid', true), before);

drop();
console.log((fail ? 'FAIL' : 'PASS') + ' | ' + LABEL + ' | ' + pass + ' passed, ' + fail + ' failed');
fails.forEach(l => console.log(l));
process.exit(fail ? 1 : 0);
