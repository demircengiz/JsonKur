import express from "express";
import sql from "mssql";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";
import dns from "node:dns";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// DNS: bazı ortamlarda IPv6 kaynaklı fetch sorunlarını azaltmak için IPv4'ü öncele
dns.setDefaultResultOrder("ipv4first");

app.set("trust proxy", 1);

// Basit Request-ID (log/debug için)
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});

// Güvenlik header'ları (hafif)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// Basit rate limit (IP bazlı)
const __rateMap = new Map();
app.use((req, res, next) => {
  const ip =
    (req.headers["x-forwarded-for"]?.toString().split(",")[0] || "").trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const windowMs = 60_000; // 1 dk
  const limit = Number(process.env.RATE_LIMIT_PER_MIN || 180); // varsayılan 180/dk

  const entry = __rateMap.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count++;
  __rateMap.set(ip, entry);

  if (entry.count > limit) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  next();
});

// CORS ve JSON middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

// Render: PORT env var'ını dinlemelisin
const PORT = process.env.PORT || 3000;

// ENV'den al
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_HOST, // örn: "1.2.3.4" veya "sql.domain.com"
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 1433,
  options: {
    encrypt: false, // Azure SQL ise genelde true gerekir
    trustServerCertificate: true, // self-signed / cert problemi varsa
    enableArithAbort: true,
    requestTimeout: 30000,
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let poolPromise = null;
let dbConnected = false;

async function getPool() {
  if (!poolPromise) {
    try {
      poolPromise = sql.connect(dbConfig);
      await poolPromise;
      dbConnected = true;
      console.log("SQL Server bağlantısı başarılı");
    } catch (err) {
      dbConnected = false;
      console.error("SQL Server bağlantı hatası:", err.message);
      throw err;
    }
  }
  return poolPromise;
}

// fetch yardımcıları: timeout + retry (upstream'ler geçici düşebilir)
async function fetchWithTimeout(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonRetry(url, { timeoutMs = 15000, headers = {}, tries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs, headers });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // fetch failed gibi durumlarda asıl sebep çoğunlukla err.cause içindedir (ENOTFOUND/ECONNRESET/timeout vb.)
      console.warn(`[fetchJsonRetry] ${url} attempt=${i} msg=${err?.message}`, "cause:", err?.cause);
      await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
  throw lastErr;
}

// ISO formatında tarih-saat döndürme (Türkiye saati)
function getCurrentDateTimeISO() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  const hours = parts.find((p) => p.type === "hour").value;
  const minutes = parts.find((p) => p.type === "minute").value;
  const seconds = parts.find((p) => p.type === "second").value;

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// JSON dosya yolları
const kurlarFilePath = path.join(__dirname, "kurlar.json");
const koprubasiFilePath = path.join(__dirname, "koprubasi.json");
const haremAltinFilePath = path.join(__dirname, "haremaltin.json");
const tcmbFilePath = path.join(__dirname, "tcmb.json");

// EskisehirDöviz JSON dosyasını oku
function readKurlarFromFile() {
  try {
    if (fs.existsSync(kurlarFilePath)) {
      const data = fs.readFileSync(kurlarFilePath, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("kurlar.json okuma hatası:", err.message);
  }
  return {};
}

// EskisehirDöviz JSON dosyasına yaz
function writeKurlarToFile(data) {
  try {
    fs.writeFileSync(kurlarFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("kurlar.json yazma hatası:", err.message);
  }
}

// Koprubasi JSON dosyasını oku
function readKoprubasiFromFile() {
  try {
    if (fs.existsSync(koprubasiFilePath)) {
      const data = fs.readFileSync(koprubasiFilePath, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("koprubasi.json okuma hatası:", err.message);
  }
  return {};
}

// Koprubasi JSON dosyasına yaz
function writeKoprubasiToFile(data) {
  try {
    fs.writeFileSync(koprubasiFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("koprubasi.json yazma hatası:", err.message);
  }
}

// HaremAltin JSON dosyasını oku
function readHaremAltinFromFile() {
  try {
    if (fs.existsSync(haremAltinFilePath)) {
      const data = fs.readFileSync(haremAltinFilePath, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("haremaltin.json okuma hatası:", err.message);
  }
  return {};
}

// HaremAltin JSON dosyasına yaz
function writeHaremAltinToFile(data) {
  try {
    fs.writeFileSync(haremAltinFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("haremaltin.json yazma hatası:", err.message);
  }
}

// TCMB JSON dosyasını oku
function readTcmbFromFile() {
  try {
    if (fs.existsSync(tcmbFilePath)) {
      const data = fs.readFileSync(tcmbFilePath, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("tcmb.json okuma hatası:", err.message);
  }
  return {};
}

// TCMB JSON dosyasına yaz
function writeTcmbToFile(data) {
  try {
    fs.writeFileSync(tcmbFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("tcmb.json yazma hatası:", err.message);
  }
}

// Bozuk Türkçe karakterleri düzelt (SQL verilerinde)
function fixTurkishEncoding(text) {
  if (!text || typeof text !== "string") return text;

  let fixed = text;
  fixed = fixed.replace(/Ãœ/g, "Ü");
  fixed = fixed.replace(/Ã¶/g, "ö");
  fixed = fixed.replace(/Ã¼/g, "ü");
  fixed = fixed.replace(/Ã§/g, "ç");
  fixed = fixed.replace(/ÅŸ/g, "ş");
  fixed = fixed.replace(/ÄŸ/g, "ğ");
  fixed = fixed.replace(/Ä°/g, "İ");
  fixed = fixed.replace(/Ã‡/g, "Ç");
  fixed = fixed.replace(/Åž/g, "Ş");
  fixed = fixed.replace(/Äž/g, "Ğ");
  fixed = fixed.replace(/Ã–/g, "Ö");

  return fixed;
}

// SQL verilerini kurlar formatına dönüştür
function convertSqlDataToKurFormat(sqlData, existingData = {}, convertEmptyToZero = false) {
  const converted = {};

  if (Array.isArray(sqlData)) {
    for (const item of sqlData) {
      if (item && item.Kodu) {
        const kodu = String(item.Kodu || "");
        const adi = fixTurkishEncoding(String(item.Adi || ""));
        let alis = String(item.Alis || "");
        let satis = String(item.Satis || "");

        // EskisehirDöviz için boş değerleri sıfıra çevir
        if (convertEmptyToZero) {
          if (!alis || alis.trim() === "") alis = "0";
          if (!satis || satis.trim() === "") satis = "0";
        }

        // Tarih alanları varsa koru
        const existingItem = existingData[kodu] || {};
        converted[kodu] = {
          Kodu: kodu,
          Adi: adi,
          Alis: alis,
          Satis: satis,
          ...(existingItem.A_t && { A_t: existingItem.A_t }),
          ...(existingItem.S_t && { S_t: existingItem.S_t }),
          ...(existingItem.e_Alis && { e_Alis: existingItem.e_Alis }),
          ...(existingItem.e_Alis_t && { e_Alis_t: existingItem.e_Alis_t }),
          ...(existingItem.e_Satis && { e_Satis: existingItem.e_Satis }),
          ...(existingItem.e_Satis_t && { e_Satis_t: existingItem.e_Satis_t }),
        };
      }
    }
  }

  return converted;
}

// Koprubasi verilerini kurlar formatına dönüştür
function convertKoprubasiDataToKurFormat(koprubasiData) {
  const converted = [];

  if (Array.isArray(koprubasiData)) {
    for (const item of koprubasiData) {
      if (item && item.KOD) {
        converted.push({
          Kodu: String(item.KOD || ""),
          Adi: String(item.AD || item.KOD || ""),
          Alis: String(item.ALIS || ""),
          Satis: String(item.SATIS || ""),
        });
      }
    }
  }

  return converted;
}

// Köprübaşı API verilerini fetch et (mevcut mantığın korunuyor)
async function fetchKoprubasiData() {
  const triggerUrl = "http://88.247.58.95:85/Kur/";
  const dataUrl = "http://88.247.58.95:85/Kur/koprubasi.json";

  try {
    // trigger (hata olsa da devam)
    try {
      await fetchWithTimeout(triggerUrl, { timeoutMs: 5000 });
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const json = await fetchJsonRetry(dataUrl, { timeoutMs: 15000, tries: 2 });
    const arr = Array.isArray(json) ? json : [];
    console.log("Koprubasi API bağlantısı başarılı");
    return { data: arr, error: null };
  } catch (err) {
    const errorMsg = `Koprubasi API bağlantısı başarısız: ${err?.message || err}`;
    console.error(errorMsg, "cause:", err?.cause);
    return { data: [], error: errorMsg };
  }
}

async function fetchHaremAltinData() {
  const endpoint = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";

  try {
    const json = await fetchJsonRetry(endpoint, {
      timeoutMs: 15000,
      tries: 3,
      headers: {
        "user-agent": "Mozilla/5.0 (Render; Node.js) JsonKur/1.0",
        accept: "application/json,text/plain,*/*",
        referer: "https://canlipiyasalar.haremaltin.com/",
        origin: "https://canlipiyasalar.haremaltin.com",
      },
    });

    // Beklenen format: { data: {...}, ... }
    const data = json?.data || {};
    if (!data || Object.keys(data).length === 0) {
      return { data: {}, error: "HaremAltin API boş veri döndü" };
    }

    console.log("HaremAltin API bağlantısı başarılı");
    return { data, error: null };
  } catch (err) {
    const errorMsg = `HaremAltin API bağlantısı başarısız: ${err?.message || err}`;
    console.error(errorMsg, "cause:", err?.cause);
    return { data: {}, error: errorMsg };
  }
}

// TCMB API'den veri çek
async function fetchTcmbData() {
  try {
    const tcmbUrl = "https://www.tcmb.gov.tr/kurlar/today.xml";
    const response = await fetchWithTimeout(tcmbUrl, { timeoutMs: 20000 });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const xmlText = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseAttributeValue: true,
      trimValues: true,
      parseTrueNumberOnly: false,
    });

    const jsonData = parser.parse(xmlText);

    if (!jsonData || Object.keys(jsonData).length === 0) {
      throw new Error("TCMB XML parse hatasında boş veri");
    }

    console.log("TCMB XML bağlantısı başarılı");
    return { data: jsonData, error: null };
  } catch (err) {
    const errorMsg = `TCMB XML bağlantısı başarısız: ${err.message}`;
    console.error(errorMsg, "cause:", err?.cause);
    return { data: {}, error: errorMsg };
  }
}

// TCMB API verilerini mevcut formata dönüştür
function convertTcmbDataToKurFormat(tcmbData) {
  const converted = [];

  try {
    if (!tcmbData || Object.keys(tcmbData).length === 0) {
      return converted;
    }

    const currencies = tcmbData?.Tarih_Date?.Currency;
    if (!currencies) return converted;

    const currencyArray = Array.isArray(currencies) ? currencies : [currencies];

    for (const item of currencyArray) {
      const kod = item?.["@_CurrencyCode"];
      if (!kod) continue;

      const name = item?.Isim?.["#text"] || item?.Isim || kod;
      const forexBuying = item?.ForexBuying?.["#text"] || item?.ForexBuying || "";
      const forexSelling = item?.ForexSelling?.["#text"] || item?.ForexSelling || "";

      converted.push({
        Kodu: String(kod),
        Adi: String(name),
        Alis: String(forexBuying),
        Satis: String(forexSelling),
      });
    }
  } catch (err) {
    console.error("TCMB veri dönüştürme hatası:", err.message);
  }

  return converted;
}

// Döviz item sıralamasını düzelt (Kodu, Adi, Alis, Satis)
function reorderKurItem(item) {
  if (!item || typeof item !== "object") return item;
  const {
    Kodu,
    Adi,
    Alis,
    Satis,
    A_t,
    S_t,
    e_Alis,
    e_Alis_t,
    e_Satis,
    e_Satis_t,
    ...rest
  } = item;

  const ordered = {
    ...(Kodu !== undefined && { Kodu }),
    ...(Adi !== undefined && { Adi }),
    ...(Alis !== undefined && { Alis }),
    ...(Satis !== undefined && { Satis }),
    ...(A_t !== undefined && { A_t }),
    ...(S_t !== undefined && { S_t }),
    ...(e_Alis !== undefined && { e_Alis }),
    ...(e_Alis_t !== undefined && { e_Alis_t }),
    ...(e_Satis !== undefined && { e_Satis }),
    ...(e_Satis_t !== undefined && { e_Satis_t }),
    ...rest,
  };

  return ordered;
}

// Mevcut verilerle karşılaştırıp sadece değişenleri güncelle
function updateKurlarWithChanges(newData, existingData = {}, convertEmptyToZero = false) {
  let existingObject = {};

  if (Array.isArray(existingData)) {
    for (const item of existingData) {
      if (item && item.Kodu) {
        existingObject[item.Kodu] = item;
      }
    }
  } else if (existingData && typeof existingData === "object") {
    existingObject = { ...existingData };
  }

  const updated = { ...existingObject };
  const now = getCurrentDateTimeISO();

  const newObject = convertSqlDataToKurFormat(newData, existingObject, convertEmptyToZero);

  for (const [kodu, newItem] of Object.entries(newObject)) {
    const existingItem = existingObject[kodu];

    if (!existingItem) {
      updated[kodu] = reorderKurItem({
        ...newItem,
        A_t: now,
        S_t: now,
      });
      continue;
    }

    const oldAlis = String(existingItem.Alis ?? "");
    const oldSatis = String(existingItem.Satis ?? "");
    const newAlis = String(newItem.Alis ?? "");
    const newSatis = String(newItem.Satis ?? "");

    let changed = false;

    if (oldAlis !== newAlis) {
      newItem.e_Alis = oldAlis;
      newItem.e_Alis_t = existingItem.A_t || now;
      newItem.A_t = now;
      changed = true;
    } else {
      newItem.A_t = existingItem.A_t || now;
      if (existingItem.e_Alis) newItem.e_Alis = existingItem.e_Alis;
      if (existingItem.e_Alis_t) newItem.e_Alis_t = existingItem.e_Alis_t;
    }

    if (oldSatis !== newSatis) {
      newItem.e_Satis = oldSatis;
      newItem.e_Satis_t = existingItem.S_t || now;
      newItem.S_t = now;
      changed = true;
    } else {
      newItem.S_t = existingItem.S_t || now;
      if (existingItem.e_Satis) newItem.e_Satis = existingItem.e_Satis;
      if (existingItem.e_Satis_t) newItem.e_Satis_t = existingItem.e_Satis_t;
    }

    updated[kodu] = reorderKurItem({ ...existingItem, ...newItem });

    if (!changed) {
      updated[kodu] = reorderKurItem(updated[kodu]);
    }
  }

  const finalUpdated = {};
  for (const [key, value] of Object.entries(updated)) {
    finalUpdated[key] = reorderKurItem(value);
  }

  return finalUpdated;
}

// Basit health endpoint
app.get("/health", (req, res) => res.json({ ok: true, time: getCurrentDateTimeISO() }));

/**
 * /api/kurlar endpoint'i
 * SQL bağlantısı başarısız olursa JSON dosyasından veri okur.
 */
app.get("/api/kurlar", async (req, res) => {
  try {
    // Mevcut JSON dosyalarını oku
    let existingEskisehirData = readKurlarFromFile();
    let existingKoprubasiData = readKoprubasiFromFile();
    let existingHaremAltinData = readHaremAltinFromFile();
    let existingTcmbData = readTcmbFromFile();

    let updatedEskisehirData = existingEskisehirData;
    let updatedKoprubasiData = existingKoprubasiData;
    let updatedHaremAltinData = existingHaremAltinData;
    let updatedTcmbData = existingTcmbData;

    // SQL Server'dan veri almaya çalış
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP (50)
          Kodu,
          CAST(Adi AS NVARCHAR(MAX)) COLLATE Turkish_CI_AS AS Adi, 
          Alis, 
          Satis
        FROM dbo.OnlineFiyatlar
        ORDER BY Kodu DESC
      `);

      // Yeni verilerle karşılaştırıp güncelle (EskisehirDöviz için boş değerleri sıfır yap)
      updatedEskisehirData = updateKurlarWithChanges(result.recordset, existingEskisehirData, true);
    } catch (dbError) {
      console.error(`SQL Server bağlantı hatası: ${dbError.message}`);
      updatedEskisehirData =
        existingEskisehirData && Object.keys(existingEskisehirData).length > 0
          ? existingEskisehirData
          : {};
    }

    // Köprübaşı API'den veri çek
    try {
      const { data: koprubasiData } = await fetchKoprubasiData();
      const koprubasiConverted = convertKoprubasiDataToKurFormat(koprubasiData);

      // Array -> object (Kodu key)
      const koprubasiObj = {};
      for (const item of koprubasiConverted) {
        if (item?.Kodu) koprubasiObj[item.Kodu] = reorderKurItem(item);
      }
      updatedKoprubasiData = koprubasiObj;
    } catch (err) {
      console.warn("Koprubasi fetch/dönüştürme hatası:", err?.message, "cause:", err?.cause);
      updatedKoprubasiData = existingKoprubasiData || {};
    }

    // HaremAltin API'den veri çek
    try {
      const { data: haremAltinData } = await fetchHaremAltinData();
      updatedHaremAltinData = haremAltinData || {};
    } catch (err) {
      console.warn("HaremAltin fetch hatası:", err?.message, "cause:", err?.cause);
      updatedHaremAltinData = existingHaremAltinData || {};
    }

    // TCMB XML'den veri çek
    try {
      const { data: tcmbData } = await fetchTcmbData();
      const tcmbConverted = convertTcmbDataToKurFormat(tcmbData);
      const tcmbObj = {};
      for (const item of tcmbConverted) {
        if (item?.Kodu) tcmbObj[item.Kodu] = reorderKurItem(item);
      }
      updatedTcmbData = tcmbObj;
    } catch (err) {
      console.warn("TCMB fetch hatası:", err?.message, "cause:", err?.cause);
      updatedTcmbData = existingTcmbData || {};
    }

    // Dosyalara yaz (fallback amaçlı)
    try {
      writeKurlarToFile(updatedEskisehirData);
      writeKoprubasiToFile(updatedKoprubasiData);
      writeHaremAltinToFile(updatedHaremAltinData);
      writeTcmbToFile(updatedTcmbData);
    } catch {}

    const generatedAt = getCurrentDateTimeISO();

    const response = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "KoprubasiDoviz", "HaremAltinDoviz", "Tcmb"],
      },
      data: {
        EskisehirDöviz: updatedEskisehirData || {},
        KoprubasiDoviz: updatedKoprubasiData || {},
        HaremAltinDoviz: updatedHaremAltinData || {},
        Tcmb: updatedTcmbData || {},
      },
      error: null,
    };

    res.json(response);
  } catch (error) {
    console.error(`API error: ${error.message}`, "cause:", error?.cause);

    const kurlar = readKurlarFromFile();
    const koprubasi = readKoprubasiFromFile();
    const haremAltin = readHaremAltinFromFile();
    const tcmb = readTcmbFromFile();

    const response = {
      meta: {
        generated_at: getCurrentDateTimeISO(),
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "KoprubasiDoviz", "HaremAltinDoviz", "Tcmb"],
      },
      data: {
        EskisehirDöviz: kurlar || {},
        KoprubasiDoviz: koprubasi || {},
        HaremAltinDoviz: haremAltin || {},
        Tcmb: tcmb || {},
      },
      error: "Beklenmeyen hata oluştu",
    };

    res.json(response);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

// Graceful shutdown (Render deploy/restart sırasında bağlantıları temiz kapat)
async function shutdown(signal) {
  console.log(`Shutting down: ${signal}`);
  server.close(() => console.log("HTTP server closed"));
  try {
    const p = await poolPromise;
    if (p && typeof p.close === "function") await p.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
