#!/usr/bin/env ts-node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { verifyStaging } from "./verifyStaging";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("verify")
    .usage("$0 --api <url> --ws <url>")
    .option("api", {
      type: "string",
      demandOption: true,
      describe: "HTTP base URL",
    })
    .option("ws", {
      type: "string",
      demandOption: true,
      describe: "WebSocket URL",
    })
    .strict()
    .help()
    .parse();

  const apiUrl = String(argv.api);
  const wsUrl = String(argv.ws);

  await verifyStaging(apiUrl, wsUrl);
  console.log("verify: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
