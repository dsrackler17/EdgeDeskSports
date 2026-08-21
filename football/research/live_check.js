/* Operational integration check: replicates the Football module's runtime
   data path with REAL live fetches (nflverse + cfbfastR-data), then runs the
   engine end to end. Network-dependent by design — run it before shipping a
   params regen, not in CI. Node 18+.

   Usage: node football/research/live_check.js
   Exit 0 = the live pipeline produced sane, gated output. */
const P = require('../params.js');
const E = require('../engine.js');

function csv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const hd = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(hd.map((h, i) => [h, (r[i] === '' || r[i] === 'NA') ? null : r[i]])));
}
const num = x => { const v = +x; return isFinite(v) ? v : null; };

(async () => {
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (ok ? '' : ' | ' + detail));
    if (!ok) failures++;
  };

  // ---- NFL: schedule + state build, exactly as the app module does ----
  const gtxt = await (await fetch('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv')).text();
  const games = csv(gtxt);
  const maxSeason = Math.max(...games.map(g => num(g.season) || 0));
  check('games.csv fetched', games.length > 7000, games.length);
  const st = E.nfl.newState();
  for (let y = st.seededThrough; y < maxSeason; y++) E.nfl.seasonBreak(st);
  check('season gap within supported window', maxSeason <= st.seededThrough + 1,
    maxSeason + ' vs seeds ' + st.seededThrough);

  let absorbed = 0;
  const toAbsorb = games.filter(g => num(g.season) > st.seededThrough && g.home_score != null);
  if (toAbsorb.length) {
    for (const y of [...new Set(toAbsorb.map(g => num(g.season)))]) {
      const r = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${y}.csv`);
      if (!r.ok) { console.log('note | stats_team_week_' + y + ' not published (' + r.status + ') — results not absorbed'); continue; }
      const byGame = {};
      csv(await r.text()).forEach(x => (byGame[x.game_id] = byGame[x.game_id] || []).push(x));
      toAbsorb.filter(g => num(g.season) === y)
        .sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)))
        .forEach(g => {
          const pair = byGame[g.game_id]; if (!pair || pair.length !== 2) return;
          const hRow = pair.find(x => x.team === g.home_team), aRow = pair.find(x => x.team === g.away_team);
          if (!hRow || !aRow) return;
          const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
          hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score);
          ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
          E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
          absorbed++;
        });
    }
  }
  console.log('note | absorbed ' + absorbed + ' completed post-seed games');

  const next = games.filter(g => num(g.season) === maxSeason && g.home_score == null)
    .sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)))[0];
  check('an upcoming game exists in the schedule', !!next, 'none');
  if (next) {
    const p = E.predictGame({ sport: 'nfl', state: st, season: num(next.season),
      game: { home: next.home_team, away: next.away_team, week: num(next.week),
        home_rest: num(next.home_rest), away_rest: num(next.away_rest),
        roof: next.roof, surface: next.surface, div_game: num(next.div_game) },
      market: { spread_line: num(next.spread_line), total_line: num(next.total_line) } });
    check('live predictGame PREDICTED', p.status === 'PREDICTED', JSON.stringify(p).slice(0, 200));
    if (p.status === 'PREDICTED') {
      console.log('note | ' + next.away_team + ' @ ' + next.home_team + ' (' + next.gameday + '): fair '
        + p.model.fair_spread.toFixed(1) + ' / total ' + p.model.fair_total.toFixed(1)
        + ' / p(home) ' + (p.model.home_win_prob * 100).toFixed(0) + '%'
        + (num(next.spread_line) != null ? (' | market ' + next.spread_line + ' gap ' + p.market.spread_gap.toFixed(1)) : ' | no line yet'));
      check('sane ranges', Math.abs(p.model.fair_spread) < 30 && p.model.fair_total > 25 && p.model.fair_total < 70,
        p.model.fair_spread + '/' + p.model.fair_total);
      check('edge stays honest', ['PASS', 'RESEARCH_LEAN', 'NO_MARKET'].indexOf(p.edge.spread.recommendation) >= 0
        && p.edge.spread.validated === false, JSON.stringify(p.edge.spread));
    }
  }

  // ---- CFB: schedule for the current season (404 => honest gate) ----
  const nowY = new Date().getFullYear(), m = new Date().getMonth();
  const cur = (m <= 1) ? nowY - 1 : nowY;
  const cst = E.cfb.newState();
  for (let y = cst.seededThrough; y < cur; y++) E.cfb.seasonBreak(cst);
  const cr = await fetch(`https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${cur}.csv`);
  if (!cr.ok) {
    console.log('note | cfb_schedules_' + cur + ' not published yet (' + cr.status + ') — module gates, ratings board only');
    const q = E.dataQuality('cfb', { state: cst, game: { home: 'Georgia', away: 'Alabama' }, season: cur });
    check('CFB gate path still predicts nothing false', q.status === 'OK' || q.status === 'BLOCKED', q.status);
  } else {
    const sched = csv(await cr.text());
    let cAbs = 0;
    sched.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).forEach(g => {
      const hF = g.home_division === 'fbs', aF = g.away_division === 'fbs';
      if (!hF && !aF) return;
      if (String(g.completed).toUpperCase() === 'TRUE' && g.home_points != null) {
        E.cfb.absorb(cst, g.home_team, g.away_team, hF, aF,
          String(g.neutral_site).toUpperCase() === 'TRUE',
          num(g.home_points) - num(g.away_points), num(g.home_points), num(g.away_points));
        cAbs++;
      }
    });
    console.log('note | absorbed ' + cAbs + ' completed ' + cur + ' CFB games');
    const up = sched.find(g => g.home_division === 'fbs' && g.away_division === 'fbs' && g.home_points == null);
    if (up) {
      const p = E.predictGame({ sport: 'cfb', state: cst, season: cur,
        game: { home: up.home_team, away: up.away_team, home_fbs: true, away_fbs: true,
          neutral_site: String(up.neutral_site).toUpperCase() === 'TRUE' } });
      check('CFB live predictGame', p.status === 'PREDICTED', JSON.stringify(p).slice(0, 200));
      if (p.status === 'PREDICTED')
        console.log('note | ' + up.away_team + ' @ ' + up.home_team + ': fair ' + p.model.fair_spread.toFixed(1)
          + (p.model.fair_total != null ? ' / total ' + p.model.fair_total.toFixed(1) : ''));
    }
  }

  console.log(failures === 0 ? 'LIVE CHECK GREEN' : ('LIVE CHECK FAILURES: ' + failures));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('LIVE CHECK ERROR', e); process.exit(1); });
