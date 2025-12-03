type RoundInformationSectionProps = {
  accessCode: string;
  courseName: string;
  holes: number;
  par: number;
};

export function RoundInformationSection({
  accessCode,
  courseName,
  holes,
  par,
}: RoundInformationSectionProps) {
  return (
    <section aria-label="Round information">
      <h4>Round info</h4>

      <p>
        Access code: <strong>{accessCode}</strong>
      </p>

      <p>
        Course name: <strong>{courseName}</strong>
      </p>

      <p>
        Holes: <strong>{holes}</strong>
      </p>

      <p>
        Par: <strong>{par}</strong>
      </p>
    </section>
  );
}
