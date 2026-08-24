// =====================================================
// Notion 書き込みAPI（スマホ入力フォーム用）
//
// form.html から呼ばれ、Notionのデータベースに1行追加します。
//
// 【重要】このAPIはインターネットに公開されるため、
// 環境変数 FORM_PASSCODE に合言葉を設定してください。
// 合言葉が一致しないリクエストは受け付けません。
// （営業の方には合言葉を1度だけ入力してもらい、
//   スマホ側に記憶されるので毎回の入力は不要です）
//
// 使用する環境変数
//   NOTION_API_KEY … 既存のものをそのまま使います
//   FORM_PASSCODE  … 新規。フォームの合言葉（例: eslead2026）
// =====================================================

// 書き込み先のデータベース。IDはサーバー側だけが持ちます。
const TARGETS = {
  // アポイント・契約管理（部ごとに別データベース）
  apo_1: { id: '71778839de25479e9fbb07a3edd67cff', kind: 'apo', label: '1部',
           courses: ['川崎課','依田課','井岡課','宮下課','松浦課','土居課'] },
  apo_2: { id: '7b62671117fc4f8796e00cfbc309368a', kind: 'apo', label: '2部',
           courses: ['幸課','滝川課','定行課','梅原課','馬場課','橋本課'] },
  apo_3: { id: '585c32e893e642559e5af99577d6f071', kind: 'apo', label: '3部',
           courses: ['富川課','平谷課','平沼課','林課','古高課','龍課'] },
  apo_5: { id: '6c58f027e43a412599087ba7649ce93e', kind: 'apo', label: '5部',
           courses: ['5部1課'] },
  apo_7: { id: '88119c2f00a34fb5a93181dc6ecd9bf0', kind: 'apo', label: '7部',
           courses: ['上田課'] },
  // 出張カレンダー（全部署共通）
  trip:  { id: '39c368b39ccb49e2a12c50207168ddce', kind: 'trip', label: '出張' },
  // キャッチセールス配置（全部署共通）
  catch: { id: '84609900fe0e4400b78ba74984df76bd', kind: 'catch', label: 'キャッチ配置' },
  // 月間ボードの実績（担当者×種別×月ごとに1行。既にあれば件数を書き換えます）
  board: { id: 'bd001f89c489477f841c8242041c3570', kind: 'board', label: '月間ボード' },
};

const TYPE_OPTIONS    = ['アポイント', '契約予定'];
const SHUKAKU_OPTIONS = ['D（電話）', 'A（アンケート・紹介）', '買い増し'];
const TRIP_OPTIONS    = ['書類回収', '金消契約'];
const CATCH_OPTIONS   = ['淀屋橋','名古屋駅','JR大阪駅','パナソニックスタジアム','中之島','茶屋町','新大阪駅','尼崎駅'];
const BOARD_TYPES     = ['契約','新規','解約','対面AP','ZOOM'];
const BOARD_DEPTS     = ['1部','2部','3部','5部','7部'];

// Notionのプロパティ形式に変換する小道具
const title = v => ({ title: [{ text: { content: cut(v, 200) } }] });
const text  = v => ({ rich_text: v ? [{ text: { content: cut(v, 500) } }] : [] });
const sel   = v => ({ select: v ? { name: v } : null });
const date  = v => ({ date: v ? { start: v } : null });
const num   = v => ({ number: Number(v) || 0 });
const cut   = (v, n) => String(v ?? '').slice(0, n);

// 選択肢に無い値は弾く（Notion側に勝手な選択肢が増えるのを防ぐ）
const pick = (v, list) => (list.includes(v) ? v : null);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POSTのみ対応しています' }); }

  const API_KEY  = process.env.NOTION_API_KEY;
  const PASSCODE = process.env.FORM_PASSCODE;

  if (!API_KEY)  return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' });
  if (!PASSCODE) return res.status(500).json({ error: 'サーバー設定エラー（FORM_PASSCODE 未設定）' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'データの形式が正しくありません' });
  }

  if (String(body?.passcode || '') !== String(PASSCODE)) {
    return res.status(401).json({ error: '合言葉が違います' });
  }

  const target = TARGETS[body?.target];
  if (!target) return res.status(400).json({ error: '登録先が正しくありません' });

  const f = body.fields || {};
  const tanto = cut(f.担当者名, 60).trim();
  if (!tanto) return res.status(400).json({ error: '担当者名を入力してください' });
  if (target.kind !== 'board' && !f.日付) return res.status(400).json({ error: '日付を入力してください' });

  // 登録先ごとにプロパティを組み立てる
  let properties, existingId = null;
  if (target.kind === 'apo') {
    const customer = cut(f.お客様名, 100).trim();
    if (!customer) return res.status(400).json({ error: 'お客様名を入力してください' });
    properties = {
      'お客様名' : title(customer),
      '種別'     : sel(pick(f.種別, TYPE_OPTIONS)),
      '日付'     : date(f.日付),
      '時刻'     : text(f.時刻),
      '場所'     : text(f.場所),
      '物件名'   : text(f.物件名),
      '物件番号' : text(f.物件番号),
      '集客手段' : sel(pick(f.集客手段, SHUKAKU_OPTIONS)),
      '担当課'   : sel(pick(f.担当課, target.courses)),
      '担当者名' : text(tanto),
    };
  } else if (target.kind === 'trip') {
    const kind = pick(f.種別, TRIP_OPTIONS);
    if (!kind) return res.status(400).json({ error: '種別を選んでください' });
    properties = {
      '種別（タイトル）': title(kind),   // 一覧の見出しになる項目
      '種別'     : sel(kind),
      '日付'     : date(f.日付),
      '行き先'   : text(f.行き先),
      '備考'     : text(f.備考),
      '担当者名' : text(tanto),
    };
  } else if (target.kind === 'board') {
    const dept = pick(f.部, BOARD_DEPTS);
    const type = pick(f.種別, BOARD_TYPES);
    const course = cut(f.課, 40).trim();
    const month  = cut(f.対象月, 7).trim();          // 例: 2026-08
    if (!dept || !type || !course) return res.status(400).json({ error: '部・課・種別が正しくありません' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '対象月の形式が正しくありません' });
    const count = Math.max(0, Math.min(9999, Number(f.件数) || 0));
    properties = {
      '記録'     : title(`${month} ${dept} ${course} ${tanto} ${type}`),
      '対象月'   : text(month),
      '部'       : sel(dept),
      '課'       : text(course),
      '担当者名' : text(tanto),
      '種別'     : sel(type),
      '件数'     : num(count),
      '登録元'   : sel(f.登録元 === 'サイネージ' ? 'サイネージ' : 'スマホ'),
    };
    // 既に同じ行があるか探す（あれば件数を書き換える）
    existingId = await findBoardRow(API_KEY, target.id, { month, dept, course, tanto, type });
  } else { // catch
    const place = pick(f.配置場所, CATCH_OPTIONS);
    if (!place) return res.status(400).json({ error: '配置場所を選んでください' });
    properties = {
      '担当者（タイトル）': title(tanto), // 一覧の見出しになる項目
      '日付'     : date(f.日付),
      '配置場所' : sel(place),
      '担当者名' : text(tanto),
    };
  }

  try {
    const notion = (path, method, payload) => fetch('https://api.notion.com/v1/' + path, {
      method,
      headers: {
        'Authorization' : 'Bearer ' + API_KEY,
        'Notion-Version': '2022-06-28',
        'Content-Type'  : 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    // 月間ボードは「同じ人・同じ種別・同じ月」の行があれば件数を書き換える（行が増え続けないようにするため）
    if (target.kind === 'board' && existingId) {
      const r = await notion(`pages/${existingId}`, 'PATCH', { properties });
      const data = await r.json();
      if (!r.ok) {
        console.error('[notion-create] update error:', JSON.stringify(data).slice(0, 500));
        return res.status(502).json({ error: 'Notionの更新に失敗しました', detail: data?.message || '' });
      }
      return res.status(200).json({ success: true, id: data.id, updated: true, target: target.label });
    }

    const r = await notion('pages', 'POST', { parent: { database_id: target.id }, properties });
    const data = await r.json();
    if (!r.ok) {
      console.error('[notion-create] Notion API error:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'Notionへの登録に失敗しました', detail: data?.message || '' });
    }
    return res.status(200).json({ success: true, id: data.id, target: target.label });
  } catch (e) {
    console.error('[notion-create]', e);
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}

/**
 * 月間ボードで「同じ月・同じ人・同じ種別」の行を探す
 * 見つかればそのページIDを返し、無ければ null を返します。
 * これにより、押すたびに行が増えるのではなく1行が書き換わります。
 */
async function findBoardRow(apiKey, dbId, { month, dept, course, tanto, type }) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method : 'POST',
      headers: {
        'Authorization' : 'Bearer ' + apiKey,
        'Notion-Version': '2022-06-28',
        'Content-Type'  : 'application/json',
      },
      body: JSON.stringify({
        page_size: 2,
        filter: { and: [
          { property: '対象月',   rich_text: { equals: month  } },
          { property: '部',       select   : { equals: dept   } },
          { property: '課',       rich_text: { equals: course } },
          { property: '担当者名', rich_text: { equals: tanto  } },
          { property: '種別',     select   : { equals: type   } },
        ]},
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.results?.[0]?.id || null;
  } catch (e) {
    console.error('[notion-create] findBoardRow:', e.message);
    return null; // 探せなかった場合は新規作成にまわす
  }
}
