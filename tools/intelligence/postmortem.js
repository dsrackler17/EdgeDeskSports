#!/usr/bin/env node
/* ============================================================================
   THE POSTMORTEM — what kind of miss was it, and does it repeat?

   Reads graded research packets (the `research_packet_grades` view exported
   to JSON, or any file of rows in that shape) and sorts every graded miss
   into ONE of four classes that call for different fixes:

     DATA_FAILURE       the packet was built without the inputs that would
                        have changed it (availability UNKNOWN, no starter, no
                        price, no forecast): fix the feed, not the model
     ANALYTICAL_ERROR   the football read pointed the wrong way while the
                        number itself was close: the decisive factor, not
                        the projection, missed
     MODEL_ERROR        the projection missed by more than the close did, in
                        the direction the close had: the model, not the read
     VARIANCE           the result landed inside the model's own residual
                        spread of the projection: nothing to learn from one
     UNGRADED           no outcome yet

   Then it counts repeats by sport, class, label, favourite size and decisive
   factor, and where a class repeats past a sample floor it emits a CANDIDATE
   IMPROVEMENT — a hypothesis with the evidence that produced it and the
   evaluation it must pass before anyone proposes promoting it: a time-
   separated held-out window (fit on seasons before S, test on S), and a
   reviewed change to EDINTEL.MODEL_VALIDATION. Nothing here changes a model,
   a threshold or a prompt, and no generated text becomes a fact.

   ONE LOSS IS NOT PROOF OF BAD REASONING; ONE WIN IS NOT PROOF OF SKILL. The
   sample floor and the variance class exist to say so in numbers.

   Usage
     node tools/intelligence/postmortem.js grades.json            # prints the report
     node tools/intelligence/postmortem.js grades.json --json     # machine-readable
   ========================================================================== */
'use strict';
const fs = require('fs');

const SIGMA = { americanfootball_ncaaf: 14.9, americanfootball_nfl: 10.7 };
const DEFAULTS = { sample_floor: 8, base_rate_margin: 0.15, big_miss_points: 7 };

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { const n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
function r3(v) { const n = num(v); return n == null ? null : Math.round(n * 1000) / 1000; }
function favBucket(homeLine) { const a = Math.abs(num(homeLine) || 0); return a < 3 ? 'pick-3' : a < 7 ? '3-7' : a < 14 ? '7-14' : '14+'; }

/** Classify ONE graded packet. `row` is a research_packet_grades row (or the same fields). */
function classify(row, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const sport = row.sport || null;
  const sigma = SIGMA[sport] || 12;
  const packet = row.packet || {};
  const summary = packet.analysis_summary || null;
  const outcome = String(row.outcome || row.grade || '').toUpperCase();
  const modelHome = num(row.model_home_line);
  const closeHome = num(row.closing_home_line != null ? row.closing_home_line : row.close_home_line);
  const finalMargin = num(row.final_home_margin != null ? row.final_home_margin : row.home_margin);
  const missing = (packet.confidence && packet.confidence.data && packet.confidence.data.missing) || [];
  const dataMissing = missing.filter((m) => /availability|starters|price|weather|projection|drivers/.test(String(m)));
  const out = { packet_id: row.packet_id, sport, game_id: row.game_id, label: row.label || (packet.label && packet.label.label) || null, side: row.side || null, selection: row.selection || null, outcome: outcome || 'UNGRADED',
    favourite_bucket: modelHome != null ? favBucket(modelHome) : null, decisive_factor: summary && summary.decisive && summary.decisive[0] ? String(summary.decisive[0]).split(':')[0] : null, decisive_favours: summary && summary.decisive && summary.decisive[0] ? String(summary.decisive[0]).split(':')[1] || null : null,
    class: 'UNGRADED', why: null, residual: null, sigma };
  if (!outcome || outcome === 'UNGRADED' || finalMargin == null) { out.why = 'no final margin on file'; return out; }
  const resid = modelHome != null ? finalMargin - (-modelHome) : null; /* home margin minus projected home margin */
  out.residual = r2(resid);
  const win = /WIN|W$/.test(outcome), push = /PUSH/.test(outcome);
  if (win || push) { out.class = win ? 'HIT' : 'PUSH'; out.why = win ? 'the graded side covered' : 'the number pushed'; return out; }
  /* a miss: which kind? */
  if (dataMissing.length >= 2 || out.label === 'INSUFFICIENT DATA') { out.class = 'DATA_FAILURE'; out.why = 'the packet lacked ' + dataMissing.join(', ') + (out.label === 'INSUFFICIENT DATA' ? ' (label INSUFFICIENT DATA)' : ''); return out; }
  if (modelHome != null && closeHome != null) {
    /* the close is the comparator that decides whether the NUMBER was the problem, whatever the residual: a projection that
       missed by materially more than the close did is a model miss even when the result sat inside sigma */
    const modelErr = Math.abs(finalMargin - (-modelHome)), closeErr = Math.abs(finalMargin - (-closeHome));
    if (modelErr > closeErr + 3) { out.class = 'MODEL_ERROR'; out.why = 'the projection missed by ' + r2(modelErr) + ' against the close’s ' + r2(closeErr) + '; the market had it'; return out; }
  }
  if (resid != null && Math.abs(resid) <= sigma) {
    /* inside one sigma of the projection: the number was not the problem unless the read pointed the wrong way */
    if (out.decisive_favours && out.side) {
      const favouredHome = packet.game && packet.game.home && String(out.decisive_favours).toLowerCase() === String(packet.game.home).toLowerCase();
      const favouredAway = packet.game && packet.game.away && String(out.decisive_favours).toLowerCase() === String(packet.game.away).toLowerCase();
      const readSideHome = favouredHome ? true : favouredAway ? false : null;
      if (readSideHome != null) {
        const marginForRead = readSideHome ? finalMargin : -finalMargin;
        if (marginForRead <= -o.big_miss_points) { out.class = 'ANALYTICAL_ERROR'; out.why = 'the decisive factor (' + out.decisive_factor + ') favoured ' + out.decisive_favours + ' and the game went the other way by ' + Math.abs(marginForRead) + ' while the projection missed by only ' + Math.abs(r2(resid)) + ' (inside sigma ' + sigma + ')'; return out; }
      }
    }
    out.class = 'VARIANCE'; out.why = 'the result landed ' + Math.abs(r2(resid)) + ' from the projection, inside the model’s own sigma of ' + sigma; return out;
  }
  out.class = 'VARIANCE'; out.why = 'a miss beyond sigma with no close to compare against, or one the close missed too: an outlier result, not a diagnosed error';
  return out;
}

/** Aggregate classified rows into repeats and candidate improvements. */
function aggregate(classified, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const graded = classified.filter((c) => c.class !== 'UNGRADED');
  const misses = graded.filter((c) => c.class !== 'HIT' && c.class !== 'PUSH');
  const by = (key) => { const m = {}; graded.forEach((c) => { const k = key(c); if (k == null) return; const e = (m[k] = m[k] || { n: 0, hit: 0, miss: 0, classes: {} }); e.n++; if (c.class === 'HIT') e.hit++; else if (c.class !== 'PUSH') { e.miss++; e.classes[c.class] = (e.classes[c.class] || 0) + 1; } }); return m; };
  const groups = {
    by_sport: by((c) => c.sport), by_class: (() => { const m = {}; misses.forEach((c) => { m[c.class] = (m[c.class] || 0) + 1; }); return m; })(),
    by_label: by((c) => c.label), by_favourite_bucket: by((c) => c.sport + '|' + c.favourite_bucket), by_decisive_factor: by((c) => c.sport + '|' + c.decisive_factor),
  };
  const baseMissRate = graded.length ? misses.length / graded.length : null;
  const candidates = [];
  function consider(scope, key, e) {
    if (e.n < o.sample_floor) return;
    const rate = e.miss / e.n;
    if (baseMissRate == null || rate < baseMissRate + o.base_rate_margin) return;
    const top = Object.keys(e.classes).sort((a, b) => e.classes[b] - e.classes[a])[0];
    if (!top || e.classes[top] < Math.ceil(o.sample_floor / 2)) return;
    candidates.push({
      candidate: top === 'DATA_FAILURE' ? 'Close the data gap for ' + scope + ' ' + key + ' (a feed or provider fix, not a model change).'
        : top === 'ANALYTICAL_ERROR' ? 'Re-examine how the decisive-factor read is weighted for ' + scope + ' ' + key + ': the football read has pointed the wrong way repeatedly.'
        : top === 'MODEL_ERROR' ? 'A model change hypothesis for ' + scope + ' ' + key + ': the projection has missed where the close did not.'
        : 'No change: repeated misses in ' + scope + ' ' + key + ' are inside the model’s own variance.',
      scope, key, n: e.n, misses: e.miss, miss_rate: r3(rate), base_miss_rate: r3(baseMissRate), dominant_class: top, dominant_class_n: e.classes[top],
      status: 'HYPOTHESIS', evaluation_required: 'Evaluate on a time-separated held-out window (fit on seasons before the test season, test on the test season, never the seasons that produced this candidate). A promotion is a reviewed change to EDINTEL.MODEL_VALIDATION or the affected build, never an edit made here.',
      note: 'Produced from ' + e.n + ' graded packets; a candidate, not a finding.'
    });
  }
  Object.keys(groups.by_favourite_bucket).forEach((k) => consider('favourite bucket', k, groups.by_favourite_bucket[k]));
  Object.keys(groups.by_decisive_factor).forEach((k) => consider('decisive factor', k, groups.by_decisive_factor[k]));
  Object.keys(groups.by_label).forEach((k) => consider('label', k, groups.by_label[k]));
  return {
    schema: 'edgedesk_postmortem_v1', generated_at: new Date().toISOString(),
    counts: { rows: classified.length, graded: graded.length, hits: graded.filter((c) => c.class === 'HIT').length, pushes: graded.filter((c) => c.class === 'PUSH').length, misses: misses.length, ungraded: classified.length - graded.length },
    base_miss_rate: r3(baseMissRate), groups, candidates,
    rules: { sample_floor: o.sample_floor, base_rate_margin: o.base_rate_margin, big_miss_points: o.big_miss_points, sigma: SIGMA },
    note: 'Data failures, analytical errors, model errors and variance are separated because each calls for a different fix. One loss is not proof of bad reasoning; one win is not proof of skill. Nothing here changes a model, a threshold or a prompt, and nothing generated here becomes a verified fact.'
  };
}

function report(rows, opts) { const classified = rows.map((r) => classify(r, opts)); return Object.assign(aggregate(classified, opts), { classified }); }

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/intelligence/postmortem.js <grades.json> [--json]'); process.exit(2); }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rep = report(Array.isArray(rows) ? rows : rows.rows || []);
  if (args.includes('--json')) { console.log(JSON.stringify(rep, null, 1)); return; }
  const c = rep.counts;
  console.log(`postmortem: ${c.rows} rows, ${c.graded} graded (${c.hits} hits, ${c.pushes} pushes, ${c.misses} misses), base miss rate ${rep.base_miss_rate}`);
  Object.keys(rep.groups.by_class).forEach((k) => console.log(`  ${k}: ${rep.groups.by_class[k]}`));
  if (!rep.candidates.length) console.log('  no candidate improvement clears the sample floor (' + rep.rules.sample_floor + ')');
  rep.candidates.forEach((x) => console.log(`  CANDIDATE [${x.dominant_class}] ${x.candidate} (n=${x.n}, miss rate ${x.miss_rate} vs base ${x.base_miss_rate})`));
}

module.exports = { classify, aggregate, report, SIGMA, DEFAULTS };
if (require.main === module) main();
