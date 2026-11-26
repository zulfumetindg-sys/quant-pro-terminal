const ALLOWED = ["EURUSD","GBPUSD","USDJPY","USDTRY","XAUUSD","XAGUSD","NAS100","DAX40"];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: "TWELVE_DATA_API_KEY Vercel ortam değişkeninde bulunamadı."
    });
  }

  let symbolMap;

  try {
    symbolMap = JSON.parse(process.env.QUANT_SYMBOL_MAP || "{}");
  } catch {
    return res.status(500).json({
      error: "QUANT_SYMBOL_MAP geçerli JSON değil."
    });
  }

  const missing = ALLOWED.filter(
    name => typeof symbolMap[name] !== "string" || !symbolMap[name].trim()
  );

  if (missing.length) {
    return res.status(409).json({
      error: `Sembol eşleştirmesi eksik: ${missing.join(", ")}.`,
      missing
    });
  }

  const pairs = await Promise.all(
    ALLOWED.map(async name => {
      const symbol = symbolMap[name];
      const url = new URL("https://api.twelvedata.com/price");
      url.searchParams.set("symbol", symbol);

      try {
        const response = await fetch(url, {
          headers: { Authorization: `apikey ${key}` }
        });

        const body = await response.json();

        if (!response.ok || body.status === "error" || !body.price) {
          return [name, {
            error: body.message || "Fiyat verisi alınamadı."
          }];
        }

        return [name, {
          price: body.price,
          providerSymbol: symbol,
          timestamp: new Date().toISOString()
        }];
      } catch {
        return [name, {
          error: "Veri sağlayıcısına erişilemedi."
        }];
      }
    })
  );

  const data = Object.fromEntries(pairs);
  const successCount = Object.values(data).filter(v => v.price).length;

  return res.status(successCount ? 200 : 502).json({
    ok: successCount > 0,
    provider: "Twelve Data",
    checkedAt: new Date().toISOString(),
    data,
    successCount,
    total: ALLOWED.length
  });
};
