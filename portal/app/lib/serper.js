const SERPER_API_URL = 'https://google.serper.dev/search';

export function serperConfigured() {
  return Boolean(process.env.SERPER_API_KEY);
}

export async function serperSearch(query, num = 5) {
  const r = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num }),
  });
  if (!r.ok) throw new Error(`Serper API error ${r.status}`);
  const data = await r.json();
  return (data.organic || []).map(item => ({
    title:   item.title   || '',
    link:    item.link    || '',
    snippet: item.snippet || '',
  }));
}
