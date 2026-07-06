# Punchlist

This document states where the system is today and where it needs to be. It is a problem statement, not a design. Design tasks follow separately.

---

## 1. Domain

### Where we are

The domain models a single anonymous round. The core entities are `RoundConfig`, `RoundState`, `Player`, `Score`, and `CourseSnapshot`. These are sufficient to track strokes for a group of golfers through one round on one course.

What the domain does not have:

- **No user identity.** There is no concept of a person across rounds. A player exists only within a single round and cannot be linked to any prior or future activity.
- **No player history.** Handicaps, scoring averages, round history, and trends cannot be computed or stored because there is no persistent player identity.
- **No tournament structure.** There is no model for a competition, bracket, leaderboard, flight, or any grouping of rounds under a shared context. The domain can only represent one round at a time.
- **No scoring format.** The domain records raw strokes and nothing else. Formats like Stableford, match play, net scoring, or skins are not expressible. Par-relative scoring is computed in the UI from raw strokes and course par, not in the domain.
- **No round groupings.** A round belongs to no parent. You cannot model a tournament day, a club event, or a multi-round series.
- **No handicap system.** Course handicap, playing handicap, and net scores are entirely absent. `handicapIndex` exists on `TeeHole` but is only used for display in the UI.
- **No policies, only hardcoded rules.** Authorization rules (creator can change status, players can only edit themselves) are baked into `RoundService` as imperative logic. There is no policy layer that could vary by context, e.g. a tournament director having broader permissions.
- **Creator identity is re-derived.** The round creator is not stored. It is inferred on every relevant call by sorting players by `joinedAt` and taking the first. This is fragile and not a first-class domain concept.
- **`Player.color` is misnamed.** The field is called `color` but holds a tee set name. Color and tee selection are conflated.
- **`RoundStatus` allows `null`.** The type is `"IN_PROGRESS" | "COMPLETED" | null` but `null` is never set. Either it has meaning that is undocumented, or it should be removed.

### Where we need to be

The system needs to support:

- **Persistent user profiles** with an identity that spans rounds, with history, handicap index, and preferences.
- **Tournament facilitation**: a first-class model for competitions that group rounds, players, and scoring results under a shared context, with configurable formats and rules.
- **Flexible scoring formats**: net scoring, Stableford, match play, and skins must be representable.
- **A course system**: a managed catalog of courses with tee sets and hole data, independent of any specific round.
- **Anonymous play must still work**: the access-code round-join flow is a valid use case and must coexist with authenticated, tournament-style play.

---

## 2. Sessions

### Where we are

Sessions are app-level tokens, not tied to any authentication system. Creating or joining a round generates a `sessionId` that is stored in `sessionStorage` and sent with every mutation. The server validates the session is active, belongs to the requested round, and that the player still exists.

What is missing or broken:

- **No rejoin.** `sessionStorage` is per-tab and is cleared when the tab is closed. If a player closes their browser mid-round, their session is gone. They would need to use the access code to re-enter, but re-entering creates a new player record — their original scores are orphaned under their old `playerId`.
- **Scoped to a single tab.** Two tabs = two independent sessions and two separate player identities in the same round. This is not intentional — it is a consequence of using `sessionStorage`.
- **No authenticated user context.** Sessions carry a `(roundId, playerId)` pair but no concept of a logged-in user. When user profiles exist, session management will need to distinguish between: an authenticated user playing a round (session linked to their account), and an anonymous guest (current behavior). These are different session types with different capabilities and different expiry semantics.
- **No cross-device continuity.** A player who switches from phone to tablet cannot resume their position in a round. The session is device- and tab-local.
- **Tournament play is unsupported.** A tournament director managing multiple rounds, a scorer updating cards on behalf of players, or a player participating in multiple rounds within a tournament event — none of these session shapes exist.

### Where we need to be

- Players should be able to close and reopen a round without losing their identity or scores.
- Authenticated users should have a single durable session that works across tabs and devices.
- Anonymous access-code play should remain supported but be clearly distinguished from authenticated play.
- Session design must accommodate tournament contexts where a user's relationship to a round is not simply "a player in this round."

---

## 3. UI

### Where we are

The UI is an Ionic React SPA. It has four screens: Home, Create Round, Join Round, and Round (which contains a score entry page). The score entry page shows one hole at a time with a stepper (+/−) for each player's strokes. A totals strip at the bottom shows running totals.

What is wrong with it:

- **No profile or account UI.** There is no sign-in, sign-up, profile view, or history view of any kind.
- **No tournament UI.** There is no way to view, join, or manage a tournament.
- **Score entry is functional but not well-suited to the real use case.** A golfer scoring on a phone on the course needs fast, thumb-friendly input. The stepper-per-player-per-hole interaction is fine for one or two players but gets unwieldy with four.
- **No scorecard view.** There is a totals strip but no full scorecard showing all holes for all players in a grid — the standard golf scorecard format.
- **Home screen is bare.** It has Create and Join buttons and a "Resume round" shortcut if a round is active. There is no indication of past rounds, player identity, or anything beyond the current session.
- **Built on Ionic.** The current UI uses Ionic React. Ionic adds mobile-native feel but also adds significant complexity, bundle size, and styling friction. Whether this is the right framework for the target product is an open question.
- **No leaderboard or competition view.** Even within a single round, there is no ranking or par-relative summary by player.

### Where we need to be

- A UI that works well as a mobile web app for on-course scoring, with fast, thumb-friendly interactions.
- Profile and history views for signed-in users.
- Tournament views: event lobby, round list, leaderboard, standings.
- A full scorecard view in addition to the hole-by-hole entry view.
- A home screen that reflects the user's context: active rounds, upcoming events, recent history.
