export const DEFAULT_BASE_URL = 'https://api.podpitch.com';

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('The API URL must use HTTPS. HTTP is allowed only on localhost.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an API origin, such as https://api.podpitch.com, without a path or credentials.');
  }
  return url.origin;
}

export function validateKey(value) {
  const key = value.trim();
  if (!/^pp_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Enter a PodPitch API key starting with pp_. Get one at https://app.podpitch.com/settings/api.');
  }
  return key;
}

export async function request(baseUrl, apiKey, path, query = {}) {
  const url = new URL(`/api/v1${path}`, normalizeBaseUrl(baseUrl));
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${validateKey(apiKey)}`, Accept: 'application/json', 'User-Agent': 'podpitch-cli/1.0.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  }).catch(() => { throw new Error('Could not reach the PodPitch API. Check your connection and API URL.'); });
  if (!response.ok) {
    const messages = {
      400: 'The API rejected the filters. Check podpitch --help.',
      401: 'The API key is invalid or revoked. Run podpitch login again.',
      403: 'Your account or profile does not have access to this action. Check your PodPitch integration access.',
      404: 'The record was not found or is outside your API key\'s profile.',
      422: 'The API rejected a parameter. Check podpitch --help.',
      429: 'The API rate limit was reached. Wait before trying again.',
    };
    throw new Error(`HTTP ${response.status}. ${messages[response.status] || 'The API request failed. Try again later.'}`);
  }
  const data = await response.json().catch(() => { throw new Error('The API returned an invalid JSON response.'); });
  if (data === null || typeof data !== 'object' || data.success === false) {
    throw new Error('The API returned an unsuccessful response.');
  }
  return data;
}
