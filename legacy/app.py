"""绿城园区智能能源数据监控中心 (IEMS-IOT Dashboard)

基于本地 SQLite 数据库 (energy_data.db) 构建的三级动态监控与分析仪表盘：
  1. 【天级 - Daily】: 每日用电走势、分类能耗结构、同环比能耗诊断与分时电费测算
  2. 【15分钟级 - Sample】: 24 块智能电表实时工况、单表负荷曲线下钻、全园区总负荷曲线与多回路对比
  3. 【分钟级 - Alarm】: 突发设备故障、掉电与电气越限秒级告警监测

特性：
  - 动态监听：实时检测 SQLite 数据库变动，自动秒级无感热更新
  - 深度分析：单表负荷曲线、全园总负荷、多表同轴比对、耗电Top5排行、尖峰平谷电费测算
  - 运维报表：支持一键导出日用电量与电表台账 CSV 报表
  - 零外部文件依赖：无需 Excel 离线文件或中间缓存，直接面向数据库实时呈现
"""

from __future__ import annotations

from datetime import datetime, timedelta
import io
import os
from pathlib import Path
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

# =============================================================================
# 页面基础配置
# =============================================================================

st.set_page_config(
    page_title="绿城园区能源数据监控中心",
    page_icon="🌿",
    layout="wide",
    initial_sidebar_state="expanded",
)

ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = Path(os.getenv("BBI_DB_PATH", str(ROOT / "energy_data.db")))
EMISSION_FACTOR_TON_PER_KWH = 0.000581  # 华东区域电网基准碳排因子 0.581 kg CO2/kWh
DEFAULT_ELECTRICITY_PRICE = 0.82  # 浙江省一般工商业综合参考电价（元/kWh）

# =============================================================================
# CSS 现代化视觉主题
# =============================================================================

st.markdown(
    """
    <style>
      .stApp {
        background: #f4f7f5;
        color: #163d30;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      header[data-testid='stHeader'] { display: none; }
      [data-testid='stAppViewContainer'] > .main { top: 0; }
      .block-container { max-width: 1680px; padding-top: 1.4rem; padding-bottom: 2.5rem; }

      /* 侧边栏高质感渐变 */
      [data-testid='stSidebar'] {
        background: linear-gradient(180deg, #09472e 0%, #063422 100%);
      }
      [data-testid='stSidebar'] * { color: #ebf7f0 !important; }
      [data-testid='stSidebar'] .stRadio label { padding: .2rem 0; font-size: 14px; font-weight: 500; }

      /* 标题与状态栏 */
      .dash-title {
        font-size: 27px;
        font-weight: 750;
        letter-spacing: -0.3px;
        color: #0b4930;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .dash-subtitle {
        color: #678477;
        margin-top: 4px;
        font-size: 13.5px;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid #c9e4d5;
        background: #ebf7f0;
        color: #0d6942;
        padding: 6px 13px;
        border-radius: 20px;
        font-size: 12.5px;
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(13, 105, 66, 0.06);
      }
      .pulse-dot {
        width: 8px;
        height: 8px;
        background: #10b981;
        border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
        animation: pulse 2s infinite;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); }
        70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
        100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
      }

      /* KPI 指标卡 */
      .metric-card {
        background: #ffffff;
        border: 1px solid #e2ece6;
        border-radius: 14px;
        padding: 16px 18px 14px;
        min-height: 124px;
        box-shadow: 0 2px 10px rgba(18, 56, 40, 0.04);
        position: relative;
        overflow: hidden;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .metric-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(18, 56, 40, 0.08);
      }
      .metric-label { color: #526f62; font-size: 13.5px; font-weight: 600; }
      .metric-value { font-size: 25px; font-weight: 750; margin-top: 6px; letter-spacing: -0.2px; }
      .metric-detail { color: #7e968b; font-size: 12px; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
      .metric-line { height: 3px; width: 38px; border-radius: 6px; position: absolute; left: 18px; bottom: 12px; }

      .trend-tag-down {
        background: #ecfdf5;
        color: #059669;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 700;
        font-size: 11.5px;
      }
      .trend-tag-up {
        background: #fef2f2;
        color: #dc2626;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 700;
        font-size: 11.5px;
      }

      /* 卡片容器 */
      .section-box {
        background: #ffffff;
        border: 1px solid #e2ece6;
        border-radius: 14px;
        padding: 18px 20px;
        box-shadow: 0 2px 10px rgba(18, 56, 40, 0.035);
        margin-bottom: 16px;
      }
      .section-title {
        color: #0e4c34;
        font-size: 17px;
        font-weight: 750;
        margin: 0 0 4px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .section-sub {
        color: #7d968b;
        font-size: 12px;
        margin: 0 0 14px 0;
      }

      /* 侧边信息栏条目 */
      .side-info-card {
        background: #ffffff;
        border: 1px solid #e2ece6;
        border-radius: 14px;
        padding: 18px;
        box-shadow: 0 2px 10px rgba(18, 56, 40, 0.035);
        margin-bottom: 14px;
      }
      .side-info-title {
        color: #0e4c34;
        font-weight: 750;
        font-size: 15.5px;
        margin-bottom: 12px;
      }
      .info-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid #edf4f0;
        padding: 8px 0;
        font-size: 13px;
        color: #4b665a;
      }
      .info-row:last-child { border-bottom: 0; }
      .info-val { color: #0e623f; font-weight: 700; }

      /* 表格与选项卡 */
      div[data-testid='stDataFrame'] { border: 0; }
      .stTabs [data-baseweb="tab-list"] {
        gap: 10px;
        background: #e9f2ec;
        padding: 5px;
        border-radius: 10px;
      }
      .stTabs [data-baseweb="tab"] {
        height: 38px;
        border-radius: 8px;
        color: #3b5a4d;
        font-weight: 600;
        font-size: 13.5px;
        padding: 0 18px;
      }
      .stTabs [aria-selected="true"] {
        background: #ffffff !important;
        color: #0b4930 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.06);
      }
    </style>
    """,
    unsafe_allow_html=True,
)


# =============================================================================
# 数据库指纹与数据载入函数
# =============================================================================

def get_db_fingerprint(db_path: Path) -> Tuple[int, int, int]:
    """获取 SQLite 数据库指纹（修改时间, 文件字节数, PRAGMA data_version）。"""
    if not db_path.exists():
        return (0, 0, 0)
    try:
        stat = db_path.stat()
        mtime = stat.st_mtime_ns
        size = stat.st_size
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            c = conn.cursor()
            c.execute("PRAGMA data_version;")
            ver = c.fetchone()[0]
        return (mtime, size, ver)
    except Exception:
        return (db_path.stat().st_mtime_ns, db_path.stat().st_size, 0)


@st.cache_data(show_spinner=False)
def load_dashboard_data(db_path: Path, fingerprint: Tuple[int, int, int]) -> Dict[str, Any]:
    """只读方式完整读取三级能源数据，并计算日电量与 15 分钟负荷功率时序。"""
    if not db_path.exists():
        return {
            "connected": False,
            "error": f"未找到本地 SQLite 数据库文件: {db_path}",
        }

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except Exception as e:
        return {
            "connected": False,
            "error": f"连接 SQLite 数据库失败: {e}",
        }

    try:
        # 1. 项目基础档案
        project_df = pd.read_sql_query("SELECT * FROM projects LIMIT 1;", conn)
        project_info = project_df.iloc[0].to_dict() if not project_df.empty else {
            "project_id": "202607020000000001",
            "project_name": "宁波慈溪凤起潮鸣",
            "meter_count": 24,
            "updated_at": "未记录",
        }

        # 2. 表计台账
        meters_df = pd.read_sql_query("SELECT * FROM meters ORDER BY room_detail_addr;", conn)

        # 3. 第一级：日冻结历史抄表 (meter_readings)
        raw_readings = pd.read_sql_query("""
            SELECT r.meter_no, r.data_time, r.total_kwh, r.multiplier, r.real_kwh,
                   r.rate1_kwh, r.rate2_kwh, r.rate3_kwh, r.rate4_kwh,
                   COALESCE(m.category, '其他负荷') AS category,
                   COALESCE(m.room_detail_addr, r.meter_no) AS room_detail_addr
            FROM meter_readings r
            LEFT JOIN meters m ON r.meter_no = m.meter_no
            WHERE r.data_time LIKE '%00:00:00'
            ORDER BY r.meter_no, r.data_time;
        """, conn)

        # 4. 第二级：15分钟负荷采样与工况 (meter_load_samples)
        raw_samples = pd.read_sql_query("""
            SELECT s.meter_no, s.sample_time, s.total_kwh, s.multiplier, s.real_kwh,
                   s.relay_status, s.online_status,
                   COALESCE(m.category, '其他负荷') AS category,
                   COALESCE(m.room_detail_addr, s.meter_no) AS room_detail_addr,
                   m.rate, m.ct_rate, m.pt_rate, m.comm_type, m.imei_no
            FROM meter_load_samples s
            LEFT JOIN meters m ON s.meter_no = m.meter_no
            WHERE s.real_kwh > 0
            ORDER BY s.meter_no, s.sample_time;
        """, conn)

        # 5. 第三级：突发告警事件 (alarm_events)
        alarms_df = pd.read_sql_query("""
            SELECT meter_no, project_id, alarm_time, alarm_name, alarm_code, room_addr, alarm_status, created_at
            FROM alarm_events
            ORDER BY alarm_time DESC;
        """, conn)

        # 6. 表行数统计
        counts = {}
        for table in ["projects", "meters", "meter_readings", "meter_load_samples", "alarm_events"]:
            try:
                cur = conn.cursor()
                cur.execute(f"SELECT COUNT(*) FROM {table};")
                counts[table] = cur.fetchone()[0]
            except Exception:
                counts[table] = 0

    finally:
        conn.close()

    # ---------------------------------------------------------
    # 数据计算 1: 每日用电量（相邻冻结日电量底数正向增量）
    # ---------------------------------------------------------
    usage_daily = pd.DataFrame(columns=["日期", "用电量(kWh)"])
    category_daily = pd.DataFrame(columns=["日期", "分类", "用电量(kWh)"])
    meter_daily = pd.DataFrame(columns=["日期", "meter_no", "分类", "room_detail_addr", "用电量(kWh)"])

    if not raw_readings.empty:
        raw_readings["日期"] = pd.to_datetime(raw_readings["data_time"]).dt.date
        clean_r = raw_readings.drop_duplicates(subset=["meter_no", "日期"], keep="last").sort_values(["meter_no", "日期"])
        clean_r["用电量(kWh)"] = clean_r.groupby("meter_no")["real_kwh"].diff().clip(lower=0)
        daily_diffs = clean_r.dropna(subset=["用电量(kWh)"]).copy()

        if not daily_diffs.empty:
            usage_daily = daily_diffs.groupby("日期", as_index=False)["用电量(kWh)"].sum()
            category_daily = daily_diffs.groupby(["日期", "category"], as_index=False)["用电量(kWh)"].sum().rename(columns={"category": "分类"})
            meter_daily = daily_diffs[["日期", "meter_no", "category", "room_detail_addr", "用电量(kWh)"]].copy()

    # ---------------------------------------------------------
    # 数据计算 2: 15分钟时序负荷功率推算 (P = delta_E / delta_t)
    # ---------------------------------------------------------
    samples_df = raw_samples.copy()
    if not samples_df.empty:
        samples_df["datetime"] = pd.to_datetime(samples_df["sample_time"])
        samples_df = samples_df.sort_values(["meter_no", "datetime"])

        # 计算相邻采样点的时间差与电量差
        samples_df["prev_dt"] = samples_df.groupby("meter_no")["datetime"].shift(1)
        samples_df["prev_real_kwh"] = samples_df.groupby("meter_no")["real_kwh"].shift(1)
        samples_df["hours_diff"] = (samples_df["datetime"] - samples_df["prev_dt"]).dt.total_seconds() / 3600.0
        samples_df["delta_kwh"] = (samples_df["real_kwh"] - samples_df["prev_real_kwh"]).clip(lower=0)

        # 功率 P (kW) = 增量电量 (kWh) / 时间差 (h)
        # 过滤时间差异常（如大于 24 小时或等于 0）
        valid_mask = (samples_df["hours_diff"] > 0) & (samples_df["hours_diff"] <= 24)
        samples_df["power_kw"] = np.nan
        samples_df.loc[valid_mask, "power_kw"] = (
            samples_df.loc[valid_mask, "delta_kwh"] / samples_df.loc[valid_mask, "hours_diff"]
        ).round(2)
        # 对首个采样点使用后向填充（bfill），代表首个采样区间内的平均负荷，消除首点被默认置0导致的误导折线
        samples_df["power_kw"] = samples_df.groupby("meter_no")["power_kw"].bfill()
        samples_df["power_kw"] = samples_df["power_kw"].fillna(0.0)

        # 状态规范化文本
        samples_df["relay_status_desc"] = samples_df["relay_status"].apply(
            lambda x: "通电 (合闸)" if str(x) in ("00120001", "合闸", "1") else "断电 (拉闸)" if str(x) in ("00120002", "拉闸", "0") else str(x or "合闸")
        )
        samples_df["online_status_desc"] = samples_df["online_status"].apply(
            lambda x: "在线" if str(x) in ("正常", "在线", "0", "1") else str(x or "正常")
        )

    db_mtime = datetime.fromtimestamp(db_path.stat().st_mtime)

    return {
        "connected": True,
        "db_path": str(db_path),
        "db_size_kb": round(db_path.stat().st_size / 1024, 1),
        "db_mtime": db_mtime.strftime("%Y-%m-%d %H:%M:%S"),
        "project_info": project_info,
        "meters_df": meters_df,
        "usage_daily": usage_daily,
        "category_daily": category_daily,
        "meter_daily": meter_daily,
        "samples_df": samples_df,
        "alarms_df": alarms_df,
        "counts": counts,
    }


# =============================================================================
# 辅助绘图函数
# =============================================================================

def build_kpi_card(title: str, value: str, detail_html: str, accent: str = "#0d6942") -> str:
    """渲染高质感标准化指标卡片。"""
    return f"""
    <div class='metric-card'>
      <div class='metric-label'>{title}</div>
      <div class='metric-value' style='color:{accent}'>{value}</div>
      <div class='metric-detail'>{detail_html}</div>
      <div class='metric-line' style='background:{accent}'></div>
    </div>
    """


def plot_daily_trend(df: pd.DataFrame) -> go.Figure:
    """绘制日用电量趋势折线渐变图。"""
    fig = go.Figure()
    if df.empty:
        fig.add_annotation(text="所选周期内暂无用电统计数据", showarrow=False, font={"size": 14, "color": "#7d968b"})
        fig.update_layout(height=320, paper_bgcolor="white", plot_bgcolor="white")
        return fig

    fig.add_trace(
        go.Scatter(
            x=df["日期"],
            y=df["用电量(kWh)"],
            mode="lines+markers",
            line={"color": "#0d8250", "width": 3, "shape": "spline", "smoothing": 0.5},
            marker={"size": 7, "color": "#0d8250", "symbol": "circle"},
            fill="tozeroy",
            fillcolor="rgba(16, 185, 129, 0.08)",
            hovertemplate="<b>%{x}</b><br>当日用电: <b>%{y:,.1f} kWh</b><extra></extra>",
        )
    )
    fig.update_layout(
        height=320,
        margin={"l": 20, "r": 20, "t": 16, "b": 20},
        paper_bgcolor="white",
        plot_bgcolor="white",
        hovermode="x unified",
        showlegend=False,
        xaxis={
            "showgrid": False,
            "tickformat": "%m-%d",
            "fixedrange": True,
            "tickfont": {"color": "#638072", "size": 12},
        },
        yaxis={
            "title": {"text": "用电量 (kWh)", "font": {"color": "#638072", "size": 12}},
            "gridcolor": "#edf4f0",
            "zeroline": False,
            "fixedrange": True,
            "tickfont": {"color": "#638072", "size": 12},
        },
    )
    return fig


def plot_category_donut(df: pd.DataFrame) -> go.Figure:
    """绘制用电场景占比环形图。"""
    fig = go.Figure()
    if df.empty:
        fig.add_annotation(text="暂无分类数据", showarrow=False, font={"size": 14, "color": "#7d968b"})
        fig.update_layout(height=320, paper_bgcolor="white", plot_bgcolor="white")
        return fig

    cat_sum = df.groupby("分类")["用电量(kWh)"].sum().reset_index().sort_values("用电量(kWh)", ascending=False)
    colors = ["#0d8250", "#22a06b", "#3bb682", "#5fc99b", "#86dcb5", "#1473b8", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"]

    fig.add_trace(
        go.Pie(
            labels=cat_sum["分类"],
            values=cat_sum["用电量(kWh)"],
            hole=0.6,
            marker={"colors": colors},
            textinfo="label+percent",
            textposition="outside",
            hovertemplate="<b>%{label}</b><br>总用电: %{value:,.1f} kWh (%{percent})<extra></extra>",
        )
    )
    fig.update_layout(
        height=320,
        margin={"l": 20, "r": 20, "t": 16, "b": 20},
        paper_bgcolor="white",
        showlegend=False,
    )
    return fig


def plot_category_stacked_bars(df: pd.DataFrame) -> go.Figure:
    """绘制分类用电日堆叠条形图。"""
    if df.empty:
        fig = go.Figure()
        fig.add_annotation(text="暂无数据", showarrow=False)
        fig.update_layout(height=320, paper_bgcolor="white", plot_bgcolor="white")
        return fig

    fig = px.bar(
        df,
        x="日期",
        y="用电量(kWh)",
        color="分类",
        color_discrete_sequence=px.colors.qualitative.Prism,
        category_orders={"日期": sorted(df["日期"].unique().tolist())},
    )
    fig.update_layout(
        height=320,
        margin={"l": 20, "r": 20, "t": 16, "b": 20},
        paper_bgcolor="white",
        plot_bgcolor="white",
        barmode="stack",
        hovermode="x unified",
        xaxis={"showgrid": False, "fixedrange": True, "tickformat": "%m-%d"},
        yaxis={"title": {"text": "kWh", "font": {"color": "#638072", "size": 12}}, "gridcolor": "#edf4f0", "zeroline": False, "fixedrange": True},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02, "xanchor": "right", "x": 1, "title": None},
    )
    return fig


def plot_top_consumers_bar(meter_daily_df: pd.DataFrame) -> go.Figure:
    """绘制耗电回路 Top 5 横向跑道图。"""
    fig = go.Figure()
    if meter_daily_df.empty:
        fig.add_annotation(text="暂无电表数据", showarrow=False)
        fig.update_layout(height=260, paper_bgcolor="white", plot_bgcolor="white")
        return fig

    top_df = meter_daily_df.groupby(["meter_no", "room_detail_addr", "category"], as_index=False)["用电量(kWh)"].sum()
    top_df = top_df.sort_values("用电量(kWh)", ascending=True).tail(5)

    fig.add_trace(
        go.Bar(
            x=top_df["用电量(kWh)"],
            y=top_df["room_detail_addr"],
            orientation="h",
            marker={
                "color": top_df["用电量(kWh)"],
                "colorscale": [[0, "#a7f3d0"], [1, "#059669"]],
            },
            text=top_df["用电量(kWh)"].apply(lambda v: f" {v:,.1f} kWh"),
            textposition="auto",
            hovertemplate="<b>%{y}</b><br>累计电量: %{x:,.1f} kWh<extra></extra>",
        )
    )
    fig.update_layout(
        height=260,
        margin={"l": 10, "r": 20, "t": 10, "b": 10},
        paper_bgcolor="white",
        plot_bgcolor="white",
        xaxis={"showgrid": True, "gridcolor": "#f0f4f1", "title": {"text": "kWh", "font": {"size": 11}}},
        yaxis={"showgrid": False, "tickfont": {"size": 12, "color": "#163d30"}},
    )
    return fig


def plot_realtime_load_curve(
    samples_df: pd.DataFrame,
    mode: str,
    selected_meters: Optional[List[str]] = None,
    selected_category: Optional[str] = None,
    period_label: str = ""
) -> go.Figure:
    """绘制电表 15 分钟实时负荷功率曲线 (kW)。"""
    fig = go.Figure()

    if samples_df.empty:
        fig.add_annotation(text="所选周期内暂无 15 分钟负荷采样数据", showarrow=False, font={"size": 14, "color": "#7d968b"})
        fig.update_layout(height=360, paper_bgcolor="white", plot_bgcolor="white")
        return fig

    tag_suffix = f" · {period_label}" if period_label else ""

    # 1. 模式：全园区实时总负荷走势
    if mode == "total":
        total_p = samples_df.groupby("sample_time", as_index=False)["power_kw"].sum().sort_values("sample_time")
        if total_p.empty or (total_p["power_kw"] == 0).all():
            fig.add_annotation(text="正在累积时序负荷采样（当前已记录最新点位工况，下次采样将自动成线）", showarrow=False, font={"size": 13, "color": "#0d8250"})

        # 根据采样点数决定是否绘制标记点（多天海量点时仅用平滑折线，保持高质感）
        use_markers = len(total_p) <= 96
        scatter_mode = "lines+markers" if use_markers else "lines"

        fig.add_trace(
            go.Scatter(
                x=total_p["sample_time"],
                y=total_p["power_kw"],
                mode=scatter_mode,
                name="园区总负荷",
                line={"color": "#0f766e", "width": 2.5, "shape": "spline"},
                marker={"size": 6, "color": "#0f766e"} if use_markers else {},
                fill="tozeroy",
                fillcolor="rgba(15, 118, 110, 0.08)",
                hovertemplate="<b>%{x}</b><br>全园总负荷: <b>%{y:,.2f} kW</b><extra></extra>",
            )
        )
        fig.update_layout(
            title={"text": f"全园区 24 块智能电表聚合负荷走势 (kW){tag_suffix}", "font": {"size": 15, "color": "#0f766e"}},
        )

    # 2. 模式：单表深度下钻
    elif mode == "single" and selected_meters and len(selected_meters) == 1:
        m_no = selected_meters[0]
        sub = samples_df[samples_df["meter_no"] == m_no].sort_values("sample_time")
        label = sub["room_detail_addr"].iloc[0] if not sub.empty else m_no
        mult = sub["multiplier"].iloc[0] if not sub.empty else 1.0

        use_markers = len(sub) <= 96
        scatter_mode = "lines+markers" if use_markers else "lines"

        fig.add_trace(
            go.Scatter(
                x=sub["sample_time"],
                y=sub["power_kw"],
                mode=scatter_mode,
                name=label,
                line={"color": "#2563eb", "width": 2.5, "shape": "spline"},
                marker={"size": 6, "color": "#2563eb"} if use_markers else {},
                fill="tozeroy",
                fillcolor="rgba(37, 99, 235, 0.08)",
                hovertemplate="<b>%{x}</b><br>" + label + "<br>负荷功率: <b>%{y:,.2f} kW</b><extra></extra>",
            )
        )
        fig.update_layout(
            title={"text": f"回路负荷曲线: {label} (表号: {m_no} · 倍率: {mult:.0f}x){tag_suffix}", "font": {"size": 15, "color": "#1e40af"}},
        )

    # 3. 模式：多回路同轴对比
    elif mode == "multi" and selected_meters:
        colors = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#e11d48", "#06b6d4"]
        for idx, m_no in enumerate(selected_meters):
            sub = samples_df[samples_df["meter_no"] == m_no].sort_values("sample_time")
            label = sub["room_detail_addr"].iloc[0] if not sub.empty else m_no
            c = colors[idx % len(colors)]
            use_markers = len(sub) <= 96
            scatter_mode = "lines+markers" if use_markers else "lines"

            fig.add_trace(
                go.Scatter(
                    x=sub["sample_time"],
                    y=sub["power_kw"],
                    mode=scatter_mode,
                    name=label,
                    line={"color": c, "width": 2.0},
                    marker={"size": 5, "color": c} if use_markers else {},
                    hovertemplate="<b>%{x}</b><br>" + label + ": <b>%{y:,.2f} kW</b><extra></extra>",
                )
            )
        fig.update_layout(
            title={"text": f"多回路实时负荷功率比对 (已选 {len(selected_meters)} 个回路){tag_suffix}", "font": {"size": 15, "color": "#163d30"}},
            showlegend=True,
            legend={"orientation": "h", "yanchor": "bottom", "y": 1.02, "xanchor": "right", "x": 1},
        )

    # 4. 模式：按用电场景分类聚合
    elif mode == "category" and selected_category:
        cat_df = samples_df[samples_df["category"] == selected_category]
        cat_p = cat_df.groupby("sample_time", as_index=False)["power_kw"].sum().sort_values("sample_time")
        use_markers = len(cat_p) <= 96
        scatter_mode = "lines+markers" if use_markers else "lines"

        fig.add_trace(
            go.Scatter(
                x=cat_p["sample_time"],
                y=cat_p["power_kw"],
                mode=scatter_mode,
                name=selected_category,
                line={"color": "#d97706", "width": 2.5, "shape": "spline"},
                marker={"size": 6, "color": "#d97706"} if use_markers else {},
                fill="tozeroy",
                fillcolor="rgba(217, 119, 6, 0.08)",
                hovertemplate="<b>%{x}</b><br>" + selected_category + "总负荷: <b>%{y:,.2f} kW</b><extra></extra>",
            )
        )
        fig.update_layout(
            title={"text": f"{selected_category} 实时总负荷走势 (kW){tag_suffix}", "font": {"size": 15, "color": "#b45309"}},
        )

    fig.update_layout(
        height=360,
        margin={"l": 20, "r": 20, "t": 48, "b": 20},
        paper_bgcolor="white",
        plot_bgcolor="white",
        hovermode="x unified",
        xaxis={"showgrid": False, "fixedrange": False, "tickfont": {"color": "#638072", "size": 11}},
        yaxis={
            "title": {"text": "负荷功率 (kW)", "font": {"color": "#638072", "size": 12}},
            "gridcolor": "#edf4f0",
            "zeroline": False,
            "fixedrange": True,
            "tickfont": {"color": "#638072", "size": 12},
        },
    )
    return fig


# =============================================================================
# 页面主视图与实时更新 Fragment
# =============================================================================

@st.fragment(run_every="10s")
def render_live_dashboard(db_path: Path):
    """主仪表盘渲染核心：由 st.fragment 每 10 秒自动轮询检测数据库变动。"""

    # 抓取当前数据库指纹并加载数据
    fingerprint = get_db_fingerprint(db_path)
    data = load_dashboard_data(db_path, fingerprint)

    if not data.get("connected"):
        st.error(data.get("error", "未能连接到能源数据库"))
        st.info("提示：请先在终端运行同步脚本拉取现网数据到本地 SQLite：\n```bash\npython3 sync_energy_to_sqlite.py --mode all\n```")
        return

    project_info = data["project_info"]
    usage_daily = data["usage_daily"]
    category_daily = data["category_daily"]
    meter_daily = data["meter_daily"]
    samples_df = data["samples_df"]
    alarms_df = data["alarms_df"]
    counts = data["counts"]

    # 顶部仪表盘状态栏
    top_l, top_r = st.columns([3.6, 1.4], gap="medium")
    with top_l:
        st.markdown(
            f"""
            <div class='dash-title'>
              🌿 绿城园区能源数据监控中心
            </div>
            <div class='dash-subtitle'>
              项目：<b>{project_info.get('project_name', '宁波慈溪凤起潮鸣')}</b> · 智能物联网实时感知台账 (ID: {project_info.get('project_id', '202607020000000001')})
            </div>
            """,
            unsafe_allow_html=True,
        )

    with top_r:
        st.markdown(
            f"""
            <div style='text-align: right;'>
              <div class='status-badge'>
                <span class='pulse-dot'></span>
                <span>SQLite 实时在线</span>
                <span style='color:#7da190; font-weight:normal;'>|</span>
                <span>{data['db_mtime'].split(' ')[1]} 步进更新</span>
              </div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    st.markdown("<div style='height:10px'></div>", unsafe_allow_html=True)

    # 统计周期过滤器
    period_options = {"今日 (实时)": 1, "近 7 天": 7, "近 14 天": 14, "近 30 天": 30, "全部历史": None}
    col_filter_l, col_filter_r = st.columns([4, 1])
    with col_filter_r:
        selected_period = st.selectbox("统计周期", list(period_options.keys()), index=1, label_visibility="collapsed")
    days_limit = period_options[selected_period]

    # 根据时间筛选日用电数据
    if not usage_daily.empty and days_limit is not None:
        max_date = usage_daily["日期"].max()
        cutoff_date = max_date - timedelta(days=days_limit - 1)
        u_view = usage_daily[usage_daily["日期"] >= cutoff_date].copy()
        c_view = category_daily[category_daily["日期"] >= cutoff_date].copy()
        m_view = meter_daily[meter_daily["日期"] >= cutoff_date].copy()
    else:
        u_view = usage_daily.copy()
        c_view = category_daily.copy()
        m_view = meter_daily.copy()

    # 根据时间筛选 15 分钟负荷采样数据 (服从全局设定的统计周期)
    if not samples_df.empty and days_limit is not None:
        ref_date = max_date if not usage_daily.empty else samples_df["datetime"].max().date()
        cutoff_dt = pd.to_datetime(ref_date - timedelta(days=days_limit - 1))
        s_view = samples_df[samples_df["datetime"] >= cutoff_dt].copy()
    else:
        s_view = samples_df.copy()

    # ---------------------------------------------------------
    # 核心运营指标与同环比计算
    # ---------------------------------------------------------
    total_usage = u_view["用电量(kWh)"].sum() if not u_view.empty else 0.0
    avg_daily_usage = u_view["用电量(kWh)"].mean() if not u_view.empty else 0.0
    peak_daily_usage = u_view["用电量(kWh)"].max() if not u_view.empty else 0.0
    total_emission = total_usage * EMISSION_FACTOR_TON_PER_KWH
    stat_days = len(u_view)

    # 估算电费
    total_cost = total_usage * DEFAULT_ELECTRICITY_PRICE

    # 日环比计算
    if len(u_view) >= 2:
        today_val = u_view["用电量(kWh)"].iloc[-1]
        yest_val = u_view["用电量(kWh)"].iloc[-2]
        day_diff = today_val - yest_val
        day_pct = (day_diff / yest_val * 100) if yest_val > 0 else 0.0
        if day_diff < 0:
            trend_html = f"<span class='trend-tag-down'>环比 {day_pct:.1f}% ↓</span> 较昨日省 {abs(day_diff):,.1f} 度"
        else:
            trend_html = f"<span class='trend-tag-up'>环比 +{day_pct:.1f}% ↑</span> 较昨日增 {day_diff:,.1f} 度"
    else:
        today_val = u_view["用电量(kWh)"].iloc[-1] if not u_view.empty else 0.0
        trend_html = "暂无昨日基准可比"

    meter_count = project_info.get("meter_count", 24)
    if not samples_df.empty:
        latest_meter_samples = samples_df.sort_values("datetime").groupby("meter_no", as_index=False).last()
        online_count = int((latest_meter_samples["online_status_desc"] == "在线").sum())
    else:
        online_count = meter_count
    alarm_count = len(alarms_df[alarms_df["alarm_status"] == "告警中"]) if not alarms_df.empty else 0

    # KPI 卡片阵列 (5联)
    c1, c2, c3, c4, c5 = st.columns(5)
    with c1:
        st.markdown(build_kpi_card("周期总用电量", f"{total_usage:,.1f} kWh", f"统计跨度 {stat_days} 个自然日", "#0d8250"), unsafe_allow_html=True)
    with c2:
        st.markdown(build_kpi_card("最新日用电量", f"{today_val:,.1f} kWh", trend_html, "#15803d"), unsafe_allow_html=True)
    with c3:
        st.markdown(build_kpi_card("估算总电费成本", f"¥ {total_cost:,.1f}", f"参考单价 {DEFAULT_ELECTRICITY_PRICE:.2f} 元/度", "#d97706"), unsafe_allow_html=True)
    with c4:
        st.markdown(build_kpi_card("等效碳排放基准", f"{total_emission:,.2f} 吨", "折算 0.581 kg CO₂/kWh", "#0284c7"), unsafe_allow_html=True)
    with c5:
        alarm_color = "#e11d48" if alarm_count > 0 else "#059669"
        alarm_text = f"{alarm_count} 起待处理" if alarm_count > 0 else f"{online_count}/{meter_count} 块在线 · 运行平稳"
        st.markdown(build_kpi_card("表计工况与告警", f"{meter_count} 块全部在线", alarm_text, alarm_color), unsafe_allow_html=True)

    st.markdown("<div style='height:14px'></div>", unsafe_allow_html=True)

    # 选项卡多维切换
    tabs = st.tabs([
        "📊 能源总览与趋势",
        "📈 实时负荷与单表曲线 (15分钟级)",
        "⚡ 表计台账与工况全览",
        "🚨 突发告警监测中心",
        "⚙️ 系统通道与同步管理"
    ])

    # =========================================================================
    # TAB 1: 能源总览与趋势分析
    # =========================================================================
    with tabs[0]:
        col_main, col_side = st.columns([3.3, 1.2], gap="large")

        with col_main:
            # 1. 用电趋势曲线
            st.markdown(
                """
                <div class='section-box'>
                  <div class='section-title'>
                    <span>📈 园区总日用电量趋势 (Daily Freeze)</span>
                    <span style='font-size:12px; color:#88a296; font-weight:normal;'>单位: kWh / 日</span>
                  </div>
                  <div class='section-sub'>统计 24 块智能物联电表相邻日冻结底数真实电量增量（自动乘互感器倍率）</div>
                """,
                unsafe_allow_html=True,
            )
            st.plotly_chart(plot_daily_trend(u_view), width="stretch", config={"displayModeBar": False})
            st.markdown("</div>", unsafe_allow_html=True)

            # 2. 分类用电日分布条形图
            st.markdown(
                """
                <div class='section-box'>
                  <div class='section-title'>
                    <span>📊 场景分类日用电堆叠分布</span>
                    <span style='font-size:12px; color:#88a296; font-weight:normal;'>按主要用电场景区分</span>
                  </div>
                  <div class='section-sub'>清晰比对每日空调、儿童空间、给排水、照明等各用电负荷的波动情况</div>
                """,
                unsafe_allow_html=True,
            )
            st.plotly_chart(plot_category_stacked_bars(c_view), width="stretch", config={"displayModeBar": False})
            st.markdown("</div>", unsafe_allow_html=True)

        with col_side:
            # 1. 结构环形图
            st.markdown(
                """
                <div class='side-info-card'>
                  <div class='side-info-title'>场景能耗结构占比</div>
                """,
                unsafe_allow_html=True,
            )
            st.plotly_chart(plot_category_donut(c_view), width="stretch", config={"displayModeBar": False})
            st.markdown("</div>", unsafe_allow_html=True)

            # 2. 运行摘要卡
            newest_date = usage_daily["日期"].max() if not usage_daily.empty else None
            earliest_date = usage_daily["日期"].min() if not usage_daily.empty else None
            st.markdown(
                f"""
                <div class='side-info-card'>
                  <div class='side-info-title'>园区运行摘要</div>
                  <div class='info-row'><span>目标项目</span><span class='info-val'>{project_info.get('project_name', '宁波慈溪凤起潮鸣')}</span></div>
                  <div class='info-row'><span>在运电表</span><span class='info-val'>{meter_count} 台</span></div>
                  <div class='info-row'><span>通信方式</span><span class='info-val'>电信 NB-IoT (100%)</span></div>
                  <div class='info-row'><span>高倍率互感器</span><span class='info-val'>3 块 (40x, 30x, 20x)</span></div>
                  <div class='info-row'><span>日冻结周期</span><span class='info-val'>{earliest_date} 至 {newest_date}</span></div>
                  <div class='info-row'><span>单日最高峰值</span><span class='info-val'>{peak_daily_usage:,.1f} kWh</span></div>
                </div>
                """,
                unsafe_allow_html=True,
            )

            # 3. 能耗诊断与节能洞察
            top_cat = c_view.groupby("分类")["用电量(kWh)"].sum().idxmax() if not c_view.empty else "空调系统"
            st.markdown(
                f"""
                <div class='side-info-card'>
                  <div class='side-info-title'>💡 能耗诊断与节能洞察</div>
                  <div style='color:#557265; font-size:12.5px; line-height:1.75;'>
                    • <b>负荷主体</b>：当前周期内 <b>{top_cat}</b> 为园区最大能耗来源。<br>
                    • <b>环比走势</b>：{trend_html}。<br>
                    • <b>节能建议</b>：建议在营业前 30 分钟分批开启主要空调回路，避开午间 11:00~13:00 尖峰电价时段的超大负荷重叠，可显著降低综合电费。
                  </div>
                </div>
                """,
                unsafe_allow_html=True,
            )

        # 3. 耗电回路 Top 5 与分类明细
        c_sub1, c_sub2 = st.columns([1.5, 2], gap="large")
        with c_sub1:
            st.markdown(
                """
                <div class='section-box'>
                  <div class='section-title'>🔥 周期重点耗电回路 Top 5</div>
                  <div class='section-sub'>园区用电负荷最高的重点回路排名</div>
                """,
                unsafe_allow_html=True,
            )
            st.plotly_chart(plot_top_consumers_bar(m_view), width="stretch", config={"displayModeBar": False})
            st.markdown("</div>", unsafe_allow_html=True)

        with c_sub2:
            st.markdown(
                """
                <div class='section-box'>
                  <div class='section-title'>📋 场景用电明细与占比排行</div>
                  <div class='section-sub'>各分类用电总量与占比（点击表头可重新排序）</div>
                """,
                unsafe_allow_html=True,
            )
            if not c_view.empty:
                cat_summary = c_view.groupby("分类", as_index=False)["用电量(kWh)"].sum().sort_values("用电量(kWh)", ascending=False)
                total_sum = cat_summary["用电量(kWh)"].sum()
                cat_summary["占比"] = (cat_summary["用电量(kWh)"] / total_sum * 100).round(1) if total_sum > 0 else 0.0
                cat_summary["估算电费(元)"] = (cat_summary["用电量(kWh)"] * DEFAULT_ELECTRICITY_PRICE).round(1)
                cat_summary["用电量(kWh)"] = cat_summary["用电量(kWh)"].round(1)
                st.dataframe(
                    cat_summary,
                    width="stretch",
                    hide_index=True,
                    column_config={
                        "分类": st.column_config.TextColumn("用电分类", width="medium"),
                        "用电量(kWh)": st.column_config.NumberColumn("累计用电量 (kWh)", format="%.1f kWh"),
                        "估算电费(元)": st.column_config.NumberColumn("估算电费 (元)", format="¥ %.1f"),
                        "占比": st.column_config.ProgressColumn("用电占比 (%)", min_value=0, max_value=100, format="%.1f%%"),
                    },
                )
            else:
                st.info("暂无分类数据")
            st.markdown("</div>", unsafe_allow_html=True)

    # =========================================================================
    # TAB 2: 实时负荷与单表曲线 (重点增加项)
    # =========================================================================
    with tabs[1]:
        st.markdown(
            """
            <div class='section-box'>
              <div class='section-title'>
                <span>📈 15 分钟级电表实时负荷曲线工作台 (Real-time Load Curves)</span>
                <span style='font-size:12px; color:#88a296; font-weight:normal;'>采样周期: 每 15 分钟推算功率 (kW)</span>
              </div>
              <div class='section-sub'>根据智能电表相邻 15 分钟瞬时底数增量实时换算等效平均负荷功率：P = ΔE / Δt。支持全园大盘、单回路下钻及多回路同轴对比。</div>
            """,
            unsafe_allow_html=True,
        )

        if not s_view.empty:
            # 模式切换选择器
            mode_labels = {
                "total": "🏢 全园区实时总负荷走势",
                "single": "🔍 单回路深度下钻 (24表任意选)",
                "multi": "⚖️ 多回路同轴对比 (自选对比)",
                "category": "🗂️ 场景分类总负荷走势"
            }
            sel_mode_key = st.radio(
                "分析视角",
                list(mode_labels.keys()),
                format_func=lambda k: mode_labels[k],
                horizontal=True,
                label_visibility="collapsed"
            )

            ctrl_col1, ctrl_col2, ctrl_col3, ctrl_col4 = st.columns([1.8, 1, 1, 1.2])

            selected_meters_list = []
            selected_cat_name = None

            # 创建电表选项字典：meter_no -> "安装位置 (倍率 / 表号)"
            meter_options = {}
            for _, r in data["meters_df"].iterrows():
                m_no = r["meter_no"]
                m_addr = r.get("room_detail_addr", m_no)
                m_rate = r.get("rate", 1.0)
                meter_options[m_no] = f"{m_addr} ({m_rate:.0f}x | {m_no})"

            if sel_mode_key == "single":
                with ctrl_col1:
                    chosen_meter = st.selectbox(
                        "选择要下钻的电表回路",
                        list(meter_options.keys()),
                        format_func=lambda x: meter_options.get(x, x),
                        index=0
                    )
                    selected_meters_list = [chosen_meter]

            elif sel_mode_key == "multi":
                with ctrl_col1:
                    default_picks = list(meter_options.keys())[:3]
                    multi_picks = st.multiselect(
                        "选择要同轴对比的电表回路 (建议 2~5 个)",
                        list(meter_options.keys()),
                        default=default_picks,
                        format_func=lambda x: meter_options.get(x, x),
                    )
                    selected_meters_list = multi_picks

            elif sel_mode_key == "category":
                with ctrl_col1:
                    all_cats = sorted(s_view["category"].dropna().unique().tolist())
                    selected_cat_name = st.selectbox("选择用电场景", all_cats, index=0)

            # 实时负荷关键指标提示（基于最新瞬时值）与所选周期负荷极值
            latest_time = samples_df["sample_time"].max()
            latest_slice = samples_df[samples_df["sample_time"] == latest_time]
            current_total_kw = latest_slice["power_kw"].sum() if not latest_slice.empty else 0.0

            time_grouped = s_view.groupby("sample_time")["power_kw"].sum()
            period_peak_kw = time_grouped.max() if not time_grouped.empty else 0.0
            period_avg_kw = time_grouped.mean() if not time_grouped.empty else 0.0

            with ctrl_col2:
                st.metric("最新采样时点", latest_time.split(" ")[1] if latest_time else "—", "15 分钟节拍")
            with ctrl_col3:
                st.metric("全园当前负荷", f"{current_total_kw:,.2f} kW", f"{len(latest_slice)} 表就绪")
            with ctrl_col4:
                st.metric(f"{selected_period}最高需量", f"{period_peak_kw:,.2f} kW", f"均值 {period_avg_kw:,.1f} kW")

            # 绘制对应的负荷曲线图（服从全局设定的统计周期）
            fig_load = plot_realtime_load_curve(
                s_view,
                mode=sel_mode_key,
                selected_meters=selected_meters_list,
                selected_category=selected_cat_name,
                period_label=selected_period
            )
            st.plotly_chart(fig_load, width="stretch", config={"displayModeBar": False})

            # 单表模式下的参数卡片
            if sel_mode_key == "single" and selected_meters_list:
                s_mno = selected_meters_list[0]
                m_records = s_view[s_view["meter_no"] == s_mno].sort_values("sample_time", ascending=False)
                if not m_records.empty:
                    m_row = m_records.iloc[0]
                    pk_kw = m_records["power_kw"].max()
                    avg_kw = m_records["power_kw"].mean()
                    st.markdown(
                        f"""
                        <div style='background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; padding:12px 18px; margin-top:8px;'>
                          <div style='font-size:13.5px; color:#374151; font-weight:600; margin-bottom:6px;'>回路运行参数档案：{m_row['room_detail_addr']}</div>
                          <div style='display:flex; flex-wrap:wrap; gap:20px; font-size:12.5px; color:#4b5563;'>
                            <span>• <b>电表编号</b>: {s_mno}</span>
                            <span>• <b>所属场景</b>: {m_row['category']}</span>
                            <span>• <b>互感器倍率</b>: {m_row['multiplier']:.0f}x</span>
                            <span>• <b>CT/PT规格</b>: {m_row.get('ct_rate', '直通')}</span>
                            <span>• <b>通信方式</b>: {m_row.get('comm_type', '电信NB-IoT')}</span>
                            <span>• <b>继电器状态</b>: <span style='color:#059669; font-weight:700;'>{m_row['relay_status_desc']}</span></span>
                            <span>• <b>单表当前负荷</b>: <b style='color:#2563eb;'>{m_row['power_kw']:,.2f} kW</b></span>
                            <span>• <b>{selected_period}最高需量</b>: <b style='color:#d97706;'>{pk_kw:,.2f} kW</b></span>
                            <span>• <b>{selected_period}平均负荷</b>: <b style='color:#059669;'>{avg_kw:,.2f} kW</b></span>
                            <span>• <b>折算总底数</b>: {m_row['real_kwh']:,.2f} kWh</span>
                          </div>
                        </div>
                        """,
                        unsafe_allow_html=True,
                    )
        else:
            st.info(f"在【{selected_period}】范围内暂未检索到 15 分钟负荷采样数据。可通过运行 `python3 sync_energy_to_sqlite.py --backfill-intraday 7` 扩展采样历史。")

        st.markdown("</div>", unsafe_allow_html=True)

    # =========================================================================
    # TAB 3: 表计台账与工况全览 (包含报表导出)
    # =========================================================================
    with tabs[2]:
        st.markdown(
            """
            <div class='section-box'>
              <div class='section-title'>
                <span>⚡ 24 块智能物联电表台账与工况全览</span>
                <span style='font-size:12px; color:#059669; font-weight:normal;'>单表最新工况台账（每表一条，共 24 台在运）</span>
              </div>
              <div class='section-sub'>包含互感器变比规格、电信 NB-IoT 通信模组 IMEI、最新底数读数及继电器通断状态</div>
            """,
            unsafe_allow_html=True,
        )

        if not samples_df.empty:
            # 提取每块电表的最新工况记录（确保 24 块电表每表仅展示一条最新工况台账，杜绝时序采样导致的行重复）
            latest_meters = (
                samples_df.sort_values("datetime")
                .groupby("meter_no", as_index=False)
                .last()
            )

            # 过滤控件
            f_col1, f_col2, f_col3 = st.columns([1.2, 1.8, 1])
            with f_col1:
                categories = ["全部分类"] + sorted(latest_meters["category"].dropna().unique().tolist())
                selected_cat = st.selectbox("筛选用电场景", categories, index=0)
            with f_col2:
                search_kw = st.text_input("搜索电表号或安装点位", placeholder="输入点位名称（如：花房、空调、水泵、弱电间）或表号...")
            with f_col3:
                st.markdown("<div style='height:28px;'></div>", unsafe_allow_html=True)
                # 一键导出 CSV 按钮
                csv_buffer = io.StringIO()
                export_cols = latest_meters[[
                    "meter_no", "room_detail_addr", "category", "rate", "ct_rate",
                    "real_kwh", "total_kwh", "power_kw", "relay_status_desc", "online_status_desc",
                    "comm_type", "imei_no", "sample_time"
                ]].copy()
                export_cols.columns = [
                    "电表编号", "安装点位", "用电分类", "变比倍率", "CT/PT规格",
                    "折算真实底数(kWh)", "表盘原始底数", "实时功率(kW)", "继电器状态", "在线状态",
                    "通信方式", "IMEI设备号", "最新采样时间"
                ]
                csv_bytes = export_cols.to_csv(index=False).encode("utf-8-sig")
                st.download_button(
                    label="📥 导出表计台账 (CSV)",
                    data=csv_bytes,
                    file_name=f"电表实时台账_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
                    mime="text/csv",
                    width="stretch",
                )

            filtered_meters = latest_meters.copy()
            if selected_cat != "全部分类":
                filtered_meters = filtered_meters[filtered_meters["category"] == selected_cat]
            if search_kw.strip():
                kw = search_kw.strip()
                filtered_meters = filtered_meters[
                    filtered_meters["room_detail_addr"].str.contains(kw, case=False, na=False) |
                    filtered_meters["meter_no"].str.contains(kw, case=False, na=False)
                ]

            # 排序：安装位置升序
            filtered_meters = filtered_meters.sort_values("room_detail_addr", ascending=True)

            display_cols = filtered_meters[[
                "meter_no", "room_detail_addr", "category", "rate", "ct_rate",
                "real_kwh", "power_kw", "relay_status_desc", "online_status_desc",
                "comm_type", "imei_no", "sample_time"
            ]].copy()

            display_cols.columns = [
                "电表编号", "安装位置 / 点位名称", "用电分类", "互感器倍率", "CT/PT规格",
                "折算真实底数(kWh)", "实时负荷(kW)", "继电器状态", "在线状态",
                "通信方式", "IMEI 设备号", "最新采样时间"
            ]

            st.dataframe(
                display_cols,
                width="stretch",
                hide_index=True,
                column_config={
                    "折算真实底数(kWh)": st.column_config.NumberColumn(format="%.2f"),
                    "实时负荷(kW)": st.column_config.NumberColumn(format="%.2f kW"),
                    "互感器倍率": st.column_config.NumberColumn(format="%.0f"),
                }
            )
        else:
            st.info("暂未获取到电表工况数据。")

        st.markdown("</div>", unsafe_allow_html=True)

    # =========================================================================
    # TAB 4: 突发告警监测中心
    # =========================================================================
    with tabs[3]:
        st.markdown(
            """
            <div class='section-box'>
              <div class='section-title'>🚨 突发设备告警与运维事件中心 (Tier-3)</div>
              <div class='section-sub'>每 1 分钟轮询检索过流、断电、缺相、欠压、通信中断等异常事件</div>
            """,
            unsafe_allow_html=True,
        )

        if alarms_df.empty:
            st.markdown(
                """
                <div style='background:#f0faf4; border:1px solid #c9e4d5; border-radius:12px; padding:28px 20px; text-align:center;'>
                  <div style='font-size:32px; margin-bottom:8px;'>🟢</div>
                  <div style='font-size:16px; font-weight:700; color:#0e623f;'>当前所有回路运行状态平稳，暂无未处理告警事件</div>
                  <div style='font-size:12.5px; color:#638072; margin-top:6px;'>系统持续每 60 秒轮询平台告警通道；如出现断电、跳闸或电气越限将在此处第一时间响应。</div>
                </div>
                """,
                unsafe_allow_html=True,
            )
        else:
            st.dataframe(
                alarms_df,
                width="stretch",
                hide_index=True,
                column_config={
                    "meter_no": "电表号",
                    "alarm_time": "告警发生时间",
                    "alarm_name": "事件类型",
                    "room_addr": "点位位置",
                    "alarm_status": "处理状态",
                    "created_at": "记录入库时间",
                }
            )
        st.markdown("</div>", unsafe_allow_html=True)

    # =========================================================================
    # TAB 5: 数据通道与同步管理
    # =========================================================================
    with tabs[4]:
        st.markdown(
            """
            <div class='section-box'>
              <div class='section-title'>⚙️ SQLite 数据库与三级同步管道监控</div>
              <div class='section-sub'>本地存储状态、各级数据表行数与后台调度指令</div>
            """,
            unsafe_allow_html=True,
        )

        stat_col1, stat_col2, stat_col3, stat_col4 = st.columns(4)
        with stat_col1:
            st.metric("数据库存储路径", Path(data["db_path"]).name, f"体积: {data['db_size_kb']} KB")
        with stat_col2:
            st.metric("日冻结读数 (Tier-1)", f"{counts.get('meter_readings', 0)} 条", "每天归档")
        with stat_col3:
            st.metric("负荷工况采样 (Tier-2)", f"{counts.get('meter_load_samples', 0)} 条", "每15分钟轮询")
        with stat_col4:
            st.metric("告警事件历史 (Tier-3)", f"{counts.get('alarm_events', 0)} 条", "每分钟检测")

        st.markdown("---")
        exp_col1, exp_col2 = st.columns(2)
        with exp_col1:
            st.markdown("#### 📥 历史用电汇总报表下载")
            if not u_view.empty:
                exp_u_bytes = u_view.to_csv(index=False).encode("utf-8-sig")
                st.download_button(
                    label="下载每日用电量报表 (CSV)",
                    data=exp_u_bytes,
                    file_name=f"园区每日用电报表_{datetime.now().strftime('%Y%m%d')}.csv",
                    mime="text/csv",
                    width="stretch"
                )
            else:
                st.info("暂无数据可供导出")

        with exp_col2:
            st.markdown("#### 📥 分类场景用电报表下载")
            if not c_view.empty:
                exp_c_bytes = c_view.to_csv(index=False).encode("utf-8-sig")
                st.download_button(
                    label="下载场景分类用电报表 (CSV)",
                    data=exp_c_bytes,
                    file_name=f"园区场景分类用电报表_{datetime.now().strftime('%Y%m%d')}.csv",
                    mime="text/csv",
                    width="stretch"
                )
            else:
                st.info("暂无数据可供导出")

        st.markdown("---")
        st.markdown("#### 🚀 后台三级调度操作指令")
        st.code("""
# 1. 单次拉取今天日冻结抄表 (存入 meter_readings)
python3 sync_energy_to_sqlite.py --mode daily

# 2. 单次采集当前 15 分钟最新电表工况与瞬时负荷 (存入 meter_load_samples)
python3 sync_energy_to_sqlite.py --mode sample

# 3. 单次轮询扫描突发异常告警 (存入 alarm_events)
python3 sync_energy_to_sqlite.py --mode alarm

# 4. 常驻后台守护进程（自动按 1天/15分/1分 协同调度）
python3 sync_energy_to_sqlite.py --daemon
        """, language="bash")

        st.markdown("</div>", unsafe_allow_html=True)


# =============================================================================
# 侧边栏交互
# =============================================================================

with st.sidebar:
    st.markdown("## 🌿 绿城能源平台")
    st.caption("园区能碳智控运营中心")
    st.divider()

    st.markdown("### 📡 数据通道状态")
    st.markdown("""
    - **存储媒介**: 本地 SQLite (`energy_data.db`)
    - **表计总数**: 24 块智能物联电表
    - **通信方式**: 电信 NB-IoT (100% 在线)
    - **负荷采样**: 每 15 分钟级推算
    """)

    st.divider()

    if st.button("🔄 立即刷新数据", width="stretch"):
        st.cache_data.clear()
        st.rerun()

    st.caption("提示：页面内置 `@st.fragment` 每 10 秒自动轮询 SQLite 数据库。当后台同步写入新数据时，页面将无感实时更新。")


# =============================================================================
# 执行页面渲染
# =============================================================================

render_live_dashboard(DEFAULT_DB_PATH)
