// The test of @example/greet, which the builder's `tests` and the
// conformance-offline job run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "./index.js";

test("greet names whom it greets", () => {
  assert.match(greet("Nix"), /Nix/);
});
