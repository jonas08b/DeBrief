export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  // Herprobeert automatisch bij 429 met de Retry-After header van Groq
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(req.body),
      });

      if (response.status === 429 && attempt < MAX_RETRIES) {
        // Respecteer Retry-After indien aanwezig, anders exponentieel wachten
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter
          ? Math.min(parseFloat(retryAfter) * 1000, 10000)
          : Math.min(1000 * 2 ** (attempt - 1), 8000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        return res.status(500).json({ error: err.message });
      }
      // Netwerk-fout: kort wachten en opnieuw proberen
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  return res.status(429).json({ error: 'Groq rate limit — probeer later opnieuw' });
}
