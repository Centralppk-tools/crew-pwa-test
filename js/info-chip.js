/** Компактные информационные чипы: пробы, тупики, предупреждения. */
(function (global) {
    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatKmPiket(km, piket) {
        const kmText = String(km ?? '').trim();
        if (!kmText) return '';
        const pkText = String(piket ?? '').trim();
        if (!pkText) return kmText;
        return `${kmText}.${pkText}`;
    }

    function compactKmPiketText(text) {
        return String(text || '')
            .replace(/(\d+)\s*км(?:\.|\s+)(?:(\d+)\s*пк)?/gi, (_, km, pk) => (pk ? `${km}.${pk}` : km))
            .replace(/(\d+)\s*пк\s*(\d+)/gi, '$1.$2')
            .replace(/ограничен[иея](?:\s+скорости)?/gi, '')
            .replace(/скорость\s*/gi, '')
            .replace(/⚠️\s*/g, '')
            .replace(/\s+на\s+/gi, ' ')
            .replace(/\s*[—–\-]+\s*/g, ' · ')
            .replace(/\s*км\/ч/gi, 'км/ч')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function formatSpeedValue(km, piket, speed) {
        const loc = formatKmPiket(km, piket);
        const spd = String(speed ?? '').replace(/[^\d.,]/g, '').replace(',', '.');
        if (loc && spd) return `${loc} · ${spd}км/ч`;
        if (spd) return `${spd}км/ч`;
        return loc;
    }

    function fromText(text) {
        const raw = compactKmPiketText(text);
        if (!raw) return null;
        const typed = raw.match(/^(ПТ|ЭПТ|ТП|ТУП|ТУПИК|!|ТО)\s*(?:·|:)?\s*(.*)$/i);
        if (typed) {
            let prefix = typed[1].toUpperCase();
            if (prefix === 'ТУПИК' || prefix === 'ТУП') prefix = 'ТП';
            return { prefix, value: typed[2].trim(), variant: 'warn' };
        }
        if (/км\/ч|\d+\.\d+\s*·\s*\d+/i.test(raw)) {
            return { prefix: '!', value: raw, variant: 'warn' };
        }
        return { prefix: '', value: raw, variant: 'warn' };
    }

    function fromBrake(prefix, rec, extra) {
        const bits = [formatKmPiket(rec?.km, rec?.piket)];
        const extraText = String(extra || '').trim();
        if (extraText) bits.push(extraText);
        const value = bits.filter(Boolean).join(' · ');
        if (!value) return null;
        return { prefix: String(prefix || '').toUpperCase(), value, variant: 'warn' };
    }

    function fromWarning(warn, variant) {
        const value = formatSpeedValue(warn?.km, warn?.pk, warn?.speed);
        if (!value) return null;
        return {
            prefix: '!',
            value,
            variant: variant === 'danger' ? 'danger' : 'warn',
        };
    }

    function normalizeChip(chip) {
        if (!chip) return null;
        if (typeof chip === 'string') return fromText(chip);
        const prefix = String(chip.prefix || '').trim();
        const value = String(chip.value || '').trim();
        if (!prefix && !value) return null;
        return {
            prefix,
            value,
            variant: chip.variant === 'danger' ? 'danger' : 'warn',
        };
    }

    function toPlainText(chip) {
        const item = normalizeChip(chip);
        if (!item) return '';
        return [item.prefix, item.value].filter(Boolean).join(' ');
    }

    function render(chip) {
        const item = normalizeChip(chip);
        if (!item) return '';
        const variantClass = item.variant === 'danger' ? ' info-chip--danger' : '';
        const prefixHtml = item.prefix
            ? `<span class="info-chip__prefix">${escapeHtml(item.prefix)}</span>`
            : '';
        const valueHtml = item.value
            ? `<span class="info-chip__value">${escapeHtml(item.value)}</span>`
            : '';
        return `<span class="info-chip${variantClass}">${prefixHtml}${valueHtml}</span>`;
    }

    function renderRow(chips, className) {
        const html = (Array.isArray(chips) ? chips : []).map(render).filter(Boolean).join('');
        if (!html) return '';
        const extra = className ? ` ${className}` : '';
        return `<div class="info-chip-row${extra}">${html}</div>`;
    }

    global.InfoChip = {
        formatKmPiket,
        compactKmPiketText,
        formatSpeedValue,
        fromText,
        fromBrake,
        fromWarning,
        toPlainText,
        render,
        renderRow,
    };
})(window);
