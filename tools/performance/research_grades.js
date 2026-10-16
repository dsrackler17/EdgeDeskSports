'use strict';
/* ===========================================================================
   THE RESEARCH GRADE STEPS of the hourly performance job.
   docs/research-grade/METHODOLOGY.md · lib/edgedesk_research_grade.js (EDGRADE)

     snapshot   every upcoming game the capture step saw → its A–F research
                grade, computed from what is on file NOW (the projection as
                committed, the named-book line the slate captured, the model's
                own pregame track record as graded so far) → a new row in
                performance/ledger/research_grades/ whenever the grade, its
                parts, the forecast or the line it saw changed. Pregame only.
     settle     every game with a verified result (the results stream the
                performance job already keeps) → its latest valid pregame
                grade snapshot → an outcome row in
                performance/ledger/grade_outcomes/: the final, the forecast's
                errors, the record at the line the snapshot saved before
                kickoff, CLV only against a same-source close. A correction is
                a new revision; running twice adds nothing.

   What it never does: grade a game that has started, grade from a number or
   a line seen after the start, give a game a grade it did not have before
   kickoff, or choose a side from the final.
   =========================================================================== */
const path = require('path');
const P = require('../../lib/edgedesk_performance.js');
const G = require('../../lib/edgedesk_research_grade.js');
const S = require('./sources.js');
const PL = require('./pipeline.js');

const H = 3600e3;
/* the slate (the scoreboard that carries the named-book line) is the odds feed: older than this, it has failed */
const SLATE_STALE_HOURS = 6;

/* ---------------------------------------------------------- extras */
/** Each sport's own artifact row for a game: the measures the projection contract does not carry. */
function loadExtras(root) {
  const by = { cfb: new Map(), nfl: new Map(), nhl: new Map() };
  const fbs = S.readJson(path.join(root, 'football', 'fbs', 'slate.json'));
  ((fbs && fbs.games) || []).forEach((g) => by.cfb.set(String(g.game_id), { week: g.week, kickoff_tbd: g.kickoff_tbd, kickoff_state: g.kickoff_state, projection_stability: g.projection_stability || null }));
  const nfl = S.readJson(path.join(root, 'football', 'nfl', 'slate.json'));
  ((nfl && nfl.games) || []).forEach((g) => by.nfl.set(String(g.game_id), { week: g.week, data_quality: g.data_quality || null }));
  const nhl = S.readJson(path.join(root, 'hockey', 'slate.json'));
  ((nhl && nhl.games) || []).forEach((g) => by.nhl.set(String(g.game_id), { data_quality: g.data_quality || null }));
  return { get: (sport, id) => (by[sport] ? by[sport].get(String(id)) || null : null) };
}

/* ----------------------------------------------------- track record */
/**
 * The performance ledger's grade rows as track-record rows: one per grade
 * revision, with the model family of the forecast it graded. EDGRADE.trackRecord
 * reads them AS OF a moment (games started and graded before it).
 */
function trackRows(state) {
  const fam = new Map();
  state.forecasts.forEach((s) => { if (s.hash) fam.set(s.hash, G.familyOf((s.model || {}).id)); });
  /* every revision, winner or not: a game regraded void later must count as its latest revision (void), not its earlier result */
  return state.grades.map((g) => ({
    event_key: g.event_key, sport: g.sport, family: fam.get(g.forecast_hash) || null, start_utc: g.start_utc, graded_at: g.graded_at, revision: g.revision || 1,
    eligible: g.eligible !== false, p_home: g.winner ? g.winner.p_home : null, outcome: g.winner ? g.winner.outcome : null, tier: g.forecast_tier || null
  }));
}

/* ---------------------------------------------------- the line it saw */
function slateHealth(slate, now) {
  if (!slate || !slate.generated_at) return 'NO_SLATE';
  const t = P.toMs(slate.generated_at);
  if (t == null) return 'NO_SLATE';
  return now - t > SLATE_STALE_HOURS * H ? 'SLATE_STALE' : 'OK';
}

/* ------------------------------------------------------------ snapshot */
/**
 * ctx: { now, projections, slate, extras, run, git_sha }
 * Returns { appended, unchanged, refused, letters, reproduce_failures }.
 */
function snapshot(state, ctx) {
  const now = ctx.now;
  const out = { appended: [], unchanged: 0, refused: {}, letters: {}, odds: {}, considered: 0, reproduce_failures: [] };
  const refuse = (why) => { out.refused[why] = (out.refused[why] || 0) + 1; };
  const slate = ctx.slate || null;
  const feed = slateHealth(slate, now);
  const lastSnap = new Map();
  (state.research_grades || []).forEach((s) => { const p = lastSnap.get(s.event_key); if (!p || P.toMs(s.captured_at) >= P.toMs(p.captured_at)) lastSnap.set(s.event_key, s); });
  const lastFc = new Map();
  state.forecasts.forEach((s) => {
    if ((s.capture || {}).method !== 'ledger_capture') return;
    const p = lastFc.get(s.event_key);
    if (!p || PL.snapTime(s) >= PL.snapTime(p)) lastFc.set(s.event_key, s);
  });
  const tRows = trackRows(state);
  const tracks = new Map();
  const trackFor = (sport, family) => {
    const k = sport + '|' + family;
    if (!tracks.has(k)) tracks.set(k, G.trackRecord(tRows, { sport, family, as_of: now }));
    return tracks.get(k);
  };
  (ctx.projections || []).forEach((p) => {
    if (S.SUPPORTED.indexOf(p.sport) < 0) { refuse('UNSUPPORTED_SPORT'); return; }
    out.considered++;
    const st = P.toMs(p.start_utc);
    if (st == null) { refuse('NO_START'); return; }
    if (st <= now) { refuse('STARTED'); return; }
    const m = slate && feed !== 'NO_SLATE' ? S.matchSlate(slate, { sport: p.sport, event_id: p.event_id, start_utc: p.start_utc, home: p.home, away: p.away }) : { match: null, why: 'NO_SLATE' };
    if (m.match && ['LIVE', 'FINAL'].indexOf(P.slateStatus(m.match)) >= 0) { refuse('SLATE_SAYS_STARTED'); return; }
    let quote = null, qStatus;
    if (feed !== 'OK') qStatus = feed;
    else if (!m.match) qStatus = m.why === 'ID' ? 'NO_QUOTE' : m.why;
    else {
      const q = P.quoteFromSlate(slate.markets[m.match.id]);
      quote = q && P.toMs(q.captured_at) < st && P.toMs(q.captured_at) <= now ? q : null;
      qStatus = quote ? 'CAPTURED' : 'NO_QUOTE';
    }
    out.odds[qStatus] = (out.odds[qStatus] || 0) + 1;
    const fc = lastFc.get(p.event_key) || null;
    const family = G.familyOf((p.model || {}).id);
    const r = G.gradeProjection(p, { as_of: now, quote, quote_status: qStatus, time_tbd: m.match ? m.match.time_tbd : null,
      track: trackFor(p.sport, family), extra: ctx.extras ? ctx.extras.get(p.sport, p.event_id) : null });
    const row = G.snapshotRow(p, r.inputs, r.grade, { forecast_hash: fc ? fc.hash : null, run: ctx.run || null, git_sha: ctx.git_sha || null,
      slate_id: m.match ? m.match.id : null, season: S.seasonLabel(p.sport, p.start_utc) });
    /* the row must reproduce from its own inputs before it may be written */
    const rep = G.reproduce(row);
    if (!rep.ok) { out.reproduce_failures.push({ event_key: row.event_key, diffs: rep.diffs }); refuse('DOES_NOT_REPRODUCE'); return; }
    const key = row.grade.letter || G.INSUFFICIENT;
    out.letters[key] = (out.letters[key] || 0) + 1;
    const prev = lastSnap.get(row.event_key);
    if (prev && prev.signature === row.signature) { out.unchanged++; return; }
    row.revision = prev ? (prev.revision || 1) + 1 : 1;
    row.supersedes = prev ? prev.hash || null : null;
    out.appended.push(row); lastSnap.set(row.event_key, row);
  });
  return out;
}

/* -------------------------------------------------------------- settle */
/**
 * Every game with a verified result → its designated (latest valid pregame)
 * grade snapshot → an outcome revision when the snapshot, the result or the
 * close changed. ctx: { now, native }
 */
function settle(state, ctx) {
  const rx = PL.byEvent(state.results), sx = PL.byEvent(state.research_grades || []), ox = PL.byEvent(state.grade_outcomes || []);
  const out = { appended: [], no_pregame_grade: [], ineligible_snapshots: 0 };
  rx.forEach((rows, key) => {
    const res = PL.latest(rows);
    if (!res) return;
    const snaps = sx.get(key) || [];
    if (!snaps.length) { out.no_pregame_grade.push({ event_key: key, sport: res.sport, start_utc: res.start_utc, state: res.state }); return; }
    const d = G.designate(snaps, res.start_utc);
    out.ineligible_snapshots += d.ineligible.length;
    if (!d.snapshot) { out.no_pregame_grade.push({ event_key: key, sport: res.sport, start_utc: res.start_utc, state: res.state, ineligible: d.ineligible.slice(0, 5) }); return; }
    const s = d.snapshot;
    const nat = ctx.native && (s.sport === 'nfl' || s.sport === 'cfb') ? ctx.native.read(s.sport, s.event_id, s.start_utc) : { close: null };
    const o = G.settle(s, res, { close: nat.close || null });
    o.revisions_considered = d.revisions;
    o.settled_at = new Date(ctx.now).toISOString();
    const prev = PL.latest(ox.get(key));
    if (!prev) { o.revision = 1; o.supersedes = null; o.reason = 'settled'; out.appended.push(o); return; }
    if (G.outcomeSignature(prev) === G.outcomeSignature(o)) return;
    o.revision = (prev.revision || 1) + 1; o.supersedes = prev.hash;
    o.reason = prev.result_hash !== o.result_hash ? 'result_revision' : prev.snapshot_hash !== o.snapshot_hash ? 'designation_change' : 'close_or_eligibility_change';
    out.appended.push(o);
  });
  return out;
}

module.exports = { SLATE_STALE_HOURS, loadExtras, trackRows, slateHealth, snapshot, settle };
