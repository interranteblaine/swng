import { useState } from "react";
import { useParams } from "react-router-dom";
import { PlayTab } from "./PlayTab/PlayTab";
import { RoundTabs, type RoundTabId } from "./RoundTabs";
import { SettingsTab } from "./SettingsTab/SettingsTab";
import { TotalsTab } from "./TotalsTab/TotalsTab";
import { RoundProvider } from "./Context/RoundProvider";

export function RoundView() {
  const { roundId } = useParams<{ roundId: string }>();
  const [activeTab, setActiveTab] = useState<RoundTabId>("play");

  if (!roundId) {
    return (
      <div role="alert" aria-live="assertive">
        Missing roundId in route.
      </div>
    );
  }

  return (
    <RoundProvider roundId={roundId}>
      <section id="round-view" aria-labelledby="round-heading">
        <header>
          <h2 id="round-heading">Round</h2>
          <p>Score and manage the current round.</p>
        </header>

        <RoundTabs activeTab={activeTab} onChange={setActiveTab} />

        {activeTab === "play" && <PlayTab />}
        {activeTab === "totals" && <TotalsTab />}
        {activeTab === "settings" && <SettingsTab />}
      </section>
    </RoundProvider>
  );
}
