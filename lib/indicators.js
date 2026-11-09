// Indicadores técnicos puros (sin red). Entrada: arrays de cierres diarios.
export const sma = (a, n) => (a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n);

export function smaSeries(a, n) {
  return a.map((_, i) => (i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((s, x) => s + x, 0) / n));
}

export function ema(a, n) {
  const k = 2 / (n + 1);
  let e = a[0];
  return a.map((x, i) => (i === 0 ? e : (e = x * k + e * (1 - k))));
}

export function rsi(a, n = 14) {
  if (a.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function macd(a) {
  const e12 = ema(a, 12), e26 = ema(a, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = ema(line, 9);
  return { macd: line.at(-1), signal: sig.at(-1), hist: line.at(-1) - sig.at(-1) };
}

export function volatility(a, n = 30) {
  const r = [];
  for (let i = Math.max(1, a.length - n); i < a.length; i++) r.push(Math.log(a[i] / a[i - 1]));
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
  return { daily: sd * 100, annual: sd * Math.sqrt(365) * 100 };
}

export const maxDrawdown = (vals) => {
  let pk = -Infinity, m = 0;
  for (const v of vals) { pk = Math.max(pk, v); m = Math.min(m, v / pk - 1); }
  return m * 100;
};
