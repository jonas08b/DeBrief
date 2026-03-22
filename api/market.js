// api/market.js — Vercel serverless proxy voor Twelve Data
// Vereist: TWELVE_DATA_API_KEY als Vercel environment variable

const TWELVE_BASE = 'https://api.twelvedata.com';

const ALLOWED_ENDPOINTS = new Set([
  'quote',
  'time_series',
  'symbol_search',
  'price',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ status: 'error', message: `Ongeldig endpoint: ${endpoint}` });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ status: 'error', message: 'API key niet geconfigureerd op server' });
  }

  try {
    const qs  = new URLSearchParams({ ...params, apikey: apiKey }).toString();
    const url = `${TWELVE_BASE}/${endpoint}?${qs}`;

    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'DeBrief/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    const data = await upstream.json();

    // Twelve Data geeft altijd 200 terug, ook bij fouten — controleer body
    if (data.status === 'error' || data.code === 400 || data.code === 401 || data.code === 429) {
      return res.status(200).json({
        status: 'error',
        message: data.message || `Twelve Data fout (code ${data.code})`,
      });
    }

    // Cache 15 min op Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
