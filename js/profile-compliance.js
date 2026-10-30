/**
 * Личный кабинет — «Контроль допусков и проверок» (сетка 3×2 + bottom sheets).
 */
(function () {
    'use strict';

    const STORAGE_PREFIX = 'da_profile_compliance_v1_';
    const PANEL_OPEN_KEY = 'da_profile_plan_panel_open';

    const BUILTIN_IDS = ['ot_eb', 'prmo', 'quarter'];

    const DEFAULT_VISIBLE = {
        ot_eb: true,
        prmo: true,
        quarter: true
    };

    const BADGE_COLOR_OPTIONS = [
        { value: 'badge-ot', label: 'Бирюзовый (ОТ)' },
        { value: 'badge-prmo', label: 'Розовый (ПРМО)' },
        { value: 'badge-quarter', label: 'Оранжевый (Квартал)' },
        { value: 'badge-exam', label: 'Лазурный (Экзамен)' },
        { value: 'badge-trans', label: 'Красный (прочее)' }
    ];

    let uiReady = false;
    let detailSheetReady = false;
    let settingsSheetReady = false;
    let profilePlanDetailReturnFocus = null;
    let profilePlanSettingsReturnFocus = null;

    function releasePlanSheetFocus(overlay, returnFocusEl) {
        if (!overlay) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && overlay.contains(active)) {
            active.blur();
        }
        if (returnFocusEl instanceof HTMLElement && document.contains(returnFocusEl)) {
            try {
                returnFocusEl.focus({ preventScroll: true });
            } catch (_) { /* */ }
        }
    }

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function parseIsoDate(iso) {
        if (!iso || typeof iso !== 'string') return null;
        const parts = iso.split('-').map(Number);
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function daysUntil(targetDate, fromDate = new Date()) {
        const t = parseIsoDate(targetDate);
        if (!t) return null;
        return Math.round((startOfDay(t).getTime() - startOfDay(fromDate).getTime()) / 86400000);
    }

    function formatDateDots(iso) {
        const d = parseIsoDate(iso);
        if (!d) return '—';
        return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    }

    function countdownShort(days) {
        if (days === null) return '—';
        if (days < 0) return 'Проср.';
        return `${days} дн`;
    }

    function countdownFoot(days) {
        if (days === null) return '—';
        if (days < 0) return 'Просрочено';
        const n = days;
        const mod10 = n % 10;
        const mod100 = n % 100;
        let word = 'дней';
        if (mod10 === 1 && mod100 !== 11) word = 'день';
        else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) word = 'дня';
        return `Осталось ${n} ${word}`;
    }

    function pillClassForDays(days) {
        if (days === null) return 'pill-counter';
        if (days < 0) return 'pill-counter-danger';
        if (days <= 30) return 'pill-counter-warn';
        return 'pill-counter';
    }

    function badgeClassForDays(days) {
        if (days === null) return 'badge-empty';
        if (days < 0) return 'badge-danger';
        if (days <= 30) return 'badge-warning';
        return 'badge-normal';
    }

    const REMINDER_DAY_OPTIONS = [3, 7, 14, 21, 30, 45, 60];

    const EB_GROUP_SHEET_OPTIONS = [
        { value: 'II группа', label: 'II' },
        { value: 'III группа (до 1000 В)', label: 'III' },
        { value: 'IV группа (до 1000 В)', label: 'IV' },
        { value: 'IV группа (до и выше 1000 В)', label: 'IV (≥1000 В)' },
        { value: 'V группа (до и выше 1000 В)', label: 'V' }
    ];

    const EB_GROUP_SELECT_OPTIONS = [
        { value: '', label: 'Не указана' },
        ...EB_GROUP_SHEET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
    ];

    const SHEET_REMINDER_DAY_OPTIONS = [3, 7, 14, 30];

    function reminderOptionLabel(days) {
        const n = Number(days);
        if (!Number.isFinite(n)) return '—';
        const mod10 = n % 10;
        const mod100 = n % 100;
        let word = 'дней';
        if (mod100 >= 11 && mod100 <= 14) word = 'дней';
        else if (mod10 === 1) word = 'день';
        else if (mod10 >= 2 && mod10 <= 4) word = 'дня';
        return `за ${n} ${word}`;
    }

    function settingsListTitle(item) {
        if (item.kind === 'ot_eb') return 'Электробезопасность (ОТ/ЭБ)';
        if (item.kind === 'prmo') return 'ПРМО / Медосмотр';
        if (item.kind === 'quarter') return 'Квартальный зачёт';
        return item.title;
    }

    function ebGroupSelectOptionsHtml(current) {
        const cur = String(current || '').trim();
        let html = EB_GROUP_SELECT_OPTIONS.map((o) => {
            const selected = cur === o.value || (!cur && !o.value) ? ' selected' : '';
            return `<option value="${escapeHtml(o.value)}"${selected}>${escapeHtml(o.label)}</option>`;
        }).join('');
        if (cur && !EB_GROUP_SELECT_OPTIONS.some((o) => o.value === cur)) {
            html += `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>`;
        }
        return html;
    }

    function renderDetailRow(label, valueHtml) {
        return `<div class="plan-detail-row">
                <span class="plan-detail-row__label">${escapeHtml(label)}</span>
                <span class="plan-detail-row__value">${valueHtml}</span>
            </div>`;
    }

    function daysRemainBadgeHtml(days) {
        if (days === null || days === undefined) return '—';
        const pillClass = pillClassForDays(days);
        const foot = countdownFoot(days);
        return `<span class="${pillClass} plan-detail-days-badge">${escapeHtml(foot)}</span>`;
    }

    function defaultReminderDays(cardId) {
        if (cardId === 'prmo') return 21;
        if (cardId === 'quarter') return 7;
        return 14;
    }

    function getReminderDays(data, cardId) {
        const raw = data.reminders && data.reminders[cardId];
        const n = Number.parseInt(String(raw ?? ''), 10);
        if (Number.isFinite(n) && n > 0) return n;
        return defaultReminderDays(cardId);
    }

    function setReminderDays(data, cardId, days) {
        const n = Number.parseInt(String(days), 10);
        if (!Number.isFinite(n) || n <= 0) return;
        if (!data.reminders) data.reminders = {};
        data.reminders[cardId] = n;
    }

    function quarterWindowShort(date = new Date()) {
        const q = getQuarterInfo(date);
        const closeMonth = q.quarter * 3 - 1;
        const mon = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][closeMonth];
        return `20–30 ${mon}`;
    }

    function ebGroupDisplay(groupText) {
        const s = String(groupText || '');
        const m = s.match(/\b([IV]+)\s*групп/i);
        const roman = m ? m[1] : '—';
        if (/1000/i.test(s)) return `Группа: ${roman} (до 1000В)`;
        return roman !== '—' ? `Группа: ${roman}` : 'Группа не указана';
    }

    function eventCardDataAttr(item) {
        if (item.kind === 'ot_eb') return 'eb';
        if (item.kind === 'prmo') return 'prmo';
        if (item.kind === 'quarter') return 'quarter';
        return item.id;
    }

    function eventVisualMeta(item) {
        const map = {
            'badge-ot': { icon: 'icon-cyan', emoji: '⚡' },
            'badge-prmo': { icon: 'icon-pink', emoji: '🩺' },
            'badge-quarter': { icon: 'icon-amber', emoji: '📋' },
            'badge-exam': { icon: 'icon-cyan', emoji: '📘' },
            'badge-trans': { icon: 'icon-amber', emoji: '🛡️' }
        };
        return map[item.badgeClass] || map['badge-exam'];
    }

    function displayTitleForItem(item) {
        if (item.kind === 'ot_eb') return 'Электробезопасность';
        if (item.kind === 'prmo') return 'ПРМО / Медосмотр';
        if (item.kind === 'quarter') return 'Квартальный зачёт';
        return item.title;
    }

    function displaySubForItem(item, data) {
        const q = getQuarterInfo();
        if (item.kind === 'ot_eb') {
            const sub = ebGroupDisplay(data.otEb?.ebGroup);
            const days = daysUntil(data.otEb?.nextCheck);
            const ok = data.otEb?.passed && (days === null || days >= 0);
            return { text: sub, statusOk: ok };
        }
        if (item.kind === 'prmo') {
            return { text: 'Допущен', statusOk: true };
        }
        if (item.kind === 'quarter') {
            return { text: `${q.roman} квартал ${q.year}`, statusOk: data.quarter?.passedKey === q.key };
        }
        return { text: item.subBadge || '—', statusOk: false };
    }

    function centerBlockForItem(item, data) {
        const q = getQuarterInfo();
        if (item.kind === 'ot_eb') {
            return { label: 'Следующая сдача', date: formatDateDots(data.otEb?.nextCheck) };
        }
        if (item.kind === 'prmo') {
            return { label: 'Срок действия', date: formatDateDots(data.pmo?.nextDeadline) };
        }
        if (item.kind === 'quarter') {
            return { label: 'Окно сдачи', date: quarterWindowShort() };
        }
        return {
            label: 'Срок',
            date: formatDateDots(getDateIsoFromData(data, item))
        };
    }

    function ebGroupShort(groupText) {
        const s = String(groupText || '');
        const romanMap = { I: '1', II: '2', III: '3', IV: '4', V: '5' };
        const m = s.match(/\b([IV]+)\s*групп/i);
        if (m && romanMap[m[1]]) return romanMap[m[1]];
        const d = s.match(/(\d)/);
        return d ? d[1] : '—';
    }

    function getQuarterInfo(date = new Date()) {
        const y = date.getFullYear();
        const m = date.getMonth();
        const quarter = Math.floor(m / 3) + 1;
        const closeMonth = quarter * 3 - 1;
        const roman = ['I', 'II', 'III', 'IV'][quarter - 1];
        const windowEnd = new Date(y, closeMonth, 30);
        const monthName = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][closeMonth];
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return {
            year: y,
            quarter,
            roman,
            key: `${y}-Q${quarter}`,
            periodLabel: `${roman} квартал ${y}`,
            periodShort: `${roman} кв. ${y}`,
            windowLabel: `Окно: 20–30 ${['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][closeMonth]}`,
            windowText: `с 20 по 30 ${monthName}`,
            windowEndIso: iso(windowEnd)
        };
    }

    function examAdmissionLabel(code) {
        if (code === 'allowed') return 'Допущен';
        if (code === 'denied') return 'Не допущен';
        return 'На согласовании';
    }

    function defaultComplianceData() {
        const today = startOfDay(new Date());
        const nextOt = new Date(today);
        nextOt.setMonth(nextOt.getMonth() + 4);
        const nextPmo = new Date(today);
        nextPmo.setMonth(nextPmo.getMonth() + 10);
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        return {
            cardVisible: { ...DEFAULT_VISIBLE },
            customCards: [],
            otEb: {
                passed: true,
                ebGroup: 'IV группа до и выше 1000 В',
                passedDate: '2025-11-08',
                protocol: 'П-214/25',
                nextCheck: iso(nextOt),
                note: 'Проверка знаний по охране труда и электробезопасности. Протокол комиссии.'
            },
            pmo: {
                lastDate: '2025-10-02',
                nextDeadline: iso(nextPmo),
                fit: true,
                note: 'Периодический медосмотр и предрейсовый контроль. Направление и флюорография.'
            },
            quarter: {
                passedKey: '',
                theme: 'ОТ: Действия ЧС',
                note: 'Квартальный зачёт по теме действий локомотивной бригады в нестандартных ситуациях.'
            },
            exam: {
                kind: 'ПТЭ — комиссия депо',
                scheduled: '2026-11-18',
                orderRef: 'Приказ № 142-к',
                commission: 'Комиссия депо',
                admission: 'allowed',
                note: 'Периодическая проверка знаний ПТЭ, ИСИ и ИДП в комиссии депо.'
            },
            other: {
                title: 'Тр. Безоп.',
                subBadge: 'Аттестация',
                label: 'Аттестация по транспортной безопасности',
                deadline: '2026-06-15',
                done: false,
                note: 'Свидетельство / аттестация по ФЗ-16 (ОТБ).'
            }
        };
    }

    function migrateData(data) {
        if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
        BUILTIN_IDS.forEach((id) => {
            if (data.cardVisible[id] === undefined) data.cardVisible[id] = DEFAULT_VISIBLE[id];
        });
        if (!Array.isArray(data.customCards)) data.customCards = [];
        if (Array.isArray(data.other) && data.other[0] && !data.other.title) {
            data.other = {
                title: data.other[0].title || 'Тр. Безоп.',
                subBadge: 'Аттестация',
                label: data.other[0].title || 'Транспортная безопасность',
                deadline: data.other[0].deadline,
                done: Boolean(data.other[0].done),
                note: 'Разовый допуск / аттестация.'
            };
        }
        if (!data.other || Array.isArray(data.other)) {
            data.other = defaultComplianceData().other;
        }
        data.customCards.forEach((c) => {
            if (data.cardVisible[c.id] === undefined) data.cardVisible[c.id] = true;
        });
        if (!data.flags?.builtinCardsExpanded) {
            BUILTIN_IDS.forEach((id) => {
                data.cardVisible[id] = true;
            });
            data.flags = { ...(data.flags || {}), builtinCardsExpanded: true };
            data._needsPersist = true;
        }
        if (data.cardVisible.exam !== false || data.cardVisible.trans_sec !== false) {
            data.cardVisible.exam = false;
            data.cardVisible.trans_sec = false;
            data._needsPersist = true;
        }
        if (data.quarter && typeof data.quarter.theme === 'string' && data.quarter.theme.length > 22) {
            data.quarter.themeFull = data.quarter.theme;
            data.quarter.theme = 'ОТ: Действия ЧС';
            data._needsPersist = true;
        }
        if (data.exam && typeof data.exam.orderRef === 'string' && /\s+от\s+\d/.test(data.exam.orderRef)) {
            data.exam.orderRefFull = data.exam.orderRef;
            data.exam.orderRef = data.exam.orderRef.replace(/\s+от\s+.*$/, '');
            data._needsPersist = true;
        }
        return data;
    }

    function loadCompliance(tab) {
        const key = STORAGE_PREFIX + String(tab || 'default');
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    const migrated = migrateData(parsed);
                    if (migrated._needsPersist) {
                        delete migrated._needsPersist;
                        try {
                            localStorage.setItem(key, JSON.stringify(migrated));
                        } catch (_) { /* */ }
                    }
                    return migrated;
                }
            }
        } catch (_) { /* seed */ }
        const seed = defaultComplianceData();
        try {
            localStorage.setItem(key, JSON.stringify(seed));
        } catch (_) { /* quota */ }
        return seed;
    }

    function saveCompliance(tab, data) {
        try {
            localStorage.setItem(STORAGE_PREFIX + String(tab || 'default'), JSON.stringify(data));
        } catch (_) { /* ignore */ }
        if (typeof window.daCrewApiScheduleProfileUpdate === 'function') {
            window.daCrewApiScheduleProfileUpdate();
        }
    }

    function isPanelOpen() {
        try {
            if (localStorage.getItem(PANEL_OPEN_KEY) === '0') return false;
        } catch (_) { /* */ }
        return true;
    }

    function setPanelOpen(open) {
        try {
            localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0');
        } catch (_) { /* */ }
    }

    function otStatusText(data) {
        const days = daysUntil(data.otEb?.nextCheck);
        if (days !== null && days < 0) return 'Требуется сдача';
        return data.otEb?.passed ? 'Сдано' : 'Требуется сдача';
    }

    function quarterStatusText(data, q) {
        return data.quarter?.passedKey === q.key ? 'Сдан' : 'Не сдан';
    }

    function buildBuiltinCatalog(data) {
        const q = getQuarterInfo();

        return [
            {
                id: 'ot_eb',
                kind: 'ot_eb',
                badgeClass: 'badge-ot',
                title: 'ОТ/ЭБ',
                subBadge: `Группа: ${ebGroupShort(data.otEb?.ebGroup)}`,
                passedLabel: `Сдано: ${formatDateDots(data.otEb?.passedDate)}`,
                nextIso: data.otEb?.nextCheck,
                nextLabel: `Дата сл: ${formatDateDots(data.otEb?.nextCheck)}`,
                note: data.otEb?.note,
                sheetTitle: 'Электробезопасность и ОТ',
                sheetSub: otStatusText(data),
                dateField: 'otEb.nextCheck'
            },
            {
                id: 'prmo',
                kind: 'prmo',
                badgeClass: 'badge-prmo',
                title: 'ПРМО',
                subBadge: 'Допущен',
                passedLabel: `Сдано: ${formatDateDots(data.pmo?.lastDate)}`,
                nextIso: data.pmo?.nextDeadline,
                nextLabel: `Дата сл: ${formatDateDots(data.pmo?.nextDeadline)}`,
                note: data.pmo?.note,
                sheetTitle: 'Периодический медосмотр (ПРМО)',
                sheetSub: 'Допущен',
                dateField: 'pmo.lastDate'
            },
            {
                id: 'quarter',
                kind: 'quarter',
                badgeClass: 'badge-quarter',
                title: 'Квартал',
                subBadge: q.periodShort,
                passedLabel: q.windowLabel,
                nextIso: q.windowEndIso,
                nextLabel: data.quarter?.theme || 'Квартальный зачёт',
                note: data.quarter?.note,
                sheetTitle: 'Квартальный зачёт',
                sheetSub: quarterStatusText(data, q),
                dateField: 'quarter.passedDate'
            }
        ];
    }

    function buildCustomCatalogItem(c) {
        return {
            id: c.id,
            kind: 'custom',
            badgeClass: c.badgeClass || 'badge-exam',
            title: c.title,
            subBadge: c.subBadge || 'Допуск',
            passedLabel: c.passedLabel || 'Назначено',
            nextIso: c.nextIso,
            nextLabel: c.nextLabel || `Дата сл: ${formatDateDots(c.nextIso)}`,
            note: c.note || 'Добавлено вручную.',
            sheetTitle: c.title,
            sheetSub: c.subBadge || '',
            dateField: `custom:${c.id}`
        };
    }

    function getAllCatalogItems(data) {
        const builtins = buildBuiltinCatalog(data);
        const customs = (data.customCards || []).map(buildCustomCatalogItem);
        return [...builtins, ...customs];
    }

    function isEventDateUnset(item, data, center) {
        if (item.kind === 'quarter') return false;
        const iso = getDateIsoFromData(data, item);
        if (!iso) return true;
        return !center.date || center.date === '—';
    }

    function eventItemIconClass(item) {
        if (item.kind === 'ot_eb') return 'icon-eb';
        if (item.kind === 'prmo') return 'icon-prmo';
        if (item.kind === 'quarter') return 'icon-quarter';
        const map = {
            'badge-ot': 'icon-eb',
            'badge-prmo': 'icon-prmo',
            'badge-quarter': 'icon-quarter',
            'badge-exam': 'icon-eb',
            'badge-trans': 'icon-quarter'
        };
        return map[item.badgeClass] || 'icon-eb';
    }

    function eventItemIconSvg(item) {
        const sw = '2.2';
        if (item.kind === 'ot_eb' || item.badgeClass === 'badge-ot' || item.badgeClass === 'badge-exam') {
            return `<svg class="event-item-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
        }
        if (item.kind === 'prmo' || item.badgeClass === 'badge-prmo') {
            return `<svg class="event-item-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`;
        }
        if (item.kind === 'quarter' || item.badgeClass === 'badge-quarter' || item.badgeClass === 'badge-trans') {
            return `<svg class="event-item-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/></svg>`;
        }
        return `<svg class="event-item-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>`;
    }

    function displayTitleForUnifiedItem(item) {
        if (item.kind === 'ot_eb') return 'Электробезопасность';
        if (item.kind === 'prmo') return 'ПРМО';
        if (item.kind === 'quarter') return 'Квартальный зачёт';
        return item.title;
    }

    function eventItemStatusForList(item, data) {
        const q = getQuarterInfo();
        if (item.kind === 'ot_eb') {
            const groupRaw = String(data.otEb?.ebGroup || '').trim();
            if (!groupRaw) {
                return { text: 'группа не указана', success: false };
            }
            return { text: ebGroupDisplay(groupRaw).toLowerCase(), success: true };
        }
        if (item.kind === 'prmo') {
            if (data.pmo?.fit === false) {
                return { text: 'Не годен', success: false };
            }
            return { text: 'Допущен', success: true };
        }
        if (item.kind === 'quarter') {
            const passed = data.quarter?.passedKey === q.key;
            return passed
                ? { text: 'Допущен', success: true }
                : { text: `${q.roman} квартал ${q.year}`, success: false };
        }
        const sub = item.subBadge || '—';
        return { text: sub, success: false };
    }

    function planEventItemHtml(item, data) {
        const title = displayTitleForUnifiedItem(item);
        const status = eventItemStatusForList(item, data);
        const statusClass = status.success ? 'text-success' : 'text-muted';
        const iconClass = eventItemIconClass(item);
        const iconSvg = eventItemIconSvg(item);
        const dataEvent = eventCardDataAttr(item);
        return `<button type="button" class="profile-event-item" data-event="${escapeHtml(dataEvent)}" data-compliance-action="open-card" data-card-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(title)}">
  <div class="event-item-icon ${iconClass}" aria-hidden="true">${iconSvg}</div>
  <div class="event-item-text">
    <div class="event-item-title">${escapeHtml(title)}</div>
    <div class="event-item-status ${statusClass}">${escapeHtml(status.text)}</div>
  </div>
</button>`;
    }

    function buildCardsListHtml(data) {
        const visible = data.cardVisible || DEFAULT_VISIBLE;
        const active = getAllCatalogItems(data).filter((c) => visible[c.id]);
        return active.map((item) => planEventItemHtml(item, data)).join('');
    }

    function buildHtml(data) {
        return buildCardsListHtml(data);
    }

    function findCatalogItem(data, cardId) {
        return getAllCatalogItems(data).find((c) => c.id === cardId) || null;
    }

    function setDateOnData(data, dateField, iso) {
        if (!dateField || !iso) return;
        if (dateField === 'otEb.nextCheck') data.otEb.nextCheck = iso;
        else if (dateField === 'pmo.nextDeadline') data.pmo.nextDeadline = iso;
        else if (dateField === 'pmo.lastDate') data.pmo.lastDate = iso;
        else if (dateField === 'exam.scheduled') data.exam.scheduled = iso;
        else if (dateField === 'other.deadline') data.other.deadline = iso;
        else if (dateField === 'quarter.windowEnd') { /* derived from calendar */ }
        else if (dateField === 'quarter.passedDate') {
            if (!data.quarter) data.quarter = {};
            data.quarter.passedDate = iso;
        }
        else if (dateField.startsWith('custom:')) {
            const id = dateField.slice(7);
            const card = (data.customCards || []).find((c) => c.id === id);
            if (card) {
                card.nextIso = iso;
                card.nextLabel = `Дата сл: ${formatDateDots(iso)}`;
            }
        }
    }

    function getDateIsoFromData(data, item) {
        if (item.dateField === 'quarter.windowEnd') return getQuarterInfo().windowEndIso;
        if (item.dateField === 'quarter.passedDate') return data.quarter?.passedDate;
        if (item.dateField === 'otEb.nextCheck') return data.otEb?.nextCheck;
        if (item.dateField === 'pmo.lastDate') return data.pmo?.lastDate;
        if (item.dateField === 'pmo.nextDeadline') return data.pmo?.nextDeadline;
        if (item.dateField === 'exam.scheduled') return data.exam?.scheduled;
        if (item.dateField === 'other.deadline') return data.other?.deadline;
        if (item.dateField?.startsWith('custom:')) {
            const id = item.dateField.slice(7);
            return (data.customCards || []).find((c) => c.id === id)?.nextIso;
        }
        return item.nextIso;
    }

    function sheetDisplayTitle(item) {
        if (item.kind === 'prmo') return 'Периодический медосмотр (ПРМО)';
        if (item.kind === 'ot_eb') return 'Электробезопасность и ОТ';
        if (item.kind === 'quarter') return 'Квартальный зачёт';
        return item.sheetTitle || item.title || 'Событие';
    }

    function sheetShortTitle(item) {
        if (item.kind === 'prmo') return 'ПРМО';
        if (item.kind === 'ot_eb') return 'Охрана труда и ЭБ';
        if (item.kind === 'quarter') return 'Квартальный зачёт';
        return sheetDisplayTitle(item);
    }

    function getSheetDateIso(item, data) {
        if (item.kind === 'prmo') return data.pmo?.lastDate || '';
        if (item.kind === 'quarter') return data.quarter?.passedDate || '';
        if (item.kind === 'ot_eb') return data.otEb?.nextCheck || '';
        if (item.dateField === 'quarter.windowEnd') return '';
        return getDateIsoFromData(data, item) || '';
    }

    function getSheetDateLabel(item) {
        if (item.kind === 'prmo') return 'Дата последнего прохождения';
        if (item.kind === 'ot_eb') return 'Срок действия';
        if (item.kind === 'quarter') return 'Дата сдачи';
        return 'Дата';
    }

    function buildCompactStatusBanner(item, data) {
        const q = getQuarterInfo();
        let tone = 'warn';
        let text = 'Требуется сдача';
        let icon = '!';

        if (item.kind === 'ot_eb') {
            const days = daysUntil(data.otEb?.nextCheck);
            const ok = data.otEb?.passed && days !== null && days >= 0;
            if (ok) {
                tone = 'ok';
                icon = '✓';
                text = `Срок до ${formatDateDots(data.otEb?.nextCheck)} • ${countdownFoot(days)}`;
            } else if (days !== null && days < 0) {
                tone = 'danger';
                text = 'Требуется сдача • просрочено';
            }
        } else if (item.kind === 'prmo') {
            const fit = data.pmo?.fit !== false;
            const days = daysUntil(data.pmo?.nextDeadline);
            if (fit && days !== null && days >= 0) {
                tone = 'ok';
                icon = '✓';
                text = `Срок до ${formatDateDots(data.pmo?.nextDeadline)} • ${countdownFoot(days)}`;
            } else if (!fit) {
                tone = 'danger';
                text = 'Не годен • требуется комиссия';
            } else if (days !== null && days < 0) {
                tone = 'danger';
                text = 'Требуется сдача • просрочено';
            }
        } else if (item.kind === 'quarter') {
            const passed = data.quarter?.passedKey === q.key;
            const days = daysUntil(q.windowEndIso);
            if (passed) {
                tone = 'ok';
                icon = '✓';
                text = `Сдан • ${q.periodShort}`;
            } else if (days !== null && days < 0) {
                tone = 'danger';
                text = 'Требуется сдача • окно закрыто';
            } else {
                text = `Требуется сдача • ${countdownFoot(days)}`;
            }
        } else {
            const days = daysUntil(getDateIsoFromData(data, item));
            if (days !== null && days >= 0) {
                tone = 'ok';
                icon = '✓';
                text = `Срок до ${formatDateDots(getDateIsoFromData(data, item))} • ${countdownFoot(days)}`;
            } else if (days !== null && days < 0) {
                tone = 'danger';
                text = 'Требуется сдача • просрочено';
            }
        }

        return `<div class="plan-sheet-status plan-sheet-status--${tone}" role="status">
            <span class="plan-sheet-status__icon" aria-hidden="true">${icon}</span>
            <span class="plan-sheet-status__text">${escapeHtml(text)}</span>
        </div>`;
    }

    function buildSheetExtraFieldHtml(item, data) {
        if (item.kind === 'ot_eb') {
            return `<div class="plan-sheet-field">
                <label class="plan-sheet-field__label" for="planDetailEbGroup">Группа допуска</label>
                <select id="planDetailEbGroup" name="planDetailEbGroup" class="plan-sheet-field__control">${ebGroupSelectOptionsHtml(data.otEb?.ebGroup)}</select>
            </div>`;
        }
        if (item.kind === 'prmo') {
            const fit = data.pmo?.fit !== false;
            return `<div class="plan-sheet-field">
                <span class="plan-sheet-field__label">Заключение</span>
                <div class="plan-sheet-segment" id="planDetailPrmoFit" role="group" aria-label="Заключение медкомиссии">
                    <button type="button" class="plan-sheet-segment__btn${fit ? ' is-active' : ''}" data-prmo-fit="1">Годен</button>
                    <button type="button" class="plan-sheet-segment__btn${!fit ? ' is-active' : ''}" data-prmo-fit="0">Не годен</button>
                </div>
            </div>`;
        }
        if (item.kind === 'quarter') {
            return `<div class="plan-sheet-field">
                <label class="plan-sheet-field__label" for="planDetailQuarterTheme">Тема зачёта</label>
                <input type="text" id="planDetailQuarterTheme" name="planDetailQuarterTheme" class="plan-sheet-field__control" value="${escapeHtml(data.quarter?.themeFull || data.quarter?.theme || '')}" placeholder="Тема или номер билета" autocomplete="off">
            </div>`;
        }
        return '';
    }

    function buildDetailSheetContent(tab, cardId) {
        const data = loadCompliance(tab);
        const item = findCatalogItem(data, cardId);
        if (!item) return '';

        const reminderDays = getReminderDays(data, cardId);
        const reminderOptions = SHEET_REMINDER_DAY_OPTIONS.map((d) => {
            const sel = d === reminderDays ? ' selected' : '';
            return `<option value="${d}"${sel}>${escapeHtml(reminderOptionLabel(d))}</option>`;
        }).join('');

        const dateIso = getSheetDateIso(item, data);
        let dateBlock = `<div class="plan-sheet-field">
                <label class="plan-sheet-field__label" for="planDetailDateInput">${escapeHtml(getSheetDateLabel(item))}</label>
                <input type="date" id="planDetailDateInput" name="planDetailDate" class="plan-sheet-field__control plan-sheet-field__control--date" value="${escapeHtml(dateIso)}">
            </div>`;
        if (item.kind === 'quarter') {
            dateBlock += `<p class="plan-sheet-field__hint">Окно сдачи: ${escapeHtml(quarterWindowShort())}</p>`;
        }

        const title = escapeHtml(sheetShortTitle(item));
        const statusHtml = buildCompactStatusBanner(item, data);
        const extraHtml = buildSheetExtraFieldHtml(item, data);

        return `
            <div class="plan-detail-grab" aria-hidden="true"></div>
            <div class="plan-detail-head plan-sheet-head">
                <h2 class="plan-detail-title plan-sheet-head__title">${title}</h2>
                <button type="button" class="plan-detail-close plan-sheet-head__close" data-plan-detail-close aria-label="Закрыть">✕</button>
            </div>
            ${statusHtml}
            <div class="plan-sheet-form">
                ${dateBlock}
                ${extraHtml}
                <div class="plan-sheet-field">
                    <label class="plan-sheet-field__label" for="planDetailReminder">Напомнить</label>
                    <select id="planDetailReminder" name="planDetailReminder" class="plan-sheet-field__control">${reminderOptions}</select>
                </div>
                <button type="button" class="plan-sheet-save" data-plan-save-edit="${escapeHtml(cardId)}">Сохранить</button>
                <button type="button" class="plan-sheet-hide-link" data-plan-hide-card="${escapeHtml(cardId)}">Не показывать в профиле</button>
            </div>
        `;
    }

    function ensureDetailSheet() {
        if (detailSheetReady) return;
        detailSheetReady = true;
        const overlay = document.createElement('div');
        overlay.id = 'profilePlanDetailSheet';
        overlay.className = 'plan-sheet-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'false');
        overlay.inert = true;
        overlay.innerHTML = `
            <div class="plan-sheet-backdrop" data-plan-detail-close></div>
            <div class="plan-sheet-body profile-plan-detail-sheet">
                <div id="profilePlanDetailContent" class="plan-sheet-scroll"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        bindSheetSwipeDismiss(overlay, closeDetailSheet);
    }

    function bindSheetSwipeDismiss(overlay, onClose) {
        const body = overlay?.querySelector('.plan-sheet-body');
        if (!body || body.dataset.swipeBound === '1') return;
        body.dataset.swipeBound = '1';
        let startY = 0;
        body.addEventListener('touchstart', (e) => {
            if (e.touches?.[0]) startY = e.touches[0].clientY;
        }, { passive: true });
        body.addEventListener('touchend', (e) => {
            const touch = e.changedTouches?.[0];
            if (!touch) return;
            if (touch.clientY - startY > 72) onClose();
        }, { passive: true });
    }

    function bindDetailSheetEvents(tab) {
        const overlay = document.getElementById('profilePlanDetailSheet');
        const content = document.getElementById('profilePlanDetailContent');
        if (!overlay || !content) return;

        content.querySelectorAll('[data-plan-detail-close]').forEach((el) => {
            el.addEventListener('click', closeDetailSheet);
        });
        overlay.querySelector('.plan-sheet-backdrop')?.addEventListener('click', closeDetailSheet);

        content.querySelectorAll('.plan-sheet-segment__btn[data-prmo-fit]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                content.querySelectorAll('.plan-sheet-segment__btn[data-prmo-fit]').forEach((b) => {
                    b.classList.remove('is-active');
                });
                btn.classList.add('is-active');
            });
        });

        content.querySelector('[data-plan-save-edit]')?.addEventListener('click', () => {
            const cardId = content.querySelector('[data-plan-save-edit]')?.getAttribute('data-plan-save-edit');
            if (!cardId) return;
            const data = loadCompliance(tab);
            const item = findCatalogItem(data, cardId);
            if (!item) return;

            const dateInput = document.getElementById('planDetailDateInput');
            if (dateInput?.value) {
                if (item.kind === 'prmo') {
                    if (!data.pmo) data.pmo = {};
                    data.pmo.lastDate = dateInput.value;
                } else if (item.kind === 'quarter') {
                    if (!data.quarter) data.quarter = {};
                    data.quarter.passedDate = dateInput.value;
                    data.quarter.passedKey = getQuarterInfo().key;
                } else if (item.dateField && item.dateField !== 'quarter.windowEnd') {
                    setDateOnData(data, item.dateField, dateInput.value);
                }
                if (item.kind === 'ot_eb') data.otEb.passed = true;
                if (item.kind === 'trans_sec') data.other.done = false;
            }

            if (item.kind === 'ot_eb') {
                const groupInput = document.getElementById('planDetailEbGroup');
                if (groupInput) data.otEb.ebGroup = groupInput.value.trim();
            }

            if (item.kind === 'prmo') {
                if (!data.pmo) data.pmo = {};
                const fitBtn = content.querySelector('.plan-sheet-segment__btn[data-prmo-fit].is-active');
                data.pmo.fit = fitBtn?.getAttribute('data-prmo-fit') !== '0';
            }

            if (item.kind === 'quarter') {
                if (!data.quarter) data.quarter = {};
                const themeInput = document.getElementById('planDetailQuarterTheme');
                if (themeInput) {
                    const themeVal = themeInput.value.trim();
                    data.quarter.theme = themeVal;
                    data.quarter.themeFull = themeVal;
                }
            }

            const reminderSelect = document.getElementById('planDetailReminder');
            if (reminderSelect?.value) {
                setReminderDays(data, cardId, reminderSelect.value);
            }

            saveCompliance(tab, data);
            renderProfileCompliance(tab);
            openCardDetail(tab, cardId);
        });

        content.querySelector('[data-plan-hide-card]')?.addEventListener('click', () => {
            const cardId = content.querySelector('[data-plan-hide-card]')?.getAttribute('data-plan-hide-card');
            if (!cardId) return;
            const data = loadCompliance(tab);
            if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
            data.cardVisible[cardId] = false;
            saveCompliance(tab, data);
            closeDetailSheet();
            renderProfileCompliance(tab);
        });
    }

    function openCardDetail(tab, cardId) {
        ensureDetailSheet();
        const overlay = document.getElementById('profilePlanDetailSheet');
        const content = document.getElementById('profilePlanDetailContent');
        if (!overlay || !content) return;
        profilePlanDetailReturnFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        content.innerHTML = buildDetailSheetContent(tab, cardId);
        bindDetailSheetEvents(tab);
        overlay.inert = false;
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-modal', 'true');
        document.body.classList.add('plan-sheet-open');
    }

    function closeDetailSheet() {
        const overlay = document.getElementById('profilePlanDetailSheet');
        if (!overlay) return;
        releasePlanSheetFocus(overlay, profilePlanDetailReturnFocus);
        profilePlanDetailReturnFocus = null;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-modal', 'false');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.inert = true;
        document.body.classList.remove('plan-sheet-open');
    }

    function ensureSettingsSheet() {
        if (settingsSheetReady) return;
        settingsSheetReady = true;
        const overlay = document.createElement('div');
        overlay.id = 'profilePlanSettingsSheet';
        overlay.className = 'plan-sheet-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'false');
        overlay.inert = true;
        const colorOpts = BADGE_COLOR_OPTIONS.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
        overlay.innerHTML = `
            <div class="plan-sheet-backdrop" data-plan-settings-close></div>
            <div class="plan-sheet-body profile-plan-settings-sheet">
                <div class="plan-sheet-scroll">
                    <div class="plan-detail-grab" aria-hidden="true"></div>
                    <div class="plan-settings-head">
                        <div>
                            <h2 class="plan-settings-title">Выбор карточек под себя</h2>
                            <p class="plan-settings-sub">Скройте ненужные проверки или настройте даты</p>
                        </div>
                        <button type="button" class="plan-detail-close" data-plan-settings-close aria-label="Закрыть">✕</button>
                    </div>
                    <div id="profilePlanSettingsList" class="profile-plan-settings-list"></div>
                    <div class="plan-settings-add">
                        <p class="plan-settings-add__title">+ Добавить новый допуск</p>
                        <input type="text" id="planCustomName" name="planCustomName" class="plan-settings-input" placeholder="Заголовок (например: ПТМ)" autocomplete="off">
                        <input type="text" id="planCustomTag" name="planCustomTag" class="plan-settings-input" placeholder="Подзаголовок (напр. Пожарный минимум)" autocomplete="off">
                        <div class="plan-settings-add__grid">
                            <label class="plan-settings-field">
                                <span>Дата след. сдачи</span>
                                <input type="date" id="planCustomDate" name="planCustomDate" class="plan-settings-input">
                            </label>
                            <label class="plan-settings-field">
                                <span>Цвет плашки</span>
                                <select id="planCustomColor" class="plan-settings-input">${colorOpts}</select>
                            </label>
                        </div>
                        <button type="button" id="planCustomAddBtn" class="plan-settings-add__btn" disabled>Добавить в сетку</button>
                        <p id="planCustomError" class="plan-settings-error" aria-live="polite"></p>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelectorAll('[data-plan-settings-close]').forEach((el) => {
            el.addEventListener('click', closeSettingsSheet);
        });
    }

    function renderSettingsList(tab) {
        const data = loadCompliance(tab);
        const list = document.getElementById('profilePlanSettingsList');
        if (!list) return;
        const visible = data.cardVisible || DEFAULT_VISIBLE;
        list.innerHTML = getAllCatalogItems(data).map((item) => `
            <label class="profile-plan-settings-row">
                <span class="profile-plan-settings-row__main">
                    <span class="profile-plan-settings-row__text">${escapeHtml(settingsListTitle(item))}</span>
                    <span class="profile-plan-settings-row__sub">${escapeHtml(item.nextLabel)}</span>
                </span>
                <span class="plan-switch">
                    <input type="checkbox" class="profile-plan-settings-toggle" id="planCardVisible-${escapeHtml(item.id)}" name="planCardVisible-${escapeHtml(item.id)}" data-card-visible="${escapeHtml(item.id)}" ${visible[item.id] ? 'checked' : ''} aria-label="Показывать ${escapeHtml(settingsListTitle(item))}">
                    <span class="plan-switch__track"><span class="plan-switch__dot"></span></span>
                </span>
            </label>
        `).join('');
        list.querySelectorAll('.profile-plan-settings-toggle').forEach((input) => {
            input.addEventListener('change', () => {
                const id = input.getAttribute('data-card-visible');
                const d = loadCompliance(tab);
                if (!d.cardVisible) d.cardVisible = { ...DEFAULT_VISIBLE };
                d.cardVisible[id] = input.checked;
                saveCompliance(tab, d);
                renderProfileCompliance(tab);
                renderSettingsList(tab);
            });
        });
    }

    function openSettingsSheet(tab) {
        ensureSettingsSheet();
        renderSettingsList(tab);
        const data = loadCompliance(tab);
        const dateInput = document.getElementById('planCustomDate');
        if (dateInput && !dateInput.value) {
            const q = getQuarterInfo();
            dateInput.value = data.exam?.scheduled || q.windowEndIso || '';
        }
        const addBtn = document.getElementById('planCustomAddBtn');
        const nameInput = document.getElementById('planCustomName');
        if (addBtn && !addBtn.dataset.bound) {
            addBtn.dataset.bound = '1';
            addBtn.addEventListener('click', () => createCustomCard(tab));
            nameInput?.addEventListener('input', () => {
                addBtn.disabled = !nameInput.value.trim();
                const err = document.getElementById('planCustomError');
                if (err) err.textContent = '';
            });
            nameInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && nameInput.value.trim()) createCustomCard(tab);
            });
        }
        if (addBtn && nameInput) addBtn.disabled = !nameInput.value.trim();
        const overlay = document.getElementById('profilePlanSettingsSheet');
        profilePlanSettingsReturnFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        overlay.inert = false;
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-modal', 'true');
        document.body.classList.add('plan-sheet-open');
    }

    function createCustomCard(tab) {
        const name = document.getElementById('planCustomName')?.value?.trim();
        const tag = document.getElementById('planCustomTag')?.value?.trim() || 'Зачёт';
        const iso = document.getElementById('planCustomDate')?.value;
        const badgeClass = document.getElementById('planCustomColor')?.value || 'badge-exam';
        const err = document.getElementById('planCustomError');
        if (!name) {
            if (err) err.textContent = 'Введите заголовок карточки';
            return;
        }
        if (name.length > 14) {
            if (err) err.textContent = 'Заголовок до 14 символов — иначе не влезет в плашку';
            return;
        }
        if (err) err.textContent = '';
        const data = loadCompliance(tab);
        if (!data.customCards) data.customCards = [];
        const id = `custom_${Date.now()}`;
        data.customCards.push({
            id,
            title: name,
            subBadge: tag,
            badgeClass,
            passedLabel: 'Назначено',
            nextIso: iso || '',
            nextLabel: `Дата сл: ${formatDateDots(iso)}`,
            note: 'Добавлено сотрудником вручную.'
        });
        if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
        data.cardVisible[id] = true;
        saveCompliance(tab, data);
        document.getElementById('planCustomName').value = '';
        document.getElementById('planCustomTag').value = '';
        const addBtn = document.getElementById('planCustomAddBtn');
        if (addBtn) addBtn.disabled = true;
        renderProfileCompliance(tab);
        renderSettingsList(tab);
    }

    function closeSettingsSheet() {
        const overlay = document.getElementById('profilePlanSettingsSheet');
        if (!overlay) return;
        releasePlanSheetFocus(overlay, profilePlanSettingsReturnFocus);
        profilePlanSettingsReturnFocus = null;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-modal', 'false');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.inert = true;
        document.body.classList.remove('plan-sheet-open');
    }

    function handleCardAction(tab, action, cardId) {
        if (action === 'settings') {
            openSettingsSheet(tab);
            return;
        }
        if (action === 'open-card' && cardId) {
            openCardDetail(tab, cardId);
        }
    }

    const EVENTS_COLLAPSED_KEY = 'events_collapsed';

    function isEventsBlockCollapsed() {
        try {
            return localStorage.getItem(EVENTS_COLLAPSED_KEY) === '1';
        } catch (_) {
            return false;
        }
    }

    function setEventsBlockCollapsed(collapsed) {
        try {
            localStorage.setItem(EVENTS_COLLAPSED_KEY, collapsed ? '1' : '0');
        } catch (_) { /* */ }
    }

    function syncEventsBlockCollapseUi() {
        const wrap = document.getElementById('profileEventsCollapsible');
        const handle = document.getElementById('profileCardDragHandle');
        const card = document.querySelector('#screen-profile .profile-unified-card');
        if (!wrap) return;
        const collapsed = isEventsBlockCollapsed();
        wrap.classList.toggle('collapsed', collapsed);
        card?.classList.toggle('profile-unified-card--events-collapsed', collapsed);
        handle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function toggleEventsBlockCollapse() {
        setEventsBlockCollapsed(!isEventsBlockCollapsed());
        syncEventsBlockCollapseUi();
    }

    let unifiedProfileActionsBound = false;

    function bindProfileUnifiedCardActions() {
        if (unifiedProfileActionsBound) return;
        unifiedProfileActionsBound = true;

        document.getElementById('profileAddEventBtn')?.addEventListener('click', () => {
            const root = document.getElementById('profileComplianceRoot');
            const tab = root?.dataset.complianceTab || 'default';
            openSettingsSheet(tab);
        });

        const handle = document.getElementById('profileCardDragHandle');
        handle?.addEventListener('click', () => {
            toggleEventsBlockCollapse();
        });
        handle?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleEventsBlockCollapse();
            }
        });

        let handleTouchY = 0;
        handle?.addEventListener('touchstart', (e) => {
            handleTouchY = e.changedTouches[0]?.clientY ?? 0;
        }, { passive: true });
        handle?.addEventListener('touchend', (e) => {
            const y = e.changedTouches[0]?.clientY ?? 0;
            if (Math.abs(y - handleTouchY) > 28) toggleEventsBlockCollapse();
        }, { passive: true });

        syncEventsBlockCollapseUi();
    }

    function bindComplianceRootOnce() {
        const root = document.getElementById('profileComplianceRoot');
        if (!root || root.dataset.bound === '1') return;
        root.dataset.bound = '1';
        root.addEventListener('click', (e) => {
            const tab = root.dataset.complianceTab || 'default';
            const card = e.target.closest('[data-compliance-action]');
            if (!card) return;
            handleCardAction(tab, card.getAttribute('data-compliance-action'), card.getAttribute('data-card-id'));
        });
        bindProfileUnifiedCardActions();
    }

    window.initProfileComplianceUi = function initProfileComplianceUi() {
        if (uiReady) return;
        uiReady = true;
        ensureDetailSheet();
        ensureSettingsSheet();
        bindProfileUnifiedCardActions();
        syncEventsBlockCollapseUi();
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const detail = document.getElementById('profilePlanDetailSheet');
            const settings = document.getElementById('profilePlanSettingsSheet');
            if (detail?.classList.contains('is-open')) {
                e.preventDefault();
                closeDetailSheet();
            } else if (settings?.classList.contains('is-open')) {
                e.preventDefault();
                closeSettingsSheet();
            }
        });
    };

    window.renderProfileCompliance = function renderProfileCompliance(tab) {
        const root = document.getElementById('profileComplianceRoot');
        if (!root) return;
        const data = loadCompliance(tab);
        root.dataset.complianceTab = String(tab || 'default');
        root.className = 'profile-events-list';
        root.innerHTML = buildHtml(data);
        bindComplianceRootOnce();
    };

    /** Снимок для VPS crew-api (поле users.events). */
    window.exportProfileComplianceSnapshot = function exportProfileComplianceSnapshot(tab) {
        const data = loadCompliance(tab);
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            data
        };
    };

    window.importProfileComplianceSnapshot = function importProfileComplianceSnapshot(tab, events) {
        if (!events || typeof events !== 'object') return;
        const payload = events.data && typeof events.data === 'object' ? events.data : events;
        if (!payload || typeof payload !== 'object') return;
        try {
            localStorage.setItem(STORAGE_PREFIX + String(tab || 'default'), JSON.stringify(payload));
        } catch (_) { /* quota */ }
        renderProfileCompliance(tab);
    };
})();
