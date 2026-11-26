module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY Vercel ortam değişkeninde bulunamadı."
    });
  }

  try {
    const response = await fetch(
      "https://api.twelvedata.com/api_usage",
      {
        headers: { Authorization: `apikey ${key}` }
      }
    );

    const body = await response.json();

    if (!response.ok || body.status === "error") {
      return res.status(502).json({
        ok: false,
        error: body.message || "Twelve Data API doğrulaması başarısız."
      });
    }

    return res.status(200).json({
      ok: true,
      provider: "Twelve Data",
      usage: body
    });
  } catch {
    return res.status(502).json({
      ok: false,
      error: "Twelve Data servisine erişilemedi."
    });
  }
};
