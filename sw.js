const CACHE="quant-pro-v0-8-20";
const ASSETS=["./","./index.html","./styles.css","./app.js","./forward-archive.js","./manifest.webmanifest","./icon.svg"];
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
