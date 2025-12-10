import { useParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

        <Tabs defaultValue="play">
          <TabsList>
            <TabsTrigger value="play">Play</TabsTrigger>
            <TabsTrigger value="totals">Totals</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="play">
            <PlayTab />
          </TabsContent>
          <TabsContent value="totals">
            <TotalsTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
        </Tabs>
      </section>
    </RoundProvider>
  );
}
