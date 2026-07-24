'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { attachRealtimeServer } = require('./realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./realtime/mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./realtime/geminiLiveProvider');
const { createRealtimeProviderRegistry, normalizeProviderName } = require('./realtime/providerRegistry');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('./geminiVoices');
const { listGrokVoices } = require('./grokVoices');
const { synthesizeProviderVoicePreview, MAX_PREVIEW_TEXT_CHARS } = require('./voicePreview');
const { TOOL_DECLARATIONS, createToolHandlers } = require('./tools');
const { createSessionMemory } = require('./memory/sessionMemory');
const { loadIndex, buildIndex } = require('./knowledge/index');
const knowledgeLoader = require('./knowledge/loader');
const discoveredStore = require('./knowledge/discovered/store');
const { promote } = require('./knowledge/discovered/promote');
const { runUpdateCycle } = require('./knowledge/updateCycle');
const {
    SUPPORTED_LANGUAGES, defaultPersonaPrompt,
    currentPersonaName, currentPersonaDescription, currentWelcomeMessage,
} = require('./persona/wineExpertPersona');
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

const KNOWN_ENDPOINTS = ['/health', '/', '/dashboard', '/avatar-lab', '/avatar-dev', '/avatar.png', '/visual-modules/VisualStoryController.mjs', '/visual-assets/visual-story.css', '/avatar-demo-ru.wav', '/avatar-demo-gemini-orus.wav', '/api/voices', '/api/voice-preview', '/api/persona', '/api/screen-context/:type/:id', '/api/purchase-options/:wineId', '/api/analytics/purchase-click', '/api/kos/sources', '/api/kos/sources/website', '/api/kos/sources/:sourceId', '/api/kos/sources/:sourceId/crawl', '/api/knowledge/status', '/api/knowledge/sources', '/api/knowledge/sources/:file', '/api/knowledge/reindex', '/api/knowledge/upload', '/api/knowledge/pipeline-status', '/api/knowledge/discovered', '/api/knowledge/discovered/:id/approve', '/api/knowledge/discovered/:id/reject', '/api/knowledge/update', '/api/avatar/status', '/api/avatar/config', '/realtime'];

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
        '/visual-assets/bottle-codru-rose.png': {
            filePath: path.join(visualModulesDir, 'bottle-codru-rose.png'),
            contentType: 'image/png',
        },
        '/visual-assets/bottle-stefan-viorica.png': {
            filePath: path.join(visualModulesDir, 'bottle-stefan-viorica.png'),
            contentType: 'image/png',
        },
        '/visual-assets/avatar-woman-1.png': {
            filePath: path.join(publicDir, 'woman avatar 1.png'),
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
                res.writeHead(200, { 'content-type': visualStatic.contentType, 'cache-control': 'public, max-age=3600' });
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

    if (req.method === 'GET' && pathname === '/api/persona') {
        return sendJson(res, 200, {
            ok: true,
            name: currentPersonaName(),
            description: currentPersonaDescription(),
            languages: SUPPORTED_LANGUAGES,
            welcome_message: currentWelcomeMessage(),
            system_prompt: defaultPersonaPrompt(),
        });
    }

    // Persists name/description/welcome_message/system_prompt (Postgres-
    // backed when DATABASE_URL is set, file-backed for local dev — see
    // src/persona/personaStore.js). Every realtime session started AFTER a
    // successful save picks up the change immediately, since
    // defaultPersonaPrompt() reads the same in-memory cache this updates.
    // Languages are deliberately not editable here — SUPPORTED_LANGUAGES
    // drives real language-detection/UI behavior elsewhere, not just display.
    if (req.method === 'POST' && pathname === '/api/persona') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        try {
            const saved = await personaStore.save({
                name: body.name,
                description: body.description,
                welcome_message: body.welcome_message,
                system_prompt: body.system_prompt,
            });
            return sendJson(res, 200, {
                ok: true,
                name: currentPersonaName(),
                description: currentPersonaDescription(),
                languages: SUPPORTED_LANGUAGES,
                welcome_message: currentWelcomeMessage(),
                system_prompt: defaultPersonaPrompt(),
                saved,
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'persona_save_failed', message: error.message });
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
                });
                return sendJson(res, 201, { ok: true, ...result });
            }

            if (req.method === 'GET' && kosSourceMatch) {
                return sendJson(res, 200, await sourceIngestionService.getSourceWithStatus({ sourceId: kosSourceMatch[1] }));
            }

            if (req.method === 'POST' && kosSourceCrawlMatch) {
                const result = await sourceIngestionService.triggerCrawlForSource({ sourceId: kosSourceCrawlMatch[1] });
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
        return sendJson(res, 200, {
            ok: true,
            built_at: index.built_at,
            document_count: index.document_count || 0,
            chunk_count: index.chunk_count || 0,
        });
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
        // path.basename strips any directory component the client sent —
        // this must never be able to write outside knowledge/source/.
        const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const ext = path.extname(safeName).toLowerCase();
        const sourceDir = knowledgeLoader.DEFAULT_SOURCE_DIR;

        if (ext === '.pdf') {
            const contentBase64 = String(body.contentBase64 || '');
            if (!contentBase64) {
                return sendJson(res, 400, { ok: false, error: 'content_base64_required_for_pdf' });
            }
            let extractedText;
            try {
                const buffer = Buffer.from(contentBase64, 'base64');
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
            if (extractedText.length < 50) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'pdf_text_extraction_empty',
                    message: 'No extractable text found — this is likely a scanned PDF without a text layer (needs OCR, not supported here).',
                });
            }
            const mdName = safeName.replace(/\.pdf$/i, '') + '.md';
            const title = rawName.replace(/\.pdf$/i, '');
            const frontmatter = [
                '---',
                `title: ${title}`,
                'language: ru',
                'doc_type: uploaded_pdf',
                `source: Uploaded PDF via dashboard (${rawName}) — raw pdf-parse text extraction, not reviewed`,
                'confidence: unverified',
                '---',
                '',
                extractedText,
            ].join('\n');
            try {
                fs.mkdirSync(sourceDir, { recursive: true });
                fs.writeFileSync(path.join(sourceDir, mdName), frontmatter, 'utf8');
                const result = buildIndex();
                return sendJson(res, 200, {
                    ok: true,
                    filename: mdName,
                    document_count: result.documentCount,
                    chunk_count: result.chunkCount,
                    errors: result.errors,
                });
            } catch (error) {
                return sendJson(res, 500, { ok: false, error: 'upload_failed', message: error.message });
            }
        }

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
            fs.mkdirSync(sourceDir, { recursive: true });
            fs.writeFileSync(path.join(sourceDir, safeName), content, 'utf8');
            const result = buildIndex();
            return sendJson(res, 200, {
                ok: true,
                filename: safeName,
                document_count: result.documentCount,
                chunk_count: result.chunkCount,
                errors: result.errors,
            });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: 'upload_failed', message: error.message });
        }
    }

    if (req.method === 'POST' && pathname === '/api/knowledge/reindex') {
        try {
            const result = buildIndex();
            return sendJson(res, 200, {
                ok: true,
                document_count: result.documentCount,
                chunk_count: result.chunkCount,
                errors: result.errors,
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
    console.log(`[WineAI] listening port=${PORT} provider=${defaultProvider.id}`);
});
