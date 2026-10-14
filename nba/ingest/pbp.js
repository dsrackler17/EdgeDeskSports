'use strict';
/* ===========================================================================
   EdgeDesk NBA — one game's play-by-play in, the derived tables out.

   Pure and offline (tools/nba/nba.test.js exercises it on fixtures):

     processGame(rawRows, ctx) → {
       periods:  [{ p, h, a }]           points scored in each period (from the
                                          running score, so a missed scoring flag
                                          cannot lose a point)
       final:    { h, a }                the play-by-play's own final
       stints:   [{ t0, t1, h5, a5, hp, ap, hfga, afga, hfta, afta, hor, aor, htov, atov, ok }]
       shots:    [{ per, t, tm, sh, mk, v, ast, blk, x, y, d, ty, tr, lead }]
       team:     { [teamId]: { fga, fgm, fg3a, fg3m, fta, ftm, oreb, tov, rim_a, rim_m, paint_a, paint_m,
                               mid_a, mid_m, c3_a, c3_m, ab3_a, ab3_m, tr_a, tr_pts, heave } }
       onCourt:  Map(playerId → seconds)  from the reconstructed lineups
       spread:   { line_home, available } ESPN's displayed spread, UNTIMESTAMPED
       issues:   { sub_errors, bad_lineup_seconds, total_seconds, period_inferred_fills, ... }
     }

   LINEUPS. The source records substitutions but not who starts periods 2+.
   Period 1 starts with the box score's five starters. For a later period a
   player was on the floor at its start when his first appearance in the period
   is anything other than entering as a substitute (he is subbed out, shoots,
   fouls, rebounds); a player whose first appearance is entering was not. A
   five that is still short (a player who did nothing all period) is completed
   from the previous period's closing five, then by box-score minutes. A stint
   whose five is not exactly five is kept, flagged `ok: 0`, and excluded from
   player-impact fitting; its share of game time is reported per season.

   POSSESSIONS within a stint use the box-score estimator on the stint's own
   counts: FGA − OREB + TOV + 0.44·FTA, per side (Oliver 2004; the NBA's own
   POSS definition is the same family). Offensive TEAM rebounds (no player:
   mostly dead-ball rebounds after a missed first free throw) are not OREB.

   SHOTS. Distance from the description ("24-foot") when present, else from
   coordinates (ESPN's x runs the court's length in feet from centre, so the
   rim sits at |x| = 41.75, y = 0). `tr` (transition proxy): the shot came
   within 7 seconds of the shooting team gaining the ball by a defensive
   rebound, a steal or an opponent's turnover. `lead` is the shooting team's
   margin before the shot. Assists and blocks are outcomes, never features.
   =========================================================================== */

const PERIOD = 720, OT = 300, REG = 2880;
const perStart = (p) => (p <= 4 ? (p - 1) * PERIOD : REG + (p - 5) * OT);
const perLen = (p) => (p <= 4 ? PERIOD : OT);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v) => v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1';
const id = (v) => { const n = num(v); return n == null || n <= 0 ? null : String(Math.round(n)); };

const RE_FT = /^Free Throw/;
const RE_TOV = /Turnover|Traveling/;
const RE_THREE = /three point|3-pt|3pt/i;
const RE_FOOT = /(\d+)-foot/;

/** shot family from ESPN's shot type (pre-shot description, not an outcome) */
function shotFamily(type) {
  const t = String(type || '').toLowerCase();
  if (/heave/.test(t)) return 'heave';
  if (/tip|putback/.test(t)) return 'putback';
  if (/alley oop/.test(t)) return 'alley_oop';
  if (/dunk/.test(t)) return 'dunk';
  if (/layup|finger roll/.test(t)) return /driving|running|cutting/.test(t) ? 'layup_move' : 'layup';
  if (/hook/.test(t)) return 'hook';
  if (/floating/.test(t)) return 'floater';
  if (/step back/.test(t)) return 'stepback';
  if (/fade/.test(t)) return 'fadeaway';
  if (/turnaround/.test(t)) return 'turnaround';
  if (/pullup|running jump|driving jump/.test(t)) return 'pullup';
  if (/jump shot|jumper|bank/.test(t)) return 'jumper';
  return 'other';
}

function normalise(rows) {
  const out = [];
  for (const r of rows) {
    const per = num(r.period_number);
    if (per == null || per < 1) continue;
    const cm = num(r.clock_minutes), cs = num(r.clock_seconds);
    let clk = cm == null || cs == null ? null : cm * 60 + cs;
    if (clk == null) continue;
    clk = Math.max(0, Math.min(perLen(per), clk));
    const type = String(r.type_text || '').replace(/\s+/g, ' ').trim();
    const x = num(r.coordinate_x), y = num(r.coordinate_y);
    out.push({
      seq: num(r.sequence_number) || 0, tid: num(r.type_id), type, text: String(r.text || ''), per,
      t: perStart(per) + perLen(per) - clk, hs: num(r.home_score), as: num(r.away_score),
      scoring: truthy(r.scoring_play), val: num(r.score_value) || 0, shooting: truthy(r.shooting_play),
      team: id(r.team_id), a1: id(r.athlete_id_1), a2: id(r.athlete_id_2), a3: id(r.athlete_id_3),
      x: x != null && Math.abs(x) <= 50 ? x : null, y: y != null && Math.abs(y) <= 30 ? y : null,
    });
  }
  out.sort((a, b) => a.per - b.per || a.t - b.t || a.seq - b.seq);
  return out;
}

function shotDistance(e) {
  const m = RE_FOOT.exec(e.text);
  if (m) return Number(m[1]);
  if (e.x != null && e.y != null) return Math.round(Math.sqrt(Math.pow(Math.abs(e.x) - 41.75, 2) + e.y * e.y));
  return null;
}

function zoneOf(d, three, x, y) {
  if (three) {
    if (y != null && x != null && Math.abs(y) >= 21.5 && Math.abs(Math.abs(x) - 41.75) <= 14) return 'c3';
    return 'ab3';
  }
  if (d == null) return 'mid';
  if (d <= 4) return 'rim';
  if (d <= 14) return 'paint';
  return 'mid';
}

function emptyTeam() {
  return { fga: 0, fgm: 0, fg3a: 0, fg3m: 0, fta: 0, ftm: 0, oreb: 0, dreb: 0, tov: 0, pts: 0,
    rim_a: 0, rim_m: 0, paint_a: 0, paint_m: 0, mid_a: 0, mid_m: 0, c3_a: 0, c3_m: 0, ab3_a: 0, ab3_m: 0, tr_a: 0, tr_pts: 0, heave: 0 };
}

/**
 * ctx: { home, away (team ids as strings), roster: Map(pid → teamId),
 *        starters: { [teamId]: [pid…] }, minutes: Map(pid → box minutes) }
 */
function processGame(rawRows, ctx) {
  const ev = normalise(rawRows);
  const home = String(ctx.home), away = String(ctx.away);
  const roster = ctx.roster || new Map();
  const teamOf = (pid, fallback) => (pid && roster.has(pid) ? roster.get(pid) : fallback || null);
  const issues = { events: ev.length, sub_errors: 0, bad_lineup_seconds: 0, total_seconds: 0, period_inferred_fills: 0, period_overfull: 0, starters_bad: 0, unknown_team_events: 0 };
  const team = { [home]: emptyTeam(), [away]: emptyTeam() };
  const shots = [];

  /* period scores from the running score */
  const lastScore = new Map();
  for (const e of ev) if (e.hs != null && e.as != null) lastScore.set(e.per, { h: e.hs, a: e.as });
  const pers = [...new Set(ev.map((e) => e.per))].sort((a, b) => a - b);
  const periods = []; let ph = 0, pa = 0;
  for (const p of pers) { const s = lastScore.get(p); if (!s) continue; periods.push({ p, h: s.h - ph, a: s.a - pa }); ph = s.h; pa = s.a; }
  const final = { h: ph, a: pa };

  /* ESPN's displayed spread (untimestamped; no book named) */
  let spread = { line_home: null, available: false };
  for (const r of rawRows) {
    if (truthy(r.game_spread_available) && num(r.home_team_spread) != null) { spread = { line_home: -num(r.home_team_spread), available: true }; break; }
  }

  /* lineups and stints */
  const starters = ctx.starters || {};
  const onCourt = new Map();
  const stints = [];
  const on = { [home]: new Set(), [away]: new Set() };
  let prevEnd = { [home]: [], [away]: [] };
  const minutes = ctx.minutes || new Map();

  function inferPeriodStart(p, pevs) {
    for (const tm of [home, away]) {
      if (p === 1 && starters[tm] && starters[tm].length === 5) { on[tm] = new Set(starters[tm]); continue; }
      if (p === 1) issues.starters_bad++;
      const seen = new Map(); const order = [];
      const mark = (pid, s) => { if (!pid || seen.has(pid) || teamOf(pid) !== tm) return; seen.set(pid, s); order.push(pid); };
      for (const e of pevs) {
        if (e.type === 'Substitution') { mark(e.a2, 'start'); mark(e.a1, 'bench'); }
        else if (!/Timeout|Technical|Ejection|Delay|No Ejection|End |Start /.test(e.type)) { mark(e.a1, 'start'); mark(e.a2, 'start'); mark(e.a3, 'start'); }
      }
      let five = order.filter((pid) => seen.get(pid) === 'start');
      if (five.length < 5) {
        issues.period_inferred_fills++;
        const cands = (prevEnd[tm] || []).filter((pid) => !seen.has(pid));
        for (const pid of cands) if (five.length < 5) five.push(pid);
        if (five.length < 5) {
          const pool = [...roster.entries()].filter(([pid, t]) => t === tm && !seen.has(pid) && five.indexOf(pid) < 0).map(([pid]) => pid)
            .sort((a, b) => (minutes.get(b) || 0) - (minutes.get(a) || 0));
          for (const pid of pool) if (five.length < 5) five.push(pid);
        }
      }
      if (five.length > 5) { issues.period_overfull++; five = five.slice(0, 5); }
      on[tm] = new Set(five);
    }
  }

  let cur = null;
  function open(t) {
    cur = { t0: t, t1: t, h5: [...on[home]].sort(), a5: [...on[away]].sort(), hp: 0, ap: 0, hfga: 0, afga: 0, hfta: 0, afta: 0, hor: 0, aor: 0, htov: 0, atov: 0 };
    cur.ok = cur.h5.length === 5 && cur.a5.length === 5 ? 1 : 0;
  }
  function snapshot(st) {
    st.h5 = [...on[home]].sort(); st.a5 = [...on[away]].sort();
    st.ok = st.h5.length === 5 && st.a5.length === 5 ? 1 : 0;
  }
  function stintHasContent(st, t) {
    return t > st.t0 || st.hp || st.ap || st.hfga || st.afga || st.hfta || st.afta || st.hor || st.aor || st.htov || st.atov;
  }
  function close(t) {
    if (!cur) return;
    cur.t1 = t;
    const dur = cur.t1 - cur.t0;
    if (dur > 0 || cur.hp || cur.ap || cur.hfga || cur.afga || cur.hfta || cur.afta) {
      stints.push(cur);
      issues.total_seconds += Math.max(0, dur);
      if (!cur.ok) issues.bad_lineup_seconds += Math.max(0, dur);
      if (dur > 0) for (const pid of cur.h5.concat(cur.a5)) onCourt.set(pid, (onCourt.get(pid) || 0) + dur);
    }
    cur = null;
  }

  let hsPrev = 0, asPrev = 0;
  let possGain = { [home]: null, [away]: null };  /* time the team last gained the ball live (dreb, steal, opp turnover) */
  for (const p of pers) {
    const pevs = ev.filter((e) => e.per === p);
    inferPeriodStart(p, pevs);
    open(perStart(p));
    for (const e of pevs) {
      /* score deltas go to the current five */
      if (e.hs != null && e.as != null) {
        const dh = e.hs - hsPrev, da = e.as - asPrev;
        if (dh > 0) cur.hp += dh; if (da > 0) cur.ap += da;
        hsPrev = e.hs; asPrev = e.as;
      }
      const evTeam = e.team || teamOf(e.a1);
      const side = evTeam === home ? 'h' : evTeam === away ? 'a' : null;
      if (e.type === 'Substitution') {
        const tm = teamOf(e.a1, evTeam) || teamOf(e.a2, evTeam);
        if (tm !== home && tm !== away) { issues.unknown_team_events++; continue; }
        /* a stint with any time or any event closes at the substitution; an
           empty one (several substitutions in one dead ball) only re-reads
           the fives after each swap */
        if (stintHasContent(cur, e.t)) close(e.t);
        if (on[tm].has(e.a2)) on[tm].delete(e.a2); else issues.sub_errors++;
        if (e.a1) on[tm].add(e.a1);
        if (!cur) open(e.t); else snapshot(cur);
        continue;
      }
      if (!side) { if (e.shooting || RE_TOV.test(e.type)) issues.unknown_team_events++; continue; }
      const T = team[evTeam];
      const isFt = RE_FT.test(e.type);
      if (e.shooting && isFt) {
        T.fta++; if (e.scoring) T.ftm++;
        if (side === 'h') cur.hfta++; else cur.afta++;
      } else if (e.shooting && e.tid !== 91) {
        const three = RE_THREE.test(e.text) || (e.scoring && e.val === 3);
        const made = !!e.scoring;
        const d = shotDistance(e);
        const fam = shotFamily(e.type);
        T.fga++; if (made) T.fgm++;
        if (three) { T.fg3a++; if (made) T.fg3m++; }
        const z = zoneOf(d, three, e.x, e.y);
        T[z + '_a']++; if (made) T[z + '_m']++;
        if (fam === 'heave') T.heave++;
        const g = possGain[evTeam]; const tr = g != null && e.t - g <= 7 && e.t >= g ? 1 : 0;
        if (tr) { T.tr_a++; if (made) T.tr_pts += three ? 3 : 2; }
        if (side === 'h') cur.hfga++; else cur.afga++;
        /* the running score already includes this shot when it was made */
        const leadAfter = side === 'h' ? hsPrev - asPrev : asPrev - hsPrev;
        shots.push({ per: e.per, t: e.t, tm: evTeam, sh: e.a1, mk: made ? 1 : 0, v: three ? 3 : 2,
          ast: made && e.a2 && /assist/i.test(e.text) ? e.a2 : null, blk: !made && e.a2 && /block/i.test(e.text) ? e.a2 : null,
          x: e.x, y: e.y, d, ty: fam, tr, lead: made ? leadAfter - (three ? 3 : 2) : leadAfter, clk: perStart(e.per) + perLen(e.per) - e.t });
        possGain[evTeam] = null;
      } else if (e.type === 'Offensive Rebound') {
        if (e.a1) { T.oreb++; if (side === 'h') cur.hor++; else cur.aor++; }
      } else if (e.type === 'Defensive Rebound') {
        if (e.a1) T.dreb++;
        possGain[evTeam] = e.t;
      } else if (RE_TOV.test(e.type) && !/^No Turnover/.test(e.type)) {
        T.tov++; if (side === 'h') cur.htov++; else cur.atov++;
        possGain[evTeam === home ? away : home] = e.t;
      }
    }
    close(perStart(p) + perLen(p));
    prevEnd = { [home]: [...on[home]], [away]: [...on[away]] };
  }
  team[home].pts = final.h; team[away].pts = final.a;
  return { periods, final, stints, shots, team, onCourt, spread, issues };
}

module.exports = { processGame, normalise, shotFamily, shotDistance, zoneOf, perStart, perLen, REG, PERIOD, OT };
