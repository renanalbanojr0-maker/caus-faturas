const CACHE_NAME = 'caus-faturas-v1';
const ARQUIVOS = [
  '/',
  '/index.html',
  '/calculadora-nf.html',
  '/produtos.js',
  '/clientes.js',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Sora:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
];

// Instala e faz cache dos arquivos principais
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Fazendo cache dos arquivos...');
      return Promise.allSettled(
        ARQUIVOS.map(url => cache.add(url).catch(e => console.warn('[SW] Não cacheou:', url)))
      );
    }).then(() => self.skipWaiting())
  );
});

// Ativa e limpa caches antigos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Intercepta requisições
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Socket.io e APIs — nunca cachear, sempre rede
  if(url.pathname.startsWith('/socket.io') ||
     url.pathname.startsWith('/tiny-api') ||
     url.pathname.startsWith('/historico-prec') ||
     url.pathname.startsWith('/salvar-pdf-nf') ||
     url.pathname.startsWith('/ping')) {
    return; // deixa passar normalmente
  }

  // Arquivos estáticos — cache primeiro, rede como fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(response => {
        if(response && response.status === 200 && response.type === 'basic'){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline — retorna cache se disponível
        return caches.match('/index.html');
      });
    })
  );
});
