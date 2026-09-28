// =====================================================
// Notion 読み込みAPI（件数が多いデータベース用・全件取得）
//
// Notionは1回の問い合わせで最大100件までしか返しません。
// 月間ボードの実績は「担当者×種別」ごとに1行あるため、1か月で100行を超え、
// 101行目以降（あとから登録された人の数字）が画面に出ない、ということが起きていました。
// このAPIは「続き」があれば最後まで読み進めて、全件をまとめて返します。
//
// 使用する環境変数： NOTION_API_KEY（既存のもの）
// =====================================================

// 読み込みを許可するデータベース（これ以外は断ります）
const ALLOWED = new Set([
  'bd001f89c489477f841c8242041c3570', // 月間ボード実績
  '3d880bb910f080a8af18cdbdf35a40f8', // 部設定（名簿・目標・遠隔操作）
  '71778839de25479e9fbb07a3edd67cff', // アポイント 1部
  '7b62671117fc4f8796e00cfbc309368a', // アポイント 2部
  '585c32e893e642559e5af99577d6f071', // アポイント 3部
  '6c58f027e43a412599087ba7649ce93e', // アポイント 5部
  '88119c2f00a34fb5a93181dc6ecd9bf0', // アポイント 7部
  '39c368b39ccb49e2a12c50207168ddce', // 出張カレンダー
  '84609900fe0e4400b78ba74984df76bd', // キャッチ配置
  'f83e35035a8946448a45b5d4dec52960', // 書類回収
  'd5da225315fc4557a94a86dea8c32b3e', // 物件マスタ
]);
const MAX_PAGES = 20; // 最大2,000件まで
// 混み合っていて断られたとき（429）や一時的なエラーは、少し待ってやり直します
async function nfetch(url, opt) {
  let r;
  for (let i = 0; i < 4; i++) {
    r = await fetch(url, opt);
    if (r.status !== 429 && r.status < 500) return r;
    const ra = Number(r.headers.get('retry-after'));
    await new Promise(ok => setTimeout(ok, (ra > 0 ? ra * 1000 : 400 * 2 ** i) + Math.random() * 200));
  }
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POSTのみ対応しています' });

  const API_KEY = process.env.NOTION_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'データの形式が正しくありません' }); }

  const dbId = String(body.dbId || '').replace(/-/g, '');
  if (!ALLOWED.has(dbId)) return res.status(400).json({ error: 'このデータベースは読み込めません' });

  const results = [];
  let cursor = undefined;
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = { page_size: 100 };
      if (body.filter) q.filter = body.filter;
      if (Array.isArray(body.sorts)) q.sorts = body.sorts;
      if (cursor) q.start_cursor = cursor;
      const r = await nfetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: {
          'Authorization' : 'Bearer ' + API_KEY,
          'Notion-Version': '2022-06-28',
          'Content-Type'  : 'application/json',
        },
        body: JSON.stringify(q),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('[notion-query]', JSON.stringify(data).slice(0, 400));
        return res.status(502).json({ error: 'Notionからの読み込みに失敗しました', detail: data?.message || '' });
      }
      results.push(...(data.results || []));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return res.status(200).json({ results, count: results.length });
  } catch (e) {
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}
