import { getStore } from '@netlify/blobs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Serves the shop page for /p/<SKU> with product details in the link preview (WhatsApp, Facebook, etc.).
export const config = { path: '/p/*' };

export default async req => {
  const u = new URL(req.url);
  let html = await (await fetch(new URL('/index.html', u.origin))).text();
  try {
    const sku = decodeURIComponent(u.pathname.replace(/^\/p\//, '').split('/')[0]).toLowerCase();
    const cf = await getStore('shop').get('config', { type: 'json' });
    const p = cf && (cf.catalog || []).find(x => String(x.sku).toLowerCase() === sku);
    if (p) {
      const biz = (cf.settings && cf.settings.biz) || 'our shop';
      const title = `${p.name} - R${Number(p.price).toFixed(2)}`;
      const desc = `${p.cat} · SKU ${p.sku}. Order from ${biz} with delivery across South Africa.`;
      const img = p.img ? `${u.origin}/api?action=img&sku=${encodeURIComponent(p.sku)}` : '';
      const tags = `<meta name="description" content="${esc(desc)}"><meta property="og:type" content="product"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(u.href)}">${img ? `<meta property="og:image" content="${esc(img)}">` : ''}<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">`;
      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`).replace('</head>', tags + '</head>');
    }
  } catch (e) { /* fall back to the plain page */ }
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
};
