import { BlockList, isIP } from "node:net";

/**
 * SSRF guard. Only public http(s) URLs on default ports are fetched, and every address a hostname
 * resolves to must be public. Checked on every hop, after DNS resolution.
 */

export class BlockedUrlError extends Error {
  override name = "BlockedUrlError";
}

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments (incl. 192.0.0.192 Oracle metadata)
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["64:ff9b::", 96], // NAT64 (embeds IPv4)
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo (embeds IPv4)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds IPv4)
  ["fc00::", 7], // unique local, incl. fd00:ec2::254 (AWS metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPPED_V4_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** True when an IP address must never be contacted. Unparseable input is treated as blocked. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return true;
  const dotted = MAPPED_V4.exec(ip);
  if (dotted) return isBlockedAddress(dotted[1]!);
  const hex = MAPPED_V4_HEX.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (ip.startsWith("::ffff:")) return true;
  return blocked.check(ip, "ipv6");
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/**
 * Checks everything that can be checked before DNS: scheme, credentials, port, and hostname.
 * Returns the parsed URL. IP-literal hosts are checked here too.
 */
export function checkUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${String(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`scheme ${url.protocol} is not allowed (http and https only)`);
  }
  if (url.username || url.password) throw new BlockedUrlError("URLs with credentials are not allowed");
  if (url.port !== "") throw new BlockedUrlError(`non-default port ${url.port} is not allowed`);

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isBlockedAddress(bare)) throw new BlockedUrlError(`address ${bare} is private or reserved`);
    return url;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`host ${host} is local or internal`);
  }
  if (!host.includes(".")) throw new BlockedUrlError(`host ${host} is not a public domain name`);
  return url;
}
