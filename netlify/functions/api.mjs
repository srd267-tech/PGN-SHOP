import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const E = k => process.env[k] || '';
const clean = (s, n = 200) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const R = n => 'R' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const sast = () => new Date(Date.now() + 72e5).toISOString();
const same = (x, y) => timingSafeEqual(createHash('sha256').update(String(x)).digest(), createHash('sha256').update(String(y)).digest());
const yoco = u => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)yoco\.com$/.test(x.hostname) ? x.href : ''; } catch { return ''; } };

async function mail(to, subject, text, reply) {
  const k = E('RESEND_API_KEY'); if (!k || !to) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: E('FROM_EMAIL') || 'Shop <onboarding@resend.dev>', to: [to], subject, text, ...(reply ? { reply_to: reply } : {}) }) });
  } catch (e) { /* email is best effort */ }
}
async function allOrders(st) {
  const { blobs } = await st.list({ prefix: 'order:' });
  const os = await Promise.all(blobs.slice(-300).map(x => st.get(x.key, { type: 'json' })));
  return os.filter(Boolean).sort((p, q) => q.date.localeCompare(p.date));
}

export const config = { path: '/api' };

export default async req => {
  const url = new URL(req.url), a = url.searchParams.get('action') || '', st = getStore('shop');
  const key = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  const admin = !!E('ADMIN_KEY') && same(key, E('ADMIN_KEY'));
  let b = {}; if (req.method === 'POST') { try { b = await req.json(); } catch { /* empty body */ } }
  const day = sast().slice(0, 10), hr = sast().slice(0, 13);

  if (a === 'auth') {
    if (!E('ADMIN_KEY')) return J({ ok: false, reason: 'not_configured' }, 503);
    if (!admin) { await new Promise(r => setTimeout(r, 1000)); return J({ ok: false }, 401); }
    return J({ ok: true });
  }

  if (a === 'img') {
    const cf = await st.get('config', { type: 'json' }), sku = (url.searchParams.get('sku') || '').toLowerCase();
    const p = cf && (cf.catalog || []).find(x => String(x.sku).toLowerCase() === sku);
    const m = p && typeof p.img === 'string' && p.img.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(Buffer.from(m[2], 'base64')), { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=3600' } });
  }

  if (a === 'catalog') return J((await st.get('config', { type: 'json' })) || {});

  if (a === 'publish' && req.method === 'POST') {
    if (!admin) return J({ ok: false }, 403);
    const s = b.settings || {};
    await st.setJSON('config', { catalog: Array.isArray(b.catalog) ? b.catalog : [],
      settings: { yoco: yoco(s.yoco), biz: clean(s.biz, 80), contact: clean(s.contact, 200), vat: clean(s.vat, 40) } });
    return J({ ok: true });
  }

  if (a === 'view') {
    const v = (await st.get('views', { type: 'json' })) || {};
    v.total = (v.total || 0) + 1; v.days = v.days || {}; v.days[day] = (v.days[day] || 0) + 1; v.visitors = v.visitors || {};
    const vid = clean(b.vid || 'anon', 40), isNew = !v.visitors[vid]; if (isNew) v.visitors[vid] = day;
    const ks = Object.keys(v.visitors); if (ks.length > 20000) for (const k of ks.slice(0, ks.length - 20000)) delete v.visitors[k];
    if (v.hour !== hr) { v.hour = hr; v.sent = 0; }
    const send = isNew && (v.sent || 0) < (+E('VIEW_EMAILS_PER_HOUR') || 10); if (send) v.sent = (v.sent || 0) + 1;
    await st.setJSON('views', v);
    if (send) await mail(E('STORE_EMAIL'), 'New visitor on your shop',
      `Someone just opened your shop link.\n\nTotal views: ${v.total}\nUnique visitors: ${Object.keys(v.visitors).length}\nViews today: ${v.days[day]}\n`);
    return J({ ok: true });
  }

  if (a === 'order') {
    const o = b.order || {}, id = clean(o.id, 24);
    if (!/^ORD-[A-Z0-9-]{4,20}$/.test(id) || !Array.isArray(o.items) || !o.items.length) return J({ ok: false }, 400);
    if (await st.get('order:' + id)) return J({ ok: true });
    const c = o.customer || {}, t = o.totals || {};
    const rec = { id, date: new Date().toISOString(), status: 'Pending', pay: 'Yoco', yref: '', courier: clean(o.courier), promo: clean(o.promo, 20) || null,
      customer: { name: clean(c.name), email: clean(c.email), phone: clean(c.phone), addr: clean(c.addr, 300), notes: clean(c.notes, 300) },
      items: o.items.slice(0, 50).map(i => ({ id: +i.id || 0, sku: clean(i.sku, 40), name: clean(i.name, 120), price: +i.price || 0, qty: Math.max(0, Math.floor(+i.qty || 0)) })),
      totals: { sub: +t.sub || 0, disc: +t.disc || 0, ship: +t.ship || 0, tax: +t.tax || 0, total: +t.total || 0 } };
    await st.setJSON('order:' + id, rec);
    const cf = await st.get('config', { type: 'json' });
    if (cf && cf.catalog) { for (const i of rec.items) { const p = cf.catalog.find(x => x.sku === i.sku); if (p) p.stock = Math.max(0, (+p.stock || 0) - i.qty); } await st.setJSON('config', cf); }
    const lines = rec.items.map(i => `  ${i.sku}  ${i.name} x ${i.qty}  ${R(i.price * i.qty)}`).join('\n');
    await mail(E('STORE_EMAIL'), `New order ${id} - ${R(rec.totals.total)}`,
      `Order ${id} (AWAITING PAYMENT)\n\nCustomer: ${rec.customer.name}\nEmail: ${rec.customer.email}\nCell: ${rec.customer.phone}\nDeliver to: ${rec.customer.addr}\nNotes: ${rec.customer.notes}\nCourier: ${rec.courier}\n\n${lines}\n\nDelivery: ${rec.totals.ship ? R(rec.totals.ship) : 'Free'}\nTOTAL: ${R(rec.totals.total)}\n\nTotals come from the customer's browser. Check the amount in Yoco when the payment arrives.\n`, rec.customer.email);
    if (E('CONFIRM_CUSTOMER') === 'true') await mail(rec.customer.email, `We received your order ${id}`,
      `Hi ${rec.customer.name},\n\nThank you for your order.\n\n${lines}\n\nTotal: ${R(rec.totals.total)}\nCourier: ${rec.courier}\n\nPlease pay with our Yoco link and use ${id} as the payment reference. We will pack your order once payment is confirmed.\n`);
    return J({ ok: true });
  }

  if (a === 'payclick') {
    const o = await st.get('order:' + clean(b.id, 24), { type: 'json' });
    if (o) await mail(E('STORE_EMAIL'), `Customer opened Yoco payment for ${o.id}`,
      `${o.customer.name} (${o.customer.email}) clicked "Pay with Yoco" for ${o.id}, amount ${R(o.totals.total)}.\n\nThis is NOT confirmation of payment. Confirm it in your Yoco app, then mark the order as paid.\n`);
    return J({ ok: true });
  }

  if (a === 'orders') { if (!admin) return J({ ok: false }, 403); return J({ orders: await allOrders(st) }); }

  if (a === 'stats') {
    if (!admin) return new Response('Forbidden', { status: 403 });
    const v = (await st.get('views', { type: 'json' })) || {}, os = await allOrders(st);
    const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() + 72e5 - i * 864e5).toISOString().slice(0, 10); return `<li>${d}: ${(v.days || {})[d] || 0}</li>`; }).join('');
    const rows = os.slice(0, 25).map(o => `<tr><td>${esc(o.id)}</td><td>${esc(o.customer.name)}<br>${esc(o.customer.email)}</td><td>${R(o.totals.total)}</td><td>${esc(o.date.slice(0, 10))}</td></tr>`).join('');
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shop stats</title><body style="font:15px Arial;max-width:760px;margin:24px auto;padding:0 16px"><h2>Shop stats</h2><p>Total views: <b>${v.total || 0}</b> · Unique visitors: <b>${Object.keys(v.visitors || {}).length}</b> · Orders: <b>${os.length}</b></p><h3>Views, last 7 days</h3><ul>${days}</ul><h3>Latest orders</h3><table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr><th>Order</th><th>Customer</th><th>Total</th><th>Date</th></tr>${rows}</table>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return J({ ok: false }, 404);
};
