/**
 * SQLite 建表 DDL —— 与原 sync_energy_to_sqlite.py 的 init_database 保持一致。
 * 全部使用 IF NOT EXISTS，幂等执行。
 */
export const INIT_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  meter_count INTEGER DEFAULT 0,
  address TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS meters (
  meter_no TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  room_detail_addr TEXT,
  category TEXT,
  rate REAL DEFAULT 1.0,
  ct_rate TEXT,
  pt_rate TEXT,
  gateway_no TEXT,
  meter_type TEXT,
  comm_type TEXT,
  imei_no TEXT,
  sim_no TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS meter_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_no TEXT NOT NULL,
  project_id TEXT NOT NULL,
  data_time TEXT NOT NULL,
  total_kwh REAL DEFAULT 0.0,
  rate1_kwh REAL DEFAULT 0.0,
  rate2_kwh REAL DEFAULT 0.0,
  rate3_kwh REAL DEFAULT 0.0,
  rate4_kwh REAL DEFAULT 0.0,
  multiplier REAL DEFAULT 1.0,
  real_kwh REAL DEFAULT 0.0,
  created_at TEXT,
  UNIQUE (meter_no, data_time)
);

CREATE TABLE IF NOT EXISTS meter_load_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_no TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sample_time TEXT NOT NULL,
  total_kwh REAL DEFAULT 0.0,
  rate1_kwh REAL DEFAULT 0.0,
  rate2_kwh REAL DEFAULT 0.0,
  rate3_kwh REAL DEFAULT 0.0,
  rate4_kwh REAL DEFAULT 0.0,
  multiplier REAL DEFAULT 1.0,
  real_kwh REAL DEFAULT 0.0,
  relay_status TEXT,
  online_status TEXT,
  created_at TEXT,
  UNIQUE (meter_no, sample_time)
);

CREATE TABLE IF NOT EXISTS alarm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_no TEXT NOT NULL,
  project_id TEXT NOT NULL,
  alarm_time TEXT NOT NULL,
  alarm_name TEXT NOT NULL,
  alarm_code TEXT,
  room_addr TEXT,
  alarm_status TEXT,
  raw_data TEXT,
  created_at TEXT,
  UNIQUE (meter_no, alarm_time, alarm_name)
);

CREATE INDEX IF NOT EXISTS idx_readings_time ON meter_readings (data_time);
CREATE INDEX IF NOT EXISTS idx_readings_meter ON meter_readings (meter_no);
CREATE INDEX IF NOT EXISTS idx_samples_time ON meter_load_samples (sample_time);
CREATE INDEX IF NOT EXISTS idx_samples_meter_time ON meter_load_samples (meter_no, sample_time);
CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarm_events (alarm_time);
`;
