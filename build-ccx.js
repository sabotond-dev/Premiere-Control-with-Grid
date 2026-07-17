// Builds the UXP plugin installer: a .ccx is simply a zip of the
// plugin folder with manifest.json at its root. Double-clicking it
// installs the plugin into Premiere via Creative Cloud Desktop.
// Output lands in the repo root so build.js ships it inside the
// package archive (mirroring how package-photoshop ships its ccx).

const fs = require("fs");
const archiver = require("archiver");

const CCX_NAME = "c8e52a9b_PPRO.ccx";

const output = fs.createWriteStream(CCX_NAME);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`${CCX_NAME} created (${archive.pointer()} bytes).`);
});

archive.on("error", (err) => {
  throw err;
});

archive.pipe(output);
archive.directory("premiere-plugin", false);
archive.finalize();
