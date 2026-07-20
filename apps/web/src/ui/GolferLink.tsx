import { createContext, useContext } from "react";
import { Link } from "react-router";
import { linkEntity } from "./classes";

// WatchPage's spectator tree turns every golfer link off at the root (spec §4c.2) — a context,
// not a prop threaded through four component layers.
export const PlainNamesContext = createContext(false);

export function GolferLink({ golferId, name, className }: { golferId: string; name: string; className?: string }) {
  if (useContext(PlainNamesContext)) return <span className={className}>{name}</span>;
  return (
    <Link to={`/golfers/${golferId}`} className={className ? `${linkEntity} ${className}` : linkEntity}>
      {name}
    </Link>
  );
}
