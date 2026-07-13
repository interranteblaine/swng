// A deterministic, boring display name derived from a Cognito sub (accounts-only identity
// spec §2): "Golfer NNNN", where NNNN is an FNV-1a 32-bit hash of the sub, mod 10000,
// zero-padded to 4 digits. Deterministic BY DESIGN — the concurrent-first-request mint race
// (two authenticated requests both minting the caller's golfer at once) cannot generate two
// different names for the same sub, so the race's loser re-reading the winner's golfer never
// sees a name mismatch. It is the invariant's backstop, never the UX: the join funnel asks
// "What should the card call you?" at the highest-motivation moment; someone who deep-links
// past that prompt renders as this placeholder until they set a real name on their profile.
//
// FNV-1a 32-bit: offset basis 0x811c9dc5, prime 0x01000193, per code unit XOR-then-multiply.
// Math.imul does the 32-bit-wrapping multiply; `>>> 0` reads the result back as unsigned before
// the modulo. Cognito subs are ASCII (UUIDs), so charCodeAt maps 1:1 to the hashed bytes.
export const placeholderName = (sub: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sub.length; i += 1) {
    hash ^= sub.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const n = (hash >>> 0) % 10000;
  return `Golfer ${String(n).padStart(4, "0")}`;
};
