import { useState } from "react";
import type { RoundId } from "@swng/domain";
import { shareRound } from "../api";
import { btnSecondary } from "../ui/classes";
import { CopiedLinkLine } from "../ui/CopiedLinkLine";

export interface ShareButtonProps {
  readonly roundId: RoundId;
  readonly token: string;
}

// "Share round" (M9 Task 3 brief): mints (or re-fetches — the server side is deterministic,
// getShareLink.ts's own doc comment) this round's own immortal spectator link and copies it.
// Rendered by RoundPage (live) and ResultsView (archived) — see ResultsView.tsx's own doc
// comment for why it's an OPTIONAL prop there, not unconditional: WatchPage reuses the exact
// same ResultsView component for a spectator's own final-card view, and a spectator holds no
// participant token to mint a NEW link with (the route is participant-gated) — omitting the
// prop is what keeps that reuse edit-affordance-free without forking ResultsView.
//
// `navigator.clipboard.writeText` is attempted, but the raw url is ALWAYS shown afterward too
// (brief: "a visible fallback of the raw URL") — clipboard access can silently fail (no
// permission, insecure context, older browsers), and a share link is useless if the only sign
// of success is a toast that already vanished.
export function ShareButton({ roundId, token }: ShareButtonProps) {
  const [busy, setBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const onClick = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await shareRound(roundId, token);
      // getShareLink.ts returns a path+fragment (no web-origin config seam on the server) —
      // this device's own origin is what a spectator opening the link will actually load.
      const absolute = `${window.location.origin}${url}`;
      setShareUrl(absolute);
      setCopied(false);
      try {
        await navigator.clipboard.writeText(absolute);
        setCopied(true);
      } catch {
        // Clipboard permission denied/unavailable — the visible raw-url fallback below still
        // lets the golfer copy it by hand.
      }
    } catch {
      setError("Could not create a share link — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      <button type="button" onClick={() => void onClick()} disabled={busy} className={`${btnSecondary} min-h-12 disabled:opacity-50`}>
        {busy ? "Getting link…" : "Share round"}
      </button>
      {shareUrl && <CopiedLinkLine url={shareUrl} copied={copied} />}
      {error && (
        <p role="alert" className="text-xs text-oxblood">
          {error}
        </p>
      )}
    </div>
  );
}
