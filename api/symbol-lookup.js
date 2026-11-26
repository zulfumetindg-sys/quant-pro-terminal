const QUERIES = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD",
  NAS100: "NASDAQ 100",
  DAX40: "DAX"
};

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

  const results = await Promise.all(
    Object.entries(QUERIES).map(async ([market, query]) => {
      try {
        const url = new URL(
          "https://api.twelvedata.com/symbol_search"
        );

        url.searchParams.set("symbol", query);
        url.searchParams.set("outputsize", "10");

        const response = await fetch(url, {
          headers: {
            Authorization: `apikey ${key}`
          }
        });

        const body = await response.json();

        if (!response.ok || body.status === "error") {
          return [market, {
            query,
            error: body.message || "Arama başarısız."
          }];
        }

        return [market, {
          query,
          matches: (body.data || []).map(item => ({
            symbol: item.symbol,
            name: item.instrument_name,
            exchange: item.exchange,
            country: item.country,
            currency: item.currency,
            type: item.instrument_type
          }))
        }];
      } catch {
        return [market, {
          query,
          error: "Twelve Data servisine erişilemedi."
        }];
      }
    })
  );

  return res.status(200).json({
    ok: true,
    provider: "Twelve Data",
    results: Object.fromEntries(results)
  });
};
