// api/market.js — Finnhub proxy
// Vereist: FINNHUB_API_KEY als Vercel environment variable

const FH = 'https://finnhub.io/api/v1';

const ENDPOINTS = {
  quote:        sym  => `${FH}/quote?symbol=${enc(sym)}`,
  stock_candle: p    => `${FH}/stock/candle?symbol=${enc(p.symbol)}&resolution=${p.resolution}&from=${p.from}&to=${p.to}`,
  forex_candle: p    => `${FH}/forex/candle?symbol=${enc(p.symbol)}&resolution=${p.resolution}&from=${p.from}&to=${p.to}`,
  crypto_candle:p    => `${FH}/crypto/candle?symbol=${enc(p.symbol)}&resolution=${p.resolution}&from=${p.from}&to=${p.to}`,
  search:       q    => `${FH}/search?q=${enc(q)}`,
};

const enc = s => encodeURIComponent(s);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FINNHUB_API_KEY niet ingesteld' });

  const { endpoint, symbol, resolution, from, to, q } = req.query;

  try {
    let url;

    if (endpoint === 'quote') {
      url = ENDPOINTS.quote(symbol);
    } else if (endpoint === 'stock_candle') {
      url = ENDPOINTS.stock_candle({ symbol, resolution, from, to });
    } else if (endpoint === 'forex_candle') {
      url = ENDPOINTS.forex_candle({ symbol, resolution, from, to });
    } else if (endpoint === 'crypto_candle') {
      url = ENDPOINTS.crypto_candle({ symbol, resolution, from, to });
    } else if (endpoint === 'search') {
      url = ENDPOINTS.search(q);
    } else {
      return res.status(400).json({ error: `Onbekend endpoint: ${endpoint}` });
    }

    // Voeg API key toe
    url += `&token=${apiKey}`;

    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'DeBrief/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) throw new Error(`Finnhub ${upstream.status}`);
    const data = await upstream.json();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[market]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
