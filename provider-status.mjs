export default async () => {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) {
    return Response.json({
      ok: false,
      error: "TWELVE_DATA_API_KEY Netlify ortam değişkeninde bulunamadı. Site ayarlarından Functions kapsamına ekleyip yeniden deploy edin."
    }, { status: 503 });
  }
  try {
    const url = new URL("https://api.twelvedata.com/api_usage");
    const response = await fetch(url, { headers: { Authorization: `apikey ${key}` } });
    const body = await response.json();
    if (!response.ok || body.status === "error") {
      return Response.json({ ok: false, error: body.message || "Twelve Data API doğrulaması başarısız." }, { status: 502 });
    }
    return Response.json({ ok: true, provider: "Twelve Data", usage: body });
  } catch {
    return Response.json({ ok: false, error: "Twelve Data servisine erişilemedi." }, { status: 502 });
  }
};
