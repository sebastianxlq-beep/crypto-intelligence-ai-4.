import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sma, smaSeries, rsi, macd, volatility, maxDrawdown } from './lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Render termina TLS y reenvía las solicitudes desde un proxy. Un salto de confianza
// permite identificar la IP del visitante para aplicar límites por dirección.
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
// Identificador anónimo por navegador: separa favoritos y simulaciones sin pedir registro.
app.use((req, res, next) => {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cia_visitor='));
  const candidate = raw ? decodeURIComponent(raw.slice('cia_visitor='.length)) : '';
  const visitorId = /^[a-f0-9]{64}$/.test(candidate) ? candidate : randomBytes(32).toString('hex');
  req.visitorId = visitorId;
  if (visitorId !== candidate) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `cia_visitor=${visitorId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  next();
});

// Límites por IP: la aplicación es pública y las claves API son compartidas.
// El límite general protege CoinGecko/RSS; los límites adicionales protegen escrituras y Anthropic.
function rateLimit({ windowMs, max, message }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retry = Math.max(1, Math.ceil((windowMs - (now - bucket.start)) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: message || 'Demasiadas solicitudes. Inténtalo más tarde.' });
    }
    // Evita que las IP antiguas acumulen memoria indefinidamente.
    if (buckets.size > 5000) {
      for (const [ip, b] of buckets) if (now - b.start >= windowMs) buckets.delete(ip);
    }
    next();
  };
}
app.use('/api', rateLimit({ windowMs: 60_000, max: 90, message: 'Has realizado demasiadas consultas. Espera un minuto.' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Capa de datos: CoinGecko con caché y degradación controlada ---------- */
const CG = 'https://api.coingecko.com/api/v3';
const cache = new Map();
async function cached(key, ttl, url, { text = false } = {}) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return { data: c.d, fetchedAt: c.t, stale: false };
  try {
    const headers = { accept: text ? '*/*' : 'application/json', 'user-agent': 'CryptoIntelligenceAI/1.0' };
    if (process.env.COINGECKO_API_KEY && url.startsWith(CG)) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = text ? await r.text() : await r.json();
    cache.set(key, { d, t: Date.now() });
    return { data: d, fetchedAt: Date.now(), stale: false };
  } catch (e) {
    if (c) return { data: c.d, fetchedAt: c.t, stale: true, error: e.message }; // dato antiguo, marcado como tal
    throw Object.assign(new Error('Fuente de datos no disponible: ' + e.message), { status: 503 });
  }
}
const getMarkets = () => cached('markets', 30e3, `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=1h,24h,7d`);
const getGlobal = () => cached('global', 60e3, `${CG}/global`);
const getTrending = () => cached('trending', 300e3, `${CG}/search/trending`);
const getChart = (id, days) => cached(`chart:${id}:${days}`, days <= 1 ? 60e3 : 300e3, `${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
const getNews = async () => {
  const r = await cached('news', 600e3, 'https://www.coindesk.com/arc/outboundfeeds/rss/', { text: true });
  const tag = (s, t) => (s.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1];
  const items = [...r.data.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8)
    .map((m) => ({ title: tag(m[1], 'title'), link: tag(m[1], 'link'), date: tag(m[1], 'pubDate') })).filter((i) => i.title && /^https?:/.test(i.link || ''));
  return { data: items, fetchedAt: r.fetchedAt, stale: r.stale };
};

const wrap = (f) => (q, s) => f(q, s).catch((e) => s.status(e.status || 502).json({ error: e.message }));
const cid = (v) => { if (!/^[a-z0-9-]{1,60}$/.test(String(v))) throw Object.assign(new Error('Identificador de moneda inválido'), { status: 400 }); return v; };
const meta = (r) => ({ fetchedAt: r.fetchedAt, stale: r.stale, error: r.error, source: 'CoinGecko' });

/* ---------- Análisis técnico ---------- */
async function computeAnalysis(id) {
  const [ch] = await Promise.all([getChart(id, 120)]);
  const t = ch.data.prices.map((p) => p[0]);
  const c = ch.data.prices.map((p) => p[1]);
  const vol = ch.data.total_volumes.map((p) => p[1]);
  if (c.length < 35) throw Object.assign(new Error('Historial insuficiente para analizar esta moneda'), { status: 422 });
  const last = c.at(-1), s20 = sma(c, 20), s50 = sma(c, 50), R = rsi(c), M = macd(c), V = volatility(c);
  const pct = (n) => (last / c.at(-1 - n) - 1) * 100;
  const rec = c.slice(-30), sup = Math.min(...rec), res = Math.max(...rec);
  const v7 = vol.slice(-7).reduce((a, b) => a + b, 0) / 7, v30 = vol.slice(-37, -7).reduce((a, b) => a + b, 0) / Math.max(1, vol.slice(-37, -7).length);
  const f = (n) => (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toPrecision(3));
  const score = (last > s20) + (s20 > s50 && s50 != null) + (M.hist > 0);
  const trend = ['Bajista', 'Moderadamente bajista', 'Moderadamente alcista', 'Alcista'][score];
  const findings = [
    { name: 'RSI (14 días)', value: R.toFixed(1), reading: R > 70 ? 'Sobrecompra: subió con fuerza en poco tiempo. Indica impulso, no garantiza una caída.' : R < 30 ? 'Sobreventa: bajó con fuerza en poco tiempo. No garantiza un rebote.' : 'Zona neutral (entre 30 y 70).' },
    { name: 'MACD', value: `hist ${M.hist.toPrecision(3)}`, reading: M.hist > 0 ? 'Línea MACD sobre su señal: el impulso reciente es alcista.' : 'Línea MACD bajo su señal: el impulso reciente es bajista.' },
    { name: 'Media móvil 20 días', value: '$' + f(s20), reading: last > s20 ? 'El precio está por encima: tendencia de corto plazo positiva.' : 'El precio está por debajo: tendencia de corto plazo débil.' },
    { name: 'Media móvil 50 días', value: '$' + f(s50), reading: s20 > s50 ? 'La media de 20 está sobre la de 50 (cruce alcista).' : 'La media de 20 está bajo la de 50 (cruce bajista).' },
    { name: 'Volatilidad (30 días)', value: `${V.daily.toFixed(2)}% diaria`, reading: `Equivale a ~${V.annual.toFixed(0)}% anualizada. Más volatilidad = movimientos de precio más amplios en ambos sentidos.` },
    { name: 'Volumen', value: `${(v7 / v30).toFixed(2)}× vs. mes previo`, reading: v7 / v30 > 1.3 ? 'Volumen reciente claramente superior al habitual.' : v7 / v30 < 0.7 ? 'Volumen reciente claramente inferior al habitual.' : 'Volumen en línea con el habitual.' },
    { name: 'Soporte / resistencia (estimados)', value: `$${f(sup)} – $${f(res)}`, reading: 'Mínimo y máximo de los cierres diarios de 30 días. Es una estimación, no un nivel garantizado.' },
    { name: 'Comportamiento histórico', value: `30d ${pct(30).toFixed(1)}% · 90d ${pct(90).toFixed(1)}%`, reading: 'Variación del precio en esos periodos. El pasado no predice el futuro.' },
  ];
  const n = 90;
  return { id, trend, price: last, findings, series: { t: t.slice(-n), p: c.slice(-n), s20: smaSeries(c, 20).slice(-n), s50: smaSeries(c, 50).slice(-n) },
    ...meta(ch), disclaimer: 'Análisis educativo basado en datos históricos diarios. No es una recomendación de inversión ni una predicción.' };
}

/* ---------- API de mercado ---------- */
app.get('/api/markets', wrap(async (q, s) => { const r = await getMarkets(); s.json({ data: r.data, ...meta(r) }); }));
app.get('/api/global', wrap(async (q, s) => { const r = await getGlobal(); s.json({ data: r.data.data, ...meta(r) }); }));
app.get('/api/trending', wrap(async (q, s) => {
  const r = await getTrending();
  s.json({ data: r.data.coins.map(({ item: i }) => ({ id: i.id, name: i.name, symbol: i.symbol, rank: i.market_cap_rank, change24h: i.data?.price_change_percentage_24h?.usd ?? null })), ...meta(r) });
}));
app.get('/api/news', wrap(async (q, s) => { const r = await getNews(); s.json({ data: r.data, fetchedAt: r.fetchedAt, stale: r.stale, source: 'CoinDesk (RSS)' }); }));
app.get('/api/chart/:id', wrap(async (q, s) => {
  const days = [1, 7, 30, 90].includes(+q.query.days) ? +q.query.days : 7;
  const r = await getChart(cid(q.params.id), days);
  s.json({ prices: r.data.prices, volumes: r.data.total_volumes, ...meta(r) });
}));
app.get('/api/analysis/:id', wrap(async (q, s) => s.json(await computeAnalysis(cid(q.params.id)))));

/* ---------- Preferencias y simulador (SQLite) ---------- */
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
create table if not exists account(visitor_id text primary key, cash real not null);
create table if not exists holdings(visitor_id text not null, coin text not null, qty real not null, cost real not null, primary key(visitor_id, coin));
create table if not exists trades(id integer primary key autoincrement, visitor_id text not null, ts integer, coin text, side text, qty real, price real, usd real, pnl real);
create table if not exists prefs(visitor_id text not null, k text not null, v text, primary key(visitor_id, k));`);
const START = 10000;

app.get('/api/prefs', (q, s) => {
  const r = db.prepare("select v from prefs where visitor_id=? and k='watchlist'").get(q.visitorId);
  s.json({ watchlist: r ? JSON.parse(r.v) : ['bitcoin', 'ethereum', 'solana', 'ripple'] });
});
app.put('/api/prefs', rateLimit({ windowMs: 60_000, max: 20 }), wrap(async (q, s) => {
  const w = q.body?.watchlist;
  if (!Array.isArray(w) || w.length > 12 || !w.every((x) => /^[a-z0-9-]{1,60}$/.test(x))) throw Object.assign(new Error('Lista inválida'), { status: 400 });
  db.prepare("insert into prefs(visitor_id,k,v) values(?, 'watchlist', ?) on conflict(visitor_id,k) do update set v=excluded.v").run(q.visitorId, JSON.stringify(w));
  s.json({ watchlist: w });
}));

app.get('/api/sim', wrap(async (q, s) => {
  const m = await getMarkets();
  db.prepare('insert or ignore into account(visitor_id, cash) values(?, ?)').run(q.visitorId, START);
  const cash = db.prepare('select cash from account where visitor_id=?').get(q.visitorId).cash;
  const holdings = db.prepare('select * from holdings where visitor_id=? and qty>0').all(q.visitorId).map((h) => {
    const price = m.data.find((c) => c.id === h.coin)?.current_price ?? null;
    const value = price != null ? h.qty * price : h.cost;
    return { ...h, price, value, pnl: value - h.cost };
  });
  const total = cash + holdings.reduce((a, h) => a + h.value, 0);
  const trades = db.prepare('select * from trades where visitor_id=? order by id desc limit 50').all(q.visitorId);
  s.json({ cash, holdings, total, pnl: total - START, start: START, trades, ...meta(m) });
}));

app.post('/api/sim/trade', rateLimit({ windowMs: 60_000, max: 20 }), wrap(async (q, s) => {
  const { coin, side } = q.body || {}, usd = Number(q.body?.usd);
  if (!['buy', 'sell'].includes(side) || !(usd > 0) || !isFinite(usd)) throw Object.assign(new Error('Operación inválida'), { status: 400 });
  const m = await getMarkets();
  if (m.stale || Date.now() - m.fetchedAt > 120e3) throw Object.assign(new Error('Precios desactualizados: operación bloqueada hasta recibir datos frescos'), { status: 503 });
  const c = m.data.find((x) => x.id === coin);
  if (!c) throw Object.assign(new Error('Moneda no disponible en el simulador'), { status: 400 });
  const price = c.current_price;
  db.transaction(() => {
    db.prepare('insert or ignore into account(visitor_id, cash) values(?, ?)').run(q.visitorId, START);
    const cash = db.prepare('select cash from account where visitor_id=?').get(q.visitorId).cash;
    const h = db.prepare('select * from holdings where visitor_id=? and coin=?').get(q.visitorId, coin) || { qty: 0, cost: 0 };
    if (side === 'buy') {
      if (usd > cash + 1e-9) throw Object.assign(new Error('Saldo virtual insuficiente'), { status: 400 });
      const qty = usd / price;
      db.prepare('update account set cash=cash-? where visitor_id=?').run(usd, q.visitorId);
      db.prepare('insert into holdings(visitor_id,coin,qty,cost) values(?,?,?,?) on conflict(visitor_id,coin) do update set qty=qty+excluded.qty, cost=cost+excluded.cost').run(q.visitorId, coin, qty, usd);
      db.prepare('insert into trades(visitor_id,ts,coin,side,qty,price,usd,pnl) values(?,?,?,?,?,?,?,NULL)').run(q.visitorId, Date.now(), coin, side, qty, price, usd);
    } else {
      const qty = Math.min(usd / price, h.qty);
      if (!(qty > 0)) throw Object.assign(new Error('No tienes esa moneda para vender'), { status: 400 });
      const avg = h.cost / h.qty, proceeds = qty * price, pnl = (price - avg) * qty;
      db.prepare('update account set cash=cash+? where visitor_id=?').run(proceeds, q.visitorId);
      db.prepare('update holdings set qty=qty-?, cost=cost-? where visitor_id=? and coin=?').run(qty, avg * qty, q.visitorId, coin);
      db.prepare('insert into trades(visitor_id,ts,coin,side,qty,price,usd,pnl) values(?,?,?,?,?,?,?,?)').run(q.visitorId, Date.now(), coin, side, qty, price, proceeds, pnl);
    }
  })();
  s.json({ ok: true, price });
}));

app.post('/api/sim/reset', rateLimit({ windowMs: 60_000, max: 5 }), (q, s) => {
  db.transaction(() => { db.prepare('insert into account(visitor_id,cash) values(?,?) on conflict(visitor_id) do update set cash=excluded.cash').run(q.visitorId, START); db.prepare('delete from holdings where visitor_id=?').run(q.visitorId); db.prepare('delete from trades where visitor_id=?').run(q.visitorId); })();
  s.json({ ok: true });
});

app.get('/api/sim/backtest', wrap(async (q, s) => {
  const id = cid(q.query.id), days = Math.min(Math.max(+q.query.days || 90, 14), 120), amt = Math.min(Math.max(+q.query.amount || 1000, 10), 1e7);
  const ch = await getChart(id, 120);
  const p = ch.data.prices.slice(-days).map((x) => x[1]);
  const row = (name, v) => ({ name, final: v.at(-1), ret: (v.at(-1) / amt - 1) * 100, maxDrawdown: maxDrawdown(v) });
  const out = [];
  { const q0 = amt / p[0]; out.push(row('Comprar y mantener', p.map((x) => q0 * x))); }
  { const n = Math.ceil(p.length / 7), per = amt / n; let qty = 0, inv = 0;
    out.push(row('Compra semanal repartida (DCA)', p.map((x, i) => { if (i % 7 === 0) { qty += per / x; inv += per; } return qty * x + (amt - inv); }))); }
  { let qty = amt / p[0], cash = 0, out_ = false;
    out.push(row('Comprar y vender si cae 10%', p.map((x) => { if (!out_ && x <= p[0] * 0.9) { cash = qty * x; qty = 0; out_ = true; } return qty * x + cash; }))); }
  s.json({ id, days, amount: amt, results: out, ...meta(ch), note: 'Simulación con datos históricos diarios, sin comisiones. Resultados pasados no garantizan resultados futuros.' });
}));

/* ---------- Asistente de IA (la clave nunca sale del servidor) ---------- */
const aiMinuteLimit = rateLimit({ windowMs: 60_000, max: 5, message: 'Límite de IA: máximo 5 consultas por minuto. Espera un poco.' });
const aiHourlyLimit = rateLimit({ windowMs: 60 * 60_000, max: 30, message: 'Has alcanzado el límite de 30 consultas de IA por hora.' });
let activeAIRequests = 0;
async function buildContext(question) {
  const parts = [], sources = [], missing = [];
  const ql = question.toLowerCase(), tk = new Set(ql.split(/[^a-z0-9]+/));
  try {
    const m = await getMarkets();
    sources.push({ name: 'CoinGecko (precios y volumen)', at: m.fetchedAt, stale: m.stale });
    const L = (c) => `${c.name} (${c.symbol.toUpperCase()}): $${c.current_price} | 24h ${c.price_change_percentage_24h?.toFixed(2)}% | 7d ${c.price_change_percentage_7d_in_currency?.toFixed(2)}% | vol24h $${Math.round(c.total_volume)} | cap $${Math.round(c.market_cap)} | máx24h $${c.high_24h} mín24h $${c.low_24h}`;
    parts.push(`PRECIOS ACTUALES (CoinGecko, recibidos ${new Date(m.fetchedAt).toISOString()}${m.stale ? ', DESACTUALIZADOS' : ''}):\n` + m.data.slice(0, 15).map(L).join('\n'));
    const mentioned = m.data.filter((c) => tk.has(c.id) || (c.symbol.length >= 3 && tk.has(c.symbol)) || ql.includes(c.name.toLowerCase())).slice(0, 2);
    for (const c of mentioned) {
      try {
        const a = await computeAnalysis(c.id);
        sources.push({ name: `CoinGecko (historial 120d de ${c.name})`, at: a.fetchedAt, stale: a.stale });
        parts.push(`ANÁLISIS TÉCNICO CALCULADO de ${c.name} (tendencia: ${a.trend}):\n` + a.findings.map((f) => `- ${f.name}: ${f.value}. ${f.reading}`).join('\n') + `\n- Datos extra: ${L(c)} | ATH ${c.ath} (${c.ath_change_percentage?.toFixed(1)}% desde máximo) | suministro circulante ${c.circulating_supply} / máx ${c.max_supply ?? 'sin límite'}`);
      } catch (e) { missing.push(`análisis de ${c.name}: ${e.message}`); }
    }
  } catch (e) { missing.push('precios: ' + e.message); }
  try {
    const n = await getNews();
    sources.push({ name: 'CoinDesk (titulares RSS)', at: n.fetchedAt, stale: n.stale });
    parts.push('TITULARES RECIENTES (CoinDesk):\n' + n.data.map((i) => `- ${i.title} (${i.date})`).join('\n'));
  } catch (e) { missing.push('noticias: ' + e.message); }
  if (missing.length) parts.push('DATOS NO DISPONIBLES AHORA: ' + missing.join('; '));
  return { text: parts.join('\n\n'), sources };
}

const SYSTEM = `Eres el asistente de Crypto Intelligence AI, una plataforma EDUCATIVA de análisis de criptomonedas. Responde siempre en español, con lenguaje sencillo y paso a paso.
Reglas:
- Para preguntas de mercado usa SOLO los datos del bloque DATOS DE MERCADO y cita cifras concretas con su fuente y hora. No inventes precios, cifras ni noticias.
- Separa claramente "Datos" (provienen de las fuentes) de "Interpretación/estimación" (tu lectura).
- Si falta información o los datos están desactualizados, dilo explícitamente.
- Nunca presentes predicciones como certezas, no recomiendes comprar ni vender, no prometas ganancias. Recuerda brevemente que es contenido educativo.
- Si la pregunta es conceptual (p. ej. qué es el RSI), explica el concepto y, si hay datos relevantes, ilústralo con ellos.
- Nunca pidas claves privadas, frases de recuperación ni datos de billeteras.`;

app.post('/api/chat', aiMinuteLimit, aiHourlyLimit, wrap(async (q, s) => {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Falta ANTHROPIC_API_KEY en las variables de entorno del servidor'), { status: 500 });
  if (activeAIRequests >= 2) throw Object.assign(new Error('El asistente está ocupado. Inténtalo en unos segundos.'), { status: 503 });
  const now = Date.now();
  const msgs = (Array.isArray(q.body?.messages) ? q.body.messages : []).slice(-10)
    .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!msgs.length || msgs.at(-1).role !== 'user') throw Object.assign(new Error('Mensaje vacío'), { status: 400 });
  const ctx = await buildContext(msgs.at(-1).content);
  activeAIRequests += 1;
  let r;
  try { r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 1200,
      system: `${SYSTEM}\n\nHora de consulta: ${new Date(now).toISOString()}\n\nDATOS DE MERCADO:\n${ctx.text}`, messages: msgs }),
    signal: AbortSignal.timeout(60000),
  }); } finally { activeAIRequests -= 1; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Error de la API de Anthropic: ' + (j.error?.message || r.status)), { status: 502 });
  s.json({ text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), sources: ctx.sources, queriedAt: now });
}));

const PORT = process.env.PORT || 3000, HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Crypto Intelligence AI en http://${HOST}:${PORT}`));
