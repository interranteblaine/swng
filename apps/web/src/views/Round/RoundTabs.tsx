export type RoundTabId = "play" | "totals" | "settings";

type RoundTabsProps = {
  activeTab: RoundTabId;
  onChange: (tab: RoundTabId) => void;
};

export function RoundTabs({ activeTab, onChange }: RoundTabsProps) {
  return (
    <nav aria-label="Round sections" role="tablist">
      <button
        type="button"
        id="tab-play"
        role="tab"
        aria-selected={activeTab === "play"}
        aria-controls="panel-play"
        tabIndex={activeTab === "play" ? 0 : -1}
        onClick={() => onChange("play")}
      >
        Play
      </button>

      <button
        type="button"
        id="tab-totals"
        role="tab"
        aria-selected={activeTab === "totals"}
        aria-controls="panel-totals"
        tabIndex={activeTab === "totals" ? 0 : -1}
        onClick={() => onChange("totals")}
      >
        Totals
      </button>

      <button
        type="button"
        id="tab-settings"
        role="tab"
        aria-selected={activeTab === "settings"}
        aria-controls="panel-settings"
        tabIndex={activeTab === "settings" ? 0 : -1}
        onClick={() => onChange("settings")}
      >
        Settings
      </button>
    </nav>
  );
}
