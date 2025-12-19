import express from "express";
import sql from "mssql";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
function writeKurlarToFile(eskisehirData, tcmbData = null) {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    
    // Verileri object formatına çevir
    const eskisehirObj = arrayToObject(eskisehirData);
    const tcmbObj = tcmbData ? arrayToObject(tcmbData) : readTcmbFromFile();
    
    // Mevcut verileri koru (eğer yeni veri yoksa)
    const finalTcmb = Object.keys(tcmbObj).length > 0 ? tcmbObj : readTcmbFromFile();
    
    // Meta bilgilerini oluştur
    const generatedAt = getCurrentDateTimeISO();
    
    const jsonData = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "Tcmb"]
      },
      data: {
        EskisehirDöviz: Object.keys(eskisehirObj).length > 0 ? eskisehirObj : {},
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


// Köprübaşı API verilerini mevcut formata dönüştür




// Harici API verilerini mevcut formata dönüştür


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

// TCMB API proxy
app.get("/api/proxy/tcmb", async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch("https://www.tcmb.gov.tr/kurlar/today.xml", {
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      return res.status(response.status).json({ error: `HTTP ${response.status}` });
    }
    
    const xmlText = await response.text();
    res.type("application/xml").send(xmlText);
  } catch (err) {
    res.status(503).json({ error: `TCMB API hatası: ${err.message}` });
  }
});

// Basit health endpoint
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * JSON endpoint örneği:
 * SQL Server 2016+ ise FOR JSON PATH ile tek parça JSON döndürüyoruz.
 * SQL bağlantısı başarısız olursa JSON dosyasından veri okur.
 */
app.get("/api/kurlar", async (req, res) => {
  try {
    // Mevcut JSON dosyasını oku
    let existingEskisehirData = readKurlarFromFile();
    let existingTcmbData = readTcmbFromFile();
    let updatedEskisehirData = existingEskisehirData;
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
      // SQL bağlantısı başarısız, mevcut veriyi koru veya boş obje oluştur
      updatedEskisehirData = existingEskisehirData && Object.keys(existingEskisehirData).length > 0 ? existingEskisehirData : {};
    }

    // TCMB API'den veri çek
    try {
      const { data: tcmbData, error: tcmbError } = await fetchTcmbData();
      if (tcmbError) {
        console.warn(`TCMB hatası: ${tcmbError}`);
      }
      
      if (!tcmbData || Object.keys(tcmbData).length === 0) {
        updatedTcmbData = existingTcmbData && Object.keys(existingTcmbData).length > 0 ? existingTcmbData : {};
      } else {
        const convertedTcmbData = convertTcmbDataToKurFormat(tcmbData);
        
        // Veri varsa ve boş değilse güncelle, yoksa mevcut veriyi koru
        if (convertedTcmbData && convertedTcmbData.length > 0) {
          updatedTcmbData = updateKurlarWithChanges(convertedTcmbData, existingTcmbData);
        } else {
          // API'den veri gelmedi, mevcut veriyi koru veya boş obje oluştur
          updatedTcmbData = existingTcmbData && Object.keys(existingTcmbData).length > 0 ? existingTcmbData : {};
        }
      }
    } catch (tcmbError) {
      console.error(`TCMB işleme hatası: ${tcmbError.message}`);
      // Hata durumunda mevcut veriyi koru veya boş obje oluştur
      updatedTcmbData = existingTcmbData && Object.keys(existingTcmbData).length > 0 ? existingTcmbData : {};
    }

    // Güncellenmiş verileri JSON dosyasına kaydet
    writeKurlarToFile(updatedEskisehirData, updatedTcmbData);

    // Meta bilgilerini oluştur
    const generatedAt = getCurrentDateTimeISO();
    
    // Response oluştur (meta ve data wrapper ile)
    const response = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "Tcmb"]
      },
      data: {
        EskisehirDöviz: updatedEskisehirData || {},
        Tcmb: updatedTcmbData || {}
      }
    };

    return res.json(response);
  } catch (err) {
    // Son çare olarak JSON dosyasından oku
    const kurlar = readKurlarFromFile();
    const tcmb = readTcmbFromFile();
    
    // Meta bilgilerini oluştur
    const generatedAt = getCurrentDateTimeISO();
    
    // API bağlantısı yoksa bile boş obje oluştur
    const response = {
      meta: {
        generated_at: generatedAt,
        cache_ttl: 30,
        sources: ["EskisehirDöviz", "Tcmb"]
      },
      data: {
        EskisehirDöviz: kurlar || {},
        Tcmb: tcmb || {}
      },
      error: "Beklenmeyen hata oluştu"
    };
    
    res.json(response);
  }
});
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
