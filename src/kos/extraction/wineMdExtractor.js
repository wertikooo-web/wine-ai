'use strict';

/**
 * Wine.md Extractor — extracts structured data from wine.md pages.
 * Handles wine products, editorial articles, and contact pages.
 */

const { JSDOM } = require('jsdom');

/**
 * Extract structured wine product data from HTML.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted wine product data
 */
function extractWineProduct(html, url) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const result = {
        type: 'wine_product',
        url,
        name: null,
        winery: null,
        vintage: null,
        grape_varieties: [],
        wine_type: null,
        color: null,
        sweetness: null,
        alcohol: null,
        region: null,
        volume: null,
        description: null,
        tasting_notes: null,
        pairing: null,
        serving_temperature: null,
        price: null,
        currency: 'MDL',
        availability: null,
        image: null,
        product_url: null,
        source_url: url,
        fetched_at: new Date().toISOString(),
    };

    // Try JSON-LD first (most reliable)
    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
        try {
            const data = JSON.parse(script.textContent);
            if (data['@type'] === 'Product' || data['@type'] === 'WineProduct') {
                extractFromJsonLd(result, data);
            }
        } catch {
            // Ignore parse errors
        }
    }

    // Fallback to HTML parsing
    if (!result.name) {
        extractFromHtml(result, doc, url);
    }

    // Extract price from common patterns
    if (!result.price) {
        result.price = extractPrice(doc);
    }

    // Extract availability
    if (!result.availability) {
        result.availability = extractAvailability(doc);
    }

    return result;
}

/**
 * Extract data from JSON-LD structured data.
 */
function extractFromJsonLd(result, data) {
    result.name = data.name || result.name;
    result.description = data.description || result.description;
    result.image = data.image || result.image;

    // Extract brand (winery)
    if (data.brand) {
        result.winery = data.brand.name || data.brand;
    }

    // Extract offers (price, availability)
    if (data.offers) {
        const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
        result.price = offers.price || offers.lowPrice || result.price;
        result.currency = offers.priceCurrency || result.currency;
        result.availability = offers.availability || result.availability;
    }

    // Extract additional properties
    if (data.additionalProperty) {
        for (const prop of data.additionalProperty) {
            const name = (prop.name || '').toLowerCase();
            const value = prop.value;

            if (name.includes('vintage') || name.includes('year')) {
                result.vintage = parseInt(value, 10) || null;
            } else if (name.includes('grape') || name.includes('variety') || name.includes('sort')) {
                result.grape_varieties.push(value);
            } else if (name.includes('type') || name.includes('wine type')) {
                result.wine_type = value;
            } else if (name.includes('color') || name.includes('colour')) {
                result.color = value;
            } else if (name.includes('sweet') || name.includes('dry')) {
                result.sweetness = value;
            } else if (name.includes('alcohol')) {
                result.alcohol = parseFloat(value) || null;
            } else if (name.includes('region')) {
                result.region = value;
            } else if (name.includes('volume') || name.includes('size')) {
                result.volume = value;
            } else if (name.includes('tasting')) {
                result.tasting_notes = value;
            } else if (name.includes('pair') || name.includes('food')) {
                result.pairing = value;
            } else if (name.includes('temperature') || name.includes('serve')) {
                result.serving_temperature = value;
            }
        }
    }
}

/**
 * Extract data from HTML elements.
 */
function extractFromHtml(result, doc, url) {
    // Extract name from title or h1
    const h1 = doc.querySelector('h1');
    if (h1) {
        result.name = h1.textContent.trim();
    } else if (doc.title) {
        result.name = doc.title.split('|')[0].split('-')[0].trim();
    }

    // Extract winery from breadcrumbs or meta
    const breadcrumbs = doc.querySelectorAll('[class*="breadcrumb"] a, nav a');
    for (const crumb of breadcrumbs) {
        const text = crumb.textContent.trim();
        if (text && !text.toLowerCase().includes('wine') && !text.toLowerCase().includes('vin')) {
            result.winery = text;
            break;
        }
    }

    // Extract description from meta or first paragraph
    const metaDesc = doc.querySelector('meta[name="description"]');
    if (metaDesc) {
        result.description = metaDesc.getAttribute('content');
    } else {
        const firstP = doc.querySelector('article p, .content p, main p');
        if (firstP) {
            result.description = firstP.textContent.trim().slice(0, 500);
        }
    }

    // Extract image
    const ogImage = doc.querySelector('meta[property="og:image"]');
    if (ogImage) {
        result.image = ogImage.getAttribute('content');
    } else {
        const productImg = doc.querySelector('img[class*="product"], img[class*="wine"], .product img');
        if (productImg) {
            result.image = productImg.getAttribute('src');
        }
    }

    // Extract product URL (canonical)
    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) {
        result.product_url = canonical.getAttribute('href');
    } else {
        result.product_url = url;
    }
}

/**
 * Extract price from HTML.
 */
function extractPrice(doc) {
    // Look for price patterns
    const pricePatterns = [
        /(\d+[\.,]\d+)\s*(?:MDL|lei|RON)/i,
        /(?:цена|price|cost)[:\s]*(\d+[\.,]\d+)/i,
        /(\d+[\.,]\d+)/,
    ];

    const priceElements = doc.querySelectorAll('[class*="price"], [class*="cost"], [data-price]');
    for (const el of priceElements) {
        const text = el.textContent;
        for (const pattern of pricePatterns) {
            const match = text.match(pattern);
            if (match) {
                return parseFloat(match[1].replace(',', '.')) || null;
            }
        }
    }

    // Fallback: search in body text
    const bodyText = doc.body ? doc.body.textContent : '';
    for (const pattern of pricePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
            return parseFloat(match[1].replace(',', '.')) || null;
        }
    }

    return null;
}

/**
 * Extract availability from HTML.
 */
function extractAvailability(doc) {
    const availabilityTexts = ['в наличии', 'in stock', 'available', 'нет в наличии', 'out of stock', 'unavailable'];
    const bodyText = (doc.body ? doc.body.textContent : '').toLowerCase();

    for (const text of availabilityTexts) {
        if (bodyText.includes(text)) {
            return text;
        }
    }

    // Check for add-to-cart button
    const addToCart = doc.querySelector('button[class*="cart"], button[class*="buy"], [data-action="add-to-cart"]');
    if (addToCart) {
        return 'available';
    }

    return null;
}

/**
 * Extract editorial article data from HTML.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted article data
 */
function extractEditorialArticle(html, url) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const result = {
        type: 'editorial_article',
        url,
        title: null,
        author: null,
        published_date: null,
        description: null,
        content: null,
        tags: [],
        image: null,
        source_url: url,
        fetched_at: new Date().toISOString(),
    };

    // Extract title
    const h1 = doc.querySelector('h1');
    if (h1) {
        result.title = h1.textContent.trim();
    } else if (doc.title) {
        result.title = doc.title.split('|')[0].split('-')[0].trim();
    }

    // Extract author
    const authorEl = doc.querySelector('[class*="author"], [rel="author"], meta[name="author"]');
    if (authorEl) {
        result.author = authorEl.getAttribute('content') || authorEl.textContent.trim();
    }

    // Extract published date
    const dateEl = doc.querySelector('time[datetime], [class*="date"], meta[property="article:published_time"]');
    if (dateEl) {
        result.published_date = dateEl.getAttribute('datetime') || dateEl.getAttribute('content') || dateEl.textContent.trim();
    }

    // Extract description
    const metaDesc = doc.querySelector('meta[name="description"]');
    if (metaDesc) {
        result.description = metaDesc.getAttribute('content');
    }

    // Extract content (main article text)
    const article = doc.querySelector('article, .content, .post-content, main');
    if (article) {
        // Remove navigation, footer, etc.
        const nav = article.querySelectorAll('nav, footer, .sidebar, .related-posts');
        nav.forEach(el => el.remove());

        result.content = article.textContent.trim().slice(0, 10000);
    }

    // Extract tags
    const tagElements = doc.querySelectorAll('[class*="tag"] a, [class*="category"] a');
    for (const tag of tagElements) {
        const text = tag.textContent.trim();
        if (text && !result.tags.includes(text)) {
            result.tags.push(text);
        }
    }

    // Extract image
    const ogImage = doc.querySelector('meta[property="og:image"]');
    if (ogImage) {
        result.image = ogImage.getAttribute('content');
    }

    return result;
}

/**
 * Extract contact page data from HTML.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted contact data
 */
function extractContactPage(html, url) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const result = {
        type: 'contact_page',
        url,
        company_name: null,
        address: null,
        phone: null,
        email: null,
        website: null,
        social_links: [],
        working_hours: null,
        source_url: url,
        fetched_at: new Date().toISOString(),
    };

    // Extract company name
    const h1 = doc.querySelector('h1');
    if (h1) {
        result.company_name = h1.textContent.trim();
    }

    // Extract phone
    const phoneRegex = /(?:\+?373|0)[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{3}/g;
    const bodyText = doc.body ? doc.body.textContent : '';
    const phoneMatch = bodyText.match(phoneRegex);
    if (phoneMatch) {
        result.phone = phoneMatch[0];
    }

    // Extract email
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emailMatch = bodyText.match(emailRegex);
    if (emailMatch) {
        result.email = emailMatch[0];
    }

    // Extract address
    const addressEl = doc.querySelector('[class*="address"], [itemprop="address"]');
    if (addressEl) {
        result.address = addressEl.textContent.trim();
    }

    // Extract social links
    const socialLinks = doc.querySelectorAll('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="linkedin"]');
    for (const link of socialLinks) {
        result.social_links.push(link.getAttribute('href'));
    }

    // Extract working hours
    const hoursEl = doc.querySelector('[class*="hours"], [class*="schedule"], [itemprop="openingHours"]');
    if (hoursEl) {
        result.working_hours = hoursEl.textContent.trim();
    }

    return result;
}

module.exports = {
    extractWineProduct,
    extractEditorialArticle,
    extractContactPage,
};
