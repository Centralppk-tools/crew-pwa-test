/** Полная зачистка — только явный вызов hardResetAppData (не при загрузке и не при смене build_id). */
(function (global) {
    const BUILD_KEY = 'APP_BUILD_ID';
    const SCHEDULE_DB = 'da_schedule_yar';
    const SCHEDULE_STORE = 'daily';

    function appBuildId() {
        return String(global.APP_CONFIG?.APP_BUILD_ID || global.APP_BUILD_ID || '').trim();
    }

    async function saveScheduleToLocalDb(payload) {
        if (!global.indexedDB || !payload) return;
        return new Promise((resolve, reject) => {
            try {
                const req = global.indexedDB.open(SCHEDULE_DB, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(SCHEDULE_STORE)) {
                        db.createObjectStore(SCHEDULE_STORE);
                    }
                };
                req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(SCHEDULE_STORE, 'readwrite');
                    tx.objectStore(SCHEDULE_STORE).put(payload, 'current');
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                };
                req.onerror = () => reject(req.error);
            } catch (err) {
                reject(err);
            }
        });
    }

    async function hardResetAppData(options = {}) {
        const preserveBuild = options.preserveBuild === true;
        const currentBuild = preserveBuild ? global.localStorage.getItem(BUILD_KEY) : null;

        global.localStorage.clear();
        global.sessionStorage.clear();
        if (currentBuild) {
            global.localStorage.setItem(BUILD_KEY, currentBuild);
        }

        if (global.indexedDB?.databases) {
            try {
                const dbs = await global.indexedDB.databases();
                for (const db of dbs) {
                    if (db?.name) {
                        global.indexedDB.deleteDatabase(db.name);
                    }
                }
            } catch (err) {
                console.warn('IndexedDB databases lookup failed:', err);
            }
        }

        if (global.caches) {
            const keys = await global.caches.keys();
            for (const key of keys) {
                await global.caches.delete(key);
            }
        }

        if (options.reload !== false) {
            global.location.reload();
        }
    }

    async function ensureAppBuildMatches() {
        const localId = appBuildId();
        if (!localId) return;

        const stored = global.localStorage.getItem(BUILD_KEY);
        if (stored === localId) return;

        // Только метка сборки. hardResetAppData — только при явном вызове из UI (не автоматически).
        global.localStorage.setItem(BUILD_KEY, localId);
    }

    global.hardResetAppData = hardResetAppData;
    global.ensureAppBuildMatches = ensureAppBuildMatches;
    global.saveScheduleToLocalDb = saveScheduleToLocalDb;
})(window);
