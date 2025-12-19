import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";

// Basit memory cache (rate-limit yememek için)
let cache = null;
let cacheAt = 0;
const TTL_MS = 10_000; // 10 saniye (gerekirse 30-60 yap)

async function fetchWithHeaders(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: "GET",
      // WAF'lar için kritik headerlar:
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://canlipiyasalar.haremaltin.com/",
        "Origin": "https://canlipiyasalar.haremaltin.com",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      signal: controller.signal,
    });

    const text = await res.text(); // JSON değilse bile body’yi görmek için
    return { status: res.status, headers: Object.fromEntries(res.headers), text };
  } finally {
    clearTimeout(t);
  }
}

async function getData() {
  // cache
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;

  // retry (özellikle 429/5xx için)
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    const out = await fetchWithHeaders(SOURCE_URL);

    if (out.status === 200) {
      const json = JSON.parse(out.text);
      cache = json;
      cacheAt = Date.now();
      return json;
    }

    // 403 ise genelde IP/WAF -> tekrar denemenin faydası az ama 1-2 kez deniyoruz
    if (out.status === 429 || (out.status >= 500 && out.status <= 599)) {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      continue;
    }

    // Hata detayını dışarı ver (debug)
    throw new Error(
      `Upstream error: ${out.status} body_snippet=${out.text.slice(0, 200)}`
    );
  }

  throw new Error("Upstream failed after retries.");
}

// Proxy endpoint
app.get("/api/altin", async (req, res) => {
  try {
    const json = await getData();
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json(json);
  } catch (e) {
    res.status(502).json({
      success: false,
      error: String(e.message || e),
    });
  }
});

app.get("/", (req, res) => res.send("OK /api/altin"));

app.listen(PORT, () => console.log("Listening on", PORT));
