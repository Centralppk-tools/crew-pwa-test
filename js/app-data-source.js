/** Справочники PWA: S3 shedulemax-public (data/*), локальные файлы — только на 127.0.0.1. */
(function (global) {
    function cfg() {
        return global.APP_CONFIG?.sheduleMax || {};
    }

    function s3Base() {
        return String(cfg().s3BaseUrl || 'https://shedulemax-public.s3.cloud.ru').replace(/\/$/, '');
    }

    function useDirectS3() {
        return Boolean(s3Base()) && cfg().useDirectS3 !== false;
    }

    function isLocalDevHost() {
        const host = String(global.location?.hostname || '');
        return host === '127.0.0.1' || host === 'localhost';
    }

    function normalizeRelPath(path) {
        let rel = String(path || '').trim().replace(/^\.\//, '');
        if (rel === 'spr.json') return 'data/spr.json';
        if (!rel.startsWith('data/')) return `data/${rel}`;
        return rel;
    }

    function s3UrlForRel(relPath) {
        const key = normalizeRelPath(relPath);
        return `${s3Base()}/${key}`;
    }

    function urlsFor(localPath) {
        const rel = String(localPath || '').trim();
        const urls = [];
        if (useDirectS3()) {
            urls.push(s3UrlForRel(rel));
        }
        if (isLocalDevHost()) {
            const local = rel.startsWith('./') || rel.startsWith('/') ? rel : `./${rel}`;
            urls.push(local);
        }
        return urls.length ? urls : [rel];
    }

    function resolveAssetUrl(relOrAbs) {
        const raw = String(relOrAbs || '').trim();
        if (!raw || /^https?:\/\//i.test(raw)) return raw;
        const rel = raw.replace(/^\.\//, '');
        if (useDirectS3()) return s3UrlForRel(rel);
        return raw.startsWith('./') ? raw : `./${rel}`;
    }

    async function fetchJson(localPath, options = {}) {
        const bust = options.cacheBust === true;
        const candidates = urlsFor(localPath);
        let lastError = null;
        for (const url of candidates) {
            const fetchUrl = bust ? `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}` : url;
            try {
                const res = await fetch(fetchUrl, { cache: 'no-store' });
                if (!res.ok) {
                    lastError = new Error(`HTTP ${res.status} для ${fetchUrl}`);
                    continue;
                }
                const text = await res.text();
                if (!text.trim()) {
                    lastError = new Error(`Пустой ответ: ${fetchUrl}`);
                    continue;
                }
                return JSON.parse(text);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error(`Не удалось загрузить ${localPath}`);
    }

    global.AppDataSource = {
        s3Base,
        useDirectS3,
        isLocalDevHost,
        urlsFor,
        resolveAssetUrl,
        fetchJson,
        s3UrlForRel,
    };
})(window);
