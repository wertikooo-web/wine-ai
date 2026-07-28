'use strict';

/**
 * Vision OCR Module — extracts text from images using Gemini Vision API.
 * Used for scanned PDFs without a text layer.
 */

const { GoogleGenAI } = require('@google/genai');

const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash';

const OCR_PROMPT = `Extract all text from this image exactly as it appears.
Preserve the original formatting, line breaks, and structure.
Return ONLY the extracted text without any commentary or explanation.
If the image contains a table, preserve its structure.
If the image is in Russian, Romanian, or English, extract the text in that language.`;

let ai = null;

function getClient() {
    if (!ai) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is required for vision OCR');
        }
        ai = new GoogleGenAI({ apiKey });
    }
    return ai;
}

/**
 * Recognize text from a single image buffer.
 * @param {Buffer} imageBuffer - The image data
 * @param {string} mimeType - MIME type (image/png, image/jpeg, etc.)
 * @returns {Promise<string>} Extracted text
 */
async function recognizeImage(imageBuffer, mimeType = 'image/png') {
    const client = getClient();
    const base64Data = imageBuffer.toString('base64');

    const response = await client.models.generateContent({
        model: GEMINI_VISION_MODEL,
        contents: [{
            role: 'user',
            parts: [
                { text: OCR_PROMPT },
                { inlineData: { mimeType, data: base64Data } }
            ]
        }],
        config: {
            temperature: 0,
        }
    });

    const text = response.text;
    if (!text || typeof text !== 'string') {
        throw new Error('Gemini Vision returned empty response');
    }

    return text.trim();
}

/**
 * Recognize text from multiple image buffers (e.g., PDF pages).
 * @param {Array<{buffer: Buffer, mimeType: string}>} images - Array of image data
 * @param {object} options - Options
 * @param {number} options.concurrency - Max parallel API calls (default: 3)
 * @returns {Promise<string>} Combined extracted text
 */
async function recognizeImages(images, options = {}) {
    const { concurrency = 3 } = options;

    if (!images.length) {
        throw new Error('No images provided for OCR');
    }

    const results = [];
    for (let i = 0; i < images.length; i += concurrency) {
        const batch = images.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(img => recognizeImage(img.buffer, img.mimeType))
        );
        results.push(...batchResults);
    }

    return results.join('\n\n--- Page Break ---\n\n');
}

module.exports = {
    recognizeImage,
    recognizeImages,
    GEMINI_VISION_MODEL,
};
