// Moved to @swng/domain (2026-08-27, MCP arc Phase 1): compareHlc (the rule that CONSUMES an
// hlc) already lived in @swng/domain — a generator and its comparator living in different
// packages is a defect the moment a second client exists, because that client has to write its
// own copy of the CRDT conflict key. Re-exported here because session.ts and the rest of this
// package reach on-device compute through @swng/client, not through @swng/domain.
export { createHlcSource } from "@swng/domain";
export type { HlcSource } from "@swng/domain";
