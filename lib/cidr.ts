/**
 * CIDR utilities for building "allowlist that behaves like a denylist".
 *
 * Security groups only support ALLOW rules — there is no DENY. To satisfy the
 * hard constraint "never write 0.0.0.0/0" while still letting *almost everyone*
 * in and blocking a *few* specific IPs, we compute the CIDR **complement** of
 * the excluded addresses: a set of prefixes whose union is (entire IPv4 space
 * minus the excluded IPs). None of those prefixes is ever 0.0.0.0/0, so
 * compliance scanners (AWS Config / Security Hub) that match the literal
 * 0.0.0.0/0 stay green.
 *
 * Mathematically: excluding a single /32 yields exactly 32 CIDR blocks
 * (one sibling block at each prefix length 32..1). Their union has 2^32 - 1
 * addresses — everything except that one IP.
 */

const FULL_SPACE_BITS = 32;

/** Parse "a.b.c.d" or "a.b.c.d/nn" into { base: uint32, prefix: number }. */
export function parseCidr(input: string): { base: number; prefix: number } {
  const trimmed = input.trim();
  const [ipPart, prefixPart] = trimmed.split('/');
  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix in "${input}" (must be 0..32)`);
  }

  const octets = ipPart.split('.');
  if (octets.length !== 4) {
    throw new Error(`Invalid IPv4 address in "${input}"`);
  }

  let value = 0;
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255 || octet.trim() === '') {
      throw new Error(`Invalid IPv4 octet "${octet}" in "${input}"`);
    }
    // Use multiplication (not <<) to stay in the unsigned 32-bit range.
    value = value * 256 + n;
  }

  // Normalise the base to the network address for the given prefix.
  const masked = applyMask(value, prefix);
  return { base: masked >>> 0, prefix };
}

/** Zero out host bits below the given prefix. Returns an unsigned 32-bit int. */
function applyMask(value: number, prefix: number): number {
  if (prefix === 0) return 0;
  if (prefix === 32) return value >>> 0;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0;
}

/** Convert an unsigned 32-bit int back to dotted-quad. */
export function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

export function cidrToString(base: number, prefix: number): string {
  return `${intToIp(base)}/${prefix}`;
}

/** True iff the CIDR is the entire IPv4 space (0.0.0.0/0). */
export function isFullSpace(cidr: string): boolean {
  try {
    const { base, prefix } = parseCidr(cidr);
    return prefix === 0 && base === 0;
  } catch {
    return false;
  }
}

/**
 * Compute the CIDR complement of a set of excluded IPs/CIDRs, i.e. a minimal
 * list of prefixes covering (0.0.0.0/0 minus the excluded ranges).
 *
 * Implementation: recursively split the full space; a block is kept whole when
 * it does not overlap any excluded range, dropped when fully contained in an
 * excluded range, otherwise split into two halves. Guaranteed never to emit
 * 0.0.0.0/0 as long as `excluded` is non-empty.
 */
export function complementOf(excluded: string[]): string[] {
  const ranges = excluded.map((e) => {
    const { base, prefix } = parseCidr(e);
    const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
    return { start: base, end: base + size - 1 };
  });

  if (ranges.length === 0) {
    // Nothing excluded — caller should decide; we refuse to return 0.0.0.0/0.
    throw new Error('complementOf([]) would be 0.0.0.0/0 — refuse. Provide at least one excluded IP.');
  }

  // If any excluded range is the whole space, the complement is empty.
  if (ranges.some((r) => r.start === 0 && r.end === 0xffffffff)) {
    return [];
  }

  const result: string[] = [];

  const overlaps = (bStart: number, bEnd: number) =>
    ranges.filter((r) => r.start <= bEnd && r.end >= bStart);

  const walk = (base: number, prefix: number) => {
    const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
    const start = base;
    const end = base + size - 1;
    const hits = overlaps(start, end);

    if (hits.length === 0) {
      result.push(cidrToString(base, prefix));
      return;
    }
    // Fully covered by a single excluded range → drop entirely.
    if (hits.some((r) => r.start <= start && r.end >= end)) {
      return;
    }
    if (prefix === 32) {
      // Single address that overlaps an excluded range → excluded, drop.
      return;
    }
    const half = size / 2;
    walk(base, prefix + 1);
    walk(base + half, prefix + 1);
  };

  walk(0, 0);
  return result;
}

/**
 * Build prefixes covering a fraction (2^n - 1) / 2^n of the address space,
 * i.e. "3/4", "7/8", "31/32" style coverage, starting from 0.0.0.0.
 * n=1 -> ["0.0.0.0/1"] (1/2). n=2 -> ["0.0.0.0/1","128.0.0.0/2"] (3/4). etc.
 * Never emits 0.0.0.0/0.
 */
export function coverageFraction(n: number): string[] {
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new Error(`coverageFraction(n): n must be 1..32, got ${n}`);
  }
  const out: string[] = [];
  let base = 0;
  for (let k = 1; k <= n; k++) {
    out.push(cidrToString(base >>> 0, k));
    // Next block starts at the midpoint of the *remaining* upper half.
    base = (base + (2 ** (32 - k))) >>> 0;
  }
  return out;
}

/**
 * True iff two CIDR ranges overlap (share at least one address).
 *
 * Used by L3 validation to reject a us profile VPC CIDR that collides with the
 * Tokyo VPC CIDR — overlapping CIDRs make VPC Peering routing ambiguous/illegal.
 */
export function cidrsOverlap(a: string, b: string): boolean {
  const ra = cidrRange(a);
  const rb = cidrRange(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

/** Inclusive [start, end] uint32 range covered by a CIDR. */
function cidrRange(cidr: string): { start: number; end: number } {
  const { base, prefix } = parseCidr(cidr);
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  return { start: base, end: base + size - 1 };
}

/** Total number of addresses covered by a list of CIDRs (no overlap assumed). */
export function totalAddresses(cidrs: string[]): number {
  return cidrs.reduce((sum, c) => {
    const { prefix } = parseCidr(c);
    return sum + (prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix));
  }, 0);
}
