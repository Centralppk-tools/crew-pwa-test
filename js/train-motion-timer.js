/**
 * Динамический отсчёт: шапка, подвал карточки маршрута, прогресс перегона.
 */
(function initTrainMotionTimer(global) {
    const MS_MIN = 60 * 1000;
    const MS_HOUR = 60 * MS_MIN;

    const SUB_ACCENT_CLASSES = ['ok', 'muted', 'warn', 'danger', 'dwell'];
    let deps = null;

    function pad2(n) {
        return String(Math.max(0, Math.floor(n))).padStart(2, '0');
    }

    function formatMmSs(totalMs) {
        const sec = Math.max(0, Math.ceil(totalMs / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${pad2(m)}:${pad2(s)}`;
    }

    function formatHourMinRu(totalMs) {
        const min = Math.max(0, Math.ceil(totalMs / MS_MIN));
        const h = Math.floor(min / 60);
        const m = min % 60;
        if (h <= 0) return `${m}м`;
        if (m <= 0) return `${h}ч`;
        return `${h}ч ${m}м`;
    }

    function formatTurnaroundRemainingRu(remainingMs) {
        const min = Math.max(0, Math.ceil(remainingMs / MS_MIN));
        const h = Math.floor(min / 60);
        const m = min % 60;
        if (h > 0 && m > 0) return `${h} ч ${m} мин`;
        if (h > 0) return `${h} ч`;
        return `${m} мин`;
    }

    function shortStationLabel(title, maxLen = 9) {
        let text = String(title || '').trim();
        text = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return '—';
        const first = text.split(/[\s,–—-]/)[0] || text;
        const limit = Math.max(3, Number(maxLen) || 9);
        if (first.length <= limit) return first;
        return first.slice(0, limit);
    }

    function accentFromRemainingMs(remainingMs, overdue) {
        if (overdue) return 'danger';
        return 'muted';
    }

    function phaseAccent(phase) {
        if (phase === 'red') return 'danger';
        if (phase === 'yellow') return 'warn';
        if (phase === 'green') return 'ok';
        if (phase === 'transit') return 'ok';
        return 'muted';
    }

    function setBadge(el, text, accent) {
        if (!el) return;
        SUB_ACCENT_CLASSES.forEach((name) => {
            el.classList.remove(`clock-wrap__sub--${name}`);
        });
        if (!text) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = text;
        el.classList.add(`clock-wrap__sub--${accent || 'muted'}`);
    }

    function resolveActiveTurnaround(nowDate, trains) {
        if (!deps || !nowDate || !Array.isArray(trains)) return null;
        const nowMs = nowDate.getTime();

        for (let i = 0; i < trains.length; i++) {
            const train = trains[i];
            if (!train?.nextDeparture || !train?.nextDepartureDate || !train?.arrival) continue;
            const arrDt = deps.buildRouteEventDateTime(train.arrivalDate, train.arrival);
            const depNextDt = deps.buildRouteEventDateTime(train.nextDepartureDate, train.nextDeparture);
            if (!arrDt || !depNextDt) continue;
            const startMs = arrDt.getTime();
            const endMs = depNextDt.getTime();
            if (endMs <= startMs || nowMs < startMs || nowMs >= endMs) continue;

            const currentIndex = train.index ?? i;
            const nextIndex = currentIndex + 1;
            if (nextIndex >= trains.length) continue;

            const remainingMs = endMs - nowMs;
            const totalMs = endMs - startMs;
            const elapsedMs = nowMs - startMs;
            const diffMin = remainingMs / MS_MIN;
            let phase = 'green';
            if (diffMin <= 3) phase = 'red';
            else if (diffMin <= 10) phase = 'yellow';

            return {
                trainIndex: nextIndex,
                phase,
                progress: Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100)),
                remainingMs,
                totalMs,
            };
        }
        return null;
    }

    function resolveActiveRouteTrain(nowDate, trains) {
        if (!nowDate || !Array.isArray(trains) || !trains.length || !deps) return null;

        let transit = null;
        let upcoming = null;
        let upcomingDiff = Infinity;

        for (const train of trains) {
            const phase = deps.resolveRouteTrainPhase(nowDate, train);
            if (phase === 'transit') {
                transit = { train, phase: 'transit' };
                break;
            }
            if (phase === 'green' || phase === 'yellow' || phase === 'red') {
                const depDt = deps.buildRouteEventDateTime(train.departureDate, train.departure);
                if (!depDt) continue;
                const diff = depDt.getTime() - nowDate.getTime();
                if (diff < upcomingDiff) {
                    upcomingDiff = diff;
                    upcoming = { train, phase: 'before', depDt };
                }
            }
        }

        if (transit) {
            const arrDt = deps.buildRouteEventDateTime(transit.train.arrivalDate, transit.train.arrival);
            return { ...transit, arrDt };
        }
        if (upcoming) return upcoming;
        return null;
    }

    function buildTurnaroundHeaderBadge(turnaround) {
        if (!turnaround) return null;
        const rem = turnaround.remainingMs;
        const overdue = rem < 0;
        const text = rem >= MS_HOUR
            ? `Оборот ${formatHourMinRu(rem)}`
            : `Оборот ${formatMmSs(rem)}`;
        return {
            text,
            accent: phaseAccent(overdue ? 'red' : turnaround.phase),
        };
    }

    function buildRouteHeaderBadge(nowDate, active) {
        if (!active) return null;
        if (active.phase === 'transit') {
            const arrDt = active.arrDt;
            if (!arrDt) return null;
            const rem = arrDt.getTime() - nowDate.getTime();
            const overdue = rem < 0;
            return {
                text: `В пути ${formatMmSs(Math.abs(rem))}`,
                accent: accentFromRemainingMs(rem, overdue),
            };
        }
        const depDt = active.depDt;
        if (!depDt) return null;
        const rem = depDt.getTime() - nowDate.getTime();
        const overdue = rem < 0;
        const accent = accentFromRemainingMs(rem, overdue);
        if (rem >= MS_HOUR) {
            return {
                text: `Отпр ${formatHourMinRu(rem)}`,
                accent,
            };
        }
        return {
            text: `Отпр ${formatMmSs(rem)}`,
            accent,
        };
    }

    function findPrevDepartureIndex(displayStops, nextIndex, selectedDate) {
        for (let i = nextIndex - 1; i >= 0; i--) {
            const win = deps.buildStopLiveWindow(displayStops, i, selectedDate);
            if (!win?.end) continue;
            return i;
        }
        return -1;
    }

    function analyzeScheduleMotion(displayStops, selectedDate, nowDate) {
        if (!deps || !displayStops?.length || !nowDate) return null;
        if (selectedDate && !deps.isScheduleContextActive(nowDate, selectedDate)) return null;

        const { currentIndex, nextIndex } = deps.findTimelineStationPhases(displayStops, selectedDate, nowDate);
        const nowMs = nowDate.getTime();

        if (currentIndex >= 0) {
            const win = deps.buildStopLiveWindow(displayStops, currentIndex, selectedDate);
            const arrStart = win?.start?.getTime() ?? win?.arrDt?.getTime();
            const depEnd = win?.end?.getTime();
            if (arrStart != null && depEnd != null && depEnd > arrStart) {
                const rem = depEnd - nowMs;
                const overdue = rem < 0;
                const elapsed = nowMs - arrStart;
                const total = depEnd - arrStart;
                const progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
                return {
                    mode: 'dwell',
                    targetIndex: currentIndex,
                    passedBefore: currentIndex,
                    progress,
                    badge: {
                        text: `Стоянка ${formatMmSs(Math.abs(rem))}`,
                        accent: overdue ? 'danger' : 'dwell',
                    },
                };
            }
        }

        if (nextIndex >= 0) {
            const prevIndex = findPrevDepartureIndex(displayStops, nextIndex, selectedDate);
            const prevWin = prevIndex >= 0
                ? deps.buildStopLiveWindow(displayStops, prevIndex, selectedDate)
                : deps.buildStopLiveWindow(displayStops, 0, selectedDate);
            const nextWin = deps.buildStopLiveWindow(displayStops, nextIndex, selectedDate);
            const legStart = prevWin?.end?.getTime() ?? prevWin?.start?.getTime() ?? prevWin?.arrDt?.getTime();
            const legEnd = nextWin?.arrDt?.getTime();
            if (legStart != null && legEnd != null && legEnd > legStart) {
                const rem = legEnd - nowMs;
                const overdue = rem < 0;
                const elapsed = nowMs - legStart;
                const total = legEnd - legStart;
                const progress = Math.min(100, Math.max(0, (elapsed / total) * 100));
                const item = displayStops[nextIndex];
                const title = item?.referenceTitle || item?.threadStop?.station?.title || '';
                return {
                    mode: 'leg',
                    targetIndex: nextIndex,
                    passedBefore: nextIndex,
                    progress,
                    badge: {
                        text: `${shortStationLabel(title, 9)} ${formatMmSs(Math.abs(rem))}`,
                        accent: accentFromRemainingMs(rem, overdue),
                    },
                };
            }
        }

        return null;
    }

    function resetRoutePhaseFills() {
        document.querySelectorAll('[data-route-phase-fill]').forEach((fill) => {
            fill.hidden = true;
            fill.style.height = '0%';
            fill.classList.remove('route-card__phase-fill--breath');
        });
    }

    function resetRouteTurnaroundLabels() {
        document.querySelectorAll('.route-turnaround-label').forEach((el) => {
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-turnaround-label--live');
        });
    }

    function resetRouteMotionDecor() {
        resetRoutePhaseFills();
        resetRouteTurnaroundLabels();
    }

    function clearInactiveTurnaroundLabels(activeTrainIndex) {
        document.querySelectorAll('.route-turnaround-label--live').forEach((el) => {
            if (String(el.dataset.trainIndex) === String(activeTrainIndex)) return;
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-turnaround-label--live');
        });
    }

    function applyRoutePhaseFill(trainIndex, progressPct, { breathe = false } = {}) {
        const card = document.querySelector(
            `#routeGrid .route-card[data-train-index="${trainIndex}"]`,
        );
        const fill = card?.querySelector('[data-route-phase-fill]');
        if (!fill) return;
        const pct = Math.min(100, Math.max(0, Number(progressPct) || 0));
        fill.hidden = false;
        fill.style.height = `${pct}%`;
        fill.classList.toggle('route-card__phase-fill--breath', breathe);
    }

    const TURNAROUND_CLOCK_ICON =
        '<span class="route-turnaround-clock" aria-hidden="true">' +
        '<span class="route-turnaround-clock__dial"></span></span>';

    function applyRouteTurnaroundCountdown(trainIndex, remainingMs) {
        const el = document.querySelector(
            `.route-turnaround-label[data-train-index="${trainIndex}"]`,
        );
        if (!el) return;
        const timeText = formatTurnaroundRemainingRu(remainingMs);
        const timeEl = el.querySelector('.route-turnaround-label__time');
        if (!el.classList.contains('route-turnaround-label--live') || !timeEl) {
            el.innerHTML =
                `${TURNAROUND_CLOCK_ICON}<span class="route-turnaround-label__time">${timeText}</span>`;
            el.classList.add('route-turnaround-label--live');
            return;
        }
        timeEl.textContent = timeText;
    }

    function trainByIndex(trains, trainIndex) {
        if (!Array.isArray(trains)) return null;
        const idx = Number(trainIndex);
        return trains.find((item) => (item?.index ?? -1) === idx) || trains[idx] || null;
    }

    function resolveWaitWindowStartMs(trainIndex, trains, shiftReportDt) {
        const idx = Number(trainIndex);
        if (idx === 0 && shiftReportDt) {
            return shiftReportDt.getTime();
        }
        if (idx > 0) {
            const prev = trainByIndex(trains, idx - 1);
            if (prev?.arrival && prev?.arrivalDate) {
                const arrDt = deps.buildRouteEventDateTime(prev.arrivalDate, prev.arrival);
                if (arrDt) return arrDt.getTime();
            }
        }
        return null;
    }

    function buildWaitProgress(nowDate, trainIndex, endDt, trains, shiftReportDt) {
        if (!endDt || !deps) return null;
        const endMs = endDt.getTime();
        const startMs = resolveWaitWindowStartMs(trainIndex, trains, shiftReportDt);
        if (startMs == null || endMs <= startMs) return null;

        const nowMs = nowDate.getTime();
        const remainingMs = endMs - nowMs;
        const totalMs = endMs - startMs;
        const elapsedMs = Math.max(0, Math.min(nowMs - startMs, totalMs));
        const diffMin = remainingMs / MS_MIN;
        let phase = 'green';
        if (diffMin <= 3) phase = 'red';
        else if (diffMin <= 10) phase = 'yellow';

        return {
            trainIndex,
            phase,
            progress: Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100)),
            remainingMs,
            totalMs,
        };
    }

    function resetRouteCardLiveFooters() {
        document.querySelectorAll('.route-live-travel').forEach((el) => {
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-live-travel--active');
        });
        resetRouteMotionDecor();
    }

    function updateRouteMotion(nowDate, context) {
        const badgeEl = document.getElementById('scheduleMotionBadge');
        if (!context.synced || context.tab !== 'tab-route' || !context.routeTrains?.length) {
            setBadge(badgeEl, '', 'muted');
            resetRouteCardLiveFooters();
            return;
        }

        resetRoutePhaseFills();

        const turnaround = resolveActiveTurnaround(nowDate, context.routeTrains);
        if (turnaround) {
            const header = buildTurnaroundHeaderBadge(turnaround);
            setBadge(badgeEl, header?.text, header?.accent);
            clearInactiveTurnaroundLabels(turnaround.trainIndex);
            applyRoutePhaseFill(turnaround.trainIndex, turnaround.progress, { breathe: true });
            applyRouteTurnaroundCountdown(turnaround.trainIndex, turnaround.remainingMs);
            document.querySelectorAll('.route-live-travel').forEach((el) => {
                const staticText = el.getAttribute('data-static') || '';
                el.textContent = staticText;
                el.classList.remove('route-live-travel--active');
            });
            return;
        }

        resetRouteTurnaroundLabels();

        const active = resolveActiveRouteTrain(nowDate, context.routeTrains);
        const header = buildRouteHeaderBadge(nowDate, active);
        setBadge(badgeEl, header?.text, header?.accent);
        const shiftReportDt = deps?.getShiftReportDateTime?.() || null;

        document.querySelectorAll('.route-live-travel').forEach((el) => {
            const staticText = el.getAttribute('data-static') || '';
            el.textContent = staticText;
            el.classList.remove('route-live-travel--active');
        });

        if (!active?.train) return;

        const idx = active.train.index ?? 0;
        if (active.phase === 'transit') {
            const depDt = deps.buildRouteEventDateTime(
                active.train.departureDate,
                active.train.departure,
            );
            const arrDt = active.arrDt;
            if (depDt && arrDt) {
                const totalMs = arrDt.getTime() - depDt.getTime();
                const elapsedMs = nowDate.getTime() - depDt.getTime();
                if (totalMs > 0) {
                    applyRoutePhaseFill(idx, (elapsedMs / totalMs) * 100, { breathe: true });
                }
            }
            if (!arrDt) return;
            const rem = arrDt.getTime() - nowDate.getTime();
            const travelEl = document.querySelector(`.route-live-travel[data-train-index="${idx}"]`);
            if (travelEl) {
                travelEl.textContent = `В пути: ${formatMmSs(Math.max(0, rem))}`;
                travelEl.classList.add('route-live-travel--active');
            }
            return;
        }

        if (active.phase === 'before' && active.depDt) {
            const wait = buildWaitProgress(
                nowDate,
                idx,
                active.depDt,
                context.routeTrains,
                shiftReportDt,
            );
            if (wait) applyRoutePhaseFill(wait.trainIndex, wait.progress, { breathe: true });
        }
    }

    function applyProgressBarState(bar, fill, motion, isTarget) {
        bar.classList.remove('station-progress-bar--leg', 'station-progress-bar--dwell', 'station-progress-bar--pulse');
        if (!isTarget || !motion) {
            bar.hidden = true;
            fill.style.width = '0%';
            return;
        }
        bar.hidden = false;
        fill.style.width = `${motion.progress}%`;
        if (motion.mode === 'dwell') {
            bar.classList.add('station-progress-bar--dwell');
        } else {
            bar.classList.add('station-progress-bar--leg');
        }
    }

    function updateScheduleMotion(nowDate, context) {
        const badgeEl = document.getElementById('scheduleMotionBadge');
        if (!context.synced || context.tab !== 'tab-schedule' || !context.displayStops?.length) {
            if (context.tab !== 'tab-route') setBadge(badgeEl, '', 'muted');
            clearTimelineMotion();
            return;
        }

        const motion = analyzeScheduleMotion(context.displayStops, context.selectedDate, nowDate);
        if (motion?.badge) {
            setBadge(badgeEl, motion.badge.text, motion.badge.accent);
        } else {
            setBadge(badgeEl, '', 'muted');
        }

        const nodes = document.querySelectorAll('#stationsList .station-node');
        nodes.forEach((node, index) => {
            const passed = motion && index < motion.passedBefore;
            node.classList.toggle('passed', passed);

            const bar = node.querySelector('[data-leg-progress]');
            const fill = bar?.querySelector('.fill');
            if (!bar || !fill) return;

            const isTarget = motion && index === motion.targetIndex;
            applyProgressBarState(bar, fill, motion, isTarget);
        });
    }

    function clearTimelineMotion() {
        document.querySelectorAll('#stationsList .station-node.passed').forEach((node) => {
            node.classList.remove('passed');
        });
        document.querySelectorAll('#stationsList [data-leg-progress]').forEach((bar) => {
            const fill = bar.querySelector('.fill');
            applyProgressBarState(bar, fill, null, false);
        });
    }

    function updateTimers(context) {
        if (!deps || !context?.nowDate) {
            clearTimelineMotion();
            resetRouteCardLiveFooters();
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            return;
        }

        const screenSchedule = document.getElementById('screen-schedule');
        if (!screenSchedule || screenSchedule.classList.contains('hidden')) {
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            clearTimelineMotion();
            resetRouteCardLiveFooters();
            return;
        }

        if (context.tab === 'tab-route') {
            updateRouteMotion(context.nowDate, context);
            clearTimelineMotion();
        } else if (context.tab === 'tab-schedule') {
            updateScheduleMotion(context.nowDate, context);
            resetRouteCardLiveFooters();
        } else {
            setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
            clearTimelineMotion();
            resetRouteCardLiveFooters();
        }
    }

    function resetMotionForNavigation() {
        clearTimelineMotion();
        resetRouteCardLiveFooters();
        setBadge(document.getElementById('scheduleMotionBadge'), '', 'muted');
    }

    global.TrainMotionTimer = {
        init(api) {
            deps = api || null;
        },
        updateTimers,
        clearTimelineMotion,
        resetRouteCardLiveFooters,
        resetMotionForNavigation,
        formatMmSs,
    };
})(typeof window !== 'undefined' ? window : globalThis);
