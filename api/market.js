// api/market.js — DeBrief Markt proxy v8
//
// EUR/USD  → frankfurter.app        (gratis, geen key)
// XAU/USD  → gold-api.com           (gratis, geen key)
// Euro Stoxx 50 → Yahoo Finance (^STOXX50E) (gratis, geen key)
// US10Y    → FRED API (DGS10)       (gratis, key vereist)
// Aandelen/ETFs → Finnhub           (gratis, key vereist, 60/min)
// Search   → Finnhub                (gratis, key vereist, 60/min)
//
// Cache-strategie:
//   Vercel Edge Cache-Control → CDN cached per endpoint+symbol (5 min)
//   In-memory stale-while-revalidate → bij fout stale data teruggeven (60 min)

const FRED_KEY    = process.env.FRED_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// ── In-memory cache (stale-while-revalidate) ──────────────────────────────────
const CACHE     = {};
const FRESH_TTL = 5  * 60 * 1000;
const STALE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const e = CACHE[key];
  if (!e) return { fresh: null, stale: null };
  const age = Date.now() - e.ts;
  if (age > STALE_TTL) { delete CACHE[key]; return { fresh: null, stale: null }; }
  if (age > FRESH_TTL) return { fresh: null, stale: e.data };
  return { fresh: e.data, stale: e.data };
}
function cacheSet(key, data) {
  CACHE[key] = { data, ts: Date.now() };
  return data;
}
async function cached(key, fn) {
  const { fresh, stale } = cacheGet(key);
  if (fresh) return fresh;
  try {
    const data = await fn();
    return cacheSet(key, data);
  } catch (err) {
    if (stale) {
      console.warn(`[market] Stale data voor ${key}: ${err.message}`);
      return { ...stale, stale: true };
    }
    throw err;
  }
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  return res.json();
}

// Yahoo Finance helper — stuurt de juiste User-Agent mee
async function fetchYahoo(url) {
  return fetchJSON(url, {
    'User-Agent': 'Mozilla/5.0 (compatible; DeBrief/1.0)',
    'Accept': 'application/json',
  });
}

// ── Quotes ────────────────────────────────────────────────────────────────────

async function quoteEURUSD() {
  return cached('q_eurusd', async () => {
    const cur = await fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD');
    const price = cur.rates?.USD;
    if (!price) throw new Error('Geen EUR/USD data');
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    let prevClose = price;
    try {
      const prev = await fetchJSON(`https://api.frankfurter.app/${yDate.toISOString().split('T')[0]}?from=EUR&to=USD`);
      prevClose = prev.rates?.USD || price;
    } catch {}
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

async function quoteXAUUSD() {
  return cached('q_xauusd', async () => {
    const data = await fetchJSON('https://api.gold-api.com/price/XAU');
    const price = data.price;
    if (!price) throw new Error('Geen XAU data');
    const prev = data.prev_close_price || price;
    return { c: price, pc: prev, dp: ((price - prev) / prev) * 100 };
  });
}

// Euro Stoxx 50 via Yahoo Finance ^STOXX50E — gratis, geen key, betrouwbaar serverside
async function quoteSX5E() {
  return cached('q_sx5e', async () => {
    const data = await fetchYahoo(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ESTOXX50E?interval=1d&range=5d'
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) throw new Error('Geen Euro Stoxx 50 data van Yahoo Finance');
    const price     = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

// US10Y via FRED — gebruik altijd sort_order=desc + limit zodat we nooit
// afhankelijk zijn van een vaste startdatum. DGS10 is een business-day serie:
// weekends en feestdagen ontbreken, dus observation_start kan 0 resultaten geven.
async function quoteUS10Y() {
  return cached('q_us10y', async () => {
    if (!FRED_KEY) throw new Error('FRED_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=10`
    );
    const obs = data.observations?.filter(o => o.value !== '.');
    if (!obs?.length) throw new Error('Geen US10Y data');
    const price     = parseFloat(obs[0].value);
    const prevClose = parseFloat(obs[1]?.value ?? obs[0].value);
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

// Finnhub quote: werkt voor aandelen en ETFs (JPM, URTH, BNO, AAPL, ...)
async function quoteFinnhub(symbol) {
  return cached(`q_fh_${symbol}`, async () => {
    if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    // Finnhub geeft { c: current, pc: prev close, d: change, dp: change% }
    if (!data?.c) throw new Error(`Geen Finnhub data voor ${symbol}`);
    return { c: data.c, pc: data.pc, dp: data.dp };
  });
}

// ── PCT ───────────────────────────────────────────────────────────────────────

function periodToUnix(period) {
  // Ruime marges zodat we altijd voldoende business days hebben
  const daysMap = { '1day': 7, '1month': 40, '6month': 190, '1year': 375 };
  const days    = daysMap[period] ?? 40;
  const from    = Math.floor((Date.now() - days * 86400000) / 1000);
  const to      = Math.floor(Date.now() / 1000);
  return { from, to };
}

function periodToStartDate(period) {
  const { from } = periodToUnix(period);
  return new Date(from * 1000).toISOString().split('T')[0];
}

// Hoeveel FRED-observaties ophalen per periode (ruim genoeg voor business days)
function fredLimitForPeriod(period) {
  const map = { '1day': 10, '1month': 35, '6month': 140, '1year': 270 };
  return map[period] ?? 35;
}

async function pctEURUSD(period) {
  return cached(`pct_eurusd_${period}`, async () => {
    const startDate = periodToStartDate(period);
    const data = await fetchJSON(`https://api.frankfurter.app/${startDate}..?from=EUR&to=USD`);
    const entries = Object.entries(data.rates || {}).sort(([a],[b]) => a.localeCompare(b));
    if (entries.length < 2) return { dp: null };
    const first = entries[0][1].USD;
    const last  = entries[entries.length - 1][1].USD;
    return { dp: ((last - first) / first) * 100 };
  });
}

// Goud pct via Yahoo Finance (GC=F = Gold futures front-month)
async function pctXAUUSD(period) {
  return cached(`pct_xauusd_${period}`, async () => {
    const { from, to } = periodToUnix(period);
    const data = await fetchYahoo(
      `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&period1=${from}&period2=${to}`
    );
    return pctFromYahooChart(data);
  });
}

// Euro Stoxx 50 pct via Yahoo Finance historische data
async function pctSX5E(period) {
  return cached(`pct_sx5e_${period}`, async () => {
    const { from, to } = periodToUnix(period);
    const data = await fetchYahoo(
      `https://query1.finance.yahoo.com/v8/finance/chart/%5ESTOXX50E?interval=1d&period1=${from}&period2=${to}`
    );
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
    if (!closes || closes.length < 2) return { dp: null };
    const first = closes[0];
    const last  = closes[closes.length - 1];
    return { dp: ((last - first) / first) * 100 };
  });
}

// US10Y pct — gebruik limit+desc en draai de array om zodat eerste vs laatste
// altijd correct is, ongeacht weekends of feestdagen aan de randen.
async function pctUS10Y(period) {
  return cached(`pct_us10y_${period}`, async () => {
    if (!FRED_KEY) return { dp: null };
    const limit = fredLimitForPeriod(period);
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`
    );
    // desc → nieuwste eerst; omdraaien voor oudste-eerste vergelijking
    const obs = (data.observations || []).filter(o => o.value !== '.').reverse();
    if (obs.length < 2) return { dp: null };
    const first = parseFloat(obs[0].value);
    const last  = parseFloat(obs[obs.length - 1].value);
    return { dp: ((last - first) / first) * 100 };
  });
}

// Universele pct via Yahoo Finance — werkt voor stocks en ETFs (JPM, BNO, URTH, ...)
async function pctFinnhub(symbol, period) {
  return cached(`pct_yf_${symbol}_${period}`, async () => {
    const { from, to } = periodToUnix(period);
    const data = await fetchYahoo(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${from}&period2=${to}`
    );
    return pctFromYahooChart(data);
  });
}

// Herbruikbare helper: extraheert eerste-vs-laatste close uit Yahoo Finance v8 response
function pctFromYahooChart(data) {
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null);
  if (!closes || closes.length < 2) return { dp: null };
  const first = closes[0];
  const last  = closes[closes.length - 1];
  return { dp: ((last - first) / first) * 100 };
}

// ── Symbol search via Finnhub ─────────────────────────────────────────────────
async function searchSymbols(q) {
  return cached(`search_${q.toLowerCase()}`, async () => {
    if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    );
    const hits = (data?.result || []).slice(0, 8).map(m => ({
      symbol:    m.displaySymbol || m.symbol,
      full_name: m.symbol,
      name:      m.description,
      exchange:  m.type,
      type:      m.type?.toLowerCase(),
    }));
    return { hits };
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { endpoint, symbol, period } = req.query;

  // Interne symboolmapping — BNO (Brent) vervangt USO (WTI) voor Europese olieprijzen
  const FINNHUB_MAP = {
    JPM:  'JPM',
    URTH: 'URTH',
    BNO:  'BNO',
    AAPL: 'AAPL',
  };

  try {
    let data;

    if (endpoint === 'quote') {
      switch (symbol) {
        case 'EURUSD': data = await quoteEURUSD(); break;
        case 'XAUUSD': data = await quoteXAUUSD(); break;
        case 'SX5E':   data = await quoteSX5E();   break;
        case 'US10Y':  data = await quoteUS10Y();  break;
        default: {
          const fhSym = FINNHUB_MAP[symbol] || symbol;
          data = await quoteFinnhub(fhSym);
          break;
        }
      }
    } else if (endpoint === 'pct') {
      const p = period || '1month';
      switch (symbol) {
        case 'EURUSD': data = await pctEURUSD(p);  break;
        case 'XAUUSD': data = await pctXAUUSD(p);  break;
        case 'SX5E':   data = await pctSX5E(p);    break;
        case 'US10Y':  data = await pctUS10Y(p);   break;
        default: {
          const fhSym = FINNHUB_MAP[symbol] || symbol;
          data = await pctFinnhub(fhSym, p);
          break;
        }
      }
    } else if (endpoint === 'search') {
      const q = req.query.q || '';
      if (!q.trim()) throw new Error('Zoekterm ontbreekt');
      data = await searchSymbols(q.trim());
    } else {
      throw new Error(`Onbekend endpoint: ${endpoint}`);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: err.message });
  }
}
