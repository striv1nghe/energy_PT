import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 从给定目录向上查找 monorepo 根目录（以 pnpm-workspace.yaml 为标记）。
 * 用于在 dev (cwd=apps/api) 与 prod 两种运行方式下都能稳定定位 data/ 等资源。
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
