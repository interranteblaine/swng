import { PlayersSection } from "./PlayersSection";
import { RoundInformationSection } from "./RoundInformationSection";
import { RoundStateSection } from "./RoundStateSection";
import { useRoundData, useRoundActions } from "../Context/useRoundContext";
import { computeParTotal } from "../../../lib/roundCalcs";

export function SettingsTab() {
  const { snapshot } = useRoundData();
  const { updatePlayer, patchRoundState } = useRoundActions();

  const parArray = snapshot?.config.par ?? [];
  const holes = parArray.length;
  const parTotal = snapshot ? computeParTotal(snapshot) : 0;

  const accessCode = snapshot?.config.accessCode ?? "";
  const courseName = snapshot?.config.courseName ?? "";

  const status = snapshot?.state.status ?? null;
  const isArchived = status === "COMPLETED";

  const players =
    snapshot?.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      color: (p as { color?: string | null }).color ?? "White",
    })) ?? [];

  const teeOptions = ["White", "Blue", "Gold"];

  return (
    <section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings">
      <header>
        <h3>Settings</h3>
      </header>

      <RoundInformationSection
        accessCode={accessCode}
        courseName={courseName}
        holes={holes}
        par={parTotal}
      />

      <RoundStateSection
        isArchived={isArchived}
        onArchive={() => patchRoundState({ status: "COMPLETED" })}
        onUnarchive={() => patchRoundState({ status: null })}
      />

      <PlayersSection
        players={players}
        isArchived={isArchived}
        teeOptions={teeOptions}
        onUpdatePlayer={(playerId, fields) =>
          updatePlayer({ playerId, ...fields })
        }
      />
    </section>
  );
}
