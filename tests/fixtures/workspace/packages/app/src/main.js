import ms from "ms";
import { greet } from "@example/greet";

console.log(greet(process.argv[2] ?? "world"));
console.log(`One day is ${ms("1d")} milliseconds.`);
