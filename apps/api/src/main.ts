import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { findWorkspaceRoot } from './common/paths';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true }));

  // 若已构建前端，则由后端同源托管静态资源（单进程/单容器部署）。
  const webDist = join(findWorkspaceRoot(), 'apps', 'web', 'dist');
  if (existsSync(webDist)) {
    app.useStaticAssets(webDist, { index: 'index.html' });
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🌿 能源数据 API 已启动: http://localhost:${port}/api`);
  if (existsSync(webDist)) {
    // eslint-disable-next-line no-console
    console.log(`🌿 仪表盘已托管: http://localhost:${port}/`);
  }
}

bootstrap();
