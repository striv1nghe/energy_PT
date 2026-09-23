# 绿城园区能源数据监控中心 — Node 全栈迁移方案

> 目标：将现有 Python (Streamlit + pandas + Plotly) 单文件看板，迁移为可靠、易长期维护的 Node 全栈（NestJS + React 18/Vite + ECharts + better-sqlite3）。不要求向后兼容。

## 一、目标技术栈

| 层 | 现状 (Python) | 目标 (Node/TS) |
|---|---|---|
| 前端 | Streamlit 单文件 | React 18 + Vite + TypeScript + Ant Design |
| 图表 | Plotly | Apache ECharts |
| 后端 | Streamlit 内置 / 无独立服务 | NestJS (TypeScript) |
| 数据同步 | Python 脚本 + daemon | NestJS `@nestjs/schedule` 定时任务 + 同步服务 |
| 数据存储 | SQLite（保留） | SQLite + `better-sqlite3`（结构不变，后续可平滑切 PG） |
| 认证 | Python 调用 node 内嵌 JS 实现 RSA | 原生 TS `AuthService`（消除跨语言 hack） |

## 二、仓库结构（pnpm monorepo）

```
energy_PT/
├── apps/
│   ├── api/                 # NestJS 后端
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── database/     # better-sqlite3 连接 + 迁移
│   │       │   ├── energy/       # 数据读取 + 聚合计算 + REST/导出
│   │       │   ├── sync/         # 三级同步 + 定时调度 + 手动触发
│   │       │   └── auth/         # BBICloud sid 缓存 + 自动重登(RSA)
│   │       └── main.ts
│   └── web/                 # React 前端
│       └── src/
│           ├── api/         # TanStack Query hooks + fetch client
│           ├── components/  # KpiCard / 图表 / 表格 / 状态栏
│           ├── views/       # Dashboard（5 Tab 单页）
│           └── theme/       # 绿色主题 + ECharts 主题
├── packages/
│   └── shared/              # 前后端共享类型 (DTO / 枚举 / 计算常量)
├── data/                    # energy_data.db（复制保留）
├── docs/                    # API 文档 + 迁移说明
└── legacy/                  # 原 Python 文件归档（不再运行）
```

## 三、后端设计（NestJS）

**数据层 `DatabaseModule`**
- 用 `better-sqlite3` 同步读取（快、类型安全），复用现有 5 表结构，把 `init_database` 的建表 SQL 固化为 `migrations/001_init.sql`。
- 保留「数据库指纹」检测（mtime + size + `PRAGMA data_version`）作为缓存失效信号。

**聚合计算 `EnergyService`（纯函数，必须逐项移植 + 单测）**

| 原 Python 逻辑 | Node 实现要点 |
|---|---|
| 日用电量 `groupby(meter_no).diff().clip(0)` | 按 `meter_no+日期` 排序后逐表计算相邻 `real_kwh` 增量 |
| 功率 `P=ΔE/Δt`，过滤 `0<hours<=24`，首点 bfill | 同法，时间用字符串→`Date` 解析，保持本地时区语义 |
| `classify_meter` 关键词归集 | 原样移植 9 条规则，常量抽到 shared |
| 碳排 0.581、电费 0.82 | 常量抽到 shared 的 `config.ts` |

**REST API**
- `GET /api/overview` — 项目信息、表计数、库体积、更新时间
- `GET /api/meters?category=&search=` — 台账（每表最新工况 + 过滤/搜索）
- `GET /api/kpi?period=` — 周期总用电/最新日/电费/碳排/在线数/告警数
- `GET /api/daily-usage?period=` — 日用电趋势 + 分类堆叠 + 分表数据
- `GET /api/load-curve?mode=total|single|multi|category&meters=&category=&period=` — 负荷曲线序列
- `GET /api/alarms` — 告警事件
- `POST /api/sync/run`（daily/sample/alarm/all）+ `GET /api/sync/status` — 手动同步
- `GET /api/export/ledger|daily|category.csv` — CSV 导出（`\ufeff` BOM，Excel 中文兼容）

**实时刷新**：沿用现有「每 10 秒轮询」行为，由前端 TanStack Query `refetchInterval: 10000` 驱动（最简、与原版一致）；预留 SSE 推送作为后续升级点，不做过度设计。

**同步 `SyncModule`（移植 `sync_energy_to_sqlite.py`）**
- 三个同步函数 `syncDaily / syncSample / syncAlarm / backfillIntraday` 用 `axios` 重写（带 sid 失效自动重登重试，对应原 `make_request` 的 2 次重试）。
- 调度：`@nestjs/schedule` Cron — 告警每 60s、采样每 15min、日冻结每日 02:00，替代原 Python `while True` 守护循环。
- 支持 `--backfill-intraday N` 的历史回填等价命令（CLI 子命令或 API 参数）。

**认证 `AuthModule`（重点风险项）**
- 原 `auto_login_and_get_sid` 靠 `subprocess` 调 node 内嵌 JS、抓取前端 `chunk-*.js` 并 `new Function` 提取 RSA 函数——这是最脆弱的部分，必须重写为原生 TS：`GET /getRsaKey` → 用 `jsencrypt`/Node `crypto` 对「反转后的密码」RSA 加密 → `POST /doLogin` → 缓存 sid 到 `.bbi_session`。
- 保留「手动配置 sid / 环境变量」作为免登录降级通道。
- ⚠️ 实现阶段需实测该 RSA 加密细节（指数/模数格式），是唯一有外部依赖不确定性的点。

## 四、前端设计（React + Vite + ECharts）

**页面 = 单页 5 Tab（与原版一一对应）**，Ant Design `Tabs` + `Row/Col` 栅格复刻宽屏布局。

| 原 Tab | 组件 | ECharts 实现 |
|---|---|---|
| 能源总览与趋势 | `DailyTrendChart` / `CategoryStackedBar` / `CategoryDonut` / `Top5Bar` / 明细表 + 运行摘要卡 | line(渐变面积) / 堆叠 bar / 环形 pie / 横向 bar |
| 实时负荷与单表曲线 | `LoadCurveChart` + 模式切换(总览/单表/多表/分类) + 回路参数卡 | 多条 line，tooltip 同轴 |
| 表计台账与工况 | `MeterTable`（分类筛选 + 搜索 + CSV 导出） | Ant Table |
| 突发告警监测 | `AlarmTable` / 空态绿卡 | Ant Table |
| 通道与同步管理 | `SyncPanel`（统计 + 导出 + 调度指令） | Ant Statistic |

- **KPI 卡片**：`KpiCard` 组件，复刻原 CSS 卡片样式（渐变侧边栏、绿色主色 `#0d8250`、脉冲状态点、悬浮动效）。
- **状态管理**：TanStack Query（服务端数据 + 轮询）+ 少量 `useState/Context`（UI 状态），不引入重状态库。
- **图表主题**：抽一份 ECharts 绿色主题，统一 line/pie/bar 配色与原版一致。

## 五、分阶段执行计划

| 阶段 | 内容 | 交付/验收 |
|---|---|---|
| **P0 脚手架** | pnpm workspace + NestJS + Vite + TS 严格模式 + ESLint/Prettier | 前后端可启动、可联调 |
| **P1 数据层** | better-sqlite3 连接、迁移、`classify/日增量/功率` 纯函数 + 单测 | 用真实 db 跑通计算，输出与 Python 一致 |
| **P2 后端 API** | energy 全接口 + CSV 导出 + 指纹缓存 | REST 返回与 SQL 直查核对 |
| **P3 前端页面** | 主题 + KPI + 5 Tab + ECharts + 轮询 + 导出 | 视觉/数据与原看板一致 |
| **P4 同步/认证** | 三级同步 + 定时调度 + RSA 自动登录 + 手动触发 | daemon 等价能力跑通 |
| **P5 收尾** | 空态/边界、时区与中文编码核对、Docker + 部署文档、legacy 归档 | 可一键部署 |

## 六、关键风险与应对

1. **BBICloud 自动登录 RSA**（依赖上游前端内部实现）→ P4 实测加密细节，保留手动 sid 降级。
2. **时区语义**：`data_time/sample_time` 是本地时间字符串 → 统一按本地时区解析，不做 UTC 转换。
3. **中文 CSV**：Excel 需 UTF-8 BOM，导出接口统一加 `\ufeff`。
4. **better-sqlite3 原生编译**：优先用官方预编译二进制；若环境受限，回退 Node 22+ 内置 `node:sqlite`。
5. **`iems_iot_client.py`**（JWT 通道 + Webhook）当前未接入主数据流，作为可选后续模块，不阻塞主线。
