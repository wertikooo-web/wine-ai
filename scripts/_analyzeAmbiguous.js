const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers:{'User-Agent':'Mozilla/5.0'}}, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    }).on('error', reject);
  });
}

const urls = [
  'https://wine.md/purcari-negru-de-purcari-2707',
  'https://wine.md/pinot-gris-de-purcari-3333',
  'https://wine.md/purcari-freedom-blend-3672'
];

(async () => {
  for (const url of urls) {
    const html = await fetch(url);
    console.log('\n=== ' + url + ' ===');

    // JSON-LD
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatch) {
      for (const m of ldMatch) {
        try {
          const data = JSON.parse(m.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,''));
          if (data['@type'] === 'Product') {
            console.log('  JSON-LD name:', data.name);
            console.log('  JSON-LD brand:', JSON.stringify(data.brand));
            console.log('  JSON-LD category:', data.category);
          }
        } catch(e) {}
      }
    }

    // H1
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) console.log('  H1:', h1Match[1].replace(/<[^>]+>/g,'').trim());

    // Breadcrumbs (look for structured breadcrumb data)
    const breadcrumbMatch = html.match(/itemtype="[^"]*BreadcrumbList[^"]*"[\s\S]*?<\/nav>/i);
    if (breadcrumbMatch) {
      const items = [...breadcrumbMatch[0].matchAll(/itemprop="name"[^>]*>([^<]+)/gi)];
      console.log('  Breadcrumbs:', items.map(m => m[1].trim()));
    }

    // Look for winery/producer in page text
    const producerMatch = html.match(/(?:producător|producer|winery|crame|domaine)[:\s]*([^<\n]+)/i);
    if (producerMatch) console.log('  Producer text:', producerMatch[1].trim());

    // Look for "Purcari" brand link
    const purcariLinks = [...html.matchAll(/href="[^"]*"[^>]*>[^<]*purcari[^<]*/gi)];
    console.log('  Purcari links:', purcariLinks.map(m => m[0].slice(0,100)));
  }
})();
