'use strict';
/* ===========================================================================
   EdgeDesk NHL — why a price is what it is.

   explainGame() decomposes one game's moneyline probability (and expected
   total) into the factors of the production model, EXACTLY:

     baseline     two league-average clubs at a neutral rink, fully rested
                  (every rating at the league average, home ice off)
     factors      home ice, and for each club: 5v5 chance creation, 5v5 chance
                  suppression, results beyond chances (goals-for/against
                  ratings and finishing), special teams (power play, penalty
                  kill, penalties drawn and taken), rest (back-to-back)

   Each factor's contribution is its Shapley value (Shapley 1953; the same
   attribution SHAP uses for model explanations, Lundberg & Lee 2017),
   computed over all 2^11 on/off combinations of the factors through the full
   pricing chain — GLM → pair recalibration → exact score distribution with
   overtime and the shootout. The contributions therefore add up to the
   price exactly: baseline + Σ contributions = the published probability.

   A factor is "off" at the league average (log ratio 0, no back-to-back, no
   home ice). Nothing here is estimated anew: the coefficients, ratings and
   distribution are the production model's. The narrative is a deterministic
   template over these numbers — no language model writes or edits it.
   =========================================================================== */
const GLM = require('./glm');
const DIST = require('./distribution');

/* features per factor, as they appear in the HOME row (fh) and the AWAY row (fa).
   A club's offence appears in its own row; its defence appears in the opponent's row as *_opp. */
function groupsFor() {
  const g = [{ key: 'home_ice', team: null, label: 'home ice', fh: ['home'], fa: [] }];
  for (const side of ['home', 'away']) {
    const own = side === 'home' ? 'fh' : 'fa', opp = side === 'home' ? 'fa' : 'fh';
    g.push({ key: side + '_ev_off', team: side, label: '5v5 chance creation', [own]: ['ev_off'], [opp]: [] });
    g.push({ key: side + '_ev_def', team: side, label: '5v5 chance suppression', [own]: [], [opp]: ['ev_def_opp'] });
    g.push({ key: side + '_results', team: side, label: 'results beyond chances (goals for and against, finishing)', [own]: ['g_off', 'fin'], [opp]: ['g_def_opp'] });
    g.push({ key: side + '_special', team: side, label: 'special teams (power play, penalty kill, penalties drawn and taken)', [own]: ['pp_off', 'pp_draw'], [opp]: ['pk_def_opp', 'pk_take_opp'] });
    g.push({ key: side + '_rest', team: side, label: 'rest (second night of a back-to-back)', [own]: ['b2b'], [opp]: ['b2b_opp'] });
  }
  for (const x of g) { x.fh = x.fh || []; x.fa = x.fa || []; }
  return g;
}
const NEUTRAL = { home: 0, b2b: 0, b2b_opp: 0 };
/* the league-average club: home ice and back-to-backs off; every rating at the
   mean of the 32 clubs' current ratings (leagueNeutral). A ratio is not
   neutral at 1 when the league as a whole sits off 1 — finishing (goals ÷ xG)
   does whenever the xG model's level drifts — and a factor measured from 1
   would credit both clubs with a league-wide effect that cancels between them. */
function neutralOf(map) { return (k) => (k in NEUTRAL ? NEUTRAL[k] : map && map[k] != null ? map[k] : 1); }
const RATIO_KEYS = { ev_off: 'ev_off', ev_def: 'ev_def_opp', g_off: 'g_off', g_def: 'g_def_opp', pp_off: 'pp_off', pk_def: 'pk_def_opp', pp_draw: 'pp_draw', pk_take: 'pk_take_opp', fin: 'fin' };
/** the league-average club from a ratings state: the mean of every active club's current ratings */
function leagueNeutral(teamRatings) {
  const out = {}; const n = teamRatings.length || 1;
  for (const [rk, fk] of Object.entries(RATIO_KEYS)) out[fk] = teamRatings.reduce((a, r) => a + (r[rk] == null ? 1 : r[rk]), 0) / n;
  return out;
}

/** price(fh, fa) → { p, total } through the production chain */
function pricer(o) {
  return function (fh, fa) {
    const raw = { lh: GLM.predict(o.model, fh), la: GLM.predict(o.model, fa) };
    const c = GLM.applyPairCalibration(raw.lh, raw.la, o.cal);
    const D = DIST.game({ lamH: c.lh, lamA: c.la, effects: o.effects, ot: o.ot });
    return { p: D.p_home, total: DIST.expectedTotal(D), lh: c.lh, la: c.la };
  };
}

/** exact Shapley values over the factor groups */
function shapley(price, fh, fa, groups, neutral) {
  neutral = neutral || neutralOf(null);
  const n = groups.length; const N = 1 << n;
  const val = new Array(N);
  for (let mask = 0; mask < N; mask++) {
    const h = Object.assign({}, fh), a = Object.assign({}, fa);
    for (let i = 0; i < n; i++) if (!(mask & (1 << i))) { for (const k of groups[i].fh) h[k] = neutral(k); for (const k of groups[i].fa) a[k] = neutral(k); }
    val[mask] = price(h, a);
  }
  const fact = [1]; for (let i = 1; i <= n; i++) fact.push(fact[i - 1] * i);
  const phiP = new Array(n).fill(0), phiT = new Array(n).fill(0);
  for (let mask = 0; mask < N; mask++) {
    let s = 0; for (let i = 0; i < n; i++) if (mask & (1 << i)) s++;
    const w = fact[s] * fact[n - s - 1] / fact[n];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      const with_ = val[mask | (1 << i)], without = val[mask];
      phiP[i] += w * (with_.p - without.p); phiT[i] += w * (with_.total - without.total);
    }
  }
  return { baseline: val[0], full: val[N - 1], phiP, phiT };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r2 = (v) => Math.round(v * 100) / 100;

/** the factor's measured inputs, oriented so a reader can read them: × the league-average club */
function evidenceOf(key, fh0, fa0, nz) {
  const side = key.split('_')[0];
  const rel = (f) => { const o = Object.assign({}, f); for (const k of Object.values(RATIO_KEYS)) if (o[k] != null) o[k] = o[k] / nz(k); return o; };
  const fh = rel(fh0), fa = rel(fa0);
  const own = side === 'home' ? fh : fa, opp = side === 'home' ? fa : fh;
  if (/_ev_off$/.test(key)) return { metric: '5v5 expected goals created per 60', vs_league: r4(own.ev_off), better: own.ev_off >= 1 };
  if (/_ev_def$/.test(key)) return { metric: '5v5 expected goals allowed per 60', vs_league: r4(opp.ev_def_opp), better: opp.ev_def_opp <= 1 };
  /* a club's defence sits in the OPPONENT's row as *_opp: these are the club's own numbers */
  if (/_results$/.test(key)) return { metric: 'its goals for per game / its goals against per game / its finishing (goals ÷ xG)', vs_league: [r4(own.g_off), r4(opp.g_def_opp), r4(own.fin)], better: own.g_off >= opp.g_def_opp };
  if (/_special$/.test(key)) return { metric: 'its power-play xG per 60 / its penalty-kill xG allowed per 60 / its PP minutes drawn / its PK minutes taken', vs_league: [r4(own.pp_off), r4(opp.pk_def_opp), r4(own.pp_draw), r4(opp.pk_take_opp)], better: own.pp_off >= opp.pk_def_opp };
  if (/_rest$/.test(key)) return { metric: 'second night of a back-to-back', vs_league: own.b2b ? 1 : 0, better: !own.b2b, note: 'the production model carries no goalie term, so this effect includes how often a club starts its backup on the second night; the goalie scenarios show the move once a starter is named' };
  return { metric: 'home ice', vs_league: null, better: true };
}

/**
 * o: { model (GLM fit), cal (pair calibration), effects, ot, fh, fa (snapshots), home, away (abbrs) }
 * → { baseline, published, factors: [...sorted by |pp|], check }
 */
function explainGame(o) {
  /* a factor whose features the production model does not carry contributes nothing: it is not listed */
  const inModel = new Set(o.model.names || []);
  const groups = groupsFor().filter((g) => g.fh.concat(g.fa).some((k) => inModel.has(k)));
  const price = pricer(o);
  const nz = neutralOf(o.neutral);
  const s = shapley(price, o.fh, o.fa, groups, nz);
  const factors = groups.map((g, i) => ({
    key: g.key, team: g.team ? o[g.team] : null, side: g.team, label: g.label,
    pp: r4(s.phiP[i] * 100), goals: r2(s.phiT[i]), evidence: evidenceOf(g.key, o.fh, o.fa, nz),
  })).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp));
  const sumP = s.phiP.reduce((a, v) => a + v, 0);
  return {
    method: 'exact Shapley values over the model\'s ' + groups.length + ' factor groups through the full pricing chain (GLM → pair recalibration → score distribution with overtime and the shootout); contributions sum exactly to the published probability',
    baseline: { p_home: r4(s.baseline.p), expected_total: r2(s.baseline.total), what: 'two league-average clubs (every rating at the mean of the 32 clubs\' current ratings) at a neutral rink, both rested', neutral: o.neutral || null },
    published: { p_home: r4(s.full.p), expected_total: r2(s.full.total), lambda_home: r4(s.full.lh), lambda_away: r4(s.full.la) },
    factors,
    check: { sum_of_contributions_pp: r4(sumP * 100), published_minus_baseline_pp: r4((s.full.p - s.baseline.p) * 100), exact: Math.abs(sumP - (s.full.p - s.baseline.p)) < 1e-9 },
    generated_by: 'deterministic decomposition of the production model (hockey/model/explain.js) — no language model',
  };
}

function pp(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + ' pp'; }
function x(v) { return v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2) + '×'; }

/** a plain-language account built only from the decomposition (deterministic template) */
function narrative(e, game) {
  const fav = e.published.p_home >= 0.5 ? game.home : game.away;
  const pFav = e.published.p_home >= 0.5 ? e.published.p_home : 1 - e.published.p_home;
  const lines = [];
  lines.push(fav + ' ' + (pFav * 100).toFixed(1) + '% to win (overtime and shootout included). Two league-average clubs at a neutral rink would be ' + (e.baseline.p_home * 100).toFixed(1) + '% for the home side; the factors below move ' + game.home + ' from there to ' + (e.published.p_home * 100).toFixed(1) + '%.');
  const big = e.factors.filter((f) => Math.abs(f.pp) >= 0.3);
  for (const f of big.slice(0, 6)) {
    /* the factor's name without its parenthetical: the evidence that follows says the same, with numbers */
    const name = f.label.split(' (')[0];
    const who = f.team ? f.team + '\'s ' + name : name;
    let ev = '';
    const v = f.evidence.vs_league;
    if (/_ev_off$/.test(f.key)) ev = ' (' + x(v) + ' the league-average club, opponent- and score-adjusted)';
    else if (/_ev_def$/.test(f.key)) ev = ' (allows ' + x(v) + ' the league-average club)';
    else if (/_rest$/.test(f.key)) ev = ' (its backup goalie is likelier to start; the model has no goalie term)';
    else if (/_results$/.test(f.key)) ev = ' (goals for ' + x(v[0]) + ', goals against ' + x(v[1]) + ', finishing ' + x(v[2]) + ' the league-average club)';
    else if (/_special$/.test(f.key)) ev = ' (power play ' + x(v[0]) + ', penalty kill allows ' + x(v[1]) + ', penalties drawn ' + x(v[2]) + ', taken ' + x(v[3]) + ')';
    lines.push(who + ev + ': ' + pp(f.pp) + ' for ' + game.home + '.');
  }
  const small = e.factors.length - big.length;
  if (small > 0) lines.push(small + ' smaller factor' + (small === 1 ? '' : 's') + ' move it less than 0.3 points each.');
  lines.push('Expected goals: ' + game.home + ' ' + e.published.lambda_home.toFixed(2) + ', ' + game.away + ' ' + e.published.lambda_away.toFixed(2) + ' in regulation; total ' + e.published.expected_total.toFixed(2) + ' including overtime.');
  return lines;
}

module.exports = { explainGame, narrative, groupsFor, shapley, pricer, leagueNeutral, RATIO_KEYS };
