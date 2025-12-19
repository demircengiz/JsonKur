import express from "express";
import sql from "mssql";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Background API update sistemi
let isUpdating = false;
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 dakika

async function updateDataInBackground() {
  if (isUpdating) return;
  isUpdating = true;
  
  try {
    console.log("Background API update başladı...");
    
    // Mevcut verileri oku
    let eskisehirData = readKurlarFromFile();
    let koprubasiData = readKoprubasiFromFile();
    let haremAltinData = readHaremAltinFromFile();
    let tcmbData = readTcmbFromFile();
    
    // SQL Server - EskisehirDöviz
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
      if (result && result.recordset && result.recordset.length > 0) {
        eskisehirData = updateKurlarWithChanges(result.recordset, eskisehirData, true);
        console.log("Background SQL Server veri çekildi");
      }
    } catch (e) {
      console.warn("Background SQL Server hatası:", e.message);
    }
    
    // Köprübaşı
    try {
      const { data } = await fetchKoprubasiData();
      const converted = convertKoprubasiDataToKurFormat(data);
      if (converted && converted.length > 0) {
        koprubasiData = updateKurlarWithChanges(converted, koprubasiData);
        console.log("Background Köprübaşı veri çekildi");
      }
    } catch (e) {
      console.warn("Background Köprübaşı hatası:", e.message);
    }
    
    // HaremAltin
    try {
      const { data } = await fetchHaremAltinData();
      const converted = convertHaremAltinDataToKurFormat(data);
      if (converted && converted.length > 0) {
        haremAltinData = updateKurlarWithChanges(converted, haremAltinData);
        console.log("Background HaremAltin veri çekildi");
      }
    } catch (e) {
      console.warn("Background HaremAltin hatası:", e.message);
    }
    
    // TCMB
    try {
      const { data } = await fetchTcmbData();
      if (data && Object.keys(data).length > 0) {
        const converted = convertTcmbDataToKurFormat(data);
        if (converted && converted.length > 0) {
          tcmbData = updateKurlarWithChanges(converted, tcmbData);
          console.log("Background TCMB veri çekildi");
        }
      }
    } catch (e) {
      console.warn("Background TCMB hatası:", e.message);
    }
    
    // Dosyaya kaydet
    writeKurlarToFile(eskisehirData, koprubasiData, haremAltinData, tcmbData);
    lastUpdateTime = Date.now();
    console.log("Background API update tamamlandı");
  } catch (err) {
    console.error("Background update hatası:", err.message);
  } finally {
    isUpdating = false;
  }
}

// Periyodik update başlat (30 dakika arayla)
setInterval(updateDataInBackground, UPDATE_INTERVAL);

// Startup'ta ilk update'i hemen çalıştır (async)
updateDataInBackground().catch(err => console.error("Initial update hatası:", err));

// CORS ve JSON middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
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
  server: process.env.DB_HOST,     // örn: "1.2.3.4" veya "sql.domain.com"
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 1433,
  options: {
    encrypt: false,                // Azure SQL ise genelde true gerekir
    trustServerCertificate: true,   // self-signed / cert problemi varsa
    enableArithAbort: true,
    requestTimeout: 30000
  },
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000
  }
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
      console.log("SQL Server bağlantısı başarısız");
      poolPromise = null;
      throw err;
    }
  }
  return poolPromise;
}

// Şimdiki zamanı formatla (DD.MM.YYYY HH:mm:ss) - Türkiye saati
function getCurrentDateTime() {
  // Türkiye saatine göre tarih/saat al (Europe/Istanbul - UTC+3)
  const now = new Date();
  
  // Türkiye saatini almak için Intl.DateTimeFormat kullan
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  const hours = parts.find(p => p.type === "hour").value;
  const minutes = parts.find(p => p.type === "minute").value;
  const seconds = parts.find(p => p.type === "second").value;
  
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

// Türkiye saatini YYYY-MM-DD HH:mm:ss formatında döndür
function getCurrentDateTimeISO() {
  // Türkiye saatine göre tarih/saat al (Europe/Istanbul - UTC+3)
  const now = new Date();
  
  // Türkiye saatini almak için Intl.DateTimeFormat kullan
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  const hours = parts.find(p => p.type === "hour").value;
  const minutes = parts.find(p => p.type === "minute").value;
  const seconds = parts.find(p => p.type === "second").value;
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Türkçe karakter encoding sorununu düzelt
function fixTurkishEncoding(text) {
  if (!text || typeof text !== "string") return text;
  
  // Yaygın encoding hatalarını düzelt
  let fixed = text;
  
  // UTF-8 encoding hatalarını düzelt
  fixed = fixed.replace(/Ãœ/g, "Ü");
  fixed = fixed.replace(/Ã¼/g, "ü");
  fixed = fixed.replace(/Ã–/g, "Ö");
  fixed = fixed.replace(/Ã¶/g, "ö");
  fixed = fixed.replace(/Ã/g, ",");
  fixed = fixed.replace(/Ã/g, ",");
  fixed = fixed.replace(/Ä°/g, "İ");
  fixed = fixed.replace(/Ä±/g, "ı");
  fixed = fixed.replace(/Åž/g, "Ş");
  fixed = fixed.replace(/ÅŸ/g, "ş");
  fixed = fixed.replace(/ÄŸ/g, "ğ");
  fixed = fixed.replace(/Ä/g, "Ğ");
  
  return fixed;
}

// Objeyi doğru sırada yeniden oluştur (Kodu ve Adi en üstte)
function reorderKurItem(item) {
  if (!item || typeof item !== "object") return item;
  
  return {
    Kodu: item.Kodu || "",
    Adi: item.Adi || "",
    Alis: item.Alis || "",
    Alis_t: item.Alis_t || "",
    Satis: item.Satis || "",
    Satis_t: item.Satis_t || "",
    ...(item.e_Alis && { e_Alis: item.e_Alis }),
    ...(item.e_Alis_t && { e_Alis_t: item.e_Alis_t }),
    ...(item.e_Satis && { e_Satis: item.e_Satis }),
    ...(item.e_Satis_t && { e_Satis_t: item.e_Satis_t })
  };
}

// JSON dosyasından veri okuma fonksiyonu
function readKurlarFromFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (fs.existsSync(jsonPath)) {
      const data = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(data);
      
      // Yeni format (meta/data) kontrolü
      let kurlar = {};
      if (parsed.data && parsed.data.EskisehirDöviz) {
        kurlar = parsed.data.EskisehirDöviz;
      } else if (parsed.EskisehirDöviz) {
        kurlar = parsed.EskisehirDöviz;
      }
      
      // Array formatı ise object'e çevir
      if (Array.isArray(kurlar)) {
        kurlar = arrayToObject(kurlar);
      }
      
      // Her bir öğeyi doğru sırada yeniden oluştur ve Türkçe karakterleri düzelt
      const reordered = {};
      for (const [key, value] of Object.entries(kurlar)) {
        const item = reorderKurItem(value);
        // Adi alanındaki Türkçe karakter sorununu düzelt
        if (item.Adi) {
          item.Adi = fixTurkishEncoding(item.Adi);
        }
        reordered[key] = item;
      }
      console.log("JSON dosyası okundu: EskisehirDöviz");
      return reordered;
    }
    console.log("JSON dosyası bulunamadı: EskisehirDöviz");
    return {};
  } catch (err) {
    console.log("JSON dosyası okunamadı: EskisehirDöviz");
    return {};
  }
}

// HaremAltinDoviz verilerini JSON dosyasından okuma
function readHaremAltinFromFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (fs.existsSync(jsonPath)) {
      const data = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(data);
      
      // Yeni format (meta/data) kontrolü
      let haremAltin = {};
      if (parsed.data && parsed.data.HaremAltinDoviz) {
        haremAltin = parsed.data.HaremAltinDoviz;
      } else if (parsed.HaremAltinDoviz) {
        haremAltin = parsed.HaremAltinDoviz;
      }
      
      // Array formatı ise object'e çevir
      if (Array.isArray(haremAltin)) {
        haremAltin = arrayToObject(haremAltin);
      }
      
      // Her bir öğeyi doğru sırada yeniden oluştur
      const reordered = {};
      for (const [key, value] of Object.entries(haremAltin)) {
        reordered[key] = reorderKurItem(value);
      }
      console.log("JSON dosyası okundu: HaremAltinDoviz");
      return reordered;
    }
    console.log("JSON dosyası bulunamadı: HaremAltinDoviz");
    return {};
  } catch (err) {
    console.log("JSON dosyası okunamadı: HaremAltinDoviz");
    return {};
  }
}

// KoprubasiDoviz verilerini JSON dosyasından okuma
function readKoprubasiFromFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (fs.existsSync(jsonPath)) {
      const data = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(data);
      
      // Yeni format (meta/data) kontrolü
      let koprubasi = {};
      if (parsed.data && parsed.data.KoprubasiDoviz) {
        koprubasi = parsed.data.KoprubasiDoviz;
      } else if (parsed.KoprubasiDoviz) {
        koprubasi = parsed.KoprubasiDoviz;
      }
      
      // Array formatı ise object'e çevir
      if (Array.isArray(koprubasi)) {
        koprubasi = arrayToObject(koprubasi);
      }
      
      // Her bir öğeyi doğru sırada yeniden oluştur
      const reordered = {};
      for (const [key, value] of Object.entries(koprubasi)) {
        reordered[key] = reorderKurItem(value);
      }
      console.log("JSON dosyası okundu: KoprubasiDoviz");
      return reordered;
    }
    console.log("JSON dosyası bulunamadı: KoprubasiDoviz");
    return {};
  } catch (err) {
    console.log("JSON dosyası okunamadı: KoprubasiDoviz");
    return {};
  }
}

// Tcmb verilerini JSON dosyasından okuma
function readTcmbFromFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (fs.existsSync(jsonPath)) {
      const data = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(data);
      
      // Yeni format (meta/data) kontrolü
      let tcmb = {};
      if (parsed.data && parsed.data.Tcmb) {
        tcmb = parsed.data.Tcmb;
      } else if (parsed.Tcmb) {
        tcmb = parsed.Tcmb;
      }
      
      // Array formatı ise object'e çevir
      if (Array.isArray(tcmb)) {
        tcmb = arrayToObject(tcmb);
      }
      
      // Her bir öğeyi doğru sırada yeniden oluştur
      const reordered = {};
      for (const [key, value] of Object.entries(tcmb)) {
        reordered[key] = reorderKurItem(value);
      }
      console.log("JSON dosyası okundu: Tcmb");
      return reordered;
    }
    console.log("JSON dosyası bulunamadı: Tcmb");
    return {};
  } catch (err) {
    console.log("JSON dosyası okunamadı: Tcmb");
    return {};
  }
}

// JSON dosyasına veri yazma fonksiyonu
function writeKurlarToFile(eskisehirData, koprubasiData = null, haremAltinData = null, tcmbData = null) {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    
    // Verileri object formatına çevir
    const eskisehirObj = arrayToObject(eskisehirData);
    const koprubasiObj = koprubasiData ? arrayToObject(koprubasiData) : readKoprubasiFromFile();
    const haremAltinObj = haremAltinData ? arrayToObject(haremAltinData) : readHaremAltinFromFile();
    const tcmbObj = tcmbData ? arrayToObject(tcmbData) : readTcmbFromFile();
    
    // Mevcut verileri koru (eğer yeni veri yoksa)
    const finalKoprubasi = Object.keys(koprubasiObj).length > 0 ? koprubasiObj : readKoprubasiFromFile();
    const finalHaremAltin = Object.keys(haremAltinObj).length > 0 ? haremAltinObj : readHaremAltinFromFile();
    const finalTcmb = Object.keys(tcmbObj).length > 0 ? tcmbObj : readTcmbFromFile();
    
    // Meta bilgilerini oluştur
    const generatedAt = getCurrentDateTimeISO();
    
    const jsonData = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "KoprubasiDoviz", "HaremAltinDoviz", "Tcmb"]
      },
      data: {
        EskisehirDöviz: Object.keys(eskisehirObj).length > 0 ? eskisehirObj : {},
        KoprubasiDoviz: Object.keys(finalKoprubasi).length > 0 ? finalKoprubasi : {},
        HaremAltinDoviz: Object.keys(finalHaremAltin).length > 0 ? finalHaremAltin : {},
        Tcmb: Object.keys(finalTcmb).length > 0 ? finalTcmb : {}
      }
    };
    
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 4), "utf8");
    console.log("JSON dosyası yazıldı");
    return true;
  } catch (err) {
    console.log("JSON dosyası yazılamadı");
    return false;
  }
}

// Köprübaşı API'den veri çek (tetikleyici sayfayı önce çağır)
async function fetchKoprubasiData() {
  try {
    // Önce tetikleyici sayfayı çağrı (dosya üretimini tetikle)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch("http://88.247.58.95:85/Kur/", { signal: controller.signal });
      clearTimeout(timeout);
      console.log("Köprübaşı tetikleyici sayfası çağrıldı");
    } catch (triggerError) {
      console.warn(`Köprübaşı tetikleyici hatası (devam ediliyor): ${triggerError.message}`);
    }
    
    // Dosya oluşturulması için kısa bir bekleme
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Şimdi coprubasi.json dosyasını çek
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch("http://88.247.58.95:85/Kur/koprubasi.json", { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("Köprübaşı API bağlantısı başarılı");
    return { data: data || [], error: null };
  } catch (err) {
    const errorMsg = `Köprübaşı API bağlantısı başarısız: ${err.message}`;
    console.error(errorMsg);
    return { data: [], error: errorMsg };
  }
}

// Köprübaşı API verilerini mevcut formata dönüştür
function convertKoprubasiDataToKurFormat(koprubasiData) {
  const converted = [];
  
  if (Array.isArray(koprubasiData)) {
    for (const item of koprubasiData) {
      if (item && item.KOD) {
        converted.push({
          Kodu: String(item.KOD || ""),
          Adi: String(item.AD || item.KOD || ""),
          Alis: String(item.ALIS || ""),
          Satis: String(item.SATIS || "")
        });
      }
    }
  }
  
  return converted;
}

// Hareci API'den altın/döviz verilerini çek
async function fetchHaremAltinData(retryCount = 0) {
  const endpoint = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";
  const maxRetries = 3;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 saniye timeout
    
    const response = await fetch(endpoint, { 
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://canlipiyasalar.haremaltin.com/',
        'Accept': 'application/json',
        'Accept-Language': 'tr-TR,tr;q=0.9',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("HaremAltin API bağlantısı başarılı");
    return { data: data.data || {}, error: null };
  } catch (err) {
    // Retry eğer fetch failed ise
    if (retryCount < maxRetries && err.message.includes("fetch")) {
      const delay = Math.pow(2, retryCount) * 1000; // exponential backoff
      console.warn(`HaremAltin retry ${retryCount + 1}/${maxRetries} after ${delay}ms: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchHaremAltinData(retryCount + 1);
    }
    
    const errorMsg = `HaremAltin API başarısız (${retryCount > 0 ? `${retryCount} retry sonrası` : "hızlı geçiliyor"}): ${err.message}`;
    console.warn(errorMsg);
    return { data: {}, error: null };
  }
}

// Harici API verilerini mevcut formata dönüştür
function convertHaremAltinDataToKurFormat(haremAltinData) {
  const converted = [];
  
  for (const [key, item] of Object.entries(haremAltinData)) {
    if (item && item.code) {
      converted.push({
        Kodu: item.code,
        Adi: item.code, // code hem Kodu hem Adi olarak kullanılıyor
        Alis: String(item.alis || ""),
        Satis: String(item.satis || "")
      });
    }
  }
  
  return converted;
}

// TCMB API'den veri çek
async function fetchTcmbData() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 saniye timeout
    
    const response = await fetch("https://www.tcmb.gov.tr/kurlar/today.xml", { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const xmlText = await response.text();
    
    if (!xmlText || xmlText.trim().length === 0) {
      throw new Error("TCMB API'den boş yanıt alındı");
    }
    
    // XML'i parse et - TCMB XML'inde attribute'lar önemli
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      parseAttributeValue: true,
      trimValues: true,
      parseTrueNumberOnly: false
    });
    
    const jsonData = parser.parse(xmlText);
    
    if (!jsonData || Object.keys(jsonData).length === 0) {
      throw new Error("TCMB XML parse hatasında boş veri");
    }
    
    console.log("TCMB XML bağlantısı başarılı");
    return { data: jsonData, error: null };
  } catch (err) {
    const errorMsg = `TCMB XML bağlantısı başarısız: ${err.message}`;
    console.error(errorMsg);
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
    
    // TCMB XML yapısı: Tarih_Date.Currency[]
    const tarihDate = tcmbData.Tarih_Date;
    if (!tarihDate) {
      return converted;
    }
    
    if (!tarihDate.Currency) {
      return converted;
    }
    
    const currencies = Array.isArray(tarihDate.Currency) 
      ? tarihDate.Currency 
      : [tarihDate.Currency];
    
    for (const currency of currencies) {
      if (!currency) continue;
      
      // CurrencyCode attribute olarak (@_CurrencyCode) veya text node olarak gelebilir
      const currencyCode = currency["@_CurrencyCode"] || currency.CurrencyCode || currency["@_Kod"] || currency.Kod;
      
      if (!currencyCode) {
        continue;
      }
      
      // BanknoteBuying ve BanknoteSelling değerlerini al
      // Bunlar text node olarak gelir
      const alis = currency.BanknoteBuying || currency["#text"] || "";
      const satis = currency.BanknoteSelling || "";
      
      // CurrencyName veya Isim alanını al
      const currencyName = currency.CurrencyName || currency.Isim || currencyCode;
      
      // Eğer hem alis hem satis boşsa bu kaydı atla
      if (alis === "" && satis === "") {
        continue;
      }
      
      converted.push({
        Kodu: String(currencyCode),
        Adi: String(currencyName),
        Alis: String(alis),
        Satis: String(satis)
      });
    }
  } catch (err) {
    // Hata sessizce yok sayılır
  }
  
  return converted;
}

// Array formatındaki veriyi object formatına çevir (key-value pairs)
function arrayToObject(dataArray) {
  if (!Array.isArray(dataArray)) {
    // Zaten object ise direkt dön
    if (dataArray && typeof dataArray === 'object') {
      return dataArray;
    }
    return {};
  }
  
  const result = {};
  for (const item of dataArray) {
    if (item && item.Kodu) {
      result[item.Kodu] = reorderKurItem(item);
    }
  }
  return result;
}

// Object formatındaki veriyi array formatına çevir
function objectToArray(dataObject) {
  if (Array.isArray(dataObject)) {
    return dataObject;
  }
  
  if (!dataObject || typeof dataObject !== 'object') {
    return [];
  }
  
  return Object.values(dataObject);
}

// Yeni verileri mevcut JSON ile karşılaştırıp güncelle
function updateKurlarWithChanges(newData, existingData, isEskisehirDoviz = false) {
  // Mevcut veriyi object formatına çevir
  let existingObject = {};
  if (Array.isArray(existingData)) {
    existingObject = arrayToObject(existingData);
  } else if (existingData && typeof existingData === 'object') {
    existingObject = { ...existingData };
  }
  
  const currentTime = getCurrentDateTime();
  const updated = { ...existingObject };

  // SQL'den gelen veriler array formatında
  // Her bir yeni kayıt için kontrol et
  if (Array.isArray(newData)) {
    for (const newItem of newData) {
      const kodu = newItem.Kodu;
      if (!kodu) continue;

      const existingItem = existingObject[kodu] || {};
      // Tüm kaynaklar için boş veya 0 değerleri "0" olarak ayarla
      let newAlis = String(newItem.Alis || "");
      let newSatis = String(newItem.Satis || "");
      
      // Boş, null, undefined veya "0" ise "0" olarak ayarla
      if (newAlis === "" || newAlis === "null" || newAlis === "undefined" || newAlis === "0" || newAlis === 0 || !newAlis) {
        newAlis = "0";
      }
      if (newSatis === "" || newSatis === "null" || newSatis === "undefined" || newSatis === "0" || newSatis === 0 || !newSatis) {
        newSatis = "0";
      }
      
      // Mevcut değerleri de normalize et
      let oldAlis = String(existingItem.Alis || "");
      let oldSatis = String(existingItem.Satis || "");
      
      if (oldAlis === "" || oldAlis === "null" || oldAlis === "undefined" || oldAlis === "0" || oldAlis === 0 || !oldAlis) {
        oldAlis = "0";
      }
      if (oldSatis === "" || oldSatis === "null" || oldSatis === "undefined" || oldSatis === "0" || oldSatis === 0 || !oldSatis) {
        oldSatis = "0";
      }

      // Alis değişti mi veya yeni kayıt mı?
      if (newAlis !== oldAlis || !existingItem.Alis) {
        // Eski değerleri e_Alis ve e_Alis_t'ye kaydet (eğer eski değer "0" değilse ve varsa)
        if (oldAlis !== "0" && oldAlis !== "" && existingItem.Alis) {
          existingItem.e_Alis = oldAlis;
          existingItem.e_Alis_t = existingItem.Alis_t || currentTime;
        }
        // Yeni değerleri Alis ve Alis_t'ye yaz
        existingItem.Alis = newAlis;
        existingItem.Alis_t = currentTime;
      }

      // Satis değişti mi veya yeni kayıt mı?
      if (newSatis !== oldSatis || !existingItem.Satis) {
        // Eski değerleri e_Satis ve e_Satis_t'ye kaydet (eğer eski değer "0" değilse ve varsa)
        if (oldSatis !== "0" && oldSatis !== "" && existingItem.Satis) {
          existingItem.e_Satis = oldSatis;
          existingItem.e_Satis_t = existingItem.Satis_t || currentTime;
        }
        // Yeni değerleri Satis ve Satis_t'ye yaz
        existingItem.Satis = newSatis;
        existingItem.Satis_t = currentTime;
      }

      // Diğer alanları güncelle (Adi, Kodu)
      existingItem.Kodu = kodu;
      // EskisehirDöviz için Türkçe karakter sorununu düzelt
      let adi = newItem.Adi || existingItem.Adi || "";
      if (isEskisehirDoviz) {
        adi = fixTurkishEncoding(adi);
      }
      existingItem.Adi = adi;

      // Objeyi doğru sırada yeniden oluştur (Kodu ve Adi en üstte)
      updated[kodu] = reorderKurItem(existingItem);
    }
  }

  // Tüm kayıtları doğru sırada yeniden oluştur (değişiklik olmayan kayıtlar için de)
  const finalUpdated = {};
  for (const [key, value] of Object.entries(updated)) {
    finalUpdated[key] = reorderKurItem(value);
  }

  return finalUpdated;
}

// Basit health endpoint
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * JSON endpoint - Cached data'yı döndürür
 * Background task async olarak API'yi günceller
 */
app.get("/api/kurlar", async (req, res) => {
  try {
    // Cached data'yı oku
    const kurlar = readKurlarFromFile();
    const koprubasi = readKoprubasiFromFile();
    const haremAltin = readHaremAltinFromFile();
    const tcmb = readTcmbFromFile();
    
    // Background update'i tetikle (async, response'ü bloke etmez)
    if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
      updateDataInBackground().catch(err => console.error("Bg update error:", err));
    }
    
    // Meta bilgilerini oluştur
    const generatedAt = getCurrentDateTimeISO();
    
    // Response oluştur
    const response = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "KoprubasiDoviz", "HaremAltinDoviz", "Tcmb"],
        last_updated: lastUpdateTime ? new Date(lastUpdateTime).toISOString() : "never"
      },
      data: {
        EskisehirDöviz: kurlar || {},
        KoprubasiDoviz: koprubasi || {},
        HaremAltinDoviz: haremAltin || {},
        Tcmb: tcmb || {}
      }
    };
    
    return res.json(response);
  } catch (err) {
    console.error("Kurlar endpoint hatası:", err.message);
    
    // Son çare fallback
    const generatedAt = getCurrentDateTimeISO();
    res.status(500).json({
      meta: {
        generated_at: generatedAt,
        error: "Veri okunamadı"
      },
      data: {}
    });
  }
});
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
