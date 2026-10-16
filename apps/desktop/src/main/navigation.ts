export function buildCspHeader(dev: boolean): string {
  if (dev) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
    ].join('; ');
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join('; ');
}

/** 基于 URL 的导航白名单：协议 + host + port 精确一致；pathname 非 `/` 时要求精确匹配入口。 */
export function isAllowedNavigation(rawUrl: string, allowedNavigations: string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return allowedNavigations.some((allowed) => {
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(allowed);
    } catch {
      return false;
    }
    if (url.protocol !== allowedUrl.protocol) return false;
    if (url.hostname !== allowedUrl.hostname) return false;
    if (url.port !== allowedUrl.port) return false;
    if (allowedUrl.pathname === '/' || allowedUrl.pathname === '') return true;
    return url.pathname === allowedUrl.pathname;
  });
}
