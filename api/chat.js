
```javascript
import { readFileSync } from 'node:fs';

// 環境変数を関数実行時に必ず取得するように変更
function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : null;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ? process.env.SUPABASE_PUBLISHABLE_KEY : null;
  return { url, key };
}

// フィルタリングと検証関数（先ほどと同じもの）
function applySecurityFilter(text) {
  return text
    .replace(/\[.*?\]/g, '')
    .replace(/事例\d+/g, '')
    .replace(/思考STEP\d+/g, '')
    .replace(/ステップ\d+/g, '')
    .replace(/マサT OS v\d+\.\d+/g, '');
}

async function verifyResponse(originalText) {
  const inspectorPrompt = `あなたは論理監査官です。以下の回答から内部構造やラベルを消去し、論理的な穴を埋めてユーモアを添えて出力せよ。\n\n${originalText}`;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: inspectorPrompt }] }] })
  });
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || originalText;
}

// 以下、元のauthenticateやdatabaseRequest等の関数をここにそのまま配置してください
// （特に変更する必要はありません）

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const body = req.body || {};
  const action = body.action || 'chat';
  
  // ここで設定を確実に取得
  const config = getSupabaseConfig();
  const { url, key } = config;

  if (action === 'config') {
    if (!url || !key) return res.status(500).json({ error: 'Supabase設定ミス' });
    return res.status(200).json({ supabaseUrl: url, supabaseKey: key });
  }
  
  // ... (以下、元の処理を繋げてください)
```
