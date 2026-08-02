const CACHE_NAME = 'giuseppe-apps-v8';
const ASSETS = [
  './index.html',
  './pontos-interesse.html',
  './financeiro-veiculos-1.html',
  './agenda.html',
  './Perito.html',
  './vistoria.html',
  './manifest.webmanifest',
  './manifest-perito.webmanifest',
  './manifest-vistoria.webmanifest',
  './icon-perito.svg',
  './icon-vistoria.svg'
];
self.addEventListener('install',function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(function(c){return c.addAll(ASSETS).catch(function(){});}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(ns){
      return Promise.all(ns.map(function(n){return caches.delete(n);}));
    })
  );
  self.clients.claim();
});
self.addEventListener('fetch',function(e){
  e.respondWith(
    fetch(e.request).then(function(r){
      if(r&&r.status===200&&e.request.method==='GET'){
        var cl=r.clone();
        caches.open(CACHE_NAME).then(function(c){c.put(e.request,cl);});
      }
      return r;
    }).catch(function(){
      return caches.match(e.request);
    })
  );
});
