import type { NavigateFunction } from "react-router";
import type { RoundId } from "@swng/domain";
import { mintParticipantToken } from "../api";
import { credentialStore } from "../identity";

export interface OpenLiveRoundDeps {
  readonly withAuth: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  // The name written into the freshly-minted credential — the caller's OWN account golfer name
  // (HomePage's `golfer!.name`; RoundRecordPage's own equivalent), never a form value.
  readonly golferName: string;
  readonly navigate: NavigateFunction;
}

// Architecture-realignment Task 14's re-mint, extracted (navigation spec §7 step 2): a device
// that holds no local scoring credential for a round its identity shows/owns mints one fresh —
// via POST /rounds/{roundId}/token, the SAME wire shape a real join's own token mint returns —
// stores it exactly as a join would (credentialStore.save), then navigates to the live scoring
// session. The re-mint response carries the round's join code (spec 2026-07-20 §2 — token
// implies code), so a device entering from home shows the Join code panel like any other; the
// former papercut-19 blank panel is unrepresentable. A byte-identical move of HomePage's own
// click-handler body, so BOTH callers — HomePage's "Your rounds" list and RoundRecordPage's own
// live-check branch (§7 step 2) — share ONE re-mint implementation rather than two. Error
// handling (ApiError branching into human copy) stays at each call site — that's caller-specific
// UI, not part of the re-mint itself.
export async function openLiveRound(id: RoundId, deps: OpenLiveRoundDeps): Promise<void> {
  const response = await deps.withAuth((token) => mintParticipantToken(token, id));
  credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: deps.golferName, joinCode: response.joinCode });
  deps.navigate(`/round/${response.roundId}`);
}
