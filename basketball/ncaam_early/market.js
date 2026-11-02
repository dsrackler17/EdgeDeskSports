'use strict';
/* ===========================================================================
   NCAAM-EARLY — the market comparison (T2) and the Conviction tiers.
   Every threshold is the registered config/model_v0.json `market`,
   `conviction` and `angle_tags`; nothing is tuned here.

   A quote: { book, line (home spread / total, null for moneyline),
              price_a, price_b (American: home & away, or over & under)
                or dec_a, dec_b (decimal, as the odds gateway stores them;
                used as given when present, so no price is rounded),
              captured_at (ISO), volume? (Kalshi contracts) }

     devig(a, b)                         the multiplicative two-way de-vig
                                         (the same arithmetic as the two-way de-vig in lib/edgedesk_calc.js)
     compare(market, proj, quotes, now, cfg)
                                         per side: the best FRESH captured
                                         price, the model's probability at that
                                         price's own line, Edge = p x decimal - 1,
                                         the reference (Pinnacle when captured,
                                         else the median fair of the books at the
                                         modal line) with its book and capture
                                         time; thin / stale flags
     angleTags(fh, fa, ph, pa, cfg)      the registered angle definitions
     varianceCap(vars, cfg)              the 60th percentile of the day's team variances
     conviction(edge, x, cfg)            HIGH / MEDIUM / LOW / PASS
   Conviction is never a stake: units exist only for EdgeDesk's own grading
   (config conviction.internal_grading_units) and are not returned here.
   =========================================================================== */
const M = require('./model');

const v = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
function impliedFromAmerican(am) { am = Number(am); if (!Number.isFinite(am) || am === 0 || Math.abs(am) < 100) return null; return am > 0 ? 100 / (am + 100) : -am / (-am + 100); }
function decimalFromAmerican(am) { am = Number(am); if (!Number.isFinite(am) || am === 0 || Math.abs(am) < 100) return null; return am > 0 ? 1 + am / 100 : 1 + 100 / -am; }
function devig(a, b) {
  const pa = impliedFromAmerican(a), pb = impliedFromAmerican(b);
  if (pa == null || pb == null) return null;
  const s = pa + pb; if (!(s > 0)) return null;
  return { a: pa / s, b: pb / s, overround: s - 1 };
}
/* a quote's decimal price of side s ('a' | 'b'): its own decimal, else from American */
function decOf(q, s) {
  const d = Number(s === 'a' ? q.dec_a : q.dec_b);
  if (Number.isFinite(d) && (s === 'a' ? q.dec_a : q.dec_b) != null) return d > 1 ? d : null;
  return decimalFromAmerican(s === 'a' ? q.price_a : q.price_b);
}
function devigQuote(q) {
  const da = decOf(q, 'a'), db = decOf(q, 'b');
  if (da == null || db == null) return null;
  const s = 1 / da + 1 / db;
  return { a: 1 / da / s, b: 1 / db / s, overround: s - 1 };
}
function americanOf(q, s) {
  const am = s === 'a' ? q.price_a : q.price_b;
  if (am != null) return am;
  const d = decOf(q, s); if (d == null) return null;
  return d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
}
const median = (xs) => { const s = xs.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/* the model's probability of each side at a quote's own line */
function modelProbs(market, proj, line) {
  if (market === 'moneyline') return { a: proj.win_prob_home, b: 1 - proj.win_prob_home, push: 0 };
  if (market === 'spread') { const c = M.coverProb(proj, line); return { a: c.home_cover, b: c.away_cover, push: c.push }; }
  const o = M.overProb(proj, line); return { a: o.over, b: o.under, push: o.push };
}

function compare(market, proj, quotes, now, cfg) {
  const MK = cfg.market, staleMs = MK.stale_price_minutes * 60e3, t = Date.parse(now);
  const all = (quotes || []).filter((q) => q && q.book && decOf(q, 'a') != null && decOf(q, 'b') != null && (market === 'moneyline' || Number.isFinite(q.line)));
  const fresh = all.filter((q) => Number.isFinite(Date.parse(q.captured_at)) && t - Date.parse(q.captured_at) <= staleMs && Date.parse(q.captured_at) <= t);
  const flags = [];
  if (!fresh.length) return { market, sides: [], flags: [all.length ? 'STALE_PRICE' : 'NO_PRICE'] };
  const books = new Set(fresh.map((q) => q.book));
  const kalshiThin = fresh.some((q) => /kalshi/i.test(q.book) && q.volume != null && q.volume < 500);
  const thin = books.size < 3 || (books.size === 1 && kalshiThin);
  if (books.size < 3) flags.push('THIN_FEWER_THAN_3_BOOKS');
  if (kalshiThin) flags.push('THIN_KALSHI_VOLUME');
  /* the reference: Pinnacle, else the median fair at the modal line */
  const pin = fresh.find((q) => /pinnacle/i.test(q.book));
  let reference;
  if (pin) { const d = devigQuote(pin); reference = d && { book: pin.book, line: pin.line, captured_at: pin.captured_at, fair_a: d.a, fair_b: d.b, basis: 'pinnacle' }; }
  if (!reference) {
    const lines = fresh.map((q) => (q.line == null ? 'ml' : String(q.line)));
    const modal = lines.sort((x, y) => lines.filter((z) => z === y).length - lines.filter((z) => z === x).length)[0];
    const at = fresh.filter((q) => (q.line == null ? 'ml' : String(q.line)) === modal);
    const ds = at.map(devigQuote).filter(Boolean);
    reference = ds.length ? { book: 'consensus of ' + at.length + ' book' + (at.length === 1 ? '' : 's'), line: at[0].line, captured_at: at.map((q) => q.captured_at).sort().pop(), fair_a: median(ds.map((d) => d.a)), fair_b: median(ds.map((d) => d.b)), basis: 'consensus' } : null;
  }
  const sides = ['a', 'b'].map((s) => {
    let best = null;
    for (const q of fresh) {
      const dec = decOf(q, s); if (dec == null) continue;
      const p = modelProbs(market, proj, q.line)[s];
      const edge = p * dec - 1;
      if (!best || edge > best.edge) best = { side: s, book: q.book, line: q.line, price_american: americanOf(q, s), decimal: dec, p_model: p, edge, captured_at: q.captured_at };
    }
    return best;
  }).filter(Boolean);
  return { market, sides, reference, thin, flags, books_fresh: books.size };
}

/** the registered angle definitions (config angle_tags) */
function angleTags(fh, fa, ph, pa) {
  const tags = [];
  const both = (f) => [fh, fa].map(f);
  if (fh && fa && fh.returning_minutes_share != null && fa.returning_minutes_share != null && Math.abs(fh.returning_minutes_share - fa.returning_minutes_share) >= 0.30) tags.push('continuity_gap');
  if (both((f) => f && ((f.minutes_share_transfer_d1 || 0) + (f.minutes_share_non_d1 || 0)) >= 0.25 && Math.abs(f.translation_shift || 0) >= 1.5).some(Boolean)) tags.push('transfer_translation');
  if (both((f) => f && f.coach_change === true).some(Boolean)) tags.push('coach_change');
  if (both((f) => f && f.returning_value_share != null && 1 - f.returning_value_share >= 0.5).some(Boolean)) tags.push('departed_production');
  if ([ph, pa].some((p) => p && Math.abs(p.tempo_coach_shift || 0) >= 2)) tags.push('pace_coach_history');
  if (fh && fa && fh.height_in_avg != null && fa.height_in_avg != null && Math.abs(fh.height_in_avg - fa.height_in_avg) >= 1.5) tags.push('size_mismatch');
  if (!tags.length) tags.push('price_only');
  return tags;
}

function varianceCap(vars) {
  const s = vars.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const k = 0.6 * (s.length - 1), lo = Math.floor(k), hi = Math.ceil(k);
  return s[lo] + (k - lo) * (s[hi] - s[lo]);
}

/** x: { var_home, var_away, cap, angles, thin, stale } */
function conviction(edge, x, cfg) {
  const T = cfg.conviction.thresholds;
  if (edge == null || x.thin || x.stale || edge < T.edge_floor) return 'PASS';
  const nonPrice = (x.angles || []).some((a) => a !== 'price_only');
  const calm = x.cap != null && x.var_home != null && x.var_away != null && x.var_home <= x.cap && x.var_away <= x.cap;
  if (edge >= T.edge_high && calm && nonPrice) return 'HIGH';
  /* the registered text overlaps for a price-only bet between edge_low and
     edge_high (MEDIUM's "edge_low <= edge < edge_high" against LOW's "the only
     angle is price_only"): the more conservative reading is taken, LOW; a
     price-only bet at edge_high or more is MEDIUM, as MEDIUM's text says */
  if (edge >= T.edge_high) return 'MEDIUM';
  if (edge >= T.edge_low && nonPrice) return 'MEDIUM';
  return 'LOW';
}

module.exports = { devig, devigQuote, decOf, impliedFromAmerican, decimalFromAmerican, compare, modelProbs, angleTags, varianceCap, conviction };
