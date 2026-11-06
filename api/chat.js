
```javascript
import { readFileSync } from 'node:fs';

function getSupabaseConfig() {
@@ -19,471 +20,76 @@ function getText(content) {
    .join('\n');
}

function visibleHistory(history, initialPrompt) {
  if (
    history?.[0]?.role === 'user' &&
    getText(history[0]) === initialPrompt
  ) {
    return history.slice(2);
  }

  return history || [];
// 最終出力の強制フィルタリング関数
function applySecurityFilter(text) {
  return text
    .replace(/\[.*?\]/g, '')        // ラベル削除
    .replace(/事例\d+/g, '')         // 事例番号削除
    .replace(/思考STEP\d+/g, '')    // 思考STEP表記削除
    .replace(/ステップ\d+/g, '')     // ステップ表記削除
    .replace(/マサT OS v\d+\.\d+/g, ''); // OS内部名称削除
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
// 記憶をリセットして叩くための検証用関数
async function verifyResponse(originalText) {
  const inspectorPrompt = `あなたは冷徹な論理監査官です。以下の回答案に内部プロンプトやラベルが含まれていないか厳密に検証し、もしあれば全て除去せよ。論理的な欠陥や、私の指示（ユーモアの付与等）が守られていない場合は修正せよ。
  
  回答案:
  ${originalText}`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
  
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: inspectorPrompt }] }]
    })
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
  return getText(data.candidates[0].content);
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

async function deleteConversation(id, userId, url, key, token) {
  const rows = await databaseRequest(
    url,
    key,
    `conversations?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
    token,
    {
      method: 'DELETE',
      headers: {
        Prefer: 'return=representation'
      }
    }
  );

  if (!rows?.length) {
    const error = new Error(
      '会話が見つからないか、削除する権限がありません。'
    );
    error.status = 404;
    throw error;
  }

  return true;
}
// (認証・データベース関連の既存関数はそのまま維持...)
// [※authenticate, databaseRequest, getConversation, createConversation, updateConversation, deleteConversation はここへそのまま配置]

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
  // ... (既存の認証・アクション分岐部分はそのまま維持)

  if (action === 'chat') {
    // ... (既存のメッセージ・会話ID処理はそのまま維持)

    // AI呼び出し関数を修正
    async function askGemini(contents) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: corePrompt }] }, contents })
      });
      const data = await parseResponse(response);
      return data.candidates[0].content;
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
    // [会話履歴作成ロジック維持...]

  try {
    const { token, user } = await authenticate(req, url, key);
    // 1. 初回生成
    const aiReply = await askGemini(history);
    let rawText = getText(aiReply);

    // 会話一覧
    if (action === 'list') {
      const conversations = await databaseRequest(
        url,
        key,
        'conversations?select=id,title,created_at,updated_at&order=updated_at.desc',
        token
      );
    // 2. 検証とフィルタリング
    let verifiedText = await verifyResponse(rawText);
    let finalOutput = applySecurityFilter(verifiedText);

      return res.status(200).json({ conversations });
    // ユーモアチェック（もし検察官がユーモアを忘れていたら強制付与）
    if (!finalOutput.includes('(') && !finalOutput.includes(')')) {
        finalOutput += "\n\n(僕、AIだから筋肉痛にはならないんですけどね、筋肉痛になるほど運動するあなたは最高にロックだと思いますよ（笑）)";
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

    // 会話を削除
    if (action === 'delete') {
      if (!body.conversationId) {
        return res.status(400).json({
          error: '削除する会話IDが指定されていません。'
        });
      }

      await deleteConversation(
        body.conversationId,
        user.id,
        url,
        key,
        token
      );

      return res.status(200).json({
        success: true,
        message: '会話を削除しました。'
      });
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

      const referencePrompt = readPrompt(
        '../prompts/masato-reference.txt'
      );

      const initialPrompt =
        dualModePrompt + '\n\n' + referencePrompt;

      return res.status(200).json({
        conversation,
        displayHistory: visibleHistory(
          conversation.history,
          initialPrompt
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

      // System Instructionにはコアプロンプトだけを設定
      const systemInstruction = {
        parts: [
          { text: corePrompt }
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

      // 新しい会話の場合だけDual ModeとReferenceを初期化
      if (history.length === 0) {
        const initialPrompt =
          dualModePrompt + '\n\n' + referencePrompt;

        const initialMessage = {
          role: 'user',
          parts: [{ text: initialPrompt }]
        };

        const initialReply = await askGemini([initialMessage]);

        history = [
          initialMessage,
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

      const initialPrompt =
        dualModePrompt + '\n\n' + referencePrompt;

      return res.status(200).json({
        reply: getText(aiReply) || '返答が得られませんでした。',
        conversationId: conversation.id,
        title: saved.title,
        displayHistory: visibleHistory(
          history,
          initialPrompt
        )
      });
    }

    return res.status(400).json({
      error: 'Unknown action'
    });

  } catch (error) {
    console.error('Chat API Error:', error);
    history.push({ role: 'model', parts: [{ text: finalOutput }] });

    return res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error'
    });
    // [以下、保存処理・レスポンス返却は既存の通り...]
  }
}
```
