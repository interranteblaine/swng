import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export function HomeView() {
  return (
    <section
      id="home-view"
      aria-labelledby="home-heading"
      className="lg:max-w-2xl flex flex-col items-center"
    >
      <header className="mb-6 flex flex-col items-center">
        <h2 id="home-heading" className="text-l md:text-xl font-semibold">
          Welcome to SWNG
        </h2>
        <p className="sr-only">Create a new round or join one.</p>
      </header>

      <nav aria-label="Primary actions">
        <ul className="space-y-6 flex flex-col items-center">
          <li>
            <Button asChild size="lg">
              <Link to="/rounds/create" id="home-create-link">
                Create a round
              </Link>
            </Button>
          </li>
          <li>
            <Button asChild variant="outline" size="lg">
              <Link to="/rounds/join" id="home-join-link">
                Join a round
              </Link>
            </Button>
          </li>
        </ul>
      </nav>
    </section>
  );
}
