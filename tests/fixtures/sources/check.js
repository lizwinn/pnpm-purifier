// One dependency from each source pnpm can lock: GitHub, given two ways;
// a tarball URL outside the registry; a git repository on a host pnpm
// does not know; a local directory; and a local tarball.
import escapeStringRegexp from "escape-string-regexp";
import isPlainObj from "is-plain-obj";
import isOdd from "is-odd";
import ms from "ms";
import vendored from "vendored";
import packed from "packed";

console.log(`github: ${escapeStringRegexp("a.b")}`);
console.log(`git+https github: ${isPlainObj({})}`);
console.log(`tarball url: ${isOdd(3)}`);
console.log(`git: ${ms("1h")}`);
console.log(`directory: ${vendored}`);
console.log(`tarball file: ${packed}`);
