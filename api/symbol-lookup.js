
const QUERIES = {
  NASDAQ: ["NDX", "NASDAQ", "NASDAQ 100"],
  DAX: ["DAX", "DAX 40", "GER40"]
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

  const results = {};

  for (const [market, queries] of Object.entries(QUERIES)) {
    results[market] = [];

    for (const query of queries) {
      try {
        const url = new URL(
          "https://api.twelvedata.com/symbol_search"
        );

        url.searchParams.set("symbol", query);
        url.searchParams.set("outputsize", "10");

        const response = await fetch(url, {
          headers: { Authorization: `apikey ${key}` }
        });

        const body = await response.json();

        results[market].push({
          query,
          matches: (body.data || []).map(item => ({
            symbol: item.symbol,
            name: item.instrument_name,
            exchange: item.exchange,
            country: item.country,
            currency: item.currency,
            type: item.instrument_type
          })),
          error: body.message || null
        });
      } catch {
        results[market].push({
          query,
          error: "Arama başarısız."
        });
      }
    }
  }

  return res.status(200).json({
    ok: true,
    provider: "Twelve Data",
    results
  });
};
