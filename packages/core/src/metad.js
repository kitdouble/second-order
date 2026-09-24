// Type 1 SDT and meta-d' by maximum likelihood (Maniscalco & Lau, 2012, 2014).
// Mirrors the logic of fit_meta_d_MLE: cell padding of 1/(2K), meta-c' = c'
// constraint, type 2 likelihood conditional on stimulus and response.
import { pnorm, qnorm } from "./dist.js";
import { nelderMead } from "./optim.js";

/**
 * Builds nR_S1 / nR_S2 count vectors from trials.
 * trials: [{ side: 'left'|'right', response: 'left'|'right', confidence: 1..K (scaled) }]
 * Left = S1, right = S2. Order: [S1 resp conf K..1, S2 resp conf 1..K].
 */
export function ratingCounts(trials, scaleMin, K) {
  const nR_S1 = new Array(2 * K).fill(0);
  const nR_S2 = new Array(2 * K).fill(0);
  for (const t of trials) {
    if (t.confidence === null || t.confidence === undefined) continue;
    const k = Math.round(t.confidence - scaleMin + 1); // 1..K
    if (k < 1 || k > K) continue;
    const idx = t.response === "left" ? K - k : K - 1 + k;
    if (t.side === "left") nR_S1[idx] += 1;
    else nR_S2[idx] += 1;
  }
  return { nR_S1, nR_S2 };
}

/** d' and criterion from 2AFC-as-yes/no counts, with a standard 0.5 cell correction. */
export function typeOne(trials) {
  let h = 0, s2 = 0, fa = 0, s1 = 0;
  for (const t of trials) {
    if (t.side === "right") {
      s2++;
      if (t.response === "right") h++;
    } else {
      s1++;
      if (t.response === "right") fa++;
    }
  }
  if (!s1 || !s2) return null;
  const HR = (h + 0.5) / (s2 + 1);
  const FAR = (fa + 0.5) / (s1 + 1);
  return { d_prime: qnorm(HR) - qnorm(FAR), c: -0.5 * (qnorm(HR) + qnorm(FAR)) };
}

export function fitMetaD(nR_S1, nR_S2) {
  const K = nR_S1.length / 2;
  const pad = 1 / (2 * K);
  const a = nR_S1.map((v) => v + pad);
  const b = nR_S2.map((v) => v + pad);
  const sumA = a.reduce((x, y) => x + y, 0);
  const sumB = b.reduce((x, y) => x + y, 0);

  // Type 1 at the central criterion.
  const HR = b.slice(K).reduce((x, y) => x + y, 0) / sumB;
  const FAR = a.slice(K).reduce((x, y) => x + y, 0) / sumA;
  const d1 = qnorm(HR) - qnorm(FAR);
  const c1 = -0.5 * (qnorm(HR) + qnorm(FAR));
  if (!(d1 > 0.05)) return { d_prime: d1, c: c1, meta_d: null, mratio: null, note: "d' too low to estimate meta-d'." };
  const cPrime = c1 / d1;

  const cnt = { s1: a, s2: b };
  const unpack = (x) => {
    const md = x[0];
    const mc = cPrime * md;
    const tS1 = [];
    let prev = mc;
    for (let j = 0; j < K - 1; j++) {
      prev = prev - Math.exp(x[1 + j]);
      tS1.push(prev);
    }
    const tS2 = [];
    prev = mc;
    for (let j = 0; j < K - 1; j++) {
      prev = prev + Math.exp(x[K + j]);
      tS2.push(prev);
    }
    return { md, mc, tS1, tS2 };
  };

  const negLL = (x) => {
    const { md, mc, tS1, tS2 } = unpack(x);
    if (!Number.isFinite(md) || Math.abs(md) > 20) return 1e12;
    let ll = 0;
    for (const [stim, mu] of [["s1", -md / 2], ["s2", md / 2]]) {
      const c = cnt[stim];
      const pRespS1 = pnorm(mc - mu);
      const pRespS2 = 1 - pRespS1;
      if (pRespS1 <= 1e-12 || pRespS2 <= 1e-12) return 1e12;
      // Respond S1: conf k region (lower, upper); k = 1 is next to mc.
      for (let k = 1; k <= K; k++) {
        const upper = k === 1 ? mc : tS1[k - 2];
        const lower = k === K ? -Infinity : tS1[k - 1];
        const p = (pnorm(upper - mu) - (lower === -Infinity ? 0 : pnorm(lower - mu))) / pRespS1;
        ll += c[K - k] * Math.log(Math.max(p, 1e-12));
      }
      // Respond S2.
      for (let k = 1; k <= K; k++) {
        const lower = k === 1 ? mc : tS2[k - 2];
        const upper = k === K ? Infinity : tS2[k - 1];
        const p = ((upper === Infinity ? 1 : pnorm(upper - mu)) - pnorm(lower - mu)) / pRespS2;
        ll += c[K - 1 + k] * Math.log(Math.max(p, 1e-12));
      }
    }
    return -ll;
  };

  const x0 = [d1, ...new Array(2 * (K - 1)).fill(Math.log(0.5))];
  let best = nelderMead(negLL, x0, { maxIter: 3000, tol: 1e-10 });
  // One restart from the best point helps Nelder-Mead escape flat regions.
  const again = nelderMead(negLL, best.x, { maxIter: 3000, tol: 1e-10, step: 0.2 });
  if (again.fx < best.fx) best = again;

  const { md, mc, tS1, tS2 } = unpack(best.x);
  return {
    d_prime: d1,
    c: c1,
    meta_d: md,
    meta_c: mc,
    mratio: md / d1,
    criteria_s1: tS1,
    criteria_s2: tS2,
    logL: -best.fx,
  };
}

/** Convenience: meta-d' fit from trial rows of a confidence task. */
export function metaDFromTrials(trials, scale) {
  const [min, max] = scale;
  const K = max - min + 1;
  const { nR_S1, nR_S2 } = ratingCounts(trials, min, K);
  if (nR_S1.reduce((x, y) => x + y, 0) === 0 || nR_S2.reduce((x, y) => x + y, 0) === 0) return null;
  return fitMetaD(nR_S1, nR_S2);
}
