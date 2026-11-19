import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

// =====================================================
// 検証用デモのAPI(ログインなし・履歴なし)
// 合言葉(DEMO_ACCESS_CODE)を確認して、1回の質問に1回だけ答える。
// Supabase(自分用のデータ)には、一切つながらない。
// 自分用の画面で使っているプロンプトのファイルを、そのまま読み込む。
// =====================================================

// ----- デモの固定設定(ここを変えると、デモ全体が変わる)-----
const MODEL_ID = 'gemini-3.8-flash';
const THINKING_LEVEL = 'low';
const MAX_MESSAGE_LENGTH = 4000;

// true: 回答の項目名(急所、利益など)を隠す。false: そのまま見せる。
const HIDE_LABELS = true;

// 英語で聞かれたら英語で答えるための一文。OSありの側のシステム指示の末尾にだけ足す。
const LANGUAGE_RULE =
  "Reply in the same language as the user's latest message.";

// OSありの側の質問の末尾に足す、言語の指示。
// システム指示や履歴が日本語でも、最後に読む質問の末尾に置くことで、言語が引っ張られにくくする。
const USER_LANGUAGE_SUFFIX =
  '\n\n(Write your entire answer in the same language as the question above, ' +
  'including all headings and labels. ' +
  'If the question is in English, answer fully in English.)';

// 自分用の画面では、最初のメッセージ(追加プロトコル)に対するAIの返事が、会話の履歴に入っている。
// デモでは、その返事を毎回もらい直すのをやめて、この固定の返事を履歴に入れる。
// そのため、質問1回につき、AIの呼び出しは1回だけになる。
// 自分用の会話の一番最初のAIの返事に近い文章に、書き換えてもよい。
const SETUP_REPLY = 'Understood.';

function readPrompt(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function getText(content) {
  return (content?.parts || [])
    .filter(part => part.text)
    .map(part => part.text)
    .join('\n');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 合言葉の比較(文字数の違いからも、手がかりが漏れないようにする)
function safeEqual(a, b) {
  const hashA = createHash('sha256').update(String(a)).digest();
  const hashB = createHash('sha256').update(String(b)).digest();

  return timingSafeEqual(hashA, hashB);
}

// ===== 画面用の整形 開始 =====
// 画面に出す回答だけを整える。保存する履歴は変えない。
// 次のどちらの形でもない回答(会話モードなど)は、見出しと項目名には触らない。
//   A. 見出しが3つ以上ある形(●冷徹解剖…、【Step 0：…】…)
//   B. 「・項目名：」だけの行が2つ以上ある形(最後に「まとめ」「結論」の見出しがあるか、
//      項目名らしい言葉(LABEL_HINTS)を含む場合)

// 最初の見出し(または最初の項目名の位置)をこの名前にする。
// 途中の見出しは消し(中身は1つにまとまる)、最後の見出しは FINAL_HEADING にする。
const HEADINGS_JA = { checkpoint: '●チェックポイント', final: '●まとめ' };
const HEADINGS_EN = { checkpoint: '●Checkpoints', final: '●Summary' };

// 質問に日本語(ひらがな・カタカナ・漢字)が含まれるか。含まれなければ、英語の見出しにする。
const JAPANESE_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

// チェックポイントの部分で、行頭にあれば取り除く【】のタグ(見出しとは扱わない)
const BRACKET_TAGS = ['根', '幹', '枝', '事実', '推論'];

// 項目名の前に付く記号(・ • ･ · ● など)
const BULLET_CHARS = '・･•·●○◦‣∙▪\\-*';
const BULLET_RE = new RegExp(`^\\s*[${BULLET_CHARS}]\\s*`);

// B の形で、最後の見出しとみなす言葉
const FINAL_WORDS = /まとめ|結論|summary|conclusion|bottom line/i;

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
function tidyHeadedAnswer(lines, headings, names) {
  const first = headings[0];
  const last = headings[headings.length - 1];
  const middle = new Set(headings.slice(1, -1));
  const result = [];
  let promoteIndented = false;

  lines.forEach((line, index) => {
    if (index === first) {
      result.push(names.checkpoint);
      return;
    }

    if (middle.has(index)) {
      return;
    }

    if (index === last) {
      result.push(names.final);
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
function tidyLabelBlocks(lines, names) {
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
        result.push(names.final);
        return;
      }

      if (index === headingAt) {
        result.push(names.final);
      }

      result.push(line);
      return;
    }

    if (LABEL_ONLY_PATTERN.test(line)) {
      if (index === first) {
        result.push(names.checkpoint);
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

function tidyAnswer(text, isJapanese) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  const names = isJapanese ? HEADINGS_JA : HEADINGS_EN;
  const lines = removeCaseNumbers(text).split('\n');
  const headings = [];

  lines.forEach((line, index) => {
    if (isHeadingLine(line)) {
      headings.push(index);
    }
  });

  if (headings.length >= 3) {
    return tidyHeadedAnswer(lines, headings, names);
  }

  const labelBlocks = tidyLabelBlocks(lines, names);

  return labelBlocks !== null ? labelBlocks : lines.join('\n');
}
// ===== 画面用の整形 終了 =====

// ----- Gemini の呼び出し -----
async function callGemini({ systemText, contents }) {
  const body = {
    contents,
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: THINKING_LEVEL
      }
    }
  };

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const startedAt = performance.now();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    }
  );

  const raw = await response.text();
  const elapsedMs = Math.round(performance.now() - startedAt);
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error('The model API returned an unreadable response.');
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || 'The model API returned an error.');
  }

  const candidate = data?.candidates?.[0];

  if (!candidate?.content?.parts) {
    throw new Error('The model returned no answer.');
  }

  return {
    content: candidate.content,
    usage: data.usageMetadata || {},
    modelVersion: data.modelVersion || null,
    elapsedMs
  };
}

function summarizeCall(label, result) {
  const number = value => (Number.isFinite(value) ? value : 0);
  const usage = result.usage || {};

  return {
    call: label,
    inputTokens: number(usage.promptTokenCount),
    cachedInputTokens: number(usage.cachedContentTokenCount),
    outputTokens: number(usage.candidatesTokenCount),
    thinkingTokens: number(usage.thoughtsTokenCount),
    totalTokens: number(usage.totalTokenCount),
    timeMs: result.elapsedMs
  };
}

function sumCalls(calls) {
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    timeMs: 0
  };

  for (const call of calls) {
    for (const key of Object.keys(totals)) {
      totals[key] += call[key];
    }
  }

  return totals;
}

// ----- 受け付け口 -----
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const expectedCode = process.env.DEMO_ACCESS_CODE;

  if (!expectedCode || !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'The demo is not configured yet.' });
  }

  const body = req.body || {};

  if (!safeEqual(body.code || '', expectedCode)) {
    // 合言葉を機械的に試されるのを遅くする
    await sleep(1000);
    return res.status(401).json({ error: 'Invalid access code.' });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!message) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `The question is too long (limit: ${MAX_MESSAGE_LENGTH} characters).`
    });
  }

  const useOS = body.useOS !== false;

  // OSなしの側に送る質問(何も足さない)
  const userMessage = { role: 'user', parts: [{ text: message }] };

  // OSありの側に送る質問(末尾に、言語をそろえる指示を足す)
  const osUserMessage = {
    role: 'user',
    parts: [{ text: message + USER_LANGUAGE_SUFFIX }]
  };

  try {
    const calls = [];
    let answer;

    if (useOS) {
      const corePrompt = readPrompt('../prompts/masato-core.txt');
      const referencePrompt = readPrompt('../prompts/masato-reference.txt');
      const dualModePrompt = readPrompt('../prompts/masato-dual-mode.txt');

      const systemText = corePrompt + '\n\n' + LANGUAGE_RULE;

      // 自分用の画面と同じ並び: 最初に追加プロトコル、AIの返事、そのあとに質問
      const initialMessage = {
        role: 'user',
        parts: [{ text: dualModePrompt + '\n\n' + referencePrompt }]
      };

      // AIの返事は、毎回もらい直さず、固定の返事を入れる(呼び出しを1回にするため)
      const setupReply = { role: 'model', parts: [{ text: SETUP_REPLY }] };

      answer = await callGemini({
        systemText,
        contents: [initialMessage, setupReply, osUserMessage]
      });

      calls.push(summarizeCall('answer', answer));
    } else {
      answer = await callGemini({
        systemText: null,
        contents: [userMessage]
      });

      calls.push(summarizeCall('answer', answer));
    }

    const rawText = getText(answer.content);
    const reply = useOS && HIDE_LABELS
      ? tidyAnswer(rawText, JAPANESE_RE.test(message))
      : rawText;

    return res.status(200).json({
      mode: useOS ? 'with_os' : 'baseline',
      reply: reply || 'No answer was returned.',
      metrics: {
        model: MODEL_ID,
        modelVersion: answer.modelVersion,
        thinkingLevel: THINKING_LEVEL.toUpperCase(),
        calls,
        totals: sumCalls(calls),
        systemInstructionAddendum: useOS ? LANGUAGE_RULE : null
      }
    });
  } catch (error) {
    // 質問や回答の中身は記録しない
    console.error('Demo API Error:', error.message);

    return res.status(500).json({
      error: error.message || 'Internal Server Error.'
    });
  }
}
