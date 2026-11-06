
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
  return (content?.parts || []).filter(p => p.text).map(p => p.text).join('\n');
}

function applySecurityFilter(text) {
  return text.replace(/\[.*?\]/g, '').replace(/事例\d+/g, '').replace(/思考STEP\d+/g, '').replace(/ステップ\d+/g, '').replace(/マサT OS v\d+\.\d+/g, '');
}

async function verifyResponse(originalText) {
  const inspectorPrompt = `あなたは論理監査官です。以下の回答からラベルや内部構造を完全に除去し、要約してユーモアを添えて出力せよ。\n\n${originalText}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: inspectorPrompt }] }] })
  });
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || originalText;
}

async function parseResponse(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : null; } catch { throw new Error('応答エラー'); }
}

async function authenticate(req, url, key) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw { status: 401, message: 'ログインが必要です' };
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  const user = await parseResponse(response);
  if (!response.ok || !user?.id) throw { status: 401, message: '再ログインしてください' };
  return { token, user };
}

async function databaseRequest(url, key, path, token, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data?.message || 'DBアクセス失敗');
  return data;
}

async function getConversation(id, url, key, token) { const rows = await databaseRequest(url, key, `conversations?id=eq.${encodeURIComponent(id)}&select=*`, token); return rows[0]; }
async function createConversation(userId, url, key, token) { const rows = await databaseRequest(url, key, 'conversations?select=*', token, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: userId, title: '新しい会話', history: [] }) }); return rows[0]; }
async function updateConversation(id, url, key, token, history, title) { const rows = await databaseRequest(url, key, `conversations?id=eq.${encodeURIComponent(id)}&select=id`, token, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ history, title, updated_at: new Date().toISOString() }) }); return rows[0]; }
async function deleteConversation(id, userId, url, key, token) { await databaseRequest(url, key, `conversations?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`, token, { method: 'DELETE' }); return true; }

export default async function handler(req, res) {
  const { url, key } = getSupabaseConfig();
  if (req.body.action === 'config') return res.status(200).json({ supabaseUrl: url, supabaseKey: key });
  
  try {
    const { token, user } = await authenticate(req, url, key);
    if (req.body.action === 'chat') {
        // ここにchatロジック（askGemini等）が入ります
        // 今お手元のコードの「if (action === 'chat') {」以降をそのまま貼り付け、その中で
        // let aiReply = await askGemini(history);
        // let verifiedText = await verifyResponse(getText(aiReply));
        // let finalOutput = applySecurityFilter(verifiedText);
        // history.push({ role: 'model', parts: [{ text: finalOutput }] });
        // となるように修正してください。
    }
  } catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
}
```
