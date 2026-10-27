/**
 * 本地接口代理（仅用于 vite dev / vite preview 服务器）
 *
 * 背景：本应用是纯前端项目，浏览器会直接请求用户配置的第三方接口地址。
 * 很多中转/自建接口（例如 new-api、one-api 类服务）没有开启 CORS，
 * 浏览器发出的 OPTIONS 预检会被拒绝（或响应里没有 Access-Control-Allow-Origin），
 * 于是 fetch 直接抛 TypeError，前端只能提示“网络请求失败”。
 *
 * 这里在开发服务器上加一个同源反向代理：
 *   POST /api-proxy/v1/chat/completions
 *   X-Api-Base: https://your-api.example.com
 * 由 Node 在服务端转发，浏览器不再受跨域限制，也不受证书域名不匹配之外的限制。
 *
 * 另外支持直接代理一个绝对地址（用于把返回的图片 URL 下载为 base64）：
 *   GET /api-proxy?url=https%3A%2F%2Fexample.com%2Fa.png
 */
import http from 'node:http';
import https from 'node:https';

const PROXY_MARK_HEADER = 'x-api-proxy';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const writeJson = (res, status, payload) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // 前端依赖这个响应头判断“本地代理是否可用”
  res.setHeader(PROXY_MARK_HEADER, '1');
  res.end(JSON.stringify(payload));
};

/**
 * 解析出真实需要访问的上游地址
 */
const resolveTargetUrl = (req) => {
  const rawUrl = req.url || '/';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';

  // 1) 绝对地址代理：/api-proxy?url=<encoded>
  const explicitUrl = new URLSearchParams(search.replace(/^\?/, '')).get('url');
  if (explicitUrl) {
    return new URL(explicitUrl);
  }

  // 2) 接口代理：/api-proxy/<path> + X-Api-Base 头
  const baseHeader = req.headers['x-api-base'];
  if (!baseHeader || typeof baseHeader !== 'string' || !baseHeader.trim()) {
    throw new Error('缺少 X-Api-Base 请求头（请配置接口地址）');
  }

  const baseUrl = new URL(baseHeader.trim());
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new Error('X-Api-Base 仅支持 http/https 地址');
  }

  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const targetPath = `${basePath}${path.startsWith('/') ? path : `/${path}`}` || '/';
  const target = new URL(baseUrl.origin);
  target.pathname = targetPath;
  target.search = search; // 保留原始查询参数
  return target;
};

const forward = (req, res) => {
  let target;
  try {
    target = resolveTargetUrl(req);
  } catch (error) {
    writeJson(res, 400, {
      error: { message: `代理目标地址无效：${error.message}`, type: 'proxy_error' },
    });
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // 交给上游自己决定，避免把浏览器的来源信息透传过去
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue;
    if (lower === 'x-api-base' || lower === 'accept-encoding') continue;
    if (lower.startsWith('sec-fetch-')) continue;
    headers[lower] = value;
  }
  headers.host = target.host;

  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  const proxyReq = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        responseHeaders[key] = value;
      }
      responseHeaders[PROXY_MARK_HEADER] = '1';
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
    }
  );

  // 生成图片可能很慢，这里给足 5 分钟；前端自身还有超时控制
  proxyReq.setTimeout(300_000, () => {
    const timeoutError = new Error('上游接口请求超时（300 秒）');
    timeoutError.code = 'ETIMEDOUT';
    proxyReq.destroy(timeoutError);
  });

  proxyReq.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    writeJson(res, 502, {
      error: {
        message: `代理请求失败：${error.message}`,
        type: 'proxy_error',
        code: error.code || '',
      },
    });
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  // 直接流式转发请求体（参考图很大时也不会占满内存）
  req.pipe(proxyReq);
};

export function apiProxyPlugin() {
  return {
    name: 'local-api-proxy',
    configureServer(server) {
      server.middlewares.use('/api-proxy', forward);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api-proxy', forward);
    },
  };
}
