require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.static(__dirname, { index: false }));

// ---------- DB init ----------
async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema ready.');
}

// ---------- helpers ----------
// ยางมะตอย 1 ตัน = 0.96 ลบ.ม. = 960 ลิตร (ใช้แปลงลิตรที่ใช้ผลิต -> ตันที่หักออกจากถัง)
const ASPHALT_LITERS_PER_TON = 960;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function getAdminPin() {
  const r = await pool.query(`SELECT value FROM settings WHERE key = 'admin_pin'`);
  return r.rows[0] ? r.rows[0].value : '1234';
}

function requirePin(req, res, next) {
  getAdminPin().then((pin) => {
    const bodyPin = req.body && req.body.pin;
    if (bodyPin === pin || req.headers['x-admin-pin'] === pin) {
      next();
    } else {
      res.status(401).json({ error: 'PIN ไม่ถูกต้อง' });
    }
  }).catch((e) => res.status(500).json({ error: e.message }));
}

async function upsertCompany(name) {
  if (!name) return;
  await pool.query(
    `INSERT INTO companies (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [name]
  );
}

async function upsertPlate(plate) {
  if (!plate) return;
  await pool.query(
    `INSERT INTO vehicle_plates (plate) VALUES ($1) ON CONFLICT (plate) DO NOTHING`,
    [plate]
  );
}

// ============================================================
// MATERIALS / STOCK
// ============================================================
app.get('/api/materials', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM materials ORDER BY display_order');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PRODUCTION (บันทึกประจำวัน) — หิน + ยางมะตอย (แบ่งหลายถังได้) + น้ำมันเตา
// ไม่มีดีเซลเกี่ยวข้อง
// ============================================================
app.post('/api/production', async (req, res) => {
  const { production_date, tons_produced, asphalt_ratio_per_ton, tank_ends, oil_end, job_site, created_by } = req.body;

  const tons = toNum(tons_produced);
  const ratio = toNum(asphalt_ratio_per_ton); // กก. / ตัน
  const oilEnd = toNum(oil_end);
  const TANK_CODES = ['asphalt_1', 'asphalt_2', 'asphalt_3', 'asphalt_4', 'asphalt_old_1', 'asphalt_old_2'];

  if (!production_date || !Number.isFinite(tons) || tons <= 0 || !Number.isFinite(ratio) || ratio < 0) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง (วันที่ / ตันที่ผลิต / อัตราส่วนยางมะตอย)' });
  }
  if (!Number.isFinite(oilEnd) || oilEnd < 0) {
    return res.status(400).json({ error: 'กรอกระดับน้ำมันเตาสิ้นวันให้ถูกต้อง' });
  }
  if (!tank_ends || typeof tank_ends !== 'object') {
    return res.status(400).json({ error: 'กรอกระดับสิ้นวันของทั้ง 6 ถังให้ครบ' });
  }
  const ends = {};
  for (const code of TANK_CODES) {
    const v = toNum(tank_ends[code]);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ error: 'กรอกระดับสิ้นวันของทั้ง 6 ถังให้ครบและถูกต้อง' });
    }
    ends[code] = v;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fixedRes = await client.query(
      `SELECT code, ratio_per_ton FROM materials WHERE code IN ('stone_dust','stone_34','stone_38')`
    );
    const fixed = {};
    fixedRes.rows.forEach((m) => { fixed[m.code] = Number(m.ratio_per_ton); });

    const stoneDustUsed = tons * fixed.stone_dust;
    const stone34Used = tons * fixed.stone_34;
    const stone38Used = tons * fixed.stone_38;

    const tankRes = await client.query(
      `SELECT code, current_stock FROM materials WHERE code = ANY($1)`,
      [TANK_CODES]
    );
    const tankReadings = [];
    let totalUsedTons = 0;
    for (const row of tankRes.rows) {
      const start = Number(row.current_stock);
      const end = ends[row.code];
      if (end > start + 0.0001) {
        throw new Error(`ระดับสิ้นวันของ${row.code}มากกว่าต้นวัน (ถังยางลดลงเท่านั้น เติมได้ผ่านหน้านำเข้าเท่านั้น)`);
      }
      const used = start - end;
      totalUsedTons += used;
      tankReadings.push({ code: row.code, start, end, used });
    }
    const asphaltUsedKg = totalUsedTons * 1000;

    const oilRes = await client.query(`SELECT current_stock FROM materials WHERE code = 'fuel_oil'`);
    const oilStart = Number(oilRes.rows[0].current_stock);
    const oilUsed = oilStart - oilEnd;

    await client.query(`UPDATE materials SET current_stock = current_stock - $1 WHERE code = 'stone_dust'`, [stoneDustUsed]);
    await client.query(`UPDATE materials SET current_stock = current_stock - $1 WHERE code = 'stone_34'`, [stone34Used]);
    await client.query(`UPDATE materials SET current_stock = current_stock - $1 WHERE code = 'stone_38'`, [stone38Used]);
    for (const t of tankReadings) {
      await client.query(`UPDATE materials SET current_stock = $1 WHERE code = $2`, [t.end, t.code]);
    }
    await client.query(`UPDATE materials SET current_stock = $1 WHERE code = 'fuel_oil'`, [oilEnd]);

    const insertRes = await client.query(
      `INSERT INTO production_logs
        (production_date, tons_produced, asphalt_ratio_per_ton, stone_dust_used, stone_34_used, stone_38_used, asphalt_used, tank_splits, oil_start, oil_end, oil_used, job_site, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [production_date, tons, ratio, stoneDustUsed, stone34Used, stone38Used, asphaltUsedKg, JSON.stringify(tankReadings), oilStart, oilEnd, oilUsed, job_site || null, created_by || null]
    );

    const targetKg = tons * ratio;
    const diffKg = asphaltUsedKg - targetKg;

    await client.query('COMMIT');
    res.json({ success: true, log: insertRes.rows[0], targetKg, diffKg });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ลบรายการผลิต + คืนสต็อกที่ตัดไปทั้งหมด
app.delete('/api/production/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const logRes = await client.query('SELECT * FROM production_logs WHERE id = $1', [id]);
    if (logRes.rows.length === 0) throw new Error('ไม่พบรายการนี้');
    const log = logRes.rows[0];

    await client.query(`UPDATE materials SET current_stock = current_stock + $1 WHERE code = 'stone_dust'`, [log.stone_dust_used]);
    await client.query(`UPDATE materials SET current_stock = current_stock + $1 WHERE code = 'stone_34'`, [log.stone_34_used]);
    await client.query(`UPDATE materials SET current_stock = current_stock + $1 WHERE code = 'stone_38'`, [log.stone_38_used]);
    const splits = log.tank_splits || [];
    for (const s of splits) {
      if (s.start !== undefined && s.end !== undefined) {
        // รูปแบบใหม่: บันทึกระดับต้นวัน/สิ้นวันตรงๆ ต่อถัง -> คืนสต็อกกลับเป็นค่าต้นวัน
        await client.query(`UPDATE materials SET current_stock = $1 WHERE code = $2`, [s.start, s.code]);
      } else if (s.liters !== undefined) {
        // รูปแบบเก่า: กรอกลิตรที่ใช้ต่อถัง -> คืนด้วยการแปลงลิตร/960
        const tonsToRestore = s.liters / ASPHALT_LITERS_PER_TON;
        await client.query(`UPDATE materials SET current_stock = current_stock + $1 WHERE code = $2`, [tonsToRestore, s.code]);
      }
    }
    if (log.oil_start !== null) {
      await client.query(`UPDATE materials SET current_stock = $1 WHERE code = 'fuel_oil'`, [log.oil_start]);
    }

    await client.query('DELETE FROM production_logs WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/logs/production', async (req, res) => {
  const { from, to } = req.query;
  try {
    let q = 'SELECT * FROM production_logs';
    const params = [];
    if (from && to) {
      q += ' WHERE production_date BETWEEN $1 AND $2';
      params.push(from, to);
    }
    q += ' ORDER BY production_date DESC, created_at DESC LIMIT 200';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// DIESEL (แยกจากการผลิต ใช้กับรถสิบล้อ) — เลขไมล์ตู้จ่ายเพิ่มขึ้นเรื่อยๆ
// ============================================================
app.get('/api/diesel/last', async (req, res) => {
  try {
    const r = await pool.query('SELECT meter_end FROM diesel_logs ORDER BY created_at DESC LIMIT 1');
    if (r.rows.length > 0) {
      return res.json({ meter: Number(r.rows[0].meter_end) });
    }
    const fallback = await pool.query(`SELECT value FROM settings WHERE key = 'diesel_meter_fallback'`);
    res.json({ meter: fallback.rows[0] ? Number(fallback.rows[0].value) : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/diesel', async (req, res) => {
  const { log_date, meter_start, meter_end, created_by } = req.body;
  const start = toNum(meter_start);
  const end = toNum(meter_end);

  if (!log_date || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return res.status(400).json({ error: 'กรอกเลขไมล์ให้ถูกต้อง (สิ้นวันต้องมากกว่าต้นวัน)' });
  }
  const used = end - start;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE materials SET current_stock = current_stock - $1 WHERE code = 'diesel'`, [used]);
    const insertRes = await client.query(
      `INSERT INTO diesel_logs (log_date, meter_start, meter_end, liters_used, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [log_date, start, end, used, created_by || null]
    );
    await client.query('COMMIT');
    res.json({ success: true, log: insertRes.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/diesel/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logRes = await client.query('SELECT * FROM diesel_logs WHERE id = $1', [id]);
    if (logRes.rows.length === 0) throw new Error('ไม่พบรายการนี้');
    const log = logRes.rows[0];
    await client.query(`UPDATE materials SET current_stock = current_stock + $1 WHERE code = 'diesel'`, [log.liters_used]);
    await client.query('DELETE FROM diesel_logs WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/logs/diesel', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM diesel_logs ORDER BY log_date DESC, created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// RECEIVING / นำเข้าวัสดุ (ไม่ต้องใช้ PIN)
// ============================================================
app.get('/api/companies', async (req, res) => {
  try {
    const r = await pool.query('SELECT name FROM companies ORDER BY name');
    res.json(r.rows.map((row) => row.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/companies', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'กรอกชื่อบริษัท' });
  try {
    await upsertCompany(name.trim());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/plates', async (req, res) => {
  try {
    const r = await pool.query('SELECT plate FROM vehicle_plates ORDER BY plate');
    res.json(r.rows.map((row) => row.plate));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plates', async (req, res) => {
  const { plate } = req.body;
  if (!plate || !plate.trim()) return res.status(400).json({ error: 'กรอกทะเบียนรถ' });
  try {
    await upsertPlate(plate.trim());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/companies/:name', requirePin, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    await pool.query('DELETE FROM companies WHERE name = $1', [name]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/plates/:plate', requirePin, async (req, res) => {
  try {
    const plate = decodeURIComponent(req.params.plate);
    await pool.query('DELETE FROM vehicle_plates WHERE plate = $1', [plate]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/receiving', async (req, res) => {
  const { material_code, amount, company, plate, receiving_date, created_by } = req.body;
  const amt = toNum(amount);

  if (!material_code || !Number.isFinite(amt) || amt <= 0 || !receiving_date) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upd = await client.query(
      `UPDATE materials SET current_stock = current_stock + $1 WHERE code = $2 RETURNING *`,
      [amt, material_code]
    );
    if (upd.rows.length === 0) throw new Error('ไม่พบวัสดุนี้');

    if (company) await upsertCompany(company.trim());
    if (plate) await upsertPlate(plate.trim());

    const insertRes = await client.query(
      `INSERT INTO stock_receiving (material_code, amount, company, plate, receiving_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [material_code, amt, company || null, plate || null, receiving_date, created_by || null]
    );

    await client.query('COMMIT');
    res.json({ success: true, log: insertRes.rows[0], material: upd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/receiving/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logRes = await client.query('SELECT * FROM stock_receiving WHERE id = $1', [id]);
    if (logRes.rows.length === 0) throw new Error('ไม่พบรายการนี้');
    const log = logRes.rows[0];
    await client.query(`UPDATE materials SET current_stock = current_stock - $1 WHERE code = $2`, [log.amount, log.material_code]);
    await client.query('DELETE FROM stock_receiving WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/logs/receiving', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, m.name as material_name, m.unit FROM stock_receiving r
       JOIN materials m ON m.code = r.material_code
       ORDER BY r.receiving_date DESC, r.created_at DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SETTINGS (PIN protected) — ปรับสต็อกด้วยมือ / แก้สูตร / เปลี่ยน PIN
// ============================================================
app.post('/api/settings/verify', async (req, res) => {
  const pin = await getAdminPin();
  res.json({ valid: req.body.pin === pin });
});

app.post('/api/adjust', requirePin, async (req, res) => {
  const { material_code, new_value, reason, created_by } = req.body;
  const newVal = toNum(new_value);

  if (!material_code || !Number.isFinite(newVal) || newVal < 0) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT current_stock FROM materials WHERE code = $1', [material_code]);
    if (cur.rows.length === 0) throw new Error('ไม่พบวัสดุนี้');
    const oldVal = Number(cur.rows[0].current_stock);

    await client.query('UPDATE materials SET current_stock = $1 WHERE code = $2', [newVal, material_code]);

    const insertRes = await client.query(
      `INSERT INTO stock_adjustments (material_code, old_value, new_value, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [material_code, oldVal, newVal, reason || null, created_by || null]
    );

    await client.query('COMMIT');
    res.json({ success: true, log: insertRes.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/materials/:code', requirePin, async (req, res) => {
  const { code } = req.params;
  const { ratio_per_ton, low_stock_alert } = req.body;

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (ratio_per_ton !== undefined && ratio_per_ton !== null && ratio_per_ton !== '') {
      fields.push(`ratio_per_ton = $${idx++}`);
      values.push(toNum(ratio_per_ton));
    }
    if (low_stock_alert !== undefined && low_stock_alert !== null && low_stock_alert !== '') {
      fields.push(`low_stock_alert = $${idx++}`);
      values.push(toNum(low_stock_alert));
    }
    if (fields.length === 0) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' });

    values.push(code);
    const r = await pool.query(
      `UPDATE materials SET ${fields.join(', ')} WHERE code = $${idx} RETURNING *`,
      values
    );
    res.json({ success: true, material: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/pin', requirePin, async (req, res) => {
  const { new_pin } = req.body;
  if (!new_pin || String(new_pin).length < 4) {
    return res.status(400).json({ error: 'PIN ต้องมีอย่างน้อย 4 หลัก' });
  }
  try {
    await pool.query(`UPDATE settings SET value = $1 WHERE key = 'admin_pin'`, [String(new_pin)]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- page routes ----------
app.get('/', (req, res) => res.redirect('/production'));
app.get('/production', (req, res) => res.sendFile(path.join(__dirname, 'production.html')));
app.get('/stock', (req, res) => res.sendFile(path.join(__dirname, 'stock.html')));
app.get('/import', (req, res) => res.sendFile(path.join(__dirname, 'import.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'settings.html')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to init DB:', e);
    process.exit(1);
  });
