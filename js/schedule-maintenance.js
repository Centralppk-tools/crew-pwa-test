/**
 * Временное отключение разделов «Маршрут» и «Расписание».
 * Главный рубильник: window.DA_SCHEDULE_MAINTENANCE_BLOCK в index.html
 */
(function () {
    const OVERLAY_ID = 'scheduleMaintenanceOverlay';

    function enabled() {
        if (window.DA_SCHEDULE_MAINTENANCE_BLOCK === true) return true;
        if (document.documentElement?.getAttribute('data-schedule-maintenance') === '1') return true;
        return !!(window.APP_CONFIG && window.APP_CONFIG.scheduleMaintenance);
    }

    function message() {
        const custom = window.APP_CONFIG && window.APP_CONFIG.scheduleMaintenanceMessage;
        return (typeof custom === 'string' && custom.trim()) ? custom.trim() : 'Ведутся технические работы';
    }

    function applyDocumentFlag() {
        if (!enabled()) return;
        document.documentElement.setAttribute('data-schedule-maintenance', '1');
        document.body?.classList.add('schedule-maintenance-active');
    }

    function clearMaintenanceChrome() {
        document.documentElement.removeAttribute('data-schedule-maintenance');
        document.body?.classList.remove('schedule-maintenance-active');
        document.getElementById('screen-schedule')?.classList.remove('schedule-maintenance-screen');
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) {
            overlay.setAttribute('hidden', '');
            overlay.setAttribute('aria-hidden', 'true');
        }
        document.querySelector('.bottom-tab-btn[data-screen="schedule"]')
            ?.classList.remove('bottom-tab-btn--maintenance');
        document.querySelectorAll('#screen-schedule .tab-btn').forEach((btn) => {
            btn.classList.remove('tab-btn--maintenance');
            btn.removeAttribute('aria-disabled');
        });
    }

    function ensureOverlay() {
        let el = document.getElementById(OVERLAY_ID);
        if (!el) return null;
        const textEl = el.querySelector('.schedule-maintenance-overlay__text');
        if (textEl) textEl.textContent = message();
        return el;
    }

    function showOverlay() {
        const el = ensureOverlay();
        if (!el) return;
        el.removeAttribute('hidden');
        el.classList.remove('hidden');
        el.setAttribute('aria-hidden', 'false');
    }

    function purgeShiftRouteCaches() {
        if (typeof window.daClearShiftRouteCachesOnly === 'function') {
            window.daClearShiftRouteCachesOnly();
        }
    }

    function unregisterOfflineShell() {
        if ('serviceWorker' in navigator) {
            void navigator.serviceWorker.getRegistrations().then((regs) => {
                regs.forEach((reg) => { void reg.unregister(); });
            });
        }
        if (window.caches?.keys) {
            void window.caches.keys().then((keys) => {
                keys.forEach((key) => { void window.caches.delete(key); });
            });
        }
    }

    function onEnterScheduleScreen() {
        if (!enabled()) return;
        applyDocumentFlag();
        purgeShiftRouteCaches();
        document.getElementById('screen-schedule')?.classList.add('schedule-maintenance-screen');
        showOverlay();
    }

    function resolveLastMainScreen(saved, fallback) {
        if (enabled() && saved === 'schedule') return fallback;
        return saved;
    }

    function applyChromeClasses() {
        if (!enabled()) return;
        applyDocumentFlag();
        document.querySelector('.bottom-tab-btn[data-screen="schedule"]')
            ?.classList.add('bottom-tab-btn--maintenance');
        document.querySelectorAll('#screen-schedule .tab-btn').forEach((btn) => {
            btn.classList.add('tab-btn--maintenance');
            btn.setAttribute('aria-disabled', 'true');
        });
    }

    function init() {
        if (!enabled()) {
            clearMaintenanceChrome();
            return;
        }
        applyChromeClasses();
        purgeShiftRouteCaches();
        const scheduleEl = document.getElementById('screen-schedule');
        if (scheduleEl && !scheduleEl.classList.contains('hidden')) {
            onEnterScheduleScreen();
        }
    }

    if (enabled()) {
        applyDocumentFlag();
        unregisterOfflineShell();
    } else {
        clearMaintenanceChrome();
    }

    window.daScheduleMaintenance = {
        enabled,
        message,
        init,
        onEnterScheduleScreen,
        resolveLastMainScreen
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
