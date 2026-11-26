
const ALLOWED = ["EURUSD","GBPUSD","USDJPY","USDTRY","XAUUSD","XAGUSD","NAS100","DAX40"];

const corsHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8"
};

export default async () => {
  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return Response.json(
      { error: "TWELVE_DATA_API_KEY eksik." },
      { status: 503, headers: corsHeaders }
    );
  }

  let symbolMap;

  try {
    symbolMap = JSON.parse(process.env.QUANT_SYMBOL_MAP || "{}");
  } catch {
    return Response.json(
      { error: "QUANT_SYMBOL_MAP geçerli JSON değil." },
      { status: 500, headers: corsHeaders }
    );
  }

  const missing = ALLOWED.filter(
    k => typeof symbolMap[k] !== "string" || !symbolMap[k].trim()
  );

  if (missing.length) {
    return Response.json({
      error: `Sembol eşleştirmesi henüz tamamlanmadı: ${missing.join(", ")}. Her enstrümanın Twelve Data sembolü doğrulanmalı.`,
      missing
    }, { status: 409, headers: corsHeaders });
  }

  const pairs = await Promise.all(
    ALLOWED.map(async keyName => {
      const symbol = symbolMap[keyName];
      const url = new URL("https://api.twelvedata.com/price");

      url.searchParams.set("symbol", symbol);

      try {
        const response = await fetch(url, {
          headers: { Authorization: `apikey ${key}` }
        });

        const body = await response.json();

        if (!response.ok || body.status === "error" || !body.price) {
          return [
            keyName,
            { error: body.message || "Fiyat verisi alınamadı." }
          ];
        }

        return [
          keyName,
          { price: body.price, providerSymbol: symbol }
        ];
      } catch {
        return [
          keyName,
          { error: "Veri sağlayıcısına erişilemedi." }
        ];
      }
    })
  );

  const data = Object.fromEntries(pairs);
  const successCount = Object.values(data).filter(v => v.price).length;

  return Response.json({
    ok: successCount > 0,
    provider: "Twelve Data",
    checkedAt: new Date().toISOString(),
    data,
    successCount,
    total: ALLOWED.length
  }, {
    status: successCount ? 200 : 502,
    headers: corsHeaders
  });
};
