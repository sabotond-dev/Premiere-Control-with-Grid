// Release archiver, following the official intechstudio package
// pattern (see package-websocket / package-photoshop): move the
// runtime files into a staging folder, bring the prebuilt components
// and the UXP plugin installer along, and zip it all as
// package-archive.zip for the GitHub release.

const fs = require("fs");
const archiver = require("archiver");
const output = fs.createWriteStream("package-archive.zip");
const archive = archiver("zip", { zlib: { level: 9 } });

const subfolder = "my-project-files";
if (!fs.existsSync(subfolder)) {
  fs.mkdirSync(subfolder);
}

const excludedFiles = [
  subfolder,
  "components",
  "premiere-plugin",
  "build.js",
  "build-ccx.js",
  ".github",
  ".git",
  "tools",
];

// Get all files and directories in the current folder
const files = fs.readdirSync(".");
for (const file of files) {
  // Exclude the excluded files/directories
  if (!excludedFiles.includes(file)) {
    fs.renameSync(file, `${subfolder}/${file}`);
  }
}

//Copy components dist folder
fs.mkdirSync(`${subfolder}/components`);
fs.renameSync("components/dist", `${subfolder}/components/dist`);

output.on("close", () => {
  console.log("Archive created successfully.");
});

archive.pipe(output);
archive.directory(subfolder, false);
archive.finalize();

console.log("Dependencies removed and archive created.");
