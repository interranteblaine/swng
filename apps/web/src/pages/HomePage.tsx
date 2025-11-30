import { Link } from "react-router-dom";

export default function HomePage() {
  return (
    <div style={{ textAlign: "left" }}>
      <h1>Round Manager</h1>
      <p>Select an option to get started:</p>
      <ul>
        <li>
          <Link to="/rounds/create">Create a new round</Link>
        </li>
        <li>
          <Link to="/rounds/join">Join an existing round</Link>
        </li>
      </ul>
    </div>
  );
}
