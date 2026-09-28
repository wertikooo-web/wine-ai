'use strict';

// The Cost Control user guide (public/cost-guide.html) is customer-facing
// (shown to WineMD): RU + RO, linked from the Cost Control tab, served at
// /dashboard/cost-guide, self-contained and free of internal details.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function run() {
    let n = 0;
    const ok = (v, m) => { n += 1; assert.ok(v, m); };
    const root = path.join(__dirname, '..');
    const guide = fs.readFileSync(path.join(root, 'public', 'cost-guide.html'), 'utf8');
    const dashboard = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

    ok(/^<!doctype html>/i.test(guide), 'guide is a complete HTML document');
    ok(guide.includes('<section data-lang="ru" lang="ru">'), 'Russian version present');
    ok(guide.includes('<section data-lang="ro" lang="ro" hidden>'), 'Romanian version present, hidden by default');
    ok(guide.includes('data-set-lang="ru"') && guide.includes('data-set-lang="ro"'), 'RU/RO switch present');
    ok(guide.includes('href="/dashboard"'), 'guide links back to the dashboard');
    for (const label of ['ACTUAL', 'ESTIMATED', 'MANUAL', 'UNPRICED']) ok(guide.includes(label), `guide explains ${label}`);
    ok(guide.includes('Бюджет только информирует') && guide.includes('Bugetul doar informează'), 'budget is described as observability only in both languages');

    // Self-contained and customer-safe.
    ok(!/<(script|link)[^>]+(src|href)="https?:/i.test(guide), 'no external scripts or stylesheets');
    ok(!/railway\.app|api[_-]?key|ADMIN_TOKEN|DATABASE_URL|GEMINI_[A-Z]|XAI_[A-Z]|GROK_[A-Z]/.test(guide), 'no infrastructure details or secret names');

    ok(/id="ccGuideLink"[^>]*href="\/dashboard\/cost-guide"|href="\/dashboard\/cost-guide"[^>]*id="ccGuideLink"/.test(dashboard), 'Cost Control tab links to the guide');
    ok(server.includes("pathname === '/dashboard/cost-guide'") && server.includes("'cost-guide.html'"), 'server serves the guide route');
    ok(server.includes("'/dashboard/cost-guide'"), 'route listed in KNOWN_ENDPOINTS');
    return { assertionCount: n };
}

module.exports = { run };
