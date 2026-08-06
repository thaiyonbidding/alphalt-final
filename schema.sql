-- ระบบตัดสต็อกโรงงานผลิตยางมะตอย (v2)
-- หิน 3 ชนิด: หน่วยตัน, สูตรคงที่ต่อ 1 ตัน HOT MIX
-- ยางมะตอย: แยก 4 ถังอิสระ, หน่วยลิตร, ไม่มีสูตรคงที่ (กรอกเองทุกครั้ง แบ่งได้หลายถัง)
-- น้ำมันเตา: ผูกกับรอบผลิต กรอกระดับต้นวัน/สิ้นวัน ตั้งสต็อกเป็นค่าสิ้นวันโดยตรง (อ่านจากเกจจริง)
-- น้ำมันดีเซล: แยกจากการผลิตโดยสิ้นเชิง ใช้กับรถสิบล้อ กรอกเลขไมล์ตู้จ่าย (เพิ่มขึ้นเรื่อยๆ) หักออกจากสต็อกดีเซล

CREATE TABLE IF NOT EXISTS materials (
  code            VARCHAR(20) PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  unit            VARCHAR(10) NOT NULL,      -- 'ton' or 'liter'
  current_stock   NUMERIC(14,2) NOT NULL DEFAULT 0,
  ratio_per_ton   NUMERIC(10,4),             -- fixed ratio (unit per 1 ton HOT MIX). NULL = manual/variable
  low_stock_alert NUMERIC(14,2) DEFAULT 0,
  display_order   INT NOT NULL DEFAULT 0
);

INSERT INTO materials (code, name, unit, ratio_per_ton, low_stock_alert, display_order) VALUES
  ('stone_dust', 'หินฝุ่น',        'ton',   0.434, 100,  1),
  ('stone_34',   'หิน 3/4',        'ton',   0.267, 80,   2),
  ('stone_38',   'หิน 3/8',        'ton',   0.300, 80,   3),
  ('asphalt_1',  'ยางมะตอย ถัง 1', 'liter', NULL,  2500, 4),
  ('asphalt_2',  'ยางมะตอย ถัง 2', 'liter', NULL,  2500, 5),
  ('asphalt_3',  'ยางมะตอย ถัง 3', 'liter', NULL,  2500, 6),
  ('asphalt_4',  'ยางมะตอย ถัง 4', 'liter', NULL,  2500, 7),
  ('fuel_oil',   'น้ำมันเตา',      'liter', NULL,  800,  8),
  ('diesel',     'น้ำมันดีเซล',    'liter', NULL,  500,  9)
ON CONFLICT (code) DO NOTHING;

-- บันทึกการผลิตประจำวัน (โดยทั่วไป 1 รอบ/วัน)
CREATE TABLE IF NOT EXISTS production_logs (
  id                    SERIAL PRIMARY KEY,
  production_date       DATE NOT NULL,
  tons_produced         NUMERIC(10,2) NOT NULL,
  asphalt_ratio_per_ton NUMERIC(10,4) NOT NULL,
  stone_dust_used       NUMERIC(12,2) NOT NULL,
  stone_34_used         NUMERIC(12,2) NOT NULL,
  stone_38_used         NUMERIC(12,2) NOT NULL,
  asphalt_used          NUMERIC(12,2) NOT NULL,   -- รวมทุกถัง
  tank_splits           JSONB NOT NULL,           -- [{code:'asphalt_1', liters: 700}, ...]
  oil_start             NUMERIC(12,2),
  oil_end               NUMERIC(12,2),
  oil_used              NUMERIC(12,2),
  job_site              VARCHAR(255),
  created_by            VARCHAR(100),
  created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

-- น้ำมันดีเซล: เลขไมล์ตู้จ่าย แยกจากการผลิต ใช้กับรถสิบล้อ
CREATE TABLE IF NOT EXISTS diesel_logs (
  id            SERIAL PRIMARY KEY,
  log_date      DATE NOT NULL,
  meter_start   NUMERIC(14,2) NOT NULL,
  meter_end     NUMERIC(14,2) NOT NULL,
  liters_used   NUMERIC(12,2) NOT NULL,
  created_by    VARCHAR(100),
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- รายชื่อบริษัทคู่ค้า (สำหรับดรอปดาวน์ในหน้านำเข้า)
CREATE TABLE IF NOT EXISTS companies (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(200) UNIQUE NOT NULL
);

-- ทะเบียนรถ (สำหรับดรอปดาวน์ในหน้านำเข้า)
CREATE TABLE IF NOT EXISTS vehicle_plates (
  id    SERIAL PRIMARY KEY,
  plate VARCHAR(50) UNIQUE NOT NULL
);

-- รับวัสดุเข้า (ไม่ต้องใช้ PIN)
CREATE TABLE IF NOT EXISTS stock_receiving (
  id              SERIAL PRIMARY KEY,
  material_code   VARCHAR(20) NOT NULL REFERENCES materials(code),
  amount          NUMERIC(14,2) NOT NULL,
  company         VARCHAR(200),
  plate           VARCHAR(50),
  receiving_date  DATE NOT NULL,
  created_by      VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ปรับสต็อกด้วยมือ (ตั้งสต็อกเริ่มต้น / แก้ให้ตรงของจริง) — ต้องใช้ PIN
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id              SERIAL PRIMARY KEY,
  material_code   VARCHAR(20) NOT NULL REFERENCES materials(code),
  old_value       NUMERIC(14,2) NOT NULL,
  new_value       NUMERIC(14,2) NOT NULL,
  reason          TEXT,
  created_by      VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value TEXT
);

INSERT INTO settings (key, value) VALUES
  ('admin_pin', '1234'),
  ('diesel_meter_fallback', '100000')
ON CONFLICT (key) DO NOTHING;
