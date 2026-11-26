const MARKETS = [
 {symbol:"EURUSD",name:"Euro / US Dollar",group:"FX",digits:5},
 {symbol:"GBPUSD",name:"British Pound / US Dollar",group:"FX",digits:5},
 {symbol:"USDJPY",name:"US Dollar / Japanese Yen",group:"FX",digits:3},
 {symbol:"USDTRY",name:"US Dollar / Turkish Lira",group:"FX",digits:4},
 {symbol:"XAUUSD",name:"Gold / US Dollar",group:"METAL",digits:2},
 {symbol:"XAGUSD",name:"Silver / US Dollar",group:"METAL",digits:3},
 {symbol:"NAS100",name:"Nasdaq 100",group:"INDEX",digits:2},
 {symbol:"DAX40",name:"Germany 40",group:"INDEX",digits:2}
];
const grid=document.getElementById("marketGrid");
let activeFilter="ALL",latestData={},latestSignal=null;
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function render(){
 const items=MARKETS.filter(m=>activeFilter==="ALL"||m.group===activeFilter);
 grid.innerHTML=items.map(m=>{
  const d=latestData[m.symbol],good=d&&d.status==="ok"&&Number.isFinite(Number(d.price));
  const price=good?'<div class="price live">'+Number(d.price).toLocaleString("en-US",{maximumFractionDigits:m.digits})+'</div><div class="price-stamp">Twelve Data · '+esc(d.timestamp)+'</div>':'<div class="price">— — —</div><div class="price-note">'+esc(d&&d.error?d.error:"Canlı fiyat bekleniyor")+'</div>';
  return '<article class="market-card"><div class="market-top"><div><div class="symbol">'+m.symbol+'</div><div class="category">'+m.group+" · "+m.name+'</div></div><span class="signal-none">WATCH</span></div>'+price+'<div class="card-divider"></div><div class="timeframes"><div class="tf"><span>H1 TREND</span><b>—</b></div><div class="tf"><span>H4 TREND</span><b>—</b></div></div><div class="card-bottom"><span>Yalnızca izleme</span><b>—</b></div></article>';
 }).join("");
}
function notice(type,title,message){const n=document.getElementById("connectionNotice");n.className="notice "+(type||"");document.getElementById("connectionTitle").textContent=title;document.getElementById("connectionText").textContent=message;}
function fmt(v){return Number.isFinite(Number(v))?Number(v).toFixed(2):"—";}
function renderSignal(s){
 const box=document.getElementById("goldSignal");
 if(!s){box.innerHTML='<p class="signal-muted">Sinyal verisi henüz alınmadı.</p>';return;}
 const side=s.status||"WAIT",label=side==="BUY"?"AL":side==="SELL"?"SAT":"İŞLEM YOK";
 let html='<div class="signal-top"><span class="signal-side '+(side==="BUY"?"buy":side==="SELL"?"sell":"wait")+'">'+label+'</span><span class="signal-muted">H1 + tamamlanmış H4</span></div>';
 html+='<div class="signal-grid"><div><small>Canlı fiyat</small><b>'+fmt(s.currentPrice)+'</b></div><div><small>Giriş referansı</small><b>'+fmt(s.entry)+'</b></div><div><small>Stop loss</small><b>'+fmt(s.sl)+'</b></div><div><small>Take profit</small><b>'+fmt(s.tp)+'</b></div><div><small>R:R</small><b>'+esc(s.riskReward||"—")+'</b></div><div><small>Giriş uzaklığı</small><b>'+(s.entryDistancePercent==null?"—":s.entryDistancePercent+"%")+'</b></div><div><small>Tarihsel kazanma oranı</small><b>'+esc(s.historicalWinProbability||"UNAVAILABLE")+'</b></div><div><small>H1 / H4 yönü</small><b>'+esc((s.h1Trend||"—")+" / "+(s.h4Trend||"—"))+'</b></div></div>';
 html+='<p class="signal-muted">'+esc(s.reason||s.entryModelWarning||"Sinyal koşulları kontrol edildi.")+'</p><p class="risk-note">Durum: RESEARCH_ONLY_NOT_TRADE_READY. Bu panel emir göndermez. Bağımsız doğrulama olmadığı için tarihsel kazanma olasılığı verilmez.</p>';
 box.innerHTML=html;
}
async function loadMarket(){
 const btn=document.getElementById("refreshBtn");btn.disabled=true;btn.textContent="Yükleniyor…";
 try{const r=await fetch("/api/market-data",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Piyasa verisi alınamadı");latestData=p.data||{};render();document.querySelector(".connection").innerHTML="<i></i> VERİ KONTROL EDİLDİ";notice("ok","Piyasa veri servisi yanıt verdi","Başarılı sembol: "+(p.successCount||0)+" / 6. Altın sinyali ayrı olarak hesaplanır.");}
 catch(e){notice("bad","Piyasa verisi alınamadı",e.message);}finally{btn.disabled=false;btn.textContent="↻ Yenile";}
}
async function loadSignal(){
 const btn=document.getElementById("signalBtn");btn.disabled=true;btn.textContent="Altın analizi yükleniyor…";
 try{const r=await fetch("/api/signal-engine",{cache:"no-store"}),p=await r.json();if(!r.ok||!p.ok)throw new Error(p.message||p.error||"Sinyal hesaplanamadı");latestSignal=p.signal;renderSignal(latestSignal);document.getElementById("signalMeta").textContent="Son hesaplama: "+(p.generatedAt||"—")+" · "+p.candleCount+" H1 mum / "+p.completedH4Count+" H4 mum";}
 catch(e){document.getElementById("goldSignal").innerHTML='<p class="signal-error">'+esc(e.message)+'</p>';document.getElementById("signalMeta").textContent="Veri alınamadı";}
 finally{btn.disabled=false;btn.textContent="Altın sinyalini yenile";}
}
async function loadBacktest(){
 const btn=document.getElementById("backtestBtn"),out=document.getElementById("backtestResults");btn.disabled=true;btn.textContent="Geri test çalışıyor…";out.textContent="Tarihsel mumlar analiz ediliyor…";
 try{const r=await fetch("/api/backtest",{cache:"no-store"}),p=await r.json();if(!r.ok||!p.ok)throw new Error(p.message||p.error||"Geri test başarısız");const rows=(p.conservativeSummary&&p.conservativeSummary.periods)||[];
 out.innerHTML='<p>Motor: '+esc(p.engine)+' · Mum: '+p.candleCount+' · Spread: $'+p.costModel.spreadUSD+' · Kayma/yön: $0.20</p>'+rows.map(x=>'<div class="backtest-row"><b>'+esc(x.period)+'</b><span>İşlem: '+x.metrics.tradeCount+'</span><span>WR: '+(x.metrics.winRatePercent==null?"—":x.metrics.winRatePercent+"%")+'</span><span>PF: '+esc(x.metrics.profitFactor)+'</span><span>Net: '+x.metrics.netProfitR+'R</span><span>DD: '+x.metrics.maxDrawdownR+'R</span></div>').join("")+'<p class="risk-note">Tarihsel OHLC simülasyonudur; canlı sinyal kazanma olasılığı değildir. XM gerçek maliyetleri doğrulanmamıştır.</p>';}
 catch(e){out.textContent="Geri test alınamadı: "+e.message;}finally{btn.disabled=false;btn.textContent="Tarihsel geri testi çalıştır";}
}
document.querySelectorAll(".filter").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".filter").forEach(b=>b.classList.remove("active"));btn.classList.add("active");activeFilter=btn.dataset.filter;render();}));
document.getElementById("connectBtn").addEventListener("click",async()=>{
 const b=document.getElementById("connectBtn");b.disabled=true;b.textContent="Bağlantı test ediliyor…";
 try{const r=await fetch("/api/provider-status",{cache:"no-store"}),p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||"Bağlantı testi başarısız");notice("ok","Twelve Data API anahtarı algılandı","Sunucu API anahtarını doğruladı. Fiyat ve sinyal yenileniyor.");await loadMarket();await loadSignal();}
 catch(e){notice("bad","Twelve Data bağlantısı başarısız",e.message);}finally{b.disabled=false;b.textContent="Veri bağlantısını test et";}
});
document.getElementById("refreshBtn").addEventListener("click",()=>{loadMarket();loadSignal();});
document.getElementById("signalBtn").addEventListener("click",loadSignal);
document.getElementById("backtestBtn").addEventListener("click",loadBacktest);
let installPrompt;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;document.getElementById("installBtn").hidden=false;});
document.getElementById("installBtn").addEventListener("click",async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;document.getElementById("installBtn").hidden=true;});
if("serviceWorker"in navigator&&location.protocol.startsWith("http"))window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
render();loadMarket();loadSignal();
