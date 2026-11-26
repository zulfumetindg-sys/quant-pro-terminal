function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;

  let value = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  out[period - 1] = value;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out[i] = value;
  }

  return out;
}

function macdHistogram(candles, endIndex) {
  const close = candles
    .slice(0, endIndex + 1)
    .map(c => c.close);

  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);

  const macd = close.map((_, i) =>
    e12[i] === null || e26[i] === null
      ? null
      : e12[i] - e26[i]
  );

  const firstSignal = 33;
  if (close.length <= firstSignal) return null;

  let value = 0;

  for (let i = 25; i <= firstSignal; i++) {
    value += macd[i];
  }

  value /= 9;

  const k = 2 / 10;
  let signal = value;

  for (let i = firstSignal + 1; i < close.length; i++) {
    signal = macd[i] * k + signal * (1 - k);
  }

  return macd[macd.length - 1] - signal;
}
