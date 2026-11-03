// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
// pnpm relativizes file dependencies while writing a lock in an isolated
// copy. Keep only the declared Nix repository references absolute.
export function bindNativeLock(file, viewsFile = process.env.PNPM_PURIFIER_INPUT_VIEWS) {
  if (!viewsFile || !fs.existsSync(file)) return;
  const archives = new Map();
  for (const view of JSON.parse(fs.readFileSync(viewsFile, 'utf8'))) {
    for (const item of JSON.parse(fs.readFileSync(view.catalog, 'utf8')).modules) {
      const archive = path.resolve(view.repository, item.archive);
      if (!archive.startsWith(path.resolve(view.repository)+path.sep)) throw new Error('invalid Nix npm archive');
      const key = path.basename(archive);
      if (archives.has(key) && archives.get(key).integrity !== item.integrity) throw new Error('conflicting Nix npm archive');
      if (!archives.has(key)) archives.set(key, {archive, integrity:item.integrity});
    }
  }
  const text = fs.readFileSync(file, 'utf8');
  const rewritten = text.replace(/file:[^\s,'"{}()\[\]]+\/tarballs\/([a-f0-9]+\.tgz)/g, (original, key) =>
    archives.has(key) ? 'file:'+archives.get(key).archive : original);
  if (text !== rewritten) fs.writeFileSync(file, rewritten);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) bindNativeLock(process.argv[2]);

export function needsNativeRebind(file, viewsFile = process.env.PNPM_PURIFIER_INPUT_VIEWS) {
  if (!viewsFile || !fs.existsSync(file)) return false;
  const modules = JSON.parse(fs.readFileSync(viewsFile, 'utf8')).flatMap(view=>
    JSON.parse(fs.readFileSync(view.catalog,'utf8')).modules);
  const names = new Set(modules.map(item=>item.name));
  const archives = new Set(modules.map(item=>path.basename(item.archive)));
  const text = fs.readFileSync(file,'utf8');
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('^  [\'\"]?'+escaped+'@(?!file:)', 'm').test(text)) return true;
  }
  for (const match of text.matchAll(/^  ['"]?(.+?)@file:([^\n]+?)['"]?:\s*$/gm)) {
    const filename = path.basename(match[2].replace(/['"]$/,''));
    if (names.has(match[1]) && !archives.has(filename)) return true;
  }
  return false;
}
