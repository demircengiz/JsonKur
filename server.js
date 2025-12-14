import express from "express";
import sql from "mssql";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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

// Şimdiki zamanı formatla (DD.MM.YYYY HH:mm:ss)
function getCurrentDateTime() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
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
      const kurlar = parsed.EskisehirDöviz || {};
      
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
      const haremAltin = parsed.HaremAltinDoviz || {};
      
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
      const koprubasi = parsed.KoprubasiDoviz || {};
      
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
      const tcmb = parsed.Tcmb || {};
      
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
    console.log("JSON dosyası okunamadı: EskisehirDöviz");
    return {};
  }
}

// JSON dosyasına veri yazma fonksiyonu
function writeKurlarToFile(eskisehirData, koprubasiData = null, haremAltinData = null, tcmbData = null) {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    const jsonData = {};
    
    // EskisehirDöviz verisi varsa ve boş değilse ekle, yoksa mevcut veriyi koru
    if (eskisehirData && Object.keys(eskisehirData).length > 0) {
      jsonData.EskisehirDöviz = eskisehirData;
    } else {
      // Mevcut EskisehirDöviz verisini koru
      const existing = readKurlarFromFile();
      if (Object.keys(existing).length > 0) {
        jsonData.EskisehirDöviz = existing;
      } else {
        jsonData.EskisehirDöviz = {};
      }
    }
    
    // KoprubasiDoviz verisi varsa ve boş değilse ekle, yoksa mevcut veriyi koru
    if (koprubasiData && Object.keys(koprubasiData).length > 0) {
      jsonData.KoprubasiDoviz = koprubasiData;
    } else {
      // Mevcut KoprubasiDoviz verisini koru
      const existing = readKoprubasiFromFile();
      if (Object.keys(existing).length > 0) {
        jsonData.KoprubasiDoviz = existing;
      } else {
        jsonData.KoprubasiDoviz = {};
      }
    }
    
    // HaremAltinDoviz verisi varsa ve boş değilse ekle, yoksa mevcut veriyi koru
    if (haremAltinData && Object.keys(haremAltinData).length > 0) {
      jsonData.HaremAltinDoviz = haremAltinData;
    } else {
      // Mevcut HaremAltinDoviz verisini koru
      const existing = readHaremAltinFromFile();
      if (Object.keys(existing).length > 0) {
        jsonData.HaremAltinDoviz = existing;
      } else {
        jsonData.HaremAltinDoviz = {};
      }
    }
    
    // Tcmb verisi varsa ve boş değilse ekle, yoksa mevcut veriyi koru
    if (tcmbData && Object.keys(tcmbData).length > 0) {
      jsonData.Tcmb = tcmbData;
    } else {
      // Mevcut Tcmb verisini koru
      const existing = readTcmbFromFile();
      if (Object.keys(existing).length > 0) {
        jsonData.Tcmb = existing;
      } else {
        jsonData.Tcmb = {};
      }
    }
    
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 4), "utf8");
    console.log("JSON dosyası yazıldı");
    return true;
  } catch (err) {
    console.log("JSON dosyası yazılamadı");
    return false;
  }
}

// Köprübaşı API'den veri çek
async function fetchKoprubasiData() {
  try {
    const response = await fetch("http://94.54.145.159:81/koprubasi.json");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("Köprübaşı API bağlantısı başarılı");
    return data || [];
  } catch (err) {
    console.log("Köprübaşı API bağlantısı başarısız");
    return [];
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

// Harici API'den altın/döviz verilerini çek
async function fetchHaremAltinData() {
  try {
    const response = await fetch("https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log("HaremAltin API bağlantısı başarılı");
    return data.data || {};
  } catch (err) {
    console.log("HaremAltin API bağlantısı başarısız");
    return {};
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
    const response = await fetch("https://www.tcmb.gov.tr/kurlar/today.xml");
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
      console.log("TCMB XML bağlantısı başarısız");
      return {};
    }
    
    console.log("TCMB XML bağlantısı başarılı");
    return jsonData || {};
  } catch (err) {
    console.log("TCMB XML bağlantısı başarısız");
    return {};
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

// Yeni verileri mevcut JSON ile karşılaştırıp güncelle
function updateKurlarWithChanges(newData, existingData, isEskisehirDoviz = false) {
  const updated = { ...existingData };
  const currentTime = getCurrentDateTime();

  // SQL'den gelen veriler array formatında, JSON'daki format object formatında
  // Her bir yeni kayıt için kontrol et
  if (Array.isArray(newData)) {
    for (const newItem of newData) {
      const kodu = newItem.Kodu;
      if (!kodu) continue;

      const existingItem = existingData[kodu] || {};
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
      
      const oldAlis = String(existingItem.Alis || "");
      const oldSatis = String(existingItem.Satis || "");

      // Alis değişti mi?
      if (newAlis !== oldAlis && newAlis !== "") {
        // Eski değerleri e_Alis ve e_Alis_t'ye kaydet
        if (oldAlis !== "") {
          existingItem.e_Alis = oldAlis;
          existingItem.e_Alis_t = existingItem.Alis_t || currentTime;
        }
        // Yeni değerleri Alis ve Alis_t'ye yaz
        existingItem.Alis = newAlis;
        existingItem.Alis_t = currentTime;
      }

      // Satis değişti mi?
      if (newSatis !== oldSatis && newSatis !== "") {
        // Eski değerleri e_Satis ve e_Satis_t'ye kaydet
        if (oldSatis !== "") {
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
 * JSON endpoint örneği:
 * SQL Server 2016+ ise FOR JSON PATH ile tek parça JSON döndürüyoruz.
 * SQL bağlantısı başarısız olursa JSON dosyasından veri okur.
 */
app.get("/api/kurlar", async (req, res) => {
  try {
    // Mevcut JSON dosyasını oku
    let existingEskisehirData = readKurlarFromFile();
    let existingKoprubasiData = readKoprubasiFromFile();
    let existingHaremAltinData = readHaremAltinFromFile();
    let existingTcmbData = readTcmbFromFile();
    let updatedEskisehirData = existingEskisehirData;
    let updatedKoprubasiData = existingKoprubasiData;
    let updatedHaremAltinData = existingHaremAltinData;
    let updatedTcmbData = existingTcmbData;
    
    // Her kaynak için bağlantı başarılı olup olmadığını takip et
    let eskisehirSuccess = false;
    let koprubasiSuccess = false;
    let haremAltinSuccess = false;
    let tcmbSuccess = false;

    // SQL Server'dan veri almaya çalış (EskisehirDöviz)
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
      eskisehirSuccess = true;
    } catch (dbError) {
      // SQL bağlantısı başarısız, mevcut veriyi koru
      updatedEskisehirData = existingEskisehirData;
    }

    // Köprübaşı API'den veri çek
    try {
      const koprubasiData = await fetchKoprubasiData();
      const convertedKoprubasiData = convertKoprubasiDataToKurFormat(koprubasiData);
      
      // Veri varsa ve boş değilse güncelle
      if (convertedKoprubasiData && convertedKoprubasiData.length > 0) {
        updatedKoprubasiData = updateKurlarWithChanges(convertedKoprubasiData, existingKoprubasiData);
        koprubasiSuccess = true;
      } else {
        // API'den veri gelmedi, mevcut veriyi koru
        updatedKoprubasiData = existingKoprubasiData;
      }
    } catch (koprubasiError) {
      // Hata durumunda mevcut veriyi koru
      updatedKoprubasiData = existingKoprubasiData;
    }

    // HaremAltin API'den veri çek
    try {
      const haremAltinData = await fetchHaremAltinData();
      const convertedHaremAltinData = convertHaremAltinDataToKurFormat(haremAltinData);
      
      // Veri varsa ve boş değilse güncelle
      if (convertedHaremAltinData && convertedHaremAltinData.length > 0) {
        updatedHaremAltinData = updateKurlarWithChanges(convertedHaremAltinData, existingHaremAltinData);
        haremAltinSuccess = true;
      } else {
        // API'den veri gelmedi, mevcut veriyi koru
        updatedHaremAltinData = existingHaremAltinData;
      }
    } catch (haremAltinError) {
      // Hata durumunda mevcut veriyi koru
      updatedHaremAltinData = existingHaremAltinData;
    }

    // TCMB API'den veri çek
    try {
      const tcmbData = await fetchTcmbData();
      
      if (tcmbData && Object.keys(tcmbData).length > 0) {
        const convertedTcmbData = convertTcmbDataToKurFormat(tcmbData);
        
        // Veri varsa ve boş değilse güncelle
        if (convertedTcmbData && convertedTcmbData.length > 0) {
          updatedTcmbData = updateKurlarWithChanges(convertedTcmbData, existingTcmbData);
          tcmbSuccess = true;
        } else {
          // API'den veri gelmedi, mevcut veriyi koru
          updatedTcmbData = existingTcmbData;
        }
      } else {
        // API'den veri gelmedi, mevcut veriyi koru
        updatedTcmbData = existingTcmbData;
      }
    } catch (tcmbError) {
      // Hata durumunda mevcut veriyi koru
      updatedTcmbData = existingTcmbData;
    }

    // En az bir kaynak başarılı olduysa JSON dosyasına kaydet
    // Başarılı olanlar güncellenir, başarısız olanlar için mevcut veriler korunur (null geçilir)
    if (eskisehirSuccess || koprubasiSuccess || haremAltinSuccess || tcmbSuccess) {
      writeKurlarToFile(
        eskisehirSuccess ? updatedEskisehirData : null,
        koprubasiSuccess ? updatedKoprubasiData : null,
        haremAltinSuccess ? updatedHaremAltinData : null,
        tcmbSuccess ? updatedTcmbData : null
      );
    }

    // Response oluştur (doğru sırada: EskisehirDöviz, KoprubasiDoviz, HaremAltinDoviz, Tcmb)
    const response = { 
      EskisehirDöviz: updatedEskisehirData 
    };
    
    // KoprubasiDoviz verisi varsa ekle
    if (Object.keys(updatedKoprubasiData).length > 0) {
      response.KoprubasiDoviz = updatedKoprubasiData;
    }
    
    // HaremAltinDoviz verisi varsa ekle
    if (Object.keys(updatedHaremAltinData).length > 0) {
      response.HaremAltinDoviz = updatedHaremAltinData;
    }
    
    // Tcmb verisi varsa ekle
    if (Object.keys(updatedTcmbData).length > 0) {
      response.Tcmb = updatedTcmbData;
    }

    return res.json(response);
  } catch (err) {
    // Son çare olarak JSON dosyasından oku
    const kurlar = readKurlarFromFile();
    const koprubasi = readKoprubasiFromFile();
    const haremAltin = readHaremAltinFromFile();
    const tcmb = readTcmbFromFile();
    
    const response = { EskisehirDöviz: kurlar };
    if (Object.keys(koprubasi).length > 0) {
      response.KoprubasiDoviz = koprubasi;
    }
    if (Object.keys(haremAltin).length > 0) {
      response.HaremAltinDoviz = haremAltin;
    }
    if (Object.keys(tcmb).length > 0) {
      response.Tcmb = tcmb;
    }
    
    res.json({ ...response, error: "Beklenmeyen hata oluştu" });
  }
});
// JSON dosyasını oluştur (yoksa)
function initializeJsonFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (!fs.existsSync(jsonPath)) {
      const initialData = {
        EskisehirDöviz: {},
        KoprubasiDoviz: {},
        HaremAltinDoviz: {},
        Tcmb: {}
      };
      fs.writeFileSync(jsonPath, JSON.stringify(initialData, null, 4), "utf8");
      console.log("JSON dosyası oluşturuldu");
    }
  } catch (err) {
    console.log("JSON dosyası oluşturulamadı");
  }
}

// Sunucu başlatıldığında JSON dosyasını kontrol et ve oluştur
initializeJsonFile();

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
