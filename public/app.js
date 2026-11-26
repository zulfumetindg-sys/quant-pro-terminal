
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
let activeFilter="ALL";
let latestData={};

function escapeHtml(v){
  return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function render(){
  const items=MARKETS.filter(m=>activeFilter==="ALL"||m.group===activeFilter);
  grid.innerHTML=items.map(m=>{
    const d=latestData[m.symbol];
    const price=d?.price
      ? `<div class="price live">${Number(d.price).toLocaleString("en-US",{maximumFractionDigits:m.digits})}</div><div class="price-stamp">Kaynak: Twelve Data · ${escapeHtml(d.timestamp||"")}</div>`
      : `<div class="price">— — —</div><div class="price-note">Canlı fiyat bekleniyor</div>`;
    return `<article class="market-card">
      <div class="market-top"><div><div class="symbol">${m.symbol}</div><div class="category">${m.group} · ${m.name}</div></div><span class="signal-none">NONE</span></div>
      ${price}
      <div class="card-divider"></div>
      <div class="timeframes"><div class="tf"><span>H1 TREND</span><b>HENÜZ HESAPLANMADI</b></div><div class="tf"><span>H4 TREND</span><b>HENÜZ HESAPLANMADI</b></div></div>
      <div class="card-bottom"><span>RSI: —</span><b>ATR: —</b></div>
    </article>`;
  }).join("");
}

render();

document.querySelectorAll(".filter").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".filter").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  activeFilter=btn.dataset.filter;
  render();
}));

function setNotice(type,title,message){
  const n=document.getElementById("connectionNotice");
  n.className="notice "+(type||"");
  document.getElementById("connectionTitle").textContent=title;
  document.getElementById("connectionText").textContent=message;
}

async function loadMarket(){
  const btn=document.getElementById("refreshBtn");
  btn.disabled=true;
  btn.innerHTML="<span>↻</span> Yükleniyor";
  try{
    const response=await fetch("/api/market-data",{headers:{"Accept":"application/json"}});
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||"Piyasa verisi alınamadı.");
    latestData=payload.data||{};
    render();
    document.querySelector(".connection").innerHTML="<i></i> CANLI VERİ";
    setNotice("ok","Twelve Data bağlantısı çalışıyor",`Fiyat verisi alındı. Son kontrol: ${payload.checkedAt||"—"}. Sinyal motoru henüz devrede değil.`);
  }catch(err){
    setNotice("bad","Veri bağlantısı başarısız",err.message);
  }finally{
    btn.disabled=false;
    btn.innerHTML="<span>↻</span> Yenile";
  }
}

async function testConnection(){
  const btn=document.getElementById("connectBtn");
  btn.disabled=true;
  btn.textContent="Bağlantı test ediliyor…";
  try{
    const r=await fetch("/api/provider-status",{headers:{"Accept":"application/json"}});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||"Bağlantı testi başarısız.");
    setNotice("ok","Twelve Data API anahtarı algılandı","Sunucu anahtarı görüyor. Sembol eşleştirmesi ve fiyat testi için Yenile'ye basın.");
    await loadMarket();
  }catch(e){
    setNotice("bad","Twelve Data bağlantısı hazır değil",e.message);
  }finally{
    btn.disabled=false;
    btn.textContent="Veri bağlantısını test et";
  }
}

document.getElementById("connectBtn").addEventListener("click",testConnection);
document.getElementById("refreshBtn").addEventListener("click",loadMarket);

let installPrompt;

window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  installPrompt=e;
  document.getElementById("installBtn").hidden=false;
});

document.getElementById("installBtn").addEventListener("click",async()=>{
  if(!installPrompt)return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt=null;
  document.getElementById("installBtn").hidden=true;
});

if("serviceWorker"in navigator&&location.protocol.startsWith("http")){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
