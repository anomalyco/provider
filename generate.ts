import { $ } from "bun";

const dry = process.argv.includes("--dry");

for (const file of new Bun.Glob("*").scanSync("metadata")) {
  const provider = await import(`./metadata/${file}`);
  const version = [provider.version, provider.suffix].filter(Boolean).join("-");
  const name = `@sst-provider/${provider.name}`;
  const resp = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (resp.status !== 404) {
    console.log("skipping", name, "version", version, "already exists");
    continue;
  }
  console.log("generating", name, "version", version);
  const result =
    await $`pulumi package add terraform-provider ${provider.terraform} ${provider.version}`;
  let path = result.stdout
    .toString()
    .match(/at (\/[^\n]+)/)
    ?.at(1);
  if (!path) {
    console.log("failed to find path");
    continue;
  }
  if (path.endsWith("/sdks")) {
    path = `${path}/${provider.name}`;
  }
  console.log("path", path);
  process.chdir(path);

  const pkg = Bun.file("package.json");
  const json = await pkg.json();
  json.name = name;
  json.version = provider.version;
  json.files = ["bin/", "README.md", "LICENSE"];
  if (provider.suffix) json.version += "-" + provider.suffix;
  await Bun.write(pkg, JSON.stringify(json, null, 2));

  const tsconfig = Bun.file("tsconfig.json");
  const tsjson = await tsconfig.json();
  tsjson.compilerOptions.skipLibCheck = true;
  await Bun.write(tsconfig, JSON.stringify(tsjson, null, 2));

  await $`bun install && bun run build`;
  if (!dry) await $`npm publish --access public`;
}
