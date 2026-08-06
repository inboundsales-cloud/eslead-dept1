// =====================================================
// 発信元IPアドレス確認API
//
// ブラウザで /api/myip を開くと、Vercelから外部へ出ていく
// ときのIPアドレスが表示されます。
//
// QUOTAGUARD_URL が設定されていれば、QuotaGuardプロキシ
// 経由のIP（＝SalesforceのIP許可リストに登録すべきIP）と、
// プロキシを通さない場合のIPの両方を返します。
// 2つが違っていればプロキシが正しく効いています。
// =====================================================
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const IPIFY = 'https://api.ipify.org?format=json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL;

  // プロキシを通さない場合のIP
  let directIp = null;
  let directError = null;
  try {
    const r = await fetch(IPIFY);
    directIp = (await r.json()).ip;
  } catch (e) {
    directError = e.message;
  }

  // プロキシ経由のIP（QUOTAGUARD_URL 未設定ならスキップ）
  let proxyIp = null;
  let proxyError = null;
  if (QUOTAGUARD_URL) {
    try {
      const dispatcher = new ProxyAgent(QUOTAGUARD_URL);
      const r = await undiciFetch(IPIFY, { dispatcher });
      proxyIp = (await r.json()).ip;
    } catch (e) {
      proxyError = e.message;
    }
  }

  const proxyConfigured = Boolean(QUOTAGUARD_URL);
  const proxyWorking = proxyConfigured && Boolean(proxyIp) && proxyIp !== directIp;

  res.status(200).json({
    // SalesforceのIP許可リストに登録すべきIP
    whitelistThisIp: proxyIp || directIp,
    proxyWorking,
    proxyConfigured,
    proxyIp,
    directIp,
    errors: (directError || proxyError) ? { direct: directError, proxy: proxyError } : undefined,
    hint: !proxyConfigured
      ? 'QUOTAGUARD_URL が未設定です。Vercelの環境変数に登録してください。'
      : proxyWorking
        ? 'プロキシ経由で接続できています。whitelistThisIp をSalesforceのIP許可リストに登録してください。'
        : 'プロキシが効いていません。QUOTAGUARD_URL の値とエラー内容を確認してください。',
    checkedAt: new Date().toISOString(),
  });
}
