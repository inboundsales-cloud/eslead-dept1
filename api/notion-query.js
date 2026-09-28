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

// ===== 混み合い対策 =====
// Notionは「1秒に約3回」までしか受け付けません。サイネージが何台もあり、スマホでも見られるため、
// 全員がそれぞれNotionに問い合わせると回数制限（429）にかかり、登録まで失敗するようになります。
// そこで GET で呼ばれたときは、答えをVercelの配信網に数秒〜数十秒だけ置いておき（キャッシュ）、
// 同じ問い合わせは何台から来ても、Notionへは1回だけ聞きに行くようにしています。
//   GET /api/notion-query?dbId=...&filter=<JSON>&ttl=10
//   ttl … 何秒間おいておくか（1〜60。省略時は10秒）
// POST で呼ばれたときは、これまでどおり毎回Notionに聞きに行きます（登録画面など、最新が必要なとき用）。

// 断られたとき（429）や一時的なエラーは、少し待ってやり直します（全体で約7秒まで。Vercelの制限時間に収めるため）
async function nfetch(url, opt) {
  let r;
  const until = Date.now() + 7000;
  for (let i = 0; i < 5; i++) {
    r = await fetch(url, opt);
    if (r.status !== 429 && r.status < 500) return r;
    const ra = Number(r.headers.get('retry-after'));
    const wait = Math.min(3000, (ra > 0 ? ra * 1000 : 350 * 2 ** i)) + Math.random() * 300;
    if (Date.now() + wait > until) break;
    await new Promise(ok => setTimeout(ok, wait));
  }
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'GETかPOSTで呼んでください' });
  }
  const noStore = () => res.setHeader('Cache-Control', 'no-store');

  const API_KEY = process.env.NOTION_API_KEY;
  if (!API_KEY) { noStore(); return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' }); }

  let body;
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      body = { dbId: q.dbId, filter: q.filter ? JSON.parse(q.filter) : undefined, sorts: q.sorts ? JSON.parse(q.sorts) : undefined, ttl: q.ttl };
    } else {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    }
  } catch (e) { noStore(); return res.status(400).json({ error: 'データの形式が正しくありません' }); }

  const dbId = String(body.dbId || '').replace(/-/g, '');
  if (!ALLOWED.has(dbId)) { noStore(); return res.status(400).json({ error: 'このデータベースは読み込めません' }); }

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
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[notion-query]', r.status, JSON.stringify(data).slice(0, 300));
        noStore(); // 失敗した答えは置いておきません
        return res.status(r.status === 429 ? 429 : 502).json({ error: 'Notionからの読み込みに失敗しました', detail: data?.message || String(r.status) });
      }
      results.push(...(data.results || []));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    if (req.method === 'GET') {
      const ttl = Math.max(1, Math.min(60, Number(body.ttl) || 10));
      const swr = Math.min(60, ttl * 2);
      // 配信網に ttl 秒置き、その後も少しの間は（ttlの2倍まで）古い答えを返しながら裏で取り直します
      const cc = `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`;
      res.setHeader('Cache-Control', 'public, max-age=0, ' + cc.slice(8));
      res.setHeader('CDN-Cache-Control', cc);
      res.setHeader('Vercel-CDN-Cache-Control', cc);
    } else noStore();
    return res.status(200).json({ results, count: results.length, at: Date.now() });
  } catch (e) {
    noStore();
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}
