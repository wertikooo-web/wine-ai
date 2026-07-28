'use strict';

/**
 * PDF to Images — renders PDF pages to PNG buffers using puppeteer-core.
 * Used for scanned PDFs that need OCR.
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

let chromiumPath = null;

/**
 * Get chromium executable path.
 */
async function getChromiumPath() {
    if (chromiumPath) return chromiumPath;

    // Try @sparticuz/chromium first (for serverless environments)
    try {
        chromiumPath = await chromium.executablePath();
        return chromiumPath;
    } catch (e) {
        // Fall through to system chromium
    }

    // Try common paths
    const paths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        process.env.CHROME_PATH,
    ].filter(Boolean);

    for (const p of paths) {
        try {
            const fs = require('fs');
            if (fs.existsSync(p)) {
                chromiumPath = p;
                return chromiumPath;
            }
        } catch (e) {
            // Continue
        }
    }

    throw new Error('No Chromium/Chrome found. Set CHROME_PATH environment variable.');
}

/**
 * Render PDF pages to PNG images.
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {object} options - Options
 * @param {number} options.maxPages - Maximum pages to render (default: 50)
 * @param {number} options.scale - Page scale (default: 2)
 * @returns {Promise<Array<{buffer: Buffer, width: number, height: number, pageIndex: number}>>}
 */
async function pdfToImages(pdfBuffer, options = {}) {
    const { maxPages = 50, scale = 2 } = options;

    const execPath = await getChromiumPath();
    let browser = null;

    try {
        browser = await puppeteer.launch({
            executablePath: execPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
            headless: true,
        });

        const page = await browser.newPage();

        // Load PDF as data URL
        const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
        await page.goto(dataUrl, { waitUntil: 'networkidle0', timeout: 60000 });

        // Get total page count
        const totalPages = await page.evaluate(() => {
            const viewer = document.querySelector('embed');
            if (viewer && viewer.postMessage) {
                // Try to get page count from PDF viewer
                return null;
            }
            // Fallback: count canvas elements
            return document.querySelectorAll('canvas').length || 1;
        });

        // Render each page
        const images = [];
        const pagesToRender = Math.min(totalPages || maxPages, maxPages);

        for (let i = 0; i < pagesToRender; i++) {
            try {
                // Navigate to specific page
                await page.evaluate((pageIndex) => {
                    const embed = document.querySelector('embed');
                    if (embed && embed.postMessage) {
                        embed.postMessage({ type: 'goToPage', page: pageIndex + 1 }, '*');
                    }
                }, i);

                // Wait for render
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Capture screenshot
                const screenshot = await page.screenshot({
                    type: 'png',
                    fullPage: false,
                });

                images.push({
                    buffer: screenshot,
                    mimeType: 'image/png',
                    pageIndex: i,
                    width: page.viewport()?.width || 800,
                    height: page.viewport()?.height || 600,
                });
            } catch (pageError) {
                console.error(`[pdfToImages] Failed to render page ${i + 1}:`, pageError.message);
                // Continue with other pages
            }
        }

        return images;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = {
    pdfToImages,
};
