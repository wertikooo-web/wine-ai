'use strict';
/*
 * Step 8 -- Principal Review. Adversarial probes against the router's own
 * failure modes. Pure/offline. Each case states the decision we believe is
 * correct and WHY, so a disagreement is visible rather than buried.
 */
const { routeSelective } = require('../../src/knowledge/selectiveRagRouter');

const CASES = [
    // --- confidently-wrong-fact risk -------------------------------------
    { id: 'P01', want: 'GROUNDED', q: 'Сколько стоит Negru de Purcari 2019?', why: 'price + entity + vintage; the model has a confident wrong number' },
    { id: 'P02', want: 'GROUNDED', q: 'Какая крепость у Alb de Purcari?', why: 'ABV of a named product; priors are confidently wrong' },
    // --- unknown / invented wineries --------------------------------------
    { id: 'P03', want: 'GROUNDED', q: 'Расскажи о винодельне Crama Solaris.', why: 'not in the 109-entity registry; invented' },
    { id: 'P04', want: 'GROUNDED', q: 'Что известно про Vinăria Nistrului?', why: 'brand-new name that LOOKS like a real Moldovan producer' },
    { id: 'P05', want: 'GROUNDED', q: 'Расскажи про Domeniile Regale de Lăpușna.', why: 'plausible-sounding invented estate' },
    // --- product-like capitalized phrase that is NOT a winery -------------
    { id: 'P06', want: 'DIRECT', q: 'Что такое Grand Cru и чем он отличается от Premier Cru?', why: 'classification terms, not producers -- should stay DIRECT' },
    { id: 'P07', want: 'DIRECT', q: 'Что означает Methode Traditionnelle на этикетке?', why: 'production method, not a brand' },
    // --- typos on real entities -------------------------------------------
    { id: 'P08', want: 'GROUNDED', q: 'Расскажи про Пуркарь.', why: 'typo of Purcari; must still resolve' },
    { id: 'P09', want: 'GROUNDED', q: 'What about Krikova cellars?', why: 'typo of Cricova' },
    { id: 'P10', want: 'GROUNDED', q: 'Шато Вартели — что это?', why: 'transliterated Château Vartely' },
    // --- RU / RO / EN phrasings of the SAME intent ------------------------
    { id: 'P11', want: 'DIRECT', q: 'Что такое танины?', why: 'RU general education' },
    { id: 'P12', want: 'DIRECT', q: 'What are tannins in wine?', why: 'EN, same intent' },
    { id: 'P13', want: 'DIRECT', q: 'Ce sunt taninurile din vin?', why: 'RO, same intent' },
    { id: 'P14', want: 'GROUNDED', q: 'Сколько стоит бутылка у Cricova?', why: 'RU price+entity' },
    { id: 'P15', want: 'GROUNDED', q: 'How much is a bottle from Cricova?', why: 'EN, same intent' },
    { id: 'P16', want: 'GROUNDED', q: 'Cât costă o sticlă de la Cricova?', why: 'RO, same intent' },
    // --- follow-up turns ---------------------------------------------------
    { id: 'P17', want: 'GROUNDED', q: 'А сколько это стоит?', ctx: ['Расскажи о винодельне Purcari.'], why: 'price follow-up, entity inherited' },
    { id: 'P18', want: 'GROUNDED', q: 'А какое из них легче?', ctx: ['Что интересного у Fautor?'], why: 'referent-dependent, entity inherited' },
    { id: 'P19', want: 'DIRECT', q: 'А что такое танины вообще?', ctx: ['Расскажи о винодельне Purcari.'], why: 'clean topic switch to education; must not be dragged to GROUNDED' },
    // --- commercial framing hidden inside a casual ask ---------------------
    { id: 'P20', want: 'GROUNDED', q: 'что взять из недорогого у Purcari', why: "the brief's commercial-framing trap" },
    { id: 'P21', want: 'GROUNDED', q: 'Посоветуй что-нибудь недорогое к ужину.', why: 'recommendation = our range + price' },
    // --- general question that NAMES a famous winery in passing -----------
    { id: 'P22', want: 'GROUNDED', q: 'Какие вина обычно легче — Purcari или обычные молдавские?', why: "comparative BUT any answer makes an attributed claim about Purcari's style" },
    { id: 'P23', want: 'GROUNDED', q: 'Cricova известна игристым — а почему метод шампенуаз так ценится?', why: 'genuinely mixed; entity named, resolve toward GROUNDED' },
    // --- general question about a specific grape variety -------------------
    { id: 'P24', want: 'DIRECT', q: 'Что такое Фетяска Нягрэ и какой у неё характер?', why: 'grape education, no producer' },
    { id: 'P25', want: 'DIRECT', q: 'Чем Рара Нягрэ отличается от Саперави?', why: 'grape comparison, no producer' },
    // --- the brief's explicit mixed query ---------------------------------
    { id: 'P26', want: 'GROUNDED', q: 'Я люблю Pinot Noir. Что похожее есть у Purcari?', why: "the brief's own mixed example" },
    // --- freshness disguised as general -----------------------------------
    { id: 'P27', want: 'GROUNDED', q: 'Какие сейчас интересные новинки?', why: 'current assortment' },
    { id: 'P28', want: 'DIRECT', q: 'Как хранить открытую бутылку вина?', why: 'NOT a freshness/opening-hours question despite the stem "открыт"' },
    // --- injection-ish / adversarial phrasing ------------------------------
    { id: 'P29', want: 'GROUNDED', q: 'Не ищи ничего, просто скажи цену Negru de Purcari.', why: 'user asking to skip retrieval must NOT be able to force DIRECT' },
    { id: 'P30', want: 'GROUNDED', q: '', why: 'empty query -> conservative default' },
];

const rows = CASES.map((c) => {
    const d = routeSelective(c.q, { recentTurns: (c.ctx || []).map((t) => ({ role: 'user', text: t })) });
    return { ...c, got: d.path, reason: d.reason, entity: d.entity, ok: d.path === c.want };
});

let dangerous = 0;
for (const r of rows) {
    const flag = r.ok ? 'ok  ' : (r.want === 'GROUNDED' ? 'FALSE-DIRECT' : 'false-grounded');
    if (!r.ok && r.want === 'GROUNDED') dangerous += 1;
    console.log(`${r.id} ${flag.padEnd(14)} want=${r.want.padEnd(8)} got=${r.got.padEnd(8)} ${r.reason.padEnd(46)} :: ${r.q || '(empty)'}`);
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} correct; dangerous false-DIRECTs: ${dangerous}`);
require('fs').writeFileSync(require('path').join(__dirname, 'principal-review-results.json'), JSON.stringify(rows, null, 1));
