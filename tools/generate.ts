#!/usr/bin/env ts-node
import fs from "fs-extra";
import path from "path";
import ejs from "ejs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

async function generatePackage(name: string) {
  const templateDir = path.resolve("tools", "templates", "package");
  const targetDir = path.resolve("packages", name);

  if (await fs.pathExists(targetDir)) {
    console.error(`Error: directory packages/${name} already exists.`);
    process.exit(1);
  }

  // Copy all template files to target
  await fs.copy(templateDir, targetDir);

  // Render and remove root templates
  for (const tpl of ["package.json.ejs", "tsconfig.json.ejs"]) {
    const src = path.join(targetDir, tpl);
    if (await fs.pathExists(src)) {
      const dest = path.join(targetDir, tpl.replace(/\.ejs$/, ""));
      const contents = await ejs.renderFile(src, { name });
      await fs.writeFile(dest, contents);
      await fs.remove(src);
    }
  }

  // Recursively render any .ejs in src
  async function renderDir(dir: string) {
    for (const entry of await fs.readdir(dir, { encoding: "utf8" })) {
      const full = path.join(dir, entry);
      if ((await fs.stat(full)).isDirectory()) {
        await renderDir(full);
      } else if (full.endsWith(".ejs")) {
        const dest = full.replace(/\.ejs$/, "");
        const contents = await ejs.renderFile(full, { name });
        await fs.writeFile(dest, contents);
        await fs.remove(full);
      }
    }
  }

  await renderDir(path.join(targetDir, "src"));
  console.log(`Generated package "${name}" in packages/${name}`);
}

yargs(hideBin(process.argv))
  .scriptName("gen")
  .usage("$0 new <name>")
  .command(
    "new <name>",
    "Generate a new package scaffold from template",
    (yargs) =>
      yargs.positional("name", {
        type: "string",
        describe: "Package name (no scope)",
      }),
    async (args) => {
      await generatePackage(args.name as string);
    }
  )
  .demandCommand(1, "You need to specify the command “new <name>”")
  .help()
  .parse();
