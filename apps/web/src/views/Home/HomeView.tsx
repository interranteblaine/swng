import { Link } from "react-router-dom";

export function HomeView() {
  return (
    <section
      id="home-view"
      aria-labelledby="home-heading"
      className="lg:max-w-2xl flex flex-col"
    >
      <header className="mb-6 flex flex-col">
        <h2 id="home-heading" className="text-l md:text-xl font-semibold">
          Welcome to SWNG
        </h2>
        <p className="sr-only">Create a new round or join one.</p>
      </header>

      <nav aria-label="Primary actions">
        <ul className="flex gap-6">
          <li>
            <Link
              to="/rounds/create"
              id="home-create-link"
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-6 py-3 text-sm font-medium"
            >
              Create a round
            </Link>
          </li>
          <li>
            <Link
              to="/rounds/join"
              id="home-join-link"
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-6 py-3 text-sm font-medium"
            >
              Join a round
            </Link>
          </li>
        </ul>
      </nav>
    </section>
  );
}
