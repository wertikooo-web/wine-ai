const https = require('https');
const fs = require('fs');

const urls = JSON.parse(fs.readFileSync('scripts/_validationUrls.json','utf8'));
const wineProducts = urls.urls.filter(u => u.bucket === 'wine_product');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers:{'User-Agent':'Mozilla/5.0'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const ambiguous = [];
  for (const u of wineProducts) {
    const html = await fetch(u.url);
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    let brand = null;
    if (ldMatch) {
      for (const m of ldMatch) {
        try {
          const data = JSON.parse(m.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''));
          if (data['@type']==='Product' && data.brand) {
            brand = typeof data.brand === 'string' ? data.brand : data.brand.name;
          }
        } catch(e){}
      }
    }
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g,'').trim() : '';
    const inH1 = brand && h1.toLowerCase().includes(brand.toLowerCase());
    if (!inH1) {
      ambiguous.push({url: u.url, brand, h1});
    }
  }
  console.log(JSON.stringify(ambiguous, null, 2));
})();
