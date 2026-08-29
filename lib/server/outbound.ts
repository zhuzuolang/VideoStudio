import { ApiError } from "./api";
import { bindings } from "./runtime";

const FORBIDDEN_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);

// Built-in provider presets use this vendor-owned HTTPS host. Its TLS identity and
// exact hostname are stable, while third-party DNS-over-HTTPS lookups can be
// unavailable from some Worker regions. Only this exact host on the default HTTPS
// port may bypass the external DNS preflight; all other URL safety checks remain.
const TRUSTED_HTTPS_MODEL_HOSTS = new Set([
  "ark.cn-beijing.volces.com",
]);

const PUBLIC_DNS_JSON_RESOLVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.alidns.com/resolve",
];

export async function validateModelEndpoint(value: string): Promise<string> {
  const localEndpoint = localDevelopmentModelEndpoint(value);
  if (localEndpoint) return localEndpoint;
  const allowlistedHttpEndpoint = allowlistedPublicHttpModelEndpoint(value);
  if (allowlistedHttpEndpoint) return allowlistedHttpEndpoint;
  return validatePublicHttpsUrlInternal(
    value,
    { allowQuery: false, purpose: "模型地址" },
    isTrustedHttpsModelEndpoint(value),
  );
}

function isTrustedHttpsModelEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return url.protocol === "https:"
      && !url.port
      && TRUSTED_HTTPS_MODEL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function localDevelopmentModelEndpoint(value: string): string | null {
  const enabled = bindings()?.ALLOW_LOCAL_MODEL_ENDPOINTS?.trim().toLowerCase() === "true";
  if (!enabled) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(hostname)
    || url.username
    || url.password
    || url.hash
    || url.search
  ) {
    return null;
  }

  return url.toString();
}

export function allowlistedPublicHttpModelEndpoint(value: string): string | null {
  const allowedAuthorities = new Set(
    (bindings()?.MODEL_HTTP_ENDPOINT_ALLOWLIST ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .map((item) => {
        const match = item.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
        if (!match) return null;
        const port = Number(match[2]);
        return port >= 1 && port <= 65_535 ? `${match[1]}:${port}` : null;
      })
      .filter((item): item is string => item !== null),
  );
  if (allowedAuthorities.size === 0) return null;

  const explicitAuthority = value.match(/^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?:[/?#]|$)/i);
  if (!explicitAuthority) return null;
  const requestedPort = Number(explicitAuthority[2]);
  if (requestedPort < 1 || requestedPort > 65_535) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    url.protocol !== "http:"
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname !== explicitAuthority[1]
    || !isPublicIp(hostname)
    || !allowedAuthorities.has(`${hostname}:${requestedPort}`)
    || url.username
    || url.password
    || url.hash
    || url.search
  ) {
    return null;
  }

  return `http://${hostname}:${requestedPort}${url.pathname}`;
}

export async function validatePublicHttpsUrl(
  value: string,
  options: { allowQuery?: boolean; purpose?: string } = {},
): Promise<string> {
  return validatePublicHttpsUrlInternal(value, options, false);
}

async function validatePublicHttpsUrlInternal(
  value: string,
  options: { allowQuery?: boolean; purpose?: string },
  skipDnsLookup: boolean,
): Promise<string> {
  const purpose = options.purpose ?? "远程地址";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "INVALID_PUBLIC_URL", `${purpose}必须是有效的 HTTPS URL。 `);
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!options.allowQuery && url.search)) {
    throw new ApiError(400, "INVALID_PUBLIC_URL", `${purpose}必须使用 HTTPS，且不能包含凭据或片段。 `);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !hostname ||
    FORBIDDEN_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".nip.io") ||
    hostname.endsWith(".sslip.io")
  ) {
    throw new ApiError(400, "UNSAFE_PUBLIC_URL", `${purpose}不能指向本机或内部网络。 `);
  }

  if (isIpLiteral(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new ApiError(400, "UNSAFE_PUBLIC_URL", `${purpose}不能指向私有、回环或保留 IP。 `);
    }
  } else if (!skipDnsLookup) {
    await assertPublicDns(hostname, purpose);
  }

  url.hostname = hostname;
  return url.toString();
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isPublicIp(address: string): boolean {
  if (address.includes(":")) return isPublicIpv6(address);
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  // Only currently allocated global-unicast space (2000::/3) is eligible.
  // This rejects loopback, ULA, link-local, multicast, IPv4-mapped and NAT64 forms.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  // Teredo (2001::/32), benchmarking (2001:2::/48), documentation (2001:db8::/32),
  // ORCHID ranges (2001:10::/28, 2001:20::/28), 6to4 (2002::/16), and 3fff::/20 docs.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02 && bytes[4] === 0x00 && bytes[5] === 0x00) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && ((bytes[3] & 0xf0) === 0x10 || (bytes[3] & 0xf0) === 0x20)) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0x00) return false;
  return true;
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes("%")) return null;
  const dottedTail = normalized.match(/(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedTail) {
    const octets = dottedTail[2].split(".").map(Number);
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    normalized = normalized.slice(0, -dottedTail[2].length) + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

async function assertPublicDns(hostname: string, purpose: string): Promise<void> {
  let lookupSucceeded = false;
  for (const resolver of PUBLIC_DNS_JSON_RESOLVERS) {
    try {
      const queryResults = await Promise.allSettled(
        (["A", "AAAA"] as const).map(async (type) => {
          const url = new URL(resolver);
          url.searchParams.set("name", hostname);
          url.searchParams.set("type", type);
          const response = await fetch(url, {
            headers: { accept: "application/dns-json" },
            redirect: "manual",
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
          const result = (await response.json()) as {
            Status?: number;
            Answer?: unknown;
          };
          if (!result || typeof result !== "object") throw new Error("DNS lookup returned invalid JSON");
          if (typeof result.Status === "number" && ![0, 3].includes(result.Status)) {
            throw new Error(`DNS lookup returned status ${result.Status}`);
          }
          if (result.Answer !== undefined && !Array.isArray(result.Answer)) {
            throw new Error("DNS lookup returned invalid answers");
          }
          const answers = (result.Answer ?? []).filter((answer): answer is { type: number; data: string } => (
            Boolean(answer)
            && typeof answer === "object"
            && typeof (answer as { type?: unknown }).type === "number"
            && typeof (answer as { data?: unknown }).data === "string"
          ));
          return { Answer: answers };
        }),
      );
      const responses = queryResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const addresses = responses.flatMap((result) => result.Answer
        .filter((answer) => answer.type === 1 || answer.type === 28)
        .map((answer) => answer.data));
      if (addresses.some((address) => !isPublicIp(address))) {
        throw new ApiError(400, "UNSAFE_PUBLIC_URL", `${purpose}解析到了私有、回环或保留网络。 `);
      }
      if (queryResults.some((result) => result.status === "rejected")) continue;
      lookupSucceeded = true;
      if (addresses.length > 0) return;
    } catch (reason) {
      if (reason instanceof ApiError) throw reason;
    }
  }

  throw new ApiError(
    400,
    "PUBLIC_URL_DNS_FAILED",
    lookupSucceeded
      ? `${purpose}没有可用的公网 DNS 记录。 `
      : `无法验证${purpose}的公网 DNS，请检查地址后重试。 `,
  );
}
