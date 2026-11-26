const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD"
};

const PENDING = ["NAS100", "DAX40"];

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

  const pairs = await Promise.all(
    Object.entries(SYMBOLS).map(async ([market, symbol]) => {
      try {
        const url = new URL("https://api.twelvedata.com/price");
        url.searchParams.set("symbol", symbol);

        const response = await fetch(url, {
          headers: { Authorization: `apikey ${key}` }
        });

        const body = await response.json();

        if (!response.ok || body.status === "error" || !body.price) {
          return [market, {
            status: "error",
            error: body.message || "Fiyat alınamadı."
          }];
        }

        return [market, {
          status: "ok",
          price: Number(body.price),
          providerSymbol: symbol,
          timestamp: new Date().toISOString()
        }];
      } catch {
        return [market, {
          status: "error",
          error: "Veri sağlayıcısına erişilemedi."
        }];
      }
    })
  );

  const data = Object.fromEntries(pairs);

  for (const market of PENDING) {
    data[market] = {
      status: "pending",
      error: "Doğru endeks veri kaynağı bekleniyor."
    };
  }

  const successCount = Object.values(data)
    .filter(item => item.status === "ok").length;

  return res.status(successCount > 0 ? 200 : 502).json({
    ok: successCount > 0,
    provider: "Twelve Data",
    checkedAt: new Date().toISOString(),
    data,
    successCount,
    activeMarkets: 6,
    pendingMarkets: 2
  });
};
