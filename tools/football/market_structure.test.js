#!/usr/bin/env node
/* ===========================================================================
   NFL MARKET STRUCTURE — the core (lib/edgedesk_market_structure.js), the
   builder (tools/football/build_market_structure.js) and the committed
   artifact (football/market_structure/nfl.json). No network, no database.

     node tools/football/market_structure.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const MS = require(path.join(ROOT, 'lib', 'edgedesk_market_structure.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_execution.js'));
const B = require(path.join(__dirname, 'build_market_structure.js'));

let pass = 0, fail = 0;
const failures = [], notes = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------- one list, not two */
{
  const cap = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts'), 'utf8');
  const m = /KEY_NUMBERS:\s*Record<string,\s*number\[\]>\s*=\s*\{\s*nfl:\s*\[([^\]]*)\]/.exec(cap);
  chk('KEY_NUMBERS = capture\'s KEY_NUMBERS.nfl (one list, not two)', m && eq(m[1].split(',').map((s) => Number(s.trim())), MS.KEY_NUMBERS), m && m[1]);
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'nfl_market_structure.sql'), 'utf8');
  chk('the SQL key list = the core\'s', sql.indexOf('unnest(array[' + MS.KEY_NUMBERS.join(', ') + '])') > 0);
}
{
  const ID = require(path.join(ROOT, 'lib', 'football_identity.js'));
  const teams = (ID.NFL_TEAMS || (ID._internal && ID._internal.NFL_TEAMS)) || null;
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'football_identity.js'), 'utf8');
  const rows = [...src.matchAll(/\['([A-Z]{2,3})',\s*'([^']+)',\s*\[([^\]]*)\]\]/g)].filter((r) => /^[A-Z]/.test(r[2]) && !/University|State|College/.test(r[2]));
  const nfl = rows.slice(0, 32);
  chk('lib/football_identity.js lists 32 NFL clubs', nfl.length === 32, nfl.length + (teams ? '' : ''));
  chk('every club there has a division here, under the same code and name', nfl.every((r) => { const d = MS.division(r[1]); return d && d.code === r[1] && d.name === r[2]; }),
    nfl.filter((r) => { const d = MS.division(r[1]); return !d || d.name !== r[2]; }).map((r) => r[1]));
  const codeAliases = [];
  nfl.forEach((r) => r[3].split(',').map((s) => s.trim().replace(/'/g, '')).filter((s) => /^[A-Z]{2,3}$/.test(s)).forEach((s) => codeAliases.push([s, r[1]])));
  chk('every old or alternate code there resolves to its club here', codeAliases.every(([a, c]) => MS.teamCode(a) === c), codeAliases.filter(([a, c]) => MS.teamCode(a) !== c));
  chk('32 clubs, 8 divisions of 4, 16 per conference', MS.DIVISIONS.length === 32
    && Object.values(MS.DIVISIONS.reduce((o, d) => { o[d[4]] = (o[d[4]] || 0) + 1; return o; }, {})).every((n) => n === 4)
    && MS.DIVISIONS.filter((d) => d[3] === 'AFC').length === 16);
  chk('nflverse spells the Rams LA', MS.teamCode('LA') === 'LAR' && MS.division('LA').division === 'NFC West');
  chk('a full name as the odds feed spells it resolves to its code', MS.codeOfName('Los Angeles Rams') === 'LAR' && MS.codeOfName('San Francisco 49ers') === 'SF' && MS.codeOfName('LA') === 'LAR' && MS.codeOfName('Nowhere FC') === null);
  chk('PHI-DAL is divisional; PHI-KC is not', MS.isDivisional('PHI', 'DAL') && !MS.isDivisional('PHI', 'KC') && !MS.isDivisional('PHI', 'PHI'));
}

/* ------------------------------------------------- margin frequency */
{
  const G = [
    { season: 2022, margin: 3, close: { home_line: -3 } },     /* home fav wins by 3 */
    { season: 2023, margin: -6, close: { home_line: 4.5 } },   /* away fav wins by 6 */
    { season: 2023, margin: 6, close: { home_line: 4.5 } },    /* dog (home) wins by 6: fav margin -6 */
    { season: 2024, margin: 0, close: { home_line: 0 } },      /* PK, a tie */
    { season: 2024, margin: 7, close: { home_line: null } },
    { season: 2024, margin: null, close: { home_line: -3 } }   /* unplayed */
  ];
  const f = MS.marginFrequency(G, MS.WINDOWS[0]);
  chk('abs counts every played game', f.abs.n_games === 5 && eq(f.abs.rows.map((r) => [r.margin, r.games]), [[0, 1], [3, 1], [6, 2], [7, 1]]), f.abs);
  chk('fav_signed: the favourite\'s margin, PK and lineless excluded and counted', f.fav_signed.n_games === 3 && f.fav_signed.excluded_pickem === 1 && f.fav_signed.excluded_no_line === 1
    && eq(f.fav_signed.rows.map((r) => [r.margin, r.games]), [[-6, 1], [3, 1], [6, 1]]), f.fav_signed);
  const r = MS.marginFrequency(G, MS.WINDOWS[1]);
  chk('the recent window starts in 2023', r.abs.n_games === 4 && r.first_season === 2023);
}

/* ------------------------------------------------- half point */
{
  const rows = [{ margin: -3, frequency: 0.05 }, { margin: 3, frequency: 0.09 }, { margin: 6, frequency: 0.04 }, { margin: 7, frequency: 0.06 }, { margin: 0, frequency: 0.002 }];
  const h6 = MS.halfPoint(rows, -6), h65 = MS.halfPoint(rows, -6.5), h55 = MS.halfPoint(rows, 5.5), p6 = MS.halfPoint(rows, 6);
  chk('-6 pushes on a six-point favourite win; a half either way moves that mass', h6.push_prob === 0.04 && h6.up.effect === 'push_to_win' && h6.up.win_change === 0.04
    && h6.down.effect === 'push_to_loss' && h6.down.loss_change === 0.04, h6);
  chk('-6.5 → -6 turns losses at 6 into pushes; -6.5 → -7 turns wins at 7 into pushes', h65.push_prob === 0 && h65.up.effect === 'loss_to_push' && h65.up.moved_mass === 0.04
    && h65.down.effect === 'win_to_push' && h65.down.moved_mass === 0.06, h65);
  chk('+5.5 → +6 turns the dog\'s losses at 6 into pushes', h55.up.effect === 'loss_to_push' && h55.up.moved_mass === 0.04 && h55.up.loss_change === -0.04);
  chk('+6 and -6 push on the same games', p6.push_prob === h6.push_prob);
  chk('PK pushes on a tie', MS.halfPoint(rows, 0).push_prob === 0.002);
  chk('a line is rounded to the half point it is quoted at', MS.halfPoint(rows, -6.2).line === -6);
  chk('no rows, no answer (never a zero)', MS.halfPoint([], -6) === null && MS.halfPoint(rows, null) === null);
  /* EDExecution.halfPointValue is the existing helper: the same answer away from PK */
  const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'market_structure', 'nfl.json'), 'utf8'));
  const W = A.margin_frequency.windows[0].fav_signed.rows, pw = MS.pushWinFrom(W);
  const bad = [];
  for (let L = -20; L <= 20; L += 0.5) {
    if (Math.abs(L) < 1) continue;
    const mine = MS.halfPoint(W, L);
    [['up', L + 0.5], ['down', L - 0.5]].forEach(([dir, to]) => {
      const o = X.halfPointValue(pw, 'x', L, to);
      if (!o || Math.abs(o.win_gain - mine[dir].win_change) > 1e-5 || Math.abs(o.half_push_gain - mine[dir].half_push_change) > 1e-5) bad.push({ L, dir, o, mine: mine[dir] });
    });
  }
  chk('halfPoint() = EDExecution.halfPointValue() on every half point -20..+20 away from PK', bad.length === 0, bad.slice(0, 3));
}

/* ------------------------------------------------- key numbers */
chk('-6.5 straddles 6 and 7 and is on the Six watch', eq(MS.keyContext(-6.5).straddles, [6, 7]) && MS.keyContext(-6.5).six_watch && MS.keyContext(-6.5).on.length === 0);
chk('+3 sits on 3', eq(MS.keyContext(3).on, [3]) && !MS.keyContext(3).six_watch);
chk('-5.5 and +6 are Six watch; -4.5 is not', MS.keyContext(-5.5).six_watch && MS.keyContext(6).six_watch && !MS.keyContext(-4.5).six_watch);
chk('capture\'s own examples: 2.5→3 [3], 3→3.5 [3], 6.5→7.5 [7], 4→4.5 []',
  eq(MS.keysCrossed(2.5, 3), [3]) && eq(MS.keysCrossed(3, 3.5), [3]) && eq(MS.keysCrossed(6.5, 7.5), [7]) && eq(MS.keysCrossed(4, 4.5), []));
chk('an unchanged number touches nothing; through PK (-3.5 → +3.5) touches 3', eq(MS.keysCrossed(-3, -3), []) && eq(MS.keysCrossed(-3.5, 3.5), [3]));
chk('a snapshot move of a full point is flagged; half a point onto a key is flagged; half a point in space is not',
  MS.snapshotDelta(-2, -3).flagged && MS.snapshotDelta(-5.5, -6).flagged && !MS.snapshotDelta(-4, -4.5).flagged && MS.snapshotDelta(-4, -4.5).delta === -0.5);
chk('the move says which side it went toward', MS.snapshotDelta(-3, -4).toward === 'home' && MS.snapshotDelta(-3, -2).toward === 'away' && MS.snapshotDelta(-3, -3).toward === null);

/* ------------------------------------------------- situations */
{
  const s = MS.sides({ home: 'PHI', away: 'DAL', home_line: 3 });
  chk('a divisional home dog is named on the home side only', s.home.divisional_home_dog && !s.away.divisional_home_dog && s.home.role === 'underdog' && s.away.role === 'favorite');
  chk('its buckets', eq(s.home.buckets, ['underdogs', 'home_underdogs', 'divisional_underdogs', 'divisional_home_underdogs']) && eq(s.away.buckets, ['favorites', 'road_favorites', 'divisional_favorites']));
  const n = MS.sides({ home: 'JAX', away: 'KC', home_line: -2.5, neutral: true });
  chk('a neutral site has no home team', n.home.venue === 'neutral' && n.away.venue === 'neutral' && eq(n.home.buckets, ['favorites', 'neutral_favorites']));
  chk('no line: no role, no bucket (never a guess)', MS.sides({ home: 'PHI', away: 'DAL', home_line: null }).home.role === null && MS.sides({ home: 'PHI', away: 'DAL' }).home.buckets.length === 0);
  const games = [
    { season: 2026, date: '2026-09-13', home: 'PHI', away: 'DAL', margin: 7, close: { home_line: 3 } },    /* home dog covers (and wins) */
    { season: 2026, date: '2026-09-20', home: 'KC', away: 'DEN', margin: 3, close: { home_line: -3 } },    /* push */
    { season: 2026, date: '2026-09-27', home: 'NYJ', away: 'BUF', margin: -10, close: { home_line: 6.5 } },/* div home dog fails */
    { season: 2025, date: '2025-09-27', home: 'NYJ', away: 'BUF', margin: 10, close: { home_line: 6.5 } }  /* other season */
  ];
  const b = MS.atsBuckets(games, { season: 2026 });
  chk('ATS: 3 games, through the last date', b.n_games === 3 && b.through === '2026-09-27');
  chk('ATS: divisional home dogs 1-1, rate 50% with an interval', eq([b.buckets.divisional_home_underdogs.w, b.buckets.divisional_home_underdogs.l, b.buckets.divisional_home_underdogs.p], [1, 1, 0])
    && b.buckets.divisional_home_underdogs.cover_rate === 0.5 && b.buckets.divisional_home_underdogs.ci95[0] < 0.5, b.buckets.divisional_home_underdogs);
  chk('ATS: the push is a push for both sides and never in the rate', b.buckets.home_favorites.p === 1 && b.buckets.road_underdogs.p === 1 && b.buckets.home_favorites.cover_rate === null);
  chk('ATS: favourites and underdogs mirror each other', b.buckets.favorites.w === b.buckets.underdogs.l && b.buckets.favorites.l === b.buckets.underdogs.w);
}

/* ------------------------------------------------- two-point */
{
  const rows = [
    { game_id: 'g1', season: '2026', week: '1', season_type: 'REG', play_type: 'extra_point', extra_point_attempt: '1' },
    { game_id: 'g1', season: '2026', week: '1', season_type: 'REG', play_type: 'pass', two_point_attempt: '1', two_point_conv_result: 'success' },
    { game_id: 'g1', season: '2026', week: '1', season_type: 'REG', play_type: 'no_play', two_point_attempt: '1' },
    { game_id: 'g2', season: '2026', week: '1', season_type: 'REG', play_type: 'run', touchdown: '1' },
    { game_id: 'g2', season: '2026', week: '1', season_type: 'REG', play_type: 'run', two_point_attempt: '1', two_point_conv_result: 'failure' }
  ];
  const w = B.reduceTries(rows);
  chk('tries per week: no_play excluded, made counted, games distinct', w.length === 1 && w[0].games === 2 && w[0].two_pt_att === 2 && w[0].two_pt_made === 1 && w[0].xp_att === 1 && w[0].touchdowns === 1 && w[0].share === 0.6667, w);
  const S = MS.twoPointSeries([
    { season: 2023, xp_att: 900, two_pt_att: 100 }, { season: 2024, xp_att: 900, two_pt_att: 100 }, { season: 2025, xp_att: 900, two_pt_att: 100 },
    { season: 2026, xp_att: 300, two_pt_att: 100 }], { current_season: 2026 });
  chk('drift: 25% against a 10% baseline is RISING', S.drift && S.drift.status === 'RISING' && S.drift.baseline_share === 0.1 && S.drift.share === 0.25 && S.drift.z > 2, S.drift);
}

/* ------------------------------------------------- the committed artifact */
{
  const A = JSON.parse(fs.readFileSync(B.OUT, 'utf8'));
  const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8'));
  chk('artifact schema', A.schema === B.SCHEMA && A.engine === MS.VERSION);
  A.margin_frequency.windows.forEach((w) => {
    ['abs', 'fav_signed'].forEach((b) => {
      const s = w[b].rows.reduce((t, r) => t + r.frequency, 0), g = w[b].rows.reduce((t, r) => t + r.games, 0);
      chk('window ' + w.window_label + ' ' + b + ': shares sum to 1 and games to n', Math.abs(s - 1) < 1e-4 && g === w[b].n_games, { s, g, n: w[b].n_games });
    });
    chk('window ' + w.window_label + ': fav-signed + PK + no line = every game', w.fav_signed.n_games + w.fav_signed.excluded_pickem + w.fav_signed.excluded_no_line === w.abs.n_games);
  });
  /* the archive the artifact was built from is the one committed: rebuilding
     the windows from it needs no network and must agree */
  const played = L.games.filter((g) => typeof g.margin === 'number');
  const again = MS.WINDOWS.map((w) => MS.marginFrequency(played, w));
  const same = again.every((f, i) => eq(f.fav_signed.rows, A.margin_frequency.windows[i].fav_signed.rows) && eq(f.abs.rows, A.margin_frequency.windows[i].abs.rows));
  if (A.source.lines.generated_at === L.generated_at)
    chk('the margin windows match the line archive they were built from (rebuild with build_market_structure.js if this fails)', same);
  else if (!same)
    notes.push('NOTE | the line archive (' + L.generated_at + ') is newer than the artifact (built from ' + A.source.lines.generated_at + '): injury-sync.yml and nfl-market-structure.yml rebuild it');
  const yrs = A.two_point.seasons.map((s) => s.season);
  chk('two-point seasons run from 2015 to the season in progress, none missing', yrs[0] === B.FIRST_TRY_SEASON && yrs.every((y, i) => y === B.FIRST_TRY_SEASON + i) && A.two_point.missing.length === 0, { yrs, missing: A.two_point.missing });
  chk('two-point shares are plausible (3% to 20% a season)', A.two_point.seasons.every((s) => s.share > 0.03 && s.share < 0.2));
  chk('the drift block names its rule and baseline', A.two_point.drift && A.two_point.drift.baseline_seasons.length === 3 && /descriptive/i.test(A.two_point.drift.rule));
  chk('the division table agrees with the feed\'s div_game on every game of the season', A.situational.division_check.checked > 0 && A.situational.division_check.mismatches.length === 0, A.situational.division_check);
  const bk = A.situational.ats.buckets;
  chk('ATS buckets mirror (favourites W = underdogs L) and carry samples', bk.favorites.w === bk.underdogs.l && bk.favorites.l === bk.underdogs.w && bk.favorites.n > 0);
  chk('every ATS bucket carries n and an interval when it has a sample', MS.BUCKETS.every((k) => bk[k] && typeof bk[k].n === 'number' && (bk[k].w + bk[k].l === 0 || Array.isArray(bk[k].ci95))));
  chk('every game of the season carries venue and division flags', Object.values(A.situational.games).every((g) => typeof g.neutral === 'boolean' && typeof g.divisional === 'boolean'));
  chk('the artifact says what it is not', /nothing here is a model/i.test(A.tier) && /no projection/i.test(A.note));
}

/* ------------------------------------------------- the cron file */
{
  const C = fs.readFileSync(path.join(ROOT, 'supabase', 'nfl_market_structure_cron.sql'), 'utf8');
  chk('cron file: no psql meta-command', !/^\s*\\/m.test(C));
  chk('cron file: idempotent (unschedules before it schedules) and ends in a report', /cron\.unschedule[\s\S]*cron\.schedule[\s\S]*THE REPORT/.test(C));
  chk('cron file: Thursday through the UTC afternoon covers 13:00 ET in both EDT (17Z) and EST (18Z)', /'\*\/15 16-23 \* \* 4'/.test(C));
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
notes.forEach((n) => console.log(n));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
