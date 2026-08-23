import { ApiError } from "./api";

const FORBIDDEN_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);

export async function validateModelEndpoint(value: string): Promise<string> {
  return validatePublicHttpsUrl(value, { allowQuery: false, purpose: "模型地址" });
}

export async function validatePublicHttpsUrl(
  value: string,
  options: { allowQuery?: boolean; purpose?: string } = {},
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
  } else {
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
  const addresses: string[] = [];
  try {
    const responses = await Promise.all(
      (["A", "AAAA"] as const).map(async (type) => {
        const url = new URL("https://dns.alidns.com/resolve");
        url.searchParams.set("name", hostname);
        url.searchParams.set("type", type);
        const response = await fetch(url, {
          headers: { accept: "application/dns-json" },
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
        return (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
      }),
    );
    for (const result of responses) {
      for (const answer of result.Answer ?? []) {
        if (answer.type === 1 || answer.type === 28) addresses.push(answer.data);
      }
    }
  } catch {
    throw new ApiError(400, "PUBLIC_URL_DNS_FAILED", `无法验证${purpose}的公网 DNS，请检查地址后重试。 `);
  }

  if (addresses.length === 0) {
    throw new ApiError(400, "PUBLIC_URL_DNS_FAILED", `${purpose}没有可用的公网 DNS 记录。 `);
  }
  if (addresses.some((address) => !isPublicIp(address))) {
    throw new ApiError(400, "UNSAFE_PUBLIC_URL", `${purpose}解析到了私有、回环或保留网络。 `);
  }
}
