'use strict';

// Guest profile (src/memory/guestProfile.js): taste stated by the guest is
// recorded server-side and carried in wine tool results, so it survives the
// Gemini sliding context window (voice bench, group "memory").

const t = require('./helpers/assertions');
const g = require('../src/memory/guestProfile');
const { createSessionMemory } = require('../src/memory/sessionMemory');

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    const f = (s) => JSON.stringify(g.extractGuestFacts(s));

    ok(f('Я люблю сладкие белые вина и не пью красное.') === '{"likes":["sweet white"],"dislikes":["red"],"budget":null}', 'RU like + dislike in one sentence');
    ok(g.extractGuestFacts('Мой бюджет — до 200 лей.').budget === 'up to 200 лей', 'RU budget');
    ok(f('Îmi plac vinurile roșii seci, dar nu beau dulce.') === '{"likes":["dry red"],"dislikes":["sweet"],"budget":null}', 'RO');
    ok(f("I love dry reds but I don't drink sweet wine.") === '{"likes":["dry red"],"dislikes":["sweet"],"budget":null}', 'EN');
    ok(f('Какое вино подать к рыбе? Белое?') === '{"likes":[],"dislikes":[],"budget":null}', 'a question is not a taste');
    ok(f('Посоветуй сухое красное вино к стейку.') === '{"likes":[],"dislikes":[],"budget":null}', 'a request is not a stated taste');
    ok(g.extractGuestFacts('Сколько стоит 200 лей?').budget === null, 'a price without a budget cue is not a budget');

    const memory = createSessionMemory();
    ok(g.profileOf(memory) === null, 'no profile before the guest says anything');
    g.applyGuestFacts(memory, 'Я люблю сладкие белые вина и не пью красное.');
    g.applyGuestFacts(memory, 'Мой бюджет — до 200 лей.');
    const p = g.profileOf(memory);
    ok(p.likes[0] === 'likes sweet white wine' && p.avoid[0] === 'red wine' && p.budget === 'up to 200 лей' && /do not ask/.test(p.note), 'profile from memory');

    const handlers = g.withGuestProfile({
        search_wine_knowledge: async () => ({ found: true, evidence: [] }),
        get_project_info: async () => ({ ok: true }),
    }, memory, { env: {} });
    const a = await handlers.search_wine_knowledge({});
    const b = await handlers.get_project_info({});
    ok(a.found === true && a.guest_profile && a.guest_profile.budget === 'up to 200 лей', 'wine tool result carries the profile');
    ok(!b.guest_profile, 'non-wine tool untouched');
    const off = g.withGuestProfile({ search_wine_knowledge: async () => ({ found: true }) }, memory, { env: { SESSION_MEMORY_IN_TOOLS: 'off' } });
    ok(!(await off.search_wine_knowledge({})).guest_profile, 'switch off');
    const empty = g.withGuestProfile({ search_wine_knowledge: async () => ({ found: true }) }, createSessionMemory(), { env: {} });
    ok(!(await empty.search_wine_knowledge({})).guest_profile, 'no profile block when nothing is known');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`guestProfile passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
