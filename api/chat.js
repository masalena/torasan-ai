
import { readFileSync } from 'node:fs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'API key is not configured in Vercel'
    });
  }

  const { message, history = [] } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      error: 'Message is required'
    });
  }

  try {
    // 3つのプロンプトファイルを読み込む
    const corePrompt = readFileSync(
      new URL('../prompts/masato-core.txt', import.meta.url),
      'utf8'
    );

    const referencePrompt = readFileSync(
      new URL('../prompts/masato-reference.txt', import.meta.url),
      'utf8'
    );

    const dualModePrompt = readFileSync(
      new URL('../prompts/masato-dual-mode.txt', import.meta.url),
      'utf8'
    );

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    // 基本プロンプトと重要定義・思考事例を常に読み込ませる
    const systemInstruction = {
      parts: [
        { text: corePrompt },
        { text: referencePrompt }
      ]
    };

    // Gemini APIに送信する共通処理
    async function askGemini(contents) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction,
          contents
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error?.message || 'Google API Error'
        );
      }

      const candidate = data.candidates?.[0];

      if (!candidate?.content?.parts) {
        throw new Error('Geminiから有効な返答がありませんでした。');
      }

      return candidate.content;
    }

    // 新しい会話の場合だけDual Modeを最初に読み込む
    let conversation = Array.isArray(history)
      ? history
      : [];

    if (conversation.length === 0) {
      const dualMessage = {
        role: 'user',
        parts: [{ text: dualModePrompt }]
      };

      // 初期応答は画面に表示せず、会話履歴にだけ保存
      const initialReply = await askGemini([dualMessage]);

      conversation = [
        dualMessage,
        initialReply
      ];
    }

    // ユーザーの質問を追加
    conversation.push({
      role: 'user',
      parts: [{ text: message }]
    });

    // 通常の会話を実行
    const aiReply = await askGemini(conversation);

    // AIの返答も履歴に保存
    conversation.push(aiReply);

    const reply = aiReply.parts
      .filter(part => part.text)
      .map(part => part.text)
      .join('\n') || '返答が得られませんでした。';

    return res.status(200).json({
      reply,
      history: conversation
    });

  } catch (error) {
    console.error('Chat API Error:', error);

    return res.status(500).json({
      error: error.message || 'Internal Server Error'
    });
  }
}
