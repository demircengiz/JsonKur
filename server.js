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

// JSON dosyasından veri okuma fonksiyonu
function readKurlarFromFile() {
  try {
    const jsonPath = path.join(__dirname, "kurlar.json");
    if (fs.existsSync(jsonPath)) {
      const data = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : parsed.EskisehirDöviz || parsed.kurlar || [];
    }
    return [];
  } catch (err) {
    console.warn("JSON dosyası okunamadı:", err.message);
    return [];
  }
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
    // Önce SQL Server'dan veri almaya çalış
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP (50)
          Kodu, Adi, Alis, Satis
        FROM dbo.OnlineFiyatlar
        ORDER BY Kodu DESC
      `);

      // Başarılı olursa SQL'den döndür
      return res.json({ EskisehirDöviz: result.recordset, source: "database" });
    } catch (dbError) {
      // SQL bağlantısı başarısız olursa JSON dosyasından oku
      console.warn("SQL bağlantısı başarısız, JSON dosyası kullanılıyor:", dbError.message);
      const kurlar = readKurlarFromFile();
      return res.json({ EskisehirDöviz: kurlar, source: "json-file", warning: "Veritabanı bağlantısı yok, JSON dosyası kullanılıyor" });
    }
  } catch (err) {
    // Son çare olarak boş array döndür
    console.error("Hata:", err.message);
    const kurlar = readKurlarFromFile();
    res.json({ EskisehirDöviz: kurlar, source: "json-file", error: "Beklenmeyen hata oluştu" });
  }
});
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});
