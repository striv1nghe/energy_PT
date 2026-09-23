import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as https from 'node:https';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findWorkspaceRoot } from '../../common/paths';
import { rsaEncrypt } from './rsa';

const BASE = 'https://a.bbicloud.com';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/** BBICloud 会话管理：sid 缓存 + 基于前端 RSA 的自动登录续期。 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessionFile: string;
  private cachedSid: string | null = null;

  constructor() {
    this.sessionFile = process.env.BBI_SESSION_FILE ?? join(findWorkspaceRoot(), '.bbi_session');
  }

  /** 获取当前可用 sid：缓存 -> 环境变量 BBI_SID -> 会话文件。 */
  getSid(): string {
    if (this.cachedSid) return this.cachedSid;
    const env = process.env.BBI_SID ?? '';
    if (env) return env;
    if (existsSync(this.sessionFile)) {
      const sid = readFileSync(this.sessionFile, 'utf8').trim();
      if (sid) return sid;
    }
    return '';
  }

  credentials(): { username: string; password: string } {
    return { username: process.env.BBI_USERNAME ?? '', password: process.env.BBI_PASSWORD ?? '' };
  }

  /** 自动登录并返回新 sid；失败返回 null。 */
  async login(username: string, password: string): Promise<string | null> {
    if (!username || !password) return null;
    this.logger.log(`尝试自动登录平台刷新会话 (账号: ${username})...`);
    try {
      const rsaResp = await axios.get(`${BASE}/platform/login/getRsaKey`, { httpsAgent, timeout: 15_000 });
      const rsaKey = rsaResp.data?.data as { publicKeyModulus?: string; publicKeyExponent?: string } | undefined;
      if (!rsaKey?.publicKeyModulus || !rsaKey?.publicKeyExponent) return null;

      const setCookies = (rsaResp.headers['set-cookie'] ?? []) as string[];
      const initialCookie = setCookies.map((c) => c.split(';')[0]).join('; ');

      const encPwd = rsaEncrypt(password.split('').reverse().join(''), rsaKey.publicKeyModulus, rsaKey.publicKeyExponent);
      const body = new URLSearchParams({ username, password: encPwd, client: 'PC', platformCaptcha: '' }).toString();

      const loginResp = await axios.post(`${BASE}/platform/login/doLogin`, body, {
        httpsAgent,
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0',
          Referer: `${BASE}/v2/`,
          Cookie: initialCookie,
        },
      });

      const resObj = loginResp.data as { code?: number; msg?: string; data?: string } | undefined;
      if (resObj?.code === 0) {
        const sid = resObj.data || (initialCookie.match(/sid=([a-zA-Z0-9]+)/) ?? [])[1] || '';
        if (sid) {
          this.cachedSid = sid;
          writeFileSync(this.sessionFile, sid, 'utf8');
          this.logger.log(`自动登录成功，SID: ${sid.slice(0, 8)}...`);
          return sid;
        }
      }
      this.logger.error(`自动登录失败: ${resObj?.msg ?? '未知原因'}`);
    } catch (e) {
      this.logger.warn(`自动登录异常: ${(e as Error).message}`);
    }
    return null;
  }
}
