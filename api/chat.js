import { readFileSync } from 'node:fs';

function getSupabaseConfig() {
  return {
    url: process.env.SUPABASE_URL?.replace(/\/$/, ''),
    key: process.env.SUPABASE_PUBLISHABLE_KEY
  };
}

const MODEL_OPTIONS = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH']
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    thinkingLevels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']
  }
];

const DEFAULT_MODEL_ID = 'gemini-3.8-flash';
const DEFAULT_THINKING_LEVEL = 'LOW';

function getModelSettings(modelId, thinkingLevel) {
  const selectedModel =
    MODEL_OPTIONS.find(model => model.id === modelId) ||
    MODEL_OPTIONS.find(model => model.id === DEFAULT_MODEL_ID);

  const requestedLevel = String(
    thinkingLevel || DEFAULT_THINKING_LEVEL
  ).toUpperCase();

  if (!selectedModel.thinkingLevels.includes(requestedLevel)) {
    const error = new Error(
      `${selectedModel.label}では思考設定「${requestedLevel}」を利用できません。`
    );
    error.status = 400;
    throw error;
  }

  return {
    modelId: selectedModel.id,
    thinkingLevel: requestedLevel
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

// 画面に出さない最初の2件(追加プロトコルと、それに対するAIの返事)の判定。
// 新しい会話では、この2件に appMetadata.hidden の印が付く。
// 印のない古い会話は、最初のメッセージがとても長い場合(追加プロトコルと同じ)も、隠す。
// プロンプトのファイルを直しても、文章が一致するかどうかには左右されない。
const INITIAL_PROMPT_MIN_LENGTH = 1500;

function hasInitialPair(history) {
  const first = history?.[0];
  const second = history?.[1];

  if (first?.role !== 'user' || second?.role !== 'model') {
    return false;
  }

  if (first.appMetadata?.hidden === true) {
    return true;
  }

  return getText(first).length >= INITIAL_PROMPT_MIN_LENGTH;
}

function visibleHistory(history) {
  const list = Array.isArray(history) ? history : [];

  return hasInitialPair(list) ? list.slice(2) : list;
}

// ===== 画面用の整形 開始 =====
// 画面に出す回答だけを整える。保存する履歴は変えない。
// 見出しが3つ未満の回答(会話モードなど)は、見出しと項目名には触らない。

// 最初の見出し(●冷徹解剖、【Step 0：…】など)をこの名前にする。
// 途中の見出しは消し(中身は1つにまとまる)、最後の見出しは FINAL_HEADING にする。
const CHECKPOINT_HEADING = '●チェックポイント';
const FINAL_HEADING = '●まとめ';

// チェックポイントの部分で、行頭にあれば取り除く【】のタグ(見出しとは扱わない)
const BRACKET_TAGS = ['根', '幹', '枝', '事実', '推論'];

// 「事例013」のような番号(すべての回答で、その一文を消す)
const CASE_PATTERN = /事例\s*[0-9０-９]+/;

// 「Step 3」「ステップ2」のような番号(チェックポイントの部分だけで、その一文を消す)
const STEP_PATTERN = /(?:STEP|Step|step|ステップ)\s*[0-9０-９]+/;

// 見出し:
//   「●」で始まる短い1行(30文字以内、コロンや句点なし)
//   または、1行まるごと【】で囲まれた短い行(BRACKET_TAGS のタグを除く)
function isHeadingLine(line) {
  const text = line.trim();

  if (/^●[^：:。\n]{1,30}$/.test(text)) {
    return true;
  }

  const bracket = text.match(/^【([^】\n]{1,40})】$/);

  return Boolean(bracket) && !BRACKET_TAGS.includes(bracket[1].trim());
}

// 1行の中から、パターンを含む一文を消す。中身が残らなければ null(行ごと消す)
function dropMatchingSentences(line, pattern) {
  if (!pattern.test(line)) {
    return line;
  }

  const bulletMatch = line.match(/^\s*[・\-*●]\s*/);
  const sentences = line.match(/[^。]*。|[^。]+$/g) || [line];
  let kept = sentences.filter(s => !pattern.test(s)).join('');

  if (!kept.trim()) {
    return null;
  }

  if (bulletMatch && !/^\s*[・\-*●]/.test(kept)) {
    kept = bulletMatch[0] + kept.trimStart();
  }

  return kept;
}

function removeCaseNumbers(text) {
  const result = [];

  for (const line of text.split('\n')) {
    const kept = dropMatchingSentences(line, CASE_PATTERN);

    if (kept !== null) {
      result.push(kept);
    }
  }

  return result.join('\n');
}

// 行頭の「項目名：」や【タグ】を取り除く。中身が残らない行は null(行ごと消す)
const LABEL_PATTERN =
  /^(\s*[・\-*]\s*)\*{0,2}[^：:。、，,.\n*]{1,20}\*{0,2}[：:]\*{0,2}\s*/;

function stripLabel(line) {
  if (BRACKET_TAGS.length > 0) {
    const tagPattern = new RegExp(
      `^(\\s*(?:[・\\-*]\\s*)?)【(?:${BRACKET_TAGS.join('|')})】\\s*`
    );
    const tagMatch = line.match(tagPattern);

    if (tagMatch) {
      const rest = line.slice(tagMatch[0].length);
      return rest.trim() ? tagMatch[1] + rest : null;
    }
  }

  const labelMatch = line.match(LABEL_PATTERN);

  if (labelMatch) {
    const rest = line.slice(labelMatch[0].length);
    return rest.trim() ? labelMatch[1] + rest : null;
  }

  return line;
}

function tidyAnswer(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  const lines = removeCaseNumbers(text).split('\n');
  const headings = [];

  lines.forEach((line, index) => {
    if (isHeadingLine(line)) {
      headings.push(index);
    }
  });

  if (headings.length < 3) {
    return lines.join('\n');
  }

  const first = headings[0];
  const last = headings[headings.length - 1];
  const middle = new Set(headings.slice(1, -1));
  const result = [];
  let promoteIndented = false;

  lines.forEach((line, index) => {
    if (index === first) {
      result.push(CHECKPOINT_HEADING);
      return;
    }

    if (middle.has(index)) {
      return;
    }

    if (index === last) {
      result.push(FINAL_HEADING);
      return;
    }

    if (index > first && index < last) {
      const cleaned = stripLabel(line);

      // 項目名だけの行が消えたら、その下の字下げの行は、箇条書きにそろえる
      if (cleaned === null) {
        promoteIndented = true;
        return;
      }

      const current = dropMatchingSentences(cleaned, STEP_PATTERN);

      if (current === null) {
        return;
      }

      const isIndented =
        /^[\s　]+\S/.test(current) && !/^\s*[・\-*]/.test(current);

      if (isIndented && (promoteIndented || current !== line)) {
        result.push('・' + current.trim());
        return;
      }

      if (!isIndented) {
        promoteIndented = false;
      }

      result.push(current);
      return;
    }

    result.push(line);
  });

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 画面に返す履歴(AIの回答だけ整える。保存されている履歴は変わらない)
function toDisplayHistory(history) {
  return visibleHistory(history).map(item => {
    if (item?.role !== 'model') {
      return item;
    }

    return {
      ...item,
      parts: (item.parts || []).map(part =>
        typeof part.text === 'string'
          ? { ...part, text: tidyAnswer(part.text) }
          : part
      )
    };
  });
}
// ===== 画面用の整形 終了 =====

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

async function renameConversation(id, userId, title, url, key, token) {
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 80) : '';

  if (!cleanTitle) {
    const error = new Error('タイトルを入力してください。');
    error.status = 400;
    throw error;
  }

  const rows = await databaseRequest(
    url,
    key,
    `conversations?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id,title`,
    token,
    {
      method: 'PATCH',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        title: cleanTitle,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!rows?.length) {
    const error = new Error(
      '会話が見つからないか、名前を変更する権限がありません。'
    );
    error.status = 404;
    throw error;
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

  // ブラウザに渡すSupabaseの公開情報とモデル選択肢
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
      supabaseKeyConfigured: true,
      modelOptions: MODEL_OPTIONS,
      defaultModelId: DEFAULT_MODEL_ID,
      defaultThinkingLevel: DEFAULT_THINKING_LEVEL
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

    // 会話タイトルを変更
    if (action === 'rename') {
      if (!body.conversationId) {
        return res.status(400).json({
          error: '名前を変更する会話IDが指定されていません。'
        });
      }

      const conversation = await renameConversation(
        body.conversationId,
        user.id,
        body.title,
        url,
        key,
        token
      );

      return res.status(200).json({
        success: true,
        conversation
      });
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

      // 履歴の全文(追加プロトコルを含む)は、ブラウザに返さない
      const { history: storedHistory, ...conversationInfo } = conversation;

      return res.status(200).json({
        conversation: conversationInfo,
        displayHistory: toDisplayHistory(storedHistory)
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

      // ブラウザから届いたモデル名・思考設定を許可リストで検証
      const { modelId, thinkingLevel } = getModelSettings(
        body.modelId,
        body.thinkingLevel
      );

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
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${process.env.GEMINI_API_KEY}`;

        // アプリ独自の記録情報(appMetadata)はGemini APIへ送らない
        const apiContents = contents.map(item => ({
          role: item.role,
          parts: item.parts
        }));

        const startedAt = performance.now();

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            systemInstruction,
            contents: apiContents,
            generationConfig: {
              thinkingConfig: {
                thinkingLevel: thinkingLevel.toLowerCase()
              }
            }
          })
        });

        const data = await parseResponse(response);
        const elapsedMs = Math.round(performance.now() - startedAt);

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

        return {
          content: candidate.content,
          usageMetadata: data.usageMetadata || null,
          modelVersion: data.modelVersion || null,
          elapsedMs
        };
      }

      let history = Array.isArray(conversation.history)
        ? conversation.history
        : [];

      // 新しい会話の場合だけDual ModeとReferenceを初期化
      if (history.length === 0) {
        const initialPrompt =
          dualModePrompt + '\n\n' + referencePrompt;

        // hidden の印を付けて、画面には出さない
        // (appMetadata は askGemini の中で取り除かれるので、Geminiへ届く内容は変わらない)
        const initialMessage = {
          role: 'user',
          parts: [{ text: initialPrompt }],
          appMetadata: { hidden: true }
        };

        const initialResult = await askGemini([initialMessage]);
        const initialReply = initialResult.content;
        initialReply.appMetadata = { hidden: true };

        history = [
          initialMessage,
          initialReply
        ];
      }

      history.push({
        role: 'user',
        parts: [{ text: message }]
      });

      const answerResult = await askGemini(history);
      const aiReply = answerResult.content;

      const usage = answerResult.usageMetadata || {};

      // 回答ごとの測定値と実際に使ったモデル設定を保存
      aiReply.appMetadata = {
        elapsedMs: answerResult.elapsedMs,
        modelId,
        modelVersion: answerResult.modelVersion,
        thinkingLevel,
        promptTokenCount: Number.isFinite(usage.promptTokenCount)
          ? usage.promptTokenCount
          : null,
        candidatesTokenCount: Number.isFinite(usage.candidatesTokenCount)
          ? usage.candidatesTokenCount
          : null,
        thoughtsTokenCount: Number.isFinite(usage.thoughtsTokenCount)
          ? usage.thoughtsTokenCount
          : null,
        totalTokenCount: Number.isFinite(usage.totalTokenCount)
          ? usage.totalTokenCount
          : null
      };

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
        reply: tidyAnswer(getText(aiReply)) || '返答が得られませんでした。',
        metrics: aiReply.appMetadata,
        conversationId: conversation.id,
        title: saved.title,
        displayHistory: toDisplayHistory(history)
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
