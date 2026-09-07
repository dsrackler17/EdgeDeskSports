/* ===========================================================================
   GRIDIRON — THINGS THAT CANNOT BE TRUE.

   One list of football and arithmetic facts, checked against a finished game.
   Not tuning, not taste: every entry here is something that would mean the
   engine had lied about what happened, and the only correct number of them is
   nought — in a unit test, in ten thousand simulated games, and in a game a
   person just played on a phone.

   It is separate from the test that runs it because three callers need it:

     gridiron.test.js       a handful of games, every commit
     gridiron_sim.test.js   ten thousand games, the statistical harness
     the game itself        a development diagnostic behind a flag

   ── HARD versus SOFT ──────────────────────────────────────────────────────
   `violations` are impossible. A completion that was not an attempt; a score
   that moved without a scoring event; fourth and negative eleven.

   `anomalies` are merely astonishing — nine sacks, four hundred yards of
   offence for one team and forty for the other, a game with no pass attempts
   in it. Real football produces every one of these occasionally, so they are
   counted and reported rather than failed. What fails is a RATE: if one game
   in twenty has nine sacks in it, that is not variance, that is a bug.
   =========================================================================== */
'use strict';

/* ── ONE FINISHED GAME ────────────────────────────────────────────────────
   `g` is the engine's game object, `box` its box score. Returns
   { violations: [string], anomalies: [string] }. */
function check(G, g, box) {
  const V = [], A = [];
  const bad = (s) => V.push(s);
  const odd = (s) => A.push(s);
  const sides = ['home', 'away'];

  /* ── THE SCORE ──────────────────────────────────────────────────────────
     It only ever moves through a scoring event, and only by the points that
     event is worth. Replaying the log has to land exactly on the final. */
  const WORTH = { touchdown: 6, 'kick return': 6, 'extra point': 1, 'two-point': 2,
                  'field goal': 3, safety: 2 };
  let h = 0, a = 0, tds = 0, tries = 0;
  (g.log || []).forEach((e) => {
    if (e.kind === 'pat') tries++;
    if (e.kind !== 'score') return;
    const want = WORTH[e.how];
    if (want == null) bad('unknown scoring event "' + e.how + '"');
    else if (e.points !== want) bad(e.how + ' scored ' + e.points + ', not ' + want);
    if (e.side === 'home') h += e.points; else a += e.points;
    if (e.how === 'touchdown' || e.how === 'kick return') tds++;
  });
  if (h !== g.score.home || a !== g.score.away) {
    bad('the score log says ' + h + '-' + a + ' and the scoreboard says '
        + g.score.home + '-' + g.score.away);
  }
  /* every touchdown gets a try. There is no such thing as a touchdown that
     the clock takes the extra point away from. */
  if (tries !== tds) bad(tds + ' touchdowns but ' + tries + ' tries');
  if (g.pendingScore) bad('the game ended with a try still pending');

  /* ── THE STATE ──────────────────────────────────────────────────────────── */
  if (!g.over) bad('the game is not over');
  if (g.phase !== 'final') bad('the game ended in phase "' + g.phase + '"');
  if (g.possession !== 'home' && g.possession !== 'away') bad('nobody has the ball');
  if (!(g.ball >= 0 && g.ball <= 100)) bad('the ball is at ' + g.ball);
  if (!(g.down >= 1 && g.down <= 4)) bad('it is ' + g.down + ' down');
  if (!(g.toGo >= 0 && g.toGo <= 100)) bad(g.toGo + ' to go');
  if (!(g.clock >= 0 && g.clock <= g.cfg.quarterSeconds)) bad('the clock reads ' + g.clock);
  if (g.quarter < 1) bad('quarter ' + g.quarter);
  sides.forEach((s) => {
    if (!(g.timeouts[s] >= 0 && g.timeouts[s] <= 3)) bad(s + ' has ' + g.timeouts[s] + ' timeouts');
  });

  /* ── THE BOOKS ──────────────────────────────────────────────────────────
     The stat model is stated once in engine.js and asserted here. Sacks are
     not attempts, team passing is net of them, and both team totals are the
     sum of the men who produced them. */
  sides.forEach((s) => {
    const st = g.stats[s], b = box[s];
    const nz = (k) => { if (st[k] < 0) bad(s + ' has ' + st[k] + ' ' + k); };
    ['plays', 'att', 'comp', 'sacks', 'carries', 'ints', 'fumblesLost', 'firstDowns',
     'thirdAtt', 'thirdConv', 'fourthAtt', 'fourthConv', 'redzoneAtt', 'redzoneTD',
     'explosive', 'drives', 'punts', 'fgAtt', 'fgMade', 'sackYards'].forEach(nz);

    if (st.comp > st.att) bad(s + ': ' + st.comp + ' completions on ' + st.att + ' attempts');
    if (st.ints > st.att) bad(s + ': ' + st.ints + ' interceptions on ' + st.att + ' attempts');
    if (st.comp + st.ints > st.att) {
      bad(s + ': completions plus interceptions exceed attempts');
    }
    if (st.thirdConv > st.thirdAtt) bad(s + ': more third downs converted than faced');
    if (st.fourthConv > st.fourthAtt) bad(s + ': more fourth downs converted than faced');
    if (st.redzoneTD > st.redzoneAtt) bad(s + ': more red zone touchdowns than trips');
    if (st.fgMade > st.fgAtt) bad(s + ': more field goals made than attempted');
    if (st.yards !== st.passYards + st.rushYards) {
      bad(s + ': ' + st.yards + ' total yards, but ' + st.passYards + ' passing plus '
          + st.rushYards + ' rushing');
    }
    if (st.passYards !== st.passYardsGross - st.sackYards) {
      bad(s + ': net passing does not equal gross passing minus sack yardage');
    }
    /* a sack at the line of scrimmage loses nothing, and that is a real
       football result; sack yardage that is negative is not */
    if (st.sackYards < 0) bad(s + ': ' + st.sackYards + ' sack yardage');
    if (st.plays < st.att + st.carries + st.sacks) {
      bad(s + ': fewer plays than attempts, carries and sacks together');
    }
    if (st.top < 0) bad(s + ': negative time of possession');
    /* the box score is a view of the stats, never a second tally */
    if (b.score !== g.score[s]) bad(s + ': the box score disagrees with the scoreboard');
    if (b.sacks !== g.stats[s === 'home' ? 'away' : 'home'].sacks) {
      bad(s + ': the sacks column is not the other side\'s sacks allowed');
    }

    /* ── THE MEN ADD UP TO THE TEAM ──────────────────────────────────────
       If this fails, no player line in the game means anything. */
    const men = G.playersOf(g, s);
    const sum = (k) => men.reduce((t, p) => t + (p[k] || 0), 0);
    if (sum('ry') !== st.rushYards) {
      bad(s + ': rushers gained ' + sum('ry') + ', team rushing says ' + st.rushYards);
    }
    if (sum('recy') !== st.passYardsGross) {
      bad(s + ': receivers gained ' + sum('recy') + ', gross passing says ' + st.passYardsGross);
    }
    if (sum('car') !== st.carries) bad(s + ': carries do not add up');
    if (sum('rec') !== st.comp) bad(s + ': receptions do not add up');
    if (sum('pa') !== st.att) bad(s + ': attempts do not add up');
    if (sum('pc') !== st.comp) bad(s + ': completions do not add up');
    if (sum('rtd') + sum('rectd') !== st.rushTD + st.passTD) {
      bad(s + ': touchdown credit does not match the team');
    }
    men.forEach((p) => {
      if (p.pc > p.pa) bad(s + ': ' + p.name + ' completed more than he threw');
      if (p.rec > p.targets) bad(s + ': ' + p.name + ' caught more than he was thrown');
      if (p.side !== s) bad(s + ': ' + p.name + ' is filed under ' + p.side);
    });
  });

  /* ── THE DRIVES ─────────────────────────────────────────────────────────
     Every drive that started is a drive that finished, and the two counts
     agree. A drive dropped on the floor at the half is how time of possession
     stopped adding up. */
  sides.forEach((s) => {
    const listed = (g.drives || []).filter((d) => d.side === s).length;
    if (listed !== g.stats[s].drives) {
      bad(s + ': started ' + g.stats[s].drives + ' drives, the chart shows ' + listed);
    }
  });
  (g.drives || []).forEach((d, i) => {
    if (!d.outcome) bad('drive ' + (i + 1) + ' has no outcome');
    if (d.plays < 0 || d.seconds < 0) bad('drive ' + (i + 1) + ' has negative plays or seconds');
    if (!(d.start >= 0 && d.start <= 100)) bad('drive ' + (i + 1) + ' started at ' + d.start);
  });

  /* ── THE PLAY-BY-PLAY ───────────────────────────────────────────────────── */
  (g.plays || []).forEach((p, i) => {
    if (p.side !== 'home' && p.side !== 'away') bad('play ' + (i + 1) + ' belongs to nobody');
    if (p.q < 1) bad('play ' + (i + 1) + ' is in quarter ' + p.q);
    if (!p.text) bad('play ' + (i + 1) + ' has no commentary');
    if (p.down != null && !(p.down >= 1 && p.down <= 4)) {
      bad('play ' + (i + 1) + ' was on ' + p.down + ' down');
    }
  });

  /* ── WORTH A SECOND LOOK ─────────────────────────────────────────────────
     Real football does all of these; it does not do them often. */
  sides.forEach((s) => {
    const st = g.stats[s], drops = st.att + st.sacks;
    if (st.sacks >= 9) odd('sacks:' + st.sacks);
    if (drops >= 12 && st.sacks / drops > 0.30) odd('sackRate');
    if (st.yards < 60) odd('yards:' + st.yards);
    if (st.yards < 0) odd('negativeYards');
    if (st.att === 0 && st.plays >= 20) odd('zeroPassGame');
    if (st.carries === 0 && st.plays >= 20) odd('zeroRunGame');
    if (st.ints + st.fumblesLost >= 6) odd('turnovers:' + (st.ints + st.fumblesLost));
    if (st.drives > 0 && g.score[s] / st.drives > 4.8) odd('pointsPerDrive');
    if (g.score[s] >= 60) odd('score:' + g.score[s]);
  });
  if (Math.abs(g.score.home - g.score.away) >= 45) odd('blowout');

  return { violations: V, anomalies: A };
}

module.exports = { check: check };
