
const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD"
};

function ema(values, period) {
  if (values.length < period) return null;
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function normalizeCandles(values) {
  return values.map(c => ({
    datetime: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  })).filter(c =>
    Number.isFinite(Date.parse(c.datetime)) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  ).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

function aggregateH4(candles) {
  const groups = {};

  for (const c of candles) {
    const t = new Date(c.datetime);
    const bucket = new Date(t);
    bucket.setUTCHours(Math.floor(t.getUTCHours() / 4) * 4, 0, 0, 0);
    const key = bucket.toISOString();

    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  return Object.entries(groups)
    .filter(([, g]) => {
      if (g.length !== 4) return false;
      const times = g.map(c => new Date(c.datetime).getTime());

      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] !== 3600000) return false;
      }
      return true;
    })
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([datetime, g]) => ({
      datetime,
      open: g[0].open,
      high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)),
      close: g[3].close
    }));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    ranges.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function analyze(candles, timeframe) {
  const closes = candles.map(c => c.close);
  const fastPeriod = timeframe === "H1" ? 20 : 8;
  const slowPeriod = timeframe === "H1" ? 50 : 20;

  if (closes.length < slowPeriod + 1) {
    return { valid: false, reason: "INSUFFICIENT_CANDLES" };
  }

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);

  if (fast === null || slow === null) {
    return { valid: false, reason: "EMA_UNAVAILABLE" };
  }

  return {
    valid: true,
    trend: fast > slow ? "BUY" : fast < slow ? "SELL" : "WAIT",
    fast,
    slow,
    price: closes[closes.length - 1],
    candleCount: candles.length,
    candleTime: candles[candles.length - 1].datetime
  };
}

function createSignal(h1, h4, candles, currentPrice) {
  if (!h1.valid || !h4.valid) {
    return { status: "WAIT", reason: "INSUFFICIENT_H1_H4_DATA" };
  }

  if (h1.trend === "WAIT" || h1.trend !== h4.trend) {
    return {
      status: "WAIT",
      reason: "H1_H4_NOT_ALIGNED",
      entry: h1.price,
      currentPrice
    };
  }

  const atr = calculateATR(candles);

  if (!atr || !Number.isFinite(atr)) {
    return { status: "WAIT", reason: "ATR_UNAVAILABLE" };
  }

  const entry = h1.price;
  const risk = Math.max(atr * 1.5, Math.abs(entry) * 0.001);
  const reward = risk * 1.8;
  const side = h1.trend;

  const sl = side === "BUY" ? entry - risk : entry + risk;
  const tp = side === "BUY" ? entry + reward : entry - reward;

  const hasQuote = Number.isFinite(currentPrice) && currentPrice > 0;

  const distance = hasQuote
    ? Math.abs(currentPrice - entry) / Math.abs(entry) * 100
    : null;

  return {
    status: side,
    executionStatus: "NOT_TRADE_READY",
    executionBlockReason: "BACKTEST_AND_XM_SPREAD_VALIDATION_PENDING",
    entry,
    entryReference: "LAST_COMPLETED_H1_CANDLE_CLOSE",
    currentPrice: hasQuote ? currentPrice : null,
    liveQuoteStatus: hasQuote ? "OK" : "UNAVAILABLE",
    entryDistancePercent: distance === null ? null : Number(distance.toFixed(4)),
    entryDistanceStatus: hasQuote ? "AVAILABLE" : "UNAVAILABLE",
    sl,
    tp,
    riskReward: "1:1.8",
    historicalWinProbability: "UNAVAILABLE",
    backtestStatus: "NOT_TESTED",
    timeframeConfirmation: "H1+H4",
    maxRiskPercent: 0.5,
    atr
  };
}

async function getLatestPrice(symbol, key) {
  const url = new URL("https://api.twelvedata.com/price");
  url.searchParams.set("symbol", symbol);

  const response = await fetch(url, {
    headers: { Authorization: `apikey ${key}` }
  });

  const body = await response.json();
  const price = Number(body.price);

  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error(body.message || "LIVE_PRICE_UNAVAILABLE");
  }

  return price;
}

module.exports = async function handler(req, res) {
  // Aynı URL için tekrar istekleri Vercel önbelleğinde tut.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=50, stale-while-revalidate=10"
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "API_KEY_MISSING"
    });
  }

  try {
    // Her dakika 5 sembolden yalnızca 3 tanesinin canlı fiyatını al.
    const markets = Object.keys(SYMBOLS);
    const minuteSlot = Math.floor(Date.now() / 60000) % markets.length;

    const selectedMarkets = [
      markets[minuteSlot],
      markets[(minuteSlot + 1) % markets.length],
      markets[(minuteSlot + 2) % markets.length]
    ];

    // 5 kredi: beş piyasanın H1 mum verisi.
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", Object.values(SYMBOLS).join(","));
    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("timezone", "UTC");

    const response = await fetch(url, {
      headers: { Authorization: `apikey ${key}` }
    });

    const body = await response.json();

    if (!response.ok || body.status === "error") {
      return res.status(502).json({
        ok: false,
        error: "TWELVE_DATA_CANDLES_ERROR",
        message: body.message || "Mum verisi alınamadı."
      });
    }

    // 3 kredi: bu dakika sırası gelen üç piyasanın canlı fiyatı.
    const quoteEntries = await Promise.all(
      selectedMarkets.map(async market => {
        const symbol = SYMBOLS[market];

        try {
          return [market, {
            status: "ok",
            price: await getLatestPrice(symbol, key)
          }];
        } catch (error) {
          return [market, {
            status: "error",
            message: error.message
          }];
        }
      })
    );

    const quotes = Object.fromEntries(quoteEntries);

    // Sırası gelmeyen piyasaların fiyatını canlı gibi göstermiyoruz.
    for (const market of markets) {
      if (!quotes[market]) {
        quotes[market] = {
          status: "waiting",
          price: null,
          message: "Bu dakika canlı fiyat sırası değil."
        };
      }
    }

    const results = {};

    for (const [market, symbol] of Object.entries(SYMBOLS)) {
      const item = body[symbol];
      const quote = quotes[market];

      if (!item || !Array.isArray(item.values)) {
        results[market] = {
          symbol,
          quote,
          signal: {
            status: "WAIT",
            reason: item?.message || "CANDLE_DATA_UNAVAILABLE"
          }
        };
        continue;
      }

      const candles = normalizeCandles(item.values);
      const h4Candles = aggregateH4(candles);

      const h1 = analyze(candles, "H1");
      const h4 = analyze(h4Candles, "H4");

      const currentPrice =
        quote.status === "ok" ? quote.price : null;

      results[market] = {
        symbol,
        quote,
        h1,
        h4,
        signal: createSignal(
          h1,
          h4,
          candles,
          currentPrice
        )
      };
    }

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO SIGNAL ENGINE V5",
      mode: "SIGNALS_ONLY",
      provider: "Twelve Data",
      quoteEndpoint: "/price",
      creditPlan: {
        candleCredits: 5,
        liveQuoteCredits: 3,
        expectedTotalCredits: 8,
        planLimit: 8
      },
      quoteRotation: {
        selectedMarkets,
        rotationSlot: minuteSlot,
        message: "Canlı fiyatlar beş piyasa arasında dönüşümlü alınır."
      },
      generatedAt: new Date().toISOString(),
      results
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "ENGINE_ERROR",
      message: error.message
    });
  }
};
