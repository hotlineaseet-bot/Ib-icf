const CACHE_NAME = 'dir-v1';
const AUDIO_CACHE = 'dir-audio-v1';

// Кэшируем основные файлы приложения
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(['/', '/index.html'])
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME && k !== AUDIO_CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Аудио файлы — кэшируем для офлайн воспроизведения
    if (url.pathname.match(/\.(mp3|ogg|wav|m4a|flac)$/i) ||
        url.hostname.includes('dropbox') ||
        url.hostname.includes('archive.org') ||
        url.hostname.includes('dl.dropboxusercontent')) {
        e.respondWith(
            caches.open(AUDIO_CACHE).then(async cache => {
                const cached = await cache.match(e.request);
                if (cached) return cached;
                try {
                    const response = await fetch(e.request);
                    if (response.ok) cache.put(e.request, response.clone());
                    return response;
                } catch {
                    return cached || new Response('Офлайн', { status: 503 });
                }
            })
        );
        return;
    }

    // API запросы — только сеть
    if (url.pathname.startsWith('/api/')) {
        e.respondWith(fetch(e.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
        return;
    }

    // Остальное — сеть с fallback на кэш
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});

// Сообщение от страницы — очистить аудио кэш
self.addEventListener('message', e => {
    if (e.data === 'clearAudioCache') {
        caches.delete(AUDIO_CACHE).then(() => {
            e.source.postMessage('audioCacheCleared');
        });
    }
    if (e.data === 'getAudioCacheSize') {
        caches.open(AUDIO_CACHE).then(async cache => {
            const keys = await cache.keys();
            e.source.postMessage({ type: 'audioCacheSize', count: keys.length });
        });
    }
});
