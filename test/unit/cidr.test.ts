import {
  complementOf,
  coverageFraction,
  parseCidr,
  isFullSpace,
  cidrToString,
  intToIp,
  totalAddresses,
} from '../../lib/cidr';

const FULL = 2 ** 32; // 4294967296

describe('complementOf', () => {
  it('excluding a single /32 yields exactly 32 CIDR blocks', () => {
    const out = complementOf(['1.2.3.4']);
    expect(out).toHaveLength(32);
  });

  it('single /32 complement covers 2^32 - 1 addresses (everything but that IP)', () => {
    const out = complementOf(['1.2.3.4']);
    expect(totalAddresses(out)).toBe(FULL - 1);
    expect(totalAddresses(out)).toBe(4294967295);
  });

  it('single /32 complement never contains 0.0.0.0/0', () => {
    const out = complementOf(['1.2.3.4']);
    for (const c of out) {
      expect(isFullSpace(c)).toBe(false);
    }
    // The one excluded address must not be re-included by any block.
    const excludedInt = 0x01020304;
    for (const c of out) {
      const { base, prefix } = parseCidr(c);
      const size = prefix === 0 ? FULL : 2 ** (32 - prefix);
      const start = base;
      const end = base + size - 1;
      const contains = excludedInt >= start && excludedInt <= end;
      expect(contains).toBe(false);
    }
  });

  it('complement of multiple IPs excludes exactly those IPs (2^32 - 2)', () => {
    const out = complementOf(['1.2.3.4', '250.250.250.250']);
    // Two distinct /32s in disjoint halves; total is full space minus 2.
    expect(totalAddresses(out)).toBe(FULL - 2);
    expect(totalAddresses(out)).toBe(4294967294);
    for (const c of out) {
      expect(isFullSpace(c)).toBe(false);
    }
  });

  it('complement of a /24 covers 2^32 - 256', () => {
    const out = complementOf(['10.0.0.0/24']);
    expect(totalAddresses(out)).toBe(FULL - 256);
    expect(totalAddresses(out)).toBe(4294967040);
    for (const c of out) {
      expect(isFullSpace(c)).toBe(false);
    }
    // Excluding a single /24 (aligned) yields exactly 24 sibling blocks
    // (one at each prefix length 24..1).
    expect(out).toHaveLength(24);
  });

  it('complementOf([]) throws', () => {
    expect(() => complementOf([])).toThrow();
  });

  it("complementOf(['0.0.0.0/0']) returns []", () => {
    expect(complementOf(['0.0.0.0/0'])).toEqual([]);
  });

  it('complement blocks are contiguous and cover everything but the excluded IP', () => {
    const out = complementOf(['1.2.3.4']);
    const ranges = out
      .map((c) => {
        const { base, prefix } = parseCidr(c);
        const size = prefix === 0 ? FULL : 2 ** (32 - prefix);
        return { start: base, end: base + size - 1 };
      })
      .sort((a, b) => a.start - b.start);
    // Union must be [0, 0x01020303] ∪ [0x01020305, 0xffffffff].
    let covered = 0;
    for (const r of ranges) {
      covered += r.end - r.start + 1;
    }
    expect(covered).toBe(FULL - 1);
    // No block overlaps the excluded address.
    const excluded = 0x01020304;
    for (const r of ranges) {
      expect(excluded >= r.start && excluded <= r.end).toBe(false);
    }
  });
});

describe('coverageFraction', () => {
  it('n=2 covers 3/4 of the address space', () => {
    const out = coverageFraction(2);
    expect(totalAddresses(out)).toBe((FULL * 3) / 4);
    expect(totalAddresses(out)).toBe(3221225472);
    expect(out).toEqual(['0.0.0.0/1', '128.0.0.0/2']);
  });

  it('n=3 covers 7/8 of the address space', () => {
    const out = coverageFraction(3);
    expect(totalAddresses(out)).toBe((FULL * 7) / 8);
    expect(totalAddresses(out)).toBe(3758096384);
    expect(out).toEqual(['0.0.0.0/1', '128.0.0.0/2', '192.0.0.0/3']);
  });

  it('n=5 covers 31/32 of the address space', () => {
    const out = coverageFraction(5);
    expect(totalAddresses(out)).toBe((FULL * 31) / 32);
    expect(totalAddresses(out)).toBe(4160749568);
    expect(out).toHaveLength(5);
  });

  it('never emits 0.0.0.0/0 for any valid n', () => {
    for (let n = 1; n <= 32; n++) {
      const out = coverageFraction(n);
      for (const c of out) {
        expect(isFullSpace(c)).toBe(false);
      }
    }
  });

  it('coverageFraction(n) covers exactly (2^n - 1)/2^n of the space', () => {
    for (let n = 1; n <= 32; n++) {
      const out = coverageFraction(n);
      const expected = FULL - 2 ** (32 - n);
      expect(totalAddresses(out)).toBe(expected);
      expect(out).toHaveLength(n);
    }
  });

  it('coverageFraction(0) throws', () => {
    expect(() => coverageFraction(0)).toThrow();
  });

  it('coverageFraction(33) throws', () => {
    expect(() => coverageFraction(33)).toThrow();
  });

  it('rejects non-integer and negative n', () => {
    expect(() => coverageFraction(1.5)).toThrow();
    expect(() => coverageFraction(-1)).toThrow();
  });
});

describe('parseCidr', () => {
  it('normalizes host bits to the network address', () => {
    // 1.2.3.4/24 -> base 1.2.3.0
    const { base, prefix } = parseCidr('1.2.3.4/24');
    expect(prefix).toBe(24);
    expect(intToIp(base)).toBe('1.2.3.0');
  });

  it('normalizes host bits for /16 and /8', () => {
    expect(intToIp(parseCidr('10.20.30.40/16').base)).toBe('10.20.0.0');
    expect(intToIp(parseCidr('10.20.30.40/8').base)).toBe('10.0.0.0');
  });

  it('defaults to /32 when no prefix present', () => {
    const { base, prefix } = parseCidr('192.168.1.1');
    expect(prefix).toBe(32);
    expect(intToIp(base)).toBe('192.168.1.1');
  });

  it('parses the full space form', () => {
    const { base, prefix } = parseCidr('0.0.0.0/0');
    expect(base).toBe(0);
    expect(prefix).toBe(0);
  });

  it('parses the top address 255.255.255.255 as unsigned', () => {
    const { base } = parseCidr('255.255.255.255');
    expect(base).toBe(0xffffffff);
    expect(base).toBe(4294967295);
  });

  it('rejects octet > 255', () => {
    expect(() => parseCidr('256.0.0.1')).toThrow();
  });

  it('rejects negative octet', () => {
    expect(() => parseCidr('-1.0.0.1')).toThrow();
  });

  it('rejects too few octets', () => {
    expect(() => parseCidr('1.2.3')).toThrow();
  });

  it('rejects too many octets', () => {
    expect(() => parseCidr('1.2.3.4.5')).toThrow();
  });

  it('rejects empty octet', () => {
    expect(() => parseCidr('1..3.4')).toThrow();
  });

  it('rejects non-numeric octet', () => {
    expect(() => parseCidr('a.b.c.d')).toThrow();
  });

  it('rejects prefix > 32', () => {
    expect(() => parseCidr('1.2.3.4/33')).toThrow();
  });

  it('rejects negative prefix', () => {
    expect(() => parseCidr('1.2.3.4/-1')).toThrow();
  });

  it('rejects non-integer prefix', () => {
    expect(() => parseCidr('1.2.3.4/24.5')).toThrow();
  });
});

describe('intToIp / cidrToString round-trip', () => {
  it('round-trips a range of addresses through parseCidr -> intToIp', () => {
    const samples = ['0.0.0.0', '1.2.3.4', '128.0.0.1', '192.168.100.200', '255.255.255.255'];
    for (const ip of samples) {
      const { base } = parseCidr(ip);
      expect(intToIp(base)).toBe(ip);
    }
  });

  it('cidrToString composes intToIp and prefix', () => {
    expect(cidrToString(0, 0)).toBe('0.0.0.0/0');
    expect(cidrToString(0x01020304, 32)).toBe('1.2.3.4/32');
    expect(cidrToString(0xc0a80000, 16)).toBe('192.168.0.0/16');
  });

  it('cidrToString round-trips through parseCidr for network-aligned CIDRs', () => {
    const cidrs = ['0.0.0.0/1', '128.0.0.0/2', '10.0.0.0/24', '1.2.3.4/32'];
    for (const c of cidrs) {
      const { base, prefix } = parseCidr(c);
      expect(cidrToString(base, prefix)).toBe(c);
    }
  });

  it('intToIp treats input as unsigned 32-bit', () => {
    // -1 >>> 0 === 0xffffffff
    expect(intToIp(-1)).toBe('255.255.255.255');
    expect(intToIp(0)).toBe('0.0.0.0');
  });
});

describe('isFullSpace', () => {
  it('is true only for the 0.0.0.0/0 form', () => {
    expect(isFullSpace('0.0.0.0/0')).toBe(true);
  });

  it('is true for other /0 forms because host bits normalize to 0', () => {
    // Any address with /0 masks down to 0.0.0.0/0.
    expect(isFullSpace('1.2.3.4/0')).toBe(true);
    expect(isFullSpace('255.255.255.255/0')).toBe(true);
  });

  it('is false for non-/0 CIDRs', () => {
    expect(isFullSpace('0.0.0.0/1')).toBe(false);
    expect(isFullSpace('0.0.0.0/32')).toBe(false);
    expect(isFullSpace('0.0.0.0')).toBe(false); // defaults to /32
    expect(isFullSpace('10.0.0.0/8')).toBe(false);
  });

  it('is false for invalid input rather than throwing', () => {
    expect(isFullSpace('not-an-ip')).toBe(false);
    expect(isFullSpace('999.0.0.0/0')).toBe(false);
    expect(isFullSpace('0.0.0.0/33')).toBe(false);
  });
});

describe('totalAddresses', () => {
  it('sums address counts across CIDRs', () => {
    expect(totalAddresses(['0.0.0.0/32'])).toBe(1);
    expect(totalAddresses(['10.0.0.0/24'])).toBe(256);
    expect(totalAddresses(['0.0.0.0/0'])).toBe(FULL);
    expect(totalAddresses(['0.0.0.0/1', '128.0.0.0/1'])).toBe(FULL);
    expect(totalAddresses([])).toBe(0);
  });
});
