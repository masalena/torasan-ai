export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key is not configured in Vercel' });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    
    const googleResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: message }]
          }
        ]
      })
    });

    const data = await googleResponse.json();

    if (!googleResponse.ok) {
      return res.status(googleResponse.status).json({ error: data.error?.message || 'Google API Error' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '返答が得られませんでした。';
    return res.status(200).json({ reply });

  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
