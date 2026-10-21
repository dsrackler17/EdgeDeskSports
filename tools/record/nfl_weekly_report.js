#!/usr/bin/env node
/* ===========================================================================
   weekly_model_report.md — the NFL weekly loop's report, rendered from what
   the loop wrote (nothing is computed here):

     record/football/weekly/nfl_<season>_wNN.json     the week, scored (tools/record/nfl_weekly_eval.js)
     football/research/nfl_v2/results/weekly/<run>.json  patterns, candidates, the gate (weekly_loop.js)
     football/research/nfl_v2/registry.json            the served version and its history
     football/nfl/slate.json                           next week's cards, rebuilt after the loop

   Usage
     node tools/record/nfl_weekly_report.js [--eval <file>] [--out weekly_model_report.md]
   Exit 0 = written or unchanged; 1 = no weekly evaluation to report.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const f1 = (x) => (x == null ? '—' : (+x).toFixed(1));
const f2 = (x) => (x == null ? '—' : (+x).toFixed(2));
const f3 = (x) => (x == null ? '—' : (+x).toFixed(3));
const f4 = (x) => (x == null ? '—' : (+x).toFixed(4));
const sgn = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + (+x).toFixed(2));
const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%');
const LABEL = { base_strength: 'Base strength', passing: 'Passing', rushing: 'Rushing', quarterback: 'QB', home_field: 'Home field', context: 'Context', rest_travel: 'Rest/travel' };

function scoreTable(b) {
  const row = (name, s) => `| ${name} | ${s && s.n || 0} | ${f3(s && s.mae)} | ${f4(s && s.brier)} | ${f4(s && s.logloss)} | ${s && s.clv ? `${sgn(s.clv.mean_pts)} (${s.clv.positive}+/${s.clv.negative}−, n ${s.clv.n})` : '—'} | ${s && s.ats_vs_close ? `${s.ats_vs_close.wins}-${s.ats_vs_close.n - s.ats_vs_close.wins}` : '—'} |`;
  return ['| number | games | margin MAE | Brier | log loss | CLV pts (mean) | ATS vs close |', '|---|---|---|---|---|---|---|',
    row('Published (what the site showed)', b.published), row('Replayed (served model, corrected pipeline)', b.replayed), row('Closing line', b.close)].join('\n');
}
function pairedLine(b) {
  const p = b.paired; if (!p || !p.n) return '';
  return `\nSame ${p.n} games for all three: MAE published ${f3(p.published.mae)} / replayed ${f3(p.replayed.mae)} / close ${f3(p.close.mae)}; log loss ${f4(p.published.logloss)} / ${f4(p.replayed.logloss)} / ${f4(p.close.logloss)}.\n`;
}
function calTable(c) {
  const rows = c.replayed.bins.map((b, i) => {
    if (!b.n && !(c.close.bins[i] || {}).n) return null;
    const cl = c.close.bins[i] || {};
    return `| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${pct(b.predicted)} | ${pct(b.observed)} | ${cl.n || 0} | ${pct(cl.predicted)} | ${pct(cl.observed)} |`;
  }).filter(Boolean);
  return ['| home win prob | replayed n | predicted | observed | close n | predicted | observed |', '|---|---|---|---|---|---|---|'].concat(rows).join('\n')
    + `\n\nECE: replayed ${f3(c.replayed.ece)}, published ${f3(c.published.ece)}, close ${f3(c.close.ece)}.`;
}

function render(o) {
  const ev = o.ev, loop = o.loop, reg = o.reg, slate = o.slate;
  const L = [];
  L.push(`# NFL weekly model report — ${ev.season} week ${ev.week}`, '');
  L.push(`Generated ${ev.generated_at}. Served model: **${reg ? reg.current : ev.served_model}**. Published numbers this week came from: ${(ev.published_versions || []).join(', ') || 'none recorded'}.`, '');
  L.push('Three numbers per game, never mixed: **published** is what the site showed before kickoff (the model record, never recomputed); **replayed** is what the model served today gives the same game from its pregame state through the corrected pipeline; **close** is nflverse\'s closing consensus. CLV: points the market moved toward the number\'s side (published: from the recorded quote; replayed: from the opener).', '');
  L.push(`## Week ${ev.week}`, '', scoreTable(ev.week_summary), pairedLine(ev.week_summary));
  L.push(`## Season to date (weeks ${ev.season_to_date.weeks.join(', ')})`, '', scoreTable(ev.season_to_date), pairedLine(ev.season_to_date));
  L.push('### Calibration (season to date)', '', calTable(ev.season_to_date.calibration), '');
  L.push(`## Disagreements of ${3}+ points with the close (week ${ev.week})`, '');
  if (!ev.flags.length) L.push('None.', '');
  else {
    L.push('| game | published − close | replayed − close | close | final | closer to the final (published / replayed) | biggest card drivers (replayed) |', '|---|---|---|---|---|---|---|');
    ev.flags.forEach((f) => L.push(`| ${f.matchup} | ${sgn(f.published_gap)} | ${sgn(f.replayed_gap)} | ${sgn(f.close_home_margin)} | ${sgn(f.final_home_margin)} | ${f.published_closer || '—'} / ${f.replayed_closer || '—'} | ${f.drivers.map((d) => `${LABEL[d.key] || d.key} ${sgn(d.points)}`).join(', ')} |`));
    L.push('');
  }
  L.push(`## Biggest misses (week ${ev.week}, replayed)`, '');
  L.push('| game | model | final | close | residual | market saw it | components pointing the wrong way | base strength prior / current |', '|---|---|---|---|---|---|---|---|');
  ev.misses.filter(Boolean).forEach((m) => L.push(`| ${m.matchup} | ${sgn(m.model_home_margin)} | ${sgn(m.final_home_margin)} | ${sgn(m.close_home_margin)} | ${sgn(m.residual)} | ${m.market_saw_it ? 'yes' : 'no'} | ${m.pushed_wrong_way.map((d) => `${LABEL[d.key] || d.key} ${sgn(d.points)}`).join(', ') || '—'} | ${sgn(m.base_strength_split.prior)} / ${sgn(m.base_strength_split.current)} |`));
  L.push('', '_Attribution reads the card; it is not a causal claim._', '');
  if (loop) {
    L.push('## Repeat patterns (season to date, replayed residuals)', '');
    L.push(`A pattern repeats when |t| ≥ ${loop.pattern_rule.t} on at least ${loop.pattern_rule.min_n} games and it points the same way in at least ${Math.round(loop.pattern_rule.min_week_share * 100)}% of the weeks it can be read in.`, '');
    L.push('| pattern | n | estimate | t | weeks same sign | repeats | reading |', '|---|---|---|---|---|---|---|');
    loop.patterns.forEach((p) => L.push(`| ${p.id} | ${p.n} | ${f3(p.estimate)} | ${f2(p.t)} | ${p.weeks ? `${p.weeks.same}/${p.weeks.weeks}` : '—'} | ${p.repeat ? '**yes**' : 'no'} | ${p.meaning || '—'} |`));
    L.push('', '## Candidates and the promotion gate', '');
    L.push('A candidate is promoted only if it beats the served model on margin MAE **and** log loss on the full walk-forward backtest (2010 through this season), on the 2025 holdout, and on 2010–2025 without this season.', '');
    if (!loop.candidates.length) L.push('No repeat pattern, so no candidate was generated this week. Nothing promoted.', '');
    else {
      const inc = loop.incumbent;
      L.push('| candidate | from pattern | full MAE | full log loss | 2025 MAE | 2025 log loss | 2010–25 MAE | 2010–25 log loss | verdict |', '|---|---|---|---|---|---|---|---|---|');
      if (inc) L.push(`| served ${loop.served.model_version} | — | ${f3(inc.full.mae)} | ${f4(inc.full.logloss)} | ${f3(inc.holdout.mae)} | ${f4(inc.holdout.logloss)} | ${f3(inc.through_holdout.mae)} | ${f4(inc.through_holdout.logloss)} | incumbent |`);
      loop.candidates.forEach((c) => L.push(`| ${c.id} | ${c.from_pattern} | ${f3(c.metrics.full.mae)} | ${f4(c.metrics.full.logloss)} | ${f3(c.metrics.holdout.mae)} | ${f4(c.metrics.holdout.logloss)} | ${f3(c.metrics.through_holdout.mae)} | ${f4(c.metrics.through_holdout.logloss)} | ${c.gate.passed ? '**PASSED**' : 'rejected — ' + c.gate.why.replace(/^does not beat the served model on margin MAE and log loss on: /, 'fails ')} |`));
      L.push('', loop.promoted ? `**Promoted ${loop.promoted.model_version}** (${loop.promoted.candidate}), archived for rollback; registry and supabase/nfl_model_registry.sql updated.` : 'Nothing promoted.', '');
    }
  }
  if (slate && Array.isArray(slate.games)) {
    const up = slate.games.filter((g) => g.model_status === 'PREDICTED');
    L.push(`## Next week's cards (${up.length} games, rebuilt on ${slate.served_model ? slate.served_model.model_version : 'the served model'})`, '');
    L.push('| game | model home margin | win prob | reference close | model − market | card: base / pass / rush / QB / home / context / rest | flag |', '|---|---|---|---|---|---|---|');
    up.forEach((g) => {
      const ref = g.reference_market && g.reference_market.home_margin != null ? g.reference_market.home_margin : null;
      const d = ref == null ? null : g.model_home_margin - ref;
      const rows = g.card && g.card.rows ? Object.fromEntries(g.card.rows.map((r) => [r.key, r.points])) : {};
      L.push(`| ${g.away_code} @ ${g.home_code} | ${sgn(g.model_home_margin)} | ${pct(g.model_home_win_prob)} | ${sgn(ref)} | ${sgn(d)} | ${['base_strength', 'passing', 'rushing', 'quarterback', 'home_field', 'context', 'rest_travel'].map((k) => f1(rows[k])).join(' / ')} | ${d != null && Math.abs(d) >= 3 ? `Model disagrees with market by ${Math.abs(d).toFixed(1)} pts` : ''} |`);
    });
    L.push('');
  }
  if (reg) {
    L.push('## Version history', '', '| version | status | role |', '|---|---|---|');
    reg.versions.forEach((v) => L.push(`| ${v.model_version} | ${v.status} | ${v.role || ''} |`));
    L.push('', `Rollback: \`node football/research/nfl_v2/weekly_loop.js --rollback <version>\` restores an archived version's params (football/research/nfl_v2/versions/).`, '');
  }
  return L.join('\n');
}

function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const dir = path.join(ROOT, 'record', 'football', 'weekly');
  const idx = readJson(path.join(dir, 'index.json'));
  const evFile = v('--eval', idx && idx.latest ? path.join(dir, idx.latest.file) : null);
  const ev = evFile && readJson(path.resolve(evFile));
  if (!ev) { console.error('no weekly evaluation to report'); process.exit(1); }
  const run = `${ev.season}_w${String(ev.week).padStart(2, '0')}`;
  const md = render({
    ev, loop: readJson(path.join(ROOT, 'football', 'research', 'nfl_v2', 'results', 'weekly', run + '.json')),
    reg: readJson(path.join(ROOT, 'football', 'research', 'nfl_v2', 'registry.json')),
    slate: readJson(path.join(ROOT, 'football', 'nfl', 'slate.json')),
  });
  const out = path.resolve(v('--out', path.join(ROOT, 'weekly_model_report.md')));
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (cur === md) console.log('unchanged ' + path.relative(ROOT, out));
  else { fs.writeFileSync(out, md); console.log('wrote ' + path.relative(ROOT, out)); }
}
if (require.main === module) main();
module.exports = { render };
