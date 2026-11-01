import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Private-address (SSRF) policy for every outbound connection the Integration Hub makes.
 * Checked when an endpoint is saved and again when a delivery connects (for HTTP the
 * connection itself is pinned to the checked addresses, so DNS rebinding cannot slip
 * through).
 */

const v4ToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const inV4 = (ip: string, [base, bits]: [string, number]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return parts.length === 8 && parts.every((x) => Number.isFinite(x)) ? parts : null;
}

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return V4_BLOCKED.some((r) => inV4(ip, r));
  if (fam !== 6) return true; // not an IP: treat as unsafe
  const w = expandV6(ip);
  if (!w) return true;
  const embedded = () => `${w[6]! >> 8}.${w[6]! & 0xff}.${w[7]! >> 8}.${w[7]! & 0xff}`;
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPrivateAddress(embedded()); // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(embedded()); // NAT64
  if ((w[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w[0]! & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  return false;
}

export class BlockedAddressError extends Error {
  constructor(host: string, address?: string) {
    super(`${host}${address && address !== host ? ` (${address})` : ''} is a private or reserved address; deliveries to internal networks are not allowed`);
    this.name = 'BlockedAddressError';
  }
}

export interface SsrfPolicy {
  /** hosts exempt from the check (dev/test only) */
  allow: Set<string>;
}

export const policyFrom = (allowList: string, production: boolean): SsrfPolicy => ({
  allow: new Set(production ? [] : allowList.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
});

const resolveAll = (host: string) =>
  new Promise<LookupAddress[]>((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/** Resolves a host and rejects it if any address is private. Returns the checked addresses. */
export async function checkHost(host: string, policy: SsrfPolicy): Promise<LookupAddress[]> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (policy.allow.has(h)) return resolveAll(h);
  if (isIP(h)) {
    if (isPrivateAddress(h)) throw new BlockedAddressError(host);
    return [{ address: h, family: isIP(h) }];
  }
  const addrs = await resolveAll(h);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad || !addrs.length) throw new BlockedAddressError(host, bad?.address);
  return addrs;
}

/** `lookup` for net/tls/undici connections: only ever hands out checked addresses. */
export function safeLookup(policy: SsrfPolicy) {
  return (hostname: string, options: any, callback: (...args: any[]) => void) => {
    checkHost(hostname, policy).then(
      (addrs) => {
        if (options?.all) callback(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err) => callback(err),
    );
  };
}
