/**
 * DeStem — GET /api/destem
 *
 * Geeft de metadata van de meest recente briefing terug:
 *   { date, audioUrl, script, generatedAt }
 *
 * Fallback: als vandaag nog geen briefing beschikbaar is, geeft het de
 * briefing van gisteren terug (indien beschikbaar).
 *
 * Query params:
 *   ?date=YYYY-MM-DD   — vraag een specifieke dag op (optioneel)
 */

import { head } from '@vercel/blob';

async function fetchMeta(dateStr) {
  // Bouw de Blob-URL op basis van de bekende patroon
  // We gebruiken head() om te controleren of het bestand bestaat,
  // en fetch() om de JSON-inhoud op te halen.
  const blobBase = process.env.BLOB_READ_WRITE_TOKEN
    ? null // token aanwezig → gebruik @vercel/blob head
    : null;

  // Alternatief: haal de JSON direct op via de publieke Blob-URL
  // (werkt zolang de Blob-store publiek is)
  const storeUrl = process.env.BLOB_STORE_URL; // bijv. https://abc123.public.blob.vercel-storage.com
  if (!storeUrl) {
    throw new Error('BLOB_STORE_URL omgevingsvariabele ontbreekt');
  }

  const url = `${storeUrl.replace(/\/$/, '')}/destem/${dateStr}.json`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return await res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Specifieke datum opvragen (optioneel)
  const requestedDate = req.query?.date;

  const today     = new Date();
  const todayStr  = today.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yestStr   = yesterday.toISOString().slice(0, 10);

  try {
    if (requestedDate) {
      const meta = await fetchMeta(requestedDate);
      if (!meta) return res.status(404).json({ error: `Geen briefing voor ${requestedDate}` });
      return res.status(200).json(meta);
    }

    // Probeer vandaag, dan gisteren
    const meta = (await fetchMeta(todayStr)) || (await fetchMeta(yestStr));
    if (!meta) {
      return res.status(404).json({ error: 'Nog geen briefing beschikbaar. Kom later terug.' });
    }

    // Cache 15 minuten aan de rand
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(meta);
  } catch (err) {
    console.error('[DeStem get]', err);
    return res.status(500).json({ error: err.message });
  }
}
