const CACHE_NAME = 'giuseppe-apps-v3';
const ASSETS = [
  './index.html',
  './pontos-interesse.html',
  './financeiro-veiculos-1.html',
  './agenda-2.html',
  './Perito_3.html',
  './vistoria_5.html',
  './manifest.webmanifest'
];

self.addEventListener('install', function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(ASSETS).catch(function(err){ console.log('Cache erro:', err); });
    })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(
        names.filter(function(n){ return n !== CACHE_NAME; })
             .map(function(n){ return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event){
  event.respondWith(
    caches.match(event.request).then(function(cached){
      if(cached) return cached;
      return fetch(event.request).then(function(response){
        if(response && response.status===200 && event.request.method==='GET'){
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, clone); });
        }
        return response;
      }).catch(function(){
        return cached;
      });
    })
  );
});
