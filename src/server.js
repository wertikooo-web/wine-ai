'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { attachRealtimeServer } = require('./realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./realtime/mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./realtime/geminiLiveProvider');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('./geminiVoices');
const { synthesizeVoicePreview, MAX_PREVIEW_TEXT_CHARS } = require('./voicePreview');
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
const { MockAvatarProvider } = require('./avatar/providers/mockAvatarProvider');
const env = require('./config/env');

const PORT = env.PORT;
const provider = env.REALTIME_PROVIDER;
const publicDir = path.join(__dirname, '..', 'public');

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

const KNOWN_ENDPOINTS = ['/health', '/', '/dashboard', '/avatar.png', '/api/voices', '/api/voice-preview', '/api/persona', '/api/knowledge/status', '/api/knowledge/sources', '/api/knowledge/reindex', '/api/knowledge/upload', '/api/knowledge/pipeline-status', '/api/knowledge/discovered', '/api/knowledge/discovered/:id/approve', '/api/knowledge/discovered/:id/reject', '/api/knowledge/update', '/api/avatar/status', '/realtime'];

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
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
            ok: true,
            service: 'wine-ai-realtime',
            provider,
            model: providerFactory.metadata.model,
            endpoints: KNOWN_ENDPOINTS,
        });
    }

    if (req.method === 'GET' && pathname === '/') {
        return sendJson(res, 200, {
            name: 'Wine AI Realtime',
            status: 'realtime-ready',
            provider,
            model: providerFactory.metadata.model,
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

    if (req.method === 'GET' && pathname === '/api/voices') {
        return sendJson(res, 200, { ok: true, default_voice: DEFAULT_VOICE_NAME, voices: GEMINI_VOICES });
    }

    if (req.method === 'POST' && pathname === '/api/voice-preview') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        try {
            const preview = await synthesizeVoicePreview({ voiceName: body.voice_name || body.voiceName, text: body.text });
            return sendJson(res, 200, {
                ok: true,
                voice_name: preview.voiceName,
                mime_type: preview.mimeType,
                sample_rate: preview.sampleRate,
                audio_base64: preview.audioBase64,
            });
        } catch (error) {
            const code = error.code || 'voice_preview_failed';
            const statusCode = code === 'gemini_api_key_missing' ? 503 : 502;
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
                    chunk_count: 0,
                });
            }
            bySource.get(key).chunk_count += 1;
        }
        return sendJson(res, 200, { ok: true, sources: Array.from(bySource.values()) });
    }

    // Drag-and-drop upload for the Knowledge base tab. Body is JSON
    // ({filename, content}) rather than multipart — every source document
    // in this project is plain text (.md/.txt/.json/.csv), so the browser
    // just reads the dropped File as text (FileReader) and posts it,
    // avoiding a multipart-parsing dependency for a format that's already
    // text end to end.
    if (req.method === 'POST' && pathname === '/api/knowledge/upload') {
        let body;
        try {
            body = await readJsonBody(req, 2 * 1024 * 1024); // 2MB — generous for a text knowledge doc
        } catch (error) {
            return sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
        }
        const rawName = String(body.filename || '').trim();
        const content = String(body.content || '');
        if (!rawName || !content) {
            return sendJson(res, 400, { ok: false, error: 'filename_and_content_required' });
        }
        // path.basename strips any directory component the client sent —
        // this must never be able to write outside knowledge/source/.
        const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const ext = path.extname(safeName).toLowerCase();
        if (!knowledgeLoader.SUPPORTED_EXTENSIONS.has(ext)) {
            return sendJson(res, 400, {
                ok: false,
                error: 'unsupported_file_type',
                allowed: Array.from(knowledgeLoader.SUPPORTED_EXTENSIONS),
            });
        }
        try {
            const sourceDir = knowledgeLoader.DEFAULT_SOURCE_DIR;
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
    providerFactory: providerFactory.createSession,
    providerMetadata: providerFactory.metadata,
});

server.listen(PORT, () => {
    console.log(`[WineAI] listening port=${PORT} provider=${provider}`);
});
