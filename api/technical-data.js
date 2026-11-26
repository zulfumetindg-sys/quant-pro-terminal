const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD"
};

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateIndicators(candles) {
  if (candles.length < 51) {
    return { error: "En az 51 mum gerekli." };
  }

  const closes = candles.map(c => c.close);
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));

  const changes = [];
  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const change = closes[i] - closes[i - 1];
    changes.push(change);

    const current = candles[i];
    const previousClose = closes[i - 1];

    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    ));
  }

  const recentChanges = changes.slice(-14);
  const gains = recentChanges.map(v => Math.max(v, 0));
  const losses = recentChanges.map(v => Math.max(-v, 0));
  const avgGain = average(gains);
  const avgLoss = average(losses);

  let rsi;
  if (avgLoss === 0 && avgGain === 0) rsi = 50;
  else if (avgLoss === 0) rsi = 100;
  else rsi = 100 - (100 / (1 + avgGain / avgLoss));

  const atr = average(trueRanges.slice(-14));
  const lastClose = closes[closes.length - 1];

  let trend = "SIDEWAYS";
  if (lastClose > sma20 && sma20 > sma50) trend = "BULLISH";
  if (lastClose < sma20 && sma20 < sma50) trend = "BEARISH";

  return {
    lastClose,
    candleTime: candles[candles.length - 1].datetime,
    rsi: Number(rsi.toFixed(2)),
    atr: Number(atr.toFixed(6)),
    sma20: Number(sma20.toFixed(6)),
    sma50: Number(sma50.toFixed(6)),
    trend,
    candlesUsed: candles.length
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY bulunamadı."
    });
  }

  const timeframe = String(req.query?.timeframe || "H1").toUpperCase();
  if (!["H1", "H4"].includes(timeframe)) {
    return res.status(400).json({
      ok: false,
      error: "timeframe yalnızca H1 veya H4 olabilir."
    });
  }

  const interval = timeframe === "H1" ? "1h" : "4h";
  const symbols = Object.values(SYMBOLS).join(",");

  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbols);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("timezone", "UTC");

    const response = await fetch(url, {
      headers: { Authorization: `apikey ${key}` }
    });

    const body = await response.json();

    if (!response.ok || body.status === "error") {
      return res.status(502).json({
        ok: false,
        error: body.message || "Mum verisi alınamadı."
      });
    }

    const data = {};

    for (const [market, symbol] of Object.entries(SYMBOLS)) {
      const result = body[symbol];

      if (!result || result.status === "error" || !Array.isArray(result.values)) {
        data[market] = {
          status: "error",
          error: result?.message || "Bu piyasa için mum verisi bulunamadı."
        };
        continue;
      }

      const candles = result.values
        .map(item => ({
          datetime: item.datetime,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close)
        }))
        .filter(c =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .reverse();

      const indicators = calculateIndicators(candles);

      data[market] = indicators.error
        ? { status: "error", error: indicators.error }
        : {
            status: "ok",
            providerSymbol: symbol,
            timeframe,
            ...indicators
          };
    }

    const successCount = Object.values(data)
      .filter(item => item.status === "ok").length;

    return res.status(successCount > 0 ? 200 : 502).json({
      ok: successCount > 0,
      provider: "Twelve Data",
      timeframe,
      interval,
      checkedAt: new Date().toISOString(),
      creditNote: "Bu sorgu 5 sembol için yaklaşık 5 API kredisi kullanır.",
      data,
      successCount
    });
  } catch {
    return res.status(502).json({
      ok: false,
      error: "Twelve Data servisine erişilemedi."
    });
  }
};
