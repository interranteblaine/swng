// The clipboard-fallback line, ONE copy (ShareButton's M9 discipline, shared with SetupPanel's
// invite link since 2026-07-21): after a copy attempt the raw url is ALWAYS shown — clipboard
// access can silently fail, and a link is useless if the only sign of success is a toast that
// already vanished. `break-all` because a url is one unbroken token (a share link's token
// fragment especially) — without it the line is unbounded and runs off narrow screens (owner
// field report, 2026-07-21).
export function CopiedLinkLine({ url, copied, className }: { readonly url: string; readonly copied: boolean; readonly className?: string }) {
  return (
    <p className={`text-xs text-fairway${className ? ` ${className}` : ""}`}>
      {copied ? "Link copied — " : "Copy this link — "}
      <span className="font-mono break-all select-all">{url}</span>
    </p>
  );
}
