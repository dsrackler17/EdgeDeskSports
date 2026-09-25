/* ===========================================================================
   THE FOOTBALL MODEL RECORD — the research tool's own record, NFL and CFB.

   The edges record (the Record tab) grades rows of `signals`: prices the
   capture flagged, graded at the price. That record says nothing about the
   football MODEL, because the model never flags a price — it publishes a
   number. This file grades that number, and nothing else:

     · the model's own fair spread, total and win probability, exactly as the
       published slates carry them (football/nfl/slate.json,
       football/fbs/slate.json — the same engine run the board prints);
     · the market line at the moment the number was recorded;
     · the closing line; and
     · the final score.

   From those four it states, per game and per sport: the record against the
   spread and the total (model side vs the close, graded on the final), the
   straight-up record, how far the model and the close each missed the real
   margin, the Brier score of the win probability — and the closing-line
   value, in POINTS: how far the market moved toward the side the model's
   number leaned, between the recorded quote and the close. The same
   convention the editorial audit uses (tools/editorial/grading.js).

   THE RULES IT WILL NOT BREAK

   - Pregame only. A projection is recorded only if it was PUBLISHED before
     kickoff (the slate's generated_at, and the commit time when replayed
     from git). A number produced after kickoff is refused, not stored.
   - Frozen at kickoff. Once a game has kicked off nothing about its pick
     changes again. The pick is the model's LAST pregame number; the first
     number it published is kept beside it, and so is the ENTRY — the first
     moment the record held the model's number and a market number together,
     which is what the headline CLV is measured from.
   - A market quote counts only if it was captured before kickoff. CLV is
     computed only when the recorded quote and the close come from the SAME
     source family (nflverse consensus with nflverse consensus, ESPN with
     ESPN): a gap between two different books is not line movement.
   - Nothing is estimated. No close is a null close; no final is a null final;
     a missing total grades no total. A final is never overwritten.
   - Everything here is pure: no clock, no network, no file. The CLI
     (tools/record/football_record.js) supplies all three.
   =========================================================================== */
'use strict';
const REL = require('../../lib/cfb_reliability.js');

const SCHEMA = 'edgedesk_football_model_record_v1';
const SUMMARY_SCHEMA = 'edgedesk_football_model_record_summary_v1';

/* The board's own line guard (app.html FB_GUARD): a model–close gap past
   this is flagged, graded and counted, never hidden. */
const GUARD = { nfl: 14, cfb: 21 };
/* The engine calls 2+ points of disagreement a research lean. */
const LEAN = 2;
const EPS = 0.005;
const PLAUSIBLE = { line: 70, total: [20, 110] };
/* -110 both sides: the win rate a side has to clear to break even. */
const BREAK_EVEN_PCT = 52.38;

const MODEL = {
  nfl: { name: 'EdgeDesk Football Engine · NFL', slate: 'football/nfl/slate.json' },
  cfb: { name: 'EdgeDesk CFB Power 4 Model · all FBS', slate: 'football/fbs/slate.json' },
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function ms(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; }
function same(a, b) { return (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < EPS); }

/* The source FAMILY of a quote: 'nflverse' for the consensus feed, 'espn'
   for ESPN's scoreboard, whatever the provider behind it that day. */
function family(src) { return String(src || '').split(/[\s:·]/)[0].toLowerCase() || null; }

function emptyLedger(sport, season) {
  return {
    schema: SCHEMA, version: 1, sport, season,
    model: MODEL[sport].name,
    projection_source: MODEL[sport].slate,
    updated_at: null,
    conventions: {
      home_line: 'the line the HOME side lays, as a book prints it: negative = home favoured',
      clv_points: 'points the market moved toward the side the model leaned, from the recorded quote to the close; positive = the market came to the model',
      ats: 'model side vs the CLOSE, graded on the final margin: side = home when the model line is below the closing home line',
    },
    games: {},
    notes: [],
  };
}

/* ---------------------------------------------------------------- intake */

/** One slate game → the projection this record stores, or null when the
    engine did not price it. `meta` = { sport, season, generated_at,
    model_version } from the slate itself. */
function projectionFromSlate(sport, g, meta) {
  if (!g || g.model_status !== 'PREDICTED') return null;
  const line = num(g.model_home_line);
  const kickoff = g.kickoff && ms(g.kickoff) != null ? new Date(ms(g.kickoff)).toISOString() : null;
  if (line == null || !kickoff || g.game_id == null) return null;
  /* A number no football game can have is a build fault, not a projection
     (the 2026-09-11 FBS slate carried fair totals of 0). A line past
     PLAUSIBLE.line refuses the game; an impossible total is dropped alone. */
  if (Math.abs(line) > PLAUSIBLE.line) return null;
  const tot = num(g.model_fair_total);
  const total = tot != null && tot >= PLAUSIBLE.total[0] && tot <= PLAUSIBLE.total[1] ? tot : null;
  const wp = num(g.model_home_win_prob);
  const p = {
    game_id: String(g.game_id),
    season: num(g.season) || num(meta && meta.season),
    week: num(g.week),
    kickoff,
    home: g.home_team || null,
    away: g.away_team || null,
    model_version: g.model_version || (meta && meta.model_version) || null,
    home_line: r2(line),
    total: r2(total),
    home_win_prob: wp != null && wp >= 0 && wp <= 1 ? r4(wp) : null,
  };
  if (sport === 'nfl') {
    p.home_code = g.home_code || null;
    p.away_code = g.away_code || null;
    const rm = g.reference_market;
    if (rm && num(rm.home_line) != null) {
      p.reference_market = { home_line: num(rm.home_line), total: num(rm.total), source: 'nflverse', book: 'consensus' };
    }
  } else {
    p.home_conference = g.home_conference || null;
    p.away_conference = g.away_conference || null;
    p.home_division = g.home_division || null;
    p.away_division = g.away_division || null;
    p.matchup_type = g.matchup_type || null;
    p.group = groupOf(g);
    p.neutral_site = g.neutral_site === true;
    /* THE PREGAME RELIABILITY the slate published beside this number
       (lib/cfb_reliability.js). Carried into the pick, so it is frozen by the
       same publication-time rule as the number and can never be read after
       kickoff. Absent on a slate that predates it: null, never a guess. */
    p.reliability = reliabilityOf(g);
  }
  return p;
}
function reliabilityOf(g) {
  const s = num(g.reliability_score);
  if (s == null) return null;
  const st = g.projection_stability || null;
  const comp = {};
  const c = g.reliability_components || {};
  Object.keys(c).forEach((k) => { if (c[k] && num(c[k].score) != null) comp[k] = c[k].score; });
  return { version: (g.reliability && g.reliability.contract) || null, score: s, grade: g.reliability_grade || null,
    components: comp,
    capped_by: (g.reliability && Array.isArray(g.reliability.capped_by)) ? g.reliability.capped_by.slice() : [],
    stability_sd: st ? num(st.projection_stability_sd) : null,
    favorite_flip_rate: st ? num(st.favorite_flip_rate) : null,
    stability_tier: st ? st.tier || null : null };
}

/* One label per college game, so the record can be read by the same split
   the board filters on. */
function groupOf(g) {
  const hd = g.home_division, ad = g.away_division;
  if ((hd && hd !== 'fbs') || (ad && ad !== 'fbs')) return 'fbs_fcs';
  if (g.home_fbs_group === 'p4' || g.away_fbs_group === 'p4') return 'p4';
  return 'other_fbs';
}

function quote(q, at) {
  if (!q || num(q.home_line) == null && num(q.total) == null) return null;
  return { home_line: num(q.home_line), total: num(q.total), source: q.source || null, book: q.book || null, at: at || q.at || null };
}

/* THE ENTRY: the first moment this record held BOTH the model's number and a
   market number, before kickoff. It is the pair the headline CLV is measured
   from — the model's number as it stood then, the market as it stood then —
   so a number revised after the market moved cannot borrow the movement, and
   a game whose first number had no quote yet still gets one entry, at the
   first quote. Set once; only a replay of an OLDER pair can replace it. */
function entryOf(pick, mkt) {
  return { model_at: pick.at, home_line: pick.home_line, total: pick.total, market: mkt };
}
function older(a, b) { return ms(a) != null && ms(b) != null && ms(a) < ms(b); }

/**
 * Record one published projection.
 *   ctx.published_at  when the number was produced (slate generated_at)
 *   ctx.commit_at     when it was committed, when replayed from git history
 *   ctx.market        a quote from the same moment (the NFL slate's own
 *                     reference line), carrying its own `at`
 *   ctx.replay        true when replaying committed history, oldest first
 * Returns 'new' | 'revised' | 'unchanged' | 'refused:<why>'.
 */
function recordProjection(ledger, proj, ctx) {
  const kick = ms(proj.kickoff);
  const pub = ms(ctx.published_at);
  if (pub == null) return 'refused:no publication time';
  if (pub >= kick) return 'refused:published after kickoff';
  if (ctx.commit_at && ms(ctx.commit_at) >= kick) return 'refused:committed after kickoff';
  const g = ledger.games[proj.game_id];
  const mkt = ctx.market && (ms(ctx.market.at) == null || ms(ctx.market.at) < kick) ? quote(ctx.market) : null;
  const pick = { at: new Date(pub).toISOString(), home_line: proj.home_line, total: proj.total,
    home_win_prob: proj.home_win_prob, model_version: proj.model_version };
  if (proj.reliability) pick.reliability = Object.assign({ at: pick.at }, proj.reliability);

  if (!g) {
    const e = Object.assign({}, proj);
    delete e.reference_market;
    e.first = Object.assign({}, pick);
    e.pick = Object.assign({}, pick);
    e.revisions = 0;
    e.entry = mkt ? entryOf(pick, mkt) : null;
    e.market_pick = mkt;
    e.close = null;
    e.final = null;
    if (ctx.provenance) e.provenance = ctx.provenance;
    ledger.games[proj.game_id] = e;
    return 'new';
  }
  /* a replay of git history can surface a number older than the first one
     this record saw: the first read is the EARLIEST published number, and an
     older model–market pair is the truer entry */
  if (ctx.replay && older(pick.at, g.first.at)) g.first = Object.assign({}, pick);
  if (ctx.replay && mkt && (!g.entry || older(mkt.at, g.entry.market && g.entry.market.at))) g.entry = entryOf(pick, mkt);
  /* FROZEN BY PUBLICATION TIME, not by when this run happens to look: a
     number published after kickoff was refused above, so a pick can only be
     replaced by a later number that was itself published pregame. A slow
     scheduler cannot lose a pregame revision, and cannot admit a late one. */
  if (ms(g.pick.at) != null && pub <= ms(g.pick.at)) return 'unchanged';
  /* schedule facts can move before kickoff (a flexed kickoff, a week label) */
  ['kickoff', 'week', 'home', 'away'].forEach((k) => { if (proj[k] != null) g[k] = proj[k]; });
  if (same(g.pick.home_line, pick.home_line) && same(g.pick.total, pick.total) && same(g.pick.home_win_prob, pick.home_win_prob)) {
    /* the number held, but a LATER PREGAME read of the information under it
       is the truer description of what stood behind the pick at kickoff: its
       reliability is refreshed, stamped with its own time, and it is not a
       revision of the number */
    if (pick.reliability) g.pick.reliability = pick.reliability;
    return 'unchanged';
  }
  g.pick = pick;
  g.revisions = (g.revisions || 0) + 1;
  g.market_pick = mkt;
  if (!g.entry && mkt) g.entry = entryOf(pick, mkt);
  if (ctx.provenance) g.provenance = ctx.provenance;
  return 'revised';
}

/** A quote captured NOW for a recorded game that is still ahead of kickoff.
    It becomes the entry if there is none, and the pick's quote if the pick
    has none. Never after kickoff. Returns true when anything was filled. */
function fillMarket(e, q, nowIso) {
  if (!e || !q) return false;
  const now = ms(nowIso), kick = ms(e.kickoff);
  if (now == null || kick == null || now >= kick) return false;
  const mq = quote(q, nowIso);
  if (!mq) return false;
  let did = false;
  if (!e.market_pick) { e.market_pick = mq; did = true; }
  if (!e.entry) { e.entry = entryOf(e.pick, mq); did = true; }
  return did;
}

/* THE LAST PREGAME QUOTE — the close when the source keeps none.

   ESPN's scoreboard carries a line while a college game is ahead and, it
   turned out on the first live run, none once the game is final: 160
   finished games, 0 closes. So inside the last PRECLOSE_HOURS before kickoff
   every run keeps the latest line it saw, and a finished game the source
   gave no close is graded against that — the last number this record
   captured before kickoff, from the same source, labelled as such. The same
   shape as the edges pipeline's `last_tick` close. It changes only when the
   line does, so a quiet market writes nothing. */
const PRECLOSE_HOURS = 36;
function noteQuote(e, q, nowIso) {
  if (!e || !q) return false;
  const now = ms(nowIso), kick = ms(e.kickoff);
  if (now == null || kick == null || now >= kick || kick - now > PRECLOSE_HOURS * 3600000) return false;
  const mq = quote(q, nowIso);
  if (!mq || mq.home_line == null) return false;
  const lq = e.last_quote;
  if (lq && same(lq.home_line, mq.home_line) && same(lq.total, mq.total) && lq.book === mq.book
    && family(lq.source) === family(mq.source)) return false;
  e.last_quote = mq;
  return true;
}
/** A finished game with no close from its source takes its last pregame
    quote as the close. Never before the final, never a quote from after
    kickoff, never over a close the source did give. */
function closeFromLastQuote(e, nowIso) {
  if (!e || !e.last_quote || !e.final) return false;
  if (e.close && e.close.home_line != null) return false;
  const now = ms(nowIso), kick = ms(e.kickoff), lq = e.last_quote;
  if (now == null || kick == null || now < kick || !(ms(lq.at) < kick)) return false;
  e.close = { home_line: lq.home_line, total: lq.total, source: lq.source, book: lq.book,
    basis: 'last pregame capture', at: lq.at };
  return true;
}

/** The closing line, once the game is under way. Fills what is missing;
    never replaces a close already held from the same source. */
function setClose(e, c, nowIso) {
  if (!e || !c) return false;
  const now = ms(nowIso), kick = ms(e.kickoff);
  if (now == null || kick == null || now < kick) return false;
  const hl = num(c.home_line), tt = num(c.total);
  if (hl == null && tt == null) return false;
  if (!e.close) { e.close = { home_line: hl, total: tt, source: c.source || null, book: c.book || null }; return true; }
  let did = false;
  if (family(e.close.source) !== family(c.source)) return false;
  if (e.close.home_line == null && hl != null) { e.close.home_line = hl; did = true; }
  if (e.close.total == null && tt != null) { e.close.total = tt; did = true; }
  return did;
}

/** The final score. Set once; a later source that disagrees is noted and
    changes nothing (a wrong final grades the model permanently). */
function setFinal(e, f, nowIso) {
  if (!e || !f) return false;
  const hs = num(f.home_score), as = num(f.away_score);
  if (hs == null || as == null || !Number.isInteger(hs) || !Number.isInteger(as)) return false;
  if (hs === 0 && as === 0) return false;
  if (e.final) {
    if (e.final.home_score !== hs || e.final.away_score !== as) e.final_conflict = { home_score: hs, away_score: as, source: f.source || null };
    return false;
  }
  e.final = { home_score: hs, away_score: as, source: f.source || null, at: nowIso || null };
  return true;
}

/* ---------------------------------------------------------------- grading */

function sideResult(side, diff) {
  if (!side || diff == null) return null;
  if (Math.abs(diff) < 1e-9) return 'push';
  return (diff > 0) === (side === 'home' || side === 'over') ? 'win' : 'loss';
}

/* points the market moved toward `side`, from `m` to `c` */
function clvPts(kind, side, m, c) {
  if (!side || m == null || c == null) return null;
  if (kind === 'spread') return r2(side === 'home' ? m - c : c - m);
  return r2(side === 'over' ? c - m : m - c);
}

function leanSpread(modelLine, mktLine) {
  if (modelLine == null || mktLine == null || Math.abs(mktLine - modelLine) < EPS) return null;
  return modelLine < mktLine ? 'home' : 'away';
}
function leanTotal(modelTotal, mktTotal) {
  if (modelTotal == null || mktTotal == null || Math.abs(modelTotal - mktTotal) < EPS) return null;
  return modelTotal > mktTotal ? 'over' : 'under';
}

/* CLV for one recorded model–market pair (the entry, or the pick) against the close. */
function clvRead(read, market, close) {
  const out = { spread: null, total: null };
  if (!read || !market || !close) return out;
  if (family(market.source) !== family(close.source)) return out;
  const sSide = leanSpread(read.home_line, market.home_line);
  if (sSide && close.home_line != null) {
    out.spread = { side: sSide, market: market.home_line, close: close.home_line,
      gap: r2(Math.abs(market.home_line - read.home_line)), pts: clvPts('spread', sSide, market.home_line, close.home_line) };
  }
  const tSide = leanTotal(read.total, market.total);
  if (tSide && close.total != null) {
    out.total = { side: tSide, market: market.total, close: close.total,
      gap: r2(Math.abs(read.total - market.total)), pts: clvPts('total', tSide, market.total, close.total) };
  }
  return out;
}

/** Everything the record says about one game, derived from its facts. */
function gradeGame(e, sport, nowIso) {
  const now = ms(nowIso), kick = ms(e.kickoff);
  const g = { status: null, spread: null, total: null, su: null, clv_entry: null, clv_pick: null, error: null, brier: null, beyond_guard: false,
    reliability: null };
  const f = e.final, c = e.close, p = e.pick;
  if (now != null && kick != null && now < kick) g.status = 'PREGAME';
  else if (!f) g.status = 'AWAITING_FINAL';
  else if (!c || c.home_line == null) g.status = 'FINAL_NO_CLOSE';
  else g.status = 'GRADED';

  if (c && c.home_line != null && p.home_line != null) {
    const gap = r2(c.home_line - p.home_line);
    g.beyond_guard = Math.abs(gap) > (GUARD[sport] || 14);
    const side = leanSpread(p.home_line, c.home_line);
    g.spread = { side, gap: r2(Math.abs(gap)), result: null };
    if (f && side) g.spread.result = sideResult(side, (f.home_score - f.away_score) + c.home_line);
  }
  if (c && c.total != null && p.total != null) {
    const side = leanTotal(p.total, c.total);
    g.total = { side, gap: r2(Math.abs(p.total - c.total)), result: null };
    if (f && side) g.total.result = sideResult(side, (f.home_score + f.away_score) - c.total);
  }
  if (f) {
    const margin = f.home_score - f.away_score;
    const fav = p.home_win_prob != null ? (p.home_win_prob >= 0.5 ? 'home' : 'away') : (p.home_line <= 0 ? 'home' : 'away');
    g.su = { side: fav, result: sideResult(fav, margin) };
    g.error = {
      margin: margin,
      model_margin_err: r2(Math.abs(-p.home_line - margin)),
      close_margin_err: c && c.home_line != null ? r2(Math.abs(-c.home_line - margin)) : null,
      model_total_err: p.total != null ? r2(Math.abs(p.total - (f.home_score + f.away_score))) : null,
      close_total_err: c && c.total != null ? r2(Math.abs(c.total - (f.home_score + f.away_score))) : null,
    };
    if (p.home_win_prob != null) {
      const y = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
      g.brier = r4((p.home_win_prob - y) * (p.home_win_prob - y));
    }
  }
  /* the pregame reliability the pick was published under, in its bucket */
  if (p && p.reliability && num(p.reliability.score) != null) {
    const sc = p.reliability.score;
    const b = REL.BUCKETS.filter((x) => Math.round(sc) >= x.min && Math.round(sc) <= x.max)[0];
    g.reliability = { score: sc, bucket: b ? b.key : null, at: p.reliability.at || null };
  }
  if (c && kick != null && (now == null || now >= kick)) {
    g.clv_entry = e.entry ? clvRead(e.entry, e.entry.market, c) : { spread: null, total: null };
    g.clv_pick = clvRead(e.pick, e.market_pick, c);
  }
  return g;
}

/* -------------------------------------------------------------- summaries */

function rec() { return { n: 0, w: 0, l: 0, p: 0, pct: null }; }
function tally(r, result) {
  if (!result) return;
  r.n++;
  if (result === 'win') r.w++; else if (result === 'loss') r.l++; else r.p++;
  r.pct = (r.w + r.l) ? r1(100 * r.w / (r.w + r.l)) : null;
}
function clvAgg() { return { n: 0, sum: 0, avg: null, beat: 0, flat: 0, lost: 0, beat_pct: null }; }
function addClv(a, pts) {
  if (pts == null) return;
  a.n++; a.sum += pts;
  if (pts > 1e-9) a.beat++; else if (pts < -1e-9) a.lost++; else a.flat++;
  a.avg = r2(a.sum / a.n);
  a.beat_pct = r1(100 * a.beat / a.n);
}
function finishClv(a) { const o = Object.assign({}, a); o.sum = r2(o.sum); return o; }

function summarize(ledger, gradesById, opts) {
  opts = opts || {};
  const games = Object.keys(ledger.games).map((k) => ({ e: ledger.games[k], g: gradesById[k] }));
  const out = {
    sport: ledger.sport, season: ledger.season, model: ledger.model,
    versions: Array.from(new Set(games.map((x) => x.e.pick && x.e.pick.model_version).filter(Boolean))).sort(),
    counts: { recorded: games.length, pregame: 0, awaiting_final: 0, final_no_close: 0, graded: 0, revised: 0, beyond_guard: 0 },
    ats: { all: rec(), lean: rec(), big: rec() },
    ou: { all: rec(), lean: rec(), big: rec() },
    su: rec(),
    clv: {
      spread_entry: clvAgg(), spread_entry_lean: clvAgg(), spread_pick: clvAgg(),
      total_entry: clvAgg(), total_pick: clvAgg(),
    },
    error: { n: 0, model_mae: null, close_mae: null, model_closer_pct: null, total_n: 0, model_total_mae: null, close_total_mae: null },
    brier: { n: 0, model: null },
    weeks: [],
    break_even_pct: BREAK_EVEN_PCT,
    lean_threshold: LEAN,
    guard_points: GUARD[ledger.sport],
  };
  let me = 0, ce = 0, closer = 0, mt = 0, ct = 0, bs = 0;
  const weeks = {};
  games.forEach(({ e, g }) => {
    if (!g) return;
    const key = g.status === 'PREGAME' ? 'pregame' : g.status === 'AWAITING_FINAL' ? 'awaiting_final' : g.status === 'FINAL_NO_CLOSE' ? 'final_no_close' : 'graded';
    out.counts[key]++;
    if (e.revisions > 0) out.counts.revised++;
    if (g.beyond_guard) out.counts.beyond_guard++;
    const wk = e.week != null ? e.week : 0;
    const W = (weeks[wk] = weeks[wk] || { week: e.week, recorded: 0, graded: 0, ats: rec(), ou: rec(), clv: clvAgg() });
    W.recorded++;
    if (g.status === 'GRADED') W.graded++;
    if (g.spread && g.spread.result) {
      tally(out.ats.all, g.spread.result); tally(W.ats, g.spread.result);
      if (g.spread.gap >= LEAN) tally(out.ats.lean, g.spread.result);
      if (g.spread.gap >= 2 * LEAN) tally(out.ats.big, g.spread.result);
    }
    if (g.total && g.total.result) {
      tally(out.ou.all, g.total.result); tally(W.ou, g.total.result);
      if (g.total.gap >= LEAN) tally(out.ou.lean, g.total.result);
      if (g.total.gap >= 2 * LEAN) tally(out.ou.big, g.total.result);
    }
    if (g.su) tally(out.su, g.su.result);
    if (g.clv_entry && g.clv_entry.spread) {
      addClv(out.clv.spread_entry, g.clv_entry.spread.pts); addClv(W.clv, g.clv_entry.spread.pts);
      if (g.clv_entry.spread.gap >= LEAN) addClv(out.clv.spread_entry_lean, g.clv_entry.spread.pts);
    }
    if (g.clv_pick && g.clv_pick.spread) addClv(out.clv.spread_pick, g.clv_pick.spread.pts);
    if (g.clv_entry && g.clv_entry.total) addClv(out.clv.total_entry, g.clv_entry.total.pts);
    if (g.clv_pick && g.clv_pick.total) addClv(out.clv.total_pick, g.clv_pick.total.pts);
    if (g.error && g.error.close_margin_err != null) {
      out.error.n++; me += g.error.model_margin_err; ce += g.error.close_margin_err;
      if (g.error.model_margin_err < g.error.close_margin_err) closer++;
    }
    if (g.error && g.error.model_total_err != null && g.error.close_total_err != null) {
      out.error.total_n++; mt += g.error.model_total_err; ct += g.error.close_total_err;
    }
    if (g.brier != null) { out.brier.n++; bs += g.brier; }
  });
  if (out.error.n) {
    out.error.model_mae = r2(me / out.error.n); out.error.close_mae = r2(ce / out.error.n);
    out.error.model_closer_pct = r1(100 * closer / out.error.n);
  }
  if (out.error.total_n) { out.error.model_total_mae = r2(mt / out.error.total_n); out.error.close_total_mae = r2(ct / out.error.total_n); }
  if (out.brier.n) out.brier.model = r4(bs / out.brier.n);
  /* DOES A HIGHER PREGAME RELIABILITY GO WITH A SMALLER ERROR? Grouped by the
     reliability each pick was published under, never re-scored after the
     game; the verdict stays NOT VALIDATED until every bucket that can be
     tested holds enough games and the ordering is monotone. */
  if (ledger.sport !== 'nfl') {
    const rows = [];
    games.forEach(({ e, g }) => {
      if (!g || g.status !== 'GRADED' || !e.pick || !e.pick.reliability || num(e.pick.reliability.score) == null) return;
      rows.push({ reliability: e.pick.reliability.score, model_margin: -e.pick.home_line,
        close_margin: e.close && e.close.home_line != null ? -e.close.home_line : null,
        final_margin: e.final ? e.final.home_score - e.final.away_score : null });
    });
    out.by_reliability = REL.calibrate(rows);
  }
  Object.keys(out.clv).forEach((k) => { out.clv[k] = finishClv(out.clv[k]); });
  out.weeks = Object.keys(weeks).map(Number).sort((a, b) => a - b).map((k) => {
    const W = weeks[k]; W.clv = finishClv(W.clv); return W;
  });
  return out;
}

/** Grade every game in a ledger; stamps each game's `grade` in place and
    returns the summary. */
function gradeLedger(ledger, nowIso) {
  const grades = {};
  Object.keys(ledger.games).forEach((k) => {
    const g = gradeGame(ledger.games[k], ledger.sport, nowIso);
    ledger.games[k].grade = g;
    grades[k] = g;
  });
  return summarize(ledger, grades);
}

module.exports = {
  SCHEMA, SUMMARY_SCHEMA, GUARD, LEAN, BREAK_EVEN_PCT, MODEL, PRECLOSE_HOURS,
  emptyLedger, projectionFromSlate, groupOf, recordProjection, fillMarket, noteQuote, closeFromLastQuote, setClose, setFinal,
  gradeGame, gradeLedger, summarize, clvPts, leanSpread, leanTotal, family, num,
};
