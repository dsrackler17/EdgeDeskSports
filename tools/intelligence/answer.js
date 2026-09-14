#!/usr/bin/env node
/* ===========================================================================
   THE DETERMINISTIC ANSWER.

   Renders the answer shape §7 asks for — scope, ranked shortlist, decision,
   side, quote, model estimate, key reason, counterargument, price limit,
   blocker — from the engine's own objects alone, with no model call.

   TWO REASONS IT EXISTS.
     1. It is the offline answer. When the reasoning service is unreachable the
        user still gets a real, grounded answer rather than an apology, which
        is the same posture the rest of this product takes.
     2. It is the verification artifact. "Here is an example answer" means
        nothing if the example was written by hand; these are printed by the
        implemented system from the implemented data.

   Nothing here computes a betting number. Every value is printed exactly as
   the function produced it.

   Usage: node tools/intelligence/answer.js            (runs the example set)
          node tools/intelligence/answer.js "question" (one question)
   =========================================================================== */
'use strict';
const path = require('path');
const FX = require('./fixtures.js');

function pct(v, dp) { return v == null ? null : (v * 100).toFixed(dp == null ? 2 : dp) + '%'; }
function wrap(s, w) {
  const out = []; let line = '';
  String(s).split(/\s+/).forEach((word) => {
    if ((line + ' ' + word).trim().length > (w || 92)) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  });
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}

/** The answer, from the dry payload. */
function render(j, question) {
  const L = [];
  const st = j.slate_state || (j.data_path && j.data_path.slate_index && j.data_path.slate_index.slate_state) || null;
  const rank = j.slate_ranking || [];
  const D = j.decisions || [];
  const P = j.evidence_packets || [];

  L.push('Q: ' + question);
  L.push('');

  /* ---- scope, always first ------------------------------------------- */
  const sc = j.data_path && j.data_path.slate_index && j.data_path.slate_index.slate_state;
  if (sc) {
    L.push('SCOPE');
    L.push(wrap((j.slate_state && j.slate_state.sentence) || ''));
    L.push('  ' + [
      sc.scheduled + ' games on the card',
      sc.quoted + ' carrying a quote',
      rank.filter((r) => r.eligible).length + ' eligible for a priced recommendation',
      P.length + ' researched in depth',
    ].join(' · '));
    if (j.slate_source) L.push('  source: ' + j.slate_source);
    L.push('');
  }

  /* ---- the decisions --------------------------------------------------- */
  if (D.length) {
    const groups = {};
    D.forEach((d) => { const t = (d.attention && d.attention.tier) || 'REGIONAL'; (groups[t] = groups[t] || []).push(d); });
    const LABEL = { NATIONAL: 'NATIONALLY PROMINENT', REGIONAL: 'REGIONAL INTEREST', LOWER_PROFILE: 'LOWER PROFILE' };
    ['NATIONAL', 'REGIONAL', 'LOWER_PROFILE'].forEach((t) => {
      if (!groups[t]) return;
      L.push(LABEL[t] + '  (editorial attention category — EdgeDesk measures no betting handle, so this says nothing about how softly the game is priced)');
      groups[t].forEach((d) => {
        const p = d.price || {};
        L.push('');
        L.push('  ' + d.decision + (d.strength ? ' (' + d.strength + ')' : '') + ' — ' + d.matchup);
        L.push('    ' + d.selection + (d.handicap != null ? ' ' + (d.handicap > 0 ? '+' : '') + d.handicap : '')
          + (p.offered_american ? ' at ' + p.offered_american : '') + (p.book ? ' · ' + p.book : '')
          + (d.gates && d.gates.freshness ? ' · quote ' + String(d.gates.freshness.status).toLowerCase() : ''));
        L.push('    ' + wrap('why: ' + d.why, 86).split('\n').join('\n    '));
        if (d.model && d.model.line != null) {
          L.push('    model estimate: ' + d.model.line + ' (validation tier ' + d.model.validation_tier + ')'
            + (d.model.may_produce_model_ev ? '' : ' — contributes no expected value; the model has no validated outcome probability in this market'));
        }
        L.push('    probability edge ' + (p.probability_edge_pp != null ? (p.probability_edge_pp * 100).toFixed(2) + ' percentage points' : 'n/a')
          + ' · expected return ' + (p.expected_return_per_unit != null ? pct(p.expected_return_per_unit) + ' per unit staked' : 'n/a')
          + ' · push ' + (p.push_probability == null ? 'UNKNOWN' : pct(p.push_probability)));
        if (p.price_limit_american) L.push('    price limit: ' + p.price_limit_american
          + (p.price_needed_american ? ' · would need ' + p.price_needed_american + ' or better to qualify again' : ''));
        const counter = (d.what_would_change_it || [])[0];
        if (counter) L.push('    ' + wrap('against it: ' + counter, 86).split('\n').join('\n    '));
        if (d.blockers && d.blockers.length) L.push('    blocker: ' + wrap(d.blockers[0], 86).split('\n').join('\n    '));
        (d.evidence_gaps || []).forEach((g) => L.push('    not examined: ' + wrap(g.field + ' — ' + g.why, 84).split('\n').join('\n    ')));
        if (d.experimental) L.push('    EXPERIMENTAL — rests on a model whose own record does not beat the closing line.');
      });
      L.push('');
    });
  }

  /* ---- the whole card, grouped by attention ----------------------------
     The decisions above cover only the QUOTED selections. An attention split is
     a question about every game on the card, and answering it from the priced
     subset would drop exactly the lower-profile games it is asking about. */
  if (rank.length) {
    const tiers = { NATIONAL: [], REGIONAL: [], LOWER_PROFILE: [] };
    rank.forEach((r) => { (tiers[r.attention] || tiers.REGIONAL).push(r); });
    const LAB = { NATIONAL: 'Nationally prominent', REGIONAL: 'Regional interest', LOWER_PROFILE: 'Lower profile' };
    L.push('THE CARD BY ATTENTION — every game, not only the priced ones.');
    ['NATIONAL', 'REGIONAL', 'LOWER_PROFILE'].forEach((t) => {
      if (!tiers[t].length) return;
      L.push('  ' + LAB[t] + ' (' + tiers[t].length + ')');
      tiers[t].slice(0, 12).forEach((r) => {
        L.push('    ' + r.game + (r.eligible ? '  — eligible' : '  — ' + r.reason));
      });
      if (tiers[t].length > 12) L.push('    +' + (tiers[t].length - 12) + ' more');
    });
    L.push('  These are EDITORIAL attention categories built from rankings, conference, television window and book');
    L.push('  coverage. EdgeDesk measures no betting handle and no book limits, so a lower-profile game is NOT');
    L.push('  claimed to be more softly priced.');
    L.push('');
  }

  /* ---- nothing qualified ----------------------------------------------- */
  const cardWide = rank.length > 1;
  if (!D.some((d) => d.decision === 'BET CANDIDATE')) {
    L.push(cardWide ? 'NO BET CANDIDATE ON THIS CARD.'
      : D.length ? 'NOT A BET CANDIDATE AT THIS PRICE.'
        : 'NO DECISION — nothing priced was in focus and no card was indexed at this depth.');
    const watch = D.filter((d) => d.decision === 'WATCH').slice(0, 3);
    if (watch.length) {
      L.push('The best WATCH games and exactly what would have to change:');
      watch.forEach((d) => {
        L.push('  ' + d.matchup + ' — ' + d.selection + (d.price && d.price.offered_american ? ' at ' + d.price.offered_american : ''));
        (d.what_would_change_it || []).slice(0, 2).forEach((t) => L.push('      ' + wrap(t, 84).split('\n').join('\n      ')));
      });
    } else if (rank.length) {
      const ineligible = rank.filter((r) => !r.eligible).slice(0, 3);
      if (ineligible.length) {
        L.push('No game on the card carries a price to bet into. The highest-priority research is:');
        ineligible.forEach((r) => L.push('  ' + r.game + ' — ' + r.reason));
      }
    }
    L.push('');
  }

  /* ---- what was researched --------------------------------------------- */
  if (P.length) {
    L.push('RESEARCH — ' + P.length + ' matchup' + (P.length === 1 ? '' : 's') + ' opened in depth. Every other game was read at index level only.');
    P.slice(0, 2).forEach((pk) => {
      const id = pk.sections.identity, mu = pk.sections.matchup;
      L.push('');
      L.push('  ' + (id.matchup.value || pk.game_id) + '   [packet ' + pk.packet_id + ']');
      ['away', 'home'].forEach((side) => {
        const t = mu[side]; if (!t) return;
        L.push('    ' + (t.team.value || side) + ' — record ' + (t.record.value || 'n/a')
          + ' · SP+ ' + (t.sp_plus_overall.value != null ? t.sp_plus_overall.value : 'n/a')
          + ' (off ' + (t.sp_plus_offense.value != null ? t.sp_plus_offense.value : 'n/a')
          + ', def ' + (t.sp_plus_defense.value != null ? t.sp_plus_defense.value : 'n/a') + ' — lower is better)'
          + ' · SOS ' + (t.strength_of_schedule.value != null ? t.strength_of_schedule.value : 'n/a')
          + ' · rest ' + (t.rest_days.value != null ? t.rest_days.value + 'd' : 'n/a'));
        (t.previous_games.value || []).forEach((g) => {
          L.push('        ' + g.date + ' ' + g.venue + ' vs ' + g.opponent + '  ' + g.points_for + '-' + g.points_against
            + ' ' + g.result + '   (opponent SP+ ' + (g.opponent_sp_plus != null ? g.opponent_sp_plus : 'n/a') + ')');
        });
      });
      L.push('    SP+ gap (home minus away): ' + (mu.sp_plus_gap.value != null ? mu.sp_plus_gap.value : 'n/a')
        + ' — a difference of two EXTERNAL model ratings, not a spread and not an edge.');
      L.push('    NOT AVAILABLE for this sport, and their absence is not evidence they do not matter:');
      L.push('      ' + wrap(pk.missing.slice(0, 8).map((x) => x.field.split('.').pop()).filter((v, i, a) => a.indexOf(v) === i).join(', '), 84).split('\n').join('\n      '));
    });
    L.push('');
  }

  const cov = j.coverage_metrics;
  if (cov) {
    L.push('COVERAGE — three different questions, three different denominators:');
    if (cov.required_field_completeness) L.push('  required fields ' + (cov.required_field_completeness.value != null ? Math.round(cov.required_field_completeness.value * 100) + '%' : 'n/a'));
    if (cov.retrieval_success_rate) L.push('  retrieval ' + Math.round(cov.retrieval_success_rate.value * 100) + '% — ' + cov.retrieval_success_rate.detail);
    if (cov.evidence_delivered) L.push('  evidence delivered ' + Math.round(cov.evidence_delivered.value * 100) + '% — ' + cov.evidence_delivered.detail);
  }
  L.push('');
  L.push('EdgeDesk places no wagers. Prices move; a recommendation is the side AND the price together.');
  return L.join('\n');
}

/* ---- driver -------------------------------------------------------------- */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'k', SUPABASE_URL: 'https://sb.test',
  SUPABASE_ANON_KEY: 'a', EDGEDESK_SITE_BASE: 'https://site.test' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let route = () => [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) return { ok: true, status: 201, text: async () => '', json: async () => [] };
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => '', json: async () => null };
  return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
};

const SCOPE = { sport: 'americanfootball_ncaaf', season: 2026, week: 3, label: 'week 3' };
const EXAMPLES = [
  { q: 'Any CFB matchups look good?', mode: 'chat' },
  { q: 'Separate smaller-profile and big-attention games.', mode: 'chat' },
  { q: 'Analyze North Texas versus Texas State.', mode: 'chat' },
  { q: 'What price makes it a pass?', mode: 'price' },
  { q: 'Why should I trust this recommendation?', mode: 'challenge' },
];

(async function () {
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const asked = process.argv.slice(2).join(' ').trim();
  const set = asked ? [{ q: asked, mode: 'chat' }] : EXAMPLES;
  for (const ex of set) {
    const fx = FX.build();
    m.clearCache();
    route = FX.router(fx);
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai?dry=1', {
      method: 'POST', headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: ex.mode, question: ex.q, packet: { board_scope: SCOPE }, history: [] }),
    }));
    const j = await r.json();
    console.log('='.repeat(94));
    console.log(render(j, ex.q));
    console.log('');
  }
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
