/**
 * Постоянный sync_user_id устройства — первичный ключ облачной синхронизации (не табельный номер).
 */
(function (global) {
    'use strict';

    const SYNC_USER_ID_KEY = 'app_sync_user_id';
    const SYNC_USER_STORAGE_MIGRATED_KEY = 'app_sync_user_storage_migrated_v1';

    function generateSyncUserId() {
        const suffix = typeof global.crypto !== 'undefined' && typeof global.crypto.randomUUID === 'function'
            ? global.crypto.randomUUID()
            : `${Math.random().toString(36).substring(2)}${Date.now().toString(36)}`;
        return `usr_${suffix}`;
    }

    function legacyUserStoragePrefixes() {
        const prefixes = new Set();
        try {
            const tab = String(
                global.localStorage.getItem('depotTab')
                || global.localStorage.getItem('currentUserTab')
                || global.localStorage.getItem('rzd_auth_session')
                || ''
            ).trim();
            if (tab) prefixes.add(`u_${tab}_`);
            for (let i = 0; i < global.localStorage.length; i += 1) {
                const key = global.localStorage.key(i);
                if (!key || !key.startsWith('u_')) continue;
                const rest = key.slice(2);
                const sep = rest.indexOf('_');
                if (sep <= 0) continue;
                prefixes.add(`u_${rest.slice(0, sep)}_`);
            }
        } catch (_) { /* */ }
        return [...prefixes];
    }

    function migrateLegacyUserStorageToSyncId(syncId) {
        if (!syncId) return;
        const migratedFor = global.localStorage.getItem(SYNC_USER_STORAGE_MIGRATED_KEY);
        if (migratedFor === syncId) return;

        const targetPrefix = `u_${syncId}_`;
        legacyUserStoragePrefixes().forEach((legacyPrefix) => {
            if (legacyPrefix === targetPrefix) return;
            const keys = [];
            try {
                for (let i = 0; i < global.localStorage.length; i += 1) {
                    const key = global.localStorage.key(i);
                    if (key && key.startsWith(legacyPrefix)) keys.push(key);
                }
            } catch (_) { /* */ }
            keys.forEach((key) => {
                const suffix = key.slice(legacyPrefix.length);
                const newKey = targetPrefix + suffix;
                try {
                    if (global.localStorage.getItem(newKey) == null) {
                        const value = global.localStorage.getItem(key);
                        if (value != null) global.localStorage.setItem(newKey, value);
                    }
                } catch (_) { /* quota */ }
            });
        });

        try {
            global.localStorage.setItem(SYNC_USER_STORAGE_MIGRATED_KEY, syncId);
        } catch (_) { /* */ }
    }

    function getOrCreateSyncUserId() {
        let id = '';
        try {
            id = String(global.localStorage.getItem(SYNC_USER_ID_KEY) || '').trim();
        } catch (_) {
            id = '';
        }
        if (id && !/^usr_[a-zA-Z0-9_-]{8,128}$/.test(id)) {
            id = '';
        }
        if (!id) {
            id = generateSyncUserId();
            try {
                global.localStorage.setItem(SYNC_USER_ID_KEY, id);
            } catch (_) { /* */ }
            migrateLegacyUserStorageToSyncId(id);
        }
        return id;
    }

    function setSyncUserId(nextId, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const id = String(nextId || '').trim();
        if (!/^usr_[a-zA-Z0-9_-]{8,128}$/.test(id)) {
            return false;
        }
        try {
            global.localStorage.setItem(SYNC_USER_ID_KEY, id);
            if (!opts.skipLegacyMigrate) {
                migrateLegacyUserStorageToSyncId(id);
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    global.getOrCreateSyncUserId = getOrCreateSyncUserId;
    global.setSyncUserId = setSyncUserId;
    global.SYNC_USER_ID_STORAGE_KEY = SYNC_USER_ID_KEY;
})(typeof window !== 'undefined' ? window : globalThis);
