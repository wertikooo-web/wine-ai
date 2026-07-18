'use strict';

const { Pcm16MonoResampler } = require('../src/realtime/pcm16Resampler');
const { resolveInputSampleRate, createInputResampler, GEMINI_INPUT_SAMPLE_RATE } = require('../src/realtime/inputAudioResampling');
const t = require('./helpers/assertions');

function tone(sampleCount, sampleRate, freqHz = 440) {
    const buf = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
        const value = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 10000);
        buf.writeInt16LE(value, i * 2);
    }
    return buf;
}

async function run() {
    // 16kHz -> 16kHz is a byte-identical pass-through (no resampling math).
    const passthrough = new Pcm16MonoResampler({ inputRate: 16000, outputRate: 16000 });
    const input = tone(100, 16000);
    const output = passthrough.process(input);
    t.deepEqual(output, input, '16kHz input must pass through byte-identical');
    t.deepEqual(passthrough.flush(), Buffer.alloc(0), 'pass-through flush() must be a no-op');

    // 24kHz -> 16kHz must shrink the sample count by the 3:2 ratio.
    const resampler = new Pcm16MonoResampler({ inputRate: 24000, outputRate: 16000 });
    const input24k = tone(2400, 24000);
    const out1 = resampler.process(input24k);
    const tail = resampler.flush();
    const totalSamples = (out1.length + tail.length) / 2;
    // 2400 input samples at 24k -> 1600 at 16k; allow the small FIR-latency
    // slack the filter's group delay introduces.
    t.ok(Math.abs(totalSamples - 1600) <= 24, `expected ~1600 output samples, got ${totalSamples}`);

    // Odd-length chunk mid-stream must not throw and must not silently drop
    // the carried byte forever — a later flush() would otherwise throw
    // invalid_pcm16_length if a stray byte were still pending.
    const oddResampler = new Pcm16MonoResampler({ inputRate: 24000, outputRate: 16000 });
    oddResampler.process(tone(10, 24000).subarray(0, 19)); // 19 bytes = 9 samples + 1 stray byte
    oddResampler.process(Buffer.from([0x00, 0x01])); // completes the stray byte pair
    t.ok(true, 'processing an odd-length chunk followed by a completing byte must not throw');

    // resolveInputSampleRate: explicit valid rate, missing rate default,
    // explicit invalid rate rejected.
    t.equal(resolveInputSampleRate({ sampleRate: 24000 }).rate, 24000);
    t.equal(resolveInputSampleRate({ sampleRate: 24000 }).source, 'declared');
    const missing = resolveInputSampleRate({});
    t.equal(missing.rate, GEMINI_INPUT_SAMPLE_RATE);
    t.equal(missing.source, 'assumed_default_no_sample_rate');
    let threw = false;
    try {
        resolveInputSampleRate({ sampleRate: 8000 });
    } catch (error) {
        threw = true;
        t.equal(error.code, 'unsupported_input_sample_rate');
    }
    t.ok(threw, 'an unsupported sample rate must throw, never be silently guessed');

    const created = createInputResampler(16000);
    t.ok(typeof created.process === 'function', 'createInputResampler must return a usable resampler');
}

module.exports = { run };
