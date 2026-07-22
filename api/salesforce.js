export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Vercel環境のIP情報を取得(デバッグ用)
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['cf-connecting-ip'] ||
                   req.socket?.remoteAddress ||
                   'unknown';
  const vercelEnv = process.env.VERCEL_ENV || 'unknown';
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 8) || 'unknown';

  const CLIENT_ID     = process.env.SF_CLIENT_ID;
  const CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
  const LOGIN_URL     = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

  const REPORT_IDS = {
    annual_personal : process.env.SF_REPORT_ANNUAL_PERSONAL,
    q3_personal     : process.env.SF_REPORT_Q3_PERSONAL,
    annual_course   : process.env.SF_REPORT_ANNUAL_COURSE,
    q3_course       : process.env.SF_REPORT_Q3_COURSE,
  };

  // リクエストボディのパース
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const reportKey = body?.reportKey; // 'annual_personal' など
  const reportId  = REPORT_IDS[reportKey];

  if (!reportKey || !reportId) {
    return res.status(400).json({ error: 'reportKey が不正です', validKeys: Object.keys(REPORT_IDS) });
  }

  try {
    // ① Salesforce OAuth2.0 認証（Client Credentials フロー）
    const tokenRes = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type   : 'client_credentials',
        client_id    : CLIENT_ID,
        client_secret: CLIENT_SECRET,
      })
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(500).json({ error: 'SF認証失敗', detail: err, debug: { clientIp, vercelEnv, deploymentId } });
    }

    const tokenData    = await tokenRes.json();
    const accessToken  = tokenData.access_token;
    const instanceUrl  = tokenData.instance_url;

    // ② レポートデータ取得
    const reportRes = await fetch(
      `${instanceUrl}/services/data/v58.0/analytics/reports/${reportId}`,
      {
        method : 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type' : 'application/json',
        }
      }
    );

    if (!reportRes.ok) {
      const err = await reportRes.text();
      return res.status(500).json({ error: 'レポート取得失敗', detail: err, debug: { clientIp, vercelEnv, deploymentId } });
    }

    const reportData = await reportRes.json();

    // ③ データを整形してフロントエンドに返す
    const formatted = formatReport(reportData, reportKey);
    return res.status(200).json({
      success: true,
      data: formatted,
      raw: reportData,
      debug: { clientIp, vercelEnv, deploymentId, timestamp: new Date().toISOString() }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message, debug: { clientIp, vercelEnv, deploymentId } });
  }
}

/**
 * Salesforceのレポートデータを整形する
 * レポートキーに応じてダッシュボード形式に変換
 */
function formatReport(reportData, reportKey) {
  try {
    const factMap      = reportData.factMap || {};
    const columns      = reportData.reportMetadata?.detailColumns || [];
    const groupings    = reportData.groupingsDown?.groupings || [];

    // 個人ランキング系（明細レポート）年間・3ヶ月
    if (reportKey.includes('personal')) {
      const rows = [];
      Object.keys(factMap).forEach(key => {
        if (!key.endsWith('!T')) return; // 合計行をスキップ
        const cells = factMap[key]?.dataCells || [];
        if (cells.length === 0) return;

        // ※ 列の順番はレポートの設定によって異なります
        // ユーザーのレポートに合わせてインデックスを調整してください
        // 例: [氏名, 年間実績, 3ヶ月実績] など
        const name = cells[0]?.label || cells[0]?.value || '';
        const amount1 = cells[1]?.value || 0;
        const amount2 = cells[2]?.value || 0;

        // reportKey に応じて amount を振り分け
        const isAnnual = reportKey.includes('annual');
        rows.push({
          name,
          annual: isAnnual ? amount1 : amount2,
          q3: isAnnual ? amount2 : amount1
        });
      });

      // 年間実績で降順ソート + 上位15名に制限
      rows.sort((a, b) => Number(b.annual) - Number(a.annual));
      return rows.slice(0, 15);
    }

    // 課別ランキング系（集計レポート）年間・3ヶ月
    if (reportKey.includes('course')) {
      const rows = [];
      groupings.forEach(group => {
        const key    = group.key + '!T';
        const cells  = factMap[key]?.dataCells || [];

        const amount1 = cells[0]?.value || 0;
        const amount2 = cells[1]?.value || 0;
        const isAnnual = reportKey.includes('annual');

        rows.push({
          name  : group.label || '',        // 課名
          dept  : '',                        // 部名（レポートに含まれる場合は調整）
          chief : '',                        // 課長名（レポートに含まれる場合は調整）
          annual: isAnnual ? amount1 : amount2,
          q3: isAnnual ? amount2 : amount1
        });
      });

      rows.sort((a, b) => Number(b.annual) - Number(a.annual));
      return rows;
    }

    return [];
  } catch(e) {
    console.error('formatReport error:', e);
    return [];
  }
}
