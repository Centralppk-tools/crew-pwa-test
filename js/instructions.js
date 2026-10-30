/**
 * Модуль «Инструкции» — файловый менеджер + поиск по тексту + PDF-просмотр.
 * Загрузка: только PDF (accept в HTML: application/pdf,.pdf). Текст — pdf.js textContent, без OCR.
 */
(function () {
    'use strict';

    const DB_NAME = 'da_instructions_v1';
    const DB_VERSION = 1;
    const PDFJS_URL = new URL('vendor/pdfjs/pdf.min.mjs', window.location.href).href;
    const PDFJS_WORKER = new URL('vendor/pdfjs/pdf.worker.min.mjs', window.location.href).href;
    const SYSTEM_FOLDER_IDS = ['pte', 'reglamenty', 'tra'];
    const MIN_PAGE_CHARS = 40;
    const DIGITIZE_MSG = 'Текст не распознан, воспользуйтесь сервисом оцифровки и обновите информацию';

    const STOP_WORDS = new Set([
        'в', 'на', 'по', 'и', 'с', 'для', 'при', 'от', 'к', 'а', 'но', 'или', 'из', 'у', 'о', 'об',
        'во', 'со', 'же', 'ли', 'бы', 'то', 'что', 'как', 'это', 'не', 'до', 'за', 'под', 'над',
        'без', 'про', 'через', 'между', 'после', 'перед', 'ещё', 'еще', 'уже', 'только', 'также'
    ]);

    let dbPromise = null;
    let pdfjsLib = null;
    let pdfjsLoading = null;
    let activeFolderId = null;
    let uiBound = false;
    let searchDebounceTimer = null;
    let lastFileHits = [];
    let dragDocId = null;
    let suppressDocClick = false;
    let itemMenuHoldUntil = 0;
    let staticPack = {
        ready: false,
        folders: [],
        documents: [],
        chunks: []
    };

    /** @type {null | {
     *   doc: object,
     *   pdf: object,
     *   pageNum: number,
     *   totalPages: number,
     *   rendering: boolean,
     *   gen: number,
     *   pageTexts: string[],
     *   findQuery: string,
     *   findMatches: Array<{page: number, start: number, end: number}>,
     *   findIndex: number,
     *   highlightQuery: string,
     *   resizeObs: ResizeObserver | null,
     *   renderTask: object | null,
     *   touchStartX: number,
     *   touchStartY: number,
     *   _resizeTimer: number,
     *   _scrubTimer: number
     * }} */
    let viewer = null;

    function uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatBytes(size) {
        const n = Number(size) || 0;
        if (n < 1024) return `${n} Б`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
        return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
    }

    function formatDate(ts) {
        try {
            return new Date(ts).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });
        } catch (_) {
            return '';
        }
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function $(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        const el = $('instrStatus');
        if (el) el.textContent = text || '';
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('folders')) {
                    db.createObjectStore('folders', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('documents')) {
                    const docs = db.createObjectStore('documents', { keyPath: 'id' });
                    docs.createIndex('byFolder', 'folderId', { unique: false });
                }
                if (!db.objectStoreNames.contains('chunks')) {
                    const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
                    chunks.createIndex('byDoc', 'docId', { unique: false });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('chats')) {
                    db.createObjectStore('chats', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        });
        return dbPromise;
    }

    function idbReq(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function withStore(storeName, mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('tx error'));
            tx.onabort = () => reject(tx.error || new Error('tx aborted'));
            try {
                Promise.resolve(fn(store))
                    .then((value) => {
                        result = value;
                    })
                    .catch(reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    async function getAll(storeName) {
        return withStore(storeName, 'readonly', (store) => idbReq(store.getAll()));
    }

    async function putItem(storeName, value) {
        return withStore(storeName, 'readwrite', (store) => idbReq(store.put(value)));
    }

    async function deleteItem(storeName, key) {
        return withStore(storeName, 'readwrite', (store) => idbReq(store.delete(key)));
    }

    async function getItem(storeName, key) {
        return withStore(storeName, 'readonly', (store) => idbReq(store.get(key)));
    }

    async function migrateRemoveSystemFolders() {
        const done = await getItem('meta', 'systemFoldersRemoved');
        if (done?.value) return;

        for (const id of SYSTEM_FOLDER_IDS) {
            await deleteItem('folders', id).catch(() => {});
        }

        const docs = await getAll('documents');
        for (const doc of docs) {
            if (SYSTEM_FOLDER_IDS.includes(doc.folderId)) {
                doc.folderId = null;
                await putItem('documents', doc);
            }
        }

        await putItem('meta', { key: 'systemFoldersRemoved', value: true });
        await putItem('meta', { key: 'foldersSeeded', value: true });
    }

    async function getOpfsRoot() {
        if (!navigator.storage?.getDirectory) return null;
        try {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle('da_instructions', { create: true });
        } catch (_) {
            return null;
        }
    }

    async function saveBlob(docId, blob) {
        const dir = await getOpfsRoot();
        if (dir) {
            try {
                const handle = await dir.getFileHandle(`${docId}.bin`, { create: true });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return { storage: 'opfs', path: `${docId}.bin` };
            } catch (_) {
                /* fall through */
            }
        }
        await putItem('blobs', { id: docId, blob });
        return { storage: 'idb', path: docId };
    }

    async function loadBlob(doc) {
        if (doc?.source === 'static' || doc?.storage === 'static') {
            const rel = String(doc.pdfPath || '').replace(/^\.\//, '');
            if (!rel) return null;
            const pdfUrl = window.AppDataSource?.resolveAssetUrl?.(rel) || `./${rel}`;
            const res = await fetch(pdfUrl, { cache: 'no-store' });
            if (!res.ok) return null;
            return res.blob();
        }
        if (doc.storage === 'opfs') {
            const dir = await getOpfsRoot();
            if (dir) {
                try {
                    const handle = await dir.getFileHandle(doc.path || `${doc.id}.bin`);
                    return handle.getFile();
                } catch (_) {
                    /* fall through */
                }
            }
        }
        const row = await getItem('blobs', doc.id);
        return row?.blob || null;
    }

    async function resolveDocument(docId) {
        const id = String(docId || '');
        if (id.startsWith('static_')) {
            return staticPack.documents.find((d) => d.id === id) || null;
        }
        return getItem('documents', id);
    }

    async function resolveFolder(folderId) {
        const id = String(folderId || '');
        if (id.startsWith('static_')) {
            return staticPack.folders.find((f) => f.id === id) || null;
        }
        return getItem('folders', id);
    }

    async function loadStaticInstructionsPack() {
        staticPack = { ready: false, folders: [], documents: [], chunks: [] };
        try {
            const catalogUrls = window.AppDataSource?.urlsFor?.('./data/instructions/catalog.json')
                || ['./data/instructions/catalog.json'];

            let catalog = null;
            for (const url of catalogUrls) {
                try {
                    const res = await fetch(url, { cache: 'no-store' });
                    if (!res.ok) continue;
                    catalog = await res.json();
                    break;
                } catch (_) { /* next */ }
            }
            if (!catalog) {
                staticPack.ready = true;
                return;
            }
            staticPack.folders = (catalog.folders || []).map((f, idx) => ({
                id: `static_${f.id}`,
                staticId: f.id,
                name: f.name,
                order: f.order ?? idx,
                parentId: f.parentId ? `static_${f.parentId}` : null,
                source: 'static'
            }));

            for (const d of catalog.documents || []) {
                const pathRel = d.filePath || d.pdfPath || `data/instructions/pdf/${d.id}.pdf`;
                const kind = d.kind || (/\.xlsx$/i.test(pathRel) ? 'xlsx' : /\.docx$/i.test(pathRel) ? 'docx' : 'pdf');
                const mime = d.mime
                    || (kind === 'xlsx'
                        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                        : kind === 'docx'
                            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            : 'application/pdf');
                const doc = {
                    id: `static_${d.id}`,
                    staticId: d.id,
                    source: 'static',
                    storage: 'static',
                    folderId: d.folderId ? `static_${d.folderId}` : null,
                    title: d.title,
                    mime,
                    kind,
                    pageCount: d.pageCount || 0,
                    updatedAt: d.updatedAt || 0,
                    hasText: d.hasText !== false && !d.needsDigitize,
                    needsDigitize: !!d.needsDigitize || d.hasText === false,
                    pdfPath: pathRel,
                    size: 0
                };
                staticPack.documents.push(doc);
                if (!doc.hasText) continue;
                try {
                    const chunkUrls = window.AppDataSource?.urlsFor?.(`./data/instructions/chunks/${d.id}.json`)
                        || [`./data/instructions/chunks/${d.id}.json`];
                    let pack = null;
                    for (const curl of chunkUrls) {
                        try {
                            const chunkRes = await fetch(curl, { cache: 'no-store' });
                            if (!chunkRes.ok) continue;
                            pack = await chunkRes.json();
                            break;
                        } catch (_) { /* next */ }
                    }
                    if (!pack) continue;
                    (pack.chunks || []).forEach((ch) => {
                        staticPack.chunks.push({
                            ...ch,
                            id: ch.id || uid('schk'),
                            docId: doc.id
                        });
                    });
                } catch (_) { /* skip */ }
            }
        } catch (err) {
            console.warn('[instructions] static pack', err);
        }
        staticPack.ready = true;
    }

    async function deleteBlob(doc) {
        if (doc.storage === 'opfs') {
            const dir = await getOpfsRoot();
            if (dir) {
                try {
                    await dir.removeEntry(doc.path || `${doc.id}.bin`);
                } catch (_) {
                    /* ignore */
                }
            }
        }
        await deleteItem('blobs', doc.id).catch(() => {});
    }

    async function loadPdfJs() {
        if (pdfjsLib) return pdfjsLib;
        if (pdfjsLoading) return pdfjsLoading;
        pdfjsLoading = import(PDFJS_URL)
            .then((mod) => {
                const lib = mod.default || mod;
                if (lib?.GlobalWorkerOptions) {
                    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                }
                pdfjsLib = lib;
                return lib;
            })
            .catch((err) => {
                pdfjsLoading = null;
                throw err;
            });
        return pdfjsLoading;
    }

    function cleanPdfText(raw) {
        return String(raw || '')
            .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ')
            .replace(/[©®™�]/g, '')
            .replace(/([A-Za-zА-Яа-яЁё0-9])-\n([A-Za-zА-Яа-яЁё0-9])/g, '$1$2')
            .replace(/\r\n?/g, '\n')
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function textContentToString(content) {
        let text = '';
        let lastY = null;
        const items = content?.items || [];
        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const str = item?.str;
            if (!str) continue;
            const y = item.transform ? item.transform[5] : null;
            if (lastY != null && y != null && Math.abs(y - lastY) > 4) {
                text += '\n';
            } else if (text && !/\s$/.test(text) && !/^\s/.test(str)) {
                text += ' ';
            }
            text += str;
            if (y != null) lastY = y;
        }
        return text;
    }

    function extractSection(text) {
        const raw = String(text || '');
        const m = raw.match(/(?:^|\n)\s*((?:\d+\.){1,4}\d+)\s/)
            || raw.match(/(?:п\.|пункт|раздел|статья)\s*([\d.]+)/i)
            || raw.match(/\b(\d+(?:\.\d+){1,3})\b/);
        return m ? (m[1] || m[0]).trim() : '';
    }

    function isTocJunk(text) {
        const lines = String(text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return true;
        let tocHits = 0;
        lines.forEach((line) => {
            if (/\.{3,}|…/.test(line) && /\d{1,4}\s*$/.test(line)) tocHits += 1;
            if (/^\d+(?:\.\d+)*\s+.+\s+\d{1,4}$/.test(line) && line.length < 90) tocHits += 1;
        });
        if (tocHits >= 2) return true;
        if (tocHits >= 1 && lines.length <= 4) return true;
        const dottedRatio = tocHits / lines.length;
        return dottedRatio >= 0.5 && lines.length >= 3;
    }

    function isCoverJunk(text) {
        const raw = String(text || '').trim();
        if (!raw) return true;
        if (isTocJunk(raw)) return true;

        if (/внутренн\w*\s+нормативн|дата\s+утверждения|полигоне\s+обслуживания|центральная\s+ппк|у[эе]пс[-\s]?\d/i.test(raw)
            && raw.length < 520) {
            return true;
        }
        if (/термины\s+и\s+определения/i.test(raw) && raw.length < 280) return true;

        const cyr = (raw.match(/[а-яё]/gi) || []).length;
        const lat = (raw.match(/[a-z]/gi) || []).length;
        if (cyr + lat > 36 && lat > cyr * 0.5) return true;

        if (/(?:[A-Z]{3,}[^a-zа-яё]*){2,}/.test(raw) && cyr < 40) return true;
        if ((raw.match(/[|_]{2,}|\s—\s|\s–\s/g) || []).length >= 4 && raw.length < 650) return true;

        const words = raw.split(/\s+/).filter(Boolean);
        const shortRatio = words.filter((w) => w.length <= 2).length / Math.max(1, words.length);
        if (words.length > 12 && shortRatio > 0.45) return true;

        return false;
    }

    function splitIntoChunks(pageNum, pageText) {
        const cleaned = cleanPdfText(pageText);
        if (!cleaned) return [];

        let parts = cleaned.split(/(?=\n\d+\.\d+(?:\.\d+)*\b|\n[А-ЯЁA-Z][А-ЯЁA-Z\s]{3,}\n)/);
        if (parts.length === 1) {
            parts = cleaned.split(/\n{2,}/);
        }
        if (parts.length === 1 && cleaned.length > 900) {
            parts = [];
            let start = 0;
            while (start < cleaned.length) {
                let end = Math.min(cleaned.length, start + 700);
                if (end < cleaned.length) {
                    const soft = cleaned.lastIndexOf('. ', end);
                    if (soft > start + 200) end = soft + 1;
                }
                parts.push(cleaned.slice(start, end));
                start = end;
            }
        }

        return parts
            .map((part) => cleanPdfText(part))
            .filter((part) => part.length >= 24)
            .filter((part) => !isCoverJunk(part))
            .map((part) => {
                const section = extractSection(part);
                return {
                    id: uid('chk'),
                    page: pageNum,
                    section,
                    sectionHint: section,
                    cleanText: part,
                    text: part
                };
            });
    }

    async function extractPdfChunks(arrayBuffer) {
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: arrayBuffer.slice(0) }).promise;
        const all = [];
        const pageTexts = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const raw = textContentToString(content);
            pageTexts.push(raw);
            all.push(...splitIntoChunks(pageNum, raw));
        }
        try { pdf.destroy(); } catch (_) { /* ignore */ }
        return { pageCount: pageTexts.length, chunks: all, pageTexts };
    }

    function queryKeywords(queryNorm) {
        return queryNorm
            .split(/[\s,;:!?()[\]«»"']+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    }

    function scoreChunk(query, chunk) {
        const source = chunk.cleanText || chunk.text || '';
        if (isCoverJunk(source)) return 0;

        const qNorm = normalizeText(query);
        const text = normalizeText(source);
        if (!qNorm || !text) return 0;

        let score = 0;
        const sectionPatterns = [...qNorm.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)].map((m) => m[0]);
        sectionPatterns.forEach((sec) => {
            const escaped = sec.replace(/\./g, '\\.');
            const sectionField = normalizeText(chunk.section || chunk.sectionHint || '');
            const atStart = new RegExp(`(^|\\n)\\s*${escaped}(\\s|[.…]|$)`);
            const bodyAfter = source.replace(new RegExp(escaped), '').replace(/\s+/g, ' ').trim();
            if (sectionField === sec || atStart.test(source)) {
                if (bodyAfter.length >= 70) score += 100;
                else if (bodyAfter.length >= 30) score += 35;
            } else if (text.includes(sec)) {
                score += 6;
            }
        });

        if (text.includes(qNorm) && qNorm.length >= 6) {
            score += 50;
        }

        const keywords = queryKeywords(qNorm);
        if (!keywords.length && !sectionPatterns.length) {
            if (text.includes(qNorm)) score += 8;
            return score;
        }

        let hitCount = 0;
        keywords.forEach((token) => {
            if (text.includes(token)) {
                hitCount += 1;
                score += token.length >= 5 ? 6 : 3;
            }
        });

        if (keywords.length >= 2) {
            if (hitCount === keywords.length) score += 40;
            else if (hitCount >= Math.ceil(keywords.length * 0.75)) score += 18;
            else if (hitCount === 1) score = Math.max(0, score - 8);
        } else if (keywords.length === 1 && hitCount === 1) {
            score += 10;
        }

        if (Number(chunk.page) === 1 && score > 0 && source.length < 420) {
            score = Math.max(0, score - 25);
        }

        if (hitCount === 0 && !sectionPatterns.length) return 0;
        if (keywords.length >= 2 && hitCount < Math.ceil(keywords.length / 2) && !sectionPatterns.length) {
            return Math.min(score, 4);
        }

        return score;
    }

    async function keywordSearch(query, limit = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        const chunks = [...(await getAll('chunks')), ...staticPack.chunks];
        const docs = [...(await getAll('documents')), ...staticPack.documents];
        const docMap = Object.fromEntries(docs.map((d) => [d.id, d]));
        return chunks
            .map((chunk) => ({
                chunk,
                doc: docMap[chunk.docId],
                score: scoreChunk(q, chunk)
            }))
            .filter((row) => row.score > 0 && row.doc && row.doc.hasText !== false
                && !isCoverJunk(row.chunk.cleanText || row.chunk.text))
            .sort((a, b) => b.score - a.score || (a.chunk.page || 0) - (b.chunk.page || 0))
            .slice(0, limit);
    }

    function makeSnippetHtml(text, query, maxLen = 180) {
        const raw = String(text || '').replace(/\s+/g, ' ').trim();
        if (!raw) return '';
        const qNorm = normalizeText(query);
        const keywords = queryKeywords(qNorm);
        const lower = normalizeText(raw);
        let anchor = -1;
        const needle = keywords[0] || qNorm;
        if (needle) anchor = lower.indexOf(needle);
        if (anchor < 0) anchor = 0;

        let start = Math.max(0, anchor - 50);
        let end = Math.min(raw.length, start + maxLen);
        if (start > 0) {
            const space = raw.indexOf(' ', start);
            if (space > 0 && space < start + 20) start = space + 1;
        }
        let slice = raw.slice(start, end).trim();
        if (start > 0) slice = `…${slice}`;
        if (end < raw.length) slice = `${slice}…`;

        let html = escapeHtml(slice);
        const terms = [...new Set([qNorm, ...keywords].filter((t) => t && t.length > 1))]
            .sort((a, b) => b.length - a.length);
        terms.forEach((term) => {
            const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            html = html.replace(re, '<mark>$1</mark>');
        });
        return html;
    }

    function needsDigitizeBanner(doc) {
        if (doc.hasText === false) return true;
        if (doc.needsDigitize === true) return true;
        if (doc.needsOcr === true) return true;
        return false;
    }

    function digitizeBannerHtml() {
        return `<p class="instr-doc__digitize-banner" role="status">${escapeHtml(DIGITIZE_MSG)}</p>`;
    }

    function setFabMenuOpen(open) {
        const menu = $('instrFabMenu');
        const fab = $('instrFab');
        if (!menu || !fab) return;
        menu.hidden = !open;
        fab.classList.toggle('is-open', open);
        fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    let nameDialogResolver = null;

    function closeNameDialog(value) {
        const dialog = $('instrNameDialog');
        if (dialog) {
            dialog.hidden = true;
            dialog.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('release-overlay-open');
        const resolver = nameDialogResolver;
        nameDialogResolver = null;
        if (resolver) resolver(value);
    }

    function askFolderName() {
        return new Promise((resolve) => {
            const dialog = $('instrNameDialog');
            const input = $('instrNameDialogInput');
            if (!dialog || !input) {
                resolve(null);
                return;
            }
            nameDialogResolver = resolve;
            input.value = '';
            dialog.hidden = false;
            dialog.setAttribute('aria-hidden', 'false');
            document.body.classList.add('release-overlay-open');
            window.setTimeout(() => {
                input.focus();
                input.select();
            }, 40);
        });
    }

    async function createUserFolder() {
        const name = await askFolderName();
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) {
            setStatus('Введите название папки');
            window.setTimeout(() => setStatus(''), 2000);
            return;
        }
        const folders = await getAll('folders');
        const folder = {
            id: uid('fld'),
            name: trimmed.slice(0, 48),
            parentId: activeFolderId || null,
            order: folders.length,
            createdAt: Date.now()
        };
        await putItem('folders', folder);
        setStatus(`Папка «${folder.name}» создана`);
        window.setTimeout(() => setStatus(''), 2000);
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function deleteDocument(docId) {
        if (String(docId || '').startsWith('static_')) {
            setStatus('Основная документация — нельзя удалить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const doc = await getItem('documents', docId);
        if (!doc) return;
        const ok = window.confirm(`Удалить «${doc.title}»?`);
        if (!ok) return;

        const chunks = await getAll('chunks');
        for (const chunk of chunks) {
            if (chunk.docId === docId) {
                await deleteItem('chunks', chunk.id).catch(() => {});
            }
        }
        await deleteBlob(doc);
        await deleteItem('documents', docId);
        setStatus('Документ удалён');
        window.setTimeout(() => setStatus(''), 2000);
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    function isStaticItem(id) {
        return String(id || '').startsWith('static_');
    }

    function folderButtonHtml(folder) {
        const locked = folder.source === 'static';
        const active = folder.id === activeFolderId;
        return `
            <button type="button" class="instr-folder${locked ? ' instr-folder--static' : ''}${active ? ' is-active' : ''}" data-folder-id="${escapeHtml(folder.id)}" ${locked ? 'data-static="1"' : ''}>
                <span class="instr-folder__icon" aria-hidden="true"></span>
                <span class="instr-folder__name">${escapeHtml(folder.name)}</span>
            </button>
        `;
    }

    async function deleteUserFolder(folderId) {
        if (isStaticItem(folderId) || SYSTEM_FOLDER_IDS.includes(folderId)) {
            setStatus('Основная документация — нельзя удалить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const folder = await getItem('folders', folderId);
        if (!folder) return;
        const ok = window.confirm(`Удалить папку «${folder.name}»? Файлы и вложенные папки останутся уровнем выше.`);
        if (!ok) return;
        const parentId = folder.parentId || null;
        const folders = await getAll('folders');
        for (const f of folders) {
            if (f.parentId === folderId) {
                f.parentId = parentId;
                await putItem('folders', f);
            }
        }
        const docs = await getAll('documents');
        for (const doc of docs) {
            if (doc.folderId === folderId) {
                doc.folderId = parentId;
                doc.updatedAt = Date.now();
                await putItem('documents', doc);
            }
        }
        await deleteItem('folders', folderId);
        if (activeFolderId === folderId) activeFolderId = parentId;
        setStatus('Папка удалена');
        window.setTimeout(() => setStatus(''), 2000);
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    function docActionsHtml(doc, opts = {}) {
        const { hitsCount = 0 } = opts;
        const toggle = hitsCount
            ? `<button type="button" class="instr-doc__toggle" data-doc-toggle="${escapeHtml(doc.id)}" aria-expanded="true" aria-label="Показать совпадения">▾</button>`
            : '';
        const del = doc.source === 'static'
            ? ''
            : `<button type="button" class="instr-doc__delete" data-doc-delete="${escapeHtml(doc.id)}" aria-label="Удалить документ">✕</button>`;
        return `
            ${toggle}
            ${del}
        `;
    }

    async function renderFsNav() {
        const back = $('instrFsBack');
        const title = $('instrFsTitle');
        const showAll = $('instrShowAllBtn');
        if (!title) return;

        title.textContent = 'Рабочий стол';
        if (back) back.hidden = true;
        if (showAll) showAll.hidden = !activeFolderId;

        if (!activeFolderId) return;
        const folder = await resolveFolder(activeFolderId);
        if (folder?.parentId) {
            if (back) back.hidden = false;
            title.textContent = folder.name || 'Папка';
        }
    }

    async function enterFolder(folderId) {
        activeFolderId = folderId || null;
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function goDesktop() {
        activeFolderId = null;
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function goBack() {
        if (!activeFolderId) {
            await goDesktop();
            return;
        }
        const folder = await resolveFolder(activeFolderId);
        await enterFolder(folder?.parentId || null);
    }

    async function renderFolders() {
        const host = $('instrFolders');
        const baseHost = $('instrBaseFolders');
        const baseSection = $('instrBaseSection');
        if (!host) return;
        const sortFolders = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'ru');
        const userAll = (await getAll('folders')).filter((f) => !SYSTEM_FOLDER_IDS.includes(f.id));
        const active = activeFolderId ? await resolveFolder(activeFolderId) : null;
        const nested = Boolean(active?.parentId);

        const desktopStatic = staticPack.folders
            .filter((f) => !f.parentId)
            .sort(sortFolders);
        const desktopUser = userAll
            .filter((f) => !f.parentId)
            .sort(sortFolders);
        const desktopFolders = [...desktopStatic, ...desktopUser];

        if (baseHost && baseSection) {
            if (desktopFolders.length && !nested) {
                baseSection.hidden = false;
                baseHost.innerHTML = desktopFolders.map((folder) => folderButtonHtml(folder)).join('');
            } else {
                baseSection.hidden = true;
                baseHost.innerHTML = '';
            }
        }

        const childParent = nested ? activeFolderId : null;
        const childFolders = childParent
            ? [
                ...staticPack.folders.filter((f) => (f.parentId || null) === childParent),
                ...userAll.filter((f) => (f.parentId || null) === childParent)
            ].sort(sortFolders)
            : [];

        if (!childFolders.length) {
            host.classList.add('is-hidden');
            host.innerHTML = '';
            return;
        }

        host.classList.remove('is-hidden');
        host.innerHTML = childFolders.map((folder) => folderButtonHtml(folder)).join('');
    }

    function docSubMeta(doc, extra = '') {
        const bits = [
            formatBytes(doc.size),
            formatDate(doc.updatedAt),
            doc.pageCount ? `${doc.pageCount} стр.` : '',
            extra
        ].filter(Boolean);
        return bits.join(' · ');
    }

    function docSeriesLabel(doc) {
        const title = String(doc?.title || '');
        const found = title.match(/ЭП2ДМ?|ЭГЭ?2Т[Вв]|ПТЭ|ИДП/i);
        if (found) {
            return found[0].replace(/эгэ2тв/i, 'ЭГ2ТВ').replace(/эг2тв/i, 'ЭГ2ТВ').toUpperCase();
        }
        if (doc?.kind === 'xlsx') return 'XLS';
        if (doc?.kind === 'docx') return 'DOC';
        return doc?.source === 'static' ? 'БЗ' : 'PDF';
    }

    async function moveDocToFolder(docId, folderId) {
        if (String(docId || '').startsWith('static_')) {
            setStatus('Статичный документ нельзя переместить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        if (String(folderId || '').startsWith('static_')) {
            setStatus('В папку базы нельзя перемещать свои файлы');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const doc = await getItem('documents', docId);
        if (!doc) return;
        if (doc.folderId === folderId) return;
        doc.folderId = folderId;
        doc.updatedAt = Date.now();
        await putItem('documents', doc);
        setStatus('Документ перемещён в папку');
        window.setTimeout(() => setStatus(''), 2000);
        await renderDocuments($('instrSearchInput')?.value || '');
        await renderFolders();
    }

    function renderHitSnippetRow(hit, query) {
        const section = hit.chunk.section || hit.chunk.sectionHint || '';
        const snippet = makeSnippetHtml(hit.chunk.cleanText || hit.chunk.text, query);
        return `
            <button type="button" class="instr-hit"
                data-doc-id="${escapeHtml(hit.doc.id)}"
                data-page="${Number(hit.chunk.page) || 1}"
                data-highlight="${escapeHtml(query)}">
                <span class="instr-hit__page">Стр. ${Number(hit.chunk.page) || 1}</span>
                ${section ? `<span class="instr-hit__section">${escapeHtml(section)}</span>` : ''}
                <span class="instr-hit__snippet">${snippet}</span>
            </button>
        `;
    }

    function renderDocCardHtml(doc, opts = {}) {
        const { hits = [], query = '', location = '' } = opts;
        const hitsHtml = hits.length
            ? `<div class="instr-doc-hits">${hits.map((h) => renderHitSnippetRow(h, query)).join('')}</div>`
            : '';
        const banner = needsDigitizeBanner(doc) ? digitizeBannerHtml() : '';
        const pages = doc.pageCount ? `${doc.pageCount} стр.` : '';
        const place = [location, pages].filter(Boolean).join(' • ');
        return `
            <article class="instr-doc-card${hits.length ? ' is-open' : ''}" data-doc-card="${escapeHtml(doc.id)}" ${doc.source === 'static' ? '' : 'draggable="true"'}>
                <div class="instr-doc-head">
                    <span class="instr-doc__series">${escapeHtml(docSeriesLabel(doc))}</span>
                    <span class="instr-doc__place">${escapeHtml(place || docSubMeta(doc))}</span>
                </div>
                <div class="instr-doc" data-doc-open="${escapeHtml(doc.id)}" role="button" tabindex="0">
                    <span class="instr-doc__meta">
                        <span class="instr-doc__title">${escapeHtml(doc.title)}</span>
                    </span>
                    ${docActionsHtml(doc, { hitsCount: hits.length })}
                </div>
                ${banner}
                ${hitsHtml}
            </article>
        `;
    }

    async function renderDocuments(filterQuery = '') {
        const host = $('instrDocs');
        if (!host) return;
        const allDocs = [...(await getAll('documents')), ...staticPack.documents];
        const folders = [...(await getAll('folders')), ...staticPack.folders];
        const folderMap = Object.fromEntries(folders.map((f) => [f.id, f]));

        if (activeFolderId && !folderMap[activeFolderId]) {
            activeFolderId = null;
            await renderFsNav();
        }

        const q = String(filterQuery || '').trim();
        const qNorm = normalizeText(q);
        lastFileHits = [];

        if (qNorm) {
            let chunkHits = await keywordSearch(q, 80);
            if (activeFolderId) {
                chunkHits = chunkHits.filter((hit) => hit.doc.folderId === activeFolderId);
            }
            lastFileHits = chunkHits;
            const byDoc = new Map();
            chunkHits.forEach((hit) => {
                if (!byDoc.has(hit.doc.id)) byDoc.set(hit.doc.id, []);
                byDoc.get(hit.doc.id).push(hit);
            });

            const titleHits = allDocs.filter(
                (d) => d.hasText !== false
                    && normalizeText(d.title).includes(qNorm)
                    && !byDoc.has(d.id)
                    && (!activeFolderId || d.folderId === activeFolderId)
            );
            const orderedIds = [
                ...chunkHits.map((h) => h.doc.id).filter((id, i, arr) => arr.indexOf(id) === i),
                ...titleHits.map((d) => d.id)
            ].filter((id, i, arr) => arr.indexOf(id) === i);

            const docMap = Object.fromEntries(allDocs.map((d) => [d.id, d]));
            await renderFolders();

            if (!orderedIds.length) {
                host.innerHTML = '<p class="instr-empty">Ничего не найдено</p>';
                return;
            }

            host.innerHTML = orderedIds.map((docId) => {
                const doc = docMap[docId];
                if (!doc) return '';
                const hits = (byDoc.get(docId) || []).slice(0, 8);
                const folderName = doc.folderId ? folderMap[doc.folderId]?.name : '';
                const location = doc.source === 'static'
                    ? (folderName ? `База · ${folderName}` : 'База')
                    : (folderName || 'Рабочий стол');
                return renderDocCardHtml(doc, { hits, query: q, location });
            }).join('');
            return;
        }

        await renderFolders();

        let docs;
        if (activeFolderId) {
            docs = allDocs.filter((d) => d.folderId === activeFolderId);
        } else {
            docs = allDocs.filter((d) => !d.folderId);
        }
        docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        if (!docs.length) {
            const parent = activeFolderId || null;
            const hasChildFolders = [...(await getAll('folders')), ...staticPack.folders]
                .filter((f) => !SYSTEM_FOLDER_IDS.includes(f.id))
                .some((f) => (f.parentId || null) === parent);
            if (hasChildFolders) {
                host.innerHTML = '';
                return;
            }
            host.innerHTML = `<p class="instr-empty">${
                activeFolderId
                    ? 'Папка пуста. Нажмите +, чтобы добавить PDF, или перетащите документ с рабочего стола.'
                    : 'Нет документов на рабочем столе. Загрузите PDF или создайте папку.'
            }</p>`;
            return;
        }

        host.innerHTML = docs.map((doc) => renderDocCardHtml(doc)).join('');
    }

    async function refreshUi() {
        await migrateRemoveSystemFolders();
        await loadStaticInstructionsPack();
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function handleUploadFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;

        let added = 0;
        let lastNeedsDigitize = false;
        for (const file of files) {
            const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
            if (!isPdf) {
                setStatus(`${file.name}: только PDF`);
                window.setTimeout(() => setStatus(''), 2500);
                continue;
            }

            setStatus(`Индексация: ${file.name}…`);
            const docId = uid('doc');
            const storage = await saveBlob(docId, file);
            let pageCount = 0;
            let chunks = [];
            let hasText = false;
            let needsDigitize = false;

            try {
                const buf = await file.arrayBuffer();
                const extracted = await extractPdfChunks(buf);
                pageCount = extracted.pageCount;
                chunks = extracted.chunks.map((c) => ({
                    id: c.id,
                    docId,
                    page: c.page,
                    section: c.section,
                    sectionHint: c.sectionHint,
                    cleanText: c.cleanText,
                    text: c.text
                }));

                const totalChars = (extracted.pageTexts || []).reduce(
                    (sum, t) => sum + cleanPdfText(t).length,
                    0
                );
                const avgPerPage = pageCount ? totalChars / pageCount : 0;
                if (avgPerPage < MIN_PAGE_CHARS || chunks.length === 0) {
                    hasText = false;
                    needsDigitize = true;
                    chunks = [];
                } else {
                    hasText = true;
                    needsDigitize = false;
                }
            } catch (err) {
                console.warn('[instructions] pdf extract', err);
                hasText = false;
                needsDigitize = true;
                chunks = [];
                setStatus(`PDF сохранён без текста: ${file.name}`);
            }

            const doc = {
                id: docId,
                folderId: activeFolderId || null,
                title: file.name,
                mime: 'application/pdf',
                size: file.size,
                pageCount,
                updatedAt: Date.now(),
                storage: storage.storage,
                path: storage.path,
                hasText,
                needsDigitize
            };
            await putItem('documents', doc);
            for (const chunk of chunks) {
                await putItem('chunks', chunk);
            }
            added += 1;
            lastNeedsDigitize = needsDigitize;
        }

        if (added) {
            if (lastNeedsDigitize) setStatus(DIGITIZE_MSG);
            else setStatus(added === 1 ? 'Файл добавлен' : `Добавлено файлов: ${added}`);
        }
        await renderDocuments($('instrSearchInput')?.value || '');
        window.setTimeout(() => setStatus(''), lastNeedsDigitize ? 6000 : 2500);
    }

    function updateViewerChrome() {
        if (!viewer) return;
        const titleEl = $('instrPdfTitle');
        const pageInput = $('instrPdfPageInput');
        const pageTotal = $('instrPdfPageTotal');
        const scrubber = $('instrPdfPageScrubber');
        const findCount = $('instrPdfFindCount');

        if (titleEl) titleEl.textContent = viewer.doc?.title || 'Документ';
        if (pageTotal) pageTotal.textContent = String(viewer.totalPages || 1);
        if (pageInput) {
            pageInput.max = String(viewer.totalPages || 1);
            pageInput.value = String(viewer.pageNum || 1);
        }
        if (scrubber) {
            scrubber.max = String(viewer.totalPages || 1);
            scrubber.value = String(viewer.pageNum || 1);
        }
        if (findCount) {
            const total = viewer.findMatches.length;
            const idx = total ? viewer.findIndex + 1 : 0;
            findCount.textContent = `${idx} из ${total}`;
        }
    }

    async function renderTextLayer(page, viewport) {
        const layer = $('instrPdfTextLayer');
        if (!layer || !pdfjsLib) return;
        layer.innerHTML = '';
        layer.style.width = `${Math.floor(viewport.width)}px`;
        layer.style.height = `${Math.floor(viewport.height)}px`;
        layer.style.setProperty('--scale-factor', String(viewport.scale));

        const textContent = await page.getTextContent();
        try {
            if (typeof pdfjsLib.TextLayer === 'function') {
                const textLayer = new pdfjsLib.TextLayer({
                    textContentSource: textContent,
                    container: layer,
                    viewport
                });
                await textLayer.render();
            }
        } catch (err) {
            console.warn('[instructions] textLayer', err);
        }

        applyTextHighlights(layer);
    }

    function applyTextHighlights(layer) {
        if (!viewer || !layer) return;
        const query = normalizeText(viewer.highlightQuery || viewer.findQuery || '');
        if (!query) return;
        const terms = queryKeywords(query);
        const needles = terms.length ? terms : (query.length > 1 ? [query] : []);
        if (!needles.length) return;

        let first = null;
        layer.querySelectorAll('span').forEach((span) => {
            span.classList.remove('instr-pdf-hl');
            const lower = normalizeText(span.textContent || '');
            if (!lower) return;
            if (needles.some((n) => lower.includes(n))) {
                span.classList.add('instr-pdf-hl');
                if (!first) first = span;
            }
        });
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function ensurePdfPageDom(stage) {
        let canvas = $('instrPdfCanvas');
        let wrap = $('instrPdfPageWrap');
        if (canvas && wrap && stage.contains(canvas) && stage.contains(wrap)) {
            wrap.hidden = false;
            return { canvas, wrap };
        }
        stage.innerHTML = `
            <div id="instrPdfPageWrap" class="instr-pdf-page-wrap">
                <canvas id="instrPdfCanvas"></canvas>
                <div id="instrPdfTextLayer" class="instr-pdf-text-layer textLayer"></div>
            </div>
        `;
        return { canvas: $('instrPdfCanvas'), wrap: $('instrPdfPageWrap') };
    }

    async function renderPdfPage(pageNum) {
        if (!viewer?.pdf) return;
        const stage = $('instrPdfStage');
        if (!stage) return;
        const gen = viewer.gen;

        if (viewer.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
            viewer.renderTask = null;
        }

        const { canvas, wrap } = ensurePdfPageDom(stage);
        if (!canvas || !wrap) return;

        const target = Math.min(Math.max(1, Number(pageNum) || 1), viewer.totalPages);
        viewer.pageNum = target;
        viewer.rendering = true;
        updateViewerChrome();

        try {
            const page = await viewer.pdf.getPage(target);
            if (!viewer || viewer.gen !== gen) return;

            const containerWidth = Math.max(280, (stage.clientWidth || window.innerWidth) - 24);
            const unscaled = page.getViewport({ scale: 1 });
            const scale = containerWidth / Math.max(1, unscaled.width);
            const viewport = page.getViewport({ scale });
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cssW = Math.floor(viewport.width);
            const cssH = Math.floor(viewport.height);

            const fresh = document.createElement('canvas');
            fresh.id = 'instrPdfCanvas';
            canvas.replaceWith(fresh);
            const drawCanvas = fresh;

            drawCanvas.width = Math.floor(cssW * dpr);
            drawCanvas.height = Math.floor(cssH * dpr);
            drawCanvas.style.width = `${cssW}px`;
            drawCanvas.style.height = `${cssH}px`;
            wrap.style.width = `${cssW}px`;
            wrap.style.height = `${cssH}px`;
            wrap.hidden = false;

            const ctx = drawCanvas.getContext('2d');
            if (!ctx) throw new Error('Canvas 2D недоступен');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);

            const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
            const renderTask = page.render({
                canvasContext: ctx,
                viewport,
                transform,
                intent: 'display'
            });
            viewer.renderTask = renderTask;
            await renderTask.promise;
            if (!viewer || viewer.gen !== gen) return;
            viewer.renderTask = null;
            await renderTextLayer(page, viewport);
        } catch (err) {
            if (err?.name === 'RenderingCancelledException') return;
            console.warn('[instructions] renderPdfPage', err);
            if (viewer && viewer.gen === gen) {
                stage.innerHTML = `<p class="instr-empty">Не удалось отрисовать страницу. ${escapeHtml(err.message || '')}</p>`;
            }
        } finally {
            if (viewer && viewer.gen === gen) {
                viewer.rendering = false;
                updateViewerChrome();
            }
        }
    }

    async function ensurePageTexts() {
        if (!viewer?.pdf) return;
        if (viewer.pageTexts.length === viewer.totalPages) return;
        viewer.pageTexts = new Array(viewer.totalPages).fill('');
        for (let i = 1; i <= viewer.totalPages; i += 1) {
            const page = await viewer.pdf.getPage(i);
            const content = await page.getTextContent();
            viewer.pageTexts[i - 1] = cleanPdfText(textContentToString(content));
        }
    }

    async function runPdfFind(query, resetIndex) {
        if (!viewer) return;
        viewer.findQuery = String(query || '').trim();
        viewer.highlightQuery = viewer.findQuery;
        if (!viewer.findQuery) {
            viewer.findMatches = [];
            viewer.findIndex = -1;
            updateViewerChrome();
            await renderPdfPage(viewer.pageNum);
            return;
        }

        await ensurePageTexts();
        const q = normalizeText(viewer.findQuery);
        const matches = [];
        viewer.pageTexts.forEach((pageText, idx) => {
            const lower = normalizeText(pageText);
            let from = 0;
            while (from < lower.length) {
                const pos = lower.indexOf(q, from);
                if (pos < 0) break;
                matches.push({ page: idx + 1, start: pos, end: pos + q.length });
                from = pos + Math.max(1, q.length);
                if (matches.length > 400) break;
            }
        });
        viewer.findMatches = matches;
        if (resetIndex !== false) {
            viewer.findIndex = matches.length ? 0 : -1;
        } else if (viewer.findIndex >= matches.length) {
            viewer.findIndex = matches.length ? 0 : -1;
        }
        updateViewerChrome();
        if (viewer.findIndex >= 0) {
            await goToFindMatch(viewer.findIndex);
        } else {
            await renderPdfPage(viewer.pageNum);
        }
    }

    async function goToFindMatch(index) {
        if (!viewer?.findMatches.length) return;
        const total = viewer.findMatches.length;
        viewer.findIndex = ((index % total) + total) % total;
        const match = viewer.findMatches[viewer.findIndex];
        viewer.highlightQuery = viewer.findQuery;
        updateViewerChrome();
        await renderPdfPage(match.page);
    }

    async function openPdfViewer(docId, page, highlightQuery) {
        const overlay = $('instrPdfOverlay');
        if (!overlay) return;

        const doc = await resolveDocument(docId);
        if (!doc) {
            setStatus('Документ не найден');
            return;
        }
        if (doc.kind === 'docx' || doc.kind === 'xlsx' || (doc.mime && !String(doc.mime).includes('pdf'))) {
            setStatus('Word и Excel смотрятся по индексу, без PDF-ридера');
            window.setTimeout(() => setStatus(''), 2800);
            return;
        }

        if (viewer?.resizeObs) {
            try { viewer.resizeObs.disconnect(); } catch (_) { /* ignore */ }
        }
        if (viewer?.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
        }
        if (viewer?.pdf) {
            try { viewer.pdf.destroy(); } catch (_) { /* ignore */ }
        }
        const openGen = (viewer?.gen || 0) + 1;
        viewer = null;

        const titleEl = $('instrPdfTitle');
        if (titleEl) titleEl.textContent = doc.title || 'Документ';
        const findInput = $('instrPdfFindInput');
        if (findInput) findInput.value = String(highlightQuery || '').trim();
        const findCount = $('instrPdfFindCount');
        if (findCount) findCount.textContent = '0 из 0';
        const pageTotal = $('instrPdfPageTotal');
        if (pageTotal) pageTotal.textContent = '…';
        const pageInput = $('instrPdfPageInput');
        if (pageInput) pageInput.value = String(Math.max(1, Number(page) || 1));

        const stage = $('instrPdfStage');
        if (stage) {
            stage.innerHTML = '<p class="instr-pdf-loading">Загрузка PDF…</p>';
        }

        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('release-overlay-open');

        try {
            const blob = await loadBlob(doc);
            if (!blob) throw new Error('Файл недоступен');

            const lib = await loadPdfJs();
            const src = new Uint8Array(await blob.arrayBuffer());
            const data = src.slice();
            const pdf = await lib.getDocument({ data }).promise;
            if (viewer && viewer.gen > openGen) {
                try { pdf.destroy(); } catch (_) { /* ignore */ }
                return;
            }

            const pageNum = Math.min(Math.max(1, Number(page) || 1), pdf.numPages || 1);

            viewer = {
                gen: openGen,
                doc,
                pdf,
                pageNum,
                totalPages: pdf.numPages || 1,
                rendering: false,
                pageTexts: [],
                findQuery: '',
                findMatches: [],
                findIndex: -1,
                highlightQuery: String(highlightQuery || '').trim(),
                resizeObs: null,
                renderTask: null,
                touchStartX: 0,
                touchStartY: 0
            };

            updateViewerChrome();
            await renderPdfPage(pageNum);
            if (!viewer || viewer.gen !== openGen) return;

            if (viewer.highlightQuery) {
                applyTextHighlights($('instrPdfTextLayer'));
            }

            const stageEl = $('instrPdfStage');
            if (stageEl && typeof ResizeObserver !== 'undefined') {
                viewer.resizeObs = new ResizeObserver(() => {
                    if (!viewer?.pdf || viewer.rendering || viewer.gen !== openGen) return;
                    window.clearTimeout(viewer._resizeTimer);
                    viewer._resizeTimer = window.setTimeout(() => {
                        if (viewer?.pdf && viewer.gen === openGen) {
                            renderPdfPage(viewer.pageNum);
                        }
                    }, 180);
                });
                viewer.resizeObs.observe(stageEl);
            }
        } catch (err) {
            console.warn('[instructions] viewer', err);
            const stageEl = $('instrPdfStage');
            if (stageEl) {
                stageEl.innerHTML = `<p class="instr-empty">Не удалось открыть документ. ${escapeHtml(err.message || '')}</p>`;
            }
            if (titleEl) titleEl.textContent = doc.title || 'Документ';
        }
    }

    function closePdfViewer(hideOverlay = true) {
        if (viewer?.resizeObs) {
            try { viewer.resizeObs.disconnect(); } catch (_) { /* ignore */ }
        }
        if (viewer?.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
        }
        if (viewer?.pdf) {
            try { viewer.pdf.destroy(); } catch (_) { /* ignore */ }
        }
        viewer = null;
        const findInput = $('instrPdfFindInput');
        if (findInput) findInput.value = '';
        const findCount = $('instrPdfFindCount');
        if (findCount) findCount.textContent = '0 из 0';
        const titleEl = $('instrPdfTitle');
        if (titleEl) titleEl.textContent = 'Документ';
        const pageTotal = $('instrPdfPageTotal');
        if (pageTotal) pageTotal.textContent = '1';
        const pageInput = $('instrPdfPageInput');
        if (pageInput) {
            pageInput.value = '1';
            pageInput.max = '1';
        }
        const scrubber = $('instrPdfPageScrubber');
        if (scrubber) {
            scrubber.value = '1';
            scrubber.max = '1';
        }

        if (!hideOverlay) return;
        const overlay = $('instrPdfOverlay');
        if (!overlay) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('release-overlay-open');

        const stage = $('instrPdfStage');
        if (stage) stage.innerHTML = '';
    }

    const WALL_STORAGE_KEY = 'da_crew_wall_v2';
    const WALL_API_CATEGORY = {
        machines: 'Машины',
        line: 'Линия',
        office: 'Офис',
        contacts: 'Контакты'
    };
    const WALL_API_CATEGORY_REVERSE = {
        'Машины': 'machines',
        'Линия': 'line',
        'Офис': 'office',
        'Контакты': 'contacts'
    };
    const WALL_HAMMER_VOTES_KEY = 'da_wall_hammer_my_votes_v1';
    const WALL_LIKE_VOTES_KEY = 'da_wall_like_my_votes_v1';
    const WALL_HAMMER_ARCHIVE_AT = 10;
    const WALL_COMMENTS_STORAGE_KEY = 'da_wall_comments_v1';
    const WALL_DETAIL_HISTORY_KEY = 'daInstrWallDetail';
    const WALL_FORM_CONFIG = {
        machines: {
            chips: ['Двери', 'Тормоза', 'Климат', 'Тяга', 'Радиостанция', 'Камеры'],
            series: ['ЭГЭ2Тв', 'ЭП2Д', 'ЭД4М'],
            parts: ['Голова', 'Хвост', 'Весь состав']
        },
        line: {
            chips: ['Юз', 'Негабарит', 'Платформа', 'Сигнал', 'Ремонт']
        },
        office: {
            chips: ['Роспись в журнале', 'Инструктаж', 'Другое', 'Нарядчики']
        },
        contacts: {
            chips: ['Депо', 'Офис', 'Ремонт', 'Станции']
        }
    };

    const WALL_CHIP_URGENT = ['негабарит', 'сигнал', 'опасно', 'срочно'];
    const WALL_CHIP_FAULT = ['двери', 'климат', 'тормоза', 'тяга', 'камеры', 'радиостанция', 'юз'];
    const WALL_CHIP_PLACE = ['голова', 'хвост', 'вагон', 'состав', 'платформа', 'короткая', 'путь', 'перегон', 'станция', 'тупик', 'км', 'пк'];
    const WALL_CHIP_OFFICE = ['роспись', 'инструктаж', 'другое', 'нарядчики', 'приказ', 'срок', 'тема', 'офис'];
    const WALL_CHIP_CONTACT = ['депо', 'ремонт', 'станции', 'контакт', 'вызов', 'нарядчик'];

    function wallChipToneForLabel(label, formType) {
        const n = normalizeText(label);
        if (!n) return 'neutral';
        if (WALL_CHIP_URGENT.some((k) => n.includes(k))) return 'urgent';
        if (formType === 'contacts') return 'contact';
        if (WALL_CHIP_FAULT.some((k) => n.includes(k))) return 'fault';
        if (WALL_CHIP_PLACE.some((k) => n.includes(k))
            || /\d+\s*путь/.test(n)
            || /\d+[\.,]?\d*\s*(км|km|пк|pk)/.test(n)) {
            return 'place';
        }
        if (WALL_FORM_CONFIG.machines.series.some((s) => normalizeText(s) === n)) return 'office';
        if (formType === 'office' || WALL_CHIP_OFFICE.some((k) => n.includes(k))) return 'office';
        return 'neutral';
    }

    function wallFormChipButton(label, formType, isActive, dataAttr) {
        const tone = wallChipToneForLabel(label, formType);
        return `<button type="button" class="wall-chip wall-tone-${tone}${isActive ? ' is-active' : ''}" ${dataAttr}>${escapeHtml(label)}</button>`;
    }

    let instrMainMode = 'wall';
    let wallItems = [];
    let activeWallCategory = 'all';
    let activeWallTag = '';
    let currentFormType = 'machines';
    let selectedChipTag = WALL_FORM_CONFIG.machines.chips[0];
    let selectedMachinePart = 'Голова';
    let selectedMachineSeries = WALL_FORM_CONFIG.machines.series[0];
    let wallEditingId = null;
    let wallDetailPostId = null;
    let wallDetailComments = [];
    let wallDetailHistoryActive = false;
    let wallDetailPopstateBound = false;

    const WALL_DESC_PLACEHOLDER = 'Опишите неисправность или примечание для смены';

    function wallFormDescBlock(labelText) {
        const label = labelText || 'Что случилось';
        return `
                <div class="wall-field wall-field--desc">
                    <label>${label}</label>
                    <textarea id="f_desc" rows="3" placeholder="${WALL_DESC_PLACEHOLDER}"></textarea>
                </div>`;
    }

    function parseMachineTitleForForm(objectTitle) {
        const title = String(objectTitle || '').trim().replace(/^Машина\s+/i, '');
        const seriesList = WALL_FORM_CONFIG.machines.series || [];
        let series = seriesList.find((s) => title.toUpperCase().startsWith(String(s).toUpperCase()));
        if (!series) series = selectedMachineSeries || seriesList[0] || '';
        let number = title;
        if (series) {
            number = title.slice(series.length).trim();
        }
        number = number.replace(/^[-–—\s]+/, '').trim();
        return { series, number };
    }

    function buildWallObjectTitle(formType) {
        if (formType === 'machines') {
            const num = ($('f_machine_num')?.value || '').trim();
            const series = selectedMachineSeries || WALL_FORM_CONFIG.machines.series[0] || '';
            if (series && num) return cleanWallDanglingDashes(`${series} ${num}`);
            if (series) return cleanWallDanglingDashes(series);
            if (num) return cleanWallDanglingDashes(`Машина ${num}`);
            return 'Машина';
        }
        if (formType === 'line') {
            const place = ($('f_place')?.value || '').trim();
            if (place) return cleanWallDanglingDashes(place);
            return selectedChipTag || 'Линия';
        }
        if (formType === 'office') {
            return cleanWallDanglingDashes(selectedChipTag || 'Офис');
        }
        if (formType === 'contacts') {
            const name = ($('f_contact_name')?.value || '').trim();
            return cleanWallDanglingDashes(name) || 'Контакт';
        }
        return 'Запись';
    }

    function defaultWallItems() {
        return [];
    }

    function formatResolveVotes(count) {
        const n = Math.max(0, Number(count) || 0);
        if (!n) return '';
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return `${n} человек проголосовал`;
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} человека проголосовало`;
        return `${n} человек проголосовало`;
    }

    function getWallCurrentTab() {
        return String(window.DaCrewApi?.getTabNumber?.() || '').trim();
    }

    function wallIsCurrentUserAuthor(item) {
        if (!item) return false;
        const mySync = getWallMySyncUserId();
        const authorSync = String(item.authorSyncUserId || item.author_sync_user_id || '').trim();
        if (mySync && authorSync && mySync === authorSync) return true;
        const myTab = getWallCurrentTab();
        const authorTab = String(item.authorTab || '').trim();
        if (myTab && authorTab && myTab === authorTab) return true;
        return false;
    }

    function wallHammerCount(item) {
        if (!item) return 0;
        if (!item._fromServer && Array.isArray(item.hammers)) {
            return item.hammers.length;
        }
        return Math.max(0, Number(item.hammerCount ?? item.resolveVotes) || 0);
    }

    function wallLikesCount(item) {
        return Math.max(0, Number(item.likesCount) || 0);
    }

    function loadMyLikeVotes() {
        try {
            const raw = localStorage.getItem(WALL_LIKE_VOTES_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function saveMyLikeVotes(map) {
        try {
            localStorage.setItem(WALL_LIKE_VOTES_KEY, JSON.stringify(map || {}));
        } catch (_) { /* quota */ }
    }

    function hasMyLikeVote(id, item) {
        if (item && item.myLike) return true;
        return Boolean(loadMyLikeVotes()[String(id)]);
    }

    function loadMyHammerVotes() {
        try {
            const raw = localStorage.getItem(WALL_HAMMER_VOTES_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function saveMyHammerVotes(map) {
        try {
            localStorage.setItem(WALL_HAMMER_VOTES_KEY, JSON.stringify(map || {}));
        } catch (_) { /* quota */ }
    }

    function pruneMyHammerVotes(validIds) {
        const ids = validIds instanceof Set ? validIds : new Set(validIds || []);
        const map = loadMyHammerVotes();
        let changed = false;
        Object.keys(map).forEach((key) => {
            if (!ids.has(Number(key))) {
                delete map[key];
                changed = true;
            }
        });
        if (changed) saveMyHammerVotes(map);
        return map;
    }

    function hasMyHammerVote(id, item) {
        const voter = wallHammerVoterId();
        if (item && Array.isArray(item.hammers) && voter && item.hammers.includes(voter)) return true;
        if (item && item.myHammer) return true;
        return Boolean(loadMyHammerVotes()[String(id)]);
    }

    function ensurePostHammers(post) {
        if (!post) return [];
        if (!Array.isArray(post.hammers)) post.hammers = [];
        return post.hammers;
    }

    function syncPostHammerCount(post) {
        if (!post) return;
        const hammers = ensurePostHammers(post);
        const voter = wallHammerVoterId();
        post.myHammer = Boolean(voter && hammers.includes(voter));
        if (!post._fromServer) {
            post.hammerCount = hammers.length;
            return;
        }
        post.hammerCount = Math.max(0, Number(post.hammerCount) || 0);
    }

    function patchWallHammerUi(postId) {
        const item = wallItems.find((x) => x.id === Number(postId));
        if (!item) return;
        const count = wallHammerCount(item);
        const voted = hasMyHammerVote(item.id, item);
        document.querySelectorAll(`#wallFeedContainer [data-wall-hammer="${item.id}"]`).forEach((btn) => {
            const counter = btn.querySelector('.vote-btn__count');
            if (counter) {
                counter.textContent = String(count);
                counter.classList.toggle('is-muted', count === 0);
            }
            btn.classList.toggle('active', voted);
            btn.classList.toggle('is-voted', voted);
            btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
        });
    }

    function wallHammerVoterId() {
        const sync = getWallMySyncUserId();
        if (sync) return sync;
        const tab = getWallCurrentTab();
        if (tab) return `tab:${tab}`;
        return 'local-anon';
    }

    function removeWallPostFromFeed(id) {
        wallItems = wallItems.filter((x) => x.id !== id);
        const voteMap = loadMyHammerVotes();
        delete voteMap[String(id)];
        saveMyHammerVotes(voteMap);
        const likeMap = loadMyLikeVotes();
        delete likeMap[String(id)];
        saveMyLikeVotes(likeMap);
        saveWallItems();
        if (wallDetailPostId === id) closeWallDetail(false);
        renderWall();
    }

    function archiveWallPostWithFade(id) {
        const item = wallItems.find((x) => x.id === id);
        if (item) {
            item.isArchived = true;
            saveWallItems();
        }
        const card = document.querySelector(`#wallFeedContainer [data-wall-open="${id}"]`);
        if (card) {
            card.classList.add('wall-card--archiving');
            window.setTimeout(() => removeWallPostFromFeed(id), 340);
            return;
        }
        removeWallPostFromFeed(id);
    }

    function applyWallHammerThreshold(item) {
        if (!item) return;
        if (wallHammerCount(item) >= WALL_HAMMER_ARCHIVE_AT) {
            archiveWallPostWithFade(item.id);
        }
    }

    function snapshotHammerState(item) {
        return {
            hammers: Array.isArray(item.hammers) ? item.hammers.slice() : [],
            hammerCount: item.hammerCount,
            myHammer: item.myHammer,
        };
    }

    function restoreHammerState(item, snap) {
        if (!item || !snap) return;
        item.hammers = snap.hammers.slice();
        item.hammerCount = snap.hammerCount;
        item.myHammer = snap.myHammer;
        const map = loadMyHammerVotes();
        if (item.myHammer) map[String(item.id)] = true;
        else delete map[String(item.id)];
        saveMyHammerVotes(map);
        saveWallItems();
    }

    function applyHammerServerState(item, data) {
        if (!item || !data) return;
        const count = Math.max(0, Number(data.hammer_count) || 0);
        const userHammered = Boolean(
            data.user_hammered != null ? data.user_hammered : data.my_hammer
        );
        item.hammerCount = count;
        item.myHammer = userHammered;
        const voter = wallHammerVoterId();
        const hammers = ensurePostHammers(item);
        if (voter) {
            const idx = hammers.indexOf(voter);
            if (userHammered && idx < 0) hammers.push(voter);
            if (!userHammered && idx >= 0) hammers.splice(idx, 1);
        }
        if (!item._fromServer) {
            item.hammerCount = hammers.length;
        }
        const map = loadMyHammerVotes();
        if (userHammered) map[String(item.id)] = true;
        else delete map[String(item.id)];
        saveMyHammerVotes(map);
        saveWallItems();
    }

    function wallHammerErrorText(err) {
        const msg = err?.payload?.message;
        if (msg && String(msg).trim()) return String(msg).trim();
        if (err?.payload?.error === 'post_not_found') {
            return 'Запись не найдена или уже снята со стены.';
        }
        if (err?.payload?.error === 'wall_hammer_schema_missing') {
            return 'На сервере не настроены молотки. Нужна миграция crew-api.';
        }
        if (err?.status === 404 || err?.payload?.error === 'not_found') {
            return 'Молоток недоступен: обновите crew-api на сервере (POST …/hammer).';
        }
        return 'Не удалось поставить молоток. Попробуйте позже.';
    }

    function toggleHammerLocalState(item) {
        const voter = wallHammerVoterId();
        const hammers = ensurePostHammers(item);
        const map = loadMyHammerVotes();
        const key = String(item.id);
        const already = voter && hammers.includes(voter);
        let count = wallHammerCount(item);

        if (already) {
            const idx = hammers.indexOf(voter);
            if (idx >= 0) hammers.splice(idx, 1);
            delete map[key];
            count = Math.max(0, count - 1);
        } else if (voter) {
            hammers.push(voter);
            map[key] = true;
            count += 1;
        }

        item.hammerCount = count;
        syncPostHammerCount(item);
        if (!item._fromServer) {
            item.hammerCount = hammers.length;
        }
        saveMyHammerVotes(map);
        saveWallItems();
        return !already;
    }

    async function handleHammerClick(postId) {
        const id = Number(postId);
        const item = wallItems.find((x) => x.id === id);
        if (!item) return;

        if (wallPostUsesServerApi(item)) {
            const snap = snapshotHammerState(item);
            toggleHammerLocalState(item);
            patchWallHammerUi(id);
            renderWall();
            try {
                const data = await window.DaCrewApi.postWallHammer(id);
                applyHammerServerState(item, data);
                patchWallHammerUi(id);
                const archived = Boolean(
                    data?.is_archived != null ? data.is_archived : data?.archived
                );
                if (archived) {
                    archiveWallPostWithFade(id);
                } else {
                    renderWall();
                }
            } catch (err) {
                restoreHammerState(item, snap);
                patchWallHammerUi(id);
                renderWall();
                setStatus(wallHammerErrorText(err));
                window.setTimeout(() => setStatus(''), 4000);
            }
            return;
        }

        toggleHammerLocalState(item);
        if (wallHammerCount(item) >= WALL_HAMMER_ARCHIVE_AT) {
            applyWallHammerThreshold(item);
            return;
        }
        patchWallHammerUi(id);
        renderWall();
    }

    function applyWallHammerVote(id) {
        handleHammerClick(id);
    }

    async function toggleWallLikeVote(id) {
        const item = wallItems.find((x) => x.id === id);
        if (!item) return;

        if (wallPostUsesServerApi(item)) {
            try {
                const data = await window.DaCrewApi.postWallLike(id);
                item.likesCount = Math.max(0, Number(data?.likes_count) || 0);
                item.myLike = Boolean(data?.my_like);
                const map = loadMyLikeVotes();
                if (item.myLike) map[String(id)] = true;
                else delete map[String(id)];
                saveMyLikeVotes(map);
                saveWallItems();
                renderWall();
            } catch (err) {
                console.warn('[wall] like', err);
            }
            return;
        }

        const map = loadMyLikeVotes();
        const key = String(id);
        const voted = Boolean(map[key]);
        if (voted) {
            delete map[key];
            item.likesCount = Math.max(0, wallLikesCount(item) - 1);
            item.myLike = false;
        } else {
            map[key] = true;
            item.likesCount = wallLikesCount(item) + 1;
            item.myLike = true;
        }
        saveMyLikeVotes(map);
        saveWallItems();
        renderWall();
    }

    function toggleWallHammerVote(id) {
        handleHammerClick(id);
    }

    function normalizeWallItem(item) {
        const row = item && typeof item === 'object' ? { ...item } : {};
        if (!Array.isArray(row.hammers)) row.hammers = [];
        if (!row._fromServer) {
            row.hammerCount = row.hammers.length;
        } else {
            row.hammerCount = Math.max(0, Number(row.hammerCount ?? row.resolveVotes) || 0);
        }
        const voter = wallHammerVoterId();
        const votedInMap = Boolean(loadMyHammerVotes()[String(row.id)]);
        row.myHammer = Boolean(voter && row.hammers.includes(voter))
            || votedInMap
            || Boolean(row.myHammer);
        if (row.myHammer && voter && !row.hammers.includes(voter)) {
            row.hammers.push(voter);
        }
        if (!row.myHammer && voter) {
            const rm = row.hammers.indexOf(voter);
            if (rm >= 0) row.hammers.splice(rm, 1);
        }
        if (!row._fromServer) {
            row.hammerCount = row.hammers.length;
        }
        row.likesCount = wallLikesCount(row);
        row.commentsCount = Math.max(0, Number(row.commentsCount) || 0);
        row.isArchived = Boolean(row.isArchived || row.is_archived);
        row.resolved = false;
        return row;
    }

    function loadWallItems() {
        try {
            localStorage.removeItem('da_crew_wall_v1');
        } catch (_) { /* ignore */ }
        try {
            const raw = localStorage.getItem(WALL_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed)) {
                return parsed.map((item) => normalizeWallItem(item));
            }
        } catch (_) { /* empty */ }
        return defaultWallItems();
    }

    const WALL_HAMMER_INLINE = '<svg class="hammer-inline-svg" width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true"><g transform="translate(24 24) rotate(-45) translate(-24 -24)"><rect x="20.5" y="24" width="7" height="20" rx="3.5" fill="currentColor"/><rect x="5" y="10" width="38" height="11" rx="5.5" fill="currentColor"/></g></svg>';

    const WALL_EDIT_ICON = '<svg class="wall-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

    const WALL_DELETE_ICON = '<svg class="wall-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

    const WALL_COMMENTS_ICON = '<svg class="wall-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4z"/></svg>';

    const WALL_LIKE_ICON = '<svg class="wall-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>';

    function renderWallCommentsButton(item) {
        const n = Math.max(0, Number(item.commentsCount) || 0);
        return `<button type="button" class="action-btn wall-comments-btn wall-action-btn" data-wall-comments-open="${item.id}" aria-label="Комментарии, ${n}">
                ${WALL_COMMENTS_ICON}
                <span class="wall-comments-btn__count">${n}</span>
            </button>`;
    }

    function renderWallLikeButton(item) {
        const n = wallLikesCount(item);
        const voted = hasMyLikeVote(item.id, item);
        const countClass = n ? '' : ' is-muted';
        return `<button type="button" class="action-btn wall-like-btn wall-action-btn${voted ? ' active is-liked' : ''}" data-wall-like="${item.id}" aria-pressed="${voted ? 'true' : 'false'}" aria-label="Нравится, ${n}">
                ${WALL_LIKE_ICON}
                <span class="wall-like-btn__count${countClass}" aria-hidden="true">${n}</span>
            </button>`;
    }

    function renderWallHammerBlock(item) {
        const votes = wallHammerCount(item);
        const voted = hasMyHammerVote(item.id, item);
        const countClass = votes ? '' : ' is-muted';
        const label = voted ? 'Вы отметили запись как неактуальную' : 'Неактуально, спам или ошибка';
        return `
            <button type="button" class="action-btn vote-btn wall-action-btn btn-hammer${voted ? ' active is-voted' : ''}" data-wall-hammer="${item.id}" aria-pressed="${voted ? 'true' : 'false'}" aria-label="${label}" title="Молоток — неактуально / спам">
                <span class="hammer-icon-wrap" aria-hidden="true">${WALL_HAMMER_INLINE}</span>
                <span class="vote-btn__count${countClass}" aria-hidden="true">${votes}</span>
            </button>`;
    }

    function renderWallIconActions(item) {
        const comments = renderWallCommentsButton(item);
        const like = renderWallLikeButton(item);
        const hammer = renderWallHammerBlock(item);
        const canManage = wallIsCurrentUserAuthor(item);
        const editBtn = canManage
            ? `<button type="button" class="action-btn edit-btn wall-action-btn btn-doc" data-wall-edit="${item.id}" aria-label="Редактировать" title="Редактировать">${WALL_EDIT_ICON}</button>`
            : '';
        const deleteBtn = canManage
            ? `<button type="button" class="action-btn delete-btn wall-action-btn btn-delete" data-wall-delete="${item.id}" aria-label="Удалить" title="Удалить">${WALL_DELETE_ICON}</button>`
            : '';
        return `<div class="wall-card-actions">${comments}${like}${hammer}${editBtn}${deleteBtn}</div>`;
    }

    function wallCardMetaChipValues(item) {
        const chips = [];
        if (item?.tag) chips.push(String(item.tag).trim());
        const sub = cleanWallDanglingDashes(item?.subMeta);
        if (sub) {
            sub.split(/[•|]/).map((s) => s.trim()).filter(Boolean).forEach((part) => chips.push(part));
        }
        if (item?.text && item?.extraLine) {
            String(item.extraLine).split(/[•|;,]/).map((s) => s.trim()).filter(Boolean)
                .slice(0, 3).forEach((part) => chips.push(part));
        }
        if (item?.urgent) chips.push('Срочно');
        const seen = new Set();
        return chips.filter((c) => {
            const key = c.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, 8);
    }

    function renderWallMetaChips(item) {
        const values = wallCardMetaChipValues(item);
        if (!values.length) return '';
        return `<div class="wall-card-tags">${values.map((v) => {
            const tone = wallChipToneForLabel(v, item.category);
            return `<span class="wall-meta-chip wall-tone-${tone}">${escapeHtml(v)}</span>`;
        }).join('')}</div>`;
    }

    function renderWallCardHeader(item) {
        const time = wallCardTimeLabel(item);
        return `
                    <header class="wall-card-header">
                        <span class="wall-card-title">${escapeHtml(wallCardTitle(item))}</span>
                        ${time ? `<time class="wall-card-time" datetime="">${escapeHtml(time)}</time>` : '<span class="wall-card-time" aria-hidden="true"></span>'}
                    </header>`;
    }

    function renderWallEventCard(item, iconActions, opts = {}) {
        const detail = opts.detail ? ' wall-card--detail' : '';
        const openable = opts.detail ? '' : ' wall-card--clickable';
        const openAttr = opts.detail ? '' : ` data-wall-open="${item.id}"`;
        const body = item.text || (!item.text && item.extraLine ? item.extraLine : '');
        const footer = iconActions
            ? `<footer class="wall-card-footer">
                        <div class="author-tag">${escapeHtml(resolveWallAuthorTag(item))}</div>
                        ${iconActions}
                    </footer>`
            : `<footer class="wall-card-footer wall-card-footer--readonly">
                        <div class="author-tag">${escapeHtml(resolveWallAuthorTag(item))}</div>
                    </footer>`;
        return `
                <article class="wall-card wall-card--event${detail}${openable}${detail ? ' wall-card--pinned' : ''}${item.resolved ? ' is-resolved' : ''}${item.urgent ? ' is-urgent' : ''}"${openAttr}>
                    ${renderWallCardHeader(item)}
                    ${renderWallMetaChips(item)}
                    ${body ? `<div class="wall-card-content">${escapeHtml(body)}</div>` : ''}
                    ${footer}
                </article>
            `;
    }

    function syncWallHintsCollapsedUi() {
        const collapse = $('wallHintsCollapse');
        const footer = $('wallHintsGrab');
        const expanded = wallTagsExpanded;
        collapse?.classList.toggle('is-collapsed', !expanded);
        if (footer) {
            footer.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            footer.classList.toggle('is-collapsed', !expanded);
            footer.setAttribute(
                'aria-label',
                expanded ? 'Свернуть подсказки' : 'Развернуть подсказки'
            );
        }
        const toggle = $('wallTagsToggle');
        if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function toggleWallHintsExpanded() {
        wallTagsExpanded = !wallTagsExpanded;
        renderWallTagRow();
    }

    function saveWallItems() {
        try {
            localStorage.setItem(WALL_STORAGE_KEY, JSON.stringify(wallItems));
        } catch (_) { /* ignore quota */ }
    }

    function switchInstrMode(mode) {
        instrMainMode = mode === 'pdf' ? 'pdf' : 'wall';
        const wallPane = $('instrPaneWall');
        const pdfPane = $('instrPaneFiles');
        const topCard = $('instrTopCard');
        const wallBtn = $('instrModeWall');
        const pdfBtn = $('instrModePdf');
        const isWall = instrMainMode === 'wall';

        wallPane?.classList.toggle('active', isWall);
        pdfPane?.classList.toggle('active', !isWall);
        if (topCard) topCard.hidden = false;
        const wallFilters = $('wallFilterBlock');
        if (wallFilters) wallFilters.hidden = !isWall;
        const wallHints = $('wallTagExtra');
        if (wallHints) wallHints.hidden = !isWall;
        $('wallHintsGrab')?.toggleAttribute('hidden', !isWall);
        $('wallMetaBar')?.toggleAttribute('hidden', !isWall);
        updateSearchChrome();
        wallBtn?.classList.toggle('active', isWall);
        pdfBtn?.classList.toggle('active', !isWall);
        wallBtn?.setAttribute('aria-selected', isWall ? 'true' : 'false');
        pdfBtn?.setAttribute('aria-selected', isWall ? 'false' : 'true');
        setFabMenuOpen(false);
        if (isWall) {
            renderWall();
            scheduleWallRulesOnboarding();
        } else {
            if (wallRulesOnboardTimer) {
                window.clearTimeout(wallRulesOnboardTimer);
                wallRulesOnboardTimer = null;
            }
            refreshUi().catch(() => {});
        }
    }

    function updateSearchChrome() {
        const input = $('instrSearchInput');
        const hint = $('instrSearchHint');
        const block = $('instrSearchBlock');
        if (instrMainMode === 'wall') {
            if (input) input.placeholder = 'Поиск по записям';
            if (hint) hint.textContent = '';
        } else {
            if (input) input.placeholder = 'Поиск в тексте...';
            if (hint) hint.textContent = 'Поиск по словам внутри оцифрованных PDF с переходом на страницу.';
        }
        if (block && input) block.classList.toggle('has-query', Boolean(String(input.value || '').trim()));
    }

    function tagsForCategory(cat) {
        const make = (list, kind) => (list || []).map((value) => ({ value, kind }));
        if (cat === 'all') {
            const seen = new Set();
            const out = [];
            ['machines', 'line', 'office', 'contacts'].forEach((kind) => {
                make(WALL_FORM_CONFIG[kind].chips, kind).forEach((item) => {
                    if (seen.has(item.value)) return;
                    seen.add(item.value);
                    out.push(item);
                });
            });
            return out;
        }
        const cfg = WALL_FORM_CONFIG[cat] || {};
        return [...make(cfg.chips, cat), ...make(cfg.series, 'series')];
    }

    function itemMatchesTag(item, tag) {
        if (!tag) return true;
        const series = WALL_FORM_CONFIG.machines.series || [];
        if (series.includes(tag)) {
            return normalizeText(item.objectTitle || '').includes(normalizeText(tag));
        }
        const a = normalizeText(item.tag || '');
        const b = normalizeText(tag);
        return a === b || a.includes(b) || b.includes(a);
    }

    let wallTagsExpanded = false;

    function formatWallPostTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (d.toDateString() === now.toDateString()) return `Сегодня, ${hm}`;
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `Вчера, ${hm}`;
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}, ${hm}`;
    }

    function wallCardTimeLabel(item) {
        if (item?.time && String(item.time).trim()) return String(item.time).trim();
        if (item?.createdAt) {
            const fromTs = formatWallPostTime(new Date(item.createdAt).toISOString());
            if (fromTs) return fromTs;
        }
        return '';
    }

    function cleanWallDanglingDashes(text) {
        let s = String(text || '').trim();
        if (!s) return '';
        s = s.replace(/(?:\s*[-–—/•·]\s*)+$/g, '').trim();
        s = s.replace(/^(?:\s*[-–—/•·]\s*)+/g, '').trim();
        s = s.replace(/([-–—])\s*$/g, '').trim();
        return s;
    }

    function wallCardTitle(item) {
        return cleanWallDanglingDashes(item?.objectTitle) || 'Запись';
    }

    function wallCardSubLine(item) {
        const parts = [];
        const sub = cleanWallDanglingDashes(item?.subMeta);
        if (sub) parts.push(sub);
        const time = wallCardTimeLabel(item);
        if (time) parts.push(time);
        return parts.join(' • ');
    }

    function resolveWallAuthorTag(item) {
        const tab = String(item?.authorTab || '').trim();
        if (tab) return `Таб. ${tab}`;
        return item?.authorDepot || 'Депо';
    }

    function updateWallTagsToggle(tags) {
        const toggle = $('wallTagsToggle');
        const extra = $('wallTagExtra');
        if (!toggle || !extra) return;
        const hasTags = (tags || []).length > 0;
        extra.hidden = !hasTags;
        if (!hasTags) return;
        const active = activeWallTag ? ` · ${activeWallTag}` : '';
        toggle.textContent = wallTagsExpanded ? `Скрыть теги${active}` : `Доп. фильтры${active}`;
        toggle.setAttribute('aria-expanded', wallTagsExpanded ? 'true' : 'false');
        toggle.classList.toggle('has-active-tag', Boolean(activeWallTag));
    }

    function renderWallTagRow() {
        const row = $('wallTagRow');
        if (!row) return;
        const tags = tagsForCategory(activeWallCategory);
        if (activeWallTag && !tags.some((t) => t.value === activeWallTag)) activeWallTag = '';
        row.innerHTML = tags.map((t) => {
            const cat = t.kind === 'series' ? 'machines' : (t.kind || activeWallCategory);
            const tone = wallChipToneForLabel(t.value, cat === 'all' ? 'machines' : cat);
            return `<button type="button" class="wall-filter-tag wall-tone-${tone}${t.value === activeWallTag ? ' is-active' : ''}${t.kind === 'series' ? ' is-series' : ''}" data-wall-filter-tag="${escapeHtml(t.value)}">${escapeHtml(t.value)}</button>`;
        }).join('');
        row.hidden = instrMainMode !== 'wall' || !tags.length;
        updateWallTagsToggle(tags);
        syncWallHintsCollapsedUi();
    }

    function setWallCategory(cat) {
        activeWallCategory = cat || 'all';
        document.querySelectorAll('.wall-cat-pill').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.cat === activeWallCategory);
        });
        renderWallTagRow();
        renderWall();
    }

    function setWallTag(tag) {
        activeWallTag = activeWallTag === tag ? '' : (tag || '');
        if (activeWallTag) wallTagsExpanded = true;
        renderWallTagRow();
        renderWall();
    }

    function renderWall() {
        const container = $('wallFeedContainer');
        const countLabel = $('wallCountLabel');
        if (!container) return;
        pruneMyHammerVotes(wallItems.map((x) => x.id));
        const query = normalizeText($('instrSearchInput')?.value || '');

        const filtered = wallItems.filter((item) => {
            if (item.isArchived) return false;
            if (activeWallCategory === 'all' && !query && !activeWallTag && item.category === 'contacts') return false;
            if (activeWallCategory !== 'all' && item.category !== activeWallCategory) return false;
            if (!itemMatchesTag(item, activeWallTag)) return false;
            if (!query) return true;
            const hay = normalizeText(`${item.objectTitle} ${item.subMeta || ''} ${item.tag} ${item.text} ${item.extraLine || ''} ${item.phone || ''}`);
            return hay.includes(query);
        });

        if (countLabel) {
            countLabel.textContent = `Записей: ${filtered.length}`;
        }

        if (!filtered.length) {
            container.innerHTML = '<p class="wall-empty">По фильтру записей нет. Нажмите +, чтобы добавить сводку.</p>';
            return;
        }

        container.innerHTML = filtered.map((item) => {
            const iconActions = renderWallIconActions(item);
            if (item.category === 'contacts') {
                const tel = String(item.phone || '').replace(/[^\d+]/g, '');
                return `
                    <article class="wall-card wall-card--contact wall-card--clickable" data-wall-open="${item.id}">
                        ${renderWallCardHeader(item)}
                        ${renderWallMetaChips(item)}
                        <div class="wall-contact-phone-row">
                            <a class="wall-card-phone" href="tel:${escapeHtml(tel)}">${escapeHtml(item.phone || '')}</a>
                            <a class="wall-call" href="tel:${escapeHtml(tel)}" aria-label="Позвонить">
                                <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
                            </a>
                        </div>
                        ${item.text ? `<div class="wall-card-content wall-card-content--contact">${escapeHtml(item.text)}</div>` : ''}
                        <footer class="wall-card-footer wall-card-footer--contact">
                            <div class="author-tag">${escapeHtml(resolveWallAuthorTag(item))}</div>
                            ${iconActions}
                        </footer>
                    </article>
                `;
            }
            return renderWallEventCard(item, iconActions);
        }).join('');
    }

    function syncWallModalChrome() {
        const title = $('wallCreateTitle');
        const submit = $('wallSubmitBtn');
        if (wallEditingId) {
            if (title) title.textContent = 'Редактировать запись';
            if (submit) submit.textContent = 'Сохранить';
        } else {
            if (title) title.textContent = 'Добавить на Стену';
            if (submit) submit.textContent = 'Опубликовать на Стену';
        }
    }

    function syncWallChipActiveState() {
        document.querySelectorAll('.wall-chip').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.wallChip === selectedChipTag);
        });
    }

    function syncMachineSeriesHighlight(title) {
        const value = String(title || '');
        const seriesList = WALL_FORM_CONFIG.machines.series || [];
        if (!value && selectedMachineSeries) {
            document.querySelectorAll('[data-wall-series]').forEach((el) => {
                el.classList.toggle('is-active', el.dataset.wallSeries === selectedMachineSeries);
            });
            return;
        }
        document.querySelectorAll('[data-wall-series]').forEach((el) => {
            const series = el.dataset.wallSeries || '';
            el.classList.toggle('is-active', series && (
                value.toLowerCase().startsWith(`${series.toLowerCase()} `)
                || value.toLowerCase().startsWith(`${series.toLowerCase()}-`)
                || value.toLowerCase() === series.toLowerCase()
                || series === selectedMachineSeries
            ));
        });
    }

    function syncMachinePartHighlight(subMeta) {
        const value = String(subMeta || '');
        let matched = '';
        (WALL_FORM_CONFIG.machines.parts || []).forEach((part) => {
            if (value.toLowerCase().startsWith(`${part.toLowerCase()} `)
                || value.toLowerCase().startsWith(`${part.toLowerCase()}-`)
                || value.toLowerCase() === part.toLowerCase()) {
                matched = part;
            }
        });
        if (matched) selectedMachinePart = matched;
        document.querySelectorAll('[data-wall-part]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.wallPart === selectedMachinePart);
        });
    }

    function populateWallFormFields(item) {
        if (!item) return;
        const chips = WALL_FORM_CONFIG[item.category]?.chips || [];
        selectedChipTag = chips.includes(item.tag) ? item.tag : (chips[0] || item.tag || '');
        const descEl = $('f_desc');
        const filler = 'Добавлено с линии';
        const descParts = [item.text, item.extraLine].filter((s) => s && String(s).trim() && String(s).trim() !== filler);
        if (descEl) descEl.value = descParts.join('\n');

        if (item.category === 'machines') {
            const parsed = parseMachineTitleForForm(item.objectTitle);
            selectedMachineSeries = parsed.series || selectedMachineSeries;
            const numEl = $('f_machine_num');
            const subEl = $('f_sub');
            if (numEl) numEl.value = parsed.number || '';
            if (subEl) {
                subEl.value = item.subMeta || '';
                syncMachinePartHighlight(subEl.value);
            }
            syncMachineSeriesHighlight(item.objectTitle || selectedMachineSeries);
        } else if (item.category === 'line') {
            const placeEl = $('f_place');
            if (placeEl) placeEl.value = item.objectTitle || '';
            const meta = String(item.subMeta || '');
            const pathMatch = meta.match(/(\d+)\s*путь/i);
            const kmPart = meta.split('•').map((s) => s.trim()).filter(Boolean).find((s) => !/путь/i.test(s));
            const pathEl = $('f_path');
            const kmEl = $('f_km');
            if (pathEl && pathMatch) pathEl.value = pathMatch[1];
            if (kmEl && kmPart) kmEl.value = kmPart;
        } else if (item.category === 'office') {
            const dateEl = $('f_date');
            const deadline = String(item.subMeta || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
            if (dateEl && deadline) {
                dateEl.value = `${deadline[3]}-${deadline[2]}-${deadline[1]}`;
            }
        } else if (item.category === 'contacts') {
            const nameEl = $('f_contact_name');
            const phoneEl = $('f_phone');
            const nameParts = [item.objectTitle, item.subMeta].filter(Boolean).map((s) => String(s).trim());
            if (nameEl) nameEl.value = nameParts.join(' ').trim();
            if (phoneEl) phoneEl.value = item.phone || '+7 ';
        }
        syncWallChipActiveState();
    }

    function openWallModal(editId = null) {
        const modal = $('wallCreateModal');
        if (!modal) return;
        wallEditingId = editId ? Number(editId) : null;
        if (wallEditingId) {
            const item = wallItems.find((x) => x.id === wallEditingId);
            if (!item || !wallIsCurrentUserAuthor(item)) {
                wallEditingId = null;
            } else {
                currentFormType = item.category;
                document.querySelectorAll('.wall-form-tab').forEach((btn) => {
                    btn.classList.toggle('is-active', btn.dataset.formType === currentFormType);
                });
                renderWallForm();
                populateWallFormFields(item);
                syncWallModalChrome();
                modal.hidden = false;
                modal.setAttribute('aria-hidden', 'false');
                document.body.classList.add('release-overlay-open');
                return;
            }
        }
        const initial = activeWallCategory !== 'all' ? activeWallCategory : 'machines';
        selectWallFormType(initial);
        syncWallModalChrome();
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('release-overlay-open');
    }

    function closeWallModal() {
        const modal = $('wallCreateModal');
        if (!modal) return;
        wallEditingId = null;
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('release-overlay-open');
        syncWallModalChrome();
    }

    function selectWallFormType(type) {
        currentFormType = WALL_FORM_CONFIG[type] ? type : 'machines';
        selectedChipTag = WALL_FORM_CONFIG[currentFormType].chips[0];
        if (currentFormType === 'machines') {
            selectedMachineSeries = WALL_FORM_CONFIG.machines.series[0];
            selectedMachinePart = WALL_FORM_CONFIG.machines.parts[0];
        }
        document.querySelectorAll('.wall-form-tab').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.formType === currentFormType);
        });
        renderWallForm();
    }

    function formatPhoneMask(value) {
        let digits = String(value || '').replace(/\D/g, '');
        if (digits.startsWith('7') || digits.startsWith('8')) digits = digits.slice(1);
        digits = digits.slice(0, 10);
        let formatted = '+7';
        if (digits.length) formatted += ' (' + digits.slice(0, 3);
        if (digits.length >= 4) formatted += ') ' + digits.slice(3, 6);
        if (digits.length >= 7) formatted += ' ' + digits.slice(6, 8);
        if (digits.length >= 9) formatted += ' ' + digits.slice(8, 10);
        return formatted;
    }

    function applyMachineSeries(series) {
        if (!series) return;
        selectedMachineSeries = series;
        document.querySelectorAll('[data-wall-series]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.wallSeries === series);
        });
        $('f_machine_num')?.focus();
    }

    function applyMachinePart(part) {
        const input = $('f_sub');
        if (!input || !part) return;
        const list = WALL_FORM_CONFIG.machines.parts || [];
        let rest = String(input.value || '').trim();
        list.forEach((p) => {
            const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rest = rest.replace(new RegExp(`^\\+?${esc}-?`, 'i'), '');
        });
        rest = rest.replace(/^\s+/, '');
        input.value = rest ? `${part} ${rest}` : part;
        selectedMachinePart = part;
        input.focus();
        const pos = input.value.length;
        try { input.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
        document.querySelectorAll('[data-wall-part]').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.wallPart === part);
        });
    }

    function renderWallForm() {
        const box = $('wallDynamicFields');
        if (!box) return;
        const chipsHtml = WALL_FORM_CONFIG[currentFormType].chips.map((c) => (
            wallFormChipButton(c, currentFormType, c === selectedChipTag, `data-wall-chip="${escapeHtml(c)}"`)
        )).join('');

        if (currentFormType === 'machines') {
            const partsHtml = WALL_FORM_CONFIG.machines.parts.map((p) => (
                `<button type="button" class="wall-series wall-part wall-tone-place${p === selectedMachinePart ? ' is-active' : ''}" data-wall-part="${escapeHtml(p)}">${escapeHtml(p)}</button>`
            )).join('');
            const seriesHtml = WALL_FORM_CONFIG.machines.series.map((s) => (
                `<button type="button" class="wall-series wall-tone-office${s === selectedMachineSeries ? ' is-active' : ''}" data-wall-series="${escapeHtml(s)}">${escapeHtml(s)}</button>`
            )).join('');
            box.innerHTML = `
                <div class="wall-field">
                    <label>Машина</label>
                    <div class="wall-machine-row">
                        <div class="wall-chip-row wall-form-chip-scroll">${seriesHtml}</div>
                        <input id="f_machine_num" type="text" inputmode="numeric" autocomplete="off" placeholder="Номер (045)">
                    </div>
                </div>
                <div class="wall-field">
                    <label>Вагон</label>
                    <div class="wall-chip-row wall-form-chip-scroll wall-part-row">${partsHtml}</div>
                    <input id="f_sub" type="text" autocomplete="off" placeholder="Или укажите номер вагона">
                </div>
                <div class="wall-field">
                    <label>Неисправность</label>
                    <div class="wall-chip-row wall-form-chip-scroll">${chipsHtml}</div>
                </div>
                ${wallFormDescBlock('Описание')}
            `;
        } else if (currentFormType === 'line') {
            box.innerHTML = `
                <div class="wall-field">
                    <label>Объект</label>
                    <div class="wall-chip-row wall-form-chip-scroll">${chipsHtml}</div>
                    <input id="f_place" type="text" placeholder="Станция или перегон">
                </div>
                <div class="wall-grid-2">
                    <div class="wall-field"><label>Путь</label><input id="f_path" type="text" inputmode="numeric" placeholder="Путь (1, 2)"></div>
                    <div class="wall-field"><label>КМ / ПК</label><input id="f_km" type="text" placeholder="Км / Пк"></div>
                </div>
                ${wallFormDescBlock('Суть замечания')}
            `;
        } else if (currentFormType === 'office') {
            const today = new Date();
            const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            box.innerHTML = `
                <div class="wall-field">
                    <label>Тема</label>
                    <div class="wall-chip-row wall-form-chip-scroll">${chipsHtml}</div>
                </div>
                <div class="wall-field"><label>Срок</label><input id="f_date" type="date" value="${iso}"></div>
                ${wallFormDescBlock('Описание')}
            `;
        } else {
            box.innerHTML = `
                <div class="wall-field">
                    <label>ФИО или должность</label>
                    <input id="f_contact_name" type="text" autocomplete="name" placeholder="Например: Дежурный по депо, Нарядчик">
                </div>
                <div class="wall-field"><label>Служба</label><div class="wall-chip-row wall-form-chip-scroll">${chipsHtml}</div></div>
                <div class="wall-field"><label>Телефон</label><input id="f_phone" type="tel" value="+7 " placeholder="+7 (999) 000 00 00"></div>
                <div class="wall-field wall-field--desc">
                    <label>Пометка</label>
                    <textarea id="f_desc" rows="2" placeholder="По каким вопросам обращаться"></textarea>
                </div>
            `;
        }
    }

    function buildWallApiCardFromSubmit(payload, formType) {
        const category = WALL_API_CATEGORY[formType] || WALL_API_CATEGORY.machines;
        let train_series = null;
        let machine_number = null;
        const title = String(payload.objectTitle || '').trim();
        if (formType === 'machines') {
            const seriesList = WALL_FORM_CONFIG.machines.series || [];
            seriesList.forEach((s) => {
                if (title.toUpperCase().includes(String(s).toUpperCase())) train_series = s;
            });
            const numMatch = title.match(/(\d{2,4})/);
            machine_number = numMatch ? numMatch[1] : title.replace(/^Машина\s+/i, '').trim();
        }
        const description = String(payload.text || '').trim();
        return {
            category,
            train_series,
            machine_number,
            car_part: payload.subMeta || null,
            issue_tag: payload.tag || null,
            title,
            description: description || title
        };
    }

    function mapApiWallRowToLocal(row) {
        const category = WALL_API_CATEGORY_REVERSE[row.category] || 'machines';
        return {
            id: Number(row.id) || Date.now(),
            category,
            objectTitle: cleanWallDanglingDashes(row.title || '') || 'Запись',
            subMeta: cleanWallDanglingDashes(row.car_part || ''),
            tag: row.issue_tag || '',
            text: row.description || '',
            extraLine: '',
            time: formatWallPostTime(row.created_at) || 'Стена депо',
            authorTab: row.author_tab_number || '',
            authorSyncUserId: row.author_sync_user_id || '',
            createdAt: row.created_at ? Date.parse(row.created_at) : undefined,
            hammerCount: Math.max(0, Number(row.hammer_count) || 0),
            hammers: [],
            myHammer: Boolean(row.my_hammer),
            likesCount: Math.max(0, Number(row.likes_count) || 0),
            myLike: Boolean(row.my_like),
            commentsCount: Number(row.comments_count) || 0,
            isArchived: Boolean(row.is_archived),
            resolved: false,
            _fromServer: true
        };
    }

    window.daCrewWallApplySync = function daCrewWallApplySync(rows) {
        const prevAll = loadWallItems();
        const prevById = new Map(prevAll.map((p) => [p.id, p]));
        const serverItems = (Array.isArray(rows) ? rows : []).map(mapApiWallRowToLocal);
        const hammerMap = loadMyHammerVotes();
        const likeMap = loadMyLikeVotes();
        const voter = wallHammerVoterId();
        serverItems.forEach((item) => {
            const prev = prevById.get(item.id);
            if (prev && Array.isArray(prev.hammers) && prev.hammers.length) {
                item.hammers = prev.hammers.slice();
                item.hammerCount = item.hammers.length;
            } else {
                ensurePostHammers(item);
                if (item.myHammer && voter && !item.hammers.includes(voter)) {
                    item.hammers.push(voter);
                }
                item.hammerCount = Math.max(Number(item.hammerCount) || 0, item.hammers.length);
            }
            syncPostHammerCount(item);
            if (item.myHammer) hammerMap[String(item.id)] = true;
            if (item.myLike) likeMap[String(item.id)] = true;
        });
        saveMyHammerVotes(hammerMap);
        saveMyLikeVotes(likeMap);
        const apiOn = Boolean(window.DaCrewApi?.isEnabled?.());
        if (apiOn) {
            wallItems = serverItems.map((item) => normalizeWallItem(item));
        } else {
            const localOnly = prevAll.filter((item) => !item._fromServer && !item.isArchived);
            wallItems = [...serverItems, ...localOnly];
        }
        saveWallItems();
        renderWall();
    };

    function getWallMySyncUserId() {
        if (window.DaCrewApi?.getSyncUserId) {
            return String(window.DaCrewApi.getSyncUserId() || '').trim();
        }
        return typeof getOrCreateSyncUserId === 'function' ? String(getOrCreateSyncUserId() || '').trim() : '';
    }

    function loadLocalWallCommentsMap() {
        try {
            const raw = localStorage.getItem(WALL_COMMENTS_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function saveLocalWallCommentsMap(map) {
        try {
            localStorage.setItem(WALL_COMMENTS_STORAGE_KEY, JSON.stringify(map || {}));
        } catch (_) { /* quota */ }
    }

    function getLocalWallComments(postId) {
        const map = loadLocalWallCommentsMap();
        const list = map[String(postId)];
        return Array.isArray(list) ? list.slice() : [];
    }

    function appendLocalWallComment(postId, comment) {
        const map = loadLocalWallCommentsMap();
        const key = String(postId);
        const list = Array.isArray(map[key]) ? map[key].slice() : [];
        list.push(comment);
        map[key] = list;
        saveLocalWallCommentsMap(map);
        return list;
    }

    function wallPostUsesServerApi(item) {
        return Boolean(item && item._fromServer && window.DaCrewApi?.isEnabled?.());
    }

    function wallDetailScreenTitle(item) {
        return `${wallCardTitle(item)} • Обсуждение`;
    }

    function wallCommentAuthorLabel(c) {
        const tab = String(c.user_tab_number || c.userTab || '').trim();
        if (tab) return `Таб. ${tab}`;
        const role = String(c.author_role || c.authorRole || '').trim();
        if (role) return role;
        return 'Депо';
    }

    function wallCommentInitials(c) {
        const tab = String(c.user_tab_number || c.userTab || '').trim();
        if (tab.length >= 2) return tab.slice(-2);
        const role = String(c.author_role || c.authorRole || 'Д').trim();
        return role.slice(0, 2).toUpperCase();
    }

    function mapApiCommentRow(row) {
        return {
            id: Number(row.id),
            postId: Number(row.post_id),
            userSyncId: String(row.user_sync_id || ''),
            userTab: row.user_tab_number || '',
            authorRole: row.author_role || '',
            messageText: row.message_text || '',
            createdAt: row.created_at || new Date().toISOString()
        };
    }

    function bumpWallItemCommentCount(postId, delta) {
        const item = wallItems.find((x) => x.id === postId);
        if (!item) return;
        item.commentsCount = Math.max(0, (Number(item.commentsCount) || 0) + (delta || 0));
        saveWallItems();
    }

    function wallCommentTimeShort(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function renderWallDetailContactCard(item) {
        const tel = String(item.phone || '').replace(/[^\d+]/g, '');
        return `
            <article class="wall-card wall-card--contact wall-card--detail wall-card--pinned${item.resolved ? ' is-resolved' : ''}">
                ${renderWallCardHeader(item)}
                ${renderWallMetaChips(item)}
                <div class="wall-contact-phone-row">
                    <a class="wall-card-phone" href="tel:${escapeHtml(tel)}">${escapeHtml(item.phone || '')}</a>
                </div>
                ${item.text ? `<div class="wall-card-content wall-card-content--contact">${escapeHtml(item.text)}</div>` : ''}
                <footer class="wall-card-footer wall-card-footer--readonly">
                    <div class="author-tag">${escapeHtml(resolveWallAuthorTag(item))}</div>
                </footer>
            </article>`;
    }

    function renderWallDetailPost(item) {
        if (item.category === 'contacts') {
            return renderWallDetailContactCard(item);
        }
        return renderWallEventCard(item, '', { detail: true });
    }

    function renderWallDetailComment(c) {
        const mine = c.userSyncId && c.userSyncId === getWallMySyncUserId();
        const time = wallCommentTimeShort(c.createdAt) || '';
        const text = escapeHtml(c.messageText || '');
        const timeHtml = time ? `<time class="wall-detail-msg__time" datetime="">${escapeHtml(time)}</time>` : '';
        if (mine) {
            return `
            <div class="wall-detail-msg is-mine">
                <div class="wall-detail-msg__bubble">
                    <span class="wall-detail-msg__text">${text}</span>${timeHtml}
                </div>
            </div>`;
        }
        const author = escapeHtml(wallCommentAuthorLabel(c));
        return `
            <div class="wall-detail-msg">
                <span class="wall-detail-msg__avatar" aria-hidden="true">${escapeHtml(wallCommentInitials(c))}</span>
                <div class="wall-detail-msg__bubble">
                    <div class="wall-detail-msg__author">${author}</div>
                    <span class="wall-detail-msg__text">${text}</span>${timeHtml}
                </div>
            </div>`;
    }

    function renderWallDetailThread() {
        const host = $('wallDetailThread');
        if (!host) return;
        if (!wallDetailComments.length) {
            host.innerHTML = '<p class="wall-detail__empty">Пока нет комментариев. Напишите уточнение или ответ.</p>';
            return;
        }
        host.innerHTML = wallDetailComments.map(renderWallDetailComment).join('');
    }

    function scrollWallDetailToBottom() {
        const sc = $('wallDetailScroll');
        if (!sc) return;
        window.requestAnimationFrame(() => {
            sc.scrollTop = sc.scrollHeight;
        });
    }

    function setWallDetailOpen(open) {
        const layer = $('wallDetailLayer');
        if (!layer) return;
        layer.hidden = !open;
        layer.setAttribute('aria-hidden', open ? 'false' : 'true');
        layer.classList.toggle('is-open', open);
        document.documentElement.classList.toggle('wall-detail-open', open);
        document.body.classList.toggle('wall-detail-open', open);
        if (open) setFabMenuOpen(false);
    }

    async function loadWallDetailComments(postId) {
        const item = wallItems.find((x) => x.id === postId);
        if (!item) {
            wallDetailComments = [];
            renderWallDetailThread();
            return;
        }
        if (wallPostUsesServerApi(item)) {
            try {
                const data = await window.DaCrewApi.fetchWallComments(postId);
                wallDetailComments = (data.comments || []).map(mapApiCommentRow);
                const serverCount = wallDetailComments.length;
                if ((Number(item.commentsCount) || 0) !== serverCount) {
                    item.commentsCount = serverCount;
                    saveWallItems();
                    renderWall();
                }
            } catch (err) {
                console.warn('[wall] comments load', err);
                wallDetailComments = getLocalWallComments(postId);
            }
        } else {
            wallDetailComments = getLocalWallComments(postId);
        }
        renderWallDetailThread();
        scrollWallDetailToBottom();
    }

    function openWallDetail(postId, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const id = Number(postId);
        const item = wallItems.find((x) => x.id === id);
        if (!item) return;
        wallDetailPostId = id;
        const titleEl = $('wallDetailTitle');
        const postHost = $('wallDetailPost');
        if (titleEl) titleEl.textContent = wallDetailScreenTitle(item);
        if (postHost) postHost.innerHTML = renderWallDetailPost(item);
        setWallDetailOpen(true);
        if (!opts.skipHistory && !wallDetailHistoryActive) {
            const state = { [WALL_DETAIL_HISTORY_KEY]: id };
            history.pushState(state, '', `#wall/${id}`);
            wallDetailHistoryActive = true;
        } else if (opts.skipHistory) {
            wallDetailHistoryActive = true;
        }
        loadWallDetailComments(id);
        const input = $('wallCommentInput');
        if (input && !opts.skipHistory) {
            window.setTimeout(() => input.focus(), 280);
        }
    }

    function closeWallDetail(fromPopstate) {
        wallDetailPostId = null;
        wallDetailComments = [];
        setWallDetailOpen(false);
        const input = $('wallCommentInput');
        if (input) input.value = '';
        if (wallDetailHistoryActive && !fromPopstate) {
            wallDetailHistoryActive = false;
            history.back();
            return;
        }
        wallDetailHistoryActive = false;
    }

    function onWallDetailPopstate(ev) {
        const st = ev.state;
        if (wallDetailPostId != null && (!st || st[WALL_DETAIL_HISTORY_KEY] == null)) {
            wallDetailPostId = null;
            wallDetailComments = [];
            setWallDetailOpen(false);
            const input = $('wallCommentInput');
            if (input) input.value = '';
            wallDetailHistoryActive = false;
        } else if (st && st[WALL_DETAIL_HISTORY_KEY] != null) {
            openWallDetail(st[WALL_DETAIL_HISTORY_KEY], { skipHistory: true });
        }
    }

    async function submitWallDetailComment() {
        const postId = wallDetailPostId;
        if (!postId) return;
        const input = $('wallCommentInput');
        const text = String(input?.value || '').trim();
        if (!text) return;
        const item = wallItems.find((x) => x.id === postId);
        if (!item) return;
        const sendBtn = $('wallCommentSend');
        if (sendBtn) sendBtn.disabled = true;

        const optimistic = {
            id: Date.now(),
            postId,
            userSyncId: getWallMySyncUserId(),
            userTab: window.DaCrewApi?.getTabNumber?.() || '',
            authorRole: '',
            messageText: text,
            createdAt: new Date().toISOString()
        };

        try {
            if (wallPostUsesServerApi(item)) {
                const data = await window.DaCrewApi.postWallComment(postId, text);
                const row = data.comment ? mapApiCommentRow(data.comment) : optimistic;
                wallDetailComments.push(row);
            } else {
                appendLocalWallComment(postId, optimistic);
                wallDetailComments.push(optimistic);
            }
            bumpWallItemCommentCount(postId, 1);
            if (input) input.value = '';
            renderWallDetailThread();
            renderWall();
            scrollWallDetailToBottom();
        } catch (err) {
            console.warn('[wall] comment send', err);
            setStatus('Не удалось отправить комментарий');
            window.setTimeout(() => setStatus(''), 2500);
        } finally {
            if (sendBtn) sendBtn.disabled = false;
            input?.focus();
        }
    }

    function submitWallItem() {
        const subEl = $('f_sub');
        const pathEl = $('f_path');
        const kmEl = $('f_km');
        const descEl = $('f_desc');
        const dateEl = $('f_date');
        const phoneEl = $('f_phone');
        const rawText = (descEl && descEl.value.trim()) || '';
        let subMeta = subEl ? subEl.value.trim() : '';
        if (currentFormType === 'machines') {
            subMeta = subEl ? subEl.value.trim() : '';
        } else if (currentFormType === 'line') {
            const path = pathEl ? pathEl.value.trim() : '';
            const km = kmEl ? kmEl.value.trim() : '';
            subMeta = [path ? `${path} путь` : '', km].filter(Boolean).join(' • ');
        } else if (currentFormType === 'office' && dateEl && dateEl.value) {
            const parts = dateEl.value.split('-');
            subMeta = `Срок: ${parts[2]}.${parts[1]}.${parts[0]}`;
        } else if (currentFormType === 'contacts') {
            subMeta = '';
        }
        const defaultText = currentFormType === 'contacts' ? '' : 'Добавлено с линии';
        const payload = {
            category: currentFormType,
            objectTitle: buildWallObjectTitle(currentFormType),
            subMeta: cleanWallDanglingDashes(subMeta),
            tag: selectedChipTag,
            text: rawText || defaultText,
            extraLine: '',
            phone: phoneEl ? phoneEl.value.trim() : '',
        };
        const authorTab = String(window.DaCrewApi?.getTabNumber?.() || '').trim();
        const authorSyncUserId = getWallMySyncUserId();
        if (wallEditingId) {
            const idx = wallItems.findIndex((x) => x.id === wallEditingId);
            if (idx >= 0 && wallIsCurrentUserAuthor(wallItems[idx])) {
                wallItems[idx] = {
                    ...wallItems[idx],
                    ...payload,
                    authorTab: wallItems[idx].authorTab || authorTab,
                    time: wallItems[idx].time || wallCardTimeLabel({ createdAt: Date.now() }) || 'Только что',
                };
            }
        } else {
            wallItems.unshift({
                id: Date.now(),
                ...payload,
                authorTab,
                authorSyncUserId,
                createdAt: Date.now(),
                time: formatWallPostTime(new Date().toISOString()) || 'Только что',
                hammerCount: 0,
                hammers: [],
                likesCount: 0,
                resolved: false,
            });
        }
        const wasEdit = Boolean(wallEditingId);
        saveWallItems();
        if (!wasEdit && window.DaCrewApi?.isEnabled?.()) {
            const apiCard = buildWallApiCardFromSubmit(payload, currentFormType);
            window.DaCrewApi.postToWall(apiCard).catch((err) => {
                console.warn('[crew-api] wall post', err);
            });
        }
        closeWallModal();
        setWallCategory(currentFormType);
        setStatus(wasEdit ? 'Запись обновлена' : 'Запись добавлена на Стену');
        window.setTimeout(() => setStatus(''), 2000);
    }

    const WALL_RULES_SEEN_KEY = 'wall_rules_seen_v1';
    let wallRulesOnboardTimer = null;

    function markWallRulesSeen() {
        try {
            localStorage.setItem(WALL_RULES_SEEN_KEY, 'true');
        } catch (_) { /* quota */ }
    }

    function openWallRulesModal() {
        const modal = $('wallRulesModal');
        if (!modal) return;
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('release-overlay-open');
    }

    function closeWallRulesModal() {
        const modal = $('wallRulesModal');
        if (!modal) return;
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('release-overlay-open');
        markWallRulesSeen();
    }

    function scheduleWallRulesOnboarding() {
        try {
            if (localStorage.getItem(WALL_RULES_SEEN_KEY)) return;
        } catch (_) { /* ignore */ }
        if (wallRulesOnboardTimer) window.clearTimeout(wallRulesOnboardTimer);
        wallRulesOnboardTimer = window.setTimeout(() => {
            wallRulesOnboardTimer = null;
            if (instrMainMode !== 'wall') return;
            try {
                if (localStorage.getItem(WALL_RULES_SEEN_KEY)) return;
            } catch (_) { /* ignore */ }
            openWallRulesModal();
        }, 400);
    }

    function bindWallUi() {
        wallItems = loadWallItems();
        $('instrModeWall')?.addEventListener('click', () => switchInstrMode('wall'));
        $('instrModePdf')?.addEventListener('click', () => switchInstrMode('pdf'));
        document.querySelectorAll('.wall-cat-pill').forEach((btn) => {
            btn.addEventListener('click', () => setWallCategory(btn.dataset.cat));
        });
        $('wallTagsToggle')?.addEventListener('click', () => toggleWallHintsExpanded());
        $('wallHintsGrab')?.addEventListener('click', () => toggleWallHintsExpanded());
        $('wallTagRow')?.addEventListener('click', (e) => {
            const tagBtn = e.target.closest('[data-wall-filter-tag]');
            if (tagBtn) setWallTag(tagBtn.dataset.wallFilterTag);
        });
        $('wallAddLink')?.addEventListener('click', openWallModal);
        $('wallCreateModal')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-wall-close]')) closeWallModal();
            const tab = e.target.closest('.wall-form-tab');
            if (tab) selectWallFormType(tab.dataset.formType);
            const seriesBtn = e.target.closest('[data-wall-series]');
            if (seriesBtn) {
                applyMachineSeries(seriesBtn.dataset.wallSeries);
                return;
            }
            const chip = e.target.closest('[data-wall-chip]');
            if (chip) {
                selectedChipTag = chip.dataset.wallChip;
                document.querySelectorAll('.wall-chip').forEach((el) => {
                    el.classList.toggle('is-active', el === chip);
                });
            }
            const part = e.target.closest('[data-wall-part]');
            if (part) {
                applyMachinePart(part.dataset.wallPart);
                return;
            }
        });
        $('wallCreateModal')?.addEventListener('input', (e) => {
            if (e.target.id === 'f_phone') e.target.value = formatPhoneMask(e.target.value);
        });
        $('wallSubmitBtn')?.addEventListener('click', submitWallItem);
        $('wallFeedContainer')?.addEventListener('click', (e) => {
            const hammerBtn = e.target.closest('[data-wall-hammer]');
            if (hammerBtn) {
                e.preventDefault();
                e.stopPropagation();
                handleHammerClick(Number(hammerBtn.dataset.wallHammer));
                return;
            }
            const likeBtn = e.target.closest('[data-wall-like]');
            if (likeBtn) {
                e.preventDefault();
                e.stopPropagation();
                void toggleWallLikeVote(Number(likeBtn.dataset.wallLike));
                return;
            }
            const edit = e.target.closest('[data-wall-edit]');
            if (edit) {
                e.stopPropagation();
                openWallModal(Number(edit.dataset.wallEdit));
                return;
            }
            const del = e.target.closest('[data-wall-delete]');
            if (del) {
                e.stopPropagation();
                const id = Number(del.dataset.wallDelete);
                const item = wallItems.find((x) => x.id === id);
                if (!item || !wallIsCurrentUserAuthor(item)) return;
                const ok = window.confirm(`Удалить запись «${item.objectTitle}»?`);
                if (!ok) return;
                removeWallPostFromFeed(id);
                return;
            }
            const commentsOpen = e.target.closest('[data-wall-comments-open]');
            if (commentsOpen) {
                e.stopPropagation();
                openWallDetail(Number(commentsOpen.dataset.wallCommentsOpen));
                return;
            }
            const card = e.target.closest('[data-wall-open]');
            if (card) {
                if (e.target.closest('.wall-card-actions')) return;
                if (e.target.closest('a.wall-call, a.wall-card-phone')) return;
                openWallDetail(Number(card.dataset.wallOpen));
                return;
            }
        });
        $('openWallRulesBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openWallRulesModal();
        });
        $('wallRulesModal')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-wall-rules-close]')) closeWallRulesModal();
        });
        $('wallDetailBack')?.addEventListener('click', () => closeWallDetail(false));
        $('wallCommentSend')?.addEventListener('click', () => { submitWallDetailComment(); });
        $('wallCommentInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitWallDetailComment();
            }
        });
        if (!wallDetailPopstateBound) {
            wallDetailPopstateBound = true;
            window.addEventListener('popstate', onWallDetailPopstate);
        }
        updateSearchChrome();
        renderWallTagRow();
        renderWall();
        scheduleWallRulesOnboarding();
    }

    function bindUi() {
        if (uiBound) return;
        uiBound = true;
        bindWallUi();

        $('instrSearchInput')?.addEventListener('input', (e) => {
            updateSearchChrome();
            window.clearTimeout(searchDebounceTimer);
            const value = e.target.value;
            searchDebounceTimer = window.setTimeout(() => {
                if (instrMainMode === 'wall') renderWall();
                else renderDocuments(value);
            }, 220);
        });

        $('instrFsBack')?.addEventListener('click', () => {
            goBack();
        });
        $('instrShowAllBtn')?.addEventListener('click', () => {
            goDesktop();
        });

        const pane = $('instrPaneFiles');
        const foldersHost = $('instrFolders');

        function hideItemMenu() {
            const menu = $('instrItemMenu');
            if (menu) menu.hidden = true;
        }

        function itemFromTarget(target) {
            const folder = target?.closest?.('[data-folder-id]');
            if (folder && pane?.contains(folder)) {
                return {
                    kind: 'folder',
                    id: folder.dataset.folderId,
                    locked: folder.hasAttribute('data-static')
                };
            }
            const card = target?.closest?.('[data-doc-card]');
            if (card && pane?.contains(card)) {
                return {
                    kind: 'doc',
                    id: card.dataset.docCard,
                    locked: isStaticItem(card.dataset.docCard)
                };
            }
            return null;
        }

        function placeItemMenu(x, y) {
            const menu = $('instrItemMenu');
            if (!menu) return;
            menu.hidden = false;
            const pad = 8;
            const w = menu.offsetWidth;
            const h = menu.offsetHeight;
            let left = x;
            let top = y;
            if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
            if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
            menu.style.left = `${Math.max(pad, left)}px`;
            menu.style.top = `${Math.max(pad, top)}px`;
        }

        function showItemMenuAt(x, y, item) {
            if (!item) return;
            hideItemMenu();
            if (item.locked) {
                setStatus('Основная документация — нельзя удалить');
                window.setTimeout(() => setStatus(''), 2500);
                return;
            }
            const menu = $('instrItemMenu');
            if (!menu) return;
            menu.dataset.kind = item.kind;
            menu.dataset.id = item.id;
            placeItemMenu(x, y);
            itemMenuHoldUntil = Date.now() + 500;
            suppressDocClick = true;
            window.setTimeout(() => {
                suppressDocClick = false;
            }, 450);
        }

        pane?.addEventListener('click', (e) => {
            if (e.target.closest('#instrItemMenu')) return;
            if (suppressDocClick) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const btn = e.target.closest('[data-folder-id]');
            if (!btn || !pane.contains(btn)) return;
            const id = btn.dataset.folderId;
            if (id && id === activeFolderId) {
                goDesktop();
                return;
            }
            enterFolder(id);
        });

        let pressTimer = 0;
        let pressStart = null;
        const cancelPress = () => {
            window.clearTimeout(pressTimer);
            pressStart = null;
        };
        pane?.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const item = itemFromTarget(e.target);
            if (!item || item.locked) return;
            pressStart = { x: e.clientX, y: e.clientY, item };
            window.clearTimeout(pressTimer);
            pressTimer = window.setTimeout(() => {
                if (!pressStart) return;
                showItemMenuAt(pressStart.x, pressStart.y, pressStart.item);
                pressStart = null;
            }, 520);
        });
        pane?.addEventListener('pointermove', (e) => {
            if (!pressStart) return;
            const dx = e.clientX - pressStart.x;
            const dy = e.clientY - pressStart.y;
            if ((dx * dx) + (dy * dy) > 100) cancelPress();
        });
        pane?.addEventListener('pointerup', cancelPress);
        pane?.addEventListener('pointercancel', cancelPress);
        pane?.addEventListener('contextmenu', (e) => {
            const item = itemFromTarget(e.target);
            if (!item) return;
            e.preventDefault();
            showItemMenuAt(e.clientX, e.clientY, item);
        });

        $('instrItemMenu')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-instr-ctx]');
            if (!btn) return;
            e.stopPropagation();
            const menu = $('instrItemMenu');
            const kind = menu?.dataset.kind;
            const id = menu?.dataset.id;
            hideItemMenu();
            if (btn.dataset.instrCtx !== 'delete' || !id) return;
            if (kind === 'folder') deleteUserFolder(id);
            else if (kind === 'doc') deleteDocument(id);
        });

        pane?.addEventListener('dragover', (e) => {
            const folder = e.target.closest('[data-folder-id]');
            if (!folder || folder.hasAttribute('data-static') || !dragDocId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            pane.querySelectorAll('.instr-folder.is-drop-target').forEach((el) => {
                if (el !== folder) el.classList.remove('is-drop-target');
            });
            folder.classList.add('is-drop-target');
        });
        pane?.addEventListener('dragleave', (e) => {
            const folder = e.target.closest('[data-folder-id]');
            if (!folder) return;
            if (folder.contains(e.relatedTarget)) return;
            folder.classList.remove('is-drop-target');
        });
        pane?.addEventListener('drop', async (e) => {
            const folder = e.target.closest('[data-folder-id]');
            pane.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
            if (!folder) return;
            e.preventDefault();
            const docId = e.dataTransfer.getData('text/instr-doc-id') || dragDocId;
            dragDocId = null;
            if (!docId) return;
            suppressDocClick = true;
            await moveDocToFolder(docId, folder.dataset.folderId);
            window.setTimeout(() => {
                suppressDocClick = false;
            }, 0);
        });

        const docsHost = $('instrDocs');
        docsHost?.addEventListener('dragstart', (e) => {
            const card = e.target.closest('[data-doc-card]');
            if (!card || !card.getAttribute('draggable')) {
                e.preventDefault();
                return;
            }
            dragDocId = card.dataset.docCard;
            e.dataTransfer.setData('text/instr-doc-id', dragDocId);
            e.dataTransfer.effectAllowed = 'move';
            card.classList.add('is-dragging');
        });
        docsHost?.addEventListener('dragend', () => {
            dragDocId = null;
            docsHost.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
            pane?.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        });

        docsHost?.addEventListener('click', (e) => {
            if (suppressDocClick) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const delBtn = e.target.closest('[data-doc-delete]');
            if (delBtn) {
                e.preventDefault();
                e.stopPropagation();
                deleteDocument(delBtn.dataset.docDelete);
                return;
            }
            const hit = e.target.closest('.instr-hit');
            if (hit) {
                openPdfViewer(hit.dataset.docId, Number(hit.dataset.page) || 1, hit.dataset.highlight || '');
                return;
            }
            const toggle = e.target.closest('[data-doc-toggle]');
            if (toggle) {
                const card = toggle.closest('.instr-doc-card');
                if (!card) return;
                const open = card.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                return;
            }
            const openBtn = e.target.closest('[data-doc-open]');
            if (openBtn) {
                openPdfViewer(openBtn.dataset.docOpen, 1, $('instrSearchInput')?.value || '');
            }
        });

        $('instrFab')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (instrMainMode === 'wall') {
                openWallModal();
                return;
            }
            const menu = $('instrFabMenu');
            setFabMenuOpen(!!menu?.hidden);
        });

        $('instrFabMenu')?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-fab-action]');
            if (!item) return;
            e.stopPropagation();
            setFabMenuOpen(false);
            if (item.dataset.fabAction === 'upload') {
                $('instrFileInput')?.click();
            } else if (item.dataset.fabAction === 'folder') {
                window.setTimeout(() => {
                    createUserFolder();
                }, 0);
            }
        });

        document.addEventListener('click', (e) => {
            const wrap = document.querySelector('.instr-fab-wrap');
            if (wrap && !wrap.contains(e.target)) setFabMenuOpen(false);
            if (Date.now() < itemMenuHoldUntil) return;
            if (!e.target.closest('#instrItemMenu')) hideItemMenu();
        });

        $('instrNameDialogOk')?.addEventListener('click', () => {
            closeNameDialog($('instrNameDialogInput')?.value ?? '');
        });
        $('instrNameDialog')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-instr-name-cancel]')) {
                closeNameDialog(null);
            }
        });
        $('instrNameDialogInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeNameDialog(e.target.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeNameDialog(null);
            }
        });

        $('instrFileInput')?.addEventListener('change', async (e) => {
            const input = e.target;
            await handleUploadFiles(input.files);
            input.value = '';
        });

        $('instrPdfCloseBtn')?.addEventListener('click', () => closePdfViewer(true));

        $('instrPdfPrev')?.addEventListener('click', () => {
            if (!viewer?.pdf) return;
            renderPdfPage(viewer.pageNum - 1);
        });
        $('instrPdfNext')?.addEventListener('click', () => {
            if (!viewer?.pdf) return;
            renderPdfPage(viewer.pageNum + 1);
        });

        $('instrPdfPageInput')?.addEventListener('change', (e) => {
            if (!viewer?.pdf) return;
            renderPdfPage(Number(e.target.value) || 1);
        });

        $('instrPdfPageScrubber')?.addEventListener('input', (e) => {
            if (!viewer?.pdf) return;
            const page = Number(e.target.value) || 1;
            viewer.pageNum = page;
            updateViewerChrome();
            window.clearTimeout(viewer._scrubTimer);
            viewer._scrubTimer = window.setTimeout(() => renderPdfPage(page), 60);
        });

        let findTimer = null;
        $('instrPdfFindInput')?.addEventListener('input', (e) => {
            window.clearTimeout(findTimer);
            const value = e.target.value;
            findTimer = window.setTimeout(() => runPdfFind(value, true), 250);
        });
        $('instrPdfFindInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) goToFindMatch((viewer?.findIndex || 0) - 1);
                else goToFindMatch((viewer?.findIndex || 0) + 1);
            }
        });
        $('instrPdfFindPrev')?.addEventListener('click', () => goToFindMatch((viewer?.findIndex || 0) - 1));
        $('instrPdfFindNext')?.addEventListener('click', () => goToFindMatch((viewer?.findIndex || 0) + 1));

        const stage = $('instrPdfStage');
        stage?.addEventListener('touchstart', (e) => {
            if (!viewer || !e.changedTouches?.[0]) return;
            viewer.touchStartX = e.changedTouches[0].clientX;
            viewer.touchStartY = e.changedTouches[0].clientY;
        }, { passive: true });
        stage?.addEventListener('touchend', (e) => {
            if (!viewer?.pdf || !e.changedTouches?.[0]) return;
            const dx = e.changedTouches[0].clientX - (viewer.touchStartX || 0);
            const dy = e.changedTouches[0].clientY - (viewer.touchStartY || 0);
            if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
            if (dx < 0) renderPdfPage(viewer.pageNum + 1);
            else renderPdfPage(viewer.pageNum - 1);
        }, { passive: true });

        document.addEventListener('keydown', (e) => {
            const nameDialog = $('instrNameDialog');
            const wallModal = $('wallCreateModal');
            if (wallModal && !wallModal.hidden && e.key === 'Escape') {
                e.preventDefault();
                closeWallModal();
                return;
            }
            if (nameDialog && !nameDialog.hidden && e.key === 'Escape') {
                e.preventDefault();
                closeNameDialog(null);
                return;
            }
            if (e.key === 'Escape') hideItemMenu();
            const overlay = $('instrPdfOverlay');
            if (!overlay || overlay.hidden || !viewer?.pdf) return;
            if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                renderPdfPage(viewer.pageNum - 1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                renderPdfPage(viewer.pageNum + 1);
            } else if (e.key === 'Escape') {
                closePdfViewer(true);
            }
        });
    }

    async function initInstructionsModule() {
        bindUi();
        try {
            if (instrMainMode === 'pdf') await refreshUi();
        } catch (err) {
            console.warn('[instructions] init', err);
            setStatus('Не удалось открыть локальную базу инструкций');
        }
    }

    window.InstructionsModule = {
        init: initInstructionsModule,
        refresh: refreshUi
    };
})();