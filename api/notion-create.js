// =====================================================
// Notion 書き込みAPI（スマホ入力フォーム用）
//
// form.html から呼ばれ、Notionのデータベースに1行追加します。
//
// 合言葉の制度は廃止しました。URLを知っていればだれでも登録できます
// （機密情報を扱わないため。環境変数 FORM_PASSCODE は使わなくなったので、消しても構いません）。
//
// 使用する環境変数
//   NOTION_API_KEY … 既存のものをそのまま使います
//
// ロープレ予定との重複チェック・LINE WORKS通知の共通ロジックは、
// 毎朝の定期チェックAPI（check-roleplay-conflicts.js）と共有するため
// ./_shared.js に切り出しています。
// =====================================================
import { checkRoleplayConflict } from './_shared.js';

// 書き込み先のデータベース。IDはサーバー側だけが持ちます。
const TARGETS = {
  // アポイント・契約管理（部ごとに別データベース）
  apo_1: { id: '71778839de25479e9fbb07a3edd67cff', kind: 'apo', label: '1部',
           courses: ['川崎課','依田課','井岡課','宮下課','松浦課','土居課'] },
  apo_2: { id: '7b62671117fc4f8796e00cfbc309368a', kind: 'apo', label: '2部',
           courses: ['幸課','滝川課','定行課','梅原課','橋本課'] },
  apo_3: { id: '585c32e893e642559e5af99577d6f071', kind: 'apo', label: '3部',
           courses: ['富川課','平谷課','平沼課','古高課','龍課'] },
  apo_5: { id: '6c58f027e43a412599087ba7649ce93e', kind: 'apo', label: '5部',
           courses: ['山本課', '5部1課'] },
  apo_7: { id: '88119c2f00a34fb5a93181dc6ecd9bf0', kind: 'apo', label: '7部',
           courses: ['上田課'] },
  // 出張カレンダー（全部署共通）
  trip:  { id: '39c368b39ccb49e2a12c50207168ddce', kind: 'trip', label: '出張' },
  // キャッチセールス配置（全部署共通）
  catch: { id: '84609900fe0e4400b78ba74984df76bd', kind: 'catch', label: 'キャッチ配置' },
  // 月間ボードの実績。いまは「部設定」データベースに課ごと1行で保存します（下の handleBoard）。
  // このIDは、以前の1人1行のデータベース（今月分の移し替え元）です
  board: { id: 'bd001f89c489477f841c8242041c3570', kind: 'board', label: '月間ボード' },
  // 書類回収の案件（営業が登録し、全国マップに表示されます）
  shorui: { id: 'f83e35035a8946448a45b5d4dec52960', kind: 'shorui', label: '書類回収' },
  // 重要事項説明の予定（営業事務課が登録・削除します）
  jusetsu: { id: 'e7103ac9c70d44d6b76120f4166024cc', kind: 'jusetsu', label: '重要事項説明' },
  // 部設定（月間ボードの課・メンバー構成や目標本数。部ごとに1行だけ入ります）
  deptset: { id: '3d880bb910f080a8af18cdbdf35a40f8', kind: 'deptset', label: '部設定' },
  // 物件マスタ（書類回収マップの「物件別の登録状況」の元データ）
  bukken: { id: 'd5da225315fc4557a94a86dea8c32b3e', kind: 'bukken', label: '物件マスタ' },
  // サイネージの遠隔操作（スマホから画面を切り替える）。新しいデータベースは作らず、
  // 「部設定」データベースに部＝"_control_1部" のように部ごとの特別な1行を間借りして保存します。
  // 部ごとに行を分けているので、1部の操作が2部・3部などのサイネージに影響することはありません。
  control: { id: '3d880bb910f080a8af18cdbdf35a40f8', kind: 'control', label: 'サイネージ操作' },
};

const TYPE_OPTIONS    = ['アポイント', '契約予定', '契約済']; // 契約済＝アポイントから契約が決まったもの（スマホの「自分の登録」で切り替えます）
// 集客手段: D=電話 / A=アンケート / S=紹介 / I=イベント / 買い増し
// Notion側に無い選択肢は、書き込み時に自動で追加されます。
const SHUKAKU_OPTIONS = ['D（電話）', 'A（アンケート）', 'S（紹介）', 'I（イベント）', '買い増し'];
const TRIP_OPTIONS    = ['書類回収', '金消契約'];
const CATCH_OPTIONS   = ['淀屋橋','名古屋駅','JR大阪駅','パナソニックスタジアム','中之島','茶屋町','新大阪駅','尼崎駅','その他'];
const BOARD_TYPES     = ['契約','新規','解約','対面AP','ZOOM','解約除外']; // 解約除外＝カウントしない解約（契約数から引かない、イレギュラー）
const BOARD_DEPTS     = ['1部','2部','3部','5部','7部'];
// 重要事項説明を担当する営業事務課のメンバー
const JUSETSU_STAFF   = ['深田','坂上','寺田','田伏','田端','林'];
// ---- 書類回収 ----
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
const DOCS     = ['住民票','戸籍謄本','課税証明書','納税証明書','評価証明書','印鑑証明書','その他'];
const QUARTERS = ['第1Q','第2Q','第3Q','第4Q'];
const STATES   = ['未回収','予定済','回収済'];

// Notionのプロパティ形式に変換する小道具
const title = v => ({ title: [{ text: { content: cut(v, 200) } }] });
const text  = v => ({ rich_text: v ? [{ text: { content: cut(v, 500) } }] : [] });
const sel   = v => ({ select: v ? { name: v } : null });
const date  = v => ({ date: v ? { start: v } : null });
const num   = v => ({ number: Number(v) || 0 });
const multi = (arr, list) => ({ multi_select: (Array.isArray(arr) ? arr : []).filter(v => list.includes(v)).map(name => ({ name })) });
const cut   = (v, n) => String(v ?? '').slice(0, n);
// 部設定のJSONなど、500文字を超える可能性がある内容を保存するための長文用テキスト
// (rich_textは1項目あたり2000文字までのため、2000文字弱ごとに分割して並べます)
const longText = v => {
  const s = String(v ?? '');
  const chunks = [];
  for (let i = 0; i < s.length; i += 1900) chunks.push(s.slice(i, i + 1900));
  return { rich_text: (chunks.length ? chunks : ['']).map(c => ({ text: { content: c } })) };
};

// 選択肢に無い値は弾く（Notion側に勝手な選択肢が増えるのを防ぐ）
const pick = (v, list) => (list.includes(v) ? v : null);
// 担当課：一覧と字の違い（髙/高 など）だけなら一覧の書き方にそろえ、一覧に無い課名でも空にせずそのまま記録します
// （以前は一覧に無い課名だと担当課が空になり、サイネージの「翌日以降（課ごと）」に出ませんでした）
function pickCourse(v, list) {
  const s = cut(v, 40).trim();
  if (!s) return null;
  if (list.includes(s)) return s;
  const k = bNorm(s);
  return list.find(c => bNorm(c) === k) || s;
}

// Notionへの通信。混み合っていて断られたとき（429）や一時的なエラー（5xx）は、少し待って最大4回までやり直します。
// サイネージが何台も同時に読み込みをしていると、Notionの回数制限（1秒に約3回）にかかることがあるためです。
async function nfetch(url, opt) {
  let r;
  const until = Date.now() + 7500; // Vercelの制限時間（10秒）に収まるよう、やり直しは全体で約7.5秒まで
  for (let i = 0; i < 6; i++) {
    r = await fetch(url, opt);
    if (r.status !== 429 && r.status < 500) return r;
    const ra = Number(r.headers.get('retry-after'));
    const wait = Math.min(3000, (ra > 0 ? ra * 1000 : 350 * 2 ** i)) + Math.random() * 300;
    if (Date.now() + wait > until) break;
    await new Promise(ok => setTimeout(ok, wait));
  }
  return r;
}

// 「自分の登録」から修正・削除できる登録先
const OWNABLE = ['apo', 'trip', 'catch', 'shorui'];
const isPageId = v => /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v);
const plain = prop => (prop?.rich_text || prop?.title || []).map(t => t.plain_text).join('').trim();
const notionApi = apiKey => (path, method, payload) => nfetch('https://api.notion.com/v1/' + path, {
  method,
  headers: {
    'Authorization' : 'Bearer ' + apiKey,
    'Notion-Version': '2022-06-28',
    'Content-Type'  : 'application/json',
  },
  body: payload ? JSON.stringify(payload) : undefined,
});
/**
 * 修正・削除の前に、そのページが「この登録先のデータベースの行」で、
 * 「担当者名が本人」であることを確かめます（他の人の予定を誤って消さないため）。
 */
async function loadOwnPage(api, target, pageId, who) {
  const r = await api(`pages/${pageId}`, 'GET');
  if (!r.ok) return { status: 404, error: '予定が見つかりませんでした（すでに削除されている可能性があります）' };
  const page = await r.json();
  if (page.archived) return { status: 410, error: 'この予定はすでに削除されています' };
  const parent = String(page.parent?.database_id || '').replace(/-/g, '');
  if (parent !== target.id) return { status: 403, error: '登録先が一致しません' };
  if (!who || plain(page.properties?.['担当者名']) !== who) {
    return { status: 403, error: 'ご自身が登録した予定だけ修正・削除できます' };
  }
  return { page };
}
// 書類回収の案件から、出張カレンダーに入れる予定の中身を作ります
function shoruiTripProps(f, tanto) {
  const go   = [f.都道府県, cut(f.市区町村, 60).trim()].filter(Boolean).join(' ');
  const cust = cut(f.お客様名, 100).trim();
  const memo = [cut(f.物件名, 60).trim(), cust ? cust + '様' : '',
                (Array.isArray(f.取得書類) ? f.取得書類.join('・') : ''),
                cut(f.備考, 200).trim()].filter(Boolean).join(' / ');
  return {
    '種別（タイトル）': title('書類回収'),
    '種別'    : sel('書類回収'),
    '日付'    : date(f.回収予定日),
    '行き先'  : text(go),
    '備考'    : text(memo),
    '担当者名': text(tanto),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POSTのみ対応しています' }); }

  const API_KEY  = process.env.NOTION_API_KEY;

  if (!API_KEY)  return res.status(500).json({ error: 'サーバー設定エラー（NOTION_API_KEY 未設定）' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'データの形式が正しくありません' });
  }

  // 合言葉の制度は廃止しました（URLを知っていればだれでも登録できます）。
  // 古い画面から送られてくる passcode は、あっても無くても無視します。

  const target = TARGETS[body?.target];
  if (!target) return res.status(400).json({ error: '登録先が正しくありません' });

  // ===== 予定の削除（Notionのゴミ箱へ移動します。完全には消えません） =====
  // ===== 書類回収のまとめ =====
  // 声を掛け合って1回の出張にまとめたとき、代表者以外の出張予定を消し、
  // 案件には「実際に誰が回収に行くか」を記録します。案件自体は残します。
  if (body?.action === 'merge') {
    if (target.kind !== 'shorui') return res.status(400).json({ error: 'この登録先ではまとめできません' });
    const ids = Array.isArray(body?.ids) ? body.ids.filter(Boolean).slice(0, 20) : [];
    const rep = cut(body?.代表, 60).trim();
    const day = String(body?.回収予定日 || '').trim();
    const go  = cut(body?.行き先, 120).trim();
    if (ids.length < 2) return res.status(400).json({ error: 'まとめる案件を2件以上選んでください' });
    if (!rep) return res.status(400).json({ error: '回収に行く人を選んでください' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: '回収日を選んでください' });

    const api = (path, method, payload) => nfetch('https://api.notion.com/v1/' + path, {
      method,
      headers: {
        'Authorization' : 'Bearer ' + API_KEY,
        'Notion-Version': '2022-06-28',
        'Content-Type'  : 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const group = 'G' + Date.now().toString(36).toUpperCase();
    const ng = [];
    let removed = 0;
    try {
      for (const id of ids) {
        // それぞれの案件に紐づく出張予定を消します（まとめ後は1本だけにするため）
        let tripId = '';
        try {
          const g = await api(`pages/${id}`, 'GET');
          if (g.ok) {
            const p = (await g.json()).properties || {};
            tripId = (p['出張ページID']?.rich_text || []).map(t => t.plain_text).join('');
          }
        } catch (e) { /* 読めなくても続けます */ }
        if (tripId) {
          try { if ((await api(`pages/${tripId}`, 'PATCH', { archived: true })).ok) removed++; }
          catch (e) { /* 消せなくても続けます */ }
        }

        const r = await api(`pages/${id}`, 'PATCH', { properties: {
          '回収担当者'  : text(rep),
          'まとめ番号'  : text(group),
          '回収予定日'  : date(day),
          '出張ページID': text(''),
        }});
        if (!r.ok) ng.push(id);
      }

      // まとめた出張を1本だけ作ります
      let tripId = '';
      const tr = await api('pages', 'POST', {
        parent: { database_id: TARGETS.trip.id },
        properties: {
          '種別（タイトル）': title('書類回収'),
          '種別'    : sel('書類回収'),
          '日付'    : date(day),
          '行き先'  : text(go),
          '備考'    : text(`まとめ回収 ${ids.length}件`),
          '担当者名': text(rep),
        },
      });
      if (tr.ok) {
        tripId = (await tr.json())?.id || '';
        if (tripId && ids[0]) await api(`pages/${ids[0]}`, 'PATCH', { properties: { '出張ページID': text(tripId) } });
      }

      // まとめた代表者(rep)が、その日のロープレ講師と重なっていないか確認します。
      await checkRoleplayConflict({ dept: '', who: rep, plan: day, bukken: '', customer: '' });

      return res.status(200).json({
        success: true, group, merged: ids.length - ng.length,
        removedTrips: removed, tripCreated: !!tripId, failed: ng.length,
      });
    } catch (e) {
      console.error('[notion-create] merge:', e);
      return res.status(500).json({ error: 'まとめに失敗しました', detail: e.message });
    }
  }

  // ===== 予定の削除（Notionのゴミ箱へ移動します。完全には消えないので、Notion側で復元できます） =====
  // ・重説（営業事務課の運用）… これまでどおり
  // ・アポイント／契約予定・出張・キャッチ配置・書類回収 … スマホの「自分の登録」から。
  //   本人が登録したもの（担当者名が本人の名前）だけを消せるよう、サーバー側でも確かめます。
  if (body?.action === 'delete') {
    const pageId = String(body?.pageId || '').trim();
    if (!isPageId(pageId)) return res.status(400).json({ error: '削除する予定が指定されていません' });
    const api = notionApi(API_KEY);
    try {
      let linkedTrip = '';
      if (target.kind === 'jusetsu') {
        // 重説はこれまでどおり（営業事務課が取り消します）
      } else if (OWNABLE.includes(target.kind)) {
        const own = await loadOwnPage(api, target, pageId, cut(body?.担当者名, 60).trim());
        if (own.error) return res.status(own.status).json({ error: own.error });
        // 書類回収の案件を消すときは、一緒に作った出張予定も消します
        // （まとめ回収に使われている出張は、代表者の予定なので残します）
        if (target.kind === 'shorui') {
          const pp = own.page.properties || {};
          if (!plain(pp['まとめ番号'])) linkedTrip = plain(pp['出張ページID']);
        }
      } else {
        return res.status(400).json({ error: 'この登録先は削除に対応していません' });
      }
      const r = await api(`pages/${pageId}`, 'PATCH', { archived: true });
      const data = await r.json();
      if (!r.ok) {
        console.error('[notion-create] delete error:', JSON.stringify(data).slice(0, 400));
        return res.status(502).json({ error: '削除に失敗しました', detail: data?.message || '' });
      }
      let tripRemoved = false;
      if (linkedTrip) {
        try { tripRemoved = (await api(`pages/${linkedTrip}`, 'PATCH', { archived: true })).ok; }
        catch (e) { /* 出張予定が消せなくても、案件の削除は成功扱いにします */ }
      }
      return res.status(200).json({ success: true, deleted: true, tripRemoved });
    } catch (e) {
      return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
    }
  }

  // ===== 物件マスタの「クオーター」自動設定 =====
  // 物件マスタには本来「引渡予定日」しか入っていないため、営業事務が毎回手入力しなくて済むよう、
  // 引渡予定日の月からクオーターを自動計算してNotion側の「クオーター」欄に書き戻します。
  // すでに値が入っている物件は上書きしません（手動で調整した値を尊重します）。
  if (body?.action === 'set-quarter') {
    if (target.kind !== 'bukken') return res.status(400).json({ error: 'この登録先には対応していません' });
    const pageId  = String(body?.pageId || '').trim();
    const quarter = pick(String(body?.quarter || '').trim(), QUARTERS);
    if (!pageId)  return res.status(400).json({ error: '物件が指定されていません' });
    if (!quarter) return res.status(400).json({ error: 'クオーターの値が正しくありません' });
    try {
      const r = await nfetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method : 'PATCH',
        headers: {
          'Authorization' : 'Bearer ' + API_KEY,
          'Notion-Version': '2022-06-28',
          'Content-Type'  : 'application/json',
        },
        body: JSON.stringify({ properties: { 'クオーター': sel(quarter) } }),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('[notion-create] set-quarter error:', JSON.stringify(data).slice(0, 400));
        return res.status(502).json({ error: 'クオーターの設定に失敗しました', detail: data?.message || '' });
      }
      return res.status(200).json({ success: true, updated: true });
    } catch (e) {
      return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
    }
  }

  // ===== 月間ボードの実績（課ごとに1行へまとめて保存します） =====
  if (target.kind === 'board') {
    try { const out = await handleBoard(API_KEY, body); return res.status(out.status).json(out.json); }
    catch (e) { console.error('[notion-create] board', e); return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message }); }
  }

  const f = body.fields || {};
  const tanto = cut(f.担当者名, 60).trim();
  // アポイントの「契約済にする／取消・契約した物件と部屋番号」は、同じ課のメンバーならだれでも変えられます
  if (body?.action === 'done') {
    if (target.kind !== 'apo') return res.status(400).json({ error: 'この登録先は対応していません' });
    try { const out = await handleDone(API_KEY, target, body, tanto); return res.status(out.status).json(out.json); }
    catch (e) { console.error('[notion-create] done', e); return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message }); }
  }
  if (target.kind !== 'deptset' && target.kind !== 'control') {
    if (!tanto) return res.status(400).json({ error: '担当者名を入力してください' });
    if (!['shorui'].includes(target.kind) && !f.日付) return res.status(400).json({ error: '日付を入力してください' });
  }

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
      '担当課'   : sel(pickCourse(f.担当課, target.courses)),
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
  } else if (target.kind === 'shorui') {
    const customer = cut(f.お客様名, 100).trim();
    const pref     = pick(f.都道府県, PREFS);
    if (!pref) return res.status(400).json({ error: '都道府県を選んでください' });
    // お客様名は任意。空のときは「担当者＋行き先」を見出しにします。
    const label = customer || [tanto, pref + cut(f.市区町村, 60).trim()].filter(Boolean).join(' / ');
    properties = {
      'お客様名'      : title(label),
      '物件名'        : text(f.物件名),
      '都道府県'      : sel(pref),
      '市区町村'      : text(f.市区町村),
      '取得書類'      : multi(f.取得書類, DOCS),
      '引渡クオーター': sel(pick(f.引渡クオーター, QUARTERS)),
      '期限'          : date(f.期限),
      '回収予定日'    : date(f.回収予定日),
      '担当者名'      : text(tanto),
      '部'            : sel(pick(f.部, BOARD_DEPTS)),
      '課'            : text(f.課),
      '備考'          : text(f.備考),
    };
  } else if (target.kind === 'jusetsu') {
    const staff = pick(f.重説担当, JUSETSU_STAFF);
    const sales = cut(f.営業担当, 60).trim();
    if (!staff) return res.status(400).json({ error: '重説担当を選んでください' });
    if (!sales) return res.status(400).json({ error: '営業担当の名前を入力してください' });
    properties = {
      '営業担当' : title(sales),
      '重説担当' : sel(staff),
      '日付'     : date(f.日付),
      '時刻'     : text(f.時刻),
      '備考'     : text(f.備考),
      '登録者'   : text(tanto),
    };
  } else if (target.kind === 'deptset') {
    const dept = pick(f.部, BOARD_DEPTS);
    if (!dept) return res.status(400).json({ error: '部が正しくありません' });
    properties = {
      '部'      : title(dept),
      '設定JSON': longText(JSON.stringify(f.data || {})),
    };
    // 部ごとに1行だけにする（既にあれば書き換え、無ければ新規作成）
    try { existingId = await findDeptSetRow(API_KEY, target.id, dept); }
    catch (e) { return res.status(502).json({ error: '保存先の確認に失敗しました。少し待ってもう一度お試しください', detail: e.message }); }
  } else if (target.kind === 'control') {
    // サイネージ遠隔操作：部ごとに"_control_1部"のような専用の1行を使い回します
    // （部を指定しないと他部にも影響してしまうため、部の指定を必須にしています）
    const dept = pick(f.部, BOARD_DEPTS);
    if (!dept) return res.status(400).json({ error: '部が正しくありません' });
    const controlKey = '_control_' + dept;
    properties = {
      '部'      : title(controlKey),
      '設定JSON': longText(JSON.stringify(f.data || {})),
    };
    try { existingId = await findDeptSetRow(API_KEY, target.id, controlKey); }
    catch (e) { return res.status(502).json({ error: '保存先の確認に失敗しました。少し待ってもう一度お試しください', detail: e.message }); }
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
    const notion = (path, method, payload) => nfetch('https://api.notion.com/v1/' + path, {
      method,
      headers: {
        'Authorization' : 'Bearer ' + API_KEY,
        'Notion-Version': '2022-06-28',
        'Content-Type'  : 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    // ===== 登録内容の修正（スマホの「自分の登録」から） =====
    // 本人が登録したものだけを書き換えます。フォームから送られてこなかった項目
    // （Notionで直接入力した物件番号など）は消さずにそのまま残します。
    if (body?.action === 'update') {
      if (!OWNABLE.includes(target.kind)) return res.status(400).json({ error: 'この登録先は修正に対応していません' });
      const pageId = String(body?.pageId || '').trim();
      if (!isPageId(pageId)) return res.status(400).json({ error: '修正する予定が指定されていません' });
      const own = await loadOwnPage(notion, target, pageId, tanto);
      if (own.error) return res.status(own.status).json({ error: own.error });
      const DERIVED = { '種別（タイトル）': 1, '担当者（タイトル）': 1 };
      for (const k of Object.keys(properties)) if (!(k in f) && !DERIVED[k]) delete properties[k];
      const r = await notion(`pages/${pageId}`, 'PATCH', { properties });
      const data = await r.json();
      if (!r.ok) {
        console.error('[notion-create] edit error:', JSON.stringify(data).slice(0, 500));
        return res.status(502).json({ error: 'Notionの更新に失敗しました', detail: data?.message || '' });
      }
      // 書類回収は、出張カレンダーの予定も合わせて直します（まとめ回収済みの案件は代表者の予定なので触りません）
      let trip = false;
      if (target.kind === 'shorui') {
        const pp = own.page.properties || {};
        const oldPlan = pp['回収予定日']?.date?.start || '';
        if (!plain(pp['まとめ番号'])) {
          const tripId = plain(pp['出張ページID']);
          try {
            if (tripId && f.回収予定日) {
              trip = (await notion(`pages/${tripId}`, 'PATCH', { properties: shoruiTripProps(f, tanto) })).ok;
            } else if (tripId && !f.回収予定日) {
              await notion(`pages/${tripId}`, 'PATCH', { archived: true });
              await notion(`pages/${pageId}`, 'PATCH', { properties: { '出張ページID': text('') } });
            } else if (f.回収予定日) {
              const tr = await notion('pages', 'POST', { parent: { database_id: TARGETS.trip.id }, properties: shoruiTripProps(f, tanto) });
              trip = tr.ok;
              if (tr.ok) { const tj = await tr.json(); if (tj?.id) await notion(`pages/${pageId}`, 'PATCH', { properties: { '出張ページID': text(tj.id) } }); }
            }
          } catch (e) { console.error('[notion-create] 出張カレンダー連携(修正):', e.message); }
        }
        if (f.回収予定日 && f.回収予定日 !== oldPlan) {
          await checkRoleplayConflict({ dept: f.部, who: tanto, plan: f.回収予定日, bukken: f.物件名, customer: cut(f.お客様名, 100).trim() });
        }
      }
      return res.status(200).json({ success: true, id: data.id, updated: true, target: target.label, trip });
    }

    // 月間ボード・部設定・サイネージ操作は「同じ人/同じ部/同じ操作行」があれば書き換える（行が増え続けないようにするため）
    if ((target.kind === 'deptset' || target.kind === 'control') && existingId) {
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

    // 書類回収の案件に回収予定日が入っていれば、出張カレンダーにも予定を作ります。
    // 営業の方が2か所に入力しなくて済むようにするためです。
    let trip = false;
    if (target.kind === 'shorui' && f.回収予定日) {
      const cust = cut(f.お客様名, 100).trim();
      try {
        const tr = await notion('pages', 'POST', {
          parent: { database_id: TARGETS.trip.id },
          properties: shoruiTripProps(f, tanto),
        });
        trip = tr.ok;
        if (tr.ok) {
          // まとめたときに不要な出張を消せるよう、作った予定のIDを案件に控えます
          const tj = await tr.json();
          if (tj?.id) await notion(`pages/${data.id}`, 'PATCH', { properties: { '出張ページID': text(tj.id) } });
        } else {
          console.error('[notion-create] 出張カレンダーへの登録に失敗:', (await tr.text()).slice(0, 300));
        }
      } catch (e) {
        console.error('[notion-create] 出張カレンダー連携:', e.message);
      }
      // ロープレの試験官が書類回収に駆り出されてドタキャンにならないよう、
      // 回収に行く人(担当者名)とその日のロープレ講師が重なっていないか確認します。
      await checkRoleplayConflict({ dept: f.部, who: tanto, plan: f.回収予定日, bukken: f.物件名, customer: cust });
    }

    return res.status(200).json({ success: true, id: data.id, target: target.label, trip });
  } catch (e) {
    console.error('[notion-create]', e);
    return res.status(500).json({ error: '通信エラーが発生しました', detail: e.message });
  }
}

/**
 * 部設定で「同じ部」の行を探す（部ごとに1行だけにするため）
 * 見つかればそのページIDを返し、無ければ null を返します。
 */
async function findDeptSetRow(apiKey, dbId, dept) {
  // 同じ部の行が2つ以上できてしまっている場合（通信が混み合って新しい行が作られた場合など）は、
  // いちばん最近更新された行を正として書き換え、残りはゴミ箱へ移して1行にまとめ直します。
  // 行が2つあると、読む側がどちらを使うかで古い名簿が表示されてしまうためです。
  const r = await nfetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method : 'POST',
    headers: {
      'Authorization' : 'Bearer ' + apiKey,
      'Notion-Version': '2022-06-28',
      'Content-Type'  : 'application/json',
    },
    body: JSON.stringify({ page_size: 20, filter: { property: '部', title: { equals: dept } },
                           sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] }),
  });
  if (!r.ok) throw new Error('部設定の行を探せませんでした（' + r.status + '）');
  const rows = (await r.json()).results || [];
  for (const old of rows.slice(1)) {
    try {
      await nfetch(`https://api.notion.com/v1/pages/${old.id}`, {
        method : 'PATCH',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body   : JSON.stringify({ archived: true }),
      });
    } catch (e) { /* 片付けに失敗しても保存は続けます */ }
  }
  return rows[0]?.id || null;
}

/**
 * 月間ボードで「同じ月・同じ部・同じ人・同じ種別」の行を探します。
 * 名前は空白・全角半角・異体字（鷥→鷺 など）の違いを無視して比べ、課が違っていても同じ人の行とみなします。
 * いちばん最近更新された行を row に、それ以外（重複）を dupes に入れて返します。
 */
const B_VARIANT = {'鷥':'鷺','髙':'高','﨑':'崎','嵜':'崎','邉':'辺','邊':'辺','澤':'沢','齋':'斉','齊':'斉','斎':'斉','濱':'浜','德':'徳','眞':'真','𠮷':'吉','廣':'広','國':'国','櫻':'桜','實':'実','藏':'蔵','壽':'寿','龍':'竜','瀨':'瀬','淵':'渕','冨':'富','凜':'凛','槇':'槙'};
const bNorm = v => [...String(v ?? '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu, '')].map(c => B_VARIANT[c] || c).join('');
// =====================================================
// ===== 月間ボードの実績（課ごとに1行） =====
//
// 以前は「1人×1種別」ごとに1行でしたが、1回の登録でNotionに10回前後問い合わせることになり、
// 混み合う時間帯に保存や読み込みが断られる（混線する）原因になっていました。
// いまは「部設定」データベースに、月・部・課ごとに1行（例：_board_2026-09_1部_川崎課）を作り、
// その課の全員の数字をまとめて入れています。1つの課を書くのは課長か部長だけなので、課の行ごと上書きしても混線しません。
//   保存：何項目変えても、Notionへの問い合わせは2回（読む・書く）
//   読み込み：全部署で約20行なので、1回で読み終わります
// 念のため、人×種別ごとに「入力を始めたときの数字（基準）」との差だけを足す仕組みも残しています。
//
// 行の中身（設定JSON）： { v:2, month, dept, course, at, m:{ 氏名:{ 契約:2, 新規:1, …, _t:{ 契約:更新時刻, … } } } }
// その月・その課の行がまだ無いときは、以前の「月間ボード実績」データベースの数字を自動で移し替えてから作ります。
// =====================================================
const boardKey = (month, dept, course) => `_board_${month}_${dept}_${course}`;
const clampN = v => Math.max(0, Math.min(9999, Math.round((Number(v) || 0) * 2) / 2));
async function nquery(apiKey, dbId, q, maxPages = 10) {
  const rows = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const r = await nfetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method : 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body   : JSON.stringify({ page_size: 100, ...q, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!r.ok) throw new Error('Notionの読み込みに失敗しました（' + r.status + '）');
    const data = await r.json();
    rows.push(...(data.results || []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return rows;
}
const newest = [{ timestamp: 'last_edited_time', direction: 'descending' }];
// ===== 契約済にする（同じ課のメンバーならだれでも） =====
// 変えるのは「種別」「物件名」「物件番号」だけです。お客様名・日付・担当者名などはそのまま残します。
// 変えてよい人：その予定の担当者本人／同じ課のメンバー／部長。
// 同じ課かどうかは、予定の「担当課」と、サイネージの名簿（部設定）の両方で確かめます
// （部署異動の前に登録された予定は、担当課が前の課のままのことがあるため）。
async function handleDone(apiKey, target, body, who) {
  const f = body.fields || {};
  const pageId = String(body.pageId || '').trim();
  if (!isPageId(pageId)) return { status: 400, json: { error: '予定が指定されていません' } };
  if (!who) return { status: 400, json: { error: '担当者名がありません。最初の設定をやり直してください' } };
  const type = pick(f.種別, TYPE_OPTIONS);
  if (!type) return { status: 400, json: { error: '種別が正しくありません' } };
  const api = (path, method, payload) => nfetch('https://api.notion.com/v1/' + path, {
    method, headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined });
  const r = await api(`pages/${pageId}`, 'GET');
  if (!r.ok) return { status: 404, json: { error: '予定が見つかりませんでした（すでに削除されている可能性があります）' } };
  const page = await r.json();
  if (page.archived) return { status: 410, json: { error: 'この予定はすでに削除されています' } };
  if (String(page.parent?.database_id || '').replace(/-/g, '') !== target.id) return { status: 403, json: { error: '登録先が一致しません' } };
  const owner = plain(page.properties?.['担当者名']);
  const myCourse = cut(f.担当課, 40).trim();
  let ok = bNorm(owner) === bNorm(who) || myCourse === '部長';
  if (!ok) {
    // まず名簿で、変える人と担当者が同じ課にいるかを確かめます。担当者が名簿にいないときだけ、予定の「担当課」で判断します
    let inRoster = false;
    try {
      const ds = await nquery(apiKey, TARGETS.deptset.id, { page_size: 5, filter: { property: '部', title: { equals: target.label } }, sorts: newest }, 1);
      const set = ds[0] ? parseCourseRow(ds[0]) : null;
      const inC = (c, n) => (c?.members || []).some(m => bNorm(m?.name) === bNorm(n));
      const courses = set && Array.isArray(set.courses) ? set.courses : [];
      inRoster = courses.some(c => inC(c, owner));
      if (inRoster) ok = courses.some(c => inC(c, who) && inC(c, owner));
    } catch (e) { console.error('[notion-create] done roster', e.message); }
    if (!inRoster && myCourse && bNorm(page.properties?.['担当課']?.select?.name) === bNorm(myCourse)) ok = true;
  }
  if (!ok) return { status: 403, json: { error: '同じ課のメンバーの予定だけ契約済にできます' } };
  const props = { '種別': sel(type) };
  if ('物件名' in f) props['物件名'] = text(f.物件名);
  if ('物件番号' in f) props['物件番号'] = text(f.物件番号);
  const u = await api(`pages/${pageId}`, 'PATCH', { properties: props });
  const data = await u.json();
  if (!u.ok) {
    console.error('[notion-create] done error:', JSON.stringify(data).slice(0, 500));
    return { status: 502, json: { error: 'Notionの更新に失敗しました', detail: data?.message || '' } };
  }
  // 月間ボードにも反映します（契約済→足す／取消→引く／部屋数の修正→差分だけ）
  let board = null;
  try { board = await applyApoToBoard(apiKey, target, data); }
  catch (e) { console.error('[notion-create] done→board', e); board = { ok: false, error: e.message }; }
  return { status: 200, json: { success: true, id: data.id, done: true, by: who, owner, board } };
}

// ===== 契約済のアポイントを月間ボードに反映 =====
// ・買い増し（集客手段が「買い増し」）は「契約」、それ以外は「新規」に、契約した部屋の数だけ足します
// ・数える先：アポイントの日付の月／担当者がいまの名簿で所属する課（名簿にいなければ予定の担当課。部長は「部長」の行）
// ・同じ予定を何度押しても二重にならないよう、課の行に「どの予定で何本足したか」の控え（apo）を残し、
//   変わった分だけを足し引きします（取消なら控えの分を引き、部屋数を直せば差分だけ）
const apoRooms = v => String(v || '').split(/[／\/]/).map(x => x.trim()).filter(Boolean).length;
async function applyApoToBoard(apiKey, target, page) {
  const dept = target.label;
  if (!BOARD_DEPTS.includes(dept)) return { ok: false, skipped: '部がボード対象外' };
  const pid = String(page.id || '').replace(/-/g, '');
  const pp = page.properties || {};
  const owner = plain(pp['担当者名']);
  const day = String(pp['日付']?.date?.start || '').slice(0, 10);
  if (!owner || !/^\d{4}-\d{2}/.test(day)) return { ok: false, skipped: '担当者名か日付がありません' };
  const month = day.slice(0, 7);
  const done = pp['種別']?.select?.name === '契約済';
  const kai = String(pp['集客手段']?.select?.name || '').includes('買い増し');
  const want = done ? { type: kai ? '契約' : '新規', n: Math.max(1, apoRooms(plain(pp['物件番号']))) } : null;
  // 担当者の課と、名簿の書き方の名前
  let course = '', name = owner;
  try {
    const ds = await nquery(apiKey, TARGETS.deptset.id, { page_size: 5, filter: { property: '部', title: { equals: dept } }, sorts: newest }, 1);
    const set = ds[0] ? parseCourseRow(ds[0]) : null;
    for (const c of (set?.courses || [])) {
      const m = (c?.members || []).find(x => bNorm(x?.name) === bNorm(owner));
      if (m) { course = String(c.name).trim(); name = String(m.name).trim(); break; }
    }
    if (!course && set?.bucho && bNorm(set.bucho) === bNorm(owner)) { course = '部長'; name = String(set.bucho).trim(); }
  } catch (e) { console.error('[notion-create] done→board roster', e.message); }
  if (!course) course = String(pp['担当課']?.select?.name || '').trim();
  if (!course) return { ok: false, skipped: '担当者の課が分かりません' };
  const key = boardKey(month, dept, course);
  const rows = await nquery(apiKey, TARGETS.deptset.id, { page_size: 20, filter: { property: '部', title: { equals: key } }, sorts: newest }, 1);
  const base = { v: 2, month, dept, course };
  let data;
  if (rows.length) {
    const parsed = rows.map(parseCourseRow);
    data = mergeCourseData(parsed, { ...parsed[0], ...base });
    data.apo = Object.assign({}, ...parsed.slice().reverse().map(d => (d.apo && typeof d.apo === 'object') ? d.apo : {}));
  } else data = await migrateCourse(apiKey, month, dept, course);
  data.apo = data.apo && typeof data.apo === 'object' ? data.apo : {};
  const had = data.apo[pid] || null;
  if (!had && !want) return { ok: true, changed: false };
  if (had && want && had.type === want.type && had.n === want.n && bNorm(had.name) === bNorm(name)) return { ok: true, changed: false, month, course, name, ...want };
  const now = Date.now();
  const nameOf = n => { const k = bNorm(n); return Object.keys(data.m).find(x => bNorm(x) === k) || n; };
  const add = (nm, type, d) => {
    const k = nameOf(nm), rec = data.m[k] || (data.m[k] = { _t: {} });
    rec._t = rec._t || {};
    rec[type] = clampN((Number(rec[type]) || 0) + d); rec._t[type] = now;
  };
  if (had) add(had.name || name, had.type, -had.n);
  if (want) { add(name, want.type, want.n); data.apo[pid] = { name, type: want.type, n: want.n, at: now }; }
  else delete data.apo[pid];
  data.at = now;
  const properties = { '部': title(key), '設定JSON': longText(JSON.stringify(data)) };
  const id = rows[0]?.id || null;
  const hdr = { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const r = await nfetch('https://api.notion.com/v1/' + (id ? `pages/${id}` : 'pages'), {
    method: id ? 'PATCH' : 'POST', headers: hdr,
    body: JSON.stringify(id ? { properties } : { parent: { database_id: TARGETS.deptset.id }, properties }),
  });
  if (!r.ok) { const out = await r.json().catch(() => ({})); return { ok: false, error: out?.message || String(r.status) }; }
  for (const d of rows.slice(1)) { try { await nfetch(`https://api.notion.com/v1/pages/${d.id}`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ archived: true }) }); } catch (e) {} }
  return { ok: true, changed: true, month, course, name, type: want?.type || had?.type, n: want?.n || 0, prev: had ? had.n : 0 };
}
function parseCourseRow(row) {
  try { const d = JSON.parse(plain(row.properties?.['設定JSON'])); if (d && typeof d === 'object') { d.m = d.m && typeof d.m === 'object' ? d.m : {}; return d; } }
  catch (e) {}
  return { m: {} };
}
// 同じ課の行が2つ以上あるとき（同時に作られた場合）は、人×種別ごとに新しいほうの数字を採って1つにまとめます
function mergeCourseData(list, base) {
  const out = { ...base, m: {} };
  const keyOf = {};
  for (const d of list) {
    for (const [name, rec] of Object.entries(d.m || {})) {
      const k = bNorm(name); if (!k) continue;
      const nm = keyOf[k] || (keyOf[k] = name);
      const o = out.m[nm] || (out.m[nm] = { _t: {} });
      for (const t of BOARD_TYPES) {
        if (!(t in rec)) continue;
        const ts = Number(rec._t?.[t]) || 0;
        if (!(t in o) || ts > (o._t[t] || 0)) {
          o[t] = clampN(rec[t]); o._t[t] = ts;
          if (rec._note?.[t]) (o._note = o._note || {})[t] = rec._note[t]; else if (o._note) delete o._note[t];
        }
      }
    }
  }
  return out;
}
// 以前の「月間ボード実績」データベースから、その課の今月の数字を集めます（最初の1回だけ）
async function migrateCourse(apiKey, month, dept, course) {
  // 名簿（部設定）で、その課のメンバーを確かめます
  let names = null, rosterName = {}, others = new Set();
  const ds = await nquery(apiKey, TARGETS.deptset.id, { page_size: 5, filter: { property: '部', title: { equals: dept } }, sorts: newest }, 1);
  const set = ds[0] ? parseCourseRow(ds[0]) : null;
  if (set && Array.isArray(set.courses)) {
    const c = set.courses.find(x => bNorm(x?.name) === bNorm(course));
    if (c) { names = new Set(); (c.members || []).forEach(m => { const k = bNorm(m?.name); if (k) { names.add(k); rosterName[k] = String(m.name).trim(); } }); }
    set.courses.forEach(x => { if (x !== c) (x?.members || []).forEach(m => { const k = bNorm(m?.name); if (k) others.add(k); }); });
  }
  const old = await nquery(apiKey, TARGETS.board.id, { filter: { and: [
    { property: '対象月', rich_text: { equals: month } }, { property: '部', select: { equals: dept } } ] }, sorts: newest });
  // 同じ人・同じ種別の記録が複数あるときは「課が同じ記録」→「新しい記録」の順で採ります
  const best = {};
  for (const p of old) {
    const nm = plain(p.properties?.['担当者名']), k = bNorm(nm), type = p.properties?.['種別']?.select?.name;
    if (!k || !BOARD_TYPES.includes(type)) continue;
    const same = bNorm(plain(p.properties?.['課'])) === bNorm(course) ? 1 : 0;
    // この課の名簿にいる人：課が同じ記録か、ほかの課に同じ名前の人がいなければ採ります（サイネージの表示と同じ決まり）
    // 名簿にいない人：課が同じで、ほかの課の名簿にもいないときだけ採ります（名簿から外れた人の数字も消さないように）
    const ok = !names ? same : names.has(k) ? (same || !others.has(k)) : (same && !others.has(k));
    if (!ok) continue;
    const t = Date.parse(p.last_edited_time || p.created_time || '') || 0;
    const id = k + '|' + type, cur = best[id];
    if (cur && (cur.same > same || (cur.same === same && cur.t >= t))) continue;
    best[id] = { k, nm, type, same, t, n: clampN(p.properties?.['件数']?.number) };
  }
  const m = {};
  for (const b of Object.values(best)) {
    const nm = rosterName[b.k] || b.nm;
    const o = m[nm] || (m[nm] = { _t: {} });
    o[b.type] = b.n; o._t[b.type] = b.t;
  }
  return { v: 2, month, dept, course, m, migrated: { at: Date.now(), rows: Object.keys(best).length } };
}
async function handleBoard(apiKey, body) {
  const f = body.fields || {};
  const dept   = pick(f.部, BOARD_DEPTS);
  const course = cut(f.課, 40).trim();
  const month  = cut(f.対象月, 7).trim();          // 例: 2026-09
  if (!dept || !course) return { status: 400, json: { error: '部・課が正しくありません' } };
  if (!/^\d{4}-\d{2}$/.test(month)) return { status: 400, json: { error: '対象月の形式が正しくありません' } };
  // まとめて送る形（items）と、1項目ずつ送る以前の形の両方を受け付けます
  const raw = Array.isArray(f.items) ? f.items.slice(0, 80) : (f.担当者名 !== undefined ? [f] : []);
  const items = [];
  for (const it of raw) {
    const name = cut(it?.担当者名, 60).trim(), type = pick(it?.種別, BOARD_TYPES);
    if (!name) return { status: 400, json: { error: '担当者名を入力してください' } };
    if (!type) return { status: 400, json: { error: '種別が正しくありません' } };
    const b = it.基準;
    items.push({ name, type, count: clampN(it.件数), base: (b === undefined || b === null || b === '' || !isFinite(Number(b))) ? null : Number(b),
                 note: typeof it.理由 === 'string' ? cut(it.理由, 100).trim() : null });
  }
  const ensure = body.action === 'ensure';
  if (!ensure && !items.length) return { status: 400, json: { error: '保存する数字がありません' } };

  const key = boardKey(month, dept, course);
  let rows, data;
  try { rows = await nquery(apiKey, TARGETS.deptset.id, { page_size: 20, filter: { property: '部', title: { equals: key } }, sorts: newest }, 1); }
  catch (e) { return { status: 502, json: { error: '保存先の確認に失敗しました。少し待ってもう一度お試しください', detail: e.message } }; }
  const base = { v: 2, month, dept, course };
  if (rows.length) data = mergeCourseData(rows.map(parseCourseRow), { ...parseCourseRow(rows[0]), ...base });
  else {
    // 以前のデータを読めないまま新しい行を作ると、今月の数字が0から始まってしまうので、読めないときは保存しません
    try { data = await migrateCourse(apiKey, month, dept, course); }
    catch (e) { return { status: 502, json: { error: '以前の数字の読み込みに失敗しました。少し待ってもう一度お試しください', detail: e.message } }; }
  }
  if (ensure && rows.length === 1) return { status: 200, json: { success: true, id: rows[0].id, data, exists: true } };

  const now = Date.now(), results = [];
  const nameOf = n => { const k = bNorm(n); return Object.keys(data.m).find(x => bNorm(x) === k) || n; };
  for (const it of items) {
    const nm = nameOf(it.name);
    const rec = data.m[nm] || (data.m[nm] = { _t: {} });
    rec._t = rec._t || {};
    const cur = Number(rec[it.type]) || 0;
    let val = it.count, merged = null;
    // 入力を始めたときの数字と、いまの数字が違う（ほかの人が同時に変えていた）ときは、増減した分だけを足します
    if (it.base !== null && cur !== it.base) { val = clampN(cur + (it.count - it.base)); merged = { before: cur, after: val }; }
    rec[it.type] = val; rec._t[it.type] = now;
    // カウントしない解約の理由（申請の控え）。本数が0になったら理由も消します
    if (it.note !== null || val === 0) {
      rec._note = rec._note || {};
      if (val > 0 && it.note) rec._note[it.type] = it.note; else delete rec._note[it.type];
      if (!Object.keys(rec._note).length) delete rec._note;
    }
    results.push({ 担当者名: nm, 種別: it.type, count: val, merged });
  }
  data.at = now;
  const properties = { '部': title(key), '設定JSON': longText(JSON.stringify(data)) };
  const id = rows[0]?.id || null;
  const r = await nfetch('https://api.notion.com/v1/' + (id ? `pages/${id}` : 'pages'), {
    method : id ? 'PATCH' : 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body   : JSON.stringify(id ? { properties } : { parent: { database_id: TARGETS.deptset.id }, properties }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[notion-create] board save error:', JSON.stringify(out).slice(0, 400));
    return { status: r.status === 429 ? 503 : 502, json: { error: 'Notionへの保存に失敗しました', detail: out?.message || String(r.status) } };
  }
  // 重複していた行はゴミ箱へ（中身は上でまとめ済みです。Notion側で復元もできます）
  for (const d of rows.slice(1)) {
    try { await nfetch(`https://api.notion.com/v1/pages/${d.id}`, { method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }) }); } catch (e) {}
  }
  return { status: 200, json: { success: true, id: out.id || id, target: '月間ボード', data, results,
    count: results[0]?.count, merged: results[0]?.merged || null } };
}

// =====================================================
// ===== ロープレ予定との重複チェック → LINE WORKSへ通知 =====
//
// ロープレの予約が入っている人が、同じ日に書類回収の担当にもなっていると、
// 書類回収を優先してロープレがドタキャンされてしまう事故が起きます。
// 書類回収が登録・確定された瞬間に、ロープレの予定表（ロープレタブと同じ
// Googleスプレッドシート）と回収担当者を突き合わせ、重なっていればLINE WORKS
// のグループに知らせます（checkRoleplayConflict、実体は ./_shared.js）。
// これは新規登録の瞬間だけの1回きりのチェックです。すでに登録済みの案件や、
// 登録後にロープレの予定表側が更新されたケースまでは拾えないため、
// 毎朝まとめてチェックする check-roleplay-conflicts.js（Vercel Cronで毎日実行）
// を別途用意しています。
//
// 【LINE WORKS通知を使うための設定】(未設定なら通知は送らず、他の機能にも影響しません)
// LINE WORKS公式の「Incoming Webhookアプリ」を使う方式にしています。
// Developer ConsoleでのBot登録やClient ID/Secret、秘密鍵などは一切不要です。
//
// 設定手順（社内の管理者権限が必要です）
//  1. LINE WORKSの管理画面 → 「アプリ」から「Incoming Webhook」アプリを追加する
//  2. 通知を送りたいトークルーム(グループ)を開き、「Bot招待」からIncoming Webhook Botを招待する
//  3. そのトークルームのメニューから「Channel ID」を確認しておく
//  4. Incoming Webhookアプリの「Webhookリスト」で、名前とそのChannel IDを指定して新規発行する
//  5. 発行されたWebhook URL（https://webhook.worksmobile.com/message/…）を、
//     Vercelの環境変数 LW_WEBHOOK_URL にそのまま設定する
//
//   LW_WEBHOOK_URL … 上記4で発行したWebhook URL。これ1つだけで通知が送れます。
// =====================================================
