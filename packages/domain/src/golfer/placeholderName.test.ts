import { describe, expect, it } from "vitest";
import { placeholderName } from "./placeholderName.js";

// A deterministic, boring display name derived from a Cognito sub (accounts-only identity
// spec §2): "Golfer NNNN", a 4-digit FNV-1a hash of the sub mod 10000. Deterministic by
// design — the concurrent-first-request mint race (two requests both minting the caller's
// golfer) cannot generate two different names for the same sub, so the loser re-reading the
// winner's golfer never sees a name mismatch.
describe("placeholderName", () => {
  it("always renders exactly 'Golfer' + a 4-digit number", () => {
    for (const sub of ["", "a", "sub-abc-123", "cognito|deadbeef", "11111111-2222-3333-4444-555555555555"]) {
      expect(placeholderName(sub)).toMatch(/^Golfer \d{4}$/);
    }
  });

  it("is deterministic: the same sub always yields the same name", () => {
    expect(placeholderName("sub-abc-123")).toBe(placeholderName("sub-abc-123"));
    expect(placeholderName("11111111-2222-3333-4444-555555555555")).toBe(placeholderName("11111111-2222-3333-4444-555555555555"));
  });

  // Pinned against an independent FNV-1a 32-bit computation (offset basis 0x811c9dc5, prime
  // 0x01000193, XOR-then-multiply per byte, unsigned mod 10000, zero-padded) — a regression
  // to a different hash or a byte-order slip fails here, not silently.
  it("matches the hand-computed FNV-1a hash for known subs", () => {
    expect(placeholderName("sub-abc-123")).toBe("Golfer 3265");
    expect(placeholderName("11111111-2222-3333-4444-555555555555")).toBe("Golfer 1689");
  });

  it("is distinct-ish across many subs (a hash, not a constant)", () => {
    const names = new Set(Array.from({ length: 1000 }, (_, i) => placeholderName(`user-${i}`)));
    // Birthday collisions in a 10000-name space are expected; well over 90% distinct proves
    // it's genuinely spreading, not collapsing subs onto one name.
    expect(names.size).toBeGreaterThan(900);
  });
});
