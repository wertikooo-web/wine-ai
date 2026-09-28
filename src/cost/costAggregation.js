'use strict';

// Pure aggregation for the Cost Control dashboard. No I/O: records, pricing
// rows, fixed costs and settings go in; summary objects come out. Costs are
// (re)computed on read from the raw normalized usage and the versioned
// pricing table, so editing a price re-prices history consistently.

const { resolvePrice, computeUsageCost, convert, CATEGORY_LABELS } = require('./pricing');

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Time zone helpers (calendar periods follow the customer's time zone,
// Europe/Chisinau by default, not the server's UTC clock).
// ---------------------------------------------------------------------

function zonedParts(instant, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function tzOffsetMs(instant, timeZone) {
    const p = zonedParts(instant, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000;
}

// UTC instant of local midnight for a calendar date in `timeZone`.
function zonedMidnight(year, month, day, timeZone) {
    const guess = Date.UTC(year, month - 1, day);
    let result = guess - tzOffsetMs(guess, timeZone);
    const corrected = guess - tzOffsetMs(result, timeZone);
    if (corrected !== result) result = corrected;
    return new Date(result);
}

function zonedDateKey(instant, timeZone) {
    const p = zonedParts(instant, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function periodBounds(now, timeZone) {
    const p = zonedParts(now, timeZone);
    const todayStart = zonedMidnight(p.year, p.month, p.day, timeZone);
    const sevenStartParts = zonedParts(todayStart.getTime() - 6 * DAY_MS + 12 * 60 * 60 * 1000, timeZone);
    const sevenStart = zonedMidnight(sevenStartParts.year, sevenStartParts.month, sevenStartParts.day, timeZone);
    const monthStart = zonedMidnight(p.year, p.month, 1, timeZone);
    const nextMonth = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
    const monthEnd = zonedMidnight(nextMonth.y, nextMonth.m, 1, timeZone);
    const nowDate = new Date(now);
    return {
        now: nowDate,
        today: { from: todayStart, to: nowDate },
        last7: { from: sevenStart, to: nowDate },
        month: { from: monthStart, to: nowDate, end: monthEnd },
        monthKey: `${p.year}-${String(p.month).padStart(2, '0')}`,
        daysInMonth: Math.round((monthEnd - monthStart) / DAY_MS),
        monthElapsedFraction: Math.min(1, Math.max(0, (nowDate - monthStart) / (monthEnd - monthStart))),
    };
}

// ---------------------------------------------------------------------
// Pricing / conversion
// ---------------------------------------------------------------------

function round(value, digits = 6) {
    if (value === null || value === undefined) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

function priceRecord(record, pricingRows, settings) {
    const price = resolvePrice(pricingRows, {
        provider: record.provider, model: record.model, category: record.category, at: record.occurred_at,
    });
    const cost = computeUsageCost(record.usage, record.usage_basis, price);
    const converted = convert(cost.cost, cost.currency, settings);
    return {
        ...record,
        cost: {
            priced: cost.priced,
            basis: cost.basis,
            method: cost.method,
            pricing_id: price?.id || null,
            original: cost.cost,
            original_currency: cost.currency,
            eur: converted.eur,
            mdl: converted.mdl,
        },
    };
}

function emptyTotals() {
    return {
        conversations: 0,
        realtime_sessions: 0,
        api_calls: 0,
        conversation_duration_ms: 0,
        cost_eur: 0,
        cost_mdl: 0,
        actual_cost_eur: 0,
        estimated_cost_eur: 0,
        unpriced_records: 0,
    };
}

function addToTotals(totals, rec) {
    if (rec.kind === 'realtime_session') {
        totals.realtime_sessions += 1;
        if (Number(rec.turn_count) > 0) {
            totals.conversations += 1;
            totals.conversation_duration_ms += Number(rec.duration_ms) || 0;
        }
    } else {
        totals.api_calls += 1;
    }
    if (!rec.cost.priced) {
        totals.unpriced_records += 1;
        return totals;
    }
    totals.cost_eur += rec.cost.eur || 0;
    totals.cost_mdl += rec.cost.mdl || 0;
    if (rec.cost.basis === 'actual') totals.actual_cost_eur += rec.cost.eur || 0;
    else totals.estimated_cost_eur += rec.cost.eur || 0;
    return totals;
}

function finishTotals(totals) {
    const avgEur = totals.conversations > 0 ? totals.cost_eur / totals.conversations : null;
    const avgMdl = totals.conversations > 0 ? totals.cost_mdl / totals.conversations : null;
    return {
        ...totals,
        cost_eur: round(totals.cost_eur, 8),
        cost_mdl: round(totals.cost_mdl, 6),
        actual_cost_eur: round(totals.actual_cost_eur, 8),
        estimated_cost_eur: round(totals.estimated_cost_eur, 8),
        avg_cost_per_conversation_eur: round(avgEur, 8),
        avg_cost_per_conversation_mdl: round(avgMdl, 6),
        // Overall label: ESTIMATED as soon as any priced part is estimated.
        basis: totals.estimated_cost_eur > 0 || totals.unpriced_records > 0 ? 'estimated' : 'actual',
    };
}

function totalsFor(records, from, to) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const totals = emptyTotals();
    for (const rec of records) {
        const t = new Date(rec.occurred_at).getTime();
        if (t >= fromMs && t < toMs + 1) addToTotals(totals, rec);
    }
    return finishTotals(totals);
}

// Fixed monthly costs applicable to the calendar month [monthStartKey, monthEndKey).
function fixedCostsForMonth(items, monthStartKey, monthEndKey, settings) {
    const applicable = [];
    let eur = 0;
    let mdl = 0;
    for (const item of items || []) {
        if (item.active === false) continue;
        if (item.effective_from && item.effective_from >= monthEndKey) continue;
        if (item.effective_to && item.effective_to <= monthStartKey) continue;
        const c = convert(Number(item.amount), item.currency, settings);
        eur += c.eur;
        mdl += c.mdl;
        applicable.push({ id: item.id, name: item.name, category: item.category, amount: Number(item.amount), currency: item.currency, eur: round(c.eur, 6), mdl: round(c.mdl, 4), basis: 'manual' });
    }
    return { items: applicable, eur: round(eur, 6), mdl: round(mdl, 4), basis: 'manual' };
}

function budgetStatus({ budgetMdl, usedMdl, projectedMdl, thresholds }) {
    const list = (Array.isArray(thresholds) && thresholds.length ? thresholds : [70, 90, 100]).map(Number).sort((a, b) => a - b);
    if (!(Number(budgetMdl) > 0)) {
        return { configured: false, budget_mdl: null, used_mdl: round(usedMdl, 4), percent_used: null, projected_mdl: round(projectedMdl, 4), projected_percent: null, level: 'not_configured', crossed_threshold: null, thresholds: list, enforcement: 'observability_only' };
    }
    const percent = (usedMdl / budgetMdl) * 100;
    const projectedPercent = (projectedMdl / budgetMdl) * 100;
    let crossed = null;
    for (const t of list) if (percent >= t) crossed = t;
    let level = 'ok';
    if (crossed !== null) level = crossed >= 100 ? 'exceeded' : (crossed >= 90 ? 'critical' : 'warning');
    return {
        configured: true,
        budget_mdl: Number(budgetMdl),
        used_mdl: round(usedMdl, 4),
        percent_used: round(percent, 2),
        projected_mdl: round(projectedMdl, 4),
        projected_percent: round(projectedPercent, 2),
        projected_over_budget: projectedMdl > budgetMdl,
        level,
        crossed_threshold: crossed,
        thresholds: list,
        // Budget is observability only: nothing in the realtime path reads it.
        enforcement: 'observability_only',
    };
}

function breakdown(records) {
    const byProviderModel = new Map();
    const byCategory = new Map();
    for (const rec of records) {
        const pmKey = `${rec.provider}::${rec.model || 'unknown'}`;
        const catKey = rec.category;
        for (const [map, key, base] of [
            [byProviderModel, pmKey, { provider: rec.provider, model: rec.model || null }],
            [byCategory, catKey, { category: catKey, label: CATEGORY_LABELS[catKey] || catKey }],
        ]) {
            if (!map.has(key)) map.set(key, { ...base, records: 0, conversations: 0, cost_eur: 0, cost_mdl: 0, actual_cost_eur: 0, estimated_cost_eur: 0, unpriced_records: 0, usage: {} });
            const row = map.get(key);
            row.records += 1;
            if (rec.kind === 'realtime_session' && Number(rec.turn_count) > 0) row.conversations += 1;
            for (const [k, v] of Object.entries(rec.usage || {})) {
                if (Number(v) > 0) row.usage[k] = round((row.usage[k] || 0) + Number(v), 3);
            }
            if (!rec.cost.priced) { row.unpriced_records += 1; continue; }
            row.cost_eur += rec.cost.eur || 0;
            row.cost_mdl += rec.cost.mdl || 0;
            if (rec.cost.basis === 'actual') row.actual_cost_eur += rec.cost.eur || 0;
            else row.estimated_cost_eur += rec.cost.eur || 0;
        }
    }
    const finish = (row) => ({
        ...row,
        cost_eur: round(row.cost_eur, 8),
        cost_mdl: round(row.cost_mdl, 6),
        actual_cost_eur: round(row.actual_cost_eur, 8),
        estimated_cost_eur: round(row.estimated_cost_eur, 8),
        basis: row.estimated_cost_eur > 0 || row.unpriced_records > 0 ? 'estimated' : 'actual',
    });
    const sortFn = (a, b) => b.cost_mdl - a.cost_mdl;
    return {
        by_provider_model: [...byProviderModel.values()].map(finish).sort(sortFn),
        by_category: [...byCategory.values()].map(finish).sort(sortFn),
    };
}

// Session row for the dashboard table. Deliberately excludes raw provider
// payloads, transcripts, prompts and anything user-authored.
function sessionView(rec) {
    return {
        session_id: rec.session_id,
        started_at: rec.occurred_at,
        ended_at: rec.ended_at,
        duration_ms: rec.duration_ms,
        provider: rec.provider,
        model: rec.model,
        category: rec.category,
        voice_mode: rec.voice_mode || null,
        status: rec.status,
        end_reason: rec.end_reason,
        turn_count: rec.turn_count,
        provider_connections: rec.provider_connections,
        usage: rec.usage,
        usage_basis: rec.usage_basis,
        cost_basis: rec.cost.basis,
        priced: rec.cost.priced,
        pricing_id: rec.cost.pricing_id,
        cost_eur: round(rec.cost.eur, 8),
        cost_mdl: round(rec.cost.mdl, 6),
    };
}

function buildSummary({ records, pricingRows, fixedItems, settings, now = Date.now(), range = null }) {
    const tz = settings.timezone || 'Europe/Chisinau';
    const bounds = periodBounds(now, tz);
    const priced = records.map((r) => priceRecord(r, pricingRows, settings));

    const today = totalsFor(priced, bounds.today.from, bounds.today.to);
    const last7 = totalsFor(priced, bounds.last7.from, bounds.last7.to);
    const month = totalsFor(priced, bounds.month.from, bounds.month.to);
    const monthStartKey = `${bounds.monthKey}-01`;
    const monthEndKey = zonedDateKey(bounds.month.end.getTime() + 12 * 60 * 60 * 1000, tz);
    const fixed = fixedCostsForMonth(fixedItems, monthStartKey, monthEndKey, settings);

    // Projection: API usage so far extrapolated linearly over the month,
    // plus the full fixed monthly costs (those are billed per month).
    const fraction = bounds.monthElapsedFraction;
    const projectedApiMdl = fraction > 0 ? month.cost_mdl / fraction : 0;
    const projectedApiEur = fraction > 0 ? month.cost_eur / fraction : 0;
    const usedMdl = month.cost_mdl + fixed.mdl;
    const usedEur = month.cost_eur + fixed.eur;

    const rangeTotals = range ? totalsFor(priced, range.from, range.to) : null;

    return {
        generated_at: new Date(now).toISOString(),
        timezone: tz,
        currency_primary: 'MDL',
        rates: { eur_to_mdl: settings.eur_to_mdl, usd_to_eur: settings.usd_to_eur, confirmed: settings.rates_confirmed === true },
        periods: {
            today: { from: bounds.today.from.toISOString(), to: bounds.today.to.toISOString(), ...today },
            last_7_days: { from: bounds.last7.from.toISOString(), to: bounds.last7.to.toISOString(), ...last7 },
            month: {
                from: bounds.month.from.toISOString(), to: bounds.month.to.toISOString(), month: bounds.monthKey,
                days_in_month: bounds.daysInMonth, elapsed_fraction: round(fraction, 4),
                ...month,
                api_cost_eur: month.cost_eur,
                api_cost_mdl: month.cost_mdl,
                fixed_cost_eur: fixed.eur,
                fixed_cost_mdl: fixed.mdl,
                total_cost_eur: round(usedEur, 8),
                total_cost_mdl: round(usedMdl, 6),
                projected_api_cost_eur: round(projectedApiEur, 8),
                projected_api_cost_mdl: round(projectedApiMdl, 6),
                projected_total_cost_eur: round(projectedApiEur + fixed.eur, 8),
                projected_total_cost_mdl: round(projectedApiMdl + fixed.mdl, 6),
            },
            range: rangeTotals ? { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), ...rangeTotals } : null,
        },
        fixed_costs: fixed,
        budget: budgetStatus({ budgetMdl: settings.monthly_budget_mdl, usedMdl, projectedMdl: projectedApiMdl + fixed.mdl, thresholds: settings.warning_thresholds }),
        breakdown: breakdown(priced.filter((r) => {
            const t = new Date(r.occurred_at).getTime();
            const from = range ? new Date(range.from).getTime() : bounds.month.from.getTime();
            const to = range ? new Date(range.to).getTime() : bounds.month.to.getTime();
            return t >= from && t <= to;
        })),
        recent_sessions: priced
            .filter((r) => r.kind === 'realtime_session')
            .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
            .slice(0, 20)
            .map(sessionView),
    };
}

// Compact, customer-facing month summary (safe to show to WineMD).
function buildCustomerSummary(summary) {
    const m = summary.periods.month;
    return {
        title: 'WINE AI usage this month',
        month: m.month,
        conversations: m.conversations,
        total_conversation_time_ms: m.conversation_duration_ms,
        ai_api_cost_mdl: m.api_cost_mdl,
        ai_api_cost_eur: m.api_cost_eur,
        infrastructure_cost_mdl: m.fixed_cost_mdl,
        infrastructure_cost_eur: m.fixed_cost_eur,
        total_operational_cost_mdl: m.total_cost_mdl,
        total_operational_cost_eur: m.total_cost_eur,
        avg_cost_per_conversation_mdl: m.conversations > 0 ? round(m.total_cost_mdl / m.conversations, 4) : null,
        avg_cost_per_conversation_eur: m.conversations > 0 ? round(m.total_cost_eur / m.conversations, 6) : null,
        api_cost_basis: m.basis,
        infrastructure_cost_basis: 'manual',
    };
}

module.exports = {
    periodBounds,
    zonedMidnight,
    zonedDateKey,
    priceRecord,
    totalsFor,
    fixedCostsForMonth,
    budgetStatus,
    breakdown,
    sessionView,
    buildSummary,
    buildCustomerSummary,
};
