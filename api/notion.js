export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method==='OPTIONS'){ res.status(200).end(); return; }
  const API_KEY = process.env.NOTION_API_KEY;
  const { dbId, filter } = req.body;
  try {
    const body = { page_size: 100 };
    if(filter) body.filter = filter;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {'Authorization':'Bearer '+API_KEY,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
}
