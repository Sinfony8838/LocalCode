import { promises as dns } from 'node:dns';
import net from 'node:net';

const MAX_WEB_FETCH_BYTES = 512 * 1024;
const MAX_WEB_FETCH_CHARS = 32_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export function isPrivateOrReservedIp(ipInput: string): boolean {
  const ip = ipInput.trim().toLowerCase();
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (ip.startsWith('::ffff:')) {
    const mappedV4 = ip.slice('::ffff:'.length);
    if (net.isIP(mappedV4) === 4) {
      return isPrivateOrReservedIp(mappedV4);
    }
    return true;
  }

  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b, c] = parts;
    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private)
    if (a === 10) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link-local / Cloud Metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && c === 0) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)
    if (a >= 224) return true;
    return false;
  }

  if (version === 6) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // fc00::/7 (Unique local address)
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    // fe80::/10 (Link-local)
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true;
    // ff00::/8 (Multicast)
    if (ip.startsWith('ff')) return true;
    // 2001:db8::/32 (Documentation)
    if (ip.startsWith('2001:db8:') || ip.startsWith('2001:0db8:')) return true;
    return false;
  }

  return true;
}

export async function validateSafeHttpsUrl(
  urlInput: string,
  lookupFn: (hostname: string) => Promise<Array<{ address: string }>> = (hostname) => dns.lookup(hostname, { all: true }),
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlInput);
  } catch {
    throw new Error('无效的 URL 格式。');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('安全策略仅允许访问 HTTPS 链接。');
  }

  if (parsed.username || parsed.password) {
    throw new Error('安全策略禁止在 URL 中包含认证凭据。');
  }

  const rawHostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!rawHostname || rawHostname === 'localhost' || rawHostname.endsWith('.local') || rawHostname.endsWith('.internal')) {
    throw new Error('安全策略禁止访问本地或内网主机名。');
  }

  if (net.isIP(rawHostname)) {
    if (isPrivateOrReservedIp(rawHostname)) {
      throw new Error(`安全策略拦截了内网或保留 IP 地址：${rawHostname}`);
    }
    return parsed;
  }

  const resolved = await lookupFn(rawHostname);
  if (!resolved.length) {
    throw new Error(`无法解析域名：${rawHostname}`);
  }
  for (const record of resolved) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new Error(`安全策略拦截了指向内网或保留地址的域名（${rawHostname} -> ${record.address}）。`);
    }
  }

  return parsed;
}

export function extractReadableWebText(raw: string, contentType: string): string {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes('application/json') || lowerType.includes('text/plain') || lowerType.includes('text/markdown')) {
    return raw.trim();
  }

  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface FetchWebTextOptions {
  timeoutMs?: number;
  maxChars?: number;
  signal?: AbortSignal;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  fetchFn?: typeof fetch;
}

export async function fetchWebText(urlInput: string, options: FetchWebTextOptions = {}): Promise<string> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 30_000);
  const maxChars = Math.min(Math.max(options.maxChars ?? MAX_WEB_FETCH_CHARS, 500), MAX_WEB_FETCH_CHARS);
  const lookupFn = options.lookupFn;
  const fetchFn = options.fetchFn ?? fetch;

  let currentUrl = urlInput;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validatedUrl = await validateSafeHttpsUrl(currentUrl, lookupFn);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetchFn(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'LocalCode-WebFetch/1.0',
          Accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`HTTP 重定向缺少 Location 头（状态码 ${response.status}）。`);
        }
        if (redirectCount === MAX_REDIRECTS) {
          throw new Error(`重定向次数超过上限（最多 ${MAX_REDIRECTS} 次）。`);
        }
        currentUrl = new URL(location, validatedUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`请求失败（HTTP ${response.status}）。`);
      }

      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncatedByBytes = false;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (totalBytes + value.byteLength > MAX_WEB_FETCH_BYTES) {
              const remaining = MAX_WEB_FETCH_BYTES - totalBytes;
              if (remaining > 0) {
                chunks.push(value.subarray(0, remaining));
              }
              truncatedByBytes = true;
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
            totalBytes += value.byteLength;
          }
        }
      } else {
        const arrayBuf = new Uint8Array(await response.arrayBuffer());
        if (arrayBuf.byteLength > MAX_WEB_FETCH_BYTES) {
          chunks.push(arrayBuf.subarray(0, MAX_WEB_FETCH_BYTES));
          truncatedByBytes = true;
        } else {
          chunks.push(arrayBuf);
        }
      }

      const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const rawText = combined.toString('utf8');
      const readable = extractReadableWebText(rawText, contentType);
      const truncated = readable.length > maxChars || truncatedByBytes;
      const sliced = readable.slice(0, maxChars);

      return [
        `URL: ${validatedUrl.toString()}`,
        `Content-Type: ${contentType}`,
        '',
        sliced || '（页面无可见文本内容）',
        truncated ? `\n…（内容已截断，仅展示前 ${maxChars} 字符）` : '',
      ]
        .filter(Boolean)
        .join('\n');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw new Error('抓取网页失败。');
}
