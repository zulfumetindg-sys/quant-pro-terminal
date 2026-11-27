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

  if (signal.signalId && signal.signalValidUntil) {
    const validUntil = new Date(signal.signalValidUntil);
    const validText = Number.isFinite(validUntil.getTime())
      ? validUntil.toLocaleString("tr-TR")
      : "DOĞRULANAMADI";
    html += '<p class="signal-muted">Sinyal kimliği: ' + esc(signal.signalId) +
      ' · Geçerlilik bitişi: ' + esc(validText) +
      ' · Aynı H1 mumunda yeni sinyal değildir.</p>';
  }

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
    renderManualJournal();
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

let journalToken = "";
let journalState = { trades: [], activeTradeId: "" };
try { journalToken = sessionStorage.getItem("quantProJournalToken") || ""; } catch (_) {}

function journalRequest(method, body) {
  if (!journalToken) throw new Error("Önce güvenli kayıt anahtarını gir.");
  return fetchWithTimeout("/api/manual-journal", {
    method,
    cache: "no-store",
    headers: { Authorization: "Bearer " + journalToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }, 15000).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const messages = {
        JOURNAL_STORAGE_NOT_CONFIGURED: "Sunucu veritabanı henüz yapılandırılmadı.",
        ACTIVE_TRADE_EXISTS: "Önce açık işlemi kapatmalısın.",
        SIGNAL_ALREADY_RECORDED: "Bu sinyal daha önce kaydedildi; tekrar açılamaz.",
        SIGNAL_EXPIRED_OR_INVALID: "Sinyalin süresi dolmuş veya geçerliliği doğrulanamıyor.",
        ACTUAL_FILL_RR_BELOW_1_8: "Gerçekleşen giriş fiyatında R:R 1:1,8 altında.",
        ACTUAL_FILL_TOO_FAR_FROM_SIGNAL: "Gerçekleşen fiyat sinyal referansından %0,10 üzerinde uzak; fiyat kovalanmadı.",
        TRADE_ID_NOT_ACTIVE: "Kapanış isteği açık işlem kimliğiyle eşleşmiyor.",
        PRICE_FIELDS_INVALID: "Sinyal veya gerçekleşen fiyat alanları geçersiz.",
        FILL_PRICE_OUTSIDE_RISK_LEVELS: "Giriş fiyatı SL/TP seviyelerinin dışında.",
        UNAUTHORIZED: "Kayıt anahtarı geçersiz."
      };
      const diagnosticMessages = {
        UPSTREAM_AUTH: "Veritabanı kimlik doğrulaması reddedildi. Upstash REST URL ve REST Token aynı veritabanından alınmalı.",
        UPSTREAM_COMMAND: "Veritabanı komutu reddedildi. Sunucu tarafındaki Redis komut uyumluluğu kontrol edilmeli.",
        UPSTREAM_RATE_LIMIT: "Veritabanı istek sınırına ulaşıldı. Bir süre sonra tekrar deneyin.",
        UPSTREAM_TIMEOUT: "Veritabanı zaman aşımına uğradı. Upstash bağlantısını kontrol edin.",
        UPSTREAM_NETWORK: "Sunucu veritabanına bağlanamıyor. Upstash REST bağlantısını kontrol edin.",
        UPSTREAM_INVALID_RESPONSE: "Veritabanından beklenmeyen yanıt geldi.",
        UPSTREAM_PROVIDER_ERROR: "Veritabanı sağlayıcısı isteği reddetti.",
        UPSTREAM_COMMAND_AUTH: "Veritabanı komutu için kimlik doğrulama reddedildi.",
        UPSTREAM_COMMAND_COMMAND: "Veritabanı komutu desteklenmiyor veya hatalı.",
        UPSTREAM_COMMAND_RATE_LIMIT: "Veritabanı istek sınırına ulaşıldı.",
        UPSTREAM_COMMAND_TIMEOUT: "Veritabanı komutu zaman aşımına uğradı.",
        UPSTREAM_COMMAND_PROVIDER_ERROR: "Veritabanı komutu sağlayıcı tarafından reddedildi."
      };
      throw new Error(
        messages[payload.error] ||
        diagnosticMessages[payload.diagnosticCode] ||
        payload.error ||
        "Kayıt isteği başarısız."
      );
    }
    return payload;
  });
}

function renderManualJournal() {
  const active = journalState.trades.find(x => x.tradeId === journalState.activeTradeId && x.status === "OPEN");
  $("journalOpenBtn").disabled = !journalToken || !latestSignal || !["BUY", "SELL"].includes(latestSignal.status);
  $("journalCloseBtn").disabled = !journalToken || !active;
  $("journalActive").innerHTML = active
    ? '<h3>Açık manuel işlem</h3><div class="journal-row"><b>' + esc(active.side) + ' · XAUUSD</b><span>Gerçek giriş: ' + esc(fmt(active.fillPrice)) + '</span><span>SL: ' + esc(fmt(active.stopLoss)) + '</span><span>TP: ' + esc(fmt(active.takeProfit)) + '</span><span>R:R: 1:' + esc(active.actualFillRiskReward) + '</span><span>Açılış: ' + esc(active.openedAt) + '</span></div>'
    : '<h3>Açık manuel işlem yok</h3><p>Yeni kayıt için geçerli AL/SAT sinyali beklenir.</p>';

  const history = [...journalState.trades].reverse();
  $("journalHistory").innerHTML = '<h3>Son manuel işlemler (' + history.length + ')</h3>' +
    (history.length ? history.slice(0, 30).map(trade =>
      '<div class="journal-row"><b>' + esc(trade.side) + ' · ' + esc(trade.status) + '</b>' +
      '<span>Giriş: ' + esc(fmt(trade.fillPrice)) + '</span>' +
      '<span>Çıkış: ' + esc(trade.exitPrice == null ? "—" : fmt(trade.exitPrice)) + '</span>' +
      '<span>Sonuç: ' + esc(trade.realizedR == null ? "Açık" : trade.realizedR + "R") + '</span>' +
      '<span>Başlangıç R:R: 1:' + esc(trade.actualFillRiskReward) + '</span></div>'
    ).join("") : '<p>Henüz kayıtlı manuel işlem yok.</p>');
}

async function loadManualJournal() {
  try {
    const payload = await journalRequest("GET");
    journalState = payload.state || { trades: [], activeTradeId: "" };
    renderManualJournal();
    $("journalStatus").textContent = "Güvenli veritabanına bağlandı · " + journalState.trades.length + " kayıt · sunucu tarafında saklanıyor.";
    $("journalStatus").className = "journal-status ok";
  } catch (error) {
    $("journalStatus").textContent = error.message;
    $("journalStatus").className = "journal-status bad";
  }
}

async function connectManualJournal() {
  const entered = $("journalToken").value.trim();
  if (entered.length >= 32) {
    journalToken = entered;
    try { sessionStorage.setItem("quantProJournalToken", journalToken); } catch (_) {}
  } else if (!journalToken) {
    $("journalStatus").textContent = "En az 32 karakterli sunucu kayıt anahtarını gir.";
    $("journalStatus").className = "journal-status bad";
    return;
  }
  await loadManualJournal();
}

async function recordManualOpen() {
  const fillPrice = Number($("journalFillPrice").value);
  if (!latestSignal || !["BUY", "SELL"].includes(latestSignal.status)) {
    $("journalStatus").textContent = "Kayıt için geçerli AL/SAT sinyali yok.";
    $("journalStatus").className = "journal-status bad";
    return;
  }
  try {
    const payload = await journalRequest("POST", { action: "open", signal: { ...latestSignal, symbol: "XAUUSD" }, fillPrice });
    journalState = payload.state;
    $("journalFillPrice").value = "";
    $("journalStatus").textContent = "Manuel açılış kaydı sunucuya kaydedildi.";
    $("journalStatus").className = "journal-status ok";
    renderManualJournal();
  } catch (error) {
    $("journalStatus").textContent = error.message;
    $("journalStatus").className = "journal-status bad";
  }
}

async function recordManualClose() {
  const active = journalState.trades.find(x => x.tradeId === journalState.activeTradeId && x.status === "OPEN");
  const exitPrice = Number($("journalExitPrice").value);
  if (!active) return;
  try {
    const payload = await journalRequest("POST", { action: "close", tradeId: active.tradeId, exitPrice });
    journalState = payload.state;
    $("journalExitPrice").value = "";
    $("journalStatus").textContent = "Manuel kapanış kaydı sunucuya kaydedildi. Maliyetler dahil değildir.";
    $("journalStatus").className = "journal-status ok";
    renderManualJournal();
  } catch (error) {
    $("journalStatus").textContent = error.message;
    $("journalStatus").className = "journal-status bad";
  }
}

$("journalConnectBtn").addEventListener("click", connectManualJournal);
$("journalOpenBtn").addEventListener("click", recordManualOpen);
$("journalCloseBtn").addEventListener("click", recordManualClose);
if (journalToken) {
  $("journalToken").value = journalToken;
  loadManualJournal();
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
