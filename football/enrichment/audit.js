/* ============================================================================
   THE SELF-AUDIT — after every major refresh, what EdgeDesk knows now against
   what it knew last time, and why it changed.

   Twelve counts, every run:
      1 games                          7 games lacking injury information
      2 mean reliability               8 unrated meaningful absences
      3 median reliability             9 FCS games with THIN DATA
      4 games by reliability band     10 games with fewer than 2 market sources
      5 missing QB statuses           11 stale evidence records
      6 QB conflicts (open)           12 provider failures

   Then the comparison with the previous audit: WHAT IMPROVED, WHAT DEGRADED,
   and WHY — each game that changed grade, with the deduction family that
   moved it most. Nothing here judges whether a change is good for a bet; it
   says whether EdgeDesk knows more or less than it did.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'audit.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

/* snapshot(relArtifact, enrichArtifact) -> the twelve counts + per-game */
function snapshot(rel, enr, meta) {
  const games = rel && rel.games ? Object.values(rel.games).filter((g) => g.reliability) : [];
  const scores = games.map((g) => g.reliability.score).sort((a, b) => a - b);
  const q = (p) => { if (!scores.length) return null; const i = (scores.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return Math.round(10 * (scores[lo] + (scores[hi] - scores[lo]) * (i - lo))) / 10; };
  const band = {};
  games.forEach((g) => { band[g.reliability.grade] = (band[g.reliability.grade] || 0) + 1; });
  const E = enr && enr.games ? enr.games : {};
  let qbMissing = 0, qbConf = 0, qbConfirmed = 0, noInj = 0, unrated = 0, fcsThin = 0, lt2 = 0;
  games.forEach((g) => {
    const p = E[g.game_id];
    const ids = (g.reliability.gates || []).map((x) => x.id);
    if (ids.indexOf('THIN_DATA') >= 0 && g.matchup_type === 'fbs_fcs') fcsThin++;
    if (!p) return;
    let lacking = false;
    ['home', 'away'].forEach((s) => {
      const qb = p.quarterback[s], a = p.availability[s];
      if (qb && qb.player_id && (!qb.status || qb.status === 'UNKNOWN')) qbMissing++;
      if (qb && qb.confirmation_level === 'CONFLICTED') qbConf++;
      if (qb && qb.confirmation_level === 'CONFIRMED') qbConfirmed++;
      if (a && ['PROVIDER_FAILED', 'NO_SOURCE'].indexOf(a.coverage_class) >= 0 && p.team_data[s].is_fbs) lacking = true;
      unrated += (p.impact[s] && p.impact[s].unknown_impact) || 0;
    });
    if (lacking) noInj++;
    if (!p.market || p.market.books_reporting < 2) lt2++;
  });
  const provs = enr && enr.summary ? enr.summary.providers || [] : [];
  const mean = scores.length ? Math.round(10 * scores.reduce((s, v) => s + v, 0) / scores.length) / 10 : null;
  const per = {};
  games.forEach((g) => {
    const fam = {};
    (g.reliability.penalties || []).forEach((p) => { const f = p.family || (p.action_key ? String(p.action_key).split(':')[0] : p.component); fam[f] = Math.round(10 * ((fam[f] || 0) + p.points)) / 10; });
    const p = E[g.game_id];
    per[g.game_id] = { game: g.away + ' @ ' + g.home, score: g.reliability.score, grade: g.reliability.grade, fam,
      qb: p ? { home: p.quarterback.home.confirmation_level, away: p.quarterback.away.confirmation_level } : null,
      avail: p ? { home: p.availability.home.coverage_class, away: p.availability.away.coverage_class } : null };
  });
  return {
    at: (meta && meta.at) || new Date().toISOString(),
    reliability_generated_at: rel ? rel.generated_at : null, enrichment_generated_at: enr ? enr.generated_at : null,
    /* a count only the evidence packages can supply is null (NOT MEASURED)
       when there are none, never zero */
    counts: {
      games: games.length, mean, median: q(0.5), by_band: band,
      missing_qb_status: enr ? qbMissing : null, qb_conflicts_open: enr ? qbConf : null, qb_confirmed: enr ? qbConfirmed : null,
      games_lacking_injury_information: enr ? noInj : null, unrated_meaningful_absences: enr ? unrated : null,
      fcs_games_thin_data: fcsThin, games_under_two_market_sources: enr ? lt2 : null,
      stale_evidence_records: enr && enr.summary ? enr.summary.stale_evidence_records : null,
      provider_failures: enr ? provs.filter((p) => ['AUTH_FAILURE', 'DOWN', 'RATE_LIMITED'].indexOf(p.state) >= 0).length : null,
      provider_failures_attributable_to_run: enr ? provs.filter((p) => p.state === 'DOWN' && p.attributable_to === 'run_environment').length : null
    },
    providers: provs.map((p) => ({ provider: p.provider, state: p.state })),
    games: per
  };
}

const ORDER = ['VERY_LOW', 'LOW', 'CAUTION', 'ADEQUATE', 'STRONG', 'VERY_STRONG'];
const LABEL = { VERY_LOW: 'VERY LOW', LOW: 'LOW', CAUTION: 'CAUTION', ADEQUATE: 'ADEQUATE', STRONG: 'STRONG', VERY_STRONG: 'VERY STRONG' };
/* lower is better for these counts */
const LOWER_BETTER = ['missing_qb_status', 'qb_conflicts_open', 'games_lacking_injury_information', 'unrated_meaningful_absences',
  'fcs_games_thin_data', 'games_under_two_market_sources', 'stale_evidence_records', 'provider_failures'];
const NICE = { missing_qb_status: 'QB statuses missing', qb_conflicts_open: 'open QB conflicts', qb_confirmed: 'QB starters confirmed',
  games_lacking_injury_information: 'games lacking injury information', unrated_meaningful_absences: 'unrated meaningful absences',
  fcs_games_thin_data: 'FCS games at THIN DATA', games_under_two_market_sources: 'games under two market sources',
  stale_evidence_records: 'stale evidence records', provider_failures: 'provider failures', mean: 'mean reliability', median: 'median reliability' };

function compare(prev, cur) {
  const improved = [], degraded = [], why = [];
  if (!prev) return { baseline: true, improved, degraded, why: ['first audit: nothing to compare against'] };
  const P = prev.counts, Q = cur.counts;
  const sign = (x) => (x > 0 ? '+' : '') + (Math.round(x * 10) / 10);
  ['mean', 'median'].forEach((k) => {
    if (P[k] == null || Q[k] == null || P[k] === Q[k]) return;
    (Q[k] > P[k] ? improved : degraded).push(sign(Q[k] - P[k]) + ' ' + NICE[k] + ' (' + P[k] + ' → ' + Q[k] + ')');
  });
  if (Q.qb_confirmed !== P.qb_confirmed && P.qb_confirmed != null) (Q.qb_confirmed > P.qb_confirmed ? improved : degraded).push(sign(Q.qb_confirmed - P.qb_confirmed) + ' QB starters confirmed');
  LOWER_BETTER.forEach((k) => {
    if (P[k] == null || Q[k] == null || P[k] === Q[k]) return;
    (Q[k] < P[k] ? improved : degraded).push(sign(Q[k] - P[k]) + ' ' + NICE[k] + ' (' + P[k] + ' → ' + Q[k] + ')');
  });
  /* grade transitions, and the family that moved each */
  const moves = {};
  Object.keys(cur.games).forEach((id) => {
    const a = prev.games && prev.games[id], b = cur.games[id];
    if (!a || a.grade === b.grade) return;
    const k = LABEL[a.grade] + ' → ' + LABEL[b.grade];
    const up = ORDER.indexOf(b.grade) > ORDER.indexOf(a.grade);
    (moves[k] = moves[k] || { up, n: 0 }).n++;
    const fams = {};
    Object.keys(a.fam || {}).concat(Object.keys(b.fam || {})).forEach((f) => { fams[f] = (a.fam[f] || 0) - (b.fam[f] || 0); });
    const top = Object.keys(fams).sort((x, y) => Math.abs(fams[y]) - Math.abs(fams[x]))[0];
    const qbWhy = a.qb && b.qb ? ['home', 'away'].filter((s) => a.qb[s] !== b.qb[s]).map((s) => s + ' QB ' + a.qb[s] + ' → ' + b.qb[s]) : [];
    const avWhy = a.avail && b.avail ? ['home', 'away'].filter((s) => a.avail[s] !== b.avail[s]).map((s) => s + ' availability ' + a.avail[s] + ' → ' + b.avail[s]) : [];
    why.push(b.game + ': ' + LABEL[a.grade] + ' → ' + LABEL[b.grade] + ' (' + a.score + ' → ' + b.score + ')'
      + (top ? '; largest change: ' + top + ' ' + sign(fams[top]) + ' pts' : '') + (qbWhy.concat(avWhy).length ? '; ' + qbWhy.concat(avWhy).join(', ') : ''));
  });
  Object.keys(moves).forEach((k) => (moves[k].up ? improved : degraded).push(moves[k].n + ' game' + (moves[k].n === 1 ? '' : 's') + ' moved ' + k));
  const pp = {}; (prev.providers || []).forEach((p) => { pp[p.provider] = p.state; });
  (cur.providers || []).forEach((p) => {
    if (!pp[p.provider] || pp[p.provider] === p.state) return;
    const bad = ['AUTH_FAILURE', 'DOWN', 'RATE_LIMITED', 'STALE'];
    (bad.indexOf(p.state) >= 0 ? degraded : improved).push('provider ' + p.provider + ': ' + pp[p.provider] + ' → ' + p.state);
  });
  const newGames = Object.keys(cur.games).filter((id) => !(prev.games || {})[id]).length;
  const gone = Object.keys(prev.games || {}).filter((id) => !cur.games[id]).length;
  if (newGames || gone) why.unshift('the slate itself changed: ' + newGames + ' game' + (newGames === 1 ? '' : 's') + ' entered the window, ' + gone + ' left it (kicked off or rolled out)');
  return { baseline: false, improved, degraded, why: why.slice(0, 60) };
}

/* run(rel, enr): snapshot, compare with the last audit, persist */
function run(rel, enr, o) {
  o = o || {};
  const store = readJson(o.file || FILE, null) || { schema: 'edgedesk_enrichment_audit_v1', history: [] };
  const cur = snapshot(rel, enr, { at: o.at });
  /* the first audit has no previous refresh: it is compared with the
     baseline the caller supplies (the same slate scored without the
     evidence packages), and says so */
  const prev = store.latest || (o.baseline ? Object.assign({}, o.baseline, { baseline_of: o.baseline_label || 'baseline' }) : null);
  const diff = compare(prev, cur);
  const out = { schema: 'edgedesk_enrichment_audit_v1', generated_at: cur.at,
    basis: 'what EdgeDesk knows about the slate now against the previous refresh; an engineering audit, not a betting signal',
    latest: cur, previous: prev ? { at: prev.at, counts: prev.counts, baseline_of: prev.baseline_of || null } : null,
    what_improved: diff.improved, what_degraded: diff.degraded, why: diff.why,
    history: (store.history || []).concat([{ at: cur.at, counts: cur.counts }]).slice(-60) };
  if (o.write !== false) fs.writeFileSync(o.file || FILE, JSON.stringify(out, null, 1) + '\n');
  return out;
}

function text(a) {
  const L = [];
  const c = a.latest.counts;
  L.push('ENRICHMENT SELF-AUDIT — ' + a.generated_at);
  L.push('games ' + c.games + '  mean ' + c.mean + '  median ' + c.median + '  bands ' + JSON.stringify(c.by_band));
  L.push('missing QB status ' + c.missing_qb_status + '  open QB conflicts ' + c.qb_conflicts_open + '  confirmed QBs ' + c.qb_confirmed);
  L.push('games lacking injury info ' + c.games_lacking_injury_information + '  unrated meaningful absences ' + c.unrated_meaningful_absences);
  L.push('FCS games THIN DATA ' + c.fcs_games_thin_data + '  games <2 market sources ' + c.games_under_two_market_sources);
  L.push('stale evidence records ' + c.stale_evidence_records + '  provider failures ' + c.provider_failures
    + (c.provider_failures_attributable_to_run ? ' (' + c.provider_failures_attributable_to_run + ' refused by this run’s own network policy)' : ''));
  L.push('WHAT IMPROVED'); (a.what_improved.length ? a.what_improved : ['nothing']).forEach((x) => L.push('  ' + x));
  L.push('WHAT DEGRADED'); (a.what_degraded.length ? a.what_degraded : ['nothing']).forEach((x) => L.push('  ' + x));
  L.push('WHY'); a.why.slice(0, 15).forEach((x) => L.push('  ' + x));
  return L.join('\n');
}

if (require.main === module) {
  const ROOT = path.join(__dirname, '..', '..');
  const rel = readJson(path.join(ROOT, 'football', 'fbs', 'reliability.json'), null);
  const enr = readJson(path.join(__dirname, 'current.json'), null);
  if (!rel) { console.error('football/fbs/reliability.json is missing'); process.exit(2); }
  const a = run(rel, enr, { write: process.argv.indexOf('--write') >= 0 });
  console.log(process.argv.indexOf('--json') >= 0 ? JSON.stringify(a, null, 1) : text(a));
}

module.exports = { snapshot, compare, run, text };
