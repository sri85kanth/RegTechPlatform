/**
 * The splash after sign-in plays once per sign-in: the sign-in page asks for it,
 * the app shell shows it when the session is ready, and clears the request.
 * A reload of an existing session shows nothing.
 */
const KEY = 'cb.splash';

export function requestSplash(): void {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode: no splash, no harm */ }
}

export function splashRequested(): boolean {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function clearSplash(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
