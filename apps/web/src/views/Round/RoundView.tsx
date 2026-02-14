import { useState } from "react";
import { useParams } from "react-router-dom";
import { PlayTab } from "./PlayTab/PlayTab";
import { SettingsTab } from "./SettingsTab/SettingsTab";
import { TotalsTab } from "./TotalsTab/TotalsTab";
import { RoundProvider } from "./Context/RoundProvider";

const tabs = ["play", "totals", "settings"] as const;
type Tab = (typeof tabs)[number];

export function RoundView() {
  const { roundId } = useParams<{ roundId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>("play");

  if (!roundId) {
    return (
      <div role="alert" aria-live="assertive">
        Missing roundId in route.
      </div>
    );
  }

  return (
    <RoundProvider roundId={roundId}>
      <section
        id="round-view"
        aria-labelledby="round-heading"
        className="lg:max-w-2xl flex flex-col"
      >
        <header className="mb-6 flex flex-col">
          <h2 id="round-heading" className="text-l md:text-xl font-semibold">
            Current Round
          </h2>
          <p className="sr-only">Score and manage the current round.</p>
        </header>

        <div role="tablist" className="flex gap-2 border-b mb-4">
          {tabs.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`tabpanel-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div id="tabpanel-play" role="tabpanel" hidden={activeTab !== "play"}>
          <PlayTab />
        </div>
        <div id="tabpanel-totals" role="tabpanel" hidden={activeTab !== "totals"}>
          <TotalsTab />
        </div>
        <div id="tabpanel-settings" role="tabpanel" hidden={activeTab !== "settings"}>
          <SettingsTab />
        </div>
      </section>
    </RoundProvider>
  );
}
