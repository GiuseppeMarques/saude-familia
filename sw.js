const CACHE_NAME = 'giuseppe-apps-v6';
const ASSETS = [
  './index.html',
  './pontos-interesse.html',
  './financeiro-veiculos-1.html',
  './agenda.html',
  './Perito.html',
  './vistoria.html',
  './manifest.webmanifest'
];
self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(caches.open(CACHE_NAME).then(function(c){return c.addAll(ASSETS).catch(function(){});}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ns){return Promise.all(ns.filter(function(n){return n!==CACHE_NAME;}).map(function(n){return caches.delete(n);}));}));self.clients.claim();});
self.addEventListener('fetch',function(e){e.respondWith(caches.match(e.request).then(function(cached){if(cached)return cached;return fetch(e.request).then(function(r){if(r&&r.status===200&&e.request.method==='GET'){var cl=r.clone();caches.open(CACHE_NAME).then(function(c){c.put(e.request,cl);});}return r;}).catch(function(){return cached;});}));});
