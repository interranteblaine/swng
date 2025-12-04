import { useParams } from "react-router-dom";
import * as Tabs from "@radix-ui/react-tabs";
import { PlayTab } from "./PlayTab/PlayTab";
import { SettingsTab } from "./SettingsTab/SettingsTab";
import { TotalsTab } from "./TotalsTab/TotalsTab";
import { RoundProvider } from "./Context/RoundProvider";

export function RoundView() {
  const { roundId } = useParams<{ roundId: string }>();

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

        <Tabs.Root defaultValue="play">
          <Tabs.List aria-label="Round sections">
            <Tabs.Trigger value="play">Play</Tabs.Trigger>
            <Tabs.Trigger value="totals">Totals</Tabs.Trigger>
            <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="play">
            <PlayTab />
          </Tabs.Content>
          <Tabs.Content value="totals">
            <TotalsTab />
          </Tabs.Content>
          <Tabs.Content value="settings">
            <SettingsTab />
          </Tabs.Content>
        </Tabs.Root>
      </section>
    </RoundProvider>
  );
}
