const BASE = '/api';

export class ApiAuthError extends Error {
  constructor(message = '未登录或登录已过期') {
    super(message);
    this.name = 'ApiAuthError';
  }
}

function token(): string {
  return localStorage.getItem('energy_token') ?? '';
}

function authHeaders(): HeadersInit {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function handle401() {
  localStorage.removeItem('energy_token');
  window.dispatchEvent(new Event('energy-auth-expired'));
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    handle401();
    throw new ApiAuthError();
  }
  if (!res.ok) throw new Error(`请求失败: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    handle401();
    throw new ApiAuthError();
  }
  if (!res.ok) throw new Error(`请求失败: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}
