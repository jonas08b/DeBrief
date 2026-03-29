/**
 * DeStem — GET /api/destem
 *
 * Geeft de metadata van de meest recente briefing terug:
 *   { date, audioUrl, script, generatedAt }
 *
 * audioUrl wijst naar /api/destem-audio?date=YYYY-MM-DD (proxy)
 * zodat de browser nooit rechtstreeks van de Blob-URL laadt.
 * Dit vermijdt CORS- en mixed-content problemen.
 *
 * Fallback: als vandaag nog geen briefing beschikbaar is, geeft het de
 * briefing van gisteren terug (indien beschikbaar).
 *
 * Query params:
 *   ?date=YYYY-MM-DD   — vraag een specifieke dag op (optioneel)
 */

async function fetchMeta(dateStr) {
  const storeUrl = process.env.BLOB_STORE_URL;
  if (!storeUrl) {
    throw new Error('BLOB_STORE_URL omgevingsvariabele ontbreekt');
  }

  const url = `${storeUrl.replace(/\/$/, '')}/destem/${dateStr}.json`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Vervang de directe Blob-audioUrl door de interne proxy URL.
 * De browser stuurt dan een request naar /api/destem-audio die
 * de bytes fetcht vanuit Blob en doorstuurt met correcte headers.
 */
function withProxyAudio(meta) {
  if (!meta) return meta;
  return {
    ...meta,
    audioUrl: `/api/destem-audio?date=${meta.date}`,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      return res.status(200).json(withProxyAudio(meta));
    }

    const meta = (await fetchMeta(todayStr)) || (await fetchMeta(yestStr));
    if (!meta) {
      return res.status(404).json({ error: 'Nog geen briefing beschikbaar. Kom later terug.' });
    }

    // Cache 15 minuten aan de rand
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(withProxyAudio(meta));
  } catch (err) {
    console.error('[DeStem get]', err);
    return res.status(500).json({ error: err.message });
  }
}
