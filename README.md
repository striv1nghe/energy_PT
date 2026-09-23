# 绿城园区能源数据监控中心 (Energy PT)

面向「宁波慈溪凤起潮鸣」项目的 24 块智能 NB-IoT 电表能源监控看板。本仓库为 **Node 全栈重构版**（原 Python/Streamlit 版本已归档至 `legacy/`）。

- **前端**：React 18 + Vite + TypeScript + Ant Design + Apache ECharts
- **后端**：NestJS + TypeScript
- **数据**：SQLite（Node 内置 `node:sqlite`，零原生依赖）

## 目录结构

```
apps/
  api/        # NestJS 后端（数据读取/聚合、三级同步、定时调度、REST API、CSV 导出）
  web/        # React 前端（KPI + 5 个 Tab + ECharts 图表 + 10 秒轮询）
packages/
  shared/     # 前后端共享类型与计算常量
data/         # energy_data.db（运行时数据，.gitignore 忽略）
docs/         # 迁移方案与上游 API 文档
legacy/       # 原 Python 版本归档（不再运行）
```

## 快速开始

要求 Node >= 22（内置 `node:sqlite`）与 pnpm。

```bash
# 1. 安装依赖
pnpm install

# 2. 构建 shared 包
pnpm build:shared

# 3. 准备数据（将上游同步好的 SQLite 库放入 data/）
mkdir -p data && cp /path/to/energy_data.db data/energy_data.db

# 4. 分别启动后端与前端（两个终端）
pnpm dev:api     # http://localhost:4000/api
pnpm dev:web     # http://localhost:5173  （Vite 代理 /api -> 4000）
```

打开 http://localhost:5173 即可查看看板。页面每 10 秒自动轮询 SQLite 数据库，后台写入新数据时无感热更新。

## 生产部署

构建后由后端同源托管前端静态资源，单进程即可运行：

```bash
pnpm build
PORT=4000 node apps/api/dist/main.js
# 看板: http://localhost:4000/    API: http://localhost:4000/api
```

或用 Docker：

```bash
docker compose up --build -d   # http://localhost:4000
```

## 数据同步

上游 BBICloud 数据通过三级同步管道写入 SQLite（对应原 `sync_energy_to_sqlite.py`）：

| 级别 | 频率 | 命令 |
|---|---|---|
| Tier-1 日冻结 | 每日 | `pnpm --filter @energy/api sync:daily` |
| Tier-2 15分钟负荷采样 | 每 15 分钟 | `pnpm --filter @energy/api sync:sample` |
| Tier-3 分钟级告警 | 每 1 分钟 | `pnpm --filter @energy/api sync:alarm` |
| 全量对齐 | 单次 | `pnpm --filter @energy/api sync:all` |
| 常驻守护进程 | 自动调度 | `pnpm --filter @energy/api sync:daemon` |

也可通过运行中的 API 手动触发：`POST /api/sync/run`（body 为 `{ "mode": "daily|sample|alarm|all" }`）。

### 会话配置（环境变量 / `.env`）

| 变量 | 说明 |
|---|---|
| `BBI_SID` | 手动提供的 BBICloud 会话 sid（优先使用，可跳过自动登录） |
| `BBI_USERNAME` / `BBI_PASSWORD` | 账号密码，用于 sid 失效时基于前端 RSA 算法自动重登 |
| `BBI_DB_PATH` | SQLite 路径，默认 `<仓库根>/data/energy_data.db` |
| `SYNC_DAEMON` | 设为 `true` 时启用后台定时调度 |
| `PORT` | API 端口，默认 4000 |

> 说明：自动登录使用原生 BigInt 复刻了 BBICloud 前端 RSAUtils 的原始 RSA 加密（无 PKCS#1 填充），消除了原版 `subprocess` 调 Node 抓取前端 chunk 的脆弱做法。若平台登录接口有变更，优先使用手动 `BBI_SID` 作为稳定降级通道。

## REST API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 项目信息、库体积、各表行数 |
| GET | `/api/kpi?period=7d` | 周期 KPI 与同环比 |
| GET | `/api/daily-usage?period=7d` | 日用电趋势、分类、Top5 |
| GET | `/api/load-curve?mode=total&period=7d` | 15 分钟负荷曲线 |
| GET | `/api/meters?category=&search=` | 表计台账 |
| GET | `/api/alarms` | 告警事件 |
| POST | `/api/sync/run` | 手动触发同步 |
| GET | `/api/sync/status` | 同步状态 |
| GET | `/api/export/{daily,category,ledger}.csv` | CSV 导出（UTF-8 BOM） |

`period` 取值：`today | 7d | 14d | 30d | all`；`load-curve` 的 `mode` 取值：`total | single | multi | category`。

## 测试与校验

```bash
pnpm --filter @energy/api test     # 计算纯函数 + RSA 往返 单元测试
pnpm typecheck                     # 全仓类型检查
```

核心计算（日增量、15 分钟功率 P=ΔE/Δt、分类归集）已通过单元测试，并与原 Python 实现做了真实数据交叉验证（77 天总用电 252540.39 kWh、峰值 7071.37 kWh、当前负荷 89.23 kW 等全部一致）。

## 迁移说明

完整方案见 [docs/migration-plan.md](docs/migration-plan.md)，上游 BBICloud 接口规范见 `docs/IEMS-IOT-API接口文档.md`。
