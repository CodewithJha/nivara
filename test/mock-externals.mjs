// Record-time stand-in for Gemma, SerpApi, ElevenLabs, and Backboard. No live keys.
const real = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const chat = (content) => json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.includes(':11434')) {
    if (url.includes('/api/show')) return json({ capabilities: ['completion'] });
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    const text = (body.messages ?? []).map(m => m.content).join('\n');
    if (text.includes('Extract a customer order')) return chat('{"customer":"Rahul","items":[{"product":"Chocolate Protein Bar","quantity":3},{"product":"Shaker Bottle 700ml","quantity":1}],"delivery_text":"tomorrow"}');
    if (text.includes('Pick exactly one tool')) return chat('{"tool":"get_pending_orders","args":{}}');
    if (text.includes('what matters most today')) return chat('Deliver the overdue orders and restock what is running out.');
    return chat('Noted.');
  }
  if (url.includes('serpapi.com')) return json({ shopping_results: [{ title: 'Whey Protein 1kg Chocolate', source: 'Amazon.in', extracted_price: 1650, link: 'https://www.amazon.in/dp/123' }] });
  if (url.includes('api.elevenlabs.io')) {
    if (url.includes('/v1/user')) return json({ subscription: {} });
    if (url.includes('/speech-to-text')) return json({ text: 'what should I restock' });
    if (url.includes('/text-to-speech')) return new Response(Uint8Array.from([0xff, 0xfb, 0x90, 0x64]), { headers: { 'content-type': 'audio/mpeg' } });
    return json({ error: 'unmocked elevenlabs url' }, 404);
  }
  if (url.includes('app.backboard.io')) {
    if (url.endsWith('/api/assistants') && method === 'POST') return json({ assistant_id: 'asst-test' });
    if (url.endsWith('/memories/search')) return json({ memories: [{ id: 'm0', content: 'Prefer suppliers within 5 days' }], total_count: 1 });
    if (url.endsWith('/memories') && method === 'POST') return json({ id: 'mem-1' }, 201);
    if (url.endsWith('/memories')) return json({ memories: [{ id: 'm0', content: 'Prefer suppliers within 5 days' }], total_count: 1 });
    return json({ error: 'unmocked backboard url' }, 404);
  }
  return real(input, init);
};
