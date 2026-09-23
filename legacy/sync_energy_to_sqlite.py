#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IEMS/BBICloud 智能电表数据三级同步工具（写入 SQLite）

本脚本针对「宁波慈溪凤起潮鸣」项目（ID: 202607020000000001）
构建了三级查询与同步机制：
  1. 【天级 - Daily】: 每天查询一次全量电表日冻结数据（存入 meter_readings）
  2. 【15分钟级 - Sample】: 每 15 分钟查询一次实时负荷采样及运行工况（存入 meter_load_samples）
  3. 【分钟级 - Alarm】: 每 1 分钟轮询一次突发告警事件（存入 alarm_events）

特性：
  - 支持单次按模式执行：--mode [daily|sample|alarm|all]
  - 支持内置守护进程自动调度：--daemon（常驻后台，自动按 1天/15分/1分 节拍循环拉取）
  - 自动创建并维护 SQLite 表结构与查询索引
  - 会话失效自动静默重登续期（基于前台 RSA 加密算法）
  - 零外部依赖：纯 Python 标准库构建

使用示例：
  # 1. 单次执行：拉取今天日冻结数据
  python3 sync_energy_to_sqlite.py --mode daily

  # 2. 单次执行：拉取当前 15 分钟实时负荷采样
  python3 sync_energy_to_sqlite.py --mode sample

  # 3. 单次执行：扫描最近突发告警
  python3 sync_energy_to_sqlite.py --mode alarm

  # 4. 单次执行：完整执行三级同步
  python3 sync_energy_to_sqlite.py --mode all

  # 5. 常驻后台守护进程：自动按各自频率执行
  python3 sync_energy_to_sqlite.py --daemon

  # 6. 查看 SQLite 数据库综合概览
  python3 sync_energy_to_sqlite.py --summary
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
import logging
import os
from pathlib import Path
import sqlite3
import ssl
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("SyncEnergy")

# 默认配置参数
DEFAULT_PROJECT_ID = "202607020000000001"
DEFAULT_PROJECT_NAME = "宁波慈溪凤起潮鸣"
DEFAULT_DB_PATH = Path(__file__).resolve().parent / "energy_data.db"
DEFAULT_SESSION_FILE = Path(__file__).resolve().parent / ".bbi_session"
DEFAULT_BASE_URL = "https://a.bbicloud.com"

# 默认内置会话与账号配置
DEFAULT_SID = os.getenv("BBI_SID", "")
DEFAULT_USERNAME = os.getenv("BBI_USERNAME", "")
DEFAULT_PASSWORD = os.getenv("BBI_PASSWORD", "")


def classify_meter(room_name: str) -> str:
    """按房间与安装点位名称归集主要用电场景（与看板 app.py 分类保持一致）。"""
    name = room_name.lower()
    rules = [
        ("空调", "空调系统"),
        ("照明", "照明系统"),
        ("水泵", "给排水系统"),
        ("电梯", "电梯系统"),
        ("花房", "花房"),
        ("儿童", "儿童空间"),
        ("宠物", "宠物用房"),
        ("学习", "学习盒子"),
        ("日咖", "日咖夜酒"),
    ]
    for keyword, category in rules:
        if keyword in name:
            return category
    return "其他负荷"


def init_database(db_path: Path | str) -> sqlite3.Connection:
    """初始化 SQLite 数据库与数据表结构（三级模型）。"""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # 1. 项目基础信息表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        meter_count INTEGER DEFAULT 0,
        address TEXT,
        updated_at TEXT
    );
    """)

    # 2. 表计台账表（包含变比、通信规约、IMEI）
    cursor.execute("""
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
        updated_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects (project_id)
    );
    """)

    # 兼容历史 meters 表字段（若不存在则动态添加）
    cursor.execute("PRAGMA table_info(meters);")
    columns = [col[1] for col in cursor.fetchall()]
    for col_name in ["comm_type", "imei_no", "sim_no"]:
        if col_name not in columns:
            try:
                cursor.execute(f"ALTER TABLE meters ADD COLUMN {col_name} TEXT;")
            except sqlite3.OperationalError:
                pass

    # 3. 第一级：每日抄表日冻结数据表 (Daily Freeze)
    cursor.execute("""
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
    """)

    # 4. 第二级：每 15 分钟负荷采样与运行工况表 (15-min Load Samples)
    cursor.execute("""
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
    """)

    # 5. 第三级：每分钟突发告警事件表 (Minute-level Alarms)
    cursor.execute("""
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
    """)

    # 索引优化
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_readings_time ON meter_readings (data_time);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_samples_time ON meter_load_samples (sample_time);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarm_events (alarm_time);")

    conn.commit()
    return conn


def auto_login_and_get_sid(username: str, password: str) -> Optional[str]:
    """通过 Node.js 动态调用前端 RSA 算法，实现全自动静默登录并返回新会话 sid。"""
    if not username or not password:
        return None

    logger.info("正在尝试自动登录平台刷新会话 (账号: %s)...", username)
    js_code = f"""
    global.window = global;
    const https = require("https");
    function fetchUrl(url, cookie="") {{
      return new Promise((resolve, reject) => {{
        https.get(url, {{rejectUnauthorized:false, headers: {{Cookie: cookie, "User-Agent":"Mozilla/5.0"}}}}, res => {{
          let d=""; res.on("data", c=>d+=c); res.on("end", ()=>resolve({{headers: res.headers, data:d}}));
        }}).on("error", reject);
      }});
    }}
    async function run() {{
      try {{
        const rsaResp = await fetchUrl("https://a.bbicloud.com/platform/login/getRsaKey");
        const rsaKey = JSON.parse(rsaResp.data).data;
        const initialCookie = (rsaResp.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

        const chunkResp = await fetchUrl("https://a.bbicloud.com/static/js/chunk-0b08b4aa.c3b79fcf.js");
        const start = chunkResp.data.indexOf("\\"3e7e\\":function(");
        const funcStart = chunkResp.data.indexOf("function(", start);
        const end = chunkResp.data.indexOf(",5301:", start);
        const code = chunkResp.data.slice(funcStart, end);
        const fn = new Function("i", "t", "e", `(${{code}})(i, t, e);`);
        fn({{}}, {{}}, () => {{}});

        const RSAUtils = global.RSAUtils;
        RSAUtils.setMaxDigits(200);
        const keyPair = RSAUtils.getKeyPair(rsaKey.publicKeyExponent, "", rsaKey.publicKeyModulus);
        const encPwd = RSAUtils.encryptedString(keyPair, "{password}".split("").reverse().join(""));

        const postData = new URLSearchParams({{
          username: "{username}",
          password: encPwd,
          client: "PC",
          platformCaptcha: ""
        }}).toString();

        const req = https.request("https://a.bbicloud.com/platform/login/doLogin", {{
          method: "POST",
          rejectUnauthorized: false,
          headers: {{
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://a.bbicloud.com/v2/",
            "Cookie": initialCookie
          }}
        }}, res => {{
          let d = ""; res.on("data", c=>d+=c);
          res.on("end", () => {{
            try {{
              const resObj = JSON.parse(d);
              if (resObj.code === 0) {{
                const m = initialCookie.match(/sid=([a-zA-Z0-9]+)/);
                console.log(JSON.stringify({{ success: true, sid: resObj.data || (m ? m[1] : "") }}));
              }} else {{
                console.log(JSON.stringify({{ success: false, msg: resObj.msg }}));
              }}
            }} catch(e) {{
              console.log(JSON.stringify({{ success: false, msg: e.message }}));
            }}
          }});
        }});
        req.write(postData);
        req.end();
      }} catch(err) {{
        console.log(JSON.stringify({{ success: false, msg: err.message }}));
      }}
    }}
    run();
    """

    try:
        proc = subprocess.run(["node", "-e", js_code], capture_output=True, text=True, timeout=15)
        out = proc.stdout.strip()
        if out:
            data = json.loads(out)
            if data.get("success") and data.get("sid"):
                new_sid = data["sid"]
                logger.info("自动登录成功！获取到全新会话 SID: %s...", new_sid[:8])
                DEFAULT_SESSION_FILE.write_text(new_sid, encoding="utf-8")
                return new_sid
            else:
                logger.error("自动登录失败: %s", data.get("msg", "未知原因"))
    except Exception as e:
        logger.warning("未能执行自动登录重试: %s", e)
    return None


def get_active_sid(configured_sid: str = "", username: str = "", password: str = "") -> str:
    """获取当前可用的 Session ID（优先传入 -> 缓存文件 -> 环境变量 -> 自动登录）。"""
    if configured_sid:
        return configured_sid

    if DEFAULT_SESSION_FILE.exists():
        cached = DEFAULT_SESSION_FILE.read_text(encoding="utf-8").strip()
        if cached:
            return cached

    if username and password:
        new_sid = auto_login_and_get_sid(username, password)
        if new_sid:
            return new_sid

    return DEFAULT_SID


def make_request(
    url: str,
    sid: str,
    credentials: Optional[Tuple[str, str]] = None,
    timeout: int = 10
) -> Tuple[Optional[Dict[str, Any]], str]:
    """统一 HTTP 请求工具函数，支持过期自动重登重试。"""
    current_sid = sid
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    for attempt in range(2):
        req = urllib.request.Request(
            url,
            headers={
                "Cookie": f"sid={current_sid}",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Referer": "https://a.bbicloud.com/v2/",
                "Accept": "application/json, text/plain, */*"
            }
        )

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("code") == 401 or "失效" in data.get("msg", ""):
                    raise urllib.error.HTTPError(url, 401, "Session Expired", {}, None)
                return data, current_sid
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                logger.warning("Session SID (%s...) 已失效 (HTTP %d)。", current_sid[:8], e.code)
                if attempt == 0 and credentials and credentials[0] and credentials[1]:
                    logger.info("正在启动自动登录刷新通道...")
                    refreshed = auto_login_and_get_sid(credentials[0], credentials[1])
                    if refreshed:
                        current_sid = refreshed
                        continue
                logger.error("会话失效且未能自动刷新。")
                return None, current_sid
            else:
                logger.error("HTTP 异常 [%d]: %s", e.code, e.reason)
                return None, current_sid
        except Exception as e:
            logger.error("网络请求异常: %s", e)
            return None, current_sid

    return None, current_sid


# =============================================================================
# 一、天级同步：日冻结数据 (Daily Freeze)
# =============================================================================

def sync_daily_freeze(
    conn: sqlite3.Connection,
    sid: str,
    project_id: str,
    project_name: str,
    target_dates: List[str],
    credentials: Optional[Tuple[str, str]] = None
) -> Tuple[int, str]:
    """拉取全量 24 块电表的日冻结读数并存入 meter_readings。"""
    total_saved = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()

    for target_date in target_dates:
        logger.info("[Tier-1 日冻结] 正在拉取日期: %s ...", target_date)
        params = {
            "bar_project_id": project_id,
            "date": target_date,
            "bar_measure_type": "00080001",
            "pageNumber": 1,
            "pageSize": 50
        }
        url = f"{DEFAULT_BASE_URL}/platform/bar/engineer/getReadingDataInfo/V2?{urllib.parse.urlencode(params)}"
        resp, sid = make_request(url, sid=sid, credentials=credentials)

        if not resp or resp.get("code") != 0:
            logger.warning("[Tier-1 日冻结] 日期 %s 拉取失败或无数据。", target_date)
            continue

        readings = resp.get("data", {}).get("datas", [])
        if not readings:
            continue

        # 更新项目表
        cursor.execute("""
        INSERT INTO projects (project_id, project_name, meter_count, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
            project_name = excluded.project_name,
            meter_count = excluded.meter_count,
            updated_at = excluded.updated_at;
        """, (project_id, project_name, len(readings), now_str))

        meter_records = []
        reading_records = []

        for item in readings:
            meter_no = str(item.get("meter_no", "")).strip()
            if not meter_no:
                continue

            cons_info = item.get("mbr_cons_info", {}) or {}
            room_addr = cons_info.get("room_detail_addr", "") or ""
            category = classify_meter(room_addr)
            
            raw_rate = cons_info.get("rate", "1")
            try:
                rate_val = float(raw_rate) if raw_rate else 1.0
            except (ValueError, TypeError):
                rate_val = 1.0

            ct_rate = str(cons_info.get("ct_rate", ""))
            pt_rate = str(cons_info.get("pt_rate", ""))
            gateway_no = str(item.get("gateway_no", "") or cons_info.get("bar_gateway_no", ""))
            meter_type = str(item.get("meter_type", "00080001"))

            meter_records.append((
                meter_no, project_id, room_addr, category,
                rate_val, ct_rate, pt_rate, gateway_no, meter_type, now_str
            ))

            total_kwh = float(item.get("zxygzdl", 0.0) or 0.0)
            rate1 = float(item.get("zxygzdl1", 0.0) or 0.0)
            rate2 = float(item.get("zxygzdl2", 0.0) or 0.0)
            rate3 = float(item.get("zxygzdl3", 0.0) or 0.0)
            rate4 = float(item.get("zxygzdl4", 0.0) or 0.0)
            data_time = str(item.get("sjsj", target_date)).strip()
            real_kwh = round(total_kwh * rate_val, 2)

            reading_records.append((
                meter_no, project_id, data_time,
                total_kwh, rate1, rate2, rate3, rate4,
                rate_val, real_kwh, now_str
            ))

        # 更新台账表
        cursor.executemany("""
        INSERT INTO meters (
            meter_no, project_id, room_detail_addr, category,
            rate, ct_rate, pt_rate, gateway_no, meter_type, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(meter_no) DO UPDATE SET
            room_detail_addr = excluded.room_detail_addr,
            category = excluded.category,
            rate = excluded.rate,
            ct_rate = excluded.ct_rate,
            pt_rate = excluded.pt_rate,
            gateway_no = excluded.gateway_no,
            updated_at = excluded.updated_at;
        """, meter_records)

        # 写入日冻结读数
        cursor.executemany("""
        INSERT INTO meter_readings (
            meter_no, project_id, data_time,
            total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh,
            multiplier, real_kwh, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(meter_no, data_time) DO UPDATE SET
            total_kwh = excluded.total_kwh,
            rate1_kwh = excluded.rate1_kwh,
            rate2_kwh = excluded.rate2_kwh,
            rate3_kwh = excluded.rate3_kwh,
            rate4_kwh = excluded.rate4_kwh,
            multiplier = excluded.multiplier,
            real_kwh = excluded.real_kwh,
            created_at = excluded.created_at;
        """, reading_records)

        conn.commit()
        total_saved += len(reading_records)
        logger.info("[Tier-1 日冻结] 成功入库 %d 条记录 (%s)。", len(reading_records), target_date)

    return total_saved, sid


# =============================================================================
# 二、15分钟级同步：实时负荷采样与工况 (15-min Load Samples)
# =============================================================================

def sync_load_samples(
    conn: sqlite3.Connection,
    sid: str,
    project_id: str,
    project_name: str,
    credentials: Optional[Tuple[str, str]] = None
) -> Tuple[int, str]:
    """拉取当前全量 24 块电表的实时工况与最新负荷读数，存入 meter_load_samples。"""
    logger.info("[Tier-2 负荷采样] 正在拉取 24 块电表当前最新实时采样...")
    params = {
        "bar_project_id": project_id,
        "bar_measure_type": "00080001",
        "pageNumber": 1,
        "pageSize": 50
    }
    url = f"{DEFAULT_BASE_URL}/platform/bar/engineer/getAllMetersV3?{urllib.parse.urlencode(params)}"
    resp, sid = make_request(url, sid=sid, credentials=credentials)

    if not resp or resp.get("code") != 0:
        logger.warning("[Tier-2 负荷采样] 拉取实时设备工况失败。")
        return 0, sid

    meter_list = resp.get("data", {}).get("data", [])
    if not meter_list:
        logger.info("[Tier-2 负荷采样] 未获取到电表数据。")
        return 0, sid

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()

    sample_records = []
    meta_updates = []

    for item in meter_list:
        meter_no = str(item.get("bar_measure_no", "")).strip()
        if not meter_no:
            continue

        sample_time = str(item.get("last_online_time") or now_str).strip()
        room_addr = item.get("room_detail_addr", "")
        category = classify_meter(room_addr)

        raw_rate = item.get("rate", "1")
        try:
            rate_val = float(raw_rate) if raw_rate else 1.0
        except (ValueError, TypeError):
            rate_val = 1.0

        total_kwh = float(item.get("zxygzdl", 0.0) or 0.0)
        rate1 = float(item.get("zxygzdl1", 0.0) or 0.0)
        rate2 = float(item.get("zxygzdl2", 0.0) or 0.0)
        rate3 = float(item.get("zxygzdl3", 0.0) or 0.0)
        rate4 = float(item.get("zxygzdl4", 0.0) or 0.0)
        real_kwh = round(total_kwh * rate_val, 2)

        relay_status = str(item.get("bar_measure_jdqzt", ""))
        online_status = str(item.get("onlinestutus", ""))
        comm_type = str(item.get("comm_type_desc", ""))
        imei_no = str(item.get("imei_no", ""))
        sim_no = str(item.get("sim_no", ""))
        gateway_no = str(item.get("bar_gateway_no", ""))

        sample_records.append((
            meter_no, project_id, sample_time,
            total_kwh, rate1, rate2, rate3, rate4,
            rate_val, real_kwh, relay_status, online_status, now_str
        ))

        meta_updates.append((
            meter_no, project_id, room_addr, category,
            rate_val, comm_type, imei_no, sim_no, gateway_no, now_str
        ))

    # 更新 meter_load_samples 表
    cursor.executemany("""
    INSERT INTO meter_load_samples (
        meter_no, project_id, sample_time,
        total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh,
        multiplier, real_kwh, relay_status, online_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(meter_no, sample_time) DO UPDATE SET
        total_kwh = excluded.total_kwh,
        rate1_kwh = excluded.rate1_kwh,
        rate2_kwh = excluded.rate2_kwh,
        rate3_kwh = excluded.rate3_kwh,
        rate4_kwh = excluded.rate4_kwh,
        multiplier = excluded.multiplier,
        real_kwh = excluded.real_kwh,
        relay_status = excluded.relay_status,
        online_status = excluded.online_status,
        created_at = excluded.created_at;
    """, sample_records)

    # 顺便补全 meters 表中的通信属性
    cursor.executemany("""
    INSERT INTO meters (
        meter_no, project_id, room_detail_addr, category,
        rate, comm_type, imei_no, sim_no, gateway_no, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(meter_no) DO UPDATE SET
        room_detail_addr = excluded.room_detail_addr,
        category = excluded.category,
        rate = excluded.rate,
        comm_type = excluded.comm_type,
        imei_no = excluded.imei_no,
        sim_no = excluded.sim_no,
        gateway_no = excluded.gateway_no,
        updated_at = excluded.updated_at;
    """, meta_updates)

    conn.commit()
    logger.info("[Tier-2 负荷采样] 成功入库 %d 条采样记录（样本时间覆盖: %s）。", len(sample_records), sample_records[0][2] if sample_records else now_str)
    return len(sample_records), sid


def backfill_intraday_samples(
    conn: sqlite3.Connection,
    sid: str,
    project_id: str,
    target_spec: str = "today",
    credentials: Optional[Tuple[str, str]] = None,
    max_workers: int = 8
) -> Tuple[int, str]:
    """回填指定日期或最近 N 天的 15 分钟级时序负荷采样到 meter_load_samples。

    参数 target_spec:
      - "today", "当前", "今天", "": 仅回填今天
      - "YYYY-MM-DD": 回填指定单日
      - "7", "14", "30" 等正整数: 回填过去 N 天
    """
    spec = str(target_spec).strip().lower()
    now = datetime.now()
    dates_to_sync: List[str] = []

    if spec.isdigit():
        num_days = int(spec)
        for i in range(num_days):
            dates_to_sync.append((now - timedelta(days=i)).strftime("%Y-%m-%d"))
    elif spec in ("today", "当前", "今天", ""):
        dates_to_sync.append(now.strftime("%Y-%m-%d"))
    else:
        # 假定为 YYYY-MM-DD
        dates_to_sync.append(target_spec.strip())

    logger.info("[历史回填] 开始为日期列表 %s 批量并发回填 15 分钟级负荷采样数据...", dates_to_sync)
    cursor = conn.cursor()
    total_saved = 0
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")

    def _fetch_single_slice(dt_str: str) -> Tuple[str, List[Dict[str, Any]]]:
        params = {
            "bar_project_id": project_id,
            "date": dt_str,
            "bar_measure_type": "00080001",
            "pageNumber": 1,
            "pageSize": 50
        }
        url = f"{DEFAULT_BASE_URL}/platform/bar/engineer/getReadingDataInfo/V2?{urllib.parse.urlencode(params)}"
        resp, _ = make_request(url, sid=sid, credentials=credentials)
        if resp and resp.get("code") == 0:
            return dt_str, resp.get("data", {}).get("datas", [])
        return dt_str, []

    for date_str in dates_to_sync:
        time_points = []
        curr = datetime.strptime(f"{date_str} 00:00:00", "%Y-%m-%d %H:%M:%S")
        end = datetime.strptime(f"{date_str} 23:45:00", "%Y-%m-%d %H:%M:%S")
        if date_str == now.strftime("%Y-%m-%d"):
            end = now

        while curr <= end:
            time_points.append(curr.strftime("%Y-%m-%d %H:%M:%S"))
            curr += timedelta(minutes=15)

        logger.info("[历史回填] 正在并发获取 %s 的 %d 个 15 分钟采样时段...", date_str, len(time_points))

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            results = list(executor.map(_fetch_single_slice, time_points))

        day_records = []
        for dt_str, datas in results:
            for item in datas:
                meter_no = str(item.get("meter_no", "")).strip()
                if not meter_no:
                    continue

                raw_total = item.get("zxygzdl")
                if raw_total is None or str(raw_total).strip() in ("", "None"):
                    continue

                try:
                    total_kwh = float(raw_total)
                except (ValueError, TypeError):
                    continue

                if total_kwh <= 0.0:
                    continue

                cons = item.get("mbr_cons_info", {}) or {}
                raw_rate = cons.get("rate", "1")
                try:
                    rate_val = float(raw_rate) if raw_rate else 1.0
                except Exception:
                    rate_val = 1.0

                rate1 = float(item.get("zxygzdl1", 0.0) or 0.0)
                rate2 = float(item.get("zxygzdl2", 0.0) or 0.0)
                rate3 = float(item.get("zxygzdl3", 0.0) or 0.0)
                rate4 = float(item.get("zxygzdl4", 0.0) or 0.0)
                real_kwh = round(total_kwh * rate_val, 2)

                day_records.append((
                    meter_no, project_id, dt_str,
                    total_kwh, rate1, rate2, rate3, rate4,
                    rate_val, real_kwh, "合闸", "在线", now_str
                ))

        if day_records:
            cursor.executemany("""
            INSERT INTO meter_load_samples (
                meter_no, project_id, sample_time,
                total_kwh, rate1_kwh, rate2_kwh, rate3_kwh, rate4_kwh,
                multiplier, real_kwh, relay_status, online_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(meter_no, sample_time) DO UPDATE SET
                total_kwh = excluded.total_kwh,
                rate1_kwh = excluded.rate1_kwh,
                rate2_kwh = excluded.rate2_kwh,
                rate3_kwh = excluded.rate3_kwh,
                rate4_kwh = excluded.rate4_kwh,
                multiplier = excluded.multiplier,
                real_kwh = excluded.real_kwh,
                relay_status = excluded.relay_status,
                online_status = excluded.online_status,
                created_at = excluded.created_at;
            """, day_records)
            conn.commit()
            total_saved += len(day_records)
            logger.info("[历史回填] 日期 %s 成功写入 %d 条 15 分钟负荷样本。", date_str, len(day_records))

    logger.info("[历史回填] 全部回填完成！共计持久化 %d 条 15 分钟负荷时序记录。", total_saved)
    return total_saved, sid



# =============================================================================
# 三、分钟级同步：突发告警事件轮询 (1-min Alarms)
# =============================================================================

def sync_alarm_events(
    conn: sqlite3.Connection,
    sid: str,
    project_id: str,
    window_days: int = 3,
    credentials: Optional[Tuple[str, str]] = None
) -> Tuple[int, str]:
    """轮询近期突发告警事件，存入 alarm_events。"""
    now = datetime.now()
    start_time = (now - timedelta(days=window_days)).strftime("%Y-%m-%d 00:00:00")
    end_time = (now + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")

    params = {
        "bar_project_id": project_id,
        "start_time": start_time,
        "end_time": end_time,
        "pageNumber": 1,
        "pageSize": 50
    }
    url = f"{DEFAULT_BASE_URL}/platform/stat/meterAlarm/queryAlarmInfo?{urllib.parse.urlencode(params)}"
    resp, sid = make_request(url, sid=sid, credentials=credentials)

    if not resp or resp.get("code") != 0:
        logger.warning("[Tier-3 告警扫描] 查询告警事件失败。")
        return 0, sid

    alarm_list = resp.get("data", {}).get("list", [])
    if not alarm_list:
        logger.info("[Tier-3 告警扫描] 近期暂无未处理告警事件 (状态正常)。")
        return 0, sid

    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    cursor = conn.cursor()
    records = []

    for item in alarm_list:
        meter_no = str(item.get("bar_measure_no") or item.get("meter_no") or "").strip()
        alarm_time = str(item.get("alarm_time") or item.get("sjsj") or now_str).strip()
        alarm_name = str(item.get("alarm_name") or item.get("event_name") or "未命名告警").strip()
        alarm_code = str(item.get("alarm_code") or item.get("code") or "")
        room_addr = str(item.get("room_detail_addr") or "")
        alarm_status = str(item.get("status_desc") or item.get("status") or "告警中")
        raw_json = json.dumps(item, ensure_ascii=False)

        logger.warning("🚨 [发现设备告警] 表号: %s | 点位: %s | 事件: %s | 时间: %s", meter_no, room_addr, alarm_name, alarm_time)

        records.append((
            meter_no, project_id, alarm_time, alarm_name,
            alarm_code, room_addr, alarm_status, raw_json, now_str
        ))

    cursor.executemany("""
    INSERT INTO alarm_events (
        meter_no, project_id, alarm_time, alarm_name,
        alarm_code, room_addr, alarm_status, raw_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(meter_no, alarm_time, alarm_name) DO UPDATE SET
        alarm_status = excluded.alarm_status,
        created_at = excluded.created_at;
    """, records)

    conn.commit()
    logger.info("[Tier-3 告警扫描] 本次共记录/更新 %d 条告警事件。", len(records))
    return len(records), sid


# =============================================================================
# 四、后台常驻守护调度器 (--daemon 模式)
# =============================================================================

def run_daemon_scheduler(
    args: argparse.Namespace,
    db_path: Path | str
) -> None:
    """启动内置多频次调度器：天级、15分钟级、1分钟级协同运行。"""
    print("=" * 70)
    print("       IEMS-IOT 多层级守护进程已启动")
    print(f"目标项目: {args.project_name} (ID: {args.project_id})")
    print("调度策略:")
    print("  • 告警监测 (Alarm)  : 每 60 秒 (1 分钟) 轮询一次")
    print("  • 负荷采样 (Sample) : 每 900 秒 (15 分钟) 采集一次")
    print("  • 日冻结同步 (Daily) : 每天凌晨 02:00 同步一次（或启动时执行）")
    print("=" * 70)

    conn = init_database(db_path)
    sid = get_active_sid(configured_sid=args.sid, username=args.username, password=args.password)
    credentials = (args.username, args.password)

    last_alarm_check = 0.0
    last_sample_check = 0.0
    last_daily_sync_date = ""

    # 启动时先执行一次全量三级同步
    logger.info("正在执行启动首次三级对齐初始化...")
    today_date = datetime.now().strftime("%Y-%m-%d 00:00:00")
    _, sid = sync_daily_freeze(conn, sid, args.project_id, args.project_name, [today_date], credentials)
    _, sid = sync_load_samples(conn, sid, args.project_id, args.project_name, credentials)
    _, sid = sync_alarm_events(conn, sid, args.project_id, credentials=credentials)
    last_daily_sync_date = datetime.now().strftime("%Y-%m-%d")

    try:
        while True:
            current_time = time.time()
            now_dt = datetime.now()

            # 1. 分钟级：告警事件轮询 (间隔 60 秒)
            if current_time - last_alarm_check >= 60:
                _, sid = sync_alarm_events(conn, sid, args.project_id, credentials=credentials)
                last_alarm_check = current_time

            # 2. 15分钟级：负荷与工况采样 (间隔 900 秒)
            if current_time - last_sample_check >= 900:
                _, sid = sync_load_samples(conn, sid, args.project_id, args.project_name, credentials)
                last_sample_check = current_time

            # 3. 天级：每天凌晨 (跨天且超过 01:00) 自动执行日冻结读数同步
            today_str = now_dt.strftime("%Y-%m-%d")
            if today_str != last_daily_sync_date and now_dt.hour >= 1:
                yesterday_str = (now_dt - timedelta(days=1)).strftime("%Y-%m-%d 00:00:00")
                logger.info("[定时触发] 跨天触发日冻结同步: %s ...", yesterday_str)
                _, sid = sync_daily_freeze(conn, sid, args.project_id, args.project_name, [yesterday_str, f"{today_str} 00:00:00"], credentials)
                last_daily_sync_date = today_str

            time.sleep(5)  # 微休眠保持 CPU 友好

    except KeyboardInterrupt:
        logger.info("接收到退出信号，守护进程安全退出。")
    finally:
        conn.close()


# =============================================================================
# 五、统计概览输出 (--summary)
# =============================================================================

def print_database_summary(db_path: Path | str) -> None:
    """打印当前 SQLite 数据库中保存的三级业务数据统计概览。"""
    if not Path(db_path).exists():
        print(f"数据库文件不存在: {db_path}")
        return

    conn = init_database(db_path)
    cursor = conn.cursor()

    print("\n" + "=" * 80)
    print(f"       【本地 SQLite 数据库三级监控总览】: {db_path}")
    print("=" * 80)

    # 1. 项目与表计静态档案
    cursor.execute("SELECT project_id, project_name, meter_count, updated_at FROM projects;")
    projects = cursor.fetchall()
    for pid, pname, mcount, u_time in projects:
        print(f"• 项目: {pname} (ID: {pid}) | 表计数量: {mcount} | 最近更新: {u_time}")

    cursor.execute("""
    SELECT category, COUNT(meter_no) FROM meters GROUP BY category ORDER BY COUNT(meter_no) DESC;
    """)
    cat_counts = cursor.fetchall()
    print("\n[用电场景分布统计]")
    for cat, count in cat_counts:
        print(f"  - {cat:12}: {count} 块电表")

    # 2. 第一级：日冻结历史读数统计
    cursor.execute("""
    SELECT r.data_time, COUNT(r.meter_no), SUM(r.real_kwh)
    FROM meter_readings r
    GROUP BY r.data_time
    ORDER BY r.data_time DESC
    LIMIT 5;
    """)
    daily_stats = cursor.fetchall()
    print("\n[第一级：日冻结读数 (Daily Freeze)]")
    print(f"  {'采样日期':<22} | {'表计数量':<10} | {'总折算电量底数 (kWh)':<20}")
    print("  " + "-" * 60)
    for dtime, cnt, total_real in daily_stats:
        print(f"  {dtime:<22} | {cnt:<10} | {total_real:,.2f}")

    # 3. 第二级：15分钟负荷采样记录统计
    cursor.execute("""
    SELECT COUNT(*), COUNT(DISTINCT meter_no), MIN(sample_time), MAX(sample_time)
    FROM meter_load_samples;
    """)
    s_total, s_meters, s_min, s_max = cursor.fetchone()
    print("\n[第二级：15分钟负荷采样 (Load Samples)]")
    print(f"  • 累计采样记录数: {s_total or 0} 条")
    print(f"  • 涵盖电表总数  : {s_meters or 0} 块")
    print(f"  • 时间范围      : {s_min or '无'} 至 {s_max or '无'}")

    # 4. 第三级：突发告警事件统计
    cursor.execute("""
    SELECT COUNT(*), COUNT(DISTINCT meter_no) FROM alarm_events;
    """)
    a_total, a_meters = cursor.fetchone()
    print("\n[第三级：突发告警事件 (Alarms)]")
    print(f"  • 累计告警记录数: {a_total or 0} 条 (涉及表计: {a_meters or 0} 块)")
    if a_total and a_total > 0:
        cursor.execute("SELECT alarm_time, meter_no, alarm_name, alarm_status FROM alarm_events ORDER BY alarm_time DESC LIMIT 5;")
        for atime, mno, aname, astat in cursor.fetchall():
            print(f"    - {atime} | 表号 {mno} | {aname} ({astat})")

    print("=" * 80 + "\n")
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="IEMS 电表数据三级同步工具（日冻结 / 15分钟负荷采样 / 分钟级告警）")
    parser.add_argument("-m", "--mode", choices=["daily", "sample", "alarm", "all"], default="all",
                        help="同步模式: daily(天级日冻结) / sample(15分钟实时负荷) / alarm(分钟级告警) / all(三级全量)")
    parser.add_argument("--daemon", action="store_true",
                        help="以常驻守护进程模式启动，自动按各自频率调度执行 (日冻结每天/采样15分/告警1分)")
    parser.add_argument("--sid", default="", help="BBICloud 会话 Cookie sid 值（可选，留空则自动读取缓存或重登）")
    parser.add_argument("--username", default=DEFAULT_USERNAME, help="登录用户名（用于会话失效时自动重登）")
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="登录密码（用于会话失效时自动重登）")
    parser.add_argument("--project-id", default=DEFAULT_PROJECT_ID, help="项目编号")
    parser.add_argument("--project-name", default=DEFAULT_PROJECT_NAME, help="项目名称")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="SQLite 数据库文件路径")
    parser.add_argument("--date", default="", help="指定日冻结拉取日期 (格式: YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=1, help="回溯同步过去 N 天的日冻结读数（默认 1 天）")
    parser.add_argument("--backfill-intraday", default="", help="回填指定日期 (YYYY-MM-DD 或 today) 全天 15 分钟时序负荷采样")
    parser.add_argument("--summary", action="store_true", help="打印本地数据库统计概览并退出")

    args = parser.parse_args()

    # 1. 仅查看概览
    if args.summary:
        print_database_summary(args.db)
        return

    # 2. 守护进程模式
    if args.daemon:
        run_daemon_scheduler(args, args.db)
        return

    # 3. 单次同步模式
    conn = init_database(args.db)
    sid = get_active_sid(configured_sid=args.sid, username=args.username, password=args.password)
    credentials = (args.username, args.password)

    logger.info("正在以单次模式 [%s] 执行同步...", args.mode)

    # 第一级：日冻结读数 (daily 或 all)
    if args.mode in ("daily", "all"):
        target_dates = []
        if args.date:
            target_dates.append(f"{args.date} 00:00:00")
        else:
            now = datetime.now()
            for i in range(args.days):
                d = (now - timedelta(days=i)).strftime("%Y-%m-%d 00:00:00")
                target_dates.append(d)
        sync_daily_freeze(conn, sid, args.project_id, args.project_name, target_dates, credentials)

    # 第二级：15分钟实时负荷与工况采样 (sample 或 all)
    if args.mode in ("sample", "all"):
        sync_load_samples(conn, sid, args.project_id, args.project_name, credentials)

    # 历史 15 分钟负荷回填
    if args.backfill_intraday:
        backfill_intraday_samples(conn, sid, args.project_id, args.backfill_intraday, credentials)

    # 第三级：突发告警事件扫描 (alarm 或 all)
    if args.mode in ("alarm", "all"):
        sync_alarm_events(conn, sid, args.project_id, credentials=credentials)

    conn.close()

    # 打印最新汇总
    print_database_summary(args.db)


if __name__ == "__main__":
    main()
