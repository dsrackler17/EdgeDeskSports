// ============================================================================
// EdgeDesk : model_predict / core / fit
//
// Fitting and scoring. Every coefficient EdgeDesk uses has to come from
// somewhere, and "a number that looked about right" is not somewhere. This is
// the only sanctioned source: L2-regularised logistic regression fitted on the
// sport's own graded history, evaluated on a TIME-ORDERED holdout, and stored
// with its sample size and its metrics so a reader can decide whether to trust
// it months later.
//
// A model with no fitted parameters does not fall back to invented ones. It
// falls back to a self-calibrating baseline (Elo), or it reports
// insufficient_data.
//
// Deterministic by construction: fixed iteration count, fixed learning rate,
// zero initialisation, no shuffling, no randomness anywhere.
// ============================================================================

import { sigmoid } from "./odds.ts";

export interface FitOptions {
  /** L2 penalty. Applied to weights, never to the intercept. */
  l2?: number;
  iterations?: number;
  learningRate?: number;
  /** fraction of the (time-ordered) sample held out for evaluation */
  holdout?: number;
}

export interface FitResult {
  featureNames: string[];
  weights: number[];
  intercept: number;
  nTrain: number;
  nTest: number;
  train: Metrics;
  test: Metrics;
  /** feature-wise mean/sd used to standardise; predict must reuse them */
  mean: number[];
  sd: number[];
  converged: boolean;
}

export interface Metrics {
  n: number;
  brier: number;
  logLoss: number;
  accuracy: number;
  /** mean predicted probability minus realised rate; ~0 is calibrated */
  calibrationError: number;
}

export function metrics(probs: number[], labels: number[]): Metrics {
  const n = Math.min(probs.length, labels.length);
  if (!n) return { n: 0, brier: NaN, logLoss: NaN, accuracy: NaN, calibrationError: NaN };
  let brier = 0, ll = 0, acc = 0, sumP = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    const y = labels[i];
    brier += (p - y) * (p - y);
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    acc += ((p >= 0.5 ? 1 : 0) === y) ? 1 : 0;
    sumP += p;
    sumY += y;
  }
  return {
    n,
    brier: brier / n,
    logLoss: ll / n,
    accuracy: acc / n,
    calibrationError: (sumP - sumY) / n,
  };
}

/** Reliability by probability bucket (spec §21). Buckets are on the predicted
 *  probability, 10 equal-width bins. */
export function reliability(probs: number[], labels: number[], bins = 10) {
  const out: Array<{ bucket: string; n: number; predicted: number; realised: number }> = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    let n = 0, sp = 0, sy = 0;
    for (let i = 0; i < probs.length; i++) {
      const p = probs[i];
      if (p >= lo && (p < hi || (b === bins - 1 && p <= hi))) {
        n++;
        sp += p;
        sy += labels[i];
      }
    }
    out.push({
      bucket: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      n,
      predicted: n ? +(sp / n).toFixed(4) : 0,
      realised: n ? +(sy / n).toFixed(4) : 0,
    });
  }
  return out;
}

/**
 * Fit a logistic model.
 *
 * `rows` must already be in chronological order — the holdout is the TAIL, not
 * a random sample, because a random split lets the model see the future and
 * reports a test score it has not earned.
 */
export function fitLogistic(
  featureNames: string[],
  rows: number[][],
  labels: number[],
  opts: FitOptions = {},
): FitResult | null {
  const l2 = opts.l2 ?? 1.0;
  const iterations = opts.iterations ?? 4000;
  const lr = opts.learningRate ?? 0.1;
  const holdout = opts.holdout ?? 0.2;

  const n = rows.length;
  const d = featureNames.length;
  if (n < Math.max(50, d * 20) || !d) return null;

  const nTest = Math.max(1, Math.floor(n * holdout));
  const nTrain = n - nTest;
  if (nTrain < Math.max(40, d * 10)) return null;

  // Standardise on the TRAIN slice only; reusing test statistics leaks.
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < nTrain; i++) s += rows[i][j];
    mean[j] = s / nTrain;
    let v = 0;
    for (let i = 0; i < nTrain; i++) {
      const dx = rows[i][j] - mean[j];
      v += dx * dx;
    }
    sd[j] = Math.sqrt(v / nTrain) || 1;
  }
  const z = (i: number, j: number) => (rows[i][j] - mean[j]) / sd[j];

  const w = new Array(d).fill(0);
  let b = 0;
  let converged = false;
  let prevLoss = Infinity;

  for (let it = 0; it < iterations; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    let loss = 0;
    for (let i = 0; i < nTrain; i++) {
      let acc = b;
      for (let j = 0; j < d; j++) acc += w[j] * z(i, j);
      const p = sigmoid(acc);
      const err = p - labels[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * z(i, j);
      const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
      loss += -(labels[i] * Math.log(pc) + (1 - labels[i]) * Math.log(1 - pc));
    }
    loss /= nTrain;
    for (let j = 0; j < d; j++) loss += (l2 / (2 * nTrain)) * w[j] * w[j];

    b -= lr * (gb / nTrain);
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / nTrain + (l2 / nTrain) * w[j]);

    if (Math.abs(prevLoss - loss) < 1e-9) {
      converged = true;
      break;
    }
    prevLoss = loss;
  }

  const predict = (i: number) => {
    let acc = b;
    for (let j = 0; j < d; j++) acc += w[j] * z(i, j);
    return sigmoid(acc);
  };
  const trainP: number[] = [], trainY: number[] = [];
  for (let i = 0; i < nTrain; i++) { trainP.push(predict(i)); trainY.push(labels[i]); }
  const testP: number[] = [], testY: number[] = [];
  for (let i = nTrain; i < n; i++) { testP.push(predict(i)); testY.push(labels[i]); }

  return {
    featureNames,
    weights: w,
    intercept: b,
    nTrain,
    nTest,
    train: metrics(trainP, trainY),
    test: metrics(testP, testY),
    mean,
    sd,
    converged,
  };
}

/** Apply a stored fit to one raw feature vector. */
export function applyFit(fit: {
  weights: number[];
  intercept: number;
  mean: number[];
  sd: number[];
}, x: number[]): number {
  let acc = fit.intercept;
  for (let j = 0; j < fit.weights.length; j++) {
    const s = fit.sd[j] || 1;
    acc += fit.weights[j] * ((x[j] - fit.mean[j]) / s);
  }
  return sigmoid(acc);
}

/**
 * Ordinary least squares on one predictor, used to map a ranking onto the
 * rating scale empirically instead of by assumption.
 *
 * y = a + b*x. Returns null when the sample cannot support a slope.
 */
export function fitLine(xs: number[], ys: number[]): { a: number; b: number; n: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxy += dx * (ys[i] - my);
    sxx += dx * dx;
  }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, n };
}
