'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { commitKnowledgeFiles, deleteKnowledgeFile } = require('./knowledge/gitPersist');
const { attachRealtimeServer } = require('./realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./realtime/mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./realtime/geminiLiveProvider');
const { createRealtimeProviderRegistry, normalizeProviderName } = require('./realtime/providerRegistry');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('./geminiVoices');
const { listGrokVoices } = require('./grokVoices');
const { synthesizeProviderVoicePreview, MAX_PREVIEW_TEXT_CHARS } = require('./voicePreview');
const { TOOL_DECLARATIONS, createToolHandlers } = require('./tools');
const { createSessionMemory } = require('./memory/sessionMemory');
const { loadIndex, buildIndex, buildIndexFromPostgres } = require('./knowledge/index');
const publishService = require('./knowledge/publishService');
const { getLastSemanticError } = require('./knowledge/search');
const searchMode = require('./knowledge/searchMode');
const knowledgeEmbeddings = require('./knowledge/embeddings');
const knowledgeLoader = require('./knowledge/loader');
const discoveredStore = require('./knowledge/discovered/store');
const { promote } = require('./knowledge/discovered/promote');
const { runUpdateCycle } = require('./knowledge/updateCycle');
const {
    SUPPORTED_LANGUAGES, getRawPersonaPrompt,
    currentPersonaSommelierGender, currentPersonaName, currentPersonaDescription,
    currentWelcomeMessage, getEffectivePersonaPrompt, CORE_PERSONA_PROMPT
} = require('./persona/wineExpertPersona');
const { listProfiles, MOODS, resolveProfile, getProfileById } = require('./persona/profileRegistry');
const personaStore = require('./persona/personaStore');
const { getScreenContext, buildContextualPersona } = require('./persona/screenContexts');
const { getPurchaseOptions } = require('./data/purchaseOptions');
const { MockAvatarProvider } = require('./avatar/providers/mockAvatarProvider');
const { initKosSchema, isKosSchemaReady, getKosSchemaError } = require('./kos/db/kosSchema');
const sourceIngestionService = require('./kos/sources/sourceIngestionService');
const db = require('./knowledge/db');
const env = require('./config/env');

const PORT = env.PORT;
const provider = env.REALTIME_PROVIDER;
const publicDir = path.join(__dirname, '..', 'public');
const avatarModulesDir = path.join(publicDir, 'avatar');
const visualModulesDir = path.join(publicDir, 'visual');
const threeModuleFile = path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.js');

function envFlag(name, fallback) {
    const value = process.env[name];
    if (value == null || value === '') return fallback;
    return /^(1|true|yes|on|enabled)$/i.test(value);
}

// Tap to Start's auto-close-on-silence timeout — a fixed operational
// constant (not yet exposed as a user-editable setting; see
// personaStore.js's voiceMode for the actual mode preference), shipped to
// the client via GET /api/persona so both stay in sync from one source.
const TAP_TO_START_IDLE_TIMEOUT_MS = Number(process.env.TAP_TO_START_IDLE_TIMEOUT_MS || 5000);

function getAvatarClientConfig() {
    return {
        enabled: envFlag('AVATAR_3D_ENABLED', process.env.NODE_ENV !== 'production'),
        modelType: 'procedural',
        modelUrl: '',
        lipSync: { sensitivity: 3.4, noiseGate: 0.018, attack: 0.42, release: 0.16 },
        performance: { maxPixelRatio: 1.5 },
    };
}

// Initialize WINE AI KOS database schema (idempotent, safe fallback)
initKosSchema().catch((error) => {
    console.error('[WineAI] KOS schema initialization failed:', error);
});

// One-time data migration: import crawled docs and entity facts into Postgres.
// Runs at boot if the target tables are empty — idempotent, safe to restart.
if (db.isEnabled()) {
    const { migrateCrawledData } = require('./kos/sources/migrateCrawledData');
    const { migrateEntityFacts } = require('./kos/sources/migrateEntityFacts');
    (async () => {
        try {
            const pool = db.getPool();
            const { rows: docRows } = await pool.query('SELECT COUNT(*) as c FROM kos_source_documents');
            if (parseInt(docRows[0].c, 10) === 0) {
                console.log('[WineAI] Running one-time crawled data migration...');
                await migrateCrawledData();
            }
            const { rows: factRows } = await pool.query('SELECT COUNT(*) as c FROM entity_facts');
            if (parseInt(factRows[0].c, 10) === 0) {
                console.log('[WineAI] Running one-time entity facts migration...');
                await migrateEntityFacts();
            }
        } catch (err) {
            console.error('[WineAI] Boot-time data migration failed (non-fatal):', err.message);
        }
    })();
}

// Defense in depth beyond the per-request try/catch below: this process
// also owns every active realtime WebSocket session, so a bug anywhere
// outside the HTTP handler (a stray unhandled promise rejection, for
// instance) must not silently kill every live conversation either. Logs
// loudly rather than crashing — found this genuinely matters after a
// Postgres Date-vs-string bug crashed the whole process in production on
// 2026-07-18.
process.on('uncaughtException', (error) => {
    console.error('[WineAI] uncaughtException (process kept alive):', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('[WineAI] unhandledRejection (process kept alive):', reason);
});

// One shared avatar-status instance for the dashboard's Diagnostics panel.
// Only 'mock' is implemented in v1 — see src/avatar/AvatarProvider.js for
// the interface a real provider adapter would implement.
const avatarProvider = new MockAvatarProvider();

// Warm the persona-override cache at boot so the very first realtime
// session (and the first /api/persona GET) already reflects any saved
// customization instead of the built-in defaults for a brief window.
personaStore.load().catch((error) => {
    console.error('[WineAI] persona_override_load_failed:', error);
});

function createProviderFactory() {
    // Function-calling tools (search_wine_knowledge etc.) are core to this
    // product, not an opt-in extra — on by default, unlike the origin
    // project's REALTIME_CONTENT_TOOLS (which defaulted off for its own
    // local tools). Still overridable for a pure-voice smoke test.
    const contentToolsEnabled = !/^(0|false|no|off|disabled)$/i.test(String(process.env.REALTIME_CONTENT_TOOLS || ''));

    if (provider === 'gemini') {
        const geminiProvider = new GeminiLiveProvider();
        return {
            metadata: {
                provider,
                model: GEMINI_MODEL_ID,
                defaultVoiceName: DEFAULT_GEMINI_LIVE_VOICE,
                defaultVoiceConfigSource: process.env.GEMINI_LIVE_VOICE ? 'env' : 'default',
                contentToolsEnabled,
                toolDeclarations: TOOL_DECLARATIONS,
                createToolHandlers,
                createSessionMemory,
            },
            createSession: (sessionOptions = {}) => geminiProvider.createSession(sessionOptions),
        };
    }

    const mockProvider = new MockRealtimeProvider(DEFAULT_CONFIG);
    return {
        metadata: {
            provider: 'mock',
            model: 'mock',
            contentToolsEnabled,
            toolDeclarations: TOOL_DECLARATIONS,
            createToolHandlers,
            createSessionMemory,
        },
        createSession: (sessionOptions = {}) => mockProvider.createSession(sessionOptions),
    };
}

const providerFactory = createProviderFactory();
const providerRegistry = createRealtimeProviderRegistry({
    defaultProvider: provider,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_LIVE_MODEL,
    geminiVoice: process.env.GEMINI_LIVE_VOICE,
    grokApiKey: env.GROK_API_KEY,
    grokModel: process.env.GROK_VOICE_MODEL || process.env.XAI_VOICE_MODEL,
    grokRealtimeUrl: process.env.GROK_REALTIME_URL || process.env.XAI_REALTIME_URL,
    grokVoice: process.env.GROK_VOICE_ID || process.env.XAI_VOICE_ID,
}, providerFactory.metadata);
const defaultProvider = providerRegistry.resolveDefault();

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}


const MAX_JSON_BODY_BYTES = 64 * 1024;

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        let received = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
                reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' }));
            }
        });
        req.on('error', reject);
    });
}

const KNOWN_ENDPOINTS = ['/health', '/', '/dashboard', '/avatar-lab', '/avatar-dev', '/avatar.png', '/visual-modules/VisualStoryController.mjs', '/visual-assets/visual-story.css', '/avatar-demo-ru.wav', '/avatar-demo-gemini-orus.wav', '/api/voices', '/api/voice-preview', '/api/persona', '/api/persona/activate', '/api/screen-context/:type/:id', '/api/purchase-options/:wineId', '/api/analytics/purchase-click', '/api/kos/sources', '/api/kos/sources/website', '/api/kos/sources/:sourceId', '/api/kos/sources/:sourceId/crawl', '/api/knowledge/status', '/api/knowledge/sources', '/api/knowledge/sources/:file', '/api/knowledge/reindex', '/api/knowledge/upload', '/api/knowledge/pipeline-status', '/api/knowledge/discovered', '/api/knowledge/discovered/:id/approve', '/api/knowledge/discovered/:id/reject', '/api/knowledge/update', '/api/avatar/status', '/api/avatar/config', '/realtime'];

// A single request throwing must never take down the whole process — this
// same process also owns every active realtime WebSocket session (see
// attachRealtimeServer below); an uncaught error/rejection in
// http.createServer's callback crashes the whole Node process by default,
// silently dropping every live voice conversation, not just the one bad
// HTTP request. Found in production: a Postgres Date vs. ISO-string
// mismatch in one route (.sort() comparator) did exactly this.
const server = http.createServer(async (req, res) => {
    try {
        await handleRequest(req, res);
    } catch (error) {
        console.error('[WineAI] unhandled request error:', error);
        if (!res.headersSent) {
            try { sendJson(res, 500, { ok: false, error: 'internal_error' }); } catch { /* response already broken */ }
        }
    }
});

async function handleRequest(req, res) {
    // Route matching happens against the parsed pathname only, never raw
    // req.url — see docs/WINE_AI_MIGRATION_PLAN.md section 1.1 for why
    // that distinction matters once any route takes a query string.
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/health') {
        const isDbPostgres = db.isEnabled();
        const storageProvider = process.env.KOS_STORAGE_PROVIDER || 'local';
        const isStorageS3 = storageProvider === 's3';

        return sendJson(res, 200, {
            ok: true,
            service: 'wine-ai-realtime',
            provider: defaultProvider.id,
            model: defaultProvider.metadata.model,
            endpoints: KNOWN_ENDPOINTS,
            kos: {
                enabled: true,
                ready: isKosSchemaReady(),
                databaseMode: isDbPostgres ? 'postgres' : 'file',
                databaseProductionReady: isDbPostgres,
                storageProvider,
                storageProductionReady: isStorageS3,
                productionIngestionReady: Boolean(isDbPostgres && isStorageS3 && isKosSchemaReady()),
                error: getKosSchemaError(),
            },
        });
    }

    if (req.method === 'GET' && pathname === '/') {
        return sendJson(res, 200, {
            name: 'Wine AI Realtime',
            status: 'realtime-ready',
            provider: defaultProvider.id,
            model: defaultProvider.metadata.model,
            endpoints: KNOWN_ENDPOINTS,
            next: 'Open /dashboard in a browser and start a conversation.',
        });
    }

    if (req.method === 'GET' && pathname === '/dashboard') {
        const filePath = path.join(publicDir, 'dashboard.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 500, { ok: false, error: 'dashboard_not_available' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    // Local avatar lab is deliberately unavailable in production unless an
    // operator explicitly enables it. It contains no provider or secret data.
    if (req.method === 'GET' && (pathname === '/avatar-lab' || pathname === '/avatar-dev')) {
        const avatarLabEnabled = /^(1|true|yes|on|enabled)$/i.test(process.env.AVATAR_DEV_PANEL || '');
        if (process.env.NODE_ENV === 'production' && !avatarLabEnabled) {
            return sendJson(res, 404, { ok: false, error: 'not_found' });
        }
        const filePath = path.join(publicDir, 'avatar-dev.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'avatar_dev_not_available' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    // The dashboard has no bundler. Expose only Three's single browser ESM
    // build and explicitly named local avatar modules; neither route accepts
    // arbitrary paths into node_modules or public/.
    if (req.method === 'GET' && pathname === '/vendor/three/three.module.js') {
        fs.createReadStream(threeModuleFile)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'three_module_not_available' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
            })
            .pipe(res);
        return undefined;
    }

    const avatarModuleMatch = /^\/avatar-modules\/([a-zA-Z0-9_-]+\.mjs)$/.exec(pathname);
    if (req.method === 'GET' && avatarModuleMatch) {
        const filePath = path.join(avatarModulesDir, avatarModuleMatch[1]);
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'avatar_module_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    if (req.method === 'GET' && pathname === '/visual-modules/VisualStoryController.mjs') {
        const filePath = path.join(visualModulesDir, 'VisualStoryController.mjs');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'visual_module_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    // WineMD Rive skill contract modules (public/visual/*.mjs) + the
    // standalone mock-runtime debug harness (public/visual/debug/) — see
    // .claude/skills/winemd-rive/references/runtime-integration.md.
    // Additive only: no existing route above is touched. Debug harness is
    // NOT linked from dashboard.html or any production UI, and — same
    // convention as the existing /avatar-lab, /avatar-dev gate a few lines
    // up (envFlag('AVATAR_DEV_PANEL', ...)) — is unavailable in production
    // unless explicitly opted into. It opens a raw, unbranded WebSocket
    // straight to /realtime with none of the dashboard's UX/rate controls,
    // so it must not be a silently-public entry point into the live
    // conversational backend.
    const riveSkillJsModules = {
        '/visual-modules/avatarCommandSchema.mjs': path.join(visualModulesDir, 'avatarCommandSchema.mjs'),
        '/visual-modules/avatarSemanticAdapter.mjs': path.join(visualModulesDir, 'avatarSemanticAdapter.mjs'),
        '/visual-modules/riveAvatarAdapter.mjs': path.join(visualModulesDir, 'riveAvatarAdapter.mjs'),
        '/visual-modules/debug/avatar-debug.mjs': path.join(visualModulesDir, 'debug', 'avatar-debug.mjs'),
    };
    const isRiveDebugRoute = Boolean(riveSkillJsModules[pathname]) || pathname === '/visual-modules/debug/avatar-debug.html';
    if (req.method === 'GET' && isRiveDebugRoute) {
        const avatarDebugEnabled = envFlag('ENABLE_AVATAR_DEBUG', false);
        if (process.env.NODE_ENV === 'production' && !avatarDebugEnabled) {
            return sendJson(res, 404, { ok: false, error: 'not_found' });
        }
    }
    if (req.method === 'GET' && riveSkillJsModules[pathname]) {
        fs.createReadStream(riveSkillJsModules[pathname])
            .on('error', () => sendJson(res, 404, { ok: false, error: 'visual_module_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }
    if (req.method === 'GET' && pathname === '/visual-modules/debug/avatar-debug.html') {
        const filePath = path.join(visualModulesDir, 'debug', 'avatar-debug.html');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'visual_module_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    const visualStaticFiles = {
        '/visual-assets/visual-story.css': {
            filePath: path.join(visualModulesDir, 'visual-story.css'),
            contentType: 'text/css; charset=utf-8',
        },
        '/visual-assets/bottle-fallback.svg': {
            filePath: path.join(visualModulesDir, 'bottle-fallback.svg'),
            contentType: 'image/svg+xml; charset=utf-8',
        },
        '/visual-assets/bottle-dealul-reserve.png': {
            filePath: path.join(publicDir, 'Bottle 1 sample.png'),
            contentType: 'image/png',
        },
        // Codru Rosé / Ștefan Vodă Viorica: the original entries here
        // (-> "Bottle 2 sample.png" / "Bottle 3 sample.png") turned out to be
        // crops of the same AI-generated red-wine mockup regardless of which
        // wine they were nominally for. A same-style purpose-made
        // AI-generated photo (matching the red bottle's studio-shot look)
        // replaced them — a hand-drawn SVG placeholder was used briefly in
        // between, now superseded by these.
        //
        // Filename carries the version (…-v2.png), not a ?v= query string:
        // this content went through several revisions in one day while the
        // crop position was being corrected, and a ?v= cache-bust wasn't
        // reliable — Railway's edge/CDN layer (or an intermediate proxy)
        // appears to cache by path only and can ignore query strings, so a
        // client could keep seeing stale bottle art after a fix shipped.
        // Bump the filename's suffix (v2 -> v3 -> …), not just the query
        // string, next time these specific files change.
        '/visual-assets/bottle-codru-rose-v2.png': {
            filePath: path.join(visualModulesDir, 'bottle-codru-rose-v2.png'),
            contentType: 'image/png',
            cacheControl: 'public, max-age=120',
        },
        '/visual-assets/bottle-stefan-viorica-v2.png': {
            filePath: path.join(visualModulesDir, 'bottle-stefan-viorica-v2.png'),
            contentType: 'image/png',
            cacheControl: 'public, max-age=120',
        },
        '/visual-assets/avatar-woman-1.png': {
            filePath: path.join(publicDir, 'woman avatar 1.png'),
            contentType: 'image/png',
        },
        // dashboard.html's persona-select card (Александр / classic profile)
        // has always referenced this path, but no route for it ever existed
        // here -- a genuine 404 unrelated to any deploy-tooling issue.
        '/visual-assets/avatar-man-1.png': {
            filePath: path.join(publicDir, 'avatar wine ai.png'),
            contentType: 'image/png',
        },
        '/visual-assets/sample-1.png': {
            filePath: path.join(publicDir, 'Sample 1 .png'),
            contentType: 'image/png',
        },
        '/visual-assets/pairing-duck-berry.png': {
            filePath: path.join(visualModulesDir, 'pairing-duck-berry.png'),
            contentType: 'image/png',
        },
        '/visual-assets/pairing-aged-cheese.png': {
            filePath: path.join(visualModulesDir, 'pairing-aged-cheese.png'),
            contentType: 'image/png',
        },
        // Aroma/pairing icons cropped from the rosé and white demo reference
        // cards the user supplied — real photos instead of the CSS-gradient
        // placeholders those [data-asset-id]s used before. See
        // visual-story.css and visualCatalog.js's aromaDescriptorIds/
        // pairingIds for demo-wine-002/003.
        '/visual-assets/icon-aroma-strawberry.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-strawberry.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-aroma-raspberry.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-raspberry.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-aroma-rose.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-rose.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-aroma-linden.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-linden.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-aroma-peach.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-peach.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-aroma-grape.png': {
            filePath: path.join(visualModulesDir, 'icon-aroma-grape.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-pairing-salmon-tuna.png': {
            filePath: path.join(visualModulesDir, 'icon-pairing-salmon-tuna.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-pairing-cheese-salad-1.png': {
            filePath: path.join(visualModulesDir, 'icon-pairing-cheese-salad-1.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-pairing-seafood-fish.png': {
            filePath: path.join(visualModulesDir, 'icon-pairing-seafood-fish.png'),
            contentType: 'image/png',
        },
        '/visual-assets/icon-pairing-cheese-salad-2.png': {
            filePath: path.join(visualModulesDir, 'icon-pairing-cheese-salad-2.png'),
            contentType: 'image/png',
        },
    };
    const visualStatic = visualStaticFiles[pathname];
    if (req.method === 'GET' && visualStatic) {
        fs.createReadStream(visualStatic.filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'visual_asset_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': visualStatic.contentType, 'cache-control': visualStatic.cacheControl || 'public, max-age=3600' });
            })
            .pipe(res);
        return undefined;
    }

    if (req.method === 'GET' && pathname === '/avatar.png') {
        const filePath = path.join(publicDir, 'avatar.png');
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'avatar_image_not_available' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
            })
            .pipe(res);
        return undefined;
    }

    const avatarDemoAudio = {
        '/avatar-demo-ru.wav': 'avatar-demo-ru.wav',
        '/avatar-demo-gemini-orus.wav': 'avatar-demo-gemini-orus.wav',
    }[pathname];
    if (req.method === 'GET' && avatarDemoAudio) {
        const filePath = path.join(publicDir, avatarDemoAudio);
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'avatar_demo_audio_not_available' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
            })
            .pipe(res);
        return undefined;
    }

    // Generic static-PNG route for dashboard concept/vision images (e.g.
    // wine-screen-sample.png, winery-screen-sample.png). The filename
    // pattern itself is the path-traversal guard — no dots or slashes are
    // permitted, so this can only ever resolve to a plain file directly
    // inside publicDir, never an arbitrary path.
    const staticPngMatch = /^\/([a-zA-Z0-9_-]+)\.png$/.exec(pathname);
    if (req.method === 'GET' && staticPngMatch) {
        const filePath = path.join(publicDir, `${staticPngMatch[1]}.png`);
        fs.createReadStream(filePath)
            .on('error', () => sendJson(res, 404, { ok: false, error: 'image_not_found' }))
            .once('open', () => {
                res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
            })
            .pipe(res);
        return undefined;
    }

    if (req.method === 'GET' && pathname === '/api/voices') {
        const requestedProvider = normalizeProviderName(requestUrl.searchParams.get('provider'), defaultProvider.id);
        const providerDefinition = providerRegistry.get(requestedProvider);
        const voices = requestedProvider === 'grok'
            ? await listGrokVoices({ apiKey: env.GROK_API_KEY })
            : providerDefinition.voices;
        return sendJson(res, 200, {
            ok: true,
            default_provider: defaultProvider.id,
            provider: requestedProvider,
            providers: providerRegistry.list(),
            default_voice: providerDefinition.default_voice,
            voices,
        });
    }

    if (req.method === 'POST' && pathname === '/api/voice-preview') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        try {
            const requestedProvider = normalizeProviderName(body.provider, defaultProvider.id);
            const providerDefinition = providerRegistry.get(requestedProvider);
            if (!providerDefinition.configured) {
                const notConfigured = new Error(`${requestedProvider}_provider_not_configured`);
                notConfigured.code = 'realtime_provider_not_configured';
                throw notConfigured;
            }
            const preview = await synthesizeProviderVoicePreview({
                provider: requestedProvider,
                voiceName: body.voice_name || body.voiceName,
                text: body.text,
            });
            return sendJson(res, 200, {
                ok: true,
                provider: requestedProvider,
                voice_name: preview.voiceName,
                mime_type: preview.mimeType,
                sample_rate: preview.sampleRate,
                audio_base64: preview.audioBase64,
            });
        } catch (error) {
            const code = error.code || 'voice_preview_failed';
            const statusCode = code === 'gemini_api_key_missing'
                || code === 'grok_api_key_missing'
                || code === 'realtime_provider_not_configured'
                ? 503
                : 502;
            return sendJson(res, statusCode, { ok: false, error: code, max_chars: MAX_PREVIEW_TEXT_CHARS });
        }
    }

    if (pathname.startsWith('/api/persona')) {
        const loadError = personaStore.getLoadError();
        if (loadError) {
            return sendJson(res, 503, {
                ok: false,
                error: 'persona_store_unavailable',
                message: 'Persona settings are temporarily unavailable.'
            });
        }
    }

    if (req.method === 'GET' && pathname === '/api/persona/profiles') {
        try {
            const providers = await providerRegistry.getPublicCapabilities();
            const states = personaStore.listProfileStates();
            const profilesList = listProfiles().map(p => {
                const state = states.find(s => s.id === p.id);
                return {
                    ...p,
                    hasCustomSettings: state ? state.hasCustomSettings : false
                };
            });
            return sendJson(res, 200, {
                ok: true,
                profiles: profilesList,
                moods: MOODS,
                providers
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'failed_to_get_capabilities', message: error.message });
        }
    }

    if (req.method === 'GET' && pathname === '/api/persona') {
        try {
            const activeProfileId = personaStore.getActiveProfileId();
            const targetProfileId = requestUrl.searchParams.get('profileId') || activeProfileId;

            const builtin = getProfileById(targetProfileId);
            if (!builtin) {
                return sendJson(res, 400, { ok: false, error: 'invalid_profile_id', message: `Unknown profile ID: ${targetProfileId}` });
            }

            const rawOverrides = (personaStore.getProfilesOverrides()[targetProfileId] || {}).overrides || {};
            const overrides = { ...rawOverrides };
            const mood = overrides.mood || 'calm';
            delete overrides.mood;
            const resolved = resolveProfile(targetProfileId, overrides, mood);

            let customizationMode = 'preset';
            const hasMeaningfulOverrides = Object.keys(overrides).some(key => {
                if (key === 'mood') {
                    return false;
                }
                if (key === 'style') {
                    return Object.keys(overrides.style || {}).length > 0;
                }
                if (key === 'runtimeByProvider') {
                    return Object.keys(overrides.runtimeByProvider || {}).length > 0;
                }
                if (key === 'identity') {
                    return Object.keys(overrides.identity || {}).length > 0;
                }
                return overrides[key] !== undefined && overrides[key] !== null;
            });
            if (hasMeaningfulOverrides || personaStore.isLegacyCustomProfile()) {
                customizationMode = 'custom';
            }

            const preview = getEffectivePersonaPrompt(overrides, targetProfileId, mood);

            // Compute which profiles have custom overrides (for client badge display)
            const profilesOverrides = personaStore.getProfilesOverrides();
            const customProfileIds = Object.entries(profilesOverrides)
                .filter(([, data]) => {
                    const o = data.overrides || {};
                    return Object.keys(o).some(k => {
                        if (k === 'mood') return false;
                        if (k === 'style') return Object.keys(o.style || {}).length > 0;
                        if (k === 'runtimeByProvider') return Object.keys(o.runtimeByProvider || {}).length > 0;
                        if (k === 'identity') return Object.keys(o.identity || {}).length > 0;
                        return o[k] !== undefined && o[k] !== null;
                    });
                })
                .map(([id]) => id);

            return sendJson(res, 200, {
                ok: true,
                name: resolved.name,
                description: resolved.description,
                languages: SUPPORTED_LANGUAGES,
                welcome_message: resolved.welcomeMessage,
                system_prompt: overrides.systemPrompt !== undefined ? overrides.systemPrompt : CORE_PERSONA_PROMPT,
                personality_prompt: overrides.personalityPrompt !== undefined ? overrides.personalityPrompt : undefined,
                sommelierGender: resolved.sommelierGender,
                activeProfileId,
                profileId: targetProfileId,
                baseProfileId: customizationMode === 'custom' ? null : targetProfileId,
                customizationMode,
                mood,
                voiceMode: personaStore.getVoiceMode(),
                tapToStartIdleTimeoutMs: TAP_TO_START_IDLE_TIMEOUT_MS,
                resolved,
                effectivePromptPreview: preview,
                overrides,
                customProfileIds
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'persona_get_failed', message: error.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/persona/preview') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }

        try {
            const profileId = body.profileId || personaStore.getActiveProfileId();
            const mood = body.overrides?.mood || ((personaStore.getProfilesOverrides()[profileId] || {}).overrides?.mood || 'calm');

            const current = (personaStore.getProfilesOverrides()[profileId] || {}).overrides || {};
            const mergedOverrides = JSON.parse(JSON.stringify(current));

            if (body.overrides) {
                for (const [k, v] of Object.entries(body.overrides)) {
                    if (v === null) {
                        delete mergedOverrides[k];
                    } else if (typeof v === 'object' && !Array.isArray(v)) {
                        mergedOverrides[k] = {
                            ...(mergedOverrides[k] || {}),
                            ...v
                        };
                    } else {
                        mergedOverrides[k] = v;
                    }
                }
            }

            const preview = getEffectivePersonaPrompt(mergedOverrides, profileId, mood);
            return sendJson(res, 200, { ok: true, effectivePromptPreview: preview });
        } catch (error) {
            console.error('[WineAI] Error resolving preview:', error);
            return sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/persona/activate') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, 400, { ok: false, error: 'invalid_request' });
        }

        const profileId = body.profileId;
        if (!profileId) {
            return sendJson(res, 400, { ok: false, error: 'missing_profile_id' });
        }

        try {
            await personaStore.activateProfile(profileId);

            const rawOverrides = (personaStore.getProfilesOverrides()[profileId] || {}).overrides || {};
            const overrides = { ...rawOverrides };
            const mood = overrides.mood || 'calm';
            delete overrides.mood;
            const resolved = resolveProfile(profileId, overrides, mood);
            const preview = getEffectivePersonaPrompt(overrides, profileId, mood);

            const profilesOverrides = personaStore.getProfilesOverrides();
            const customProfileIds = Object.entries(profilesOverrides)
                .filter(([, data]) => {
                    const o = data.overrides || {};
                    return Object.keys(o).some(k => {
                        if (k === 'mood') return false;
                        if (k === 'style') return Object.keys(o.style || {}).length > 0;
                        if (k === 'runtimeByProvider') return Object.keys(o.runtimeByProvider || {}).length > 0;
                        if (k === 'identity') return Object.keys(o.identity || {}).length > 0;
                        return o[k] !== undefined && o[k] !== null;
                    });
                })
                .map(([id]) => id);

            return sendJson(res, 200, {
                ok: true,
                name: resolved.name,
                description: resolved.description,
                languages: SUPPORTED_LANGUAGES,
                welcome_message: resolved.welcomeMessage,
                system_prompt: overrides.systemPrompt !== undefined ? overrides.systemPrompt : CORE_PERSONA_PROMPT,
                personality_prompt: overrides.personalityPrompt !== undefined ? overrides.personalityPrompt : undefined,
                sommelierGender: resolved.sommelierGender,
                activeProfileId: profileId,
                profileId: profileId,
                baseProfileId: profileId,
                mood,
                resolved,
                effectivePromptPreview: preview,
                overrides,
                customProfileIds
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'failed_to_activate', message: error.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/persona') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }

        const allowedRootKeys = [
            'profileId', 'baseProfileId', 'mood', 'voiceMode', 'overrides', 'reset',
            'customizationMode', 'effectivePromptPreview', 'resolved', 'languages', 'activeProfileId', 'ok',
            'name', 'description', 'welcomeMessage', 'welcome_message',
            'sommelierGender', 'sommelier_gender', 'personalityPrompt', 'personality_prompt',
            'systemPrompt', 'system_prompt'
        ];
        for (const key of Object.keys(body)) {
            if (!allowedRootKeys.includes(key)) {
                return sendJson(res, 400, { ok: false, error: 'unknown_root_field' });
            }
        }

        const targetProfileId = body.profileId || body.baseProfileId || personaStore.getActiveProfileId();

        try {
            // Device-wide UX preference, not persona content — handled
            // separately from the overrides/updateProfile() path below.
            if (body.voiceMode !== undefined) {
                await personaStore.setVoiceMode(body.voiceMode);
            }

            if (body.baseProfileId === null) {
                personaStore.setLegacyCustomProfile(true);
            } else if (body.baseProfileId !== undefined) {
                personaStore.setLegacyCustomProfile(false);
                const currentActiveId = personaStore.getActiveProfileId();
                const currentActiveOverrides = (personaStore.getProfilesOverrides()[currentActiveId] || {}).overrides || {};
                const activeMood = currentActiveOverrides.mood || 'calm';

                await personaStore.activateProfile(body.baseProfileId);
                await personaStore.resetProfile(body.baseProfileId);
                if (activeMood && activeMood !== 'calm') {
                    await personaStore.updateProfile(body.baseProfileId, { mood: activeMood });
                }
            }

            if (body.reset) {
                if (personaStore.isLegacyCustomProfile()) {
                    return sendJson(res, 400, { ok: false, error: 'Cannot reset a custom profile' });
                }
                await personaStore.resetProfile(targetProfileId);
            } else {
                const patch = body.overrides ? { ...body.overrides } : {};
                const flatKeys = ['name', 'description', 'welcomeMessage', 'sommelierGender', 'personalityPrompt', 'systemPrompt', 'mood', 'style', 'runtimeByProvider', 'identity'];
                for (const key of Object.keys(body)) {
                    if (flatKeys.includes(key)) {
                        patch[key] = body[key];
                    }
                }
                if (Object.keys(patch).length > 0) {
                    await personaStore.updateProfile(targetProfileId, patch);
                }
            }

            const rawOverrides = (personaStore.getProfilesOverrides()[targetProfileId] || {}).overrides || {};
            const overrides = { ...rawOverrides };
            const mood = overrides.mood || 'calm';
            delete overrides.mood;
            const resolved = resolveProfile(targetProfileId, overrides, mood);
            const preview = getEffectivePersonaPrompt(overrides, targetProfileId, mood);

            let customizationMode = 'preset';
            const hasMeaningfulOverrides = Object.keys(overrides).some(key => {
                if (key === 'mood') {
                    return false;
                }
                if (key === 'style') {
                    return Object.keys(overrides.style || {}).length > 0;
                }
                if (key === 'runtimeByProvider') {
                    return Object.keys(overrides.runtimeByProvider || {}).length > 0;
                }
                if (key === 'identity') {
                    return Object.keys(overrides.identity || {}).length > 0;
                }
                return overrides[key] !== undefined && overrides[key] !== null;
            });
            if (hasMeaningfulOverrides || personaStore.isLegacyCustomProfile()) {
                customizationMode = 'custom';
            }

            const profilesOverridesSave = personaStore.getProfilesOverrides();
            const customProfileIdsSave = Object.entries(profilesOverridesSave)
                .filter(([, data]) => {
                    const o = data.overrides || {};
                    return Object.keys(o).some(k => {
                        if (k === 'mood') return false;
                        if (k === 'style') return Object.keys(o.style || {}).length > 0;
                        if (k === 'runtimeByProvider') return Object.keys(o.runtimeByProvider || {}).length > 0;
                        if (k === 'identity') return Object.keys(o.identity || {}).length > 0;
                        return o[k] !== undefined && o[k] !== null;
                    });
                })
                .map(([id]) => id);

            return sendJson(res, 200, {
                ok: true,
                name: resolved.name,
                description: resolved.description,
                languages: SUPPORTED_LANGUAGES,
                welcome_message: resolved.welcomeMessage,
                system_prompt: overrides.systemPrompt !== undefined ? overrides.systemPrompt : CORE_PERSONA_PROMPT,
                personality_prompt: overrides.personalityPrompt !== undefined ? overrides.personalityPrompt : undefined,
                sommelierGender: resolved.sommelierGender,
                activeProfileId: personaStore.getActiveProfileId(),
                baseProfileId: customizationMode === 'custom' ? null : targetProfileId,
                customizationMode,
                mood,
                voiceMode: personaStore.getVoiceMode(),
                tapToStartIdleTimeoutMs: TAP_TO_START_IDLE_TIMEOUT_MS,
                resolved,
                effectivePromptPreview: preview,
                overrides,
                customProfileIds: customProfileIdsSave
            });
        } catch (error) {
            console.error('[WineAI] POST /api/persona failed:', error);
            const statusCode = error.statusCode || 500;
            const code = error.statusCode ? error.message : 'persona_save_failed';
            return sendJson(res, statusCode, { ok: false, error: code, message: error.message });
        }
    }

    // Powers the "Спросить Wine AI об этой винодельне/вине" buttons — the
    // dashboard fetches the combined persona text once here, then sends it
    // straight through the EXISTING session.start `config.persona` override
    // (see realtimePrompt.js's sanitizePromptConfig / DASHBOARD_ALLOW_CUSTOM_PROMPT).
    // No new realtime/session code; this is purely "which text goes in".
    const screenContextMatch = /^\/api\/screen-context\/([a-z]+)\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (req.method === 'GET' && screenContextMatch) {
        const [, type, id] = screenContextMatch;
        const ctx = getScreenContext(type, id);
        if (!ctx) return sendJson(res, 404, { ok: false, error: 'screen_context_not_found' });
        return sendJson(res, 200, {
            ok: true,
            type: ctx.type,
            id: ctx.id,
            name: ctx.name,
            opening_line: ctx.openingLine,
            suggested_prompts: ctx.suggestedPrompts,
            persona: buildContextualPersona(ctx),
        });
    }

    // "Где купить" — structured purchase links/prices, never generated by
    // the model. The AI only decides when to mention this exists; the data
    // itself always comes from here (src/data/purchaseOptions.js).
    const purchaseOptionsMatch = /^\/api\/purchase-options\/([a-z0-9-]+)\/?$/.exec(pathname);
    if (req.method === 'GET' && purchaseOptionsMatch) {
        const [, wineId] = purchaseOptionsMatch;
        return sendJson(res, 200, { ok: true, wine_id: wineId, options: getPurchaseOptions(wineId) });
    }

    if (req.method === 'POST' && pathname === '/api/analytics/purchase-click') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }
        console.log('[Analytics] purchase_click', JSON.stringify({
            wineId: String(body.wineId || '').slice(0, 120),
            optionId: String(body.optionId || '').slice(0, 120),
            source: String(body.source || 'unknown').slice(0, 40),
            at: new Date().toISOString(),
        }));
        return sendJson(res, 200, { ok: true });
    }

    // Only maxPages/maxDepth/renderJs are exposed to callers — never let a
    // client override delayMs/robots/SSRF-relevant settings from the
    // request body. Ceiling (500 pages, depth 4) is a sanity bound, not a
    // security boundary — SSRF/private-IP/robots protections live in
    // ssrfProtection.js/robotsPolicy.js independently of this. renderJs
    // opts into headless-browser rendering (src/kos/sources/
    // headlessBrowser.js) for sites whose real content only appears after
    // client-side JavaScript runs — off by default since it's far
    // slower/heavier than a plain HTTP GET.
    function clampCrawlPolicy(rawPolicy) {
        if (!rawPolicy || typeof rawPolicy !== 'object') return undefined;
        const policy = {};
        if (Number.isFinite(rawPolicy.maxPages)) {
            policy.maxPages = Math.max(1, Math.min(500, Math.floor(rawPolicy.maxPages)));
        }
        if (Number.isFinite(rawPolicy.maxDepth)) {
            policy.maxDepth = Math.max(0, Math.min(4, Math.floor(rawPolicy.maxDepth)));
        }
        if (typeof rawPolicy.renderJs === 'boolean') {
            policy.renderJs = rawPolicy.renderJs;
        }
        return Object.keys(policy).length > 0 ? policy : undefined;
    }

    // Step 2E: the smallest complete Dashboard -> Source Registry -> crawler
    // flow. Crawls run in this request on purpose: the existing ingestion
    // service owns the crawl-run state, and the Dashboard shows a local
    // `running` state while it waits. No second queue/worker/progress channel
    // is introduced here. Ingested resources remain pending_review and this
    // route never writes to kos_knowledge_facts.
    const kosSourceMatch = /^\/api\/kos\/sources\/(src_[a-zA-Z0-9]+)\/?$/.exec(pathname);
    const kosSourceCrawlMatch = /^\/api\/kos\/sources\/(src_[a-zA-Z0-9]+)\/crawl\/?$/.exec(pathname);
    const isKosSourceRoute = pathname === '/api/kos/sources'
        || pathname === '/api/kos/sources/'
        || pathname === '/api/kos/sources/website'
        || pathname === '/api/kos/sources/website/'
        || Boolean(kosSourceMatch)
        || Boolean(kosSourceCrawlMatch);

    if (isKosSourceRoute) {
        if (!db.isEnabled() || !isKosSchemaReady()) {
            return sendJson(res, 503, {
                ok: false,
                error: 'kos_source_registry_unavailable',
                message: 'The KOS source registry is not ready. Check PostgreSQL and KOS schema initialization.',
            });
        }

        try {
            if (req.method === 'GET' && (pathname === '/api/kos/sources' || pathname === '/api/kos/sources/')) {
                return sendJson(res, 200, await sourceIngestionService.listSourcesWithStatus());
            }

            if (req.method === 'POST' && (pathname === '/api/kos/sources/website' || pathname === '/api/kos/sources/website/')) {
                const body = await readJsonBody(req);
                const result = await sourceIngestionService.addWebsiteAndStartCrawl({
                    url: body.url,
                    name: body.name,
                    wineryId: body.wineryId || null,
                    policy: clampCrawlPolicy(body.policy),
                });
                return sendJson(res, 201, { ok: true, ...result });
            }

            if (req.method === 'GET' && kosSourceMatch) {
                return sendJson(res, 200, await sourceIngestionService.getSourceWithStatus({ sourceId: kosSourceMatch[1] }));
            }

            if (req.method === 'POST' && kosSourceCrawlMatch) {
                // Body is optional — the Dashboard's plain "re-crawl" button
                // sends none, and the default policy (websiteCrawlerProvider's
                // maxPages:20 etc.) still applies. Only present to let a
                // caller override maxPages/maxDepth for a specific re-crawl
                // (e.g. "this site has 373 pages, not 20").
                let policy;
                try {
                    const body = await readJsonBody(req);
                    policy = clampCrawlPolicy(body.policy);
                } catch (bodyErr) {
                    if (bodyErr.code !== 'invalid_json' && bodyErr.code !== 'body_too_large') throw bodyErr;
                    policy = undefined; // no/empty body — fall back to defaults
                }
                const result = await sourceIngestionService.triggerCrawlForSource({ sourceId: kosSourceCrawlMatch[1], policy });
                return sendJson(res, 200, { ok: true, ...result });
            }

            return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        } catch (error) {
            const statusCode = error.code === 'body_too_large'
                ? 413
                : (error.code === 'invalid_json' ? 400 : (error.statusCode || 500));
            return sendJson(res, statusCode, {
                ok: false,
                error: error.code || 'kos_source_request_failed',
                message: error.message || 'KOS source request failed',
            });
        }
    }

    if (req.method === 'GET' && pathname === '/api/knowledge/status') {
        const index = loadIndex();
        const lastError = getLastSemanticError();
        let embeddingRowCount = null;
        let embeddingTableAccessible = false;
        let totalEmbeddingRowsInTable = null;

        const semanticConfigured = db.isEnabled() && knowledgeEmbeddings.isEnabled();

        if (semanticConfigured) {
            try {
                const pool = db.getPool();
                if (pool) {
                    const { rows: totalRows } = await pool.query('SELECT COUNT(*) AS cnt FROM knowledge_chunk_embeddings');
                    totalEmbeddingRowsInTable = Number(totalRows[0].cnt);

                    const currentChunkIds = (index.chunks || []).map((c) => c.id);
                    if (currentChunkIds.length > 0) {
                        const { rows } = await pool.query(
                            'SELECT COUNT(*) AS cnt FROM knowledge_chunk_embeddings WHERE chunk_id = ANY($1)',
                            [currentChunkIds]
                        );
                        embeddingRowCount = Number(rows[0].cnt);
                    }
                    embeddingTableAccessible = true;
                }
            } catch (_) { }
        }

        const idxChunkCount = index.chunk_count || 0;
        const coveragePercent = embeddingRowCount !== null && idxChunkCount > 0
            ? Math.min(Math.round((embeddingRowCount / idxChunkCount) * 10000) / 100, 100)
            : null;

        const staleRowCount = totalEmbeddingRowsInTable !== null && embeddingRowCount !== null
            ? Math.max(0, totalEmbeddingRowsInTable - embeddingRowCount)
            : null;

        return sendJson(res, 200, {
            ok: true,
            built_at: index.built_at,
            document_count: index.document_count || 0,
            chunk_count: idxChunkCount,
            search_mode: searchMode.getMode(),
            semantic_available: semanticConfigured,
            semantic_configured: semanticConfigured,
            semantic_healthy: embeddingTableAccessible && !lastError,
            index_chunk_count: idxChunkCount,
            embedding_row_count: embeddingRowCount,
            embedding_total_rows_in_table: totalEmbeddingRowsInTable,
            embedding_stale_row_count: staleRowCount,
            embedding_coverage_percent: coveragePercent,
            embedding_model: knowledgeEmbeddings.EMBEDDING_MODEL,
            embedding_payload_version: 'v2',
            last_semantic_error: lastError,
        });
    }

    // Runtime toggle for hybrid (keyword+semantic) search — see
    // src/knowledge/searchMode.js. In-memory only, by design: this is a
    // live A/B comparison knob for the Dashboard, not durable config.
    if (req.method === 'GET' && pathname === '/api/knowledge/search-mode') {
        return sendJson(res, 200, {
            ok: true,
            mode: searchMode.getMode(),
            available_modes: searchMode.VALID_MODES,
            semantic_available: db.isEnabled() && knowledgeEmbeddings.isEnabled(),
        });
    }

    if (req.method === 'POST' && pathname === '/api/knowledge/search-mode') {
        let body;
        try {
            body = await readJsonBody(req, 1024);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        try {
            const mode = searchMode.setMode(String(body.mode || ''));
            return sendJson(res, 200, { ok: true, mode });
        } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.code || 'invalid_search_mode', available_modes: searchMode.VALID_MODES });
        }
    }

    if (req.method === 'GET' && pathname === '/api/knowledge/sources') {
        const index = loadIndex();
        const bySource = new Map();
        for (const chunk of index.chunks || []) {
            const key = chunk.metadata.source_file;
            if (!bySource.has(key)) {
                bySource.set(key, {
                    source_file: key,
                    title: chunk.metadata.title,
                    doc_type: chunk.metadata.doc_type,
                    language: chunk.metadata.language,
                    confidence: chunk.metadata.confidence,
                    source: chunk.metadata.source,
                    enabled: chunk.metadata.enabled !== false,
                    chunk_count: 0,
                });
            }
            bySource.get(key).chunk_count += 1;
        }
        return sendJson(res, 200, { ok: true, sources: Array.from(bySource.values()) });
    }

    // Full text of one indexed file — the Knowledge tab's Sources list only
    // shows title/counts; this backs an expand-to-read view so "what
    // exactly did it load from this book" has an actual answer instead of
    // requiring someone to go read the file on disk/in git.
    const sourceContentMatch = /^\/api\/knowledge\/sources\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
    if (req.method === 'GET' && sourceContentMatch) {
        const [, fileName] = sourceContentMatch;
        const index = loadIndex();
        const chunks = (index.chunks || [])
            .filter((chunk) => chunk.metadata.source_file === fileName)
            .sort((a, b) => (a.metadata.chunk_index || 0) - (b.metadata.chunk_index || 0));
        if (chunks.length === 0) {
            return sendJson(res, 404, { ok: false, error: 'source_not_found' });
        }
        return sendJson(res, 200, {
            ok: true,
            source_file: fileName,
            title: chunks[0].metadata.title,
            source: chunks[0].metadata.source,
            text: chunks.map((chunk) => chunk.text).join('\n\n'),
        });
    }

    if (req.method === 'DELETE' && sourceContentMatch) {
        const [, fileName] = sourceContentMatch;
        const sourceDir = knowledgeLoader.DEFAULT_SOURCE_DIR;
        const filePath = path.join(sourceDir, fileName);

        if (!fs.existsSync(filePath)) {
            return sendJson(res, 404, { ok: false, error: 'file_not_found' });
        }

        try {
            fs.unlinkSync(filePath);
            buildIndex();

            // Best effort — deleteKnowledgeFile logs its own failures and
            // never throws; a GitHub-side failure here must not undo the
            // local delete/reindex that already succeeded.
            deleteKnowledgeFile(path.resolve(__dirname, '..'), filePath, `Delete knowledge file: ${fileName}`);

            return sendJson(res, 200, { ok: true });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'delete_failed', message: error.message });
        }
    }

    // Per-source enable/disable (Dashboard "Sources" list) — a softer
    // alternative to DELETE: the file, its chunks, and its embeddings all
    // stay in place, but search.js excludes it from retrieval until
    // re-enabled. Lets a specific source (or a whole site's worth of
    // pages, one PATCH per page from the Dashboard's "group" button) be
    // isolated for testing without losing the data or having to re-crawl
    // it later.
    if (req.method === 'PATCH' && sourceContentMatch) {
        const [, fileName] = sourceContentMatch;
        const sourceDir = knowledgeLoader.DEFAULT_SOURCE_DIR;
        const filePath = path.join(sourceDir, fileName);

        if (!fs.existsSync(filePath)) {
            return sendJson(res, 404, { ok: false, error: 'file_not_found' });
        }

        let body;
        try {
            body = await readJsonBody(req, 1024);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        if (typeof body.enabled !== 'boolean') {
            return sendJson(res, 400, { ok: false, error: 'enabled_boolean_required' });
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const frontmatterMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/.exec(raw);
            if (!frontmatterMatch) {
                return sendJson(res, 500, { ok: false, error: 'frontmatter_unparseable' });
            }
            const [, open, frontmatterBody, close, rest] = frontmatterMatch;
            const lines = frontmatterBody.split(/\r?\n/).filter((line) => !/^enabled:/.test(line.trim()));
            lines.push(`enabled: ${body.enabled}`);
            const updated = open + lines.join('\n') + close + rest;
            fs.writeFileSync(filePath, updated, 'utf8');
            buildIndex();
            commitKnowledgeFiles(path.resolve(__dirname, '..'), [filePath], `${body.enabled ? 'Enable' : 'Disable'} knowledge file: ${fileName}`);
            return sendJson(res, 200, { ok: true, enabled: body.enabled });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'patch_failed', message: error.message });
        }
    }

    // Drag-and-drop upload for the Knowledge base tab. Body is JSON
    // ({filename, content}) rather than multipart — every plain-text source
    // document in this project is already text end to end, so the browser
    // just reads the dropped File as text (FileReader) and posts it,
    // avoiding a multipart-parsing dependency.
    //
    // PDFs are the one binary exception: the client base64-encodes the file
    // (contentBase64) instead, and the server extracts text via pdf-parse
    // before writing it out as a normal .md source — the loader/index/
    // search pipeline never has to know a PDF was involved.
    if (req.method === 'POST' && pathname === '/api/knowledge/upload') {
        let body;
        try {
            body = await readJsonBody(req, 20 * 1024 * 1024); // 20MB — generous for a base64-encoded PDF
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        const rawName = String(body.filename || '').trim();
        if (!rawName) {
            return sendJson(res, 400, { ok: false, error: 'filename_required' });
        }
        const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const ext = path.extname(safeName).toLowerCase();

        // Helper: generate ID and compute content hash
        function generateId(prefix = 'id') {
            return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
        }
        function computeContentHash(text) {
            return crypto.createHash('sha256').update(text).digest('hex');
        }

        // Helper: ensure 'uploaded' source exists in kos_sources
        async function getOrCreateUploadedSource(pool) {
            const existing = await pool.query("SELECT id FROM kos_sources WHERE id = 'uploaded'");
            if (existing.rows.length > 0) return 'uploaded';
            await pool.query(
                `INSERT INTO kos_sources (id, name, seed_url, normalized_origin, source_type, trust_level, created_at, updated_at)
                 VALUES ('uploaded', 'Dashboard Uploads', 'https://uploaded.local', 'uploaded.local', 'upload', 'C', NOW(), NOW())`
            );
            return 'uploaded';
        }

        // Helper: insert document into Postgres and reindex
        async function insertAndReindex(title, extractedText, documentType) {
            const pool = db.getPool();
            if (!pool) {
                return sendJson(res, 500, { ok: false, error: 'database_not_available' });
            }

            const sourceId = await getOrCreateUploadedSource(pool);
            const docId = generateId('doc');
            const canonicalUrl = `uploaded://${safeName}`;
            const contentHash = computeContentHash(extractedText);

            // Detect language (simple heuristic)
            const hasCyrillic = /[а-яА-ЯёЁ]/.test(extractedText);
            const hasRomanian = /\b(și|sau|este|sunt|pentru|despre)\b/i.test(extractedText);
            const language = hasRomanian ? 'ro' : hasCyrillic ? 'ru' : 'en';

            // Insert into kos_source_documents
            const sql = `
                INSERT INTO kos_source_documents (
                    id, source_id, requested_url, canonical_url, title, content_type, content_length,
                    document_type, content_hash, normalized_text, language, status, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', NOW(), NOW())
                ON CONFLICT (source_id, canonical_url)
                DO UPDATE SET
                    title = EXCLUDED.title,
                    document_type = EXCLUDED.document_type,
                    content_hash = EXCLUDED.content_hash,
                    normalized_text = EXCLUDED.normalized_text,
                    language = EXCLUDED.language,
                    updated_at = NOW()
                RETURNING id;
            `;

            const result = await pool.query(sql, [
                docId,
                sourceId,
                canonicalUrl,
                canonicalUrl,
                title,
                ext === '.pdf' ? 'application/pdf' : 'text/plain',
                Buffer.byteLength(extractedText, 'utf8'),
                documentType,
                contentHash,
                extractedText.slice(0, 100000), // Limit text size
                language,
            ]);

            // Publish chunks for this document into knowledge_chunks (Stage 3
            // write path) + compute embeddings when configured. This is the
            // same shared service the crawler and update/reindex flows use.
            const publishResult = await publishService.publishDocument({
                pool,
                documentId: result.rows[0]?.id,
                metadata: {
                    title,
                    language,
                    doc_type: documentType,
                    source: canonicalUrl,
                },
                body: extractedText,
            });

            // Read-back totals for the response contract (document_count /
            // chunk_count) — read-only, does not write anything.
            const indexResult = await buildIndexFromPostgres(pool);

            return {
                ok: true,
                filename: safeName,
                document_id: result.rows[0]?.id,
                document_count: indexResult.documents.length,
                chunk_count: indexResult.chunks.length,
                publish_status: publishResult.status,
                publish: {
                    inserted: publishResult.inserted,
                    updated: publishResult.updated,
                    unchanged: publishResult.unchanged,
                    disabled: publishResult.disabled,
                    embedded: publishResult.embedded,
                    embed_failed: publishResult.embedFailed,
                },
                errors: publishResult.errors.length ? publishResult.errors : indexResult.errors,
                language,
            };
        }

        // Handle PDF upload
        if (ext === '.pdf') {
            const contentBase64 = String(body.contentBase64 || '');
            if (!contentBase64) {
                return sendJson(res, 400, { ok: false, error: 'content_base64_required_for_pdf' });
            }
            let extractedText;
            const buffer = Buffer.from(contentBase64, 'base64');
            try {
                const { PDFParse } = require('pdf-parse');
                const parser = new PDFParse({ data: buffer });
                try {
                    const result = await parser.getText();
                    extractedText = String(result.text || '').trim();
                } finally {
                    await parser.destroy();
                }
            } catch (error) {
                return sendJson(res, 400, { ok: false, error: 'pdf_parse_failed', message: error.message });
            }

            // If no text layer, try OCR via Gemini Vision
            if (extractedText.length < 50) {
                try {
                    const { pdfToImages } = require('./knowledge/pdfToImages');
                    const { recognizeImages } = require('./knowledge/visionOcr');

                    const images = await pdfToImages(buffer, { maxPages: 30 });
                    if (images.length === 0) {
                        return sendJson(res, 400, {
                            ok: false,
                            error: 'pdf_no_pages',
                            message: 'Could not render any pages from this PDF.',
                        });
                    }

                    extractedText = await recognizeImages(images);
                } catch (ocrError) {
                    return sendJson(res, 400, {
                        ok: false,
                        error: 'pdf_ocr_failed',
                        message: `OCR failed: ${ocrError.message}`,
                    });
                }

                if (!extractedText || extractedText.length < 50) {
                    return sendJson(res, 400, {
                        ok: false,
                        error: 'pdf_ocr_empty',
                        message: 'OCR could not extract any text from this PDF.',
                    });
                }
            }

            try {
                const title = rawName.replace(/\.pdf$/i, '');
                const result = await insertAndReindex(title, extractedText, 'uploaded_pdf');
                return sendJson(res, 200, result);
            } catch (error) {
                return sendJson(res, 500, { ok: false, error: 'upload_failed', message: error.message });
            }
        }

        // Handle text files (.md, .txt, .json, .csv)
        const content = String(body.content || '');
        if (!content) {
            return sendJson(res, 400, { ok: false, error: 'content_required' });
        }
        if (!knowledgeLoader.SUPPORTED_EXTENSIONS.has(ext)) {
            return sendJson(res, 400, {
                ok: false,
                error: 'unsupported_file_type',
                allowed: [...knowledgeLoader.SUPPORTED_EXTENSIONS, '.pdf'],
            });
        }
        try {
            const title = safeName.replace(/\.[^.]+$/, '');
            const documentType = ext === '.md' ? 'uploaded_markdown' : 'uploaded_text';
            const result = await insertAndReindex(title, content, documentType);
            return sendJson(res, 200, result);
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'upload_failed', message: error.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/knowledge/reindex') {
        try {
            const result = buildIndex();

            // Stage 3: also re-publish every active Postgres document into
            // knowledge_chunks (same shared service the upload/crawl flows
            // use) so the PG contour stays in sync with the document registry.
            // Best effort — failures are collected, the file index still wins.
            let pgResult = null;
            if (db.isEnabled()) {
                try {
                    const pool = db.getPool();
                    pgResult = await publishService.publishAllFromPostgres({ pool });
                } catch (pgErr) {
                    pgResult = { published: 0, documents: 0, disabledInactive: 0, errors: [{ reindex: pgErr.message }] };
                }
            }

            return sendJson(res, 200, {
                ok: true,
                document_count: result.documentCount,
                chunk_count: result.chunkCount,
                errors: result.errors,
                postgres: pgResult,
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'reindex_failed' });
        }
    }

    if (req.method === 'GET' && pathname === '/api/avatar/status') {
        return sendJson(res, 200, { ok: true, ...avatarProvider.getStatus() });
    }

    if (req.method === 'GET' && pathname === '/api/avatar/config') {
        return sendJson(res, 200, { ok: true, ...getAvatarClientConfig() });
    }

    // ---- Knowledge Pipeline / Knowledge Monitor (see
    // docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.7) ----

    if (req.method === 'GET' && pathname === '/api/knowledge/pipeline-status') {
        const reportFile = path.join(__dirname, '..', 'knowledge', 'reports', 'latest.json');
        if (!fs.existsSync(reportFile)) {
            return sendJson(res, 200, { ok: true, report: null });
        }
        try {
            const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
            return sendJson(res, 200, { ok: true, report });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'report_unreadable' });
        }
    }

    const discoveredListMatch = /^\/api\/knowledge\/discovered\/?$/.exec(pathname);
    if (req.method === 'GET' && discoveredListMatch) {
        const urlParams = new URL(req.url, 'http://localhost').searchParams;
        const statusFilter = urlParams.get('status');
        const all = await discoveredStore.loadAll();
        const filtered = statusFilter ? all.filter((doc) => doc.status === statusFilter) : all;
        // Full crawled text can be tens of KB — the monitor list only needs
        // a summary, not the whole document body.
        // fetchedAt is an ISO string from the file backend but a real Date
        // object from Postgres (node-pg maps TIMESTAMPTZ to Date) - this
        // crashed the whole process in production (.localeCompare doesn't
        // exist on Date), which took down every active voice session too,
        // not just this request. new Date(...) normalizes both.
        const summaries = filtered
            .sort((a, b) => new Date(b.fetchedAt || 0).getTime() - new Date(a.fetchedAt || 0).getTime())
            .map((doc) => ({
                id: doc.id,
                title: doc.title,
                url: doc.url,
                publisher: doc.publisher,
                language: doc.language,
                trustLevel: doc.trustLevel,
                topics: doc.topics,
                status: doc.status,
                summary: doc.summary,
                fetchedAt: doc.fetchedAt,
                lastVerifiedAt: doc.lastVerifiedAt,
            }));
        return sendJson(res, 200, { ok: true, documents: summaries });
    }

    const discoveredActionMatch = /^\/api\/knowledge\/discovered\/([^/]+)\/(approve|reject)\/?$/.exec(pathname);
    if (req.method === 'POST' && discoveredActionMatch) {
        const [, id, action] = discoveredActionMatch;
        const status = action === 'approve' ? 'approved' : 'rejected';
        const updated = await discoveredStore.setStatus(id, status);
        if (!updated) return sendJson(res, 404, { ok: false, error: 'document_not_found' });
        try {
            if (status === 'approved') {
                promote(updated);
                buildIndex();
            }
            return sendJson(res, 200, { ok: true, document: { id: updated.id, status: updated.status } });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'promote_failed' });
        }
    }

    // Kicks off scripts/knowledge-update.js as a separate process and
    // returns immediately (crawling takes longer than a normal request) —
    // the dashboard polls /api/knowledge/pipeline-status for the result.
    // KNOWLEDGE_UPDATE_FORCE=1 bypasses the 72h min-interval gate since a
    // manual click is an explicit request, not the scheduled cron.
    if (req.method === 'POST' && pathname === '/api/knowledge/update') {
        // Runs in-process and awaited (not a detached background child) —
        // a manual admin click can afford the ~20-60s the crawl takes, and
        // it means real errors surface directly in the HTTP response
        // instead of a silent, undebuggable background process. A
        // scheduled/cron run still uses the CLI script
        // (scripts/knowledge-update.js), which is fire-and-forget by
        // nature of running as its own process outside a request.
        try {
            const result = await runUpdateCycle({ force: true, log: () => {}, warn: () => {} });
            return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'update_failed', message: error.message });
        }
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

attachRealtimeServer(server, {
    providerFactory: defaultProvider.createSession,
    providerMetadata: defaultProvider.metadata,
    resolveProvider: (requestedProvider) => providerRegistry.resolve(requestedProvider),
});

server.listen(PORT, () => {
    const actualPort = server.address().port;
    console.log(`[WineAI] listening port=${actualPort} provider=${defaultProvider.id}`);

    searchMode.loadPersistedMode()
        .then((mode) => console.log(`[WineAI] knowledge search mode restored: ${mode}`))
        .catch((err) => console.error('[WineAI] failed to restore knowledge search mode:', err.message));

    // Set default update interval to 24 hours (once a day) as requested
    if (!process.env.KNOWLEDGE_UPDATE_MIN_INTERVAL_HOURS) {
        process.env.KNOWLEDGE_UPDATE_MIN_INTERVAL_HOURS = '24';
    }

    // Run a non-forced update check 1 minute after server starts
    setTimeout(async () => {
        try {
            console.log('[WineAI] Checking if background update cycle is needed on startup...');
            await runUpdateCycle({ force: false, log: console.log, warn: console.warn });
        } catch (err) {
            console.error('[WineAI] Startup background update check failed:', err.message);
        }
    }, 60 * 1000);

    // Periodically check every 4 hours if a daily run is due
    setInterval(async () => {
        try {
            console.log('[WineAI] Running periodic background update check...');
            await runUpdateCycle({ force: false, log: console.log, warn: console.warn });
        } catch (err) {
            console.error('[WineAI] Periodic background update check failed:', err.message);
        }
    }, 4 * 60 * 60 * 1000);
});
