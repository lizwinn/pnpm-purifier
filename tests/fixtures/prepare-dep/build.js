// The prepare script of prepare-dep, a package the `prepare` fixture
// installs from this repository's git history. It writes out.js, which
// exists only when prepare ran with the devDependency picocolors
// installed, so the fixture shows that the dependency was prepared.
const fs = require("node:fs");
const pc = require("picocolors");
fs.writeFileSync("out.js", `module.exports = ${JSON.stringify("prepared, picocolors " + typeof pc.bold)};\n`);
