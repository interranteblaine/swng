// The clipboard-fallback line, ONE copy (ShareButton's M9 discipline, shared with SetupPanel's
// invite link since 2026-07-21, and the crew invite since 2026-07-23): after a copy attempt the raw
// url is ALWAYS shown — clipboard access can silently fail, and a link is useless if the only sign of
// success is a toast that already vanished. `break-all` because a url is one unbroken token (a share
// link's token fragment especially) — without it the line is unbounded and runs off narrow screens
// (owner field report, 2026-07-21). An optional `note` states a link-scoped fact set off before the
// em-dash that introduces the url (the crew invite's 7-day expiry); omitted, the output is
// byte-identical for the round-share/round-invite callers.
export function CopiedLinkLine({
  url,
  copied,
  note,
  className,
}: {
  readonly url: string;
  readonly copied: boolean;
  readonly note?: string;
  readonly className?: string;
}) {
  const label = copied ? "Link copied" : "Copy this link";
  const lead = note ? `${label} · ${note} — ` : `${label} — `;
  return (
    <p className={`text-xs text-fairway${className ? ` ${className}` : ""}`}>
      {lead}
      <span className="font-mono break-all select-all">{url}</span>
    </p>
  );
}
