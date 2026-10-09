#!/usr/bin/env node
/* ===========================================================================
   THE SYSTEM-INTEGRITY AUDIT, reproduced from committed data
   (docs/system-integrity/AUDIT.md §0–§6). Read-only: it reads committed
   artifacts and writes nothing unless --out is given.

   Every figure is computed twice where the audit compares them: under the
   rule the old build used, and under the canonical layer
   (lib/edgedesk_calc.js, lib/edgedesk_schedule.js, lib/edgedesk_integrity.js).
   The committed football/cfb_terminal/games.json is the build the audit
   measured (2026-10-08T19:07:42Z); the hourly pipeline replaces it with a
   build from the canonical layer, after which the "old rule" column measures
   what the old renderer WOULD have shown on today's data.

   Run:  node tools/integrity/audit.js            # the text report
         node tools/integrity/audit.js --json     # the figures as JSON
         node tools/integrity/audit.js --out FILE # also write the JSON
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CALC = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const SCHED = require(path.join(ROOT, 'lib', 'edgedesk_schedule.js'));
const INTEG = require(path.join(ROOT, 'lib', 'edgedesk_integrity.js'));
const LAB = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.indexOf('--' + k) > 0;
const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (e) { return null; } };

const G = read('football/cfb_terminal/games.json');
if (!G || !G.games) { console.error('football/cfb_terminal/games.json is missing'); process.exit(2); }
const games = Object.values(G.games);
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
/* the old renderer's rounding: Math.round on each figure separately */
const oldR = (x) => Math.round(x * 10) / 10;
const out = { generated_at: new Date().toISOString(), source: { games_json: G.generated_at, games: games.length }, sections: {} };

/* ── §0 the board's counts, old definitions vs corrected ───────────────── */
{
  const byWeek = {}, byKey = {};
  games.forEach((g) => { byWeek[g.week] = (byWeek[g.week] || 0) + 1; const k = g.research_status && g.research_status.key || 'NONE'; byKey[k] = (byKey[k] || 0) + 1; });
  const quoted = games.filter((g) => g.market && g.market.available && num(g.market.consensus_home_line) != null);
  const usable = quoted.filter((g) => !g.market.stale && !(g.research_status && /FAULT/.test(g.research_status.key)));
  const k = (x) => byKey[x] || 0;
  out.sections.counts = {
    displayed: games.length, by_week: byWeek,
    by_research_key: byKey,
    old: { research_grade: k('WORTH_RESEARCHING') + k('INVESTIGATE') + k('VERIFIED_MAJOR'), with_quote: quoted.length,
      note: 'research-grade summed INVESTIGATE in; "with a quote" counted stale and faulted quotes' },
    corrected: { research_grade: k('WORTH_RESEARCHING') + k('VERIFIED_MAJOR'), investigate: k('INVESTIGATE'), usable_market: usable.length,
      stale_or_faulted: quoted.length - usable.length, no_market: games.length - quoted.length },
    reconciles: INTEG.countBoard(games.map((g) => ({ scope: null, research_key: g.research_status && g.research_status.key,
      market_state: !g.market || !g.market.available ? 'NONE' : (g.research_status && /FAULT/.test(g.research_status.key) ? 'FAULT' : (g.market.stale ? 'STALE' : 'FRESH')) }))).reconciles
  };
}

/* ── §1 Problem A: gaps, the near-pick'em floor, score lines ───────────── */
{
  const priced = games.filter((g) => g.edgedesk && g.edgedesk.available && num(g.edgedesk.home_margin) != null && g.market && num(g.market.consensus_home_line) != null);
  const floor = [], indep = [], canon = [];
  priced.forEach((g) => {
    const m = g.edgedesk.home_margin, k = -g.market.consensus_home_line, who = g.game.away + ' @ ' + g.game.home;
    const rawGap = Math.abs(m - k);
    /* the floor: |raw margin| < 1 was printed as ±1 */
    if (Math.abs(m) < 1 && m !== 0) {
      const floored = Math.sign(m) * 1;
      floor.push({ game: who, raw_margin: m, floored_display: floored, market_margin: k, shown_gap: oldR(rawGap), gap_from_displayed: oldR(Math.abs(floored - k)) });
    }
    /* independent rounding: the fair line, the market and the gap each rounded alone */
    const shownGap = oldR(rawGap), fromShown = oldR(Math.abs(oldR(m) - oldR(k)));
    if (shownGap !== fromShown) indep.push({ game: who, fair: oldR(-m), market: oldR(-k), shown_gap: shownGap, gap_from_displayed: fromShown });
    /* the canonical layer: the gap IS the difference of the displayed lines */
    const c = CALC.spreadComparison({ home: g.game.home, away: g.game.away, model_home_margin: m, market_home_margin: k });
    if (c.gap !== Math.abs(Math.round(c.model.display * 10) - Math.round(c.market.display * 10)) / 10) canon.push({ game: who, c: c.reconcile.formula });
  });
  const withScore = games.filter((g) => g.edgedesk && g.edgedesk.available && g.edgedesk.projected_score && num(g.edgedesk.home_margin) != null && num(g.edgedesk.fair_total) != null);
  const scoresOld = withScore.filter((g) => {
    const ps = g.edgedesk.projected_score, h = num(ps.home), a = num(ps.away);
    return h != null && a != null && (oldR(h - a) !== oldR(g.edgedesk.home_margin) || oldR(h + a) !== oldR(g.edgedesk.fair_total));
  });
  const scoresCanon = withScore.filter((g) => {
    const s = CALC.projectedScores({ home: g.game.home, away: g.game.away, home_margin: g.edgedesk.home_margin, total: g.edgedesk.fair_total });
    return !CALC.scoresReconcile(s.home, s.away, g.edgedesk.home_margin, g.edgedesk.fair_total, s.decimals).ok;
  });
  /* what the committed build actually PRINTED: its fair line, its consensus
     and its gap texts, read back and compared */
  const marginOfText = (t, g) => {
    if (!t) return null; if (/pick/i.test(t)) return 0;
    const m = /^(.*) ([+-]?\d+(?:\.\d+)?)$/.exec(String(t).trim()); if (!m) return null;
    const line = +m[2]; return m[1] === g.game.home ? -line : (m[1] === g.game.away ? line : null);
  };
  const printed = [];
  let printedN = 0;
  priced.forEach((g) => {
    const f = marginOfText(g.edgedesk.fair_text, g), k = marginOfText(g.market.consensus_text, g), gt = g.disagreement && /^(\d+(?:\.\d+)?) pts?/.exec(String(g.disagreement.text || ''));
    if (f == null || k == null || !gt) return;
    printedN++;
    const want = Math.abs(Math.round(f * 10) - Math.round(k * 10)) / 10;
    if (+gt[1] !== want) printed.push({ game: g.game.away + ' @ ' + g.game.home, fair: g.edgedesk.fair_text, market: g.market.consensus_text, shown_gap: +gt[1], gap_from_displayed: want });
  });
  out.sections.gaps = {
    priced: priced.length,
    printed_by_committed_build: { mismatches: printed.length, of: printedN, examples: printed.slice(0, 5), note: 'the gap text the committed build printed vs the difference of the two lines it printed' },
    near_pickem_floor: { count: floor.length, rows: floor, note: 'the engine’s display floor (±1) printed beside a gap measured from the raw margin' },
    independent_rounding: { old_rule_mismatches: indep.length, of: priced.length, examples: indep.slice(0, 5), canonical_mismatches: canon.length },
    score_lines: { old_rule_mismatches: scoresOld.length, of: withScore.length, examples: scoresOld.slice(0, 3).map((g) => g.edgedesk.projected_score.text + ' beside ' + g.edgedesk.fair_text),
      canonical_mismatches: scoresCanon.length }
  };
}

/* ── §2 Problem B: kickoffs and weeks ──────────────────────────────────── */
{
  const slate = read('football/fbs/slate.json');
  const slateGames = slate ? (Array.isArray(slate.games) ? slate.games : Object.values(slate.games || {})) : [];
  const flagCarried = slateGames.some((g) => Object.prototype.hasOwnProperty.call(g, 'start_time_tbd') || Object.prototype.hasOwnProperty.call(g, 'kickoff_tbd'));
  const states = {}, placeholderByWeek = {};
  games.forEach((g) => {
    const s = slateGames.find((x) => String(x.game_id || x.id) === String(g.game_id)) || {};
    const k = SCHED.kickoffOf({ kickoff: g.kickoff, start_time_tbd: s.start_time_tbd != null ? s.start_time_tbd : (s.kickoff_tbd != null ? s.kickoff_tbd : undefined) });
    states[k.state] = (states[k.state] || 0) + 1;
    if (SCHED.isPlaceholderInstant(k.ms)) placeholderByWeek[g.week] = (placeholderByWeek[g.week] || 0) + 1;
  });
  const cur = SCHED.currentWeek(games.map((g) => ({ season: g.season, week: g.week, kickoff: g.kickoff, status: g.status && g.status.key })), Date.parse(G.generated_at));
  out.sections.kickoffs = {
    slate_carries_tbd_flag: flagCarried,
    kickoff_states: states, placeholder_instants_by_week: placeholderByWeek,
    current_week: cur ? cur.week : null,
    future_week_games: cur ? games.filter((g) => SCHED.scope(g, cur) === 'FUTURE_WEEK').length : null,
    note: flagCarried ? 'the slate carries start_time_tbd: placeholders are TBA' : 'the committed slate predates the flag: the placeholder instant (midnight Eastern) is SUSPECT, never confirmed'
  };
}

/* ── §3 Problem C: research × decision ─────────────────────────────────── */
{
  const combos = {};
  games.forEach((g) => {
    const rk = g.research_status && g.research_status.key || 'NONE', dk = g.decision_status && g.decision_status.key || 'NO_DECISION';
    const key = rk + ' + ' + dk;
    combos[key] = combos[key] || { n: 0, why: INTEG.whyDiffer(rk, dk, g.decision_status && g.decision_status.reason) };
    combos[key].n++;
  });
  out.sections.statuses = combos;
}

/* ── §4 Problem D: the two EV layers and the calibrator ────────────────── */
{
  const priced = games.filter((g) => g.quote_ev && g.quote_ev.best_ev_quote && g.ev && g.ev.selected);
  const opposite = priced.filter((g) => !new RegExp('^' + String(g.ev.selected.team).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ').test(g.quote_ev.best_ev_quote));
  const cal = (games.find((g) => g.ev && g.ev.calibration) || {}).ev;
  const q = INTEG.calibrationQuality(cal && cal.calibration);
  out.sections.ev = {
    priced: priced.length, layers_on_opposite_sides: opposite.length,
    examples: opposite.slice(0, 4).map((g) => ({ game: g.game.away + ' @ ' + g.game.home, ev_layer: g.ev.selected.team + ' ' + g.ev.selected.line_text, quote_ev_best_raw: g.quote_ev.best_ev_quote, raw_ev_pct: g.quote_ev.best_ev_pct })),
    calibration: { status: cal && cal.calibration && cal.calibration.status, maturity: cal && cal.calibration && cal.calibration.maturity, oof: cal && cal.calibration && cal.calibration.oof, quality: q.state, text: q.text }
  };
}

/* ── §5 Problem E: market anomalies ────────────────────────────────────── */
{
  const reasons = {};
  let input = 0, quarantined = 0;
  games.forEach((g) => {
    const qs = (g.market && g.market.quotes || []).map((x, i) => Object.assign({ quote_id: g.game_id + ':' + i, market_type: 'spread', period: 'game', home_team: g.game.home, away_team: g.game.away }, x));
    if (!qs.length) return;
    const s = LAB.screenSet(qs, { game: { home: g.game.home, away: g.game.away } });
    input += s.counts.input; quarantined += s.counts.quarantined;
    s.quarantined.forEach((x) => x.reasons.forEach((r) => { reasons[r] = (reasons[r] || 0) + 1; }));
  });
  const faults = games.filter((g) => g.research_status && /FAULT/.test(g.research_status.key)).map((g) => g.game.away + ' @ ' + g.game.home + ': ' + (g.research_status.reason || g.research_status.key));
  out.sections.market = { quotes_screened: input, quarantined, by_reason: reasons, faulted_games: faults, stale_games: games.filter((g) => g.market && g.market.stale).length };
}

/* ── §6 quarterbacks ───────────────────────────────────────────────────── */
{
  const st = {};
  games.forEach((g) => ['home', 'away'].forEach((s) => { const x = g.qb && g.qb[s]; const k = x ? x.status || 'UNKNOWN' : 'NONE'; st[k] = (st[k] || 0) + 1; }));
  out.sections.quarterbacks = { by_status: st, sourced_reports: 0,
    note: 'every status is inferred from play-by-play attribution; none is a sourced report, so none may be written as uncertainty (lib/edgedesk_availability.js)' };
}

if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 2) + '\n');
if (flag('json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const S = out.sections;
const L = [];
L.push('SYSTEM-INTEGRITY AUDIT — from committed data (games.json ' + out.source.games_json + ')');
L.push('');
L.push('§0 counts: ' + S.counts.displayed + ' games · by week ' + JSON.stringify(S.counts.by_week));
L.push('   old "research-grade" ' + S.counts.old.research_grade + ' → corrected ' + S.counts.corrected.research_grade + ' research-grade + ' + S.counts.corrected.investigate + ' investigate');
L.push('   old "with a quote" ' + S.counts.old.with_quote + ' → ' + S.counts.corrected.usable_market + ' usable, ' + S.counts.corrected.stale_or_faulted + ' stale or faulted, ' + S.counts.corrected.no_market + ' none');
L.push('   reconciles: ' + JSON.stringify(S.counts.reconciles));
L.push('§1 gaps: ' + S.gaps.priced + ' priced · near-pick’em floor beside a gap: ' + S.gaps.near_pickem_floor.count);
S.gaps.near_pickem_floor.rows.forEach((r) => L.push('   ' + r.game + ': raw ' + r.raw_margin + ', shown ±1, market ' + r.market_margin + ' → shown gap ' + r.shown_gap + ' vs ' + r.gap_from_displayed + ' from the displayed figures'));
L.push('   as printed by the committed build: ' + S.gaps.printed_by_committed_build.mismatches + ' of ' + S.gaps.printed_by_committed_build.of + ' gaps differ from the two lines printed beside them');
S.gaps.printed_by_committed_build.examples.slice(0, 3).forEach((r) => L.push('     ' + r.game + ': ' + r.fair + ' vs ' + r.market + ' → shown ' + r.shown_gap + ', displayed lines give ' + r.gap_from_displayed));
L.push('   independent rounding: ' + S.gaps.independent_rounding.old_rule_mismatches + ' of ' + S.gaps.independent_rounding.of + ' under the old rule · ' + S.gaps.independent_rounding.canonical_mismatches + ' under the canonical layer');
L.push('   score lines: ' + S.gaps.score_lines.old_rule_mismatches + ' of ' + S.gaps.score_lines.of + ' do not reconcile as committed · ' + S.gaps.score_lines.canonical_mismatches + ' under the canonical layer');
L.push('§2 kickoffs: ' + JSON.stringify(S.kickoffs.kickoff_states) + ' · placeholder instants by week ' + JSON.stringify(S.kickoffs.placeholder_instants_by_week));
L.push('   current week ' + S.kickoffs.current_week + ' · future-week games ' + S.kickoffs.future_week_games + ' · ' + S.kickoffs.note);
L.push('§3 research × decision:');
Object.keys(S.statuses).sort((a, b) => S.statuses[b].n - S.statuses[a].n).forEach((k) => L.push('   ' + String(S.statuses[k].n).padStart(3) + '  ' + k));
L.push('§4 EV: ' + S.ev.layers_on_opposite_sides + ' of ' + S.ev.priced + ' priced games have the two EV layers on opposite sides');
S.ev.examples.forEach((e) => L.push('   ' + e.game + ': ev layer ' + e.ev_layer + ' · best raw quote ' + e.quote_ev_best_raw + ' (raw ' + e.raw_ev_pct + '%)'));
L.push('   calibrator: ' + S.ev.calibration.status + ' / ' + S.ev.calibration.maturity + ' → ' + S.ev.calibration.quality + ': ' + S.ev.calibration.text);
L.push('§5 market: ' + S.market.quotes_screened + ' quotes screened, ' + S.market.quarantined + ' quarantined ' + JSON.stringify(S.market.by_reason) + ' · ' + S.market.stale_games + ' stale games · faulted: ' + (S.market.faulted_games.join('; ') || 'none'));
L.push('§6 quarterbacks: ' + JSON.stringify(S.quarterbacks.by_status) + ' · sourced reports: ' + S.quarterbacks.sourced_reports);
console.log(L.join('\n'));
