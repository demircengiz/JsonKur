import express from "express";
import sql from "mssql";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
    trustServerCertificate: true   // self-signed / cert problemi varsa
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
      console.warn("SQL Server bağlantısı başarısız, JSON dosyası kullanılacak:", err.message);
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
      
      // Her bir öğeyi doğru sırada yeniden oluştur
      const reordered = {};
      for (const [key, value] of Object.entries(kurlar)) {
        reordered[key] = reorderKurItem(value);
      }
      return reordered;
    }
    return {};
  } catch (err) {
    console.warn("JSON dosyası okunamadı:", err.message);
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
      return reordered;
    }
    return {};
  } catch (err) {
    console.warn("JSON dosyası okunamadı:", err.message);
    return {};
  }
}

// JSON dosyasına veri yazma fonksiyonu
function writeKurlarToFile(eskisehirData, haremAltinData = null) {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    const jsonData = { 
      EskisehirDöviz: eskisehirData 
    };
    
    // HaremAltinDoviz verisi varsa ekle
    if (haremAltinData) {
      jsonData.HaremAltinDoviz = haremAltinData;
    } else {
      // Mevcut HaremAltinDoviz verisini koru
      const existing = readHaremAltinFromFile();
      if (Object.keys(existing).length > 0) {
        jsonData.HaremAltinDoviz = existing;
      }
    }
    
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 4), "utf8");
    return true;
  } catch (err) {
    console.error("JSON dosyası yazılamadı:", err.message);
    return false;
  }
}

// Harici API'den altın/döviz verilerini çek
async function fetchHaremAltinData() {
  try {
    const response = await fetch("https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.data || {};
  } catch (err) {
    console.warn("Harici API'den veri alınamadı:", err.message);
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

// Yeni verileri mevcut JSON ile karşılaştırıp güncelle
function updateKurlarWithChanges(newData, existingData) {
  const updated = { ...existingData };
  const currentTime = getCurrentDateTime();

  // SQL'den gelen veriler array formatında, JSON'daki format object formatında
  // Her bir yeni kayıt için kontrol et
  if (Array.isArray(newData)) {
    for (const newItem of newData) {
      const kodu = newItem.Kodu;
      if (!kodu) continue;

      const existingItem = existingData[kodu] || {};
      const newAlis = String(newItem.Alis || "");
      const newSatis = String(newItem.Satis || "");
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
      existingItem.Adi = newItem.Adi || existingItem.Adi || "";

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
    let existingHaremAltinData = readHaremAltinFromFile();
    let updatedEskisehirData = existingEskisehirData;
    let updatedHaremAltinData = existingHaremAltinData;

    // SQL Server'dan veri almaya çalış
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP (50)
          Kodu, Adi, Alis, Satis
        FROM dbo.OnlineFiyatlar
        ORDER BY Kodu DESC
      `);

      // Yeni verilerle karşılaştırıp güncelle
      updatedEskisehirData = updateKurlarWithChanges(result.recordset, existingEskisehirData);
    } catch (dbError) {
      console.warn("SQL bağlantısı başarısız:", dbError.message);
    }

    // Harici API'den veri çek
    try {
      const haremAltinData = await fetchHaremAltinData();
      const convertedData = convertHaremAltinDataToKurFormat(haremAltinData);
      
      // Yeni verilerle karşılaştırıp güncelle
      updatedHaremAltinData = updateKurlarWithChanges(convertedData, existingHaremAltinData);
    } catch (apiError) {
      console.warn("Harici API'den veri alınamadı:", apiError.message);
    }

    // Güncellenmiş verileri JSON dosyasına kaydet
    writeKurlarToFile(updatedEskisehirData, updatedHaremAltinData);

    // Response oluştur
    const response = { EskisehirDöviz: updatedEskisehirData };
    
    // HaremAltinDoviz verisi varsa ekle
    if (Object.keys(updatedHaremAltinData).length > 0) {
      response.HaremAltinDoviz = updatedHaremAltinData;
    }

    return res.json(response);
  } catch (err) {
    // Son çare olarak JSON dosyasından oku
    console.error("Hata:", err.message);
    const kurlar = readKurlarFromFile();
    const haremAltin = readHaremAltinFromFile();
    
    const response = { EskisehirDöviz: kurlar };
    if (Object.keys(haremAltin).length > 0) {
      response.HaremAltinDoviz = haremAltin;
    }
    
    res.json({ ...response, error: "Beklenmeyen hata oluştu" });
  }
});
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
