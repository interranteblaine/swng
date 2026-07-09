import { Link } from "react-router";
import { credentialStore } from "../identity";

// Reads localStorage directly on render rather than through useRoundSession/state — Home
// never opens a live session (that's per-round, from RoundPage), it only needs the flat list
// of rounds this device already holds a credential for.
export function HomePage() {
  const rounds = credentialStore.list();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-3xl font-bold">swng</h1>

      <nav className="flex flex-col gap-3">
        <Link to="/create" className="rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold">
          Start a round
        </Link>
        <Link to="/join" className="rounded-lg bg-slate-800 px-4 py-4 text-center text-lg font-semibold">
          Join by code
        </Link>
      </nav>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-300">Your rounds</h2>
        {rounds.length === 0 ? (
          <p className="text-slate-400">No rounds yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rounds.map((round) => (
              <li key={round.roundId}>
                <Link to={`/round/${round.roundId}`} className="block rounded-lg bg-slate-800 px-4 py-3">
                  {round.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
