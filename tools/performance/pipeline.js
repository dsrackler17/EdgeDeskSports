'use strict';
/* ===========================================================================
   THE PERFORMANCE PIPELINE — capture, import, verify, grade. One function per
   step, each idempotent: running the job twice (or ten times) on the same
   inputs appends nothing the second time.

     capture   the projection contract as committed now → a new forecast
               revision for every upcoming game whose forecast changed, and a
               quote row for every named-book quote that changed. Pregame only.
     import    the earlier pregame-only records → RECORDED revisions, for the
               period before the ledger's first capture (its epoch).
     results   every started game → its sources (the slate, the sport's own
               file, ESPN by date) → a result revision when the verdict is new
               or a source corrected it.
     grade     every game with a result → its designated snapshot → a grade
               revision when the forecast, the result or the method changed.

   Nothing here deletes or edits a row. A correction is a new row that names
   the row it supersedes and why.
   =========================================================================== */
const P = require('../../lib/edgedesk_performance.js');
const L = require('./ledger.js');
const S = require('./sources.js');

const H = 3600e3;
/* a started game with no final this long after its start is reported */
const MISSING_FINAL_HOURS = 8;
/* …and becomes an ALERT (a red run) after this long */
const ALERT_HOURS = 30;
/* how far back the job keeps chasing a final it does not have */
const CHASE_DAYS = 21;

function byEvent(rows) {
  const m = new Map();
  rows.forEach((r) => { if (!m.has(r.event_key)) m.set(r.event_key, []); m.get(r.event_key).push(r); });
  return m;
}
function latest(rows) { return (rows || []).slice().sort((a, b) => (a.revision || 0) - (b.revision || 0) || (a.seq || 0) - (b.seq || 0)).pop() || null; }
function snapTime(s) { const c = s.capture || {}; return P.toMs(c.captured_at) != null ? P.toMs(c.captured_at) : P.toMs(c.recorded_at) != null ? P.toMs(c.recorded_at) : P.toMs((s.model || {}).predicted_at); }
function quoteSig(q) { return q ? JSON.stringify([q.book, q.moneyline, q.spread, q.total]) : null; }

/** The ledger's epoch: the first time it captured a forecast itself. */
function epochOf(forecasts) {
  let t = null;
  forecasts.forEach((s) => { if ((s.capture || {}).method === 'ledger_capture') { const c = P.toMs(s.capture.captured_at); if (c != null && (t == null || c < t)) t = c; } });
  return t;
}

/* ------------------------------------------------------------- capture */
function capture(state, ctx) {
  const now = ctx.now, out = { appended: [], quotes: [], refused: {}, unchanged: 0, matched: {}, considered: 0 };
  const projections = ctx.projections || [];
  const slate = ctx.slate;
  const lastVerified = new Map();
  state.forecasts.forEach((s) => {
    if ((s.capture || {}).method !== 'ledger_capture') return;
    const p = lastVerified.get(s.event_key);
    if (!p || snapTime(s) >= snapTime(p)) lastVerified.set(s.event_key, s);
  });
  const lastQuote = new Map();
  state.quotes.forEach((q) => { const p = lastQuote.get(q.event_key); if (!p || P.toMs(q.captured_at) >= P.toMs(p.captured_at)) lastQuote.set(q.event_key, q); });
  const refuse = (why) => { out.refused[why] = (out.refused[why] || 0) + 1; };
  projections.forEach((p) => {
    if (S.SUPPORTED.indexOf(p.sport) < 0) { refuse('UNSUPPORTED_SPORT'); return; }
    out.considered++;
    const st = P.toMs(p.start_utc);
    if (st == null) { refuse('NO_START'); return; }
    if (st <= now) { refuse('STARTED'); return; }
    const m = slate ? S.matchSlate(slate, { sport: p.sport, event_id: p.event_id, start_utc: p.start_utc, home: p.home, away: p.away }) : { match: null, why: 'NO_SLATE' };
    out.matched[m.why] = (out.matched[m.why] || 0) + 1;
    /* a game the slate already shows as started is not captured, whatever its clock says */
    if (m.match && ['LIVE', 'FINAL'].indexOf(P.slateStatus(m.match)) >= 0) { refuse('SLATE_SAYS_STARTED'); return; }
    const q = m.match ? P.quoteFromSlate(slate.markets[m.match.id]) : null;
    const quote = q && P.toMs(q.captured_at) < st && P.toMs(q.captured_at) <= now ? q : null;
    const snap = P.snapshotFromProjection(p, { captured_at: new Date(now).toISOString(), method: 'ledger_capture', run: ctx.run || null, git_sha: ctx.git_sha || null, quote,
      source: 'engine/build_projections.js', source_ref: (p.model && p.model.artifact) || null });
    if (!snap) { refuse('UNREADABLE'); return; }
    if (m.match) snap.slate_id = m.match.id;
    const why = P.pregameProblem(snap, now);
    if (why) { refuse(why); return; }
    if (quote) {
      const lq = lastQuote.get(snap.event_key);
      if (!lq || quoteSig(lq) !== quoteSig(quote)) {
        const qr = Object.assign({ schema: P.QUOTE_SCHEMA, event_key: snap.event_key, sport: snap.sport, start_utc: snap.start_utc, slate_id: m.match.id, observed_at: new Date(now).toISOString() }, quote);
        out.quotes.push(qr); lastQuote.set(snap.event_key, qr);
      }
    }
    const prev = lastVerified.get(snap.event_key);
    if (prev && prev.signature === snap.signature) { out.unchanged++; return; }
    out.appended.push(snap); lastVerified.set(snap.event_key, snap);
  });
  return out;
}

/* -------------------------------------------------------------- import */
function importRecorded(state, cands) {
  const haveRef = new Set(state.forecasts.map((s) => (s.capture || {}).source_ref).filter(Boolean));
  const fresh = cands.filter((c) => !haveRef.has(c.capture.source_ref));
  /* one revision per change: a candidate whose forecast equals the revision
     just before it in time (from any record) adds nothing */
  const ev = byEvent(state.forecasts.concat(fresh.map((c) => Object.assign({ __new: true }, c))));
  const keep = [];
  ev.forEach((list) => {
    list.sort((a, b) => snapTime(a) - snapTime(b) || (a.__new ? 1 : 0) - (b.__new ? 1 : 0));
    let prevSig = null;
    list.forEach((s) => {
      if (s.__new && s.signature !== prevSig) { const c = Object.assign({}, s); delete c.__new; keep.push(c); }
      if (!s.__new || s.signature !== prevSig) prevSig = s.signature;
    });
  });
  keep.sort((a, b) => snapTime(a) - snapTime(b));
  return { appended: keep, skipped_present: cands.length - fresh.length, skipped_same: fresh.length - keep.length };
}

/* ------------------------------------------------------------- results */
/**
 * ctx: { now, slate, native, espnEvents (Map id → event, from espnDays) }
 * Returns new result rows and the per-game reading for health.
 */
function verifyResults(state, ctx) {
  const now = ctx.now;
  const fx = byEvent(state.forecasts);
  const rx = byEvent(state.results);
  const out = { appended: [], pending: [], conflicts: [], unmatched: [], wantDays: [], read: 0 };
  fx.forEach((snaps, key) => {
    const s0 = snaps.slice().sort((a, b) => snapTime(b) - snapTime(a))[0];
    const sched = P.toMs(s0.start_utc);
    if (sched == null || sched > now) return;
    if (now - sched > CHASE_DAYS * 86400e3 && latest(rx.get(key))) return; /* settled and old: done */
    out.read++;
    const sport = s0.sport;
    const cands = [];
    let slateEv = null, how = null;
    if (ctx.slate) {
      const m = S.matchSlate(ctx.slate, { sport, event_id: s0.event_id, start_utc: s0.start_utc, home: s0.home, away: s0.away });
      slateEv = m.match; how = m.why;
      if (!slateEv && ctx.espnEvents && ctx.espnEvents.size) {
        const m2 = S.matchSlate({ events: Array.from(ctx.espnEvents.values()), byId: ctx.espnEvents, markets: {} }, { sport, event_id: s0.event_id, start_utc: s0.start_utc, home: s0.home, away: s0.away });
        if (m2.match) { slateEv = m2.match; how = 'ESPN_DAY_' + m2.why; }
      }
    }
    if (slateEv) cands.push(S.slateCandidate(slateEv, ctx.slate && ctx.slate.generated_at));
    const nat = ctx.native ? ctx.native.read(sport, s0.event_id, s0.start_utc) : { cand: null };
    if (nat.cand) cands.push(nat.cand);
    const verdict = P.resolveResult(cands, { now, scheduled_start: s0.start_utc });
    const prev = latest(rx.get(key));
    const hoursPast = (now - sched) / H;
    if (verdict.state === 'FINAL' || verdict.state === 'VOID') {
      const row = { schema: P.RESULT_SCHEMA, event_key: key, sport, start_utc: verdict.start_utc || s0.start_utc, state: verdict.state, void_reason: verdict.void_reason || null,
        home_score: verdict.home_score == null ? null : verdict.home_score, away_score: verdict.away_score == null ? null : verdict.away_score, decided: verdict.decided || null,
        sources: verdict.sources, verified_at: new Date(now).toISOString(), match: how || (nat.cand ? 'NATIVE_ID' : null) };
      if (!prev) { row.revision = 1; row.supersedes = null; row.reason = 'verified'; out.appended.push(row); }
      else if (P.resultSignature(prev) !== P.resultSignature(row)) {
        row.revision = (prev.revision || 1) + 1; row.supersedes = prev.hash;
        row.reason = prev.state === 'VOID' && row.state === 'FINAL' ? 'played_after_void' : prev.state === 'FINAL' && row.state === 'FINAL' ? 'source_correction' : 'status_change';
        out.appended.push(row);
      }
      return;
    }
    if (verdict.state === 'CONFLICT') { out.conflicts.push({ event_key: key, hours_past_start: Math.round(hoursPast), sources: verdict.sources, settled: !!prev }); return; }
    if (prev) return; /* a settled game whose sources have since gone quiet stays settled */
    if (!slateEv && S.SPORT[sport] && S.SPORT[sport].id_join === 'names' && ['UNMATCHED', 'AMBIGUOUS', 'SWAPPED_HOME_AWAY'].indexOf(how) >= 0) out.unmatched.push({ event_key: key, why: how, hours_past_start: Math.round(hoursPast) });
    if (hoursPast >= MISSING_FINAL_HOURS) out.pending.push({ event_key: key, sport, pending: verdict.pending || null, hours_past_start: Math.round(hoursPast), start_utc: s0.start_utc, home: (s0.home || {}).name, away: (s0.away || {}).name });
    /* a final the slate no longer carries: ask ESPN for that day (network runs only) */
    if (!slateEv && hoursPast >= 3 && hoursPast <= CHASE_DAYS * 24 && S.SPORT[sport]) out.wantDays.push({ code: S.SPORT[sport].slate, ymd: etYmd(sched), event_key: key });
  });
  return out;
}
function etYmd(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const o = {}; p.forEach((x) => { o[x.type] = x.value; });
  return o.year + o.month + o.day;
}

/* --------------------------------------------------------------- grade */
function grade(state, ctx) {
  const fx = byEvent(state.forecasts), rx = byEvent(state.results), gx = byEvent(state.grades);
  const out = { appended: [], no_snapshot: [] };
  rx.forEach((rows, key) => {
    const res = latest(rows);
    if (!res) return;
    const snaps = fx.get(key) || [];
    const d = P.designate(snaps, res.start_utc);
    if (!d.snapshot) { out.no_snapshot.push({ event_key: key, ineligible: d.ineligible.slice(0, 5) }); return; }
    const sport = d.snapshot.sport;
    const nat = ctx.native && (sport === 'nfl' || sport === 'cfb') ? ctx.native.read(sport, d.snapshot.event_id, d.snapshot.start_utc) : { close: null };
    const g = P.gradeGame(d.snapshot, res, { close: nat.close || null });
    g.start_utc = res.start_utc || d.snapshot.start_utc;
    g.revisions_considered = d.revisions;
    g.graded_at = new Date(ctx.now).toISOString();
    const prev = latest(gx.get(key));
    if (!prev) { g.revision = 1; g.supersedes = null; g.reason = 'graded'; out.appended.push(g); return; }
    if (P.gradeSignature(prev) === P.gradeSignature(g)) return;
    g.revision = (prev.revision || 1) + 1; g.supersedes = prev.hash;
    g.reason = prev.result_hash !== g.result_hash ? 'result_revision' : prev.grader !== g.grader ? 'method_change' : prev.forecast_hash !== g.forecast_hash ? 'forecast_designation' : 'eligibility_change';
    out.appended.push(g);
  });
  return out;
}

module.exports = { MISSING_FINAL_HOURS, ALERT_HOURS, CHASE_DAYS, byEvent, latest, snapTime, epochOf, capture, importRecorded, verifyResults, grade, etYmd };
