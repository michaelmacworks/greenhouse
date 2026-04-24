function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function extractOutputText(data) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const texts = [];
  output.forEach(item => {
    if (item?.type !== 'message' || !Array.isArray(item.content)) return;
    item.content.forEach(content => {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text);
      }
    });
  });
  return texts.join('\n').trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ai' && request.method === 'POST') {
      if (!env.OPENAI_API_KEY) {
        return json({ error: { message: 'Missing OPENAI_API_KEY secret in Cloudflare.' } }, 500);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: { message: 'Invalid JSON request body.' } }, 400);
      }

      const {
        model = 'gpt-4.1-mini',
        system = '',
        userPrompt = '',
        storyContext = '',
        responseFormat,
      } = payload || {};

      if (!userPrompt.trim()) {
        return json({ error: { message: 'Missing user prompt.' } }, 400);
      }

      const requestBody = {
        model,
        input: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Story context (confidential — do not quote unless asked):\n${storyContext}\n\n---\n\nRequest: ${userPrompt}`,
          },
        ],
        max_output_tokens: responseFormat?.type === 'json_schema' ? 2200 : 1200,
        text: responseFormat ? { format: responseFormat } : { format: { type: 'text' } },
      };

      const openAiRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await openAiRes.json().catch(() => ({}));
      if (!openAiRes.ok) {
        return json({ error: { message: data?.error?.message || `OpenAI API error ${openAiRes.status}` } }, openAiRes.status);
      }

      return json({ text: extractOutputText(data) });
    }

    return env.ASSETS.fetch(request);
  },
};
