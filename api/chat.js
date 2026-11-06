
```javascript
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

// 最終出力の強制フィルタリング関数
function applySecurityFilter(text) {
  return text
    .replace(/\[.*?\]/g, '')        // ラベル削除
    .replace(/事例\d+/g, '')         // 事例番号削除
    .replace(/思考STEP\d+/g, '')    // 思考STEP表記削除
    .replace(/ステップ\d+/g, '')     // ステップ表記削除
    .replace(/マサT OS v\d+\.\d+/g, ''); // OS内部名称削除
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
  return getText(data.candidates[0].content);
}

// (認証・データベース関連の既存関数はそのまま維持...)
// [※authenticate, databaseRequest, getConversation, createConversation, updateConversation, deleteConversation はここへそのまま配置]

export default async function handler(req, res) {
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

    // [会話履歴作成ロジック維持...]

    // 1. 初回生成
    const aiReply = await askGemini(history);
    let rawText = getText(aiReply);

    // 2. 検証とフィルタリング
    let verifiedText = await verifyResponse(rawText);
    let finalOutput = applySecurityFilter(verifiedText);

    // ユーモアチェック（もし検察官がユーモアを忘れていたら強制付与）
    if (!finalOutput.includes('(') && !finalOutput.includes(')')) {
        finalOutput += "\n\n(僕、AIだから筋肉痛にはならないんですけどね、筋肉痛になるほど運動するあなたは最高にロックだと思いますよ（笑）)";
    }

    history.push({ role: 'model', parts: [{ text: finalOutput }] });

    // [以下、保存処理・レスポンス返却は既存の通り...]
  }
}
```
