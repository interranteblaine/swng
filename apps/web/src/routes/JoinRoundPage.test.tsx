import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as CreateRoundPage.test.tsx — JoinRoundPage
// calls joinRound, peekRound, updateMe (the funnel's name prompt) and getMe (via the
// AuthProvider). peekRound defaults to a rejection so a test that never explicitly stubs it
// exercises the free-text tee fallback.
vi.mock("../api", () => ({
  joinRound: vi.fn(),
  peekRound: vi.fn().mockRejectedValue(new Error("not stubbed")),
  getMe: vi.fn(),
  updateMe: vi.fn(),
  // The suggested-course-handicap fetch (unrated-courses T5b) — defaulted to an empty record in
  // beforeEach; the pre-existing cases (no declared, no metrics) show no suggestion.
  getMyRecord: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
      message?: string,
    ) {
      super(message ?? code);
      this.name = "ApiError";
    }
  },
}));

import { getMe, getMyRecord, joinRound, peekRound, updateMe } from "../api";
import { JoinRoundPage } from "./JoinRoundPage";
import { courseHandicapFromRatingSlopePar } from "@swng/domain";

const mockedJoinRound = vi.mocked(joinRound);
const mockedPeekRound = vi.mocked(peekRound);
const mockedGetMe = vi.mocked(getMe);
const mockedUpdateMe = vi.mocked(updateMe);
const mockedGetMyRecord = vi.mocked(getMyRecord);

// GetMyRecordResponse.metrics.typicalEighteen/indexHistory are required (metrics-projection-grows
// spec) — these tests only exercise the whsIndex/swngIndex suggestion, so every fixture here
// spreads a zeroed/empty pair.
const zeroMetrics = { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, indexHistory: [] } as const;

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedJoinRound.mockReset();
  mockedPeekRound.mockReset();
  mockedPeekRound.mockRejectedValue(new Error("not stubbed"));
  mockedGetMe.mockReset();
  mockedUpdateMe.mockReset();
  mockedGetMyRecord.mockReset();
  mockedGetMyRecord.mockResolvedValue({ metrics: { ...zeroMetrics }, history: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderJoin = (initialEntry = "/join") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/join" element={<JoinRoundPage />} />
          <Route path="/round/:roundId" element={<div>round view</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = (): string => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

// The wall (accounts-only identity spec §3): joining is self-join only. Signed out, the page is
// a sign-in funnel, not a form — and it preserves the join code across the Hosted-UI round trip
// so a tap on a share link lands the new account back on the round it was invited to.
describe("JoinRoundPage — the funnel (signed out)", () => {
  it("shows a sign-in CTA and NO join form — no name/tee/handicap fields, no anonymous join", () => {
    renderJoin();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/^tee$/i)).toBeNull();
    expect(screen.queryByLabelText(/strokes you get here/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
  });

  it("preserves the typed join code across the round trip: clicking Sign in stashes returnTo with the code", () => {
    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // AuthCallbackPage consumes this on return, landing the freshly-signed-in golfer back on the
    // join page with the code intact.
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/join?code=ABC123");
  });

  it("seeds the code from the URL (a join link) so the round trip's return lands ready to join", () => {
    renderJoin("/join?code=xyz789");

    expect((screen.getByLabelText(/code/i) as HTMLInputElement).value).toBe("XYZ789");
    // And the CTA preserves that same code without the golfer retyping it.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/join?code=XYZ789");
  });
});

// Signed in, the funnel resolves identity then either prompts for a name (a placeholder golfer,
// spec §2 — the highest-motivation moment) or drops straight into the join form.
describe("JoinRoundPage — the name prompt (signed in, placeholder golfer)", () => {
  it("a placeholder golfer sees 'What should the card call you?' — not the join form yet", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } });

    renderJoin();

    await screen.findByLabelText(/what should the card call you/i);
    // The join form is gated behind the name prompt — no tee/handicap/Join button until named.
    expect(screen.queryByLabelText(/^tee$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
    expect(screen.queryByText(/playing as/i)).toBeNull();
  });

  it("saving the name PUTs /me and proceeds straight into the join form in the same visit (no extra hop)", async () => {
    signIn();
    // First GET /me finds the placeholder; the refetch after PUT /me returns the real name.
    mockedGetMe
      .mockResolvedValueOnce({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } })
      .mockResolvedValueOnce({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g1"), name: "Bo Real" } });
    mockedUpdateMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g1"), name: "Bo Real" } });

    renderJoin();

    const nameField = await screen.findByLabelText(/what should the card call you/i);
    fireEvent.change(nameField, { target: { value: "Bo Real" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(mockedUpdateMe).toHaveBeenCalledWith(expect.any(String), { name: "Bo Real" }));
    // Same visit: the join form now renders — no navigation happened.
    await screen.findByText(/playing as/i);
    expect(screen.getByText("Bo Real")).toBeTruthy();
    expect(screen.getByRole("button", { name: /join round/i })).toBeTruthy();
  });
});

// A real-named golfer never sees the prompt (spec §2, controller resolution 3) and joins as
// themselves — the request carries the account's own name + golferId, never a typed input.
describe("JoinRoundPage — join as yourself (signed in, real name)", () => {
  it("goes straight to the join form as 'Playing as <name>' — the name INPUT is gone (structural pin)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo G" } });

    renderJoin();

    await screen.findByText(/playing as/i);
    expect(screen.getByText("Bo G")).toBeTruthy();
    expect(screen.queryByText(/what should the card call you/i)).toBeNull();
    // The proof-of-negative the milestone turns on: no free-text name field anywhere in the join
    // form — the name is the account's, sourced from GET /me, never from an input.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.getByRole("link", { name: /change/i }).getAttribute("href")).toBe("/profile");
  });

  it("uppercases the code and joins as-self: code + tee/handicap + the account's Bearer (seat resolved server-side, never a typed name)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo G" } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-self"), token: "tok-self", golferId: golferId("bo-g"), joinCode: "SELF01" });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "self01" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/strokes you get here/i), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedJoinRound.mock.calls[0]!;
    // Accounts-only identity (spec §3): join is as-self — the request carries only code + tee +
    // courseHandicap; the seat (name + golferId) is resolved server-side from the Bearer.
    expect(body).toEqual({ code: "SELF01", tee: "white", courseHandicap: 6 });
    expect(token).toBe(idToken);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-self"))).toEqual({ token: "tok-self", golferId: golferId("bo-g"), name: "Bo G", joinCode: "SELF01" });
  });

  // Real timers here (not fake): the join form only renders once the AuthProvider's async GET
  // /me resolves, and waitFor polls comfortably past the 250ms debounce — interleaving fake
  // timers with that async identity settle is the fiddle this avoids.
  it("once the code is 6 chars, a peek swaps the free-text tee for a picker of the round's tee names", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo G" } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [
        { name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 },
        { name: "blue", par: 72, holes: 18, rating: 74.0, slope: 140 },
      ],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i); // GET /me settled, join form rendered

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await waitFor(() => expect(mockedPeekRound).toHaveBeenCalledWith("ABC123"));
    const select = (await screen.findByLabelText(/^tee$/i)) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);

    // The join-link framing carries the round's full designation (course + date), not a bare
    // course name (spec §5) — computed via roundLabel from the peek's own createdAt, local zone,
    // the same way HomePage/WatchPage's own label tests do.
    expect(screen.getByText(`Joining ${roundLabel({ courseName: "Fixture Links 18", createdAt: 1_700_000_000_000 })}`)).toBeTruthy();
  });

  it("a failed peek falls back to free text with a note — joining is never blocked by it", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("dee-g"), name: "Dee" } });
    mockedPeekRound.mockRejectedValue(new Error("no round with that code"));
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-3"), token: "tok-3", golferId: golferId("dee-g"), joinCode: "ZZZ999" });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "zzz999" } });
    await screen.findByText(/could not look up/i); // the peek rejected; free-text fallback + note

    const teeField = screen.getByLabelText(/^tee$/i);
    expect(teeField.tagName).toBe("INPUT");

    fireEvent.change(teeField, { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/strokes you get here/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound.mock.calls[0]![0]).toEqual({ code: "ZZZ999", tee: "white", courseHandicap: 5 });
  });
});

// "Strokes you get here" (handicap-model legibility spec §4/§7): the index turned into today's
// strokes — seeded once, editable, shown WITH its derivation. The active index defaults to the
// swng index (spec §3): GET /me/record's swngIndex, or the declared override. JoinRoundPage holds
// only the peek tee (name + par + holes + rating/slope, no holes ARRAY), so a rated tee uses
// courseHandicapFromRatingSlopePar and an unrated tee uses the hole-count-correct index estimate —
// round(index) on an 18-hole card, round(index / 2) on a 9-hole one (via the peek's `holes` count).
describe("JoinRoundPage — strokes you get here", () => {
  it("a rated peek tee seeds courseHandicapFromRatingSlopePar, shows the 'from your index' derivation, and stays editable; the picker shows the tee's numbers", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "declared", value: 12.4 } } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    // Wait for the seed to land (proof the peek resolved and swapped in the <select>) before
    // inspecting the picker — the free-text <input> also carries the "Tee" label until then.
    const expected = String(courseHandicapFromRatingSlopePar(12.4, 71.6, 128, 72));
    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe(expected));
    // The derivation is on the screen — the index→strokes wire, not a bare number (spec §4/§7).
    expect(screen.getByText(new RegExp(`^${expected} — from your index \\(12\\.4\\) on this course$`))).toBeTruthy();
    // The jargon label and the old opaque "suggested (WHS)" tag are both gone.
    expect(screen.queryByText(/course handicap/i)).toBeNull();
    expect(screen.queryByText(/suggested \(WHS\)/i)).toBeNull();

    const teeSelect = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect(teeSelect.tagName).toBe("SELECT");
    expect(teeSelect.options[0]!.textContent).toMatch(/rating 71.6, slope 128/); // teeNumbers in the picker

    // Editable: a group can agree on a different number, and it wins over the seed.
    fireEvent.change(screen.getByLabelText(/strokes you get here/i), { target: { value: "5" } });
    expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe("5");
  });

  it("an unrated 18-hole peek tee seeds round(index) with an 18-hole-named derivation; the picker reads 'unrated'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "declared", value: 12.4 } } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Muni",
      teeSets: [{ name: "white", par: 71, holes: 18 }], // no rating/slope
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe("12")); // round(12.4)
    expect(screen.getByText(/your index \(12\.4\), adjusted for 18 holes; unrated course/i)).toBeTruthy();
    expect(screen.queryByText(/estimated — unrated course/i)).toBeNull();

    const teeSelect = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect(teeSelect.options[0]!.textContent).toMatch(/unrated/);
  });

  it("an unrated 9-hole peek tee seeds round(index / 2) with a 9-hole-named derivation (the shipped hole-count bug — a 9-hole round no longer gets an 18-hole estimate)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "declared", value: 12.4 } } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Muni Front 9",
      teeSets: [{ name: "front", par: 36, holes: 9 }], // 9 holes, no rating/slope
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe("6")); // round(12.4 / 2)
    expect(screen.getByText(/your index \(12\.4\), adjusted for 9 holes; unrated course/i)).toBeTruthy();
  });

  // A golfer ON the WHS source (index-source model spec §3/§6): the resolver reads the live WHS
  // metric, and the derivation NAMES it ("from your WHS index"). An unrated 9-hole tee halves it.
  it("a golfer on the WHS source seeds from the live whsIndex metric and names it in the derivation", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "whs" } } });
    mockedGetMyRecord.mockResolvedValue({ metrics: { whsIndex: { value: 10, computedAtMs: 1_000, differentialsUsed: 6 }, ...zeroMetrics }, history: [] });
    mockedPeekRound.mockResolvedValue({
      courseName: "Muni Front 9",
      teeSets: [{ name: "front", par: 36, holes: 9 }], // 9 holes, no rating/slope
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe("5")); // round(10 / 2)
    expect(screen.getByText(/from your WHS index \(10\.0\), adjusted for 9 holes; unrated course/i)).toBeTruthy();
  });

  // A plus-handicap golfer (index below scratch): the note names the + index (formatHandicapIndex)
  // and, because the course handicap comes out negative, leads with the give-back ("You give N")
  // instead of a bare number — both through the domain, no `< 0` decided in the view (spec §3).
  it("a plus-handicap golfer's note reads the + index and, when the course handicap is negative, a 'You give N' lead", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("plus-g"), name: "Plus G", indexSource: { kind: "declared", value: -1.2 } } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    const value = courseHandicapFromRatingSlopePar(-1.2, 71.6, 128, 72);
    expect(value).toBeLessThan(0); // a plus index on this rated tee gives strokes back
    // The seeded strokes field keeps the SIGNED numeric value the engine consumes (waited on, since
    // the seed lands via an effect after the note renders).
    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe(String(value)));
    // The + index in the note, and a give-back lead (never a bare negative number).
    expect(screen.getByText(`You give ${-value} — from your index (+1.2) on this course`)).toBeTruthy();
  });

  it("defaults the active index to GET /me/record's swngIndex when there's no declared override", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("bo-g"), name: "Bo G" } });
    mockedGetMyRecord.mockResolvedValue({ metrics: { swngIndex: { value: 9.0, differentialsUsed: 5 }, ...zeroMetrics }, history: [] });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    await screen.findByLabelText(/^tee$/i);

    const expected = String(courseHandicapFromRatingSlopePar(9.0, 71.6, 128, 72));
    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe(expected));
    expect(screen.getByText(new RegExp(`^${expected} — from your index \\(9\\.0\\) on this course$`))).toBeTruthy();
  });

  it("a typed value is never overwritten by the peek/record seed", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "declared", value: 12.4 } } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-typed"), token: "tok-typed", golferId: golferId("bo-g"), joinCode: "ABC123" });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);

    // Type before the peek arrives — this value must win over any later seed.
    fireEvent.change(screen.getByLabelText(/strokes you get here/i), { target: { value: "3" } });

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    await screen.findByLabelText(/^tee$/i); // peek resolved (its seed would differ from 3)
    await waitFor(() => expect(mockedPeekRound).toHaveBeenCalled());

    expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe("3");

    fireEvent.click(screen.getByRole("button", { name: /join round/i }));
    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound.mock.calls[0]![0].courseHandicap).toBe(3);
  });

  it("a rejected record fetch still seeds from the declared index alone — joining is never blocked", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G", indexSource: { kind: "declared", value: 12.4 } } });
    mockedGetMyRecord.mockRejectedValue(new Error("record unavailable"));
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", par: 72, holes: 18, rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    await screen.findByLabelText(/^tee$/i);

    const expected = String(courseHandicapFromRatingSlopePar(12.4, 71.6, 128, 72));
    await waitFor(() => expect((screen.getByLabelText(/strokes you get here/i) as HTMLInputElement).value).toBe(expected));
    expect(screen.getByRole("button", { name: /join round/i }).hasAttribute("disabled")).toBe(false);
  });
});

// The M8 defect class the milestone must not reintroduce: a submit during the GET /me loading
// window once silently renamed a profile with stale free text. Neither the join form nor the
// name prompt may render until identity resolves.
describe("JoinRoundPage — identity still loading", () => {
  it("no join form, no name prompt, a quiet placeholder instead", async () => {
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // never resolves

    renderJoin();
    await waitFor(() => expect(mockedGetMe).toHaveBeenCalled());

    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/what should the card call you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
    expect(screen.getByRole("status", { name: /loading your profile/i })).toBeTruthy();
  });
});
