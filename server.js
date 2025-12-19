import express from "express";

const app = express();

app.get("/test", async (req, res) => {
  const url = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Render; Node.js)",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://canlipiyasalar.haremaltin.com/",
        "Origin": "https://canlipiyasalar.haremaltin.com",
      },
    });

    const text = await r.text();

    console.log("STATUS:", r.status);
    console.log("HEADERS:", Object.fromEntries(r.headers.entries()));
    console.log("BODY_SNIPPET:", text.slice(0, 200));

    // JSON ise parse edip döndür
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }

    res.json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    console.error("FETCH_ERR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(process.env.PORT || 3000);
