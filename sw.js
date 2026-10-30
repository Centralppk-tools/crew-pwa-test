// Stage/test PWA — изолированный кэш (не пересекается с digital_assistant_* на боевых устройствах)
const CACHE_NAME = 'crew-stage-cache-v1';
const NOTIFICATION_ICON = './assets/app-icon.png';

const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './styles/tokens.css',
    './styles/base.css',
    './styles/routes.css',
    './styles/schedule.css',
    './styles/calendar.css',
    './styles/profile.css',
    './styles/responsive.css',
    './styles/auth.css',
    './styles/community.css',
    './styles/instructions.css',
    './data/trains-uids.json',
    './data/release-notes.json',
    './js/app-config.js',
    './js/schedule-maintenance.js',
    './js/hard-reset-app.js',
    './js/app-data-source.js',
    './js/train-motion-timer.js',
    './js/shedule-max-source.js',
    './js/info-chip.js',
    './js/instructions.js',
    './js/profile-compliance.js',
    './vendor/pdfjs/pdf.min.mjs',
    './vendor/pdfjs/pdf.worker.min.mjs',
    './vendor/pdfjs/pdf.worker.mjs',
    './assets/brand-logo.png',
    './assets/app-icon.png',
    './assets/wall-icons/doc.svg',
    './assets/wall-icons/hammer.svg',
    './assets/wall-icons/delete.svg',
    './.nojekyll'
];

function isPrecachePath(pathname) {
    return PRECACHE_ASSETS.some((asset) => {
        const cleanAsset = asset.replace(/^\.\//, '');
        return pathname.endsWith(cleanAsset) || (cleanAsset === 'index.html' && pathname.endsWith('/'));
    });
}

async function precacheAssets(cache) {
    await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
                console.warn(`[sw] пропуск прекэша ${url}:`, err);
            })
        )
    );
}

async function matchNavigationFallback(cache) {
    return cache.match('./index.html')
        || cache.match('index.html')
        || cache.match('./')
        || cache.match('/');
}

async function matchCachedRequest(cache, request) {
    const direct = await cache.match(request);
    if (direct) return direct;

    const url = new URL(request.url);
    const path = url.pathname;
    const fileName = path.split('/').pop() || '';

    if (fileName) {
        const byName = await cache.match(`./${fileName}`) || await cache.match(fileName);
        if (byName) return byName;
    }

    if (request.mode === 'navigate' || path.endsWith('/')) {
        return matchNavigationFallback(cache);
    }

    return null;
}

function revalidateInBackground(cache, request) {
    fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone());
            }
        })
        .catch(() => {});
}

function isAppShellRequest(pathname, mode) {
    if (mode === 'navigate') return true;
    return pathname.endsWith('/index.html') || pathname.endsWith('index.html');
}

function isReleaseNotesRequest(pathname) {
    return pathname.endsWith('/data/release-notes.json') || pathname.endsWith('release-notes.json');
}

function isTrainUidsRequest(pathname) {
    return pathname.endsWith('/data/trains-uids.json') || pathname.endsWith('trains-uids.json');
}

/** Конфиг прокси — всегда из сети (не cache-first), иначе залипает старый workers.dev */
function isAppConfigRequest(pathname) {
    return pathname.endsWith('/js/app-config.js') || pathname.endsWith('app-config.js');
}

function isScheduleMaintenanceRequest(pathname) {
    return pathname.endsWith('/js/schedule-maintenance.js') || pathname.endsWith('schedule-maintenance.js');
}

/** Модуль «Инструкции» — network-first, иначе залипают старые иконки/стили после правок */
function isInstructionsModuleRequest(pathname) {
    return pathname.endsWith('/js/instructions.js')
        || pathname.endsWith('instructions.js')
        || pathname.endsWith('/styles/instructions.css')
        || pathname.endsWith('instructions.css')
        || pathname.endsWith('/styles/tokens.css')
        || pathname.endsWith('tokens.css')
        || pathname.includes('/assets/wall-icons/');
}

/** Личный кабинет — network-first (плановые события, должность) */
function isProfileModuleRequest(pathname) {
    return pathname.endsWith('/js/profile-compliance.js')
        || pathname.endsWith('profile-compliance.js')
        || pathname.endsWith('/styles/profile.css')
        || pathname.endsWith('profile.css');
}

/** Расписание ЦППК — network-first, иначе залипает старый код (8792, daily doc) */
function isSheduleMaxModuleRequest(pathname) {
    return pathname.endsWith('/js/shedule-max-source.js')
        || pathname.endsWith('shedule-max-source.js');
}

function isCrewApiClientRequest(pathname) {
    return pathname.endsWith('/js/crew-api-client.js')
        || pathname.endsWith('crew-api-client.js');
}

function isDaAuthSessionRequest(pathname) {
    return pathname.endsWith('/js/da-auth-session.js')
        || pathname.endsWith('da-auth-session.js');
}

function isSyncUserIdModuleRequest(pathname) {
    return pathname.endsWith('/js/sync-user-id.js')
        || pathname.endsWith('sync-user-id.js');
}

/** Маршруты — network-first, иначе залипают pending-карточки и routes.css */
function isRoutesModuleRequest(pathname) {
    return pathname.endsWith('/styles/routes.css')
        || pathname.endsWith('routes.css');
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await matchCachedRequest(cache, request);
        if (cached) return cached;
        throw err;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await matchCachedRequest(cache, request);

    if (cached) {
        revalidateInBackground(cache, request);
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const fallback = await matchCachedRequest(cache, request);
        if (fallback) return fallback;
        throw err;
    }
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => precacheAssets(cache))
            .catch((err) => console.warn('[sw] прекэш отклонён из-за отсутствия файлов:', err))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

async function showScheduleSystemNotification(payload = {}) {
    const title = String(payload.title || 'Цифровой помощник').trim();
    const kicker = String(payload.kicker || '').trim();
    const bodyText = String(payload.body || '').trim();
    const body = [kicker, bodyText].filter(Boolean).join(' — ') || title;
    const tag = String(payload.tag || payload.key || 'schedule-alert').trim();

    await self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
        vibrate: [140, 70, 140],
        requireInteraction: true,
        silent: false,
        data: {
            key: tag,
            url: './',
            screen: 'schedule'
        }
    });
}

function parseWebPushPayload(event) {
    if (!event?.data) return {};
    try {
        return event.data.json();
    } catch {
        try {
            const text = event.data.text();
            return text ? JSON.parse(text) : {};
        } catch {
            return {};
        }
    }
}

async function handleIncomingWebPush(event) {
    const payload = parseWebPushPayload(event);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleClient = clients.find((client) => client.visibilityState === 'visible');

    if (visibleClient) {
        visibleClient.postMessage({
            type: 'REMOTE_SCHEDULE_NOTIFICATION',
            payload
        });
        return;
    }

    await showScheduleSystemNotification(payload);
}

self.addEventListener('push', (event) => {
    event.waitUntil(
        handleIncomingWebPush(event)
            .catch((err) => console.warn('[sw] web push failed:', err))
    );
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    if (data.type === 'SHOW_SCHEDULE_NOTIFICATION') {
        event.waitUntil(
            showScheduleSystemNotification(data.payload || {})
                .catch((err) => console.warn('[sw] schedule notification failed:', err))
        );
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) {
                    return self.clients.openWindow(targetUrl);
                }
                return null;
            })
    );
});

function isSheduleMaxDataRequest(url) {
    const host = String(url.hostname || '');
    const path = String(url.pathname || '');
    if (host.endsWith('s3.cloud.ru') && /cache_(schedule|stops)|cppk_export\/stops/.test(path)) return true;
    return false;
}

/** API на том же origin — только сеть, без CacheStorage */
function isSameOriginApiRequest(url) {
    return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin === self.location.origin && isSameOriginApiRequest(url)) {
        event.respondWith(fetch(request));
        return;
    }
    if (isSheduleMaxDataRequest(url)) {
        event.respondWith(networkFirst(request));
        return;
    }
    if (url.origin !== self.location.origin) return;

    if (isAppConfigRequest(url.pathname) || isScheduleMaintenanceRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isInstructionsModuleRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isProfileModuleRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isSheduleMaxModuleRequest(url.pathname)
        || isCrewApiClientRequest(url.pathname)
        || isDaAuthSessionRequest(url.pathname)
        || isSyncUserIdModuleRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isRoutesModuleRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isReleaseNotesRequest(url.pathname) || isTrainUidsRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isAppShellRequest(url.pathname, request.mode)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (isPrecachePath(url.pathname)) {
        event.respondWith(cacheFirst(request));
    }
});
