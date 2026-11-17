// ============================================================
// One place every API call goes through.
//
// The session token is attached here rather than in each service, so there is a
// single answer to "is this request authenticated?" — and a single place to
// handle a session that has expired or been revoked.
// ============================================================
// Same origin in a build: nginx serves the app and proxies /api, so a
// hard-coded host would break the deployed site (and an http:// one is blocked
// outright on an https page). Only a dev server talks to a separate port.
export const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:8787' : '');

const KEY = 'cb.session';

export function getToken(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  // The API is fully gated now, so stores that load company data must wait for
  // a session and reload when one arrives — the mirror of cb:signed-out below.
  if (t) window.dispatchEvent(new CustomEvent('cb:signed-in'));
}

// Which company the app is working in. Empty = the home company. One address
// and one sign-in serve every company: nginx reads this header and sends the
// request to that company's API once the session is confirmed to belong there.
const COMPANY_KEY = 'cb.company';
export function getCompany(): string {
  try { return localStorage.getItem(COMPANY_KEY) ?? ''; } catch { return ''; }
}
/** Switch company. Reloads, so no screen keeps another company's data in memory. */
export function switchCompany(slug: string, path = '/') {
  try { if (slug) localStorage.setItem(COMPANY_KEY, slug); else localStorage.removeItem(COMPANY_KEY); } catch { /* private mode */ }
  window.location.assign(path);
}
/** The headers every request to the API carries: the session and the company. */
export function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // a request may name its company itself (saving a new company's profile before switching to it)
  const company = getCompany();
  if (company && !headers.has('X-Company')) headers.set('X-Company', company);
  return headers;
}

/** Raised on 401 so callers can send the user back to sign-in rather than showing a bare error. */
export class Unauthorized extends Error {
  constructor(msg = 'Your session has expired. Please sign in again.') { super(msg); }
}
/** Raised on 403 — authenticated, but the role does not permit it. */
export class Forbidden extends Error {}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    // A 401 from the login call itself is an answer ("wrong password",
    // "one-time code required"), not an expired session — surface it verbatim
    // and do not broadcast a sign-out for it.
    if (path.startsWith('/api/auth/login')) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.detail ?? 'invalid email or password');
    }
    setToken('');
    window.dispatchEvent(new CustomEvent('cb:signed-out'));
    throw new Unauthorized();
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep status */ }
    if (res.status === 403) throw new Forbidden(detail);
    throw new Error(detail);
  }
  return res.json();
}

export const apiGet  = <T,>(p: string) => api<T>(p);
export const apiPost = <T,>(p: string, body?: unknown) =>
  api<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T,>(p: string, body?: unknown) =>
  api<T>(p, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T,>(p: string) => api<T>(p, { method: 'DELETE' });
