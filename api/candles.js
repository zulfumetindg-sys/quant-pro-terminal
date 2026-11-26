
const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD"
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const interval = req.query.interval || "1h";

  if (!["1h", "4h"].includes(interval)) {
    return res.status(400).json({
      ok: false,
      error: "Sadece 1h veya 4h aralığı destekleniyor."
    });
  }

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "API anahtarı bulunamadı."
    });
  }

  try {
    const symbols = Object.values(SYMBOLS).join(",");
    const url = new URL("https://api.twelvedata.com/time_series");

    url.searchParams.set("symbol", symbols);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("timezone", "UTC");

    const response = await fetch(url, {
      headers: {
        Authorization: `apikey ${key}`
      }
    });

    const body = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Twelve Data bağlantı hatası."
      });
    }

    const data = {};

    for (const [market, symbol] of Object.entries(SYMBOLS)) {
      const result = body[symbol];

      if (!result || result.status === "error" || !Array.isArray(result.values)) {
        data[market] = {
          status: "error",
          error: result?.message || "Mum verisi alınamadı."
        };
        continue;
      }

      data[market] = {
        status: "ok",
        symbol,
        interval,
        candles: result.values.map(c => ({
          datetime: c.datetime,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        }))
      };
    }

    const successCount = Object.values(data)
      .filter(x => x.status === "ok").length;

    return res.status(200).json({
      ok: successCount > 0,
      provider: "Twelve Data",
      interval,
      checkedAt: new Date().toISOString(),
      successCount,
      data
    });

  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: "Mum verisi alınırken bağlantı hatası oluştu."
    });
  }
};
