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
  $("dataStatus").textContent = dataOnline ? "DOĞRULANDI" : "DOĞRULANMADI";
  $("dataDetail").textContent = dataOnline ? "Fiyat zaman damgası geçerli" : "Fiyatın güncelliği doğrulanamadı";
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
    '<div><small>Doğrulanmış sağlayıcı fiyatı</small><b>' + fmt(signal.currentPrice) + '</b></div>' +
    '<div><small>Giriş referansı</small><b>' + fmt(signal.entry) + '</b></div>' +
    '<div><small>Stop loss</small><b>' + fmt(signal.sl) + '</b></div>' +
    '<div><small>Take profit</small><b>' + fmt(signal.tp) + '</b></div>' +
    '<div><small>Brüt risk / getiri (maliyet öncesi)</small><b>' + esc(signal.riskReward || "—") + '</b></div>' +
    '<div><small>Giriş mesafesi</small><b>' + (signal.entryDistancePercent == null ? "—" : esc(signal.entryDistancePercent) + "%") + '</b></div>' +
    '<div><small>Geçmiş kazanma oranı</small><b>' + esc(signal.historicalWinProbability || "UNAVAILABLE") + '</b></div>' +
    '<div><small>H1 / H4 trendi</small><b>' + trend(signal.h1Trend) + ' / ' + trend(signal.h4Trend) + '</b></div>' +
    '<div><small>Son H1 volatilite / önceki 14 H1 ortalaması</small><b>' +
      (signal.volatilityShock && signal.volatilityShock.available ? Number(signal.volatilityShock.ratio).toFixed(2) + 'x' : 'VERİ YOK') +
    '</b></div>' +
    '</div>' +
    '<p class="signal-muted">Volatilite ölçümü yalnızca tanısaldır; doğrulanmış eşik bulunmadığı için tek başına AL/SAT kararını engellemez.</p>';

  html += '<p class="signal-muted">' + esc(signal.reason || signal.entryModelWarning || "Sinyal koşulları kontrol edildi.") + '</p>' +
    '<p class="risk-note">RESEARCH_ONLY_NOT_TRADE_READY · Bu sistem emir göndermez. Bağımsız ileri test tamamlanmadığı için kazanma olasılığı üretilmez.</p>';

  box.innerHTML = html;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("İstek zaman aşımına uğradı (" + Math.round(timeoutMs / 1000) + " sn). API yanıt vermedi.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    const response = await fetchWithTimeout("/api/signal-engine", { cache: "no-store" }, 30000);
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
      setNotice("Fiyat zaman damgası doğrulandı", "XAUUSD fiyatı " + (payload.quote.ageSeconds ?? "—") + " saniye önce güncellendi. Bid/ask ve gerçek işlem maliyeti ayrıca doğrulanmış değildir.", "ok");
    } else {
      setNotice("Fiyat güncelliği doğrulanamadı", "Zaman damgası eksik veya 180 saniyeden eski. Güvenlik gereği AL/SAT sinyali üretilmedi.", "bad");
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

function loadFreeAnalysis() {
  const output = $("aiAnalysisResults");
  if (!latestSignal) {
    output.textContent = "Önce XAUUSD teknik verisinin yüklenmesini bekle.";
    return;
  }

  const s = latestSignal;
  const side = s.status || "WAIT";
  const trend = value => value === "BUY" ? "Yukarı" : value === "SELL" ? "Aşağı" : "Belirsiz";
  const reasonText = {
    LIVE_QUOTE_UNAVAILABLE: "Canlı fiyat doğrulanamadı. Güvenilir fiyat olmadan sinyal üretilemez.",
    INSUFFICIENT_H1_H4_DATA: "Tamamlanmış H1/H4 mum sayısı yetersiz.",
    H1_H4_NOT_ALIGNED: "H1 ve H4 yönleri aynı değil. Zaman dilimleri uyuşmadığı için işlem açılmıyor.",
    MACD_HISTOGRAM_NOT_CONFIRMED: "MACD histogramı seçilen yönü doğrulamıyor.",
    ENTRY_TOO_FAR_FROM_PRICE: "Fiyat giriş referansından izin verilen %0,10 sınırından uzakta.",
    ATR_UNAVAILABLE: "ATR verisi hesaplanamadı; zarar durdur ve hedef güvenilir biçimde belirlenemiyor."
  };

  const lines = [];
  lines.push("ÜCRETSİZ KURAL TABANLI TEKNİK AÇIKLAMA");
  lines.push("Karar: " + (side === "BUY" ? "AL" : side === "SELL" ? "SAT" : "İŞLEM YOK"));
  lines.push("H1 trendi: " + trend(s.h1Trend) + " · H4 trendi: " + trend(s.h4Trend));
  const shock = s.volatilityShock;
  lines.push("Son H1 volatilite oranı: " +
    (shock && shock.available ? shock.ratio + "x / önceki " + shock.baselinePeriod + " H1 ortalaması" : "hesaplanamadı") +
    " · tanısal, işlem engeli değil.");

  if (side === "BUY" || side === "SELL") {
    lines.push("Trend uyumu: H1 ve H4 aynı yönde; motorun yön filtresi olumlu.");
    if (Number.isFinite(Number(s.macdHistogram))) {
      lines.push("MACD histogramı: " + s.macdHistogram + " · yön filtresi sinyal tarafını destekliyor.");
    } else {
      lines.push("MACD histogramı: veri yok.");
    }
    lines.push("ATR(14): " + (s.atr == null ? "veri yok" : s.atr) + " · stop mesafesi volatiliteye göre hesaplandı.");
    lines.push("Risk/getiri: " + (s.riskReward || "hesaplanamadı") + " (spread/kayma/komisyon öncesi) · giriş mesafesi: " +
      (s.entryDistancePercent == null ? "bilinmiyor" : s.entryDistancePercent + "%") + ".");
    lines.push("Giriş: " + (s.entry ?? "—") + " · SL: " + (s.sl ?? "—") + " · TP: " + (s.tp ?? "—"));
  } else {
    lines.push("İşlem açılmama nedeni: " + (reasonText[s.reason] || s.reason || "Gerekli koşullar birlikte oluşmadı."));
    if (s.entryDistancePercent != null) lines.push("Fiyat-giriş mesafesi: " + s.entryDistancePercent + "%.");
    if (s.macdHistogram != null) lines.push("MACD histogramı: " + s.macdHistogram + ".");
  }

  lines.push("Geçmiş kazanma oranı: " + (s.historicalWinProbability || "UNAVAILABLE") + " · doğrulanmamış oran üretilmez.");
  lines.push("Bu açıklama sabit teknik kurallardan oluşturulur; yapay zekâ değildir, harici servise bağlanmaz ve ücretsizdir.");
  lines.push("RESEARCH_ONLY_NOT_TRADE_READY · Emir göndermez ve işlem kararını değiştirmez.");
  output.textContent = lines.join("\n");
}
async function loadBacktest() {
  const button = $("backtestBtn");
  const output = $("backtestResults");
  button.disabled = true;
  button.textContent = "Geri test çalışıyor…";
  output.textContent = "Tarihsel altın mumları analiz ediliyor…";
  try {
    const response = await fetchWithTimeout("/api/backtest", { cache: "no-store" }, 60000);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || "Geri test başarısız.");
    const periods = payload.results || [];
    output.innerHTML =
      '<p>Motor: ' + esc(payload.engine) + ' · Mum: ' + esc(payload.candleCount) +
      ' · Spread: ' + esc(payload.costModel && payload.costModel.spreadUSD) +
      ' · Kayma: işlem başına yön bazında $0.10 / $0.20 senaryoları</p>' +
      periods.map(period =>
        '<div class="backtest-row"><b>' + esc(period.period) + ' · Kayma/yan: ' + esc(period.slippagePerSideUSD) + '</b>' +
        '<span>İşlem: ' + esc(period.metrics.tradeCount) + '</span>' +
        '<span>WR: ' + (period.metrics.winRatePercent == null ? "—" : esc(period.metrics.winRatePercent) + "%") + '</span>' +
        '<span>PF: ' + esc(period.metrics.profitFactor) + '</span>' +
        '<span>Net: ' + esc(period.metrics.netProfitR) + 'R</span>' +
        '<span>DD: ' + esc(period.metrics.maxDrawdownR) + 'R</span>' +
        '<span>' + (period.metrics.insufficientSample ? "Örneklem yetersiz" : "30+ işlem") + '</span>' +
        '<span>' + (period.periodComplete ? "Dönem tamamlandı" : "Dönem sürüyor · açık işlem sayılmadı") + '</span></div>'
      ).join("") +
      '<p class="risk-note">Tüm altı maliyet/dönem kombinasyonu gösterilir. OHLC simülasyonudur; canlı kazanma olasılığı değildir. Gerçek bid/ask, spread, komisyon ve kayma doğrulanmamıştır. Tamamlanmamış dönemde açık işlemler sonuçlara dahil edilmez.</p>';
  } catch (error) {
    output.textContent = "Geri test alınamadı: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Tarihsel geri testi çalıştır";
  }
}
$("refreshBtn").addEventListener("click", () => loadSignal());
$("backtestBtn").addEventListener("click", loadBacktest);
$("aiAnalyzeBtn").addEventListener("click", loadFreeAnalysis);
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
