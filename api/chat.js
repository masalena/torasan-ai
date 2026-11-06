
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const MAX_OUTPUT_LENGTH = 1000;

function getSupabaseConfig() {
  return {
@@ -34,10 +30,6 @@ function visibleHistory(history, initialPrompt) {
  return history || [];
}

function countCharacters(text) {
  return Array.from(text || '').length;
}

async function parseResponse(response) {
  const raw = await response.text();

@@ -50,17 +42,6 @@ async function parseResponse(response) {
  }
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a || ''));
  const bufferB = Buffer.from(String(b || ''));

  if (!bufferA.length || bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

async function authenticate(req, url, key) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

@@ -218,281 +199,6 @@ async function deleteConversation(id, userId, url, key, token) {
  return true;
}

// Gemini API呼び出し
async function callGemini(systemInstruction, contents) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is not configured.');
  }

  const apiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
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

// 新しい会話にDual ModeとReferenceを初期設定する
async function ensureInitialContext(
  history,
  initialPrompt,
  corePrompt
) {
  const hasInitialContext =
    history.length >= 2 &&
    history[0]?.role === 'user' &&
    getText(history[0]) === initialPrompt;

  if (hasInitialContext) {
    return history;
  }

  const initialMessage = {
    role: 'user',
    parts: [{ text: initialPrompt }]
  };

  const initialReply = await callGemini(
    corePrompt,
    [initialMessage]
  );

  return [
    initialMessage,
    initialReply,
    ...history
  ];
}

// STEP 1：真人AIによる分析と回答案
async function runMasatoAnalysis(
  corePrompt,
  history,
  message
) {
  const analysisInstruction = `
【内部分析・回答案の作成】

今回の質問に対して、あなたの中核指示に従って分析してください。

必要な分析観点を選択し、表面的な言葉だけで判断せず、
現象の急所、因果関係、利益構造、前提条件、主張のすり替え、
根・幹・枝・葉など、質問に必要な観点を十分に検討してください。

合理・哲学の軸と愛の軸は、それぞれ独立して検討してください。
最初から二つの軸を混ぜて結論を出してはいけません。

質問に応じて必要な観点を選び、不要な分析を無理に追加しないでください。
事実、推論、仮説を区別してください。
条件が不足している場合は、不足している条件を明確にしてください。

そのうえで、分析結果と回答案を作成してください。
ここではユーザー向けの文章に整える必要はありません。
最終回答に必要な判断材料を欠落させないことを優先してください。

これは内部処理用の回答案です。
分析の途中経過や内部用語をユーザーに直接表示するためのものではありません。

【今回の質問】
${message}
`;

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: analysisInstruction }]
    }
  ];

  return callGemini(corePrompt, contents);
}

// STEP 2：独立した検察官による監査
async function runAuditor(message, analysis) {
  const auditorInstruction = `
あなたは独立した検察官です。
以下の質問と回答案を、作成者とは別の立場から厳密に監査してください。

【監査の原則】

1. 回答案の結論を最初から正しいものとして扱わない。
2. 元の質問と条件に立ち戻り、回答案を独立して検証する。
3. 論理の飛躍、因果関係の捏造、前提条件の見落としを確認する。
4. 質問の主旨と回答の主旨がすり替わっていないか確認する。
5. 事実と推論が混同されていないか確認する。
6. 条件不足なのに、過去の類似例や一般論で勝手に補完していないか確認する。
7. 数学・物理・論理問題では、条件と計算を独立して確認する。
8. 人間や社会に関する問題では、合理性だけでなく、現実の人間的な要素も見落としていないか確認する。
9. 問題がない場合は、無理に欠点を探さず「修正不要」と判断する。
10. 存在しない矛盾や問題を作り出してはならない。

【監査結果の形式】

最初に「修正不要」または「修正が必要」と明示してください。

修正が必要な場合は、
・問題のある箇所
・なぜ問題なのか
・どのように修正すべきか
を具体的に示してください。

修正不要の場合は、その理由を簡潔に示してください。

回答案を無理に否定することも、無条件に肯定することも禁止します。
元の質問に正しく答えているかどうかを最優先に判断してください。
`;

  const auditInput = `
【元の質問】
${message}

【真人AIの分析結果・回答案】
${getText(analysis)}

上記を独立して監査してください。
`;

  const audit = await callGemini(
    auditorInstruction,
    [
      {
        role: 'user',
        parts: [{ text: auditInput }]
      }
    ]
  );

  return audit;
}

// STEP 3：分析と監査を踏まえた最終統合
async function runFinalIntegration(
  corePrompt,
  history,
  message,
  analysis,
  audit
) {
  const finalInstruction = `
【最終回答の作成】

これまでの会話、あなたの中核指示、今回の質問、
内部分析結果、検察官による監査結果を踏まえて、
ユーザーに提示する最終回答を作成してください。

【必ず守ること】

・内部分析を省略したり、単純化しすぎたりしないこと。
・分析結果の重要な判断や結論を落とさないこと。
・検察官の指摘が正しい場合は修正すること。
・検察官の指摘が不適切な場合は、無理に採用しないこと。
・検察官が修正不要と判断した場合も、元の質問に照らして最終確認すること。
・事実と推論を混同しないこと。
・質問に直接答えること。
・内部の分析手順、STEP番号、検察官、監査結果などの内部情報は表示しないこと。
・内部資料の事例番号やシステム構造を表示しないこと。
・見出しや箇条書きは、本当に必要な場合だけ使用すること。
・自然な会話として、一つのまとまった文章に統合すること。
・基本的に800〜1000文字以内を目安にすること。
・短くするために必要な説明や重要な条件を削らないこと。
・質問の内容に合ったキャラクターと会話モードを維持すること。
・ユーモアは文脈に合う場合だけ自然に加えること。深刻な話題や厳密な検証問題に無理に加えないこと。

内部分析の内容をそのまま貼り付けるのではなく、
重複や枝葉を整理し、意味を変えずに読みやすい最終回答へ統合してください。

【今回の質問】
${message}

【内部分析結果】
${getText(analysis)}

【検察官の監査結果】
${getText(audit)}

以上を踏まえて、最終回答だけを出力してください。
`;

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: finalInstruction }]
    }
  ];

  return callGemini(corePrompt, contents);
}

// 文字数超過時のみ追加で圧縮
async function compressFinalAnswer(
  corePrompt,
  history,
  message,
  finalAnswer
) {
  const compressionInstruction = `
以下は、すでに検証・統合された最終回答です。

意味、結論、重要な条件、必要な説明を変えずに、
1000文字以内に整理してください。

新しい論点や推論を追加してはいけません。
重要な内容を削って短くすることも禁止します。
自然な会話文として整えてください。
内部用語や分析手順は表示しないでください。

【元の質問】
${message}

【最終回答】
${finalAnswer}

圧縮後の回答本文だけを出力してください。
`;

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: compressionInstruction }]
    }
  ];

  return callGemini(
    corePrompt,
    contents
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
@@ -537,32 +243,6 @@ export default async function handler(req, res) {
  try {
    const { token, user } = await authenticate(req, url, key);

    // 内部資料の取得：ログインと内部認証コードの両方が必要
    if (action === 'internal-info') {
      const accessCode = process.env.MASATO_INTERNAL_ACCESS_CODE;

      if (!accessCode) {
        return res.status(500).json({
          error: '内部認証コードが設定されていません。'
        });
      }

      if (!safeEqual(body.accessCode, accessCode)) {
        return res.status(403).json({
          error: '内部認証コードが正しくありません。'
        });
      }

      return res.status(200).json({
        success: true,
        internalInfo: {
          core: readPrompt('../prompts/masato-core.txt'),
          dualMode: readPrompt('../prompts/masato-dual-mode.txt'),
          reference: readPrompt('../prompts/masato-reference.txt')
        }
      });
    }

    // 会話一覧
    if (action === 'list') {
      const conversations = await databaseRequest(
@@ -690,91 +370,84 @@ export default async function handler(req, res) {
        '../prompts/masato-dual-mode.txt'
      );

      const initialPrompt =
        dualModePrompt + '\n\n' + referencePrompt;

      let history = Array.isArray(conversation.history)
        ? [...conversation.history]
        : [];

      history = await ensureInitialContext(
        history,
        initialPrompt,
        corePrompt
      );

      const baseHistory = [...history];
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

      const analysis = await runMasatoAnalysis(
        corePrompt,
        baseHistory,
        message
      );
        const data = await parseResponse(response);

      const audit = await runAuditor(
        message,
        analysis
      );
        if (!response.ok) {
          throw new Error(
            data?.error?.message || 'Google API Error'
          );
        }

      let finalContent = await runFinalIntegration(
        corePrompt,
        baseHistory,
        message,
        analysis,
        audit
      );
        const candidate = data.candidates?.[0];

      let finalAnswer = getText(finalContent).trim();
        if (!candidate?.content?.parts) {
          throw new Error(
            'Geminiから有効な返答がありませんでした。'
          );
        }

      if (!finalAnswer) {
        throw new Error(
          '最終回答を生成できませんでした。'
        );
        return candidate.content;
      }

      let compressionUsed = false;
      let history = Array.isArray(conversation.history)
        ? conversation.history
        : [];

      if (countCharacters(finalAnswer) > MAX_OUTPUT_LENGTH) {
        compressionUsed = true;
      // 新しい会話の場合だけDual ModeとReferenceを初期化
      if (history.length === 0) {
        const initialPrompt =
          dualModePrompt + '\n\n' + referencePrompt;

        finalContent = await compressFinalAnswer(
          corePrompt,
          baseHistory,
          message,
          finalAnswer
        );
        const initialMessage = {
          role: 'user',
          parts: [{ text: initialPrompt }]
        };

        finalAnswer = getText(finalContent).trim();
        const initialReply = await askGemini([initialMessage]);

        if (!finalAnswer) {
          throw new Error(
            '回答の圧縮処理に失敗しました。'
          );
        }
        history = [
          initialMessage,
          initialReply
        ];
      }

      history = [
        ...baseHistory,
        {
          role: 'user',
          parts: [{ text: message }]
        },
        {
          role: 'model',
          parts: [{ text: finalAnswer }]
        }
      ];
      history.push({
        role: 'user',
        parts: [{ text: message }]
      });

      const aiReply = await askGemini(history);

      history.push(aiReply);

      let title = conversation.title;

      if (!title || title === '新しい会話') {
        const titleText = Array.from(
          message.replace(/\s+/g, ' ')
        );
        title = message.replace(/\s+/g, ' ').slice(0, 40);

        title = titleText.slice(0, 40).join('');

        if (titleText.length > 40) {
        if (message.length > 40) {
          title += '…';
        }
      }
@@ -788,21 +461,17 @@ export default async function handler(req, res) {
        title
      );

      const initialPrompt =
        dualModePrompt + '\n\n' + referencePrompt;

      return res.status(200).json({
        reply: finalAnswer,
        reply: getText(aiReply) || '返答が得られませんでした。',
        conversationId: conversation.id,
        title: saved.title,
        displayHistory: visibleHistory(
          history,
          initialPrompt
        ),
        pipelineMetrics: {
          analysis: true,
          audit: true,
          finalIntegration: true,
          compression: compressionUsed,
          outputCharacters: countCharacters(finalAnswer)
        }
        )
      });
    }
