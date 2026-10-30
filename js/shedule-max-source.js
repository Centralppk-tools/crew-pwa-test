/** Источник расписания Цифрового помощника: публичный бакет S3 (Shedule_Max). */
(function (global) {
    const DIRS = ['from_moscow', 'to_moscow'];

    function cfg() {
        return global.APP_CONFIG?.sheduleMax || {};
    }

    function s3Base() {
        return String(cfg().s3BaseUrl || 'https://shedulemax-public.s3.cloud.ru').replace(/\/$/, '');
    }

    function useDirectS3() {
        return Boolean(s3Base()) && cfg().useDirectS3 !== false;
    }

    const dayStopsCache = Object.create(null);
    const dayStopsInflight = Object.create(null);
    const trainStopsMem = Object.create(null);
    const dayBundleMem = Object.create(null);
    const dayBundleInflight = Object.create(null);
    const dayStopsBundleUnavailable = Object.create(null);
    const FETCH_TIMEOUT_MS = 4500;
    const BUNDLE_FETCH_TIMEOUT_MS = 12000;
    const DAY_CACHE_NAME = 'da_shedulemax_tpl_v3';
    const ROUTE_STOP_LS = 'da_route_stop_v1:';
    const ROUTE_UPDATED_LS = 'da_route_updated_at';

    function stopPayloadFresh(payload) {
        return Boolean(payload && Array.isArray(payload.stops) && payload.stops.length > 0);
    }

    function stopPayloadMatchesDate(payload, date) {
        const want = String(date || '').trim().slice(0, 10);
        if (!want) return true;
        const got = String(payload?.date || payload?.scheduleDate || '').trim().slice(0, 10);
        return !got || got === want;
    }

    function normalizeStopLoadError(err, fallbackCode = 'FETCH_FAILED') {
        const error = err instanceof Error ? err : new Error(String(err || 'Ошибка загрузки нитки'));
        if (!error.code) {
            if (error.name === 'AbortError') error.code = 'TIMEOUT';
            else if (Number(error.status) === 404) error.code = 'NOT_FOUND';
            else error.code = fallbackCode;
        }
        return error;
    }

    function weekdayTemplateId(dateIso) {
        const parts = String(dateIso || '').split('-').map(Number);
        if (parts.length < 3 || !parts[0]) return 'MON_THU';
        const weekday = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
        if (weekday === 0) return 'SUN';
        if (weekday === 5) return 'FRI';
        if (weekday === 6) return 'SAT';
        return 'MON_THU';
    }

    function scheduleObjectPath(date) {
        const day = String(date || '').trim().slice(0, 10);
        if (!day) return `data/cache_schedule/schedule_${weekdayTemplateId(date)}.json`;
        return `data/cache_schedule/${dayToken(day)}.json`;
    }

    function dayStopsPath(date) {
        return '';
    }

    function routeStopStorageKey(date, trainNumber) {
        const day = String(date || '').trim().slice(0, 10);
        const num = String(trainNumber || '').replace(/\D/g, '');
        return day && num ? `${ROUTE_STOP_LS}${day}|${num}` : '';
    }

    function readRouteStopFromDevice(date, trainNumber) {
        const key = routeStopStorageKey(date, trainNumber);
        if (!key) return null;
        try {
            const raw = global.localStorage?.getItem(key);
            if (!raw) return null;
            const payload = JSON.parse(raw);
            return stopPayloadFresh(payload) ? payload : null;
        } catch {
            return null;
        }
    }

    function writeRouteStopToDevice(date, trainNumber, payload) {
        const key = routeStopStorageKey(date, trainNumber);
        if (!key || !payload) return;
        try {
            global.localStorage?.setItem(key, JSON.stringify(payload));
        } catch {
            /* quota */
        }
    }

    function clearRouteTrainStopsForShift(pairs) {
        (pairs || []).forEach((item) => {
            const day = String(item?.date || '').trim().slice(0, 10);
            const num = String(item?.trainNumber || '').replace(/\D/g, '');
            if (!day || !num) return;
            delete trainStopsMem[trainStopsKey(day, num)];
            const lsKey = routeStopStorageKey(day, num);
            try {
                global.localStorage?.removeItem(lsKey);
            } catch {
                /* ignore */
            }
        });
    }

    function markRouteDataUpdated(iso) {
        const stamp = iso || new Date().toISOString();
        try {
            global.localStorage?.setItem(ROUTE_UPDATED_LS, stamp);
        } catch {
            /* ignore */
        }
        return stamp;
    }

    function getRouteDataUpdatedLabel() {
        let raw = '';
        try {
            raw = global.localStorage?.getItem(ROUTE_UPDATED_LS) || '';
        } catch {
            return '';
        }
        if (!raw) return '';
        const dt = new Date(raw);
        if (Number.isNaN(dt.getTime())) return '';
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    function trainStopsKey(date, number) {
        const day = String(date || '').trim();
        const num = String(number || '').replace(/\D/g, '');
        return day && num ? `${day}|${num}` : '';
    }

    function dayToken(iso) {
        return String(iso || '').trim().replace(/-/g, '_');
    }

    function expectedThreadRev() {
        const cfgRev = cfg().threadRev;
        if (cfgRev !== undefined && cfgRev !== null && String(cfgRev).trim() !== '') {
            return String(cfgRev).trim();
        }
        return String(global.APP_CONFIG?.APP_BUILD_ID || global.APP_BUILD_ID || '1')
            .replace(/[^\w.-]/g, '_');
    }

    function revQuery() {
        return `rev=${encodeURIComponent(expectedThreadRev())}`;
    }

    function datedStopObjectPath(date, trainNumber) {
        const day = String(date || '').trim().slice(0, 10);
        const num = String(trainNumber || '').replace(/\D/g, '');
        if (!day || !num) return '';
        return `data/cache_stops/${dayToken(day)}/${num}.json`;
    }

    function stopsBundleObjectPath(date) {
        const day = String(date || '').trim().slice(0, 10);
        return day ? `data/cppk_export/stops/stops_${day}.json` : '';
    }

    function stopRowHasClock(stop) {
        if (!stop) return false;
        const values = [
            stop.arrival,
            stop.departure,
            stop.arr,
            stop.dep,
            stop.arrTime,
            stop.depTime,
        ];
        return values.some((value) => String(value || '').trim() && String(value).trim() !== '...');
    }

    function stopsPayloadHasMiddleClocks(payload) {
        const raw = Array.isArray(payload?.stops) ? payload.stops : [];
        if (raw.length < 3) return false;
        const middles = raw.slice(1, -1);
        return middles.some(stopRowHasClock);
    }

    function pickThreadFromBundle(bundle, number, voyageCode) {
        if (!bundle || bundle.format !== 'stops_bundle_v1') return null;
        const byId = bundle.threadsByScheduleId || {};
        const byNum = bundle.threadsByTrainNumber || {};
        const code = String(voyageCode || '').trim();
        if (code && byId[code]) return { ...byId[code] };
        const num = String(number || '').replace(/\D/g, '');
        if (num && byNum[num]) return { ...byNum[num] };
        return null;
    }

    async function loadDayStopsBundle(day, fresh) {
        const key = String(day || '').trim().slice(0, 10);
        if (!key || !useDirectS3()) return null;
        if (!fresh && dayStopsBundleUnavailable[key]) return null;
        if (!fresh && dayBundleMem[key]) return dayBundleMem[key];
        if (dayBundleInflight[key]) return dayBundleInflight[key];
        const path = stopsBundleObjectPath(key);
        if (!path) return null;
        const bust = fresh ? `?t=${Date.now()}` : '';
        const url = s3Url(`${path}${bust}`);
        dayBundleInflight[key] = readJson(url, BUNDLE_FETCH_TIMEOUT_MS, { fresh: Boolean(fresh) })
            .then((payload) => {
                delete dayBundleInflight[key];
                if (payload?.format === 'stops_bundle_v1') {
                    dayBundleMem[key] = payload;
                    return payload;
                }
                dayStopsBundleUnavailable[key] = true;
                return null;
            })
            .catch((err) => {
                delete dayBundleInflight[key];
                dayStopsBundleUnavailable[key] = true;
                if (err?.code !== 'NOT_FOUND') {
                    console.warn('[shedule-max] day bundle miss', key, err?.code || err?.message);
                }
                return null;
            });
        return dayBundleInflight[key];
    }

    async function dayStopsBundleAvailable(day, fresh) {
        const bundle = await loadDayStopsBundle(day, fresh);
        return Boolean(bundle);
    }

    async function loadTrainStopsFromDayBundle(day, number, uid, fresh) {
        const bundle = await loadDayStopsBundle(day, fresh);
        const slice = pickThreadFromBundle(bundle, number, uid);
        if (!slice || !stopPayloadFresh(slice)) return null;
        return slice;
    }

    function datedStopFetchUrl(date, trainNumber, fresh) {
        const path = datedStopObjectPath(date, trainNumber);
        if (!path) return '';
        if (!useDirectS3()) return '';
        const bust = fresh ? `?t=${Date.now()}` : '';
        return s3Url(`${path}${bust}`);
    }

    function stopFilePath(uid) {
        const id = String(uid || '').trim();
        return id ? `data/cache_stops/stop_${id}.json?${revQuery()}` : '';
    }

    function s3Url(path) {
        return `${s3Base()}/${String(path || '').replace(/^\//, '')}`;
    }

    function stopResourceUrl(objectPath) {
        const path = String(objectPath || '').replace(/^\//, '');
        if (!path || !useDirectS3()) return '';
        const withRev = path.includes('?') ? path : `${path}?${revQuery()}`;
        return s3Url(withRev);
    }

    function clockHms(value) {
        const match = String(value || '').trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return '';
        const hour = String(Number(match[1])).padStart(2, '0');
        return `${hour}:${match[2]}:${match[3] || '00'}`;
    }

    function clockToSeconds(value) {
        const match = String(value || '').trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;
        return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
    }

    function expandRepeatedHalt(arr, dep, { skip, first, last } = {}) {
        const arrival = clockHms(arr);
        const departure = clockHms(dep);
        if (skip || first || last || !arrival || !departure) {
            return { arr: arrival, dep: departure, seconds: 0 };
        }
        const start = clockToSeconds(arrival);
        const end = clockToSeconds(departure);
        if (start == null || end == null) {
            return { arr: arrival, dep: departure, seconds: 0 };
        }
        if (start === end) {
            return { arr: arrival, dep: departure, seconds: 0 };
        }
        let seconds = end - start;
        if (seconds < 0) seconds += 24 * 3600;
        return { arr: arrival, dep: departure, seconds };
    }

    function clockToIso(_date, clock) {
        return clockHms(clock);
    }

    function isSkipStop(stop, index, total) {
        if (!stop) return true;
        if (stop.skip || stop.isPass || stop.pass || stop.is_stop === false) return true;
        const first = Number(index) === 0;
        const last = Number(total) > 1 && Number(index) === Number(total) - 1;
        if (first || last) return false;
        return !String(stop.arr || '').trim() && !String(stop.dep || '').trim();
    }

    function mapBoardTrain(train, date, direction) {
        const number = String(train?.trainNumber || '').trim();
        const uid = String(train?.voyageCode || train?.scheduleId || number).trim();
        const dep = clockHms(train?.depTime || train?.departure || train?.departure_time || train?.segDep);
        const arr = clockHms(train?.arrTime || train?.arrival || train?.arrival_time || train?.segArr);
        const express = /экспресс|рэкс/i.test(String(train?.serviceType || train?.category || ''));
        const rawStops = Array.isArray(train?.stops) ? train.stops : [];
        const alreadyMapped = rawStops.length && rawStops[0]?.station;
        const mappedTrip = rawStops.length && !alreadyMapped
            ? mapStops(train, number, date)
            : null;
        return {
            thread: {
                uid,
                number,
                title: String(train?.route || ''),
                transport_type: 'suburban',
                express_type: express ? 'express' : null,
            },
            departure: dep || mappedTrip?.departure || '',
            arrival: arr || mappedTrip?.arrival || '',
            depTime: dep || mappedTrip?.depTime || '',
            arrTime: arr || mappedTrip?.arrTime || '',
            stops: alreadyMapped ? rawStops : (mappedTrip?.stops || undefined),
            days: null,
            except_days: null,
            is_fuzzy: false,
            _sheduleMax: {
                date,
                direction,
                voyageCode: String(train?.voyageCode || uid).trim(),
                scheduleId: String(train?.scheduleId || '').trim(),
                trainNumber: number,
            },
        };
    }

    function mapStops(payload, trainNumber, date) {
        const raw = Array.isArray(payload?.stops) ? payload.stops : [];
        const stops = raw.map((stop, index) => {
            const skipped = isSkipStop(stop, index, raw.length);
            const title = String(stop?.name || 'Станция');
            const expanded = expandRepeatedHalt(stop?.arr, stop?.dep, {
                skip: skipped,
                first: index === 0,
                last: raw.length > 1 && index === raw.length - 1,
            });
            const givenSec = Number(stop?.stop_seconds);
            const stopSeconds = Number.isFinite(givenSec) && givenSec > 0 ? givenSec : expanded.seconds;
            return {
                station: {
                    title,
                    code: String(stop?.nnst || ''),
                },
                arrival: expanded.arr || null,
                departure: expanded.dep || null,
                stop_time: stopSeconds,
                stop_seconds: stopSeconds,
                dwell: stop?.dwell || '',
                skip: skipped,
                is_stop: !skipped,
                timeEstimated: false,
            };
        });
        const halts = stops.filter((stop) => !stop.skip);
        const first = halts[0] || stops[0];
        const last = halts[halts.length - 1] || stops[stops.length - 1];
        const departureTime = clockHms(payload?.depTime) || clockHms(first?.departure);
        const arrivalTime = clockHms(payload?.arrTime) || clockHms(last?.arrival);
        let durationMins = null;
        const depParts = departureTime.split(':').map(Number);
        const arrParts = arrivalTime.split(':').map(Number);
        if (depParts.length >= 2 && arrParts.length >= 2) {
            const dMin = depParts[0] * 60 + depParts[1];
            const aMin = arrParts[0] * 60 + arrParts[1];
            durationMins = aMin >= dMin ? aMin - dMin : aMin + 1440 - dMin;
        }
        const origin = first?.station?.title || '';
        const dest = last?.station?.title || '';
        const trip = {
            number: String(payload?.trainNumber || trainNumber || ''),
            uid: String(payload?.voyageCode || ''),
            title: payload?.route || (origin && dest ? `${origin} — ${dest}` : ''),
            transport_type: /экспресс/i.test(String(payload?.serviceType || '')) ? 'РЭКС / Экспресс' : 'Пригородный',
            departure: departureTime,
            arrival: arrivalTime,
            depTime: departureTime,
            arrTime: arrivalTime,
            duration: durationMins,
            stops,
            scheduleDate: date,
            serviceDays: null,
            source: 'shedule-max',
        };
        return trip;
    }

    async function openDayCache() {
        if (!global.caches?.open) return null;
        try {
            return await global.caches.open(DAY_CACHE_NAME);
        } catch {
            return null;
        }
    }

    function openDayIdb() {
        if (!global.indexedDB) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                const req = global.indexedDB.open('da_shedulemax_idb', 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains('day')) {
                        req.result.createObjectStore('day');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    async function idbGetJson(url) {
        const db = await openDayIdb();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction('day', 'readonly');
                const req = tx.objectStore('day').get(url);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    async function idbPutJson(url, payload) {
        const db = await openDayIdb();
        if (!db || !payload) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction('day', 'readwrite');
                tx.objectStore('day').put(payload, url);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    async function readCachedJson(url) {
        const cache = await openDayCache();
        if (cache) {
            try {
                const hit = await cache.match(url);
                if (hit?.ok) return await hit.json();
            } catch {
                /* fall through to IDB */
            }
        }
        return idbGetJson(url);
    }

    async function writeCachedResponse(url, response, payload) {
        if (payload) void idbPutJson(url, payload);
        const cache = await openDayCache();
        if (!cache || !response) return;
        try {
            await cache.put(url, response);
        } catch {
            /* quota / private mode */
        }
    }

    function withCacheBust(url, fresh) {
        if (!fresh) return url;
        const sep = String(url).includes('?') ? '&' : '?';
        return `${url}${sep}_t=${Date.now()}`;
    }

    async function readJson(url, timeoutMs = FETCH_TIMEOUT_MS, options = {}) {
        const fresh = options.fresh === true;
        const controller = new AbortController();
        const timer = global.setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(withCacheBust(url, fresh), {
                signal: controller.signal,
                cache: fresh ? 'no-store' : 'default',
            });
        } catch (err) {
            const fail = new Error(
                err?.name === 'AbortError'
                    ? 'Превышено время ожидания расписания'
                    : 'Не удалось связаться с хранилищем расписания'
            );
            fail.cause = err;
            fail.code = err?.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED';
            throw fail;
        } finally {
            global.clearTimeout(timer);
        }
        if (res.status === 404) {
            const miss = new Error('Файл расписания ещё не создан');
            miss.code = 'NOT_FOUND';
            miss.status = 404;
            throw miss;
        }
        if (!res.ok) {
            const fail = new Error(`Расписание недоступно (HTTP ${res.status})`);
            fail.code = 'FETCH_FAILED';
            throw fail;
        }
        let payload = null;
        try {
            payload = await res.clone().json();
        } catch {
            payload = null;
        }
        if (!payload) {
            const fail = new Error('Некорректный JSON расписания');
            fail.code = 'FETCH_FAILED';
            throw fail;
        }
        if (!fresh) {
            void writeCachedResponse(url, res, payload);
        }
        return payload;
    }

    function trainsFromBoardPayload(payload, direction) {
        if (!payload) return [];
        const trains = payload.trains || payload[direction] || [];
        return Array.isArray(trains) ? trains : [];
    }

    async function readBoardPayload(url, options = {}) {
        const forceRefresh = options.forceRefresh === true;
        if (!url) return null;
        if (!forceRefresh) {
            const cached = await readCachedJson(url);
            if (cached) return cached;
        }
        return readJson(url, FETCH_TIMEOUT_MS, { fresh: forceRefresh });
    }

    function mapBoardTrains(payload, date, direction) {
        const trains = trainsFromBoardPayload(payload, direction);
        if (!trains.length) return null;
        return trains.map((train) => mapBoardTrain(train, date, direction));
    }

    async function fetchBoardFromS3(date, direction, errors, options = {}) {
        if (!useDirectS3()) return null;
        const path = scheduleObjectPath(date);
        try {
            const url = s3Url(path);
            const payload = await readBoardPayload(url, options);
            return mapBoardTrains(payload, date, direction);
        } catch (err) {
            errors.push(normalizeStopLoadError(err));
        }
        return null;
    }

    async function fetchBoardDirection(date, direction, errors, options = {}) {
        return fetchBoardFromS3(date, direction, errors, options);
    }

    async function fetchYaroslavlBoard(date, options = {}) {
        const errors = [];
        const payloadTrains = await Promise.all(
            DIRS.map((direction) => fetchBoardDirection(date, direction, errors, options)),
        );
        const schedule = mergeBoardTrainLists(payloadTrains);
        if (schedule.length) return schedule;
        throw errors[0] || new Error(`Табло ${date} недоступно`);
    }

    function mergeBoardTrainLists(payloadTrains) {
        const schedule = [];
        const seen = new Set();
        (payloadTrains || []).forEach((trains) => {
            (trains || []).forEach((item) => {
                const key = `${item.thread?.number || ''}@${item.thread?.uid || ''}@${item.departure || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                schedule.push(item);
            });
        });
        return schedule;
    }

    function isTripPayload(value) {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value)
            && (Array.isArray(value.stops) || value.trainNumber || value.voyageCode || value.depTime));
    }

    function tripMatches(trip, number, uid) {
        if (!isTripPayload(trip)) return false;
        const trainNumber = String(trip.trainNumber || trip.number || '').trim();
        const voyage = String(trip.voyageCode || '').trim();
        const scheduleId = String(trip.scheduleId || '').trim();
        if (uid && (voyage === uid || scheduleId === uid || trainNumber === uid)) return true;
        if (number && trainNumber === number) return true;
        return false;
    }

    function pickTripFromDayDoc(doc, number, uid) {
        if (!doc || typeof doc !== 'object') return null;
        if (Array.isArray(doc.stops) && (tripMatches(doc, number, uid) || !doc.trainNumber)) {
            return doc;
        }
        const keyed = (number && doc[number]) || (uid && (doc[uid] || doc[String(uid)]));
        if (isTripPayload(keyed) && (tripMatches(keyed, number, uid) || (!uid && number && String(keyed.trainNumber || number) === number))) {
            return keyed;
        }
        const lists = [];
        if (Array.isArray(doc)) lists.push(doc);
        ['trains', 'items', 'trips', 'data'].forEach((key) => {
            if (Array.isArray(doc[key])) lists.push(doc[key]);
        });
        for (const list of lists) {
            const hit = list.find((trip) => tripMatches(trip, number, uid));
            if (hit) return hit;
        }
        for (const value of Object.values(doc)) {
            if (tripMatches(value, number, uid)) return value;
        }
        return null;
    }

    async function loadDayStopsDoc(date) {
        const day = String(date || '').trim();
        if (!day) return null;
        if (Object.prototype.hasOwnProperty.call(dayStopsCache, day)) {
            return dayStopsCache[day];
        }
        if (dayStopsInflight[day]) return dayStopsInflight[day];
        const url = s3Url(dayStopsPath(day));
        dayStopsInflight[day] = (async () => {
            try {
                const cached = await readCachedJson(url);
                if (cached) {
                    dayStopsCache[day] = cached;
                    return cached;
                }
                const payload = await readJson(url, FETCH_TIMEOUT_MS);
                dayStopsCache[day] = payload;
                return payload;
            } catch {
                dayStopsCache[day] = null;
                return null;
            }
        })();
        try {
            return await dayStopsInflight[day];
        } finally {
            delete dayStopsInflight[day];
        }
    }

    function threadLookupKeys(trainData) {
        const number = String(trainData?.thread?.number || trainData?.number || trainData?._sheduleMax?.trainNumber || '').trim();
        const uid = String(
            trainData?._sheduleMax?.voyageCode
            || trainData?.thread?.uid
            || trainData?._sheduleMax?.scheduleId
            || ''
        ).trim();
        return { number, uid };
    }

    function threadFromPayload(payload, number, date) {
        if (!payload) return null;
        const raw = Array.isArray(payload.stops) ? payload.stops : [];
        if (!raw.length) return mapStops(payload, number, date);
        const cppkShape = raw[0]?.name && !raw[0]?.station?.title;
        if (cppkShape || raw.some((stop) => stop?.arr || stop?.dep)) {
            return mapStops(payload, number, date);
        }
        if (raw[0]?.station && stopsPayloadHasMiddleClocks(payload)) {
            return {
                ...payload,
                number: payload.number || payload.trainNumber || number,
                stops: raw,
            };
        }
        if (raw.some((stop) => stop?.arr || stop?.dep)) {
            const normalized = {
                ...payload,
                stops: raw.map((stop) => ({
                    ...stop,
                    name: stop.name || stop.station?.title || '',
                })),
            };
            return mapStops(normalized, number, date);
        }
        return mapStops(payload, number, date);
    }

    function lookupStopsByTrain(date, trainNumber) {
        const day = String(date || '').trim();
        const number = String(trainNumber || '').replace(/\D/g, '');
        if (!day || !number) return null;
        if (dayStopsBundleUnavailable[day]) return null;
        let mem = trainStopsMem[trainStopsKey(day, number)];
        if (!mem || !stopPayloadMatchesDate(mem, day)) {
            mem = readRouteStopFromDevice(day, number);
            if (mem) trainStopsMem[trainStopsKey(day, number)] = mem;
        }
        if (!mem || !stopPayloadMatchesDate(mem, day)) return null;
        return threadFromPayload(mem, number, day);
    }

    function lookupThreadSync(trainData, date) {
        const day = String(date || '').trim();
        if (!day) return null;
        const { number, uid } = threadLookupKeys(trainData);
        const byNumber = lookupStopsByTrain(day, number);
        if (byNumber) return byNumber;
        if (dayStopsBundleUnavailable[day]) return null;
        const mem = trainStopsMem[trainStopsKey(day, number)];
        if (mem && stopPayloadMatchesDate(mem, day)) return threadFromPayload(mem, number, date);
        return null;
    }

    function rememberStopsPayload(key, url, payload) {
        if (!payload || !Array.isArray(payload.stops) || !payload.stops.length) return null;
        trainStopsMem[key] = payload;
        const parts = String(key || '').split('|');
        if (parts.length === 2) {
            writeRouteStopToDevice(parts[0], parts[1], payload);
        }
        return payload;
    }

    function assertStopPayloadUsable(payload) {
        if (!payload || !Array.isArray(payload.stops) || !payload.stops.length) {
            const err = new Error('В ответе нет остановок');
            err.code = 'EMPTY_STOPS';
            throw err;
        }
        if (!stopPayloadFresh(payload)) {
            const err = new Error('В ответе нет остановок');
            err.code = 'EMPTY_STOPS';
            throw err;
        }
        return payload;
    }

    async function readStopPayloadFromUrl(url, fresh) {
        if (!url) return null;
        if (!fresh) {
            const cached = await readCachedJson(url);
            if (cached && stopPayloadFresh(cached)) return cached;
        }
        try {
            const payload = await readJson(url, FETCH_TIMEOUT_MS, { fresh: Boolean(fresh) });
            return stopPayloadFresh(payload) ? payload : null;
        } catch {
            return null;
        }
    }

    async function loadTrainStops(date, number, uid, direction = 'from_moscow', options = {}) {
        const key = trainStopsKey(date, number);
        if (!key) {
            const err = new Error('Нет даты или номера поезда');
            err.code = 'INVALID_ARGS';
            if (options.bypassCache === true) throw err;
            return null;
        }
        const bypassCache = options.bypassCache === true;
        const fresh = options.fresh === true || bypassCache;
        const day = String(date || '').trim().slice(0, 10);
        const num = String(number || '').replace(/\D/g, '');

        if (bypassCache) {
            delete trainStopsMem[key];
            try {
                global.localStorage?.removeItem(routeStopStorageKey(day, num));
            } catch {
                /* ignore */
            }
        } else if (trainStopsMem[key] && !fresh) {
            if (stopsPayloadHasMiddleClocks(trainStopsMem[key])) {
                return trainStopsMem[key];
            }
            delete trainStopsMem[key];
        } else if (!fresh) {
            const offline = readRouteStopFromDevice(day, num);
            if (offline && stopsPayloadHasMiddleClocks(offline)) {
                trainStopsMem[key] = offline;
                return offline;
            }
        }

        const tryStore = (payload) => {
            if (!stopPayloadFresh(payload)) return null;
            if (!stopPayloadMatchesDate(payload, day)) return null;
            return rememberStopsPayload(key, '', payload);
        };

        if (!useDirectS3()) {
            const err = new Error('S3 не настроен для ниток');
            err.code = 'NO_S3';
            if (bypassCache) throw err;
            return readRouteStopFromDevice(day, num);
        }

        const storeFromBundle = async () => {
            const fromBundle = await loadTrainStopsFromDayBundle(day, num, uid, fresh || bypassCache);
            if (!fromBundle) return null;
            const stored = tryStore(fromBundle);
            if (stored) markRouteDataUpdated();
            return stored;
        };

        const bundleStored = await storeFromBundle();
        if (bundleStored) return bundleStored;

        if (dayStopsBundleUnavailable[day] && !fresh && !bypassCache) {
            return null;
        }

        if (bypassCache) {
            if (dayStopsBundleUnavailable[day]) {
                return null;
            }
            const err = new Error(`Поезд ${num} не найден на сервере (${day})`);
            err.code = 'NOT_FOUND';
            throw err;
        }
        return null;
    }

    async function hydrateDayStopsCacheOnly(_date) {
        return null;
    }

    async function fetchThread(trainData, date) {
        const sync = lookupThreadSync(trainData, date);
        if (sync) return sync;
        const { number, uid } = threadLookupKeys(trainData);
        const payload = await loadTrainStops(date, number, uid, 'from_moscow', {});
        if (!payload) return null;
        return threadFromPayload(payload, number, date);
    }

    async function deleteIndexedDbSchedule() {
        if (!global.indexedDB) return;
        await new Promise((resolve) => {
            try {
                const req = global.indexedDB.deleteDatabase('da_shedulemax_idb');
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    function wipeInMemoryScheduleCaches() {
        Object.keys(dayStopsCache).forEach((k) => { delete dayStopsCache[k]; });
        Object.keys(dayStopsInflight).forEach((k) => { delete dayStopsInflight[k]; });
        Object.keys(trainStopsMem).forEach((k) => { delete trainStopsMem[k]; });
        Object.keys(dayBundleMem).forEach((k) => { delete dayBundleMem[k]; });
        Object.keys(dayBundleInflight).forEach((k) => { delete dayBundleInflight[k]; });
        Object.keys(dayStopsBundleUnavailable).forEach((k) => { delete dayStopsBundleUnavailable[k]; });
    }

    async function clearCacheStopsFromCacheStorage() {
        if (!global.caches?.keys) return;
        try {
            const names = await global.caches.keys();
            for (const name of names) {
                const cache = await global.caches.open(name);
                const requests = await cache.keys();
                await Promise.all(requests
                    .filter((req) => /cache_stops/i.test(req.url))
                    .map((req) => cache.delete(req)));
            }
        } catch (err) {
            console.warn('[shedule-max] CacheStorage cache_stops clear failed', err);
        }
    }

    async function clearAllScheduleCachesFromStorage() {
        if (!global.caches?.keys) return;
        try {
            const names = await global.caches.keys();
            for (const name of names) {
                if (/shedulemax|da_shedule/i.test(name)) {
                    await global.caches.delete(name);
                    continue;
                }
                const cache = await global.caches.open(name);
                const requests = await cache.keys();
                await Promise.all(requests
                    .filter((req) => /cache_stops|cache_schedule|shedulemax-public/i.test(req.url))
                    .map((req) => cache.delete(req)));
            }
        } catch (err) {
            console.warn('[shedule-max] CacheStorage schedule clear failed', err);
        }
        try {
            await global.caches.delete(DAY_CACHE_NAME);
        } catch {
            /* ignore */
        }
    }

    /** Полный сброс кэша ниток и остановок (память + IDB + Cache Storage). */
    async function forceResetAllCaches() {
        wipeInMemoryScheduleCaches();
        await clearAllScheduleCachesFromStorage();
        await deleteIndexedDbSchedule();
    }

    async function clearShiftThreadCaches() {
        await forceResetAllCaches();
    }

    async function clearNetworkCaches() {
        await clearShiftThreadCaches();
        if (!global.caches?.keys) return;
        try {
            const names = await global.caches.keys();
            await Promise.all(names.filter((n) => /shedulemax/i.test(n))
                .map((n) => global.caches.delete(n)));
        } catch (err) {
            console.warn('[shedule-max] cache clear failed', err);
        }
    }

    global.SheduleMaxSource = {
        fetchYaroslavlBoard,
        fetchThread,
        lookupThreadSync,
        lookupStopsByTrain,
        loadTrainStops,
        dayStopsBundleAvailable,
        isDayStopsBundleUnavailable(day) {
            const key = String(day || '').trim().slice(0, 10);
            return Boolean(key && dayStopsBundleUnavailable[key]);
        },
        stopsPayloadHasMiddleClocks,
        hydrateDayStopsCacheOnly,
        prefetchDayStops: hydrateDayStopsCacheOnly,
        clearRouteTrainStopsForShift,
        markRouteDataUpdated,
        getRouteDataUpdatedLabel,
        clearNetworkCaches,
        clearShiftThreadCaches: clearRouteTrainStopsForShift,
        forceResetAllCaches,
        wipeInMemoryScheduleCaches,
        expectedThreadRev,
        clockHms,
        clockToIso,
        enabled() {
            return Boolean(s3Base());
        },
    };
})(window);
