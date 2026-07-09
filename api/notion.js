export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method==='OPTIONS'){ res.status(200).end(); return; }

  const API_KEY = process.env.NOTION_API_KEY;

  // bodyのパース
  let parsed;
  try {
    if(typeof req.body === 'string') {
      parsed = JSON.parse(req.body);
    } else {
      parsed = req.body;
    }
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const dbId = parsed?.dbId;
  const filter = parsed?.filter;

  if(!dbId) {
    return res.status(400).json({ error: 'dbId is required' });
  }

  try {
    // 100件超のDBに対応するため、has_moreがある限り全ページを取得して結合する
    let results = [];
    let cursor;
    let data;
    do {
      const body = { page_size: 100 };
      if(filter) body.filter = filter;
      if(cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + API_KEY,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      data = await r.json();
      if(!r.ok) {
        return res.status(r.status).json(data);
      }
      results = results.concat(data.results || []);
      cursor = data.next_cursor;
    } while(data.has_more && cursor && results.length < 1000);
    res.status(200).json({ ...data, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
