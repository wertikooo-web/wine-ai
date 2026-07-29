const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers: {'User-Agent': 'Mozilla/5.0'}}, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({status: res.statusCode, html: data}));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractMinimal(html, url) {
  const result = {url, bucket: 'technical_skip', expected_type: 'technical', extracted: {}, success: true};

  const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (ldMatch) {
    for (const m of ldMatch) {
      const json = m.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      try {
        const data = JSON.parse(json);
        if (data['@type'] === 'Product') {
          result.extracted.name = data.name;
          result.extracted.description = data.description;
          result.extracted.image = data.image;
          if (data.offers) {
            const offer = Array.isArray(data.offers) ? data.offers[0] : data.offers;
            result.extracted.price = offer.price;
            result.extracted.priceCurrency = offer.priceCurrency;
            result.extracted.availability = offer.availability;
          }
        }
      } catch(e) {}
    }
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) result.extracted.h1 = h1Match[1].replace(/<[^>]+>/g, '').trim();

  return result;
}

(async () => {
  const urls = [
    'https://wine.md/catalog/wine/vinuri-albe/?sort=price',
    'https://wine.md/serviciul-clienti/termenu-si-conditii'
  ];
  const results = [];
  for (const url of urls) {
    try {
      const {status, html} = await fetchPage(url);
      if (status !== 200) {
        results.push({url, bucket: 'technical_skip', expected_type: 'technical', extracted: {}, success: false, error: `HTTP ${status}`});
        console.log(url, 'HTTP', status);
        continue;
      }
      const r = extractMinimal(html, url);
      results.push(r);
      console.log(url, 'OK', JSON.stringify(r.extracted).slice(0,100));
    } catch(e) {
      results.push({url, bucket: 'technical_skip', expected_type: 'technical', extracted: {}, success: false, error: e.message});
      console.log(url, 'ERROR:', e.message);
    }
  }

  const baselinePath = path.join(__dirname, '_baselineOld.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const old404urls = [
    'https://wine.md/search?q=vin',
    'https://wine.md/serviciul-clienti/termeni-si-conditii'
  ];
  baseline.results = baseline.results.filter(r => !old404urls.includes(r.url));
  baseline.results.push(...results);
  baseline._meta.total = baseline.results.length;
  baseline._meta.ok_count = baseline.results.filter(r => r.success).length;
  baseline._meta.failed_count = baseline.results.filter(r => !r.success).length;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  console.log(`Baseline updated: ${baseline._meta.total} URLs, ${baseline._meta.ok_count} ok, ${baseline._meta.failed_count} failed`);
})();
