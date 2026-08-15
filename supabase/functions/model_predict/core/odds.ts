// ============================================================================
// EdgeDesk : model_predict / core / odds
//
// Price and probability conversions. Lifted verbatim from model_predict v1.2 so
// MLB's fair-price output is byte-identical after the refactor; the regression
// suite pins that.
// ============================================================================

/** Fair American price for a probability. Clamped so a 0 or 1 cannot produce
 *  an infinite price — a model that is certain is a model that is broken. */
export function toAm(p: number): number {
  p = Math.min(0.999, Math.max(0.001, p));
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

export function decToAm(d: number): number {
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

export function amToDec(a: number): number {
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

/** Implied (vigged) probability of a decimal price. */
export function decToProb(d: number): number | null {
  return d > 1 ? 1 / d : null;
}

/**
 * EV on a price, as a fraction of stake. This is NOT model_edge.
 *
 * model_edge = model_prob - market_fair_prob   (a probability gap)
 * model_ev   = model_prob * decimal_price - 1  (an expected value)
 *
 * They answer different questions and EdgeDesk keeps them in separate columns
 * precisely so no downstream reader can confuse them (spec §13).
 */
export function expectedValue(prob: number, decimalPrice: number | null | undefined): number | null {
  if (decimalPrice == null || !(decimalPrice > 1)) return null;
  if (!Number.isFinite(prob)) return null;
  return prob * decimalPrice - 1;
}

/** Probability gap against the de-vigged market fair. */
export function probabilityGap(prob: number, marketFair: number | null | undefined): number | null {
  if (marketFair == null || !Number.isFinite(marketFair)) return null;
  return prob - marketFair;
}

/** Elo-style logistic on a rating difference (base-10, 400-point scale). */
export function eloProb(ratingDiff: number, scale = 400): number {
  return 1 / (1 + Math.pow(10, -ratingDiff / scale));
}

/** Numerically stable logistic. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}
