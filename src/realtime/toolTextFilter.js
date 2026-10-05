'use strict';

// Gemini Live sometimes SAYS a tool call instead of making it: the output
// transcript then contains "call:search_wine_knowledge{query:...}" and the
// /lite chat showed it to the guest (prod 2026-10-05). The audio cannot be
// edited after the fact, but the text can: this filter removes such spans
// from the streamed transcript fragments of one generation.
//
// Fragments arrive in pieces ("call:search_", "wine_knowledge{query:" ...),
// so the filter is stateful: inside a call it drops text until the matching
// closing brace, and a fragment that ends in a possible start of "call:" is
// held back until the next fragment shows whether it is one.

const START = /call\s*:\s*[a-z_][\w.]*\s*\{/i;
const PARTIAL_TAIL = /(?:^|[^\p{L}])(c|ca|cal|call|call\s*:|call\s*:\s*[a-z_][\w.]*)$/iu;

function createToolTextFilter() {
    let held = '';
    let depth = 0; // > 0 while inside a spoken call's braces
    let suppressed = 0;
    let lastTool = null;

    function push(fragment) {
        let text = held + String(fragment || '');
        held = '';
        let out = '';
        while (text) {
            if (depth > 0) {
                let i = 0;
                for (; i < text.length && depth > 0; i += 1) {
                    if (text[i] === '{') depth += 1;
                    else if (text[i] === '}') depth -= 1;
                }
                text = text.slice(i);
                continue;
            }
            const m = START.exec(text);
            if (m) {
                out += text.slice(0, m.index);
                lastTool = (m[0].match(/:\s*([a-z_][\w.]*)/i) || [])[1] || null;
                suppressed += 1;
                depth = 1;
                text = text.slice(m.index + m[0].length);
                continue;
            }
            const tail = PARTIAL_TAIL.exec(text);
            if (tail) {
                const cut = tail.index + (tail[0].length - tail[1].length);
                out += text.slice(0, cut);
                held = text.slice(cut);
            } else {
                out += text;
            }
            text = '';
        }
        return out;
    }

    // End of the generation: release held text that turned out not to be a
    // call (e.g. a sentence ending in "call"); a call that never closed is
    // dropped.
    function flush() {
        const out = depth > 0 ? '' : held;
        held = '';
        depth = 0;
        return out;
    }

    return { push, flush, stats: () => ({ suppressed, lastTool }) };
}

module.exports = { createToolTextFilter };
