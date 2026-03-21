// api/market.js — Vercel serverless proxy voor Twelve Data
// Voeg TWELVE_DATA_API_KEY toe als Vercel environment variable

const TWELVE_BASE = 'https://api.twelvedata.com';

// Toegestane endpoints (whitelist voor veiligheid)
const ALLOWED_ENDPOINTS = ['quote', 'time_series', 'symbol_search'];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  if (!endpoint || !ALLOWED_ENDPOINTS.includes(endpoint)) {
    return res.status(400).json({ status: 'error', message: 'Ongeldig endpoint' });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ status: 'error', message: 'API key niet geconfigureerd' });
  }

  try {
    const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const url = `${TWELVE_BASE}/${endpoint}?${qs}`;

    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'DeBrief/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'error',
        message: `Upstream fout: ${upstream.status}`,
      });
    }

    const data = await upstream.json();

    // Cache 15 min op Vercel Edge voor quota besparing
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
