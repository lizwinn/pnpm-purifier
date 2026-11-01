#!/usr/bin/env node
// The build script of @example/greet, which the build runs by its path, so
// its shebang has to work in the Nix sandbox. It writes built.txt, which
// the package publishes.
import fs from "node:fs";

fs.writeFileSync("built.txt", "built by gen.js\n");
