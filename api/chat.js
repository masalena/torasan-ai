
import { readFileSync } from 'node:fs';

function getSupabaseConfig() {
  return {
    url: process.env.SUPABASE_URL?.replace(/\/$/, ''),
    key: process.env.SUPABASE_PUBLISHABLE_KEY
  };
}

function readPrompt(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function getText(content) {
  return (content?.parts || [])
    .filter(part => part.text)
    .map(part => part.text)
    .join('\n');
}

function visibleHistory(history, dualModePrompt) {
  if (
    history?.[0]?.role === 'user' &&
    getText(history[0]) === dualModePrompt
  ) {
    return history.slice(2);
  }

  return history || [];
}

async function parseResponse(response) {
  const raw = await response.text();

  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(
      `応答を読み取れませんでした: ${raw.slice(0, 300)}`
    );
  }
}

async function authenticate(req, url, key) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    const error = new Error('ログインが必要です。');
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`
    }
  });

  const user = await parseResponse(response);

  if (!response.ok || !user?.id) {
    const error = new Error(
      'ログインの有効期限が切れています。再ログインしてください。'
    );
    error.status = 401;
    throw error;
  }

  return { token, user };
}

async function databaseRequest(url, key, path, token, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error_description ||
      data?.hint ||
      'データベースへのアクセスに失敗しました。'
    );
  }

  return data;
}

async function getConversation(id, url, key, token) {
  const rows = await databaseRequest(
    url,
    key,
    `conversations?id=eq.${encodeURIComponent(id)}&select=*`,
    token
  );

  if (!rows?.length) {
    const error = new Error(
      '会話が見つからないか、アクセスできません。'
    );
    error.status = 404;
    throw error;
  }

  return rows[0];
}

async function createConversation(userId, url, key, token) {
  const rows = await databaseRequest(
    url,
    key,
    'conversations?select=*',
    token,
    {
      method: 'POST',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        user_id: userId,
        title: '新しい会話',
        history: []
      })
    }
  );

  if (!rows?.length) {
    throw new Error('新しい会話を作成できませんでした。');
  }

  return rows[0];
}

async function updateConversation(
  id,
  url,
  key,
  token,
  history,
  title
) {
  const rows = await databaseRequest(
    url,
    key,
    `conversations?id=eq.${encodeURIComponent(id)}&select=id,title`,
    token,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        history,
        title,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!rows?.length) {
    throw new Error('会話履歴を保存できませんでした。');
  }

  return rows[0];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const body = req.body || {};
  const action = body.action || 'chat';
  const { url, key } = getSupabaseConfig();

  // ブラウザに渡すSupabaseの公開情報
  if (action === 'config') {
    if (!url || !key) {
      return res.status(500).json({
        error: 'Supabaseの環境変数が設定されていません。',
        diagnostics: {
          supabaseUrlConfigured: Boolean(url),
          supabaseKeyConfigured: Boolean(key)
        }
      });
    }

    return res.status(200).json({
      supabaseUrl: url,
      supabaseKey: key,
      supabaseUrlConfigured: true,
      supabaseKeyConfigured: true
    });
  }

  if (!url || !key) {
    return res.status(500).json({
      error: 'Supabaseの環境変数が設定されていません。',
      diagnostics: {
        supabaseUrlConfigured: Boolean(url),
        supabaseKeyConfigured: Boolean(key)
      }
    });
  }

  try {
    const { token, user } = await authenticate(req, url, key);

    // 会話一覧
    if (action === 'list') {
      const conversations = await databaseRequest(
        url,
        key,
        'conversations?select=id,title,created_at,updated_at&order=updated_at.desc',
        token
      );

      return res.status(200).json({ conversations });
    }

    // 新しい会話を作成
    if (action === 'new') {
      const conversation = await createConversation(
        user.id,
        url,
        key,
        token
      );

      return res.status(200).json({ conversation });
    }

    // 過去の会話を読み込む
    if (action === 'load') {
      if (!body.conversationId) {
        return res.status(400).json({
          error: '会話IDが指定されていません。'
        });
      }

      const conversation = await getConversation(
        body.conversationId,
        url,
        key,
        token
      );

      const dualModePrompt = readPrompt(
        '../prompts/masato-dual-mode.txt'
      );

      return res.status(200).json({
        conversation,
        displayHistory: visibleHistory(
          conversation.history,
          dualModePrompt
        )
      });
    }

    // Geminiとの会話
    if (action === 'chat') {
      const message = body.message;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({
          error: 'Message is required'
        });
      }

      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({
          error: 'Gemini API key is not configured.'
        });
      }

      let conversation;

      if (body.conversationId) {
        conversation = await getConversation(
          body.conversationId,
          url,
          key,
          token
        );
      } else {
        conversation = await createConversation(
          user.id,
          url,
          key,
          token
        );
      }

      const corePrompt = readPrompt(
        '../prompts/masato-core.txt'
      );

      const referencePrompt = readPrompt(
        '../prompts/masato-reference.txt'
      );

      const dualModePrompt = readPrompt(
        '../prompts/masato-dual-mode.txt'
      );

      const systemInstruction = {
        parts: [
          { text: corePrompt },
          { text: referencePrompt }
        ]
      };

      async function askGemini(contents) {
        const apiUrl =
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            systemInstruction,
            contents
          })
        });

        const data = await parseResponse(response);

        if (!response.ok) {
          throw new Error(
            data?.error?.message || 'Google API Error'
          );
        }

        const candidate = data.candidates?.[0];

        if (!candidate?.content?.parts) {
          throw new Error(
            'Geminiから有効な返答がありませんでした。'
          );
        }

        return candidate.content;
      }

      let history = Array.isArray(conversation.history)
        ? conversation.history
        : [];

      // 新しい会話の場合だけDual Modeを初期化
      if (history.length === 0) {
        const dualMessage = {
          role: 'user',
          parts: [{ text: dualModePrompt }]
        };

        const initialReply = await askGemini([dualMessage]);

        history = [
          dualMessage,
          initialReply
        ];
      }

      history.push({
        role: 'user',
        parts: [{ text: message }]
      });

      const aiReply = await askGemini(history);

      history.push(aiReply);

      let title = conversation.title;

      if (!title || title === '新しい会話') {
        title = message.replace(/\s+/g, ' ').slice(0, 40);

        if (message.length > 40) {
          title += '…';
        }
      }

      const saved = await updateConversation(
        conversation.id,
        url,
        key,
        token,
        history,
        title
      );

      return res.status(200).json({
        reply: getText(aiReply) || '返答が得られませんでした。',
        conversationId: conversation.id,
        title: saved.title,
        displayHistory: visibleHistory(
          history,
          dualModePrompt
        )
      });
    }

    return res.status(400).json({
      error: 'Unknown action'
    });

  } catch (error) {
    console.error('Chat API Error:', error);

    return res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error'
    });
  }
}
