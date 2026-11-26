let latestSignal = null;
let lastSignalRequestAt = 0;
const MIN_REFRESH_MS = 60000;

const $ = id => document.getElementById(id);
const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[ch]));
const fmt = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value).toFixed(2) : "—";

function setNotice(title, message, type = "") {
  const notice = $("connectionNotice");
  notice.className = "notice " + type;
  $("connectionTitle").textContent = title;
  $("connectionText").textContent = message;
}

function updateStats(signal, dataOnline) {
  const active = signal && (signal.status === "BUY" || signal.status === "SELL");
  $("activeCount").textContent = active ? "1" : "0";
  $("activeDetail").textContent = active ? "Altın için sinyal var" : "Şu an AL / SAT sinyali yok";
  $("dataStatus").textContent = dataOnline ? "ONLINE" : "BEKLENİYOR";
  $("dataDetail").textContent = dataOnline ? "XAUUSD verisi alındı" : "Altın verisi bekleniyor";
}

function renderSignal(signal) {
  const box = $("goldSignal");
  if (!signal) {
    box.innerHTML = '<p class="signal-muted">Altın sinyali henüz alınamadı.</p>';
    return;
  }

  const side = signal.status || "WAIT";
  const label = side === "BUY" ? "AL" : side === "SELL" ? "SAT" : "İŞLEM YOK";
  const trend = value => value === "BUY" ? "YUKARI" : value === "SELL" ? "AŞAĞI" : "—";

  let html = '<div class="signal-top"><span class="signal-side ' +
    (side === "BUY" ? "buy" : side === "SELL" ? "sell" : "wait") +
    '">' + label + '</span><span class="signal-muted">XAUUSD · H1 + tamamlanmış H4</span></div>';

  html += '<div class="signal-grid">' +
    '<div><small>Canlı fiyat</small><b>' + fmt(signal.currentPrice) + '</b></div>' +
    '<div><small>Giriş referansı</small><b>' + fmt(signal.entry) + '</b></div>' +
    '<div><small>Stop loss</small><b>' + fmt(signal.sl) + '</b></div>' +
    '<div><small>Take profit</small><b>' + fmt(signal.tp) + '</b></div>' +
    '<div><small>Risk / getiri</small><b>' + esc(signal.riskReward || "—") + '</b></div>' +
    '<div><small>Giriş mesafesi</small><b>' + (signal.entryDistancePercent == null ? "—" : esc(signal.entryDistancePercent) + "%") + '</b></div>' +
    '<div><small>Geçmiş kazanma oranı</small><b>' + esc(signal.historicalWinProbability || "UNAVAILABLE") + '</b></div>' +
    '<div><small>H1 / H4 trendi</small><b>' + trend(signal.h1Trend) + ' / ' + trend(signal.h4Trend) + '</b></div>' +
    '</div>';

  html += '<p class="signal-muted">' + esc(signal.reason || signal.entryModelWarning || "Sinyal koşulları kontrol edildi.") + '</p>' +
    '<p class="risk-note">RESEARCH_ONLY_NOT_TRADE_READY · Bu sistem emir göndermez. Bağımsız ileri test tamamlanmadığı için kazanma olasılığı üretilmez.</p>';

  box.innerHTML = html;
}

async function loadSignal(force = false) {
  const now = Date.now();
  const remaining = MIN_REFRESH_MS - (now - lastSignalRequestAt);
  if (!force && lastSignalRequestAt && remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    setNotice("API kotası koruma modu", "Yeni veri isteği için " + seconds + " saniye bekle. Aynı dakika içinde tekrarlanan API çağrıları engelleniyor.", "ok");
    return;
  }

  const button = $("refreshBtn");
  button.disabled = true;
  button.textContent = "Altın verisi alınıyor…";
  lastSignalRequestAt = now;

  try {
    const response = await fetch("/api/signal-engine", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || payload.error || "Altın verisi alınamadı.");
    }

    latestSignal = payload.signal || null;
    renderSignal(latestSignal);
    const online = payload.quote && payload.quote.status === "ok";
    updateStats(latestSignal, online);

    $("signalMeta").textContent =
      "Son kontrol: " + (payload.generatedAt || "—") +
      " · " + (payload.candleCount ?? "—") + " tamamlanmış H1 mum" +
      " · " + (payload.completedH4Count ?? "—") + " tamamlanmış H4 mum";

    if (online) {
      setNotice("Altın verisi alındı", "XAUUSD analiz edildi. Yeni veri isteği en erken 60 saniye sonra yapılabilir.", "ok");
    } else {
      setNotice("Altın fiyatı doğrulanamadı", "Sinyal verisi geldi ancak güncel fiyat alınamadı. İşlem kararı üretme.", "bad");
    }
  } catch (error) {
    updateStats(null, false);
    $("goldSignal").innerHTML = '<p class="signal-error">' + esc(error.message) + '</p>';
    $("signalMeta").textContent = "Veri alınamadı";
    setNotice("Veri sağlayıcı yanıt vermedi", error.message + " API kotası açılana kadar tekrar tekrar yenileme yapma.", "bad");
  } finally {
    button.disabled = false;
    button.textContent = "Altın verisini yenile";
  }
}

async function loadAIAnalysis() {
  const button = $("aiAnalyzeBtn");
  const output = $("aiAnalysisResults");
  if (!latestSignal) {
    output.textContent = "Önce XAUUSD teknik verisinin yüklenmesini bekle.";
    return;
  }

  button.disabled = true;
  button.textContent = "AI analiz ediyor…";
  output.textContent = "Teknik veriler OpenAI tarafından yorumlanıyor. Bu işlem OpenAI API kullanımı oluşturabilir.";

  try {
    const response = await fetch("/api/ai-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal: latestSignal })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || payload.error || "AI analizi başarısız.");
    }
    output.textContent = payload.analysis +
      "\\n\\nModel: " + payload.model +
      "\\nKarar değiştirildi mi: Hayır" +
      "\\nDurum: " + payload.executionStatus;
  } catch (error) {
    output.textContent = "AI analizi alınamadı: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "AI teknik analizini çalıştır";
  }
}

async function loadBacktest() {
  const button = $("backtestBtn");
  const output = $("backtestResults");
  button.disabled = true;
  button.textContent = "Geri test çalışıyor…";
  output.textContent = "Tarihsel altın mumları analiz ediliyor…";

  try {
    const response = await fetch("/api/backtest", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || payload.error || "Geri test başarısız.");
    }

    const periods = (payload.conservativeSummary && payload.conservativeSummary.periods) || [];
    output.innerHTML =
      '<p>Motor: ' + esc(payload.engine) + ' · Mum: ' + esc(payload.candleCount) +
      ' · Spread: $' + esc(payload.costModel && payload.costModel.spreadUSD) + '</p>' +
      periods.map(period =>
        '<div class="backtest-row"><b>' + esc(period.period) + '</b>' +
        '<span>İşlem: ' + esc(period.metrics.tradeCount) + '</span>' +
        '<span>WR: ' + (period.metrics.winRatePercent == null ? "—" : esc(period.metrics.winRatePercent) + "%") + '</span>' +
        '<span>PF: ' + esc(period.metrics.profitFactor) + '</span>' +
        '<span>Net: ' + esc(period.metrics.netProfitR) + 'R</span>' +
        '<span>DD: ' + esc(period.metrics.maxDrawdownR) + 'R</span></div>'
      ).join("") +
      '<p class="risk-note">Bu tarihsel OHLC simülasyonudur; gelecekteki sinyallerin kazanma olasılığı değildir. XM gerçek işlem maliyetleri ayrıca doğrulanmalıdır.</p>';
  } catch (error) {
    output.textContent = "Geri test alınamadı: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Tarihsel geri testi çalıştır";
  }
}

$("refreshBtn").addEventListener("click", () => loadSignal());
$("backtestBtn").addEventListener("click", loadBacktest);\n$("aiAnalyzeBtn").addEventListener("click", loadAIAnalysis);

let installPrompt;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installBtn").hidden = true;
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

loadSignal();
