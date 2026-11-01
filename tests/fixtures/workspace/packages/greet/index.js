import pc from "picocolors";

export function greet(name) {
  return `Hello, ${pc.bold(name)}!`;
}
