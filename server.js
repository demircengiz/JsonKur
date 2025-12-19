import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({
  connectTimeout: 20000,
  headersTimeout: 20000,
  bodyTimeout: 20000,
}));

import express from "express";
const app = express();

app.get("/altin", async (req, res) => {
  try {
    const r = await fetch(
      "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json,text/plain,*/*",
          "Referer": "https://canlipiyasalar.haremaltin.com/",
        },
      }
    );

    const text = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        status: r.status,
        body: text.slice(0, 200),
      });
    }

    res.json(JSON.parse(text));
  } catch (err) {
    console.error("FETCH_ERR:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(process.env.PORT || 3000);
