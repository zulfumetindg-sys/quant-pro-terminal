const CACHE="quant-pro-v0-8-22";
const ASSETS=["./","./index.html","./styles.css","./app.js","./forward-archive.js","./signal-notification-policy.js","./manifest.webmanifest","./icon.svg"];
self.addEventListener("install",event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 await cache.addAll(ASSETS);
 await self.skipWaiting();
})()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{
 const keys=await caches.keys();
 await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));
 await self.clients.claim();
})()));
self.addEventListener("fetch",event=>{
 const request=event.request;
 if(request.method!=="GET")return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith("/api/")) {
  event.respondWith(fetch(request,{cache:"no-store"}));
  return;
 }
 if(request.mode==="navigate") {
  event.respondWith(fetch(request,{cache:"no-store"}).catch(()=>caches.match("./index.html")));
  return;
 }
 event.respondWith((async()=>{
  const cached=await caches.match(request);
  if(cached)return cached;
  const response=await fetch(request);
  if(response.ok){const cache=await caches.open(CACHE);cache.put(request,response.clone());}
  return response;
 })());
});

self.addEventListener("notificationclick",event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const target=new URL(event.notification.data&&event.notification.data.url||"./",self.location.href).href;
  const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const client of windows){
   if("focus" in client){await client.focus();if("navigate" in client)await client.navigate(target);return;}
  }
  if(self.clients.openWindow)await self.clients.openWindow(target);
 })());
});

self.addEventListener("push",event=>{
 event.waitUntil((async()=>{
  let payload={};
  try{payload=event.data?event.data.json():{};}catch(_){}
  const title=typeof payload.title==="string"?payload.title:"QUANT PRO · XAUUSD";
  const requestedUrl=payload.data&&typeof payload.data.url==="string"?payload.data.url:"./";
  const safeUrl=requestedUrl.startsWith("/")&&!requestedUrl.startsWith("//")?requestedUrl:"./";
  const options={
   body:typeof payload.body==="string"?payload.body:"Yeni piyasa bildirimi. Fiyatı uygulamada yeniden doğrula.",
   tag:typeof payload.tag==="string"?payload.tag:"quant-pro-market-update",
   renotify:false,
   data:{url:safeUrl}
  };
  await self.registration.showNotification(title,options);
 })());
});
