// api/market.js — Vercel proxy voor Yahoo Finance
// Geen API key nodig — Yahoo Finance is gratis

const YF_BASE = 'https://query1.finance.yahoo.com';
const YF_BASE2 = 'https://query2.finance.yahoo.com';

// Cookie + crumb cache (per serverless instantie)
let _cookie = null;
let _crumb  = null;
let _cookieTs = 0;
const COOKIE_TTL = 25 * 60 * 1000; // 25 min (Yahoo cookies verlopen ~30 min)

async function getCookieAndCrumb() {
  if (_cookie && _crumb && Date.now() - _cookieTs < COOKIE_TTL) {
    return { cookie: _cookie, crumb: _crumb };
  }

  // Stap 1: haal cookie op via consent pagina
  const consentRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    redirect: 'follow',
  });
  const cookieHeader = consentRes.headers.get('set-cookie') || '';
  const cookieMatch  = cookieHeader.match(/A1=([^;]+)/);
  const a1Cookie     = cookieMatch ? `A1=${cookieMatch[1]}` : '';

  // Stap 2: haal crumb op
  const crumbRes = await fetch(`${YF_BASE2}/v1/test/getcrumb`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Cookie': a1Cookie,
    },
  });
  const crumb = (await crumbRes.text()).trim();

  if (crumb && crumb !== 'null' && !crumb.includes('<')) {
    _cookie   = a1Cookie;
    _crumb    = crumb;
    _cookieTs = Date.now();
    return { cookie: _cookie, crumb: _crumb };
  }

  // Fallback: probeer zonder crumb (werkt voor chart endpoint)
  return { cookie: a1Cookie, crumb: '' };
}

async function yfFetch(url, cookie) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Cookie': cookie || '',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  try {
    const { cookie, crumb } = await getCookieAndCrumb();
    let data;

    if (endpoint === 'quote') {
      // Batch quotes: symbols=EURUSD=X,GC=F,...
      const url = `${YF_BASE2}/v7/finance/quote?symbols=${encodeURIComponent(params.symbols)}&crumb=${encodeURIComponent(crumb)}&formatted=false&lang=en-US`;
      const raw = await yfFetch(url, cookie);
      // Geef enkel de quote array terug
      data = raw?.quoteResponse?.result || [];

    } else if (endpoint === 'chart') {
      // Chart: historische data
      const sym = params.symbol;
      let url;
      if (params.range === 'custom') {
        url = `${YF_BASE2}/v8/finance/chart/${encodeURIComponent(sym)}?period1=${params.period1}&period2=${params.period2}&interval=${params.interval}&events=div,splits`;
      } else {
        url = `${YF_BASE2}/v8/finance/chart/${encodeURIComponent(sym)}?range=${params.range}&interval=${params.interval}&events=div,splits`;
      }
      data = await yfFetch(url, cookie);

    } else if (endpoint === 'search') {
      // Ticker zoeken
      const url = `${YF_BASE2}/v1/finance/search?q=${encodeURIComponent(params.q)}&quotesCount=6&newsCount=0&enableFuzzyQuery=false`;
      data = await yfFetch(url, cookie);

    } else {
      return res.status(400).json({ error: `Onbekend endpoint: ${endpoint}` });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
