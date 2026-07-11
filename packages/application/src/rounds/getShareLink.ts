import type { ShareLinkResponse } from "@swng/contracts";
import type { ParticipantClaims, TokenIssuer } from "../ports/tokenIssuer.js";

// POST /rounds/{roundId}/share (M9 Task 3): mints this round's own immortal spectator link.
// No journal/broadcast/store dependency at all — the caller already proved participation via
// their OWN (participant-scoped) token, so this is a pure function of the token issuer: issue
// a spectator token for the SAME roundId and wrap it into a /watch url. Deterministic by
// construction, not by any dedup logic here — hmacTokenIssuer.ts's own contract is "the same
// payload signs to the byte-identical token," and a spectator payload is JUST the roundId (no
// exp, no randomness), so two calls for the same round always mint the identical token.
//
// The url is a PATH+FRAGMENT, not an absolute URL: this layer has no web-origin config seam
// (no env var carries one — see compositionRoot.ts's env list), and inventing one just for
// this one string would be a config change with no other consumer. The web app already knows
// its own origin at the point it renders this link (ShareButton.tsx prefixes
// window.location.origin) — cleaner and more testable than threading a deploy-time origin
// through Lambda env for a value the browser already has for free.
export const getShareLink =
  (deps: { tokens: TokenIssuer }) =>
  async (claims: ParticipantClaims): Promise<ShareLinkResponse> => {
    const token = deps.tokens.issue({ scope: "spectator", roundId: claims.roundId });
    return { url: `/watch/${claims.roundId}#${token}` };
  };
