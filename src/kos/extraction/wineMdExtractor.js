'use strict';

/**
 * Wine.md Extractor — extracts structured data from wine.md pages using cheerio.
 * Handles wine products, editorial articles, and contact pages.
 */

const cheerio = require('cheerio');

/**
 * Extract structured wine product data from HTML.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted wine product data
 */
function extractWineProduct(html, url) {
    const $ = cheerio.load(html);

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
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html());
            if (data['@type'] === 'Product' || data['@type'] === 'WineProduct') {
                extractFromJsonLd(result, data);
            }
        } catch {
            // Ignore parse errors
        }
    });

    // Fallback to HTML parsing
    if (!result.name) {
        extractFromHtml(result, $, url);
    }

    // Extract price from common patterns
    if (!result.price) {
        result.price = extractPrice($);
    }

    // Extract availability
    if (!result.availability) {
        result.availability = extractAvailability($);
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
 * Extract data from HTML elements using cheerio.
 */
function extractFromHtml(result, $, url) {
    // Extract name from title or h1
    const h1 = $('h1').first();
    if (h1.length) {
        result.name = h1.text().trim();
    } else if ($.title) {
        result.name = $.title.split('|')[0].split('-')[0].trim();
    }

    // Extract winery from breadcrumbs or meta
    $('[class*="breadcrumb"] a, nav a').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !text.toLowerCase().includes('wine') && !text.toLowerCase().includes('vin')) {
            result.winery = text;
            return false; // break
        }
    });

    // Extract description from meta or first paragraph
    const metaDesc = $('meta[name="description"]').attr('content');
    if (metaDesc) {
        result.description = metaDesc;
    } else {
        const firstP = $('article p, .content p, main p').first();
        if (firstP.length) {
            result.description = firstP.text().trim().slice(0, 500);
        }
    }

    // Extract image
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
        result.image = ogImage;
    } else {
        const productImg = $('img[class*="product"], img[class*="wine"], .product img').first();
        if (productImg.length) {
            result.image = productImg.attr('src');
        }
    }

    // Extract product URL (canonical)
    const canonical = $('link[rel="canonical"]').attr('href');
    if (canonical) {
        result.product_url = canonical;
    } else {
        result.product_url = url;
    }
}

/**
 * Extract price from HTML using cheerio.
 */
function extractPrice($) {
    // Look for price patterns
    const pricePatterns = [
        /(\d+[\.,]\d+)\s*(?:MDL|lei|RON)/i,
        /(?:цена|price|cost)[:\s]*(\d+[\.,]\d+)/i,
        /(\d+[\.,]\d+)/,
    ];

    $('[class*="price"], [class*="cost"], [data-price]').each((_, el) => {
        const text = $(el).text();
        for (const pattern of pricePatterns) {
            const match = text.match(pattern);
            if (match) {
                return parseFloat(match[1].replace(',', '.')) || null;
            }
        }
    });

    // Fallback: search in body text
    const bodyText = $('body').text() || '';
    for (const pattern of pricePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
            return parseFloat(match[1].replace(',', '.')) || null;
        }
    }

    return null;
}

/**
 * Extract availability from HTML using cheerio.
 */
function extractAvailability($) {
    const availabilityTexts = ['в наличии', 'in stock', 'available', 'нет в наличии', 'out of stock', 'unavailable'];
    const bodyText = ($('body').text() || '').toLowerCase();

    for (const text of availabilityTexts) {
        if (bodyText.includes(text)) {
            return text;
        }
    }

    // Check for add-to-cart button
    const addToCart = $('button[class*="cart"], button[class*="buy"], [data-action="add-to-cart"]').first();
    if (addToCart.length) {
        return 'available';
    }

    return null;
}

/**
 * Extract editorial article data from HTML using cheerio.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted article data
 */
function extractEditorialArticle(html, url) {
    const $ = cheerio.load(html);

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
    const h1 = $('h1').first();
    if (h1.length) {
        result.title = h1.text().trim();
    } else if ($.title) {
        result.title = $.title.split('|')[0].split('-')[0].trim();
    }

    // Extract author
    const authorEl = $('[class*="author"], [rel="author"], meta[name="author"]').first();
    if (authorEl.length) {
        result.author = authorEl.attr('content') || authorEl.text().trim();
    }

    // Extract published date
    const dateEl = $('time[datetime], [class*="date"], meta[property="article:published_time"]').first();
    if (dateEl.length) {
        result.published_date = dateEl.attr('datetime') || dateEl.attr('content') || dateEl.text().trim();
    }

    // Extract description
    const metaDesc = $('meta[name="description"]').attr('content');
    if (metaDesc) {
        result.description = metaDesc;
    }

    // Extract content (main article text)
    const article = $('article, .content, .post-content, main').first();
    if (article.length) {
        // Remove navigation, footer, etc.
        article.find('nav, footer, .sidebar, .related-posts').remove();

        result.content = article.text().trim().slice(0, 10000);
    }

    // Extract tags
    $('[class*="tag"] a, [class*="category"] a').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !result.tags.includes(text)) {
            result.tags.push(text);
        }
    });

    // Extract image
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
        result.image = ogImage;
    }

    return result;
}

/**
 * Extract contact page data from HTML using cheerio.
 * @param {string} html - Raw HTML content
 * @param {string} url - Page URL
 * @returns {Object} Extracted contact data
 */
function extractContactPage(html, url) {
    const $ = cheerio.load(html);

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
    const h1 = $('h1').first();
    if (h1.length) {
        result.company_name = h1.text().trim();
    }

    // Extract phone
    const phoneRegex = /(?:\+?373|0)[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{3}/g;
    const bodyText = $('body').text() || '';
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
    const addressEl = $('[class*="address"], [itemprop="address"]').first();
    if (addressEl.length) {
        result.address = addressEl.text().trim();
    }

    // Extract social links
    $('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="linkedin"]').each((_, el) => {
        result.social_links.push($(el).attr('href'));
    });

    // Extract working hours
    const hoursEl = $('[class*="hours"], [class*="schedule"], [itemprop="openingHours"]').first();
    if (hoursEl.length) {
        result.working_hours = hoursEl.text().trim();
    }

    return result;
}

module.exports = {
    extractWineProduct,
    extractEditorialArticle,
    extractContactPage,
};
