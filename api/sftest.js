// =====================================================
// Salesforce連携テスト用ページ
//
// ブラウザで /api/sftest を開くだけで、Salesforce接続の
// 状態を確認できます（F12のコンソール操作は不要）。
//
// 4種類のレポートすべてに接続を試み、成功/失敗と
// レポートの列構造を人間が読める形で表示します。
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
      SF_CLIENT_ID: CLIENT_ID ? '設定済み' : '★未設定',
      SF_CLIENT_SECRET: CLIENT_SECRET ? '設定済み' : '★未設定',
      SF_LOGIN_URL: LOGIN_URL,
      QUOTAGUARD_URL: QUOTAGUARD_URL ? '設定済み' : '★未設定',
      レポートID: Object.fromEntries(
        Object.entries(REPORT_IDS).map(([k, v]) => [k, v || '★未設定'])
      ),
    },
    手順2_接続経路: dispatcher ? 'QuotaGuardプロキシ経由' : '★直接接続（プロキシ未使用）',
  };

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

  // ===== 各レポートを取得 =====
  result.手順4_レポート取得 = {};
  for (const key of REPORT_KEYS) {
    const reportId = REPORT_IDS[key];
    if (!reportId) {
      result.手順4_レポート取得[key] = { 状態: '★レポートIDが未設定' };
      continue;
    }
    try {
      const r = await sfFetch(
        `${instanceUrl}/services/data/v58.0/analytics/reports/${reportId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const text = await r.text();
      if (!r.ok) {
        result.手順4_レポート取得[key] = { 状態: '★失敗', 詳細: text.slice(0, 300) };
        continue;
      }
      result.手順4_レポート取得[key] = summarizeReport(JSON.parse(text));
    } catch (e) {
      result.手順4_レポート取得[key] = { 状態: '★失敗（通信エラー）', 詳細: e.message };
    }
  }

  result.次にやること =
    '手順4がすべて「成功」なら、この画面の内容をそのままAIに貼り付けてください。列の並びに合わせて画面表示を調整します。';
  result.確認日時 = new Date().toISOString();

  return res.status(200).json(result);
}

// 認証エラーの内容から原因を推測して案内する
function judgeAuthError(text) {
  if (text.includes('ip restricted'))
    return 'SalesforceのIP許可リストに 52.192.89.194 が登録されていません。プロファイルの「ログインIPアドレスの制限」と、接続アプリの「IPの緩和」設定を確認してください。';
  if (text.includes('invalid_client'))
    return 'SF_CLIENT_ID または SF_CLIENT_SECRET の値が違います。Salesforceの接続アプリで再確認してください。';
  if (text.includes('unsupported_grant_type'))
    return '接続アプリで「クライアントクレデンシャルフロー」が有効になっていません。接続アプリの設定を確認してください。';
  if (text.includes('inactive_user') || text.includes('user hasn'))
    return '接続アプリの「実行ユーザー」が設定されていないか、無効なユーザーです。接続アプリの「管理」画面で実行ユーザーを指定してください。';
  return 'エラー詳細をそのままAIに貼り付けてください。';
}

// レポートの構造を人間が読める形にまとめる
function summarizeReport(report) {
  const meta = report.reportMetadata || {};
  const factMap = report.factMap || {};

  // 明細行を1件だけ抜き出して、列の並びを見せる
  let sampleRow = null;
  for (const key of Object.keys(factMap)) {
    const rows = factMap[key]?.rows || [];
    if (rows.length > 0) {
      sampleRow = rows[0].dataCells.map((c, i) => ({
        列番号: i,
        表示値: c.label,
        数値: c.value,
      }));
      break;
    }
  }

  const totalRows = Object.values(factMap).reduce(
    (n, v) => n + (v?.rows?.length || 0),
    0
  );

  return {
    状態: '成功',
    レポート名: meta.name,
    レポート形式: meta.reportFormat,
    明細行数: totalRows,
    列の並び: (meta.detailColumns || []).map((c, i) => `${i}: ${c}`),
    集計項目: (meta.aggregates || []).map((c, i) => `${i}: ${c}`),
    グループ化: (meta.groupingsDown || []).map(g => g.name),
    サンプル1行目: sampleRow,
  };
}
