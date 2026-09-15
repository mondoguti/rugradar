// Black-Scholes helpers. Used to compute delta when the data provider
// doesn't supply greeks (CBOE does; Yahoo doesn't).

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation, accurate to ~1e-7.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function d1(spot, strike, t, iv, r) {
  return (Math.log(spot / strike) + (r + iv * iv / 2) * t) / (iv * Math.sqrt(t));
}

export function bsDelta({ type, spot, strike, dte, iv, r = 0.04 }) {
  const t = Math.max(dte, 0.5) / 365;
  if (!iv || iv <= 0 || !spot || !strike) return null;
  const nd1 = normCdf(d1(spot, strike, t, iv, r));
  return type === 'call' ? nd1 : nd1 - 1;
}

export function bsPrice({ type, spot, strike, dte, iv, r = 0.04 }) {
  const t = Math.max(dte, 0.5) / 365;
  if (!iv || iv <= 0 || !(spot > 0) || !(strike > 0)) return null; // log(neg) = NaN, never a price
  const D1 = d1(spot, strike, t, iv, r);
  const D2 = D1 - iv * Math.sqrt(t);
  if (type === 'call') return spot * normCdf(D1) - strike * Math.exp(-r * t) * normCdf(D2);
  return strike * Math.exp(-r * t) * normCdf(-D2) - spot * normCdf(-D1);
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);
export function normPdf(x) { return Math.exp(-x * x / 2) / SQRT_2PI; }

export function bsGamma({ spot, strike, dte, iv, r = 0.04 }) {
  const t = Math.max(dte, 0.5) / 365;
  if (!iv || iv <= 0 || !(spot > 0) || !(strike > 0)) return null;
  return normPdf(d1(spot, strike, t, iv, r)) / (spot * iv * Math.sqrt(t));
}

// Per 1 vol POINT (divide raw vega by 100) — broker/CBOE convention.
export function bsVega({ spot, strike, dte, iv, r = 0.04 }) {
  const t = Math.max(dte, 0.5) / 365;
  if (!iv || iv <= 0 || !(spot > 0) || !(strike > 0)) return null;
  return spot * normPdf(d1(spot, strike, t, iv, r)) * Math.sqrt(t) / 100;
}

// Per calendar DAY — broker/CBOE convention.
export function bsTheta({ type, spot, strike, dte, iv, r = 0.04 }) {
  const t = Math.max(dte, 0.5) / 365;
  if (!iv || iv <= 0 || !(spot > 0) || !(strike > 0)) return null;
  const D1 = d1(spot, strike, t, iv, r);
  const D2 = D1 - iv * Math.sqrt(t);
  const common = -spot * normPdf(D1) * iv / (2 * Math.sqrt(t));
  const carry = r * strike * Math.exp(-r * t);
  const yearly = type === 'call' ? common - carry * normCdf(D2) : common + carry * normCdf(-D2);
  return yearly / 365;
}
