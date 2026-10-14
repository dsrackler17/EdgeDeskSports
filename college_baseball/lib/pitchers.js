'use strict';
/* ===========================================================================
   EdgeDesk college baseball — starting pitcher, bullpen and workload engines.

   Everything here is CAUSAL: PitchingState.advance(date) folds in only
   appearances from earlier dates, and every query answers "as of" that date.

   PITCHER TALENT (empirical Bayes per component, per batter faced)
     rate_shrunk = (events + n0 * population_rate) / (BF + n0)
   with n0 measured on 2024 college data (research/FINDINGS.md F-06):
     K 63 · BB 53 · HBP 113 · HR 334 · H 195 BF
   Prior seasons enter with weight `decay` per season (transfers follow the
   person link built at ingest). ERA is never an input.
   A pitcher's run value per BF comes from those shrunk components through
   college pitching linear weights fitted on team-game pitching totals of the
   FIT season only (2024): runs/BF = a + b_K K + b_BB (BB+HBP) + b_HR HR + b_H H.

   STARTER LENGTH: expected outs per start, shrunk to the role mean (12.5 outs
   in 2024, sd 5.7), with the pitcher's own spread.

   WORKLOAD. Pitch counts are not in the source. A pitcher's pitches are
   estimated as 4.2 x BF (measured from 2024 pitch sequences, sd 1.65 per PA),
   and every workload figure carries that uncertainty rather than a count.

   BULLPEN AVAILABILITY. P(a reliever appears today | recent workload) is a
   logistic model fitted on the FIT season (yesterday's BF, BF over three days,
   consecutive days pitched, days since last appearance, usage share). The
   bullpen a team can use today is its relievers weighted by that probability
   and their usual workload, so a depleted bullpen shifts toward lesser arms.

   STARTER PROJECTION (Phase 7). A conditional logit over the team's recent
   starters (rest days, same weekday slot as last week, recent start share,
   relief work in the last two days) plus an UNSEEN alternative, fitted on the
   FIT season. Status is PROJECTED or UNKNOWN by the top candidate's
   probability; nothing is ever CONFIRMED without a timestamped source.
   =========================================================================== */
const S = require('../../engine/stats');
const W = require('./warehouse');
const K = require('../ingest/common');

const N0 = { so: 63, bb: 53, hb: 113, hr: 334, h: 195 };
const PITCHES_PER_BF = 4.2; const PITCHES_SD_PER_PA = 1.65;
const DEFAULTS = { decay: 0.6, starter_outs_mean: 12.5, starter_outs_n0: 4, lookback_days: 28 };

function blank() { return { bf: 0, so: 0, bb: 0, hb: 0, hr: 0, h: 0, r: 0, er: 0, outs: 0, starts: 0, start_outs: 0, start_outs_sq: 0, relief: 0, apps: [] }; }

/* college pitching linear weights from team-game totals (rows of team_games) */
function fitPitchingWeights(teamRows) {
  const X = []; const y = [];
  for (const t of teamRows) {
    if (!t.pit_bf || t.box_quality !== 'OK') continue;
    X.push([t.pit_bf, t.pit_so || 0, (t.pit_bb || 0) + (t.pit_hb || 0), t.pit_hr_a || 0, (t.pit_h || 0) - (t.pit_hr_a || 0)]);
    y.push(t.pit_r || 0);
  }
  /* ordinary least squares without intercept (runs scale with BF) */
  const p = X[0].length; const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  const beta = Array.from(S.solve(A, b));
  return { per_bf: beta[0], so: beta[1], bb_hbp: beta[2], hr: beta[3], h_non_hr: beta[4], n: X.length };
}

class PitchingState {
  constructor(o) {
    this.o = Object.assign({}, DEFAULTS, o || {});
    this.people = new Map();      // person -> {season stats by season, last app date, recent apps}
    this.team = new Map();        // team -> {starts:[{date, person, outs, weekday, dh}], relief apps by date}
    this.pop = { bf: 0, so: 0, bb: 0, hb: 0, hr: 0, h: 0, r: 0 };
    this.queue = []; this.qi = 0; this.date = null;
    this.lw = null;               // pitching linear weights
    this.avail = null;            // availability model
    this.proj = null;             // starter projection model
  }
  load(seasons) {
    const all = [];
    for (const s of seasons) for (const p of W.pitchers(s)) if (p.person_id && p.team_id && p.date) all.push(p);
    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : a.seq - b.seq));
    this.queue = all; this.qi = 0;
    return this;
  }
  person(id) { if (!this.people.has(id)) this.people.set(id, { by: new Map(), apps: [] }); return this.people.get(id); }
  teamRec(id) { if (!this.team.has(id)) this.team.set(id, { starts: [], apps: [] }); return this.team.get(id); }

  /** fold in every appearance strictly before `date` */
  advance(date) {
    while (this.qi < this.queue.length && this.queue[this.qi].date < date) {
      const p = this.queue[this.qi++];
      const pr = this.person(p.person_id);
      if (!pr.by.has(p.season)) pr.by.set(p.season, blank());
      const v = pr.by.get(p.season);
      const bf = p.bf || 0;
      v.bf += bf; v.so += p.so || 0; v.bb += p.bb || 0; v.hb += p.hb || 0; v.hr += p.hr_a || 0; v.h += p.h || 0; v.r += p.r || 0; v.er += p.er || 0; v.outs += p.outs || 0;
      if (p.starter) { v.starts++; v.start_outs += p.outs || 0; v.start_outs_sq += (p.outs || 0) * (p.outs || 0); } else v.relief++;
      const app = { date: p.date, season: p.season, game: p.game_id, team: p.team_id, bf, outs: p.outs || 0, starter: p.starter, seq: p.seq, weekday: K.weekday(p.date) };
      pr.apps.push(app); pr.last = app; pr.lastTeam = p.team_id;
      const t = this.teamRec(p.team_id); t.apps.push(Object.assign({ person: p.person_id }, app));
      if (p.starter) t.starts.push({ date: p.date, person: p.person_id, outs: p.outs || 0, weekday: app.weekday, season: p.season });
      this.pop.bf += bf; this.pop.so += p.so || 0; this.pop.bb += p.bb || 0; this.pop.hb += p.hb || 0; this.pop.hr += p.hr_a || 0; this.pop.h += p.h || 0; this.pop.r += p.r || 0;
    }
    this.date = date;
  }

  popRate(k) { return this.pop.bf ? this.pop[k] / this.pop.bf : { so: 0.198, bb: 0.109, hb: 0.032, hr: 0.028, h: 0.232 }[k]; }

  /** shrunk component rates and run value per BF for a person, as of the current date */
  talent(person, season) {
    const pr = this.people.get(person);
    const acc = blank(); let w = 1;
    if (pr) {
      for (let s = season; s >= season - 3; s--) {
        const v = pr.by.get(s); if (v) for (const k of ['bf', 'so', 'bb', 'hb', 'hr', 'h', 'r', 'outs', 'starts', 'start_outs', 'start_outs_sq', 'relief']) acc[k] += v[k] * w;
        w *= this.o.decay;
      }
    }
    const rate = {};
    for (const k of Object.keys(N0)) rate[k] = (acc[k] + N0[k] * this.popRate(k)) / (acc.bf + N0[k]);
    const rv = this.lw ? this.lw.per_bf + this.lw.so * rate.so + this.lw.bb_hbp * (rate.bb + rate.hb) + this.lw.hr * rate.hr + this.lw.h_non_hr * (rate.h - rate.hr) : null;
    const so = this.o.starter_outs_n0;
    const outs = (acc.start_outs + so * this.o.starter_outs_mean) / (acc.starts + so);
    const varOuts = acc.starts > 1 ? Math.max(4, acc.start_outs_sq / acc.starts - Math.pow(acc.start_outs / acc.starts, 2)) : 32;
    return { rate, rv_per_bf: rv, bf_weighted: acc.bf, starts: acc.starts, exp_outs_start: outs, sd_outs_start: Math.sqrt(varOuts), reliability: acc.bf / (acc.bf + N0.so) };
  }

  /** a team's recent appearances (last `days` days) */
  recent(team, days) {
    const t = this.team.get(team); if (!t) return [];
    const from = K.addDays(this.date, -days); const out = [];
    for (let i = t.apps.length - 1; i >= 0 && t.apps[i].date >= from; i--) out.push(t.apps[i]);
    return out;
  }

  /** workload of one person over the last 1-3 days, with the pitch estimate's uncertainty */
  workload(person) {
    const pr = this.people.get(person); const d = this.date;
    const res = { bf1: 0, bf2: 0, bf3: 0, apps3: 0, consecutive: 0, days_since: null };
    if (!pr) return res;
    let consecutive = 0; let expect = K.addDays(d, -1);
    for (let i = pr.apps.length - 1; i >= 0; i--) {
      const a = pr.apps[i]; const ago = K.daysBetween(a.date, d);
      if (res.days_since == null) res.days_since = ago;
      if (ago > 3) break;
      if (ago === 1) res.bf1 += a.bf;
      if (ago <= 2) res.bf2 += a.bf;
      res.bf3 += a.bf; res.apps3++;
      if (a.date === expect) { consecutive++; expect = K.addDays(expect, -1); }
    }
    res.consecutive = consecutive;
    res.pitches3_est = Math.round(res.bf3 * PITCHES_PER_BF);
    res.pitches3_sd = Math.round(Math.sqrt(res.bf3) * PITCHES_SD_PER_PA + res.bf3 * 0.35);
    return res;
  }

  /* -------------------------------------------------------------- bullpen */
  relievers(team, season) {
    /* everyone who relieved for the team in the lookback window (or this season) */
    const apps = this.recent(team, 45).filter((a) => !a.starter);
    const by = new Map(); for (const a of apps) by.set(a.person, (by.get(a.person) || 0) + a.bf);
    const tot = [...by.values()].reduce((x, y) => x + y, 0) || 1;
    return [...by.entries()].map(([person, bf]) => ({ person, usage_share: bf / tot }));
  }
  availabilityFeatures(person, usageShare) {
    const wl = this.workload(person);
    return [1, wl.bf1 / 10, wl.bf3 / 20, wl.consecutive >= 2 ? 1 : 0, wl.days_since == null ? 1 : Math.min(7, wl.days_since) / 7, usageShare];
  }
  pAppear(person, usageShare) {
    if (!this.avail) return 0.35;
    return S.sigmoid(S.dot(this.avail, this.availabilityFeatures(person, usageShare)));
  }
  /** the bullpen a team can use today: run value per BF weighted by availability and usual usage */
  bullpen(team, season) {
    const rs = this.relievers(team, season);
    if (!rs.length) return { rv_available: null, rv_normal: null, depletion: null, n: 0, relievers: [] };
    let wa = 0; let sa = 0; let wn = 0; let sn = 0; const list = [];
    for (const r of rs) {
      const t = this.talent(r.person, season); if (t.rv_per_bf == null) continue;
      const pa = this.pAppear(r.person, r.usage_share);
      const wl = this.workload(r.person);
      list.push({ person: r.person, usage_share: r.usage_share, p_available: pa, rv_per_bf: t.rv_per_bf, bf3: wl.bf3, pitches3_est: wl.pitches3_est, pitches3_sd: wl.pitches3_sd });
      wn += r.usage_share; sn += r.usage_share * t.rv_per_bf;
      wa += r.usage_share * pa; sa += r.usage_share * pa * t.rv_per_bf;
    }
    if (!wn) return { rv_available: null, rv_normal: null, depletion: null, n: 0, relievers: [] };
    /* depletion: the share of the usual (fully rested) relief availability that recent work has taken away */
    const rested = (u) => (this.avail ? S.sigmoid(S.dot(this.avail, [1, 0, 0, 0, 3 / 7, u])) : 0.35);
    const base = list.reduce((a, x) => a + x.usage_share * rested(x.usage_share), 0);
    return { rv_available: wa ? sa / wa : sn / wn, rv_normal: sn / wn, depletion: base ? Math.max(0, 1 - wa / base) : null, n: list.length,
      bf_last3: list.reduce((a, x) => a + x.bf3, 0), relievers: list.sort((a, b) => b.usage_share - a.usage_share).slice(0, 8) };
  }

  /* -------------------------------------------------------------- starter projection */
  candidates(team, season, date, ctx) {
    const t = this.team.get(team);
    const wd = K.weekday(date);
    const starts = t ? t.starts.filter((s) => K.daysBetween(s.date, date) <= this.o.lookback_days && s.date < date) : [];
    const recentStartsN = starts.length || 1;
    const by = new Map();
    for (const s of starts) { if (!by.has(s.person)) by.set(s.person, []); by.get(s.person).push(s); }
    const out = [];
    for (const [person, ss] of by) {
      const last = ss[ss.length - 1]; const rest = K.daysBetween(last.date, date);
      const wl = this.workload(person);
      const sameSlot = ss.some((s) => K.daysBetween(s.date, date) === 7) ? 1 : 0;
      const sameWeekday = ss.some((s) => s.weekday === wd) ? 1 : 0;
      out.push({ person, features: [rest >= 5 && rest <= 9 ? 1 : 0, rest <= 3 ? 1 : 0, sameSlot, sameWeekday, ss.length / recentStartsN, wl.bf2 > 0 && wl.bf2 < 15 ? 1 : 0], rest, starts: ss.length });
    }
    return out;
  }
  projectStarter(team, season, date, ctx) {
    const cands = this.candidates(team, season, date, ctx);
    const beta = this.proj || { cand: [1.2, -2.5, 2.0, 0.8, 2.0, -1.0], unseen: -1.0 };
    const u = cands.map((c) => S.dot(beta.cand, c.features));
    const us = beta.unseen + (cands.length < 3 ? 1.0 : 0);
    const mx = Math.max(us, ...u); const e = u.map((x) => Math.exp(x - mx)); const eu = Math.exp(us - mx);
    const z = e.reduce((a, b) => a + b, 0) + eu;
    const list = cands.map((c, i) => ({ person: c.person, p: e[i] / z, rest: c.rest, starts: c.starts })).sort((a, b) => b.p - a.p);
    const top = list[0] ? list[0].p : 0;
    return { candidates: list, p_unseen: eu / z, status: top >= 0.5 ? 'PROJECTED' : 'UNKNOWN', top_p: top };
  }
}

/* -------------------------------------------------------------- model fitting on the FIT season */
/** fit the availability logit: for each team game, every recent reliever, appeared today or not */
function fitAvailability(state, season, games) {
  const X = []; const y = [];
  const byTeamDate = new Map();
  for (const p of W.pitchers(season)) if (!p.starter && p.person_id) { const k = p.team_id + '|' + p.date; if (!byTeamDate.has(k)) byTeamDate.set(k, new Set()); byTeamDate.get(k).add(p.person_id); }
  for (const g of games) {
    state.advance(g.date);
    for (const team of [g.home_id, g.away_id]) {
      const used = byTeamDate.get(team + '|' + g.date) || new Set();
      for (const r of state.relievers(team, season)) { X.push(state.availabilityFeatures(r.person, r.usage_share)); y.push(used.has(r.person) ? 1 : 0); }
    }
  }
  const f = S.logistic(X, y, { l2: 1e-3 });
  return { beta: Array.from(f.beta), n: X.length, base_rate: y.reduce((a, b) => a + b, 0) / y.length };
}

/** fit the starter-projection conditional logit by gradient ascent on the FIT season */
function fitProjection(state, season, games) {
  const sets = [];
  const starterOf = new Map();
  for (const p of W.pitchers(season)) if (p.starter && p.person_id) starterOf.set(p.game_id + '|' + p.team_id, p.person_id);
  for (const g of games) {
    state.advance(g.date);
    for (const team of [g.home_id, g.away_id]) {
      const actual = starterOf.get(g.game_id + '|' + team); if (!actual) continue;
      const cands = state.candidates(team, season, g.date, g);
      sets.push({ feats: cands.map((c) => c.features), chosen: cands.findIndex((c) => c.person === actual), few: cands.length < 3 ? 1 : 0 });
    }
    /* same-date games must not see each other's starters: advance happens per date in caller order */
  }
  const d = 6;
  let beta = new Array(d).fill(0); let unseen = -1;
  for (let it = 0; it < 300; it++) {
    const g = new Array(d).fill(0); let gu = 0; let ll = 0;
    for (const s of sets) {
      const u = s.feats.map((f) => S.dot(beta, f)); const us = unseen + s.few;
      const mx = Math.max(us, ...u); const e = u.map((x) => Math.exp(x - mx)); const eu = Math.exp(us - mx); const z = e.reduce((a, b) => a + b, 0) + eu;
      const pr = e.map((x) => x / z); const pu = eu / z;
      ll += Math.log(s.chosen >= 0 ? pr[s.chosen] : pu);
      for (let j = 0; j < d; j++) { let ex = 0; for (let i = 0; i < s.feats.length; i++) ex += pr[i] * s.feats[i][j]; g[j] += (s.chosen >= 0 ? s.feats[s.chosen][j] : 0) - ex; }
      gu += (s.chosen < 0 ? 1 : 0) - pu;
    }
    const lr = 1.5 / sets.length;
    for (let j = 0; j < d; j++) beta[j] += lr * g[j] - lr * 0.01 * beta[j];
    unseen += lr * gu;
    if (it === 299) return { cand: beta, unseen, n: sets.length, log_lik: ll };
  }
  return { cand: beta, unseen, n: sets.length };
}

module.exports = { PitchingState, fitPitchingWeights, fitAvailability, fitProjection, N0, PITCHES_PER_BF, PITCHES_SD_PER_PA, DEFAULTS };
