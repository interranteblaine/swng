import { Link } from "react-router-dom";

export function HomeView() {
  return (
    <section id="home-view" aria-labelledby="home-heading">
      <header>
        <h2 id="home-heading">Home</h2>
        <p>Start a new round or join an existing one.</p>
      </header>

      <nav aria-label="Primary actions">
        <ul>
          <li>
            <Link to="/rounds/create" id="home-create-link">
              Create a round
            </Link>
          </li>
          <li>
            <Link to="/rounds/join" id="home-join-link">
              Join a round
            </Link>
          </li>
        </ul>
      </nav>
    </section>
  );
}
