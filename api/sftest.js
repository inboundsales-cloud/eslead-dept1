// =====================================================
// Salesforce連携テスト・レポート構造確認ページ
//
// 【使い方】
//  1) 接続だけ確認したいとき
//       /api/sftest
//  2) ダッシュボードの元レポート一覧を調べたいとき
//       /api/sftest?reportId=01ZXXXXXXXXXXXXXXX
//     ダッシュボードID(01Zで始まるもの)を渡すと、
//     そこで使われているレポートの名前とIDを一覧で返します。
//     次に開くべきURLも組み立てて表示します。
//  3) レポートの中身を確認したいとき
//       /api/sftest?reportId=00OXXXXXXXXXXXXXXX
//     複数のレポートをまとめて調べたいときはカンマ区切りで
//       /api/sftest?reportId=00OAAAAAAAA,00OBBBBBBBB
//     （1回で調べられるのは5本までです）
//
// 環境変数のレポートIDを設定していなくても reportId を
// 直接渡せるので、構造を先に確認したいときに使えます。
// 表示された内容をそのままAIに貼り付けてください。
// =====================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';
 
const REPORT_KEYS = ['annual_personal', 'q3_personal', 'annual_course', 'q3_course'];
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
 
  const CLIENT_ID      = process.env.SF_CLIENT_ID;
  const CLIENT_SECRET  = process.env.SF_CLIENT_SECRET;
  const LOGIN_URL      = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL;
 
  // URLで指定されたレポートID（例: /api/sftest?reportId=00O...,00O...）
  const askedIds = String(req.query?.reportId || '')
    .split(',').map(s => s.trim()).filter(Boolean);
 
  const REPORT_IDS = {
    annual_personal : process.env.SF_REPORT_ANNUAL_PERSONAL,
    q3_personal     : process.env.SF_REPORT_Q3_PERSONAL,
    annual_course   : process.env.SF_REPORT_ANNUAL_COURSE,
    q3_course       : process.env.SF_REPORT_Q3_COURSE,
  };
 
  let dispatcher;
  try {
    dispatcher = QUOTAGUARD_URL ? new ProxyAgent(QUOTAGUARD_URL) : undefined;
  } catch (e) {
    dispatcher = undefined;
  }
  const sfFetch = (url, options = {}) =>
    dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);
 
  const result = {
    手順1_環境変数: {
      SF_CLIENT_ID    : CLIENT_ID     ? '設定済み' : '★未設定',
      SF_CLIENT_SECRET: CLIENT_SECRET ? '設定済み' : '★未設定',
      SF_LOGIN_URL    : LOGIN_URL,
      QUOTAGUARD_URL  : QUOTAGUARD_URL ? '設定済み' : '★未設定',
      レポートID: Object.fromEntries(
        Object.entries(REPORT_IDS).map(([k, v]) => [k, v || '未設定'])
      ),
    },
    手順2_接続経路: dispatcher ? 'QuotaGuardプロキシ経由' : '★直接接続（プロキシ未使用）',
  };
 
  // 指定されたIDをダッシュボード(01Z)とレポート(00O)に仕分ける
  const dashboardIds = askedIds.filter(id => id.startsWith('01Z'));
  const reportIds    = askedIds.filter(id => id.startsWith('00O'));
  const unknownIds   = askedIds.filter(id => !id.startsWith('01Z') && !id.startsWith('00O'));
  if (unknownIds.length) {
    result['★注意'] = `次のIDは形式が想定と違います（レポートは00O、ダッシュボードは01Zで始まります）: ${unknownIds.join(', ')}`;
  }
 
  // ===== Salesforce認証 =====
  let accessToken, instanceUrl;
  try {
    const tokenRes = await sfFetch(`${LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
 
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      result.手順3_認証 = '★失敗';
      result.エラー詳細 = text;
      result.次にやること = judgeAuthError(text);
      return res.status(200).json(result);
    }
 
    const tokenData = JSON.parse(text);
    accessToken = tokenData.access_token;
    instanceUrl = tokenData.instance_url;
    result.手順3_認証 = '成功';
    result.接続先 = instanceUrl;
  } catch (e) {
    result.手順3_認証 = '★失敗（通信エラー）';
    result.エラー詳細 = e.message;
    return res.status(200).json(result);
  }
 
  const getReport = async (id) => {
    const r = await sfFetch(
      `${instanceUrl}/services/data/v58.0/analytics/reports/${id}?includeDetails=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const text = await r.text();
    if (!r.ok) throw new Error(text.slice(0, 400));
    return JSON.parse(text);
  };
 
  const getDashboardMeta = async (id) => {
    const r = await sfFetch(
      `${instanceUrl}/services/data/v58.0/analytics/dashboards/${id}/describe`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const text = await r.text();
    if (!r.ok) throw new Error(text.slice(0, 400));
    return JSON.parse(text);
  };
 
  // ===== A) ダッシュボードIDが指定された場合：元レポートの一覧を返す =====
  if (dashboardIds.length) {
    result.手順4_ダッシュボードの中身 = {};
    const found = [];
    for (const id of dashboardIds) {
      try {
        const info = listDashboardReports(await getDashboardMeta(id));
        result.手順4_ダッシュボードの中身[id] = info;
        info.元レポート一覧.forEach(r => {
          if (r.レポートID && !found.includes(r.レポートID)) found.push(r.レポートID);
        });
      } catch (e) {
        result.手順4_ダッシュボードの中身[id] = { 状態: '★失敗', 詳細: String(e.message).slice(0, 400) };
      }
    }
    if (found.length) {
      result.次にやること = `元レポートが${found.length}本見つかりました。下の「次に開くURL」を順に開いて、その内容をAIに貼り付けてください。`;
      // 5本ずつに分けて、そのまま開けるURLを組み立てる
      result.次に開くURL = [];
      for (let i = 0; i < found.length; i += 5) {
        result.次に開くURL.push(`/api/sftest?reportId=${found.slice(i, i + 5).join(',')}`);
      }
    } else {
      result.次にやること = 'このダッシュボードから元レポートを特定できませんでした。この画面の内容をそのままAIに貼り付けてください。';
    }
    result.確認日時 = new Date().toISOString();
    return res.status(200).json(result);
  }
 
  // ===== B) レポートIDが指定された場合：中身を詳しく調べる =====
  if (reportIds.length) {
    const targets = reportIds.slice(0, 5); // 時間切れを防ぐため1回5本まで
    result.手順4_レポート構造 = {};
    for (const id of targets) {
      try {
        result.手順4_レポート構造[id] = inspectReport(await getReport(id));
      } catch (e) {
        result.手順4_レポート構造[id] = { 状態: '★失敗', 詳細: String(e.message).slice(0, 400) };
      }
    }
    result.次にやること = reportIds.length > 5
      ? `この画面の内容をAIに貼り付けたうえで、残りも同じ要領で確認してください: /api/sftest?reportId=${reportIds.slice(5, 10).join(',')}`
      : 'この画面の内容をそのままAIに貼り付けてください。グループ構成と列の並びに合わせて、取り込み処理を組み立てます。';
    result.確認日時 = new Date().toISOString();
    return res.status(200).json(result);
  }
 
  // ===== B) 指定なしの場合：環境変数の4本を順に確認する =====
  result.手順4_レポート取得 = {};
  let any = false;
  for (const key of REPORT_KEYS) {
    const reportId = REPORT_IDS[key];
    if (!reportId) { result.手順4_レポート取得[key] = { 状態: 'レポートIDが未設定' }; continue; }
    any = true;
    try {
      result.手順4_レポート取得[key] = inspectReport(await getReport(reportId));
    } catch (e) {
      result.手順4_レポート取得[key] = { 状態: '★失敗', 詳細: String(e.message).slice(0, 300) };
    }
  }
 
  result.次にやること = any
    ? 'この画面の内容をそのままAIに貼り付けてください。'
    : 'レポートIDが未設定です。URLの末尾に ?reportId=00O... を付けて、調べたいレポートを直接指定してください。';
  result.確認日時 = new Date().toISOString();
  return res.status(200).json(result);
}
 
// 認証エラーの内容から原因を推測して案内する
function judgeAuthError(text) {
  if (text.includes('ip restricted'))
    return 'SalesforceのIP許可リストに、QuotaGuardの静的IPが登録されていません。/api/myip で表示されるIPを、プロファイルの「ログインIPアドレスの制限」と接続アプリの「IPの緩和」設定に登録してください。';
  if (text.includes('invalid_client'))
    return 'SF_CLIENT_ID または SF_CLIENT_SECRET の値が違います。Salesforceの接続アプリで再確認してください。';
  if (text.includes('unsupported_grant_type'))
    return '接続アプリで「クライアントクレデンシャルフロー」が有効になっていません。接続アプリの設定を確認してください。';
  if (text.includes('inactive_user') || text.includes('user hasn'))
    return '接続アプリの「実行ユーザー」が設定されていないか、無効なユーザーです。接続アプリの「管理」画面で実行ユーザーを指定してください。';
  return 'エラー詳細をそのままAIに貼り付けてください。';
}
 
// =====================================================
// ダッシュボードの構成要素から、元になっているレポートを拾い出す
//
// ダッシュボードは「コンポーネント（グラフ1つ1つ）」の集まりで、
// それぞれが reportId を持っています。同じレポートを複数のグラフで
// 使っていることも多いので、重複はまとめて返します。
// =====================================================
function listDashboardReports(meta) {
  const dm = meta?.dashboardMetadata || meta || {};
 
  // 構成要素はバージョンによって置き場所が違うことがあるため、
  // 想定しうる場所をすべて見てから、それでも見つからなければ全体を探索する
  let components = [];
  if (Array.isArray(dm.components)) components = dm.components;
  else if (Array.isArray(dm.componentData)) {
    components = dm.componentData.flatMap(c => c.components || [c]);
  }
  if (!components.length) components = deepFindComponents(meta);
 
  const seen = new Map();
  components.forEach(c => {
    const id = c.reportId || c.report?.id;
    if (!id) return;
    const name = c.reportName || c.report?.name || c.header || c.title || '(名称不明)';
    if (seen.has(id)) seen.get(id).使用グラフ数 += 1;
    else seen.set(id, { レポート名: name, レポートID: id, 使用グラフ数: 1 });
  });
 
  return {
    状態: '成功',
    ダッシュボード名: dm.name || dm.label || '(名称不明)',
    グラフの数: components.length,
    元レポート本数: seen.size,
    元レポート一覧: [...seen.values()],
  };
}
 
// 構造が想定と違う場合の保険：reportIdを持つオブジェクトを再帰的に探す
function deepFindComponents(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  if (obj.reportId) out.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFindComponents(v, depth + 1, out);
  }
  return out;
}
 
// =====================================================
// レポートの構造を、人間が読める形にまとめる
//
// 確認したいのは主に次の3点です。
//   ・どの項目でグループ化されているか（何段構成か）
//   ・集計項目に何が入っているか（年間・3ヶ月の金額はどれか）
//   ・グループの見出しが実際にどんな文字列か（役職や課長名が入るか）
// =====================================================
function inspectReport(report) {
  const meta    = report.reportMetadata || {};
  const ext     = report.reportExtendedMetadata || {};
  const aggKeys = meta.aggregates || [];
  const aggInfo = ext.aggregateColumnInfo || {};
  const grpInfo = ext.groupingColumnInfo || {};
  const factMap = report.factMap || {};
 
  // 集計項目の一覧（この0番目、1番目…の並び順がそのままfactMapの並び順）
  const aggList = aggKeys.map((k, i) =>
    `${i}: ${aggInfo[k]?.label || k}（API名 ${k} / ${aggInfo[k]?.dataType || '型不明'}）`
  );
 
  // グループ化の段構成
  const grpDefs = (meta.groupingsDown || []).map((g, i) =>
    `${i + 1}段目: ${grpInfo[g.name]?.label || g.name}（API名 ${g.name}）`
  );
 
  // グループの木構造をたどって、実際の見出しと集計値を抜き出す
  // factMapのキーは1段目が "0!T"、2段目が "0_0!T" という形になります
  const tree = [];
  const walk = (groups, prefix, depth) => {
    if (!groups || depth > 2) return;
    groups.slice(0, 3).forEach(g => {
      const path = prefix ? `${prefix}_${g.key}` : String(g.key);
      const agg  = factMap[`${path}!T`]?.aggregates || [];
      tree.push({
        段: depth + 1,
        グループ見出し: g.label,
        集計値: agg.map((a, i) => `${i}: ${a.label ?? a.value}`),
      });
      walk(g.groupings, path, depth + 1);
    });
  };
  walk(report.groupingsDown?.groupings, '', 0);
 
  // 明細行が1行でもあれば、列の並びが分かるので添える
  let sampleRow = null;
  for (const key of Object.keys(factMap)) {
    const rows = factMap[key]?.rows || [];
    if (rows.length) {
      sampleRow = rows[0].dataCells.map((c, i) => ({ 列番号: i, 表示値: c.label, 数値: c.value }));
      break;
    }
  }
 
  const totalRows = Object.values(factMap).reduce((n, v) => n + (v?.rows?.length || 0), 0);
 
  return {
    状態: '成功',
    レポート名: meta.name,
    レポート形式: meta.reportFormat,
    グループ化の構成: grpDefs.length ? grpDefs : ['★グループ化されていません（サマリー形式ではない可能性があります）'],
    集計項目: aggList.length ? aggList : ['★集計項目がありません'],
    明細列の並び: (meta.detailColumns || []).map((c, i) => `${i}: ${ext.detailColumnInfo?.[c]?.label || c}`),
    最上位グループ数: (report.groupingsDown?.groupings || []).length,
    明細行数: totalRows,
    レポート全体の合計: (factMap['T!T']?.aggregates || []).map((a, i) => `${i}: ${a.label ?? a.value}`),
    グループ見出しの実例: tree.length ? tree : ['★グループが取得できませんでした'],
    サンプル明細1行目: sampleRow,
  };
}
 
















