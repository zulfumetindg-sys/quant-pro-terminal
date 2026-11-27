"use strict";

// Measures the latest completed H1 candle against the preceding 14-bar
// true-range baseline. It is diagnostic only; no trade is blocked by it.
function measureVolatilityShock(candles, index = candles.length - 1, period = 14) {
  if (!Array.isArray(candles) || !Number.isInteger(index) ||
      period < 2 || index < period + 1 || index >= candles.length) {
    return { available: false, ratio: null, reason: "INSUFFICIENT_VOLATILITY_HISTORY" };
  }

  const trueRangeAt = (i) => {
    const current = candles[i];
    const previous = candles[i - 1];
    if (!current || !previous) return null;
    const values = [
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ];
    if (!values.every(Number.isFinite) || values.some(x => x < 0)) return null;
    return Math.max(...values);
  };

  const baseline = [];
  for (let i = index - period; i < index; i++) {
    const value = trueRangeAt(i);
    if (!Number.isFinite(value)) {
      return { available: false, ratio: null, reason: "INVALID_VOLATILITY_CANDLE" };
    }
    baseline.push(value);
  }

  const currentRange = trueRangeAt(index);
  const averageRange = baseline.reduce((sum, value) => sum + value, 0) / period;
  if (!Number.isFinite(currentRange) || !Number.isFinite(averageRange) ||
      averageRange <= 0) {
    return { available: false, ratio: null, reason: "VOLATILITY_BASELINE_UNAVAILABLE" };
  }

  return {
    available: true,
    ratio: Number((currentRange / averageRange).toFixed(4)),
    currentTrueRange: Number(currentRange.toFixed(4)),
    priorAverageTrueRange: Number(averageRange.toFixed(4)),
    baselinePeriod: period,
    method: "LATEST_H1_TRUE_RANGE_DIVIDED_BY_PRIOR_14_H1_TRUE_RANGE_AVERAGE",
    blocking: false
  };
}

module.exports = { measureVolatilityShock };
