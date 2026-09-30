'use strict';

// Admin diagnostic: does the configured Gemini Live model accept
// speechConfig.languageCode? Opens ONE short Live session with the given
// code, asks for one Russian sentence, and reports whether audio came back
// or the server closed/rejected the config. Used before enabling
// GEMINI_SPEECH_LANGUAGE_CODE for everyone (a rejected config would break
// every voice session).

async function probeGeminiLanguageCode({
    languageCode,
    model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
    voiceName = 'Leda',
    apiKey = process.env.GEMINI_API_KEY || '',
    timeoutMs = 12000,
} = {}) {
    if (!apiKey) return { ok: false, error: 'gemini_api_key_missing' };
    const code = String(languageCode || '').trim();
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) return { ok: false, error: 'invalid_language_code' };
    const { GoogleGenAI, Modality } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const startedAt = Date.now();
    const result = { ok: true, languageCode: code, model, accepted: false, audioBytes: 0, transcript: '', closeReason: null, error: null, ms: 0 };
    let session = null;
    await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, timeoutMs);
        ai.live.connect({
            model,
            callbacks: {
                onmessage: (message) => {
                    const parts = message?.serverContent?.modelTurn?.parts || [];
                    for (const part of parts) {
                        if (part.inlineData?.data) result.audioBytes += Buffer.from(part.inlineData.data, 'base64').length;
                    }
                    if (message?.serverContent?.outputTranscription?.text) result.transcript += message.serverContent.outputTranscription.text;
                    if (message?.serverContent?.turnComplete) { clearTimeout(timer); done(); }
                },
                onerror: (event) => { result.error = String(event?.message || event?.error?.message || 'error').slice(0, 200); },
                onclose: (event) => { result.closeReason = String(event?.reason || event?.code || 'closed').slice(0, 200); clearTimeout(timer); done(); },
            },
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } }, languageCode: code },
                outputAudioTranscription: {},
                thinkingConfig: { thinkingBudget: 0 },
                systemInstruction: { parts: [{ text: 'Отвечай одной короткой фразой по-русски.' }] },
            },
        }).then((s) => {
            session = s;
            s.sendRealtimeInput({ text: 'Скажи: добрый день, я ваш сомелье.' });
        }).catch((error) => { result.error = String(error?.message || error).slice(0, 200); clearTimeout(timer); done(); });
    });
    try { session?.close(); } catch { /* closed */ }
    result.ms = Date.now() - startedAt;
    result.accepted = result.audioBytes > 0 && !result.error;
    return result;
}

module.exports = { probeGeminiLanguageCode };
