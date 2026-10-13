'use strict';
/* ===========================================================================
   EdgeDesk NHL — one game's play-by-play → the facts the models read.

   processGame(meta, events, opts) → { game, teams: [home, away], shots, issues }

   Conventions verified on the 2025-26 source (docs/engine/NHL.md §2):
     - x_fixed/y_fixed: the home team always attacks +x (the net at x = +89),
       the away team −x. A shot is turned to "attacking right" by negating the
       away team's coordinates.
     - event_team is the SHOOTING team for SHOT, MISSED_SHOT and GOAL; the
       PENALISED team for PENALTY. On BLOCKED_SHOT it is the BLOCKING team
       (event_player_1 is the shooter, event_player_2 the blocker), and
       x_fixed/y_fixed are rotated 180° as if the blocker had attacked:
       shooterView() turns such a row to the shooting team and its frame
       before anything reads it. Measured on every season 2010-11..2025-26
       (the shooter's club is never the event team) and against ESPN's
       2024-25 shots in datapack/nhl_v1 (hockey/crosscheck/espn.js).
     - home_score/away_score on a GOAL row already include that goal; the
       score BEFORE a shot is tracked here from the goals themselves.
     - empty_net is true exactly when the defending goalie is out of the net.
     - SHOOTOUT rows are excluded from every rate; the shootout winner comes
       from the official final score.

   Time on ice by strength is accumulated between consecutive events in the
   same period, attributed to the strength at the earlier event. States, from
   one team's side (T) against its opponent (O):
     ev5  5 skaters each, both goalies in        evo  other even (4v4, 3v3)
     pp   T has more skaters, both goalies in    sh   T has fewer skaters
     enf  O's net is empty (T may score into it) ena  T's own net is empty
   Score state (lead / tie / trail) is tracked for 5v5 only, for the
   score-and-venue adjustment.

   Nothing here reads xG from the source (the source's own `xg` is kept on each
   shot as `src_xg`, for comparison only). The shots list carries the inputs of
   EdgeDesk's own xG model (hockey/xg/model.js); applyXg() fills the per-team
   and per-goalie xG sums from a fitted model.
   =========================================================================== */
const { num, bool } = require('../lib/io');

const NET_X = 89;
const SHOT_TYPES = ['wrist', 'snap', 'slap', 'backhand', 'tip', 'wrap', 'other'];
function shotType(s) {
  s = String(s || '').toLowerCase();
  if (s === 'wrist') return 'wrist'; if (s === 'snap') return 'snap'; if (s === 'slap') return 'slap';
  if (s === 'backhand') return 'backhand'; if (s === 'tip-in' || s === 'deflected' || s === 'tip' || s === 'deflection') return 'tip';
  if (s === 'wrap-around' || s === 'wrap') return 'wrap';
  return 'other';
}
const UNBLOCKED = { SHOT: 1, MISSED_SHOT: 1, GOAL: 1 };
const OTHER = { home: 'away', away: 'home' };

/** a BLOCKED_SHOT row seen from the shooting team: its side, and its location in the fixed frame */
function shooterView(e) {
  if (e.event_type !== 'BLOCKED_SHOT' || !OTHER[e.event_team_type]) return e;
  const x = num(e.x_fixed), y = num(e.y_fixed);
  return Object.assign({}, e, {
    event_team_type: OTHER[e.event_team_type],
    event_team_abbr: e.event_team_abbr === e.home_abbr ? e.away_abbr : e.event_team_abbr === e.away_abbr ? e.home_abbr : null,
    x_fixed: x == null ? null : -x, y_fixed: y == null ? null : -y,
    blocking_team_type: e.event_team_type,
  });
}

function blankTeam() {
  const t = { toi: { ev5: 0, evo: 0, pp: 0, sh: 0, enf: 0, ena: 0 }, toi_ev5_score: { lead: 0, tie: 0, trail: 0 } };
  for (const s of ['ev5', 'evo', 'pp', 'sh', 'enf', 'ena']) t[s] = { gf: 0, ff: 0, cf: 0, xgf: 0 };
  t.ev5_score = { lead: { xgf: 0, ff: 0 }, tie: { xgf: 0, ff: 0 }, trail: { xgf: 0, ff: 0 } };
  t.pen_minors = 0; t.pen_majors = 0; t.pim = 0;
  t.goalies = {}; /* goalie id → { fa (unblocked faced), ga (non-EN goals), xga, first_seen_s } faced while in net */
  return t;
}

function stateFor(side, hs, as, hg, ag) {
  const my = side === 'home' ? hs : as, op = side === 'home' ? as : hs;
  const myG = side === 'home' ? hg : ag, opG = side === 'home' ? ag : hg;
  if (opG === 0) return 'enf';
  if (myG === 0) return 'ena';
  if (my == null || op == null) return null;
  if (my === op) return my === 5 ? 'ev5' : 'evo';
  return my > op ? 'pp' : 'sh';
}

function processGame(meta, events, opts) {
  opts = opts || {};
  const issues = [];
  const evs = events.map(shooterView).sort((a, b) => (num(a.period) - num(b.period)) || (num(a.game_seconds) - num(b.game_seconds)) || (num(a.event_idx) - num(b.event_idx)));
  const H = blankTeam(), A = blankTeam();
  const T = { home: H, away: A };
  let hScore = 0, aScore = 0;            /* running score, regulation + OT (no shootout) */
  let regH = null, regA = null;          /* score at the end of regulation */
  let otGoal = null;                     /* 'home' | 'away' when an overtime goal decided it */
  let sawShootout = false;
  const shots = [];
  let prev = null;                       /* previous non-administrative event, for rebound / rush features */
  let maxPeriod = 0;
  let startG = { home: null, away: null };

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const ptype = String(e.period_type || '').toUpperCase();
    const period = num(e.period);
    if (period > maxPeriod) maxPeriod = period;
    if (ptype === 'SHOOTOUT' || period >= 5 && meta.season_type === 'R' && ptype !== 'OVERTIME' && ptype !== 'REGULAR') { sawShootout = true; continue; }
    const gs = num(e.game_seconds);
    const hs = num(e.home_skaters), as = num(e.away_skaters);
    const hg = e.home_goalie_in == null ? null : num(e.home_goalie_in), ag = e.away_goalie_in == null ? null : num(e.away_goalie_in);
    if (startG.home == null && num(e.home_goalie_id) != null) startG.home = num(e.home_goalie_id);
    if (startG.away == null && num(e.away_goalie_id) != null) startG.away = num(e.away_goalie_id);
    if (regH == null && period >= 4) { regH = hScore; regA = aScore; }

    /* time on ice until the next event in the same period */
    const nx = evs[i + 1];
    if (nx && num(nx.period) === period && String(nx.period_type || '').toUpperCase() !== 'SHOOTOUT') {
      const dt = num(nx.game_seconds) - gs;
      if (dt > 0 && dt < 1200) {
        for (const side of ['home', 'away']) {
          const st = stateFor(side, hs, as, hg, ag);
          if (st) T[side].toi[st] += dt;
          if (st === 'ev5') {
            const diff = side === 'home' ? hScore - aScore : aScore - hScore;
            T[side].toi_ev5_score[diff > 0 ? 'lead' : diff < 0 ? 'trail' : 'tie'] += dt;
          }
        }
      }
    }

    const type = e.event_type;
    const side = e.event_team_type === 'home' || e.event_team_type === 'away' ? e.event_team_type : null;
    if (type === 'PENALTY' && side) {
      const sev = String(e.penalty_severity || '').toLowerCase();
      if (sev === 'minor' || sev === 'bench') T[side].pen_minors++; else if (sev === 'major' || sev === 'match') T[side].pen_majors++;
      T[side].pim += num(e.penalty_minutes) || 0;
    }
    if ((UNBLOCKED[type] || type === 'BLOCKED_SHOT') && side) {
      const opp = side === 'home' ? 'away' : 'home';
      const st = stateFor(side, hs, as, hg, ag);
      const myScore = side === 'home' ? hScore : aScore, opScore = side === 'home' ? aScore : hScore;
      const diff = myScore - opScore;
      const tm = T[side];
      if (st) tm[st].cf++;
      if (UNBLOCKED[type]) {
        const x = num(e.x_fixed), y = num(e.y_fixed);
        let X = null, Y = null, dist = null, angle = null;
        if (x != null && y != null) {
          X = side === 'home' ? x : -x; Y = side === 'home' ? y : -y;
          const dx = NET_X - X; dist = Math.sqrt(dx * dx + Y * Y);
          angle = Math.atan2(Math.abs(Y), dx) * 180 / Math.PI; /* 0 = straight on; > 90 = from behind the goal line */
        }
        let rebound = 0, rush = 0, sincePrev = null, prevType = null, prevSame = null, prevX = null, prevY = null;
        if (prev && num(prev.period) === period) {
          sincePrev = gs - num(prev.game_seconds);
          prevType = prev.event_type;
          const prevSide = prev.event_team_type;
          prevSame = prevSide === side ? 1 : prevSide === 'home' || prevSide === 'away' ? 0 : null;
          if (sincePrev <= 3 && prevSide === side && (UNBLOCKED[prev.event_type] || prev.event_type === 'BLOCKED_SHOT')) rebound = 1;
          const px = num(prev.x_fixed), py = num(prev.y_fixed);
          if (px != null && py != null) { prevX = side === 'home' ? px : -px; prevY = side === 'home' ? py : -py; } /* previous event in this team's attacking frame */
          if (sincePrev <= 4 && prevX != null && prevX < 25) rush = 1; /* it was outside the attacking zone four seconds ago */
        }
        const isGoal = type === 'GOAL' ? 1 : 0;
        const shot = {
          game_id: meta.game_id, season: meta.season, date: meta.date, side, period, gs, state: st, diff,
          is_home: side === 'home' ? 1 : 0, goal: isGoal, dist, angle, X, Y, type: shotType(e.secondary_type),
          rebound, rush, since_prev: sincePrev, prev_type: prevType, prev_same: prevSame, prev_X: prevX, prev_Y: prevY,
          empty_net: bool(e.empty_net) || (side === 'home' ? ag === 0 : hg === 0) ? 1 : 0,
          goalie: num(e.event_goalie_id), shooter: num(e.event_player_1_id), src_xg: num(e.xg),
        };
        shots.push(shot);
        if (st) { tm[st].ff++; tm[st].gf += isGoal; }
        if (st === 'ev5') { const k = diff > 0 ? 'lead' : diff < 0 ? 'trail' : 'tie'; tm.ev5_score[k].ff++; }
        /* the defending goalie's ledger */
        if (!shot.empty_net && shot.goalie != null) {
          const g = T[opp].goalies[shot.goalie] || (T[opp].goalies[shot.goalie] = { fa: 0, ga: 0, xga: 0, first_s: gs });
          g.fa++; g.ga += isGoal;
        }
      }
      if (type === 'GOAL') {
        if (side === 'home') hScore++; else aScore++;
        if (period >= 4 && ptype === 'OVERTIME') otGoal = otGoal || side;
      }
    }
    if (type !== 'STOP' && type !== 'PERIOD_START' && type !== 'PERIOD_END' && type !== 'GAME_END' && type !== 'DELAYED_PENALTY') prev = e;
  }
  if (regH == null) { regH = hScore; regA = aScore; }

  /* the official final: the shootout winner is +1 in it (NHL convention) */
  const fH = num(meta.final_home), fA = num(meta.final_away);
  let decided = 'REG', soWinner = null;
  if (otGoal) decided = 'OT';
  else if (regH === regA && meta.season_type === 'R') {
    decided = 'SO';
    if (fH != null && fA != null) soWinner = fH > fA ? 'home' : fA > fH ? 'away' : null;
    if (!soWinner) issues.push('tied after overtime with no shootout winner in the official final');
  } else if (regH === regA) issues.push('playoff game tied after regulation with no overtime goal in the feed');
  const finalH = decided === 'SO' ? hScore + (soWinner === 'home' ? 1 : 0) : hScore;
  const finalA = decided === 'SO' ? aScore + (soWinner === 'away' ? 1 : 0) : aScore;
  if (fH != null && fA != null && (fH !== finalH || fA !== finalA)) issues.push('play-by-play final ' + finalH + '-' + finalA + ' differs from official ' + fH + '-' + fA);

  const game = {
    game_id: meta.game_id, season: meta.season, season_type: meta.season_type, date: meta.date, start_utc: meta.start_utc || null,
    home: meta.home, away: meta.away, final_home: fH != null ? fH : finalH, final_away: fA != null ? fA : finalA,
    reg_home: regH, reg_away: regA, decided, so_winner: soWinner, periods: maxPeriod,
    starter_home: meta.starter_home != null ? meta.starter_home : startG.home, starter_away: meta.starter_away != null ? meta.starter_away : startG.away,
    shots: shots.length,
  };
  return { game, teams: { home: H, away: A }, shots, issues };
}

/* Fill every xG sum of a processed game from a fitted model (hockey/xg/model.js).
   Idempotent: the sums are reset first, so a game can be re-scored by a newer model. */
function applyXg(rec, xg) {
  const T = rec.teams;
  for (const side of ['home', 'away']) {
    const t = T[side];
    for (const s of ['ev5', 'evo', 'pp', 'sh', 'enf', 'ena']) t[s].xgf = 0;
    for (const k of ['lead', 'tie', 'trail']) t.ev5_score[k].xgf = 0;
    for (const g of Object.keys(t.goalies)) t.goalies[g].xga = 0;
  }
  for (const s of rec.shots) {
    s.xg = xg.predict(s);
    const tm = T[s.side], opp = T[s.side === 'home' ? 'away' : 'home'];
    if (s.state) tm[s.state].xgf += s.xg;
    if (s.state === 'ev5') { const k = s.diff > 0 ? 'lead' : s.diff < 0 ? 'trail' : 'tie'; tm.ev5_score[k].xgf += s.xg; }
    if (!s.empty_net && s.goalie != null && opp.goalies[s.goalie]) opp.goalies[s.goalie].xga += s.xg;
  }
  rec.xg_model = xg.id;
  return rec;
}

module.exports = { processGame, applyXg, stateFor, shotType, shooterView, SHOT_TYPES, NET_X };
