# ---- 构建与运行 ----
# 单阶段构建（内部工具，简单可靠；如需精简可改为多阶段）
FROM node:24-slim

RUN npm install -g pnpm@12.4.2

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV PORT=4000
ENV BBI_DB_PATH=/app/data/energy_data.db

EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
