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

// Google Gemini APIの有料ティア料金(USD / 100万トークン)。
// Gemini 3.8 Flashは2027-01-01から料金が変わるため、回答時点の料金を保存する。
function getModelPricing(modelId, date = new Date()) {
  if (modelId === 'gemini-3.1-flash-lite') {
    return { input: 0.25, output: 1.50 };
  }

  if (modelId === 'gemini-3.8-flash') {
    const changeDate = new Date('2027-01-01T00:00:00Z');
    return date < changeDate
      ? { input: 0.75, output: 3.75 }
      : { input: 1.50, output: 7.50 };
  }

  return null;
}

// 出力トークン数は、通常の回答トークン + 思考トークン。
// thoughtsTokenCount が省略された場合は、totalTokenCount - promptTokenCount
// から推定し、それもなければ通常の回答トークン数を使う。
function getBilledOutputTokenCount(meta = {}) {
  if (Number.isFinite(meta.billedOutputTokenCount)) {
    return Math.max(0, meta.billedOutputTokenCount);
  }

  if (
    Number.isFinite(meta.totalTokenCount) &&
    Number.isFinite(meta.promptTokenCount)
  ) {
    return Math.max(0, meta.totalTokenCount - meta.promptTokenCount);
  }

  if (
    Number.isFinite(meta.candidatesTokenCount) &&
    Number.isFinite(meta.thoughtsTokenCount)
  ) {
    return Math.max(0, meta.candidatesTokenCount + meta.thoughtsTokenCount);
  }

  if (Number.isFinite(meta.candidatesTokenCount)) {
    return Math.max(0, meta.candidatesTokenCount);
  }

  return null;
}

function estimateCostUsd(modelId, usage, savedPricing = null) {
  const inputTokens = usage?.promptTokenCount;
  const outputTokens = getBilledOutputTokenCount(usage);
  const pricing = savedPricing || getModelPricing(modelId);

  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(pricing?.input) ||
    !Number.isFinite(pricing?.output)
  ) {
    return null;
  }

  return Number((
    inputTokens * pricing.input / 1_000_000 +
    outputTokens * pricing.output / 1_000_000
  ).toFixed(8));
}

function getConversationMetrics(history) {
  const replies = visibleHistory(history).filter(item =>
    item?.role === 'model' && !item.appMetadata?.hidden
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let responseTimeMs = 0;
  let estimatedCostUsd = 0;
  let inputKnown = false;
  let outputKnown = false;
  let responseTimeKnown = false;
  let costKnownCount = 0;

  for (const reply of replies) {
    const meta = reply.appMetadata || {};

    if (Number.isFinite(meta.promptTokenCount)) {
      inputTokens += meta.promptTokenCount;
      inputKnown = true;
    }

    const billedOutputTokens = getBilledOutputTokenCount(meta);
    if (Number.isFinite(billedOutputTokens)) {
      outputTokens += billedOutputTokens;
      outputKnown = true;
    }

    if (Number.isFinite(meta.elapsedMs)) {
      responseTimeMs += meta.elapsedMs;
      responseTimeKnown = true;
    }

    // 以前の履歴に費用が保存されていない場合も、回答時に保存した料金で再計算する。
    const answerCost = Number.isFinite(meta.estimatedCostUsd)
      ? meta.estimatedCostUsd
      : estimateCostUsd(meta.modelId, meta, meta.pricing);

    if (Number.isFinite(answerCost)) {
      estimatedCostUsd += answerCost;
      costKnownCount += 1;
    }
  }

  return {
    responseCount: replies.length,
    inputTokenCount: inputKnown ? inputTokens : null,
    outputTokenCount: outputKnown ? outputTokens : null,
    responseTimeMs: responseTimeKnown ? responseTimeMs : null,
    estimatedCostUsd: costKnownCount > 0 ? Number(estimatedCostUsd.toFixed(8)) : null,
    costKnownCount
  };
}

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
// 次のどちらの形でもない回答(会話モードなど)は、見出しと項目名には触らない。
//   A. 見出しが3つ以上ある形(●冷徹解剖…、【Step 0：…】…)
//   B. 「・項目名：」だけの行が2つ以上ある形(最後に「まとめ」「結論」の見出しがあるか、
//      項目名らしい言葉(LABEL_HINTS)を含む場合)

// 最初の見出し(または最初の項目名の位置)をこの名前にする。
// 途中の見出しは消し(中身は1つにまとまる)、最後の見出しは FINAL_HEADING にする。
const CHECKPOINT_HEADING = '●チェックポイント';
const FINAL_HEADING = '●まとめ';

// チェックポイントの部分で、行頭にあれば取り除く【】のタグ(見出しとは扱わない)
const BRACKET_TAGS = ['根', '幹', '枝', '事実', '推論'];

// 項目名の前に付く記号(・ • ･ · ● など)
const BULLET_CHARS = '・･•·●○◦‣∙▪\\-*';
const BULLET_RE = new RegExp(`^\\s*[${BULLET_CHARS}]\\s*`);

// B の形で、最後の見出しとみなす言葉
const FINAL_WORDS = /まとめ|結論/;

// B の形で、最後に見出しがない回答は、項目名にこれらの言葉が含まれるときだけ対象にする
// (普通の回答の「・メリット：」などを巻き込まないため)。足りない言葉があれば、ここに足す。
const LABEL_HINTS =
  /急所|利益|置換|すり替え|捏造|射程|事実と推論|現状|弱さ|恐怖|引き受け|形から入る|プライド|承認/;

// 「事例013」のような番号(すべての回答で、その一文を消す)
const CASE_PATTERN = /事例\s*[0-9０-９]+/;

// 「Step 3」「ステップ2」のような番号(チェックポイントの部分だけで、その一文を消す)
const STEP_PATTERN = /(?:STEP|Step|step|ステップ)\s*[0-9０-９]+/;

// 記号 + 項目名(30文字以内、句読点なし) + コロン
const LABEL_PATTERN = new RegExp(
  `^(\\s*[${BULLET_CHARS}]\\s*)\\*{0,2}[^：:。、，,.\\n*]{1,30}\\*{0,2}[：:]\\*{0,2}\\s*`
);

// 上の形で、コロンの後ろに何もない行(内容は次の行にある)
const LABEL_ONLY_PATTERN = new RegExp(
  `^\\s*[${BULLET_CHARS}]\\s*\\*{0,2}[^：:。、，,.\\n*]{1,30}\\*{0,2}[：:]\\*{0,2}\\s*$`
);

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

  const bulletMatch = line.match(BULLET_RE);
  const sentences = line.match(/[^。]*。|[^。]+$/g) || [line];
  let kept = sentences.filter(s => !pattern.test(s)).join('');

  if (!kept.trim()) {
    return null;
  }

  if (bulletMatch && !BULLET_RE.test(kept)) {
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
function stripLabel(line) {
  if (BRACKET_TAGS.length > 0) {
    const tagPattern = new RegExp(
      `^(\\s*(?:[${BULLET_CHARS}]\\s*)?)【(?:${BRACKET_TAGS.join('|')})】\\s*`
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

// A の形: 見出しが3つ以上ある回答
function tidyHeadedAnswer(lines, headings) {
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
        /^[\s　]+\S/.test(current) && !BULLET_RE.test(current);

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

// B の形: 「・項目名：」だけの行が2つ以上ある回答。
// 項目名の行を消して、内容の行を箇条書きにする。最初の項目名の位置に、チェックポイントの見出しを入れる。
// 最後に「まとめ」「結論」の見出しがあれば FINAL_HEADING にし、なければ、項目の部分が終わったあとの文章の前に入れる。
// 該当しなければ null を返す。
function tidyLabelBlocks(lines) {
  let finalIndex = -1;

  lines.forEach((line, index) => {
    if (isHeadingLine(line) && FINAL_WORDS.test(line)) {
      finalIndex = index;
    }
  });

  const limit = finalIndex >= 0 ? finalIndex : lines.length;
  const labelIndexes = [];

  lines.forEach((line, index) => {
    if (index < limit && LABEL_ONLY_PATTERN.test(line)) {
      labelIndexes.push(index);
    }
  });

  if (labelIndexes.length < 2) {
    return null;
  }

  // 最後の見出しがない回答は、項目名らしい言葉を含むときだけ対象にする
  if (
    finalIndex < 0 &&
    !labelIndexes.some(index => LABEL_HINTS.test(lines[index]))
  ) {
    return null;
  }

  const first = labelIndexes[0];
  let regionEnd = finalIndex;
  let headingAt = finalIndex;

  if (finalIndex < 0) {
    // 最後の項目名の内容(次の空行まで)が、項目の部分の終わり
    regionEnd = labelIndexes[labelIndexes.length - 1] + 1;

    while (regionEnd < lines.length && lines[regionEnd].trim() !== '') {
      regionEnd += 1;
    }

    headingAt = regionEnd;

    while (headingAt < lines.length && lines[headingAt].trim() === '') {
      headingAt += 1;
    }

    if (headingAt >= lines.length) {
      headingAt = -1;
    }
  }

  const result = [];
  let pendingBullet = false;

  lines.forEach((line, index) => {
    if (index < first) {
      result.push(line);
      return;
    }

    if (index >= regionEnd) {
      if (index === finalIndex) {
        result.push(FINAL_HEADING);
        return;
      }

      if (index === headingAt) {
        result.push(FINAL_HEADING);
      }

      result.push(line);
      return;
    }

    if (LABEL_ONLY_PATTERN.test(line)) {
      if (index === first) {
        result.push(CHECKPOINT_HEADING);
      }

      pendingBullet = true;
      return;
    }

    const cleaned = stripLabel(line);

    if (cleaned === null) {
      pendingBullet = true;
      return;
    }

    const current = dropMatchingSentences(cleaned, STEP_PATTERN);

    if (current === null) {
      return;
    }

    if (!current.trim()) {
      result.push(current);
      return;
    }

    if (BULLET_RE.test(current)) {
      pendingBullet = false;
      result.push(current);
      return;
    }

    if (pendingBullet) {
      pendingBullet = false;
      result.push('・' + current.trim());
      return;
    }

    result.push(current);
  });

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

  if (headings.length >= 3) {
    return tidyHeadedAnswer(lines, headings);
  }

  const labelBlocks = tidyLabelBlocks(lines);

  return labelBlocks !== null ? labelBlocks : lines.join('\n');
}

// 画面に返す履歴(AIの回答だけ整える。保存されている履歴は変わらない)
function toDisplayHistory(history) {
  return visibleHistory(history).map(item => {
    if (item?.role !== 'model') {
      return item;
    }

    const meta = item.appMetadata || {};
    const billedOutputTokens = getBilledOutputTokenCount(meta);
    const displayMetadata = Number.isFinite(billedOutputTokens)
      ? {
          ...meta,
          candidatesTokenCount: Number.isFinite(meta.candidatesTokenCount)
            ? meta.candidatesTokenCount
            : billedOutputTokens,
          thoughtsTokenCount: Number.isFinite(meta.thoughtsTokenCount)
            ? meta.thoughtsTokenCount
            : Math.max(
                0,
                billedOutputTokens - (
                  Number.isFinite(meta.candidatesTokenCount)
                    ? meta.candidatesTokenCount
                    : billedOutputTokens
                )
              ),
          billedOutputTokenCount: billedOutputTokens
        }
      : meta;

    return {
      ...item,
      appMetadata: displayMetadata,
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
        displayHistory: toDisplayHistory(storedHistory),
        conversationMetrics: getConversationMetrics(storedHistory)
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

      // System Instructionにはコアプロンプトと回答言語ルールを設定
      // 追加プロトコルなどの初期化メッセージではなく、ユーザーの最初の通常の質問を基準にする。
      const languageInstruction = `
回答言語のルール:
- この会話でユーザーが最初に送った通常の質問・発言の言語を、基本の回答言語にする。
- 最初の発言が日本語なら日本語、英語なら英語、中国語なら中国語というように、その言語で自然に回答する。
- 最初の発言が複数の言語を含む場合は、主に使われている言語を選ぶ。
- 会話中は、ユーザーが明示的に別の言語で回答するよう求めない限り、基本の回答言語を維持する。
- ユーザーが特定の質問だけ別の言語で回答するよう求めた場合は、その依頼に限って指定言語に切り替える。以後も変更するよう明示された場合は、新しい言語を基本の回答言語にする。
- 引用、翻訳、語学学習など、ユーザーが別の言語の文章を扱っている場合は、その依頼内容に従う。
- 回答言語以外の真人OSの方針、思考方法、回答形式、一貫性に関するルールは変更しない。
`;
      const systemInstruction = {
        parts: [
          { text: corePrompt },
          { text: languageInstruction }
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
      const promptTokenCount = Number.isFinite(usage.promptTokenCount)
        ? usage.promptTokenCount
        : null;
      const candidatesTokenCount = Number.isFinite(usage.candidatesTokenCount)
        ? usage.candidatesTokenCount
        : null;
      const totalTokenCount = Number.isFinite(usage.totalTokenCount)
        ? usage.totalTokenCount
        : null;

      // thoughtsTokenCount はAPI応答で省略される場合がある。
      // totalTokenCount があれば差分から補い、なければ0として通常出力分を表示する。
      const thoughtsTokenCount = Number.isFinite(usage.thoughtsTokenCount)
        ? usage.thoughtsTokenCount
        : (
            Number.isFinite(totalTokenCount) &&
            Number.isFinite(promptTokenCount) &&
            Number.isFinite(candidatesTokenCount)
              ? Math.max(0, totalTokenCount - promptTokenCount - candidatesTokenCount)
              : 0
          );

      const billedOutputTokenCount = Number.isFinite(candidatesTokenCount)
        ? candidatesTokenCount + thoughtsTokenCount
        : (
            Number.isFinite(totalTokenCount) && Number.isFinite(promptTokenCount)
              ? Math.max(0, totalTokenCount - promptTokenCount)
              : null
          );

      // 回答ごとの測定値と実際に使ったモデル設定を保存
      aiReply.appMetadata = {
        elapsedMs: answerResult.elapsedMs,
        modelId,
        modelVersion: answerResult.modelVersion,
        thinkingLevel,
        promptTokenCount,
        candidatesTokenCount: Number.isFinite(candidatesTokenCount)
          ? candidatesTokenCount
          : billedOutputTokenCount,
        thoughtsTokenCount,
        billedOutputTokenCount,
        totalTokenCount,
        estimatedCostUsd: estimateCostUsd(modelId, {
          promptTokenCount,
          candidatesTokenCount: Number.isFinite(candidatesTokenCount)
            ? candidatesTokenCount
            : billedOutputTokenCount,
          thoughtsTokenCount,
          billedOutputTokenCount
        }),
        pricing: getModelPricing(modelId)
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
        displayHistory: toDisplayHistory(history),
        conversationMetrics: getConversationMetrics(history)
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
