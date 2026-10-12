/*__EDCHALLENGE_START__*/
/* ===========================================================================
   EdgeDesk CHALLENGE PASS (EDCHALLENGE) — an independent attempt to break a
   conclusion before it is published. docs/research-engine/ARCHITECTURE.md §6

   THE EIGHT QUESTIONS (the brief's, verbatim)
     Q1 What evidence contradicts this conclusion?
     Q2 Are the statistics outdated?
     Q3 Is the sample size adequate?
     Q4 Are key players missing?
     Q5 Is the market quote stale?
     Q6 Are the model assumptions calibrated?
     Q7 Could this apparent edge be caused by missing data?
     Q8 Does the conclusion survive reasonable alternative assumptions?

   Each is answered only from what the run actually holds: the researcher's
   findings and conflicts, the evidence ledger (EDEVIDENCE), the calculation
   ledger (EDQVERIFY), the disagreement diagnosis, the audit and the
   sensitivity. Each answer is CLEAR · CONCERN (noted, does not lower) ·
   UNRESOLVED (IMPORTANT or CRITICAL) · UNKNOWN (could not be checked;
   counts as unresolved) · NOT_APPLICABLE (with why).

   WHAT IT DOES WITH THE ANSWERS — it can only lower, never raise
     a CRITICAL item that research could settle (a key contradiction, a key
       player missing)  → at best RESEARCH REQUIRED
     a CRITICAL item research cannot settle (a stale quote, an unvalidated
       model pricing the bet, a suspected data fault)  → PASS
     an IMPORTANT item  → a VERIFIED CANDIDATE becomes WATCHLIST; research
       confidence drops one level per item
   outcome: STANDS · CONFIDENCE_LOWERED (open items; the class already says
   as much) · DOWNGRADED · PASS
   Research confidence is a category (HIGH · MODERATE · LOW · INSUFFICIENT)
   with its reasons — never a percentage, and never mixed with the win
   probability, which is the price's business.

   Browser/Node/Deno: UMD, ES5. Inlined into supabase/functions/edgedesk_ai/index.ts.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDCHALLENGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_challenge_v1';
  var QUESTIONS = [
    ['Q1_CONTRADICTIONS', 'What evidence contradicts this conclusion?'],
    ['Q2_OUTDATED_STATISTICS', 'Are the statistics outdated?'],
    ['Q3_SAMPLE_SIZE', 'Is the sample size adequate?'],
    ['Q4_KEY_PLAYERS', 'Are key players missing?'],
    ['Q5_STALE_QUOTE', 'Is the market quote stale?'],
    ['Q6_CALIBRATION', 'Are the model assumptions calibrated?'],
    ['Q7_MISSING_DATA', 'Could this apparent edge be caused by missing data?'],
    ['Q8_ALTERNATIVES', 'Does the conclusion survive reasonable alternative assumptions?']
  ];
  var SCALE = ['HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'];
  /* the researcher's own research-confidence level → the starting category */
  var FROM_RESEARCH = { GOOD: 'HIGH', THIN: 'MODERATE', PARTIAL: 'MODERATE', CONFLICTED: 'LOW', NONE: 'INSUFFICIENT' };
  var RANK = { VERIFIED_CANDIDATE: 0, WATCHLIST: 1, RESEARCH_REQUIRED: 2, REJECTED: 3, UNVERIFIED: 4 };
  var MIN_N = { held_out: 100, record: 300 }; /* the validation rules' minimums (min_cal_n, LEAN min_n) */

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function rec(L, name) { return L && L.records ? L.records.filter(function (x) { return x.name === name; })[0] || null : null; }
  function item(id, status, o) {
    o = o || {};
    var q = QUESTIONS.filter(function (x) { return x[0] === id; })[0];
    return { id: id, question: q[1], status: status, severity: status === 'UNRESOLVED' || status === 'UNKNOWN' ? (o.severity || 'IMPORTANT') : status === 'CONCERN' ? 'MINOR' : null,
      resolvable_by_research: !!o.resolvable, answer: o.answer, refs: o.refs || [] };
  }
  function normTeam(t) { return str(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function sameTeam(a, b) { var x = normTeam(a), y = normTeam(b); return !!x && !!y && (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0); }
  function isKeyFinding(f) { return !!f && (f.key === true || /^QB$|QUARTERBACK/i.test(str(f.role)) || f.topic === 'starter'); }

  /**
   * o: { classification: {classification, reasons}, candidate, research (EDAGENTS research()), evidence (EDEVIDENCE ledger),
   *      calc (EDQVERIFY ledger), disagreement (EDDISAGREE), audit, sensitivity, adjustments, research_level ('GOOD'|...),
   *      scenario_deltas { home_qb_out, away_qb_out }, side ('home'|'away') }
   */
  function challenge(o) {
    o = o || {};
    var c = o.candidate || {}, R = o.research || {}, E = o.evidence || null, L = o.calc || null, D = o.disagreement || null, a = o.audit || {}, S = o.sensitivity || null;
    /* what actually priced it: the EV record's fair source (a model candidate can be priced on the lower-EV audited market fair) */
    var fairKind = (function () { var ev = rec(L, 'EXPECTED_VALUE'); var fi = ev && ev.status === 'COMPUTED' ? ev.inputs.filter(function (i) { return i.name === 'fair probability'; })[0] : null; if (fi) return /^MODEL\b/.test(str(fi.source)) ? 'MODEL' : 'MARKET'; return c.fair && c.fair.method === 'MODEL_BLEND' ? 'MODEL' : 'MARKET'; })();
    var priced = !!(L && L.market_comparison && L.market_comparison.status === 'AVAILABLE');
    var findings = R.findings || [], byId = {};
    findings.forEach(function (f) { byId[f.id] = f; });
    var out = [];

    /* Q1 — contradictions */
    var open = (R.unresolved || []).slice();
    var contradicted = E ? E.records.filter(function (x) { return x.verification === 'CONTRADICTED'; }) : [];
    if (open.length || contradicted.length) {
      var keyed = open.some(function (cf) { return (cf.findings || []).some(function (id) { return isKeyFinding(byId[id]); }); });
      out.push(item('Q1_CONTRADICTIONS', 'UNRESOLVED', { severity: keyed ? 'CRITICAL' : 'IMPORTANT', resolvable: true,
        answer: (open.length ? open.map(function (cf) { return cf.detail + ' (' + (cf.why_unresolved || 'unresolved') + ')'; }).join('; ') : contradicted.map(function (x) { return x.claim; }).join('; ')) + (keyed ? ' — about a key player' : ''),
        refs: contradicted.map(function (x) { return x.id; }) }));
    } else {
      var settled = (R.conflicts || []).filter(function (cf) { return cf.resolved; });
      out.push(item('Q1_CONTRADICTIONS', 'CLEAR', { answer: findings.length ? 'No unresolved contradiction among ' + findings.length + ' finding' + (findings.length === 1 ? '' : 's') + (settled.length ? '; ' + settled.length + ' conflict' + (settled.length === 1 ? ' was' : 's were') + ' settled (' + settled.map(function (cf) { return cf.resolution && cf.resolution.by; }).filter(Boolean).join('; ') + ')' : '') : 'No research findings to contradict it (see Q7)' }));
    }

    /* Q2 — outdated statistics. A lineup, availability or pricing input is unresolved when it is STALE (past three times
       its window), or AGING inside a day of the game, when a change is most likely and costs most. Far from the game an
       aging input is noted: a depth chart a day old six days out is not what decides a bet. Anything else is noted. */
    var recs = E ? E.records.filter(function (x) { return x.type !== 'MARKET_QUOTE'; }) : [];
    var old = recs.filter(function (x) { return x.freshness && (x.freshness.status === 'STALE' || x.freshness.status === 'AGING'); });
    var isKeyRec = function (x) { return ['availability', 'starter', 'lineup'].indexOf(x.subject.topic) >= 0 || (x.type === 'MODEL_ESTIMATE' && fairKind === 'MODEL'); };
    var nearGame = function (x) { return /inside a day of the game/.test(str(x.freshness && x.freshness.basis)); };
    var oldKey = old.filter(function (x) { return isKeyRec(x) && (x.freshness.status === 'STALE' || nearGame(x)); }), oldOther = old.filter(function (x) { return oldKey.indexOf(x) < 0; });
    if (!recs.length) out.push(item('Q2_OUTDATED_STATISTICS', 'UNKNOWN', { severity: 'IMPORTANT', resolvable: true, answer: 'No dated statistic, report or projection is on file for this game, so freshness cannot be checked' }));
    else if (oldKey.length) out.push(item('Q2_OUTDATED_STATISTICS', 'UNRESOLVED', { severity: 'IMPORTANT', resolvable: true, answer: oldKey.map(function (x) { return x.claim + ' — ' + x.freshness.age_min + ' min old, ' + x.freshness.status.toLowerCase() + ' (' + x.freshness.basis + ')'; }).slice(0, 3).join('; '), refs: oldKey.map(function (x) { return x.id; }) }));
    else if (oldOther.length) {
      var keyAging = oldOther.filter(isKeyRec);
      out.push(item('Q2_OUTDATED_STATISTICS', 'CONCERN', { answer: oldOther.length + ' record' + (oldOther.length === 1 ? '' : 's') + ' past ' + (oldOther.length === 1 ? 'its' : 'their') + ' window (' + oldOther.map(function (x) { return x.subject.topic; }).filter(function (t, i, a) { return a.indexOf(t) === i; }).join(', ') + ')'
        + (keyAging.length ? '; the lineup or availability ones are aging, not stale, and the game is more than a day away — re-check them before it' : '; none is a lineup, availability or pricing input'), refs: oldOther.map(function (x) { return x.id; }) }));
    }
    else out.push(item('Q2_OUTDATED_STATISTICS', 'CLEAR', { answer: 'Every dated record is fresh for its topic (' + recs.length + ' checked)' }));

    /* Q3 — sample size (of the model that prices it) */
    var cal = rec(L, 'CALIBRATION'), co = cal && cal.output;
    if (!priced) out.push(item('Q3_SAMPLE_SIZE', 'NOT_APPLICABLE', { answer: 'Nothing is priced, so no model sample is relied on' }));
    else if (fairKind !== 'MODEL') out.push(item('Q3_SAMPLE_SIZE', 'NOT_APPLICABLE', { answer: 'The price is judged against the de-vigged sharp market, not a model sample; that method\'s record is the closing-line ledger' + (co && co.record_vs_close ? '. The model cross-check\'s record at this gap: ' + co.record_vs_close.wins + '-' + (co.record_vs_close.n - co.record_vs_close.wins - (co.record_vs_close.pushes || 0)) + ' against the close (n ' + co.record_vs_close.n + ')' : '') }));
    else if (!co || (co.held_out_n == null && !co.record_vs_close)) out.push(item('Q3_SAMPLE_SIZE', 'UNKNOWN', { severity: 'CRITICAL', answer: 'The model prices this bet but no validation sample is on file' }));
    else {
      var nRec = co.record_vs_close ? co.record_vs_close.n : null, nHeld = co.held_out_n;
      var thin = (nRec != null && nRec < MIN_N.record) || (nHeld != null && nHeld < MIN_N.held_out);
      out.push(item('Q3_SAMPLE_SIZE', thin ? 'UNRESOLVED' : 'CLEAR', { severity: 'IMPORTANT', answer: (nHeld != null ? 'held-out calibration n ' + nHeld : '') + (nHeld != null && nRec != null ? '; ' : '') + (nRec != null ? 'record against the close at gaps of ' + co.record_vs_close.threshold_points + '+ points n ' + nRec : '') + (thin ? ' — below the ' + (nRec != null && nRec < MIN_N.record ? MIN_N.record + ' the LEAN tier requires' : MIN_N.held_out + ' a calibration table needs') : ''), refs: [cal.id] }));
    }

    /* Q4 — key players */
    var miss = (R.missing || []).filter(function (m) { return /availability|starter|lineup/.test(str(m.topic || m)); });
    var gaps = (R.gaps || []).filter(function (g) { return g.kind === 'ABSENCE_NOT_IN_MODEL' || g.kind === 'STARTER_MISMATCH'; });
    var adjusted = (o.adjustments || []).length > 0;
    var unconfirmed = (R.gaps || []).filter(function (g) { return g.kind === 'REPORTED_ABSENCE_UNCONFIRMED'; });
    if (unconfirmed.length) {
      /* never priced on, never settled by a scenario: only a confirming or denying report settles it */
      var keyQB = unconfirmed.some(function (g) { return g.priced_starter || /QB/i.test(str(g.role)); });
      out.push(item('Q4_KEY_PLAYERS', 'UNRESOLVED', { severity: keyQB ? 'CRITICAL' : 'IMPORTANT', resolvable: true, answer: unconfirmed.map(function (g) { return g.detail; }).join('; ') }));
    } else if (gaps.length && !adjusted) {
      var qbGap = gaps.some(function (g) { return g.kind === 'STARTER_MISMATCH' || isKeyFinding(byId[g.finding]) && /QB/i.test(str(byId[g.finding] && byId[g.finding].role)); });
      out.push(item('Q4_KEY_PLAYERS', 'UNRESOLVED', { severity: qbGap ? 'CRITICAL' : 'IMPORTANT', resolvable: true, answer: gaps.map(function (g) { return g.detail; }).join('; ') + ' — and no model scenario quantifies it' }));
    } else if (miss.length) out.push(item('Q4_KEY_PLAYERS', 'UNKNOWN', { severity: 'IMPORTANT', resolvable: true, answer: 'Not checked: ' + miss.map(function (m) { return typeof m === 'string' ? m : str(m.topic) + (m.team ? ' for ' + m.team : '') + (m.why ? ' (' + m.why + ')' : ''); }).join('; ') }));
    else {
      var outs = findings.filter(function (f) { return isKeyFinding(f) && (f.status === 'OUT' || f.status === 'DOUBTFUL') && !f.speculative; });
      out.push(item('Q4_KEY_PLAYERS', 'CLEAR', { answer: (gaps.length && adjusted ? 'Absences found and priced by a model scenario: ' + gaps.map(function (g) { return g.player; }).join(', ') : outs.length ? 'Key absences on file and carried by the model: ' + outs.map(function (f) { return f.player + ' ' + f.status.toLowerCase(); }).join(', ') : 'No key absence the model does not carry') }));
    }

    /* Q5 — the quote */
    var fr = rec(L, 'MARKET_FRESHNESS');
    if (!priced) out.push(item('Q5_STALE_QUOTE', 'UNRESOLVED', { severity: 'CRITICAL', answer: 'No verified quote: ' + (L && L.market_comparison ? L.market_comparison.why : 'the market comparison is unavailable') + '. Nothing is actionable without one' }));
    else if (!fr || fr.status !== 'COMPUTED') out.push(item('Q5_STALE_QUOTE', 'UNKNOWN', { severity: 'CRITICAL', answer: 'The quote carries no capture time, so it cannot be treated as current' }));
    else {
      var fst = fr.output.status;
      out.push(item('Q5_STALE_QUOTE', fst === 'STALE' || fst === 'UNKNOWN' ? 'UNRESOLVED' : fst === 'AGING' ? 'CONCERN' : 'CLEAR', { severity: 'CRITICAL', answer: 'The quote is ' + fr.output.display + ' (' + fst.toLowerCase() + (fr.inputs[2] && fr.inputs[2].value != null ? ', limit ' + fr.inputs[2].value + ' min' : '') + ')', refs: [fr.id] }));
    }

    /* Q6 — calibration of what prices it */
    var tier = c.fair && c.fair.validation ? c.fair.validation.tier : null;
    if (!priced) out.push(item('Q6_CALIBRATION', 'NOT_APPLICABLE', { answer: 'Nothing is priced' }));
    else if (fairKind !== 'MODEL') out.push(item('Q6_CALIBRATION', 'NOT_APPLICABLE', { answer: 'The fair is the de-vigged sharp market, not a model; it carries no confidence interval (its error is largest on heavy favourites and long shots)' + (co && co.beats_base_rate === false ? '. The model cross-check does not beat the base rate on held-out games, so its agreement adds nothing' : '') }));
    else if (tier !== 'VALIDATED' && tier !== 'LEAN') out.push(item('Q6_CALIBRATION', 'UNRESOLVED', { severity: 'CRITICAL', answer: 'An ' + (tier || 'unvalidated').toLowerCase() + '-tier model prices this bet; its probabilities are not betting probabilities' }));
    else if (co && co.beats_base_rate === false) out.push(item('Q6_CALIBRATION', 'UNRESOLVED', { severity: 'IMPORTANT', answer: tier + ' tier, but ' + co.display, refs: [cal.id] }));
    else out.push(item('Q6_CALIBRATION', tier === 'LEAN' ? 'CONCERN' : 'CLEAR', { answer: tier + ' tier' + (co && co.display ? '; ' + co.display : '') + (tier === 'LEAN' ? ' — a break-even history, not a profit record' : ''), refs: cal ? [cal.id] : [] }));

    /* Q7 — missing data as the cause */
    var dq = D && D.causes ? D.causes.filter(function (x) { return x.cause === 'DATA_QUALITY' && x.assessment === 'LIKELY'; })[0] : null;
    var lineCause = D && D.causes ? D.causes.filter(function (x) { return (x.cause === 'INJURY_INFORMATION' || x.cause === 'LINEUP_ASSUMPTIONS') && x.assessment === 'LIKELY'; })[0] : null;
    var availNotChecked = (a.checks || []).some(function (x) { return x.id === 'A8_AVAILABILITY' && x.result === 'NOT_CHECKED'; });
    if (c.outlier || dq) out.push(item('Q7_MISSING_DATA', 'UNRESOLVED', { severity: 'CRITICAL', answer: c.outlier ? 'Suspected data fault first: ' + c.outlier : 'The disagreement diagnosis finds a data-quality problem likely' + (dq.detail ? ': ' + dq.detail : '') }));
    else if (lineCause) out.push(item('Q7_MISSING_DATA', 'UNRESOLVED', { severity: 'IMPORTANT', resolvable: true, answer: 'The gap is likely explained by ' + (lineCause.cause === 'INJURY_INFORMATION' ? 'injury information the model does not carry' : 'a lineup or starter assumption') + (lineCause.detail ? ': ' + lineCause.detail : '') + ' — not an edge' }));
    else if (availNotChecked && !findings.some(function (f) { return f.topic === 'availability'; })) out.push(item('Q7_MISSING_DATA', 'UNKNOWN', { severity: 'IMPORTANT', resolvable: true, answer: 'Availability was not checked, so an absence could be what the price already knows' }));
    else if (!findings.length) out.push(item('Q7_MISSING_DATA', 'UNKNOWN', { severity: 'IMPORTANT', resolvable: true, answer: 'No research findings: an unseen absence or lineup change cannot be ruled out' }));
    else out.push(item('Q7_MISSING_DATA', E && E.refused ? 'CONCERN' : 'CLEAR', { answer: (D && D.verdict ? 'Disagreement diagnosis: ' + str(D.verdict).toLowerCase().replace(/_/g, ' ') + '; ' : '') + 'no data fault or missing input is flagged' + (E && E.refused ? '; ' + E.refused + ' record' + (E.refused === 1 ? ' was' : 's were') + ' refused for lacking a source or a time' : '') }));

    /* Q8 — alternative assumptions */
    if (!priced) out.push(item('Q8_ALTERNATIVES', 'NOT_APPLICABLE', { answer: 'Nothing is priced to perturb' }));
    else {
      var sens = rec(L, 'SENSITIVITY'), so = sens && sens.status === 'COMPUTED' ? sens.output : null;
      var rows = so ? so.rows : (S && S.rows) || [], robust = so ? so.robust : S ? !!S.robust : null;
      var at2 = rows.filter(function (x) { return x.shift_pp === -2; })[0];
      /* the selection's OWN quarterback uncertain, with a priced scenario for losing him (the opponent's helps the side) */
      var qbRisk = (function () {
        var d = o.scenario_deltas || {}, side = o.side; if (side !== 'home' && side !== 'away') return null;
        var mine = num(d[side + '_qb_out']), team = side === 'home' ? c.home : c.away;
        var qb = findings.filter(function (f) { return /QB/i.test(str(f.role)) && (f.status === 'QUESTIONABLE' || f.status === 'DOUBTFUL') && !f.speculative && sameTeam(f.team, team); })[0];
        return qb && mine != null && mine < 0 ? qb.player + ' (' + team + ') is ' + qb.status.toLowerCase() + ', and losing him moves this side ' + mine + ' points' : null;
      })();
      if (robust === null) out.push(item('Q8_ALTERNATIVES', 'UNKNOWN', { severity: 'IMPORTANT', answer: 'No sensitivity was computed' }));
      else if (!robust) out.push(item('Q8_ALTERNATIVES', 'UNRESOLVED', { severity: 'IMPORTANT', answer: 'The edge does not survive a one-point error in the fair' + (so && so.display ? ' (' + so.display + ')' : '') }));
      else if (qbRisk) out.push(item('Q8_ALTERNATIVES', 'UNRESOLVED', { severity: 'IMPORTANT', resolvable: true, answer: 'Survives a one-point error in the fair, but ' + qbRisk }));
      else out.push(item('Q8_ALTERNATIVES', at2 && at2.net_ev_per_dollar != null && at2.net_ev_per_dollar <= 0 ? 'CONCERN' : 'CLEAR', { answer: 'Survives a one-point error in the fair' + (at2 && at2.net_ev_per_dollar != null ? '; at two points EV is ' + (at2.net_ev_per_dollar >= 0 ? '+' : '') + (Math.round(at2.net_ev_per_dollar * 10000) / 100) + '% per $1' : '') + '; priced on the lower-EV of the model and the audited market fair' }));
    }

    return outcome(out, o);
  }

  function outcome(items, o) {
    var cls0 = o.classification ? o.classification.classification : null;
    var unres = items.filter(function (x) { return x.status === 'UNRESOLVED' || x.status === 'UNKNOWN'; });
    var crit = unres.filter(function (x) { return x.severity === 'CRITICAL'; }), imp = unres.filter(function (x) { return x.severity === 'IMPORTANT'; });
    var critHard = crit.filter(function (x) { return !x.resolvable_by_research; }), critSoft = crit.filter(function (x) { return x.resolvable_by_research; });
    var start = FROM_RESEARCH[o.research_level] || 'MODERATE', why = [];
    var idx = SCALE.indexOf(start);
    imp.forEach(function (x) { if (idx < SCALE.length - 1) { idx++; why.push(x.question + ' — ' + x.answer); } });
    if (crit.length) { idx = SCALE.length - 1; crit.forEach(function (x) { why.push(x.question + ' — ' + x.answer); }); }
    var to = cls0, reason = null;
    function lower(target, r) { if (cls0 && RANK[target] > RANK[to]) { to = target; reason = r; } }
    if (critHard.length) lower('REJECTED', 'the challenge pass: ' + critHard[0].answer);
    else if (critSoft.length) lower('RESEARCH_REQUIRED', 'the challenge pass: ' + critSoft[0].answer);
    if (imp.length && to === 'VERIFIED_CANDIDATE') lower('WATCHLIST', 'the challenge pass left ' + imp.length + ' important question' + (imp.length === 1 ? '' : 's') + ' unresolved: ' + imp[0].question.replace(/\?$/, '') + ' — ' + imp[0].answer);
    var changed = to !== cls0;
    return {
      schema: VERSION, questions: items,
      unresolved: { critical: crit.length, important: imp.length, minor: items.filter(function (x) { return x.status === 'CONCERN'; }).length },
      /* STANDS: nothing important left open · CONFIDENCE_LOWERED: open items, but the class already says as much ·
         DOWNGRADED: the class was lowered · PASS: lowered to a pass */
      outcome: !cls0 ? 'NOT_APPLICABLE' : to === 'REJECTED' && changed ? 'PASS' : changed ? 'DOWNGRADED' : crit.length || imp.length ? 'CONFIDENCE_LOWERED' : 'STANDS',
      confidence: { before: start, after: SCALE[idx], scale: SCALE.slice(), why: why, note: 'Research confidence is how well the evidence supports the conclusion; it is not a probability of winning.' },
      classification: { before: cls0, after: to, changed: changed, reason: reason }
    };
  }

  /** Apply the outcome to a researcher classification ({classification, label, final_status, reasons}) — lowering only. */
  function apply(cls, ch, labels) {
    if (!cls || !ch || !ch.classification.changed) return cls;
    var L = labels || { label: {}, final: {} };
    return Object.assign({}, cls, { classification: ch.classification.after, label: L.label[ch.classification.after] || ch.classification.after, final_status: L.final[ch.classification.after] || cls.final_status,
      reasons: [ch.classification.reason].concat(cls.reasons || []), challenged_from: cls.classification });
  }

  return { VERSION: VERSION, QUESTIONS: QUESTIONS, SCALE: SCALE, challenge: challenge, apply: apply };
});
/*__EDCHALLENGE_END__*/
