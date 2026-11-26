const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanSignal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const allowedStatus = ["BUY", "SELL", "WAIT"];
  const status = allowedStatus.includes(raw.status) ? raw.status : "WAIT";

  return {
    status,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 100) : null,
    currentPrice: finite(raw.currentPrice),
    entry: finite(raw.entry),
    sl: finite(raw.sl),
    tp: finite(raw.tp),
    entryDistancePercent: finite(raw.entryDistancePercent),
    h1Trend: ["BUY", "SELL", "WAIT"].includes(raw.h1Trend) ? raw.h1Trend : "WAIT",
    h4Trend: ["BUY", "SELL", "WAIT"].includes(raw.h4Trend) ? raw.h4Trend : "WAIT",
    macdHistogram: finite(raw.macdHistogram),
    atr: finite(raw.atr),
    riskReward: typeof raw.riskReward === "string" ? raw.riskReward.slice(0, 20) : null,
    historicalWinProbability: "UNAVAILABLE",
    executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY"
  };
}

function extractText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "OPENAI_API_KEY_MISSING",
      message: "AI bağlantısı için Vercel ortam değişkeni OPENAI_API_KEY eklenmeli."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: "INVALID_JSON" }); }
  }

  const signal = cleanSignal(body && body.signal);
  if (!signal) {
    return res.status(400).json({ ok: false, error: "SIGNAL_DATA_REQUIRED" });
  }

  const instructions = [
    "Sen QUANT PRO için Türkçe konuşan teknik piyasa açıklama asistanısın.",
    "Yalnızca verilen XAUUSD H1 ve tamamlanmış H4 teknik verilerini yorumla.",
    "Bu veriler canlı haber akışı değildir; haber, makroekonomi veya güncel olay biliyormuş gibi davranma.",
    "Kesin fiyat tahmini, kazanma olasılığı, backtest sonucu veya garanti üretme.",
    "BUY/SELL/WAIT durumunu, giriş/SL/TP seviyelerini veya risk ayarlarını asla değiştirme.",
    "WAIT ise işlem yok kararının teknik nedenini açıkla; AL/SAT önerisi verme.",
    "BUY veya SELL olsa bile bunu emir talimatı olarak sunma; yalnızca mevcut teknik koşulları ve çelişkileri açıkla.",
    "Yanıtı Türkçe, kısa ve şu başlıklarla yaz: Teknik görünüm; Destekleyen koşullar; Riskler ve eksik doğrulamalar; Sonuç.",
    "Tarihsel kazanma olasılığı UNAVAILABLE ise bunu açıkça belirt.",
    "Her yanıtta RESEARCH_ONLY_NOT_TRADE_READY uyarısının geçerli olduğunu belirt."
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: "Aşağıdaki doğrulanmış motor çıktısını yorumla. JSON verisi:\n" + JSON.stringify(signal),
        max_output_tokens: 350,
        store: false
      }),
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "OPENAI_API_ERROR",
        message: data.error && data.error.message
          ? String(data.error.message).slice(0, 300)
          : "OpenAI API isteği başarısız."
      });
    }

    const analysis = extractText(data);
    if (!analysis) {
      return res.status(502).json({
        ok: false,
        error: "AI_EMPTY_RESPONSE"
      });
    }

    return res.status(200).json({
      ok: true,
      provider: "OpenAI Responses API",
      model: MODEL,
      analysis,
      signalDecisionChanged: false,
      historicalWinProbability: "UNAVAILABLE",
      executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: error.name === "AbortError" ? "OPENAI_TIMEOUT" : "AI_ANALYSIS_FAILED",
      message: error.name === "AbortError"
        ? "AI yanıtı 20 saniyede gelmedi."
        : String(error.message || "AI bağlantı hatası").slice(0, 250)
    });
  } finally {
    clearTimeout(timeout);
  }
};
