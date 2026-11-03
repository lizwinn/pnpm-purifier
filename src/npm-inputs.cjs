// SPDX-License-Identifier: MIT
// Native pnpm package hook: immutable Nix repositories override version ranges.
const fs = require('node:fs')
const path = require('node:path')
const previous = process.env.PNPM_PURIFIER_PREVIOUS_GLOBAL_HOOK
const configured = previous ? require(previous) : {}
const prior = configured.default || configured
const names = new Map()
const preferred = new Map()
for (const view of JSON.parse(fs.readFileSync(process.env.PNPM_PURIFIER_INPUT_VIEWS, 'utf8'))) {
  const catalog = JSON.parse(fs.readFileSync(view.catalog, 'utf8'))
  if (catalog.version !== 1) throw new Error('unsupported npm projection catalog')
  for (const item of catalog.modules) {
    const values = names.get(item.name) || new Map()
    const other = values.get(item.version)
    if (other && other.integrity !== item.integrity) throw new Error('conflicting Nix npm artifacts: '+item.name)
    const archive = path.resolve(view.repository, item.archive)
    if (!archive.startsWith(path.resolve(view.repository)+path.sep)) throw new Error('invalid npm projection archive')
    const entry = {...item, archive}
    values.set(item.version, entry)
    names.set(item.name, values)
    if (item.primary) {
      const selected = preferred.get(item.name)
      if (selected && selected.version !== item.version) throw new Error('conflicting Nix npm producers: '+item.name)
      preferred.set(item.name, entry)
    }
  }
}
for (const [name, values] of names) if (!preferred.has(name) && values.size === 1) preferred.set(name, [...values.values()][0])
module.exports = {...prior, hooks: {...prior.hooks, async readPackage(pkg, context) {
  if (prior.hooks?.readPackage) pkg = await prior.hooks.readPackage(pkg, context)
  for (const key of ['dependencies','optionalDependencies','devDependencies','peerDependencies']) {
    for (const [alias, value] of Object.entries(pkg[key] || {})) {
      let name = alias, wanted = value
      const target = typeof value === 'string' && value.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/)
      if (target) { name=target[1]; wanted=target[2] }
      const entry = names.get(name)?.get(wanted) || preferred.get(name)
      if (entry) pkg[key][alias] = 'file:'+entry.archive
    }
  }
  return pkg
}}}
