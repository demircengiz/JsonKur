import express from "express";
import sql from "mssql";

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
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(dbConfig);
  return poolPromise;
}

// Basit health endpoint
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * JSON endpoint örneği:
 * SQL Server 2016+ ise FOR JSON PATH ile tek parça JSON döndürüyoruz.
 * Kendi tablon/sorguna göre içini değiştir.
 */
app.get("/api/kurlar", async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT TOP (50)
        Code, Buy, Sell, UpdatedAt
      FROM dbo.Kurlar
      ORDER BY UpdatedAt DESC
      FOR JSON PATH, ROOT('kurlar')
    `);

    // FOR JSON çıktısı tek satır NVARCHAR olarak gelir (kolon adı boş olabilir)
    const row = result.recordset?.[0];
    const firstKey = row ? Object.keys(row)[0] : null;
    const jsonText = firstKey ? row[firstKey] : "[]";

    res.type("application/json").send(jsonText);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

app.get("/", (req, res) => {
  res.type("text").send("OK - service is running. Try /health or /api/kurlar");
});

