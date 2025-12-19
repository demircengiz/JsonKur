import axios from "axios";

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await axios.get(url, {
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Render; Node.js)",
          "Accept": "application/json,text/plain,*/*",
          "Referer": "https://canlipiyasalar.haremaltin.com/",
        },
        validateStatus: () => true,
      });

      if (r.status === 200) return r.data;

      // 429 ise bekle (backoff)
      if (r.status === 429) {
        await new Promise(s => setTimeout(s, 1500 * (i + 1)));
        continue;
      }

      // 403 ise retry genelde faydasız; yine de 1 kez dene
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
      await new Promise(s => setTimeout(s, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

const url = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
