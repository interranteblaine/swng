export function RoundStateSection({
  isArchived,
  onArchive,
  onUnarchive,
}: {
  isArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  return (
    <section aria-label="Round state">
      <h4>Round state</h4>

      {isArchived ? (
        <>
          <p>This round is archived.</p>
          <button type="button" onClick={onUnarchive}>
            Unarchive round
          </button>
        </>
      ) : (
        <>
          <p>This round is active.</p>
          <button type="button" onClick={onArchive}>
            Archive round
          </button>
        </>
      )}
    </section>
  );
}
