/**
 * JWT-сессия аккаунта (register/login/reset).
 */
(function (global) {
    'use strict';

    const JWT_KEY = 'da_auth_jwt';
    const USER_KEY = 'da_auth_user';

    function getJwt() {
        try {
            return (global.localStorage.getItem(JWT_KEY) || '').trim();
        } catch (_) {
            return '';
        }
    }

    function getStoredUser() {
        try {
            const raw = global.localStorage.getItem(USER_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function persistSession(token, user) {
        if (token) {
            global.localStorage.setItem(JWT_KEY, String(token));
        }
        if (user && typeof user === 'object') {
            global.localStorage.setItem(USER_KEY, JSON.stringify(user));
        }
    }

    function clearSession() {
        try {
            global.localStorage.removeItem(JWT_KEY);
            global.localStorage.removeItem(USER_KEY);
        } catch (_) { /* */ }
    }

    function applyUserToProfile(user) {
        if (!user || typeof user !== 'object') return;
        const name = String(user.name || '').trim();
        const tab = String(user.tab_number || '').trim();
        if (name) {
            try { global.localStorage.setItem('depotFio', name); } catch (_) { /* */ }
        }
        if (tab) {
            try { global.localStorage.setItem('depotTab', tab); } catch (_) { /* */ }
        }
        const role = String(user.role || '').toLowerCase();
        if (role.includes('машинист') || role === 'driver') {
            try { global.localStorage.setItem('depotPosition', 'machinist'); } catch (_) { /* */ }
        } else if (role) {
            try { global.localStorage.setItem('depotPosition', 'assistant'); } catch (_) { /* */ }
        }
    }

    function authHeaders() {
        const jwt = getJwt();
        if (!jwt) return {};
        return { Authorization: `Bearer ${jwt}` };
    }

    function resolveCrewApiBaseUrl() {
        const c = global.APP_CONFIG?.crewApi || {};
        const configured = String(c.baseUrl || '').replace(/\/$/, '');
        if (c.devSameOriginProxy === false || !configured) return configured;
        if (typeof global.location === 'undefined') return configured;
        const loc = global.location;
        const host = String(loc.hostname || '').toLowerCase();
        if (loc.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
            return String(loc.origin || '').replace(/\/$/, '');
        }
        return configured;
    }

    function normalizeAuthPath(path) {
        const p = String(path || '').trim();
        if (!p) return '/api/auth/register';
        return p.startsWith('/') ? p : `/${p}`;
    }

    async function authFetch(path, options) {
        const baseUrl = resolveCrewApiBaseUrl();
        if (!baseUrl) throw new Error('crew_api_disabled');
        const apiPath = normalizeAuthPath(path);
        const url = `${baseUrl}${apiPath}`;
        const opts = options && typeof options === 'object' ? options : {};
        const init = {
            method: opts.method || 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
                ...(opts.headers || {})
            },
            cache: 'no-store'
        };
        if (opts.body != null) {
            init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        }
        const res = await fetch(url, init);
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `http_${res.status}`);
            err.status = res.status;
            err.requestUrl = url;
            err.payload = data || {
                error: `http_${res.status}`,
                message: res.status === 404
                    ? 'Сервис авторизации не найден. Обновите crew-api на сервере или запустите локально npm start в crew-api/.'
                    : `Ошибка запроса ${res.status}`
            };
            throw err;
        }
        return data;
    }

    async function register(payload) {
        const data = await authFetch('/api/auth/register', { body: payload });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function login(payload) {
        const data = await authFetch('/api/auth/login', { body: payload });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function forgotPassword(emailOrTab) {
        return authFetch('/api/auth/forgot-password', {
            body: { emailOrTab: String(emailOrTab || '').trim() }
        });
    }

    async function resetPassword(token, newPassword) {
        const data = await authFetch('/api/auth/reset-password', {
            body: { token, newPassword }
        });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function bindEmail(email) {
        const data = await authFetch('/api/auth/bind-email', {
            body: { email: String(email || '').trim() }
        });
        if (data.user) persistSession(getJwt(), data.user);
        return data;
    }

    function hasEmailOnAccount() {
        const u = getStoredUser();
        return Boolean(u && u.email && String(u.email).trim());
    }

    global.DaAuthSession = {
        getJwt,
        getStoredUser,
        persistSession,
        clearSession,
        applyUserToProfile,
        authHeaders,
        register,
        login,
        forgotPassword,
        resetPassword,
        bindEmail,
        hasEmailOnAccount
    };
})(typeof window !== 'undefined' ? window : globalThis);
