const fs = require('fs');
const urls = JSON.parse(fs.readFileSync('scripts/_validationUrls.json','utf8'));
const wineProducts = urls.urls.filter(u => u.bucket === 'wine_product');

// Load the new extractor results from the report
// Actually, I need to re-run extraction to get winery values
// Let me just fetch and extract from JSON-LD
const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers:{'User-Agent':'Mozilla/5.0'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    }).on('error', reject);
  });
}

function extract(html, url) {
  const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  let name = null, winery = null;
  if (ldMatch) {
    for (const m of ldMatch) {
      try {
        const data = JSON.parse(m.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''));
        if (data['@type'] === 'Product') {
          name = data.name;
          if (data.brand) {
            winery = typeof data.brand === 'string' ? data.brand : data.brand.name;
          }
        }
      } catch(e) {}
    }
  }
  return { name, winery };
}

(async () => {
  const ambiguous = [];
  const linked = [];
  for (const u of wineProducts) {
    const html = await fetch(u.url);
    const { name, winery } = extract(html, u.url);
    const urlHasWinery = winery && u.url.toLowerCase().includes(winery.toLowerCase().split(' ')[0]);
    const nameHasWinery = winery && name && name.toLowerCase().includes(winery.toLowerCase().split(' ')[0]);
    if (!urlHasWinery && !nameHasWinery) {
      ambiguous.push({ url: u.url, name, winery, firstWord: winery?.split(' ')[0] });
    } else {
      linked.push({ url: u.url, name, winery });
    }
  }
  console.log('=== AMBIGUOUS (3) ===');
  console.log(JSON.stringify(ambiguous, null, 2));
  console.log('\n=== LINKED (27) ===');
  console.log(linked.length, 'linked');
})();
