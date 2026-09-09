// =====================================================
// Notionのデータベース定義（選択肢）を読み取るAPI
//
// 「配置場所」のような選択式の項目は、Notion側で選択肢を足したり
// 消したりできます。その一覧をこのAPIで取得して画面に反映することで、
// 場所が変わるたびにコードを直す必要がなくなります。
//
// 使い方
//   POST /api/notion-schema  { "dbId": "..." }
//   → { success:true, properties:{ 配置場所:{ select:{ options:[...] } } } }
//
// 使用する環境変数
//   NOTION_API_KEY … 既存のものをそのまま使います
// =====================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 選択肢はめったに変わらないので、少しキャッシュして呼び出しを減らします
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POSTのみ対応しています' }); }

  const API_KEY = process.env.NOTION_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'データの形式が正しくありません' });
  }

  const dbId = String(body?.dbId || '').trim();
  if (!dbId) return res.status(400).json({ error: 'dbId が指定されていません' });

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: {
        'Authorization' : 'Bearer ' + API_KEY,
        'Notion-Version': '2022-06-28',
      },
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[notion-schema]', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: 'データベースの定義を取得できませんでした', detail: data?.message || '' });
    }

    // 選択式の項目だけを、名前と色の一覧にして返します（画面で使うのはこれだけです）
    const properties = {};
    for (const [name, p] of Object.entries(data.properties || {})) {
      if (p.type === 'select') {
        properties[name] = { select: { options: (p.select?.options || []).map(o => ({ name: o.name, color: o.color })) } };
      } else if (p.type === 'multi_select') {
        properties[name] = { multi_select: { options: (p.multi_select?.options || []).map(o => ({ name: o.name, color: o.color })) } };
      }
    }
    return res.status(200).json({ success: true, title: (data.title || []).map(t => t.plain_text).join(''), properties });
  } catch (e) {
    console.error('[notion-schema]', e);
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}
