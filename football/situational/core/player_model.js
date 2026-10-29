/* ============================================================================
   FSIE — player opportunity model: team volume x player share.

   Opportunity, not counting-stat averages. For each player:
     QB pass attempts   team pass attempts x the passer's share of them
     rush attempts      team DESIGNED rushes x the player's designed-rush
                        share, plus (quarterbacks) scrambles and kneels
     targets            team targeted attempts x the player's target share
     receptions         targets x the player's catch rate (shrunk)
   Shares are point-in-time (games before kickoff only), exponentially
   weighted over the games the player was ACTIVE in (any recorded
   opportunity), seeded by last season's share on the same team, and shrunk
   toward a role prior. Every team's shares sum to at most 1 per opportunity
   type: if the eligible players' raw shares exceed it, they are scaled down,
   and the remainder belongs to "other". A player's draw is Binomial(team draw,
   share draw), so no player can be projected past his own team's volume — a
   14-target projection needs a team pass volume that makes it plausible.

   Eligibility: active in at least one of the team's last two games, and at
   least two active games of history (this season, or this season plus last
   season on the same team). Availability: an OUT player is removed and his
   share redistributed; DOUBTFUL scales the share by 0.25; QUESTIONABLE by
   0.9 and widens the interval. College football has no injury feed: its
   players carry availability "unverified" and a wider interval, never a
   guessed status. Where a team's player attribution failed the quality gate,
   no player projection is published for that team.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));

const CFG = {
  half_life_games: 4, prior_games: 2, k_share: { pass: 0.5, rush: 1, target: 1.5 }, k_catch: 30,
  catch_prior: { nfl: 0.66, cfb: 0.62 }, starter_pass_share: { nfl: 0.9652, cfb: 0.8989 }, min_share_publish: { pass: 0.25, rush: 0.06, target: 0.05 },
  availability: { OUT: 0, IR: 0, DOUBTFUL: 0.25, QUESTIONABLE: 0.9 }, cfb_unverified_widen: 1.15, questionable_widen: 1.2,
  /* share dispersion (beta concentration) per opportunity type; the walk-forward
     chooses a multiplier per market on the validation folds */
  kappa: { pass: 400, rush: 25, target: 30 }
};

/* chronological team-game usage tables for one season */
function teamUsage(seasonData) {
  const team = {};       /* team -> [{game_id, kickoff_at, totals, players:{id:usage}}] */
  const tg = {}; seasonData.team_games.forEach((r) => { tg[r.game_id + '|' + r.team] = r; });
  const byKey = {};
  seasonData.player_games.forEach((p) => { (byKey[p.game_id + '|' + p.team] = byKey[p.game_id + '|' + p.team] || []).push(p); });
  Object.keys(tg).forEach((k) => {
    const r = tg[k]; if (r.season_type !== 'REG') return;
    const ps = byKey[k] || [];
    const targeted = ps.reduce((s, p) => s + p.targets, 0);
    const designed = r.counts.designed_rush;
    (team[r.team] = team[r.team] || []).push({ game_id: r.game_id, kickoff_at: r.kickoff_at, ok: !!(r.quality && r.quality.player_ok),
      totals: { pass_att: r.counts.pass_att, designed_rush: designed, targeted, scrambles: r.counts.scrambles, kneels: r.counts.kneels, dropbacks: r.counts.dropbacks },
      players: ps.reduce((o, p) => { o[p.player_id] = p; return o; }, {}) });
  });
  Object.values(team).forEach((a) => a.sort((x, y) => String(x.kickoff_at).localeCompare(String(y.kickoff_at))));
  return team;
}

/* last season's share per (team, player) as the seed */
function seasonShares(usage) {
  const out = {};
  Object.keys(usage).forEach((t) => {
    const acc = {}; let P = 0, R = 0, T = 0;
    usage[t].forEach((g) => { if (!g.ok) return; P += g.totals.pass_att; R += g.totals.designed_rush; T += g.totals.targeted; Object.values(g.players).forEach((p) => { const a = acc[p.player_id] || (acc[p.player_id] = { pass: 0, rush: 0, tgt: 0, rec: 0, name: p.name }); a.pass += p.pass_att; a.rush += p.designed_rush; a.tgt += p.targets; a.rec += p.receptions; }); });
    out[t] = {}; Object.keys(acc).forEach((id) => { const a = acc[id]; out[t][id] = { pass: P ? a.pass / P : 0, rush: R ? a.rush / R : 0, target: T ? a.tgt / T : 0, targets: a.tgt, receptions: a.rec, name: a.name }; });
  });
  return out;
}

const BASE_KEYS = ['pass_att', 'rush_att', 'targets', 'receptions'];
const LAM3 = Math.pow(0.5, 1 / 3);
/* last season's per-active-game averages per (team, player) */
function perGameAverages(usage) {
  const out = {};
  Object.keys(usage).forEach((t) => { const acc = {}; usage[t].forEach((g) => { if (!g.ok) return; Object.values(g.players).forEach((p) => { if (p.pass_att + p.dropbacks + p.rush_att + p.targets <= 0) return; const a = acc[p.player_id] || (acc[p.player_id] = { n: 0, pass_att: 0, rush_att: 0, targets: 0, receptions: 0 }); a.n++; BASE_KEYS.forEach((k) => { a[k] += p[k]; }); }); });
    out[t] = {}; Object.keys(acc).forEach((id) => { const a = acc[id]; out[t][id] = {}; BASE_KEYS.forEach((k) => { out[t][id][k] = a[k] / a.n; }); }); });
  return out;
}

/* point-in-time player states before each of a team's games.
   -> Map(game_id|team -> { players: [state], team_games_before }) */
/* opts.append_next: also return each team's state after its last game, keyed
   'NEXT|<team>' — what the projection of the team's next game reads. */
function playerStates(sport, seasonData, prevData, opts) {
  const usage = teamUsage(seasonData);
  const prevUsage = prevData ? teamUsage(prevData) : {};
  const prevShares = prevData ? seasonShares(prevUsage) : {};
  const seedPG = prevData ? perGameAverages(prevUsage) : {};
  const lam = Math.pow(0.5, 1 / CFG.half_life_games);
  const out = new Map();
  Object.keys(usage).forEach((t) => {
    const games = usage[t]; const st = {};    /* id -> accumulators */
    const seedP = prevShares[t] || {};
    const seq = opts && opts.append_next ? games.concat([{ game_id: 'NEXT', kickoff_at: '9999', ok: false, totals: {}, players: {}, _next: true }]) : games;
    seq.forEach((g, gi) => {
      /* state BEFORE this game */
      const players = [];
      Object.keys(st).concat(Object.keys(seedP).filter((id) => !st[id])).forEach((id) => {
        const s = st[id];
        const seed = seedP[id];
        const activeRecent = s ? (gi - s.last_active_idx) <= 2 : false;
        const nActive = s ? s.n_active : 0;
        if (!activeRecent) return;
        if (nActive + (seed ? 1 : 0) < 2) return;
        /* the recency-weighted share, shrunk toward last season's share on this
           team where one exists, else toward the player's own unweighted
           share this season; the pseudo-count is k games of team volume */
        const raw = (num, den) => (s && s.sum_team[den] > 0 ? s.sum_own[num] / s.sum_team[den] : 0);
        const share = {
          /* the quarterback who started the team's last game shrinks toward the
             measured starter share (training seasons: NFL 0.965, CFB 0.899) —
             last season's share would pull a promoted backup toward his
             backup role */
          pass: s && s.w_team_pass > 0 ? shrink(s.w_pass, s.w_team_pass, s.started_last ? CFG.starter_pass_share[sport] : (seed ? seed.pass : raw('pass', 'pass')), CFG.k_share.pass * avgPer(s, 'pass')) : 0,
          rush: s && s.w_team_rush > 0 ? shrink(s.w_rush, s.w_team_rush, seed ? seed.rush : raw('rush', 'rush'), CFG.k_share.rush * avgPer(s, 'rush')) : 0,
          target: s && s.w_team_tgt > 0 ? shrink(s.w_tgt, s.w_team_tgt, seed ? seed.target : raw('tgt', 'tgt'), CFG.k_share.target * avgPer(s, 'tgt')) : 0
        };
        /* catch rate: this season's catches over targets, plus last season's
           (capped at 30 targets), shrunk toward the league prior */
        const seedT = seed ? Math.min(seed.targets, 30) : 0, seedR = seed && seed.targets ? seed.receptions * seedT / seed.targets : 0;
        const cr = ((s ? s.rec_n : 0) + seedR + CFG.k_catch * CFG.catch_prior[sport]) / ((s ? s.tgt_n : 0) + seedT + CFG.k_catch);
        const seedAvg = seedPG[t] && seedPG[t][id];
        const base = { season_avg: {}, recent_weighted: {} };
        BASE_KEYS.forEach((k) => {
          base.season_avg[k] = s && s.n_active ? s.sum[k] / s.n_active : (seedAvg ? seedAvg[k] : null);
          base.recent_weighted[k] = s && s.ew && s.ew.w > 0 ? s.ew[k] / s.ew.w : (seedAvg ? seedAvg[k] : null);
        });
        players.push({ player_id: id, name: (s && s.name) || (seed && seed.name) || null, games_active: nActive, started_last: !!(s && s.started_last), base,
          started: s && s.st_n ? { pass: s.st_pass, team: s.st_team, n: s.st_n, avg_team: s.sum_team.pass / Math.max(1, s.n_active) } : null,
          scramble_per_db: s && s.db_n > 0 ? s.scr_n / s.db_n : 0, kneels_per_game: s && nActive ? s.kneel_n / nActive : 0,
          share, catch_rate: U.round(U.clamp(cr, 0.3, 0.9), 4), role: roleOf(share, s) });
      });
      normalize(players);
      out.set(g.game_id + '|' + t, { players, team_games_before: gi });
      /* absorb this game (only if its player attribution passed the gate) */
      if (!g.ok) return;
      Object.values(st).forEach((s) => { ['w_pass', 'w_rush', 'w_tgt', 'w_team_pass', 'w_team_rush', 'w_team_tgt'].forEach((k) => { s[k] *= lam; }); });
      Object.values(g.players).forEach((p) => {
        const active = p.pass_att + p.dropbacks + p.rush_att + p.targets > 0;
        if (!active) return;
        const s = st[p.player_id] || (st[p.player_id] = { w_pass: 0, w_rush: 0, w_tgt: 0, w_team_pass: 0, w_team_rush: 0, w_team_tgt: 0, n_active: 0, last_active_idx: -9, tgt_n: 0, rec_n: 0, db_n: 0, scr_n: 0, kneel_n: 0, sum_team: { pass: 0, rush: 0, tgt: 0 },
          sum: { pass_att: 0, rush_att: 0, targets: 0, receptions: 0 }, sum_own: { pass: 0, rush: 0, tgt: 0 }, ew: null, name: p.name });
        s.sum_own.pass += p.pass_att; s.sum_own.rush += p.designed_rush; s.sum_own.tgt += p.targets;
        if (p.started) { s.st_pass = (s.st_pass || 0) * LAM3 + p.pass_att; s.st_team = (s.st_team || 0) * LAM3 + g.totals.pass_att; s.st_n = (s.st_n || 0) + 1; }
        /* pure player baselines: mean and EWMA (half-life 3) over active games */
        BASE_KEYS.forEach((k) => { s.sum[k] += p[k]; });
        if (!s.ew) { s.ew = { w: 0 }; BASE_KEYS.forEach((k) => { s.ew[k] = 0; }); }
        s.ew.w = s.ew.w * LAM3 + 1; BASE_KEYS.forEach((k) => { s.ew[k] = s.ew[k] * LAM3 + p[k]; });
        s.w_pass += p.pass_att; s.w_rush += p.designed_rush; s.w_tgt += p.targets;
        s.w_team_pass += g.totals.pass_att; s.w_team_rush += g.totals.designed_rush; s.w_team_tgt += g.totals.targeted;
        s.sum_team.pass += g.totals.pass_att; s.sum_team.rush += g.totals.designed_rush; s.sum_team.tgt += g.totals.targeted;
        s.n_active++; s.last_active_idx = gi; s.tgt_n += p.targets; s.rec_n += p.receptions; s.db_n += p.dropbacks; s.scr_n += p.scrambles; s.kneel_n += p.kneels;
        s.started_last = !!p.started; if (p.name) s.name = p.name;
      });
      Object.keys(st).forEach((id) => { st[id].started_last = !!(g.players[id] && g.players[id].started); });
    });
  });
  return out;
}
function avgPer(s, kind) { const n = Math.max(1, s.n_active); return kind === 'pass' ? s.sum_team.pass / n : kind === 'rush' ? s.sum_team.rush / n : s.sum_team.tgt / n; }
/* shrinkage of a recency-weighted share toward a prior share */
function shrink(x, n, priorShare, k) { const pri = U.isNum(priorShare) ? priorShare : 0; return U.clamp((x + k * pri) / (n + k), 0, 1); }
function roleOf(share, s) { if (share.pass >= 0.3) return 'QB'; if (share.rush >= share.target && share.rush >= 0.1) return 'RB'; if (share.target >= 0.05) return 'RECEIVER'; return 'OTHER'; }
function normalize(players) {
  ['pass', 'rush', 'target'].forEach((k) => {
    const tot = players.reduce((s, p) => s + p.share[k], 0);
    if (tot > 0.98) players.forEach((p) => { p.share[k] = p.share[k] * 0.98 / tot; });
  });
}

/* Apply availability: OUT removes and redistributes, others scale. -> players with .availability */
function applyAvailability(sport, players, statusOf) {
  const out = players.map((p) => Object.assign({}, p, { share: Object.assign({}, p.share) }));
  let removed = { pass: 0, rush: 0, target: 0 };
  out.forEach((p) => {
    const st = statusOf ? statusOf(p.player_id, p.name) : null;
    p.availability = sport === 'cfb' ? { status: 'UNVERIFIED', source: null } : { status: st || 'NO_REPORT_LISTING', source: st ? 'nflverse injuries' : 'nflverse injuries (not listed)' };
    const f = st && CFG.availability[st] != null ? CFG.availability[st] : 1;
    if (f < 1) ['pass', 'rush', 'target'].forEach((k) => { removed[k] += p.share[k] * (1 - f); p.share[k] *= f; });
    p.widen = sport === 'cfb' ? CFG.cfb_unverified_widen : (st === 'QUESTIONABLE' || st === 'DOUBTFUL' ? CFG.questionable_widen : 1);
  });
  /* redistribute removed share to the remaining players of the same type, proportionally */
  ['pass', 'rush', 'target'].forEach((k) => {
    const live = out.filter((p) => !(p.availability.status === 'OUT' || p.availability.status === 'IR'));
    const tot = live.reduce((s, p) => s + p.share[k], 0);
    if (removed[k] > 0 && tot > 0) live.forEach((p) => { p.share[k] += removed[k] * p.share[k] / tot; });
  });
  normalize(out);
  return out.filter((p) => !(p.availability.status === 'OUT' || p.availability.status === 'IR'));
}

/* means for one team-game given the team projection mean -> [{player_id, pass_att, rush_att, targets, receptions}] */
/* The projected starter's share of team pass attempts: his share in games he
   STARTED, shrunk (k = 4 starts) toward the starter share for this pregame
   margin (team.starter_share, a training-season table — backups play more of
   a blowout), not his share over every game he appeared in, which carries the
   games he left early. Written back onto p.share.pass so the simulation
   allocates the same share. */
function starterShare(team, p, sport) {
  const prior = U.isNum(team.starter_share) ? team.starter_share : CFG.starter_pass_share[sport || 'nfl'];
  const h = p.started; const k = 4;
  if (!h || !(h.avg_team > 0)) return prior;
  return U.clamp((h.pass + k * h.avg_team * prior) / (h.team + k * h.avg_team), 0.3, 1);
}
function projectMeans(team, players, sport) {
  const designed = Math.max(0, team.rush_att - team.scrambles - (team.kneels || 0));
  const targeted = team.pass_att * (team.targeted_ratio || 0.95);
  players.forEach((p) => { if (p.role === 'QB' && p.started_last) p.share.pass = starterShare(team, p, sport); });
  /* conditional on the player playing: an eligible teammate is inactive with
     probability (1 - active_rate) (measured on training seasons, after the
     availability report), and his share then falls to the others — so a
     player's expected share given he plays is s_i (1 + (1 - pi)(S - s_i)) */
  const pi = U.isNum(team.active_rate) ? team.active_rate : 1;
  if (pi < 1) ['rush', 'target'].forEach((k) => { const S = players.reduce((a, p) => a + p.share[k], 0); players.forEach((p) => { p.share[k] = U.clamp(p.share[k] * (1 + (1 - pi) * (S - p.share[k])), 0, 1); }); });
  return players.map((p) => {
    const isQB = p.role === 'QB';
    const pass = isQB ? team.pass_att * p.share.pass : 0;
    const rush = designed * p.share.rush + (isQB ? team.scrambles * Math.min(1, p.share.pass) + (team.kneels || 0) * Math.min(1, p.share.pass) : 0);
    const tg = targeted * p.share.target;
    return { player_id: p.player_id, name: p.name, role: p.role, pass_att: pass, rush_att: rush, targets: tg, receptions: tg * p.catch_rate };
  });
}

/* Simulated player distributions from team draws (arrays of the same length).
   JOINT allocation on every draw: each opportunity pool (the team's pass
   attempts, designed rushes, targeted passes) is split among the eligible
   players by sequential conditional binomials — a multinomial — so the
   players' draws can never sum past the team's own draw. Shares carry beta
   noise (kappa) and, for the starting quarterback, the early-exit tail. */
function simulatePlayers(team, teamDraws, players, opts) {
  opts = opts || {};
  const u = U.rng(opts.seed || 'fsie-player'); const N = U.normalSampler(u);
  const n = teamDraws.plays.length; const kappa = opts.kappa || CFG.kappa;
  const binom = (nn, p) => { if (nn <= 0 || p <= 0) return 0; if (p >= 1) return nn; if (nn > 50) return U.clamp(Math.round(nn * p + N() * Math.sqrt(nn * p * (1 - p))), 0, nn); let k = 0; for (let i = 0; i < nn; i++) if (u() < p) k++; return k; };
  const betaish = (m, kap) => { if (m <= 0) return 0; const sd = Math.sqrt(m * (1 - m) / (kap + 1)); return U.clamp(m + sd * N(), 0, 1); };
  /* split `total` among shares (sum <= 1; the rest is "other") */
  const split = (total, shares) => { let rem = total, remS = 1; const out = new Array(shares.length).fill(0); const S = shares.reduce((a, x) => a + x, 0); const sc = S > 0.999 ? 0.999 / S : 1;
    shares.forEach((x, j) => { const s = x * sc; const p = remS > 1e-9 ? Math.min(1, s / remS) : 0; const k = binom(rem, p); out[j] = k; rem -= k; remS -= s; }); return out; };
  const tr = team.targeted_ratio || 0.95;
  const d = players.map(() => ({ pass_att: [], rush_att: [], targets: [], receptions: [] }));
  for (let i = 0; i < n; i++) {
    const passT = teamDraws.pass_att[i], rushT = teamDraws.rush_att[i];
    const scr = Math.max(0, Math.min(rushT, Math.round(team.scrambles / Math.max(1, team.pass_att) * passT)));
    const kn = Math.min(Math.max(0, rushT - scr), Math.round(team.kneels || 0));
    const designed = Math.max(0, rushT - scr - kn);
    const sPass = players.map((p) => {
      if (p.role !== 'QB') return 0; const w = p.widen || 1;
      const q = p.started_last && U.isNum(team.qb_exit_rate) ? team.qb_exit_rate : 0;
      if (q > 0 && u() < q) return 0.05 + 0.65 * u();
      return betaish(q > 0 ? U.clamp((p.share.pass - q * 0.375) / (1 - q), 0, 1) : p.share.pass, kappa.pass / (w * w));
    });
    const sRush = players.map((p) => betaish(p.share.rush, kappa.rush / ((p.widen || 1) * (p.widen || 1))));
    const sTgt = players.map((p) => betaish(p.share.target, kappa.target / ((p.widen || 1) * (p.widen || 1))));
    const pa = split(passT, sPass), ru = split(designed, sRush), tg = split(Math.min(passT, Math.round(passT * tr)), sTgt);
    /* the quarterbacks' scrambles and kneels, split by their share of the passing */
    const qbS = sPass.map((x, j) => (players[j].role === 'QB' ? x : 0)); const qx = split(scr + kn, qbS);
    players.forEach((p, j) => {
      d[j].pass_att.push(pa[j]); d[j].rush_att.push(ru[j] + qx[j]); d[j].targets.push(tg[j]); d[j].receptions.push(binom(tg[j], p.catch_rate));
    });
  }
  return players.map((p, j) => {
    const o = { player_id: p.player_id, name: p.name, role: p.role, availability: p.availability || null, share: p.share, catch_rate: p.catch_rate };
    ['pass_att', 'rush_att', 'targets', 'receptions'].forEach((m) => { const q = U.quantiles(d[j][m], [0.1, 0.5, 0.9]); o[m] = { mean: U.round(U.mean(d[j][m]), 2), p10: q[0], p50: q[1], p90: q[2] }; });
    o.draws = opts.keep_draws ? d[j] : undefined;
    return o;
  });
}

module.exports = { playerStates, applyAvailability, projectMeans, starterShare, simulatePlayers, teamUsage, seasonShares, perGameAverages, BASE_KEYS, CFG };
