# pnpm-purifier

A command-line program and Nix library that let Nix build a pnpm project in
its sandbox. Nix reads the downloads of a build from `pnpm-lock.yaml`,
which records each package with its integrity hash, so most projects need
nothing else. pnpm-purifier writes a second lockfile,
`pnpm-purifier.lock.json`, beside `pnpm-lock.yaml` only for what that file
cannot record: the checkout hash of a git dependency, the files and
registry metadata that the prepare step of a git dependency reads, the
registries when the user config sets them, and the pnpm version when
`package.json` names none. The project needs no generated Nix files. It is
one of the [nix-purifiers](https://nix-purifiers.github.io), and it meets
the
[purifier contract](https://github.com/nix-purifiers/purifier/blob/main/CONTRACT.md).

pnpm reads every package through a registry on the loopback interface that
pnpm-purifier runs. During the lock run the registry forwards each request
upstream and records what comes back. A second install then runs from the
recorded files alone, which shows that the two lockfiles hold everything
the install needs. In the Nix build and on the developer's machine the
registry serves the locked files from the Nix store, and nothing else. The
registry mirrors upstream URLs, so
`https://registry.npmjs.org/ms/-/ms-2.1.3.tgz` is
`https/registry.npmjs.org/ms/-/ms-2.1.3.tgz` on it, which is also the
file's `path` in the lock.

## Quickstart

Run the lock run in the project root:

```zsh
nix run github:nix-purifiers/pnpm-purifier -- lock
```

The lock run keeps the resolution in `pnpm-lock.yaml`, and it writes that
file first when the project has none. It then writes
`pnpm-purifier.lock.json` when the project needs one, and otherwise it says
that the project needs none. Commit both lockfiles.

The flake's `overlays.default` adds the builder `buildPnpmProject` to a
package set, beside the builders of nixpkgs. A package written for
`callPackage` takes it by name:

```nix
# package.nix
{ buildPnpmProject }:
(buildPnpmProject { src = ./.; }).packages."@example/app"
```

A flake applies the overlay and builds the project:

```nix
{
  inputs.pnpm-purifier.url = "github:nix-purifiers/pnpm-purifier";
  inputs.nixpkgs.follows = "pnpm-purifier/nixpkgs";

  outputs = { nixpkgs, pnpm-purifier, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ pnpm-purifier.overlays.default ];
      };
      project = pkgs.buildPnpmProject { src = ./.; };
    in
    {
      packages.${system}.example-app = project.packages."@example/app";
      checks.${system}.tests = project.tests;
    };
}
```

The builder takes the packages it needs from the package set by name, so
`buildPnpmProject.override` replaces any of them. Its own arguments are
`src`, `lockFile` and `fetchers`, which go to the purifier library's
`fetchEntry`; a `fetchurl` there serves a company mirror or credentials.
Its result has:

- `packages.<name>`: each workspace project, built in the sandbox and
  deployed with its production dependencies under
  `lib/node_modules/<name>`, with a wrapper in `bin/` for each of its `bin`
  entries. `packages.<name>.artifacts.bin.<bin>` names each wrapper, and
  `packages.<name>.artifacts.tarball` names the file that `pnpm pack` makes
  of a project that is not private, which is a second output. The names
  come from the importers of `pnpm-lock.yaml` and each project's
  `package.json`, during evaluation.
- `tests`: the `test` script of every project, run in the sandbox after
  every project's `build` script.
- `release`: the tarball of each project that is not private, which
  `pnpm-purifier publish` uploads.
- `fetches`: the download entries of the lock, for SBOM, license and
  vulnerability tools.
- `lock`: the lock in memory, as `readLock` gives it.

`nix/lib/build-pnpm-project.nix` documents the builder's other arguments:
`lockFile` (see Working offline), `pnpm` (the default is
nixpkgs' pnpm of the major version that `packageManager` in `package.json`
names, or that the lockfile records), `buildScript`, `nativeBuildInputs`
(for native addons) and `srcFilter`. Native addons build against the
headers of the build's Node.js, which pnpm-purifier names in
`npm_config_nodedir`.

`lib.pnpm-purifier.readLock { src; lockFile ? …; }` reads
`pnpm-lock.yaml` in `src` and the purifier lockfile into the lock shape of the purifier library: `purifier`,
`entries` (the download entries, each with `systems` when only some
systems need it), `outputs` (the workspace projects by name) and
`problems` (why the lockfiles cannot be used, each naming the command
that fixes it). The builder passes it to the library's `checkLock` and
takes the downloads of its system from `entriesFor`.

## Development loop

`pnpm-purifier` takes pnpm's arguments, so it can stand in for `pnpm`, for
example through `alias pnpm=pnpm-purifier`. It runs the pnpm of the major
version that the project's `packageManager` field names, from the flake's
nixpkgs (pnpm 10, 11 or 12), and keeps pnpm on that version.
`PNPM_PURIFIER_PNPM` names another pnpm.

| Command | What runs |
|---|---|
| `pnpm-purifier install` | pnpm installs offline, from the locked files, which Nix fetches |
| `pnpm-purifier run build`, `test`, `exec tsc`, a script name | pnpm itself, since these download nothing |
| `pnpm-purifier add ms`, `remove ms`, `install ms` | pnpm online, since resolving versions reads registry metadata, then `pnpm-purifier lock` when `pnpm-lock.yaml` changed |
| `pnpm-purifier --online <arguments>` | pnpm online, then `pnpm-purifier lock` when `pnpm-lock.yaml` changed |
| `pnpm-purifier lock` | the lock run, which keeps the resolution in `pnpm-lock.yaml` |
| `pnpm-purifier update [<package>...]` | `pnpm update --lockfile-only` for every package or the named ones, then the lock run, which updates both lockfiles |
| `pnpm-purifier prefetch` | see Working offline |
| `pnpm-purifier publish [pnpm publish arguments]` | Nix builds the `release`, and `pnpm publish` uploads each of its tarballs |

`PNPM_PURIFIER=0` makes `pnpm-purifier` run pnpm as it is. A lock run
installs twice, once online, recording, and once offline from what it
recorded.

## Working offline

`pnpm-purifier prefetch` realizes in the Nix store the locked files for the
current system and the tools that day-to-day work runs: the
`pnpm-purifier` command itself, Node.js, pnpm 10, 11 and 12, the nixpkgs
they come from, and the purifier library with its flake inputs. It keeps
each one alive with a garbage-collector root in `.pnpm-purifier/`. After a
prefetch, `.pnpm-purifier/command/bin/pnpm-purifier install`, the build and
test scripts and the editor work with no network, and so does the Nix
build of the project.

A project whose author keeps no purifier lockfile can still be built, from
a purifier lockfile that a packaging flake keeps beside its own Nix files.
`pnpm-lock.yaml` always comes from the project tree. Every command
takes `--lockfile <path>`, such as `pnpm-purifier lock --lockfile
../packaging/app.lock.json`, or the environment variable
`PNPM_PURIFIER_LOCKFILE`, which the dev shell of the packaging flake can
set; the flag wins over the variable. The builder takes the path of that
purifier lockfile as `lockFile`.

## Editor

An editor's language server, such as the TypeScript server, reads
`node_modules`. An offline install writes the same `node_modules` an online
one does, so the editor works as it does with pnpm alone, with the network
cut off after a prefetch.

## Troubleshooting

Each common mistake stops with what went wrong and the command to run.

| Mistake | What happens |
|---|---|
| `pnpm-lock.yaml` changed after `pnpm-purifier lock` | the command says the lock is stale, runs pnpm online and names `pnpm-purifier lock`; the Nix build fails during evaluation with the same command |
| `pnpm-purifier.lock.json` was edited by hand | its `contentHash`, a hash of its own content, no longer matches; the command and Nix evaluation both stop and name `pnpm-purifier lock` |
| `pnpm-purifier.lock.json` is not valid | the command and Nix evaluation say what is wrong and name `pnpm-purifier lock` |
| The purifier lockfile has no entry for a git dependency | Nix evaluation names the dependency and `pnpm-purifier lock` |
| A file is missing from the lock | the offline install and the Nix build name `pnpm-purifier lock` |
| `package.json` changed, and an offline install needs to resolve | the command names the `pnpm-purifier --online` command to run |
| A locked file does not match `pnpm-lock.yaml` | pnpm refuses it with `ERR_PNPM_TARBALL_INTEGRITY` |
| A download changed upstream | Nix's fetch fails with the URL and both hashes, and the command names `pnpm-purifier lock` |

## Supported language repositories

Each source that `pnpm-lock.yaml` can express is supported. While pnpm runs,
pnpm-purifier rewrites the entries that pnpm fetches by absolute URL or
with git, so that they name its registry: in a copy in the lock run and
the Nix build, and in the project's own file for the length of an
interactive command, which it puts back afterwards, also after an
interrupt.

| Source in `package.json` | Entry in `pnpm-lock.yaml` | Download entry | In `pnpm-purifier.lock.json` |
|---|---|---|---|
| A registry version, any registry or scope | `{integrity}` | file: the tarball at the registry | nothing |
| A tarball URL | `{integrity, tarball: https://…}` | file: the tarball | nothing |
| GitHub, GitLab or Bitbucket (`github:` or `git+https://github.com/…`) | `{gitHosted: true, integrity, tarball: https://codeload…}` | file: the host's archive, which `integrity` already pins | nothing |
| Any other git repository | `{commit, repo, type: git}` | git: the checkout of the commit, which Nix packs as a tarball that the registry serves | the git entry with its hash |
| A git dependency with a `prepare` script | as above | as above, plus the files and registry metadata the prepare step reads | those files and inline entries |
| A local directory or tarball (`file:`, `link:`, `workspace:`) | `{directory}` or `{tarball: file:…}` | none: it is part of the project source | nothing |

Nix reads `pnpm-lock.yaml` itself, through the narrow form pnpm writes it
in (`nix/lib/pnpm-lock.nix`). A registry package's URL is
`<registry><name>/-/<name without scope>-<version>.tgz`, with the registry
of its scope from the project's `.npmrc`, npm's default registry, and
`https://npm.jsr.io/` for `@jsr`. A file entry is
`{ path, url, mirrors, hash }`, where `hash` is the sha512 integrity from
`pnpm-lock.yaml`. An entry with npm's `os`, `cpu` and `libc` filters
carries `systems`, the Linux systems the filters admit, and the build
fetches only the entries of its own system. A git entry is
`{ path, git = { url, rev, submodules = false, leaveDotGit = false, commitObject = null }, hash }`,
where `hash` is what `nix-prefetch-git` reports, and it carries the
directory of a `#path:` dependency as `subdirectory`.

pnpm 12 prepares an allowed git dependency with that repository's package
manager, which installs the repository's devDependencies, which
`pnpm-lock.yaml` does not list, from registry metadata. The lock run's
second install finds those metadata requests, and the lock records each
response as an inline entry `{ path, contents }`, cut down to the versions
whose tarballs it recorded, so offline the dependency resolves to the same
versions.

These limits affect a project:

- The Nix build runs on x86_64-linux and aarch64-linux.
- A command that resolves versions reads registry metadata, which a
  registry changes each time a package publishes, so it runs online, and
  `pnpm-purifier lock` records the result.
- A git dependency installs without its submodules, because pnpm clones git
  dependencies without them and the archives of GitHub, GitLab and
  Bitbucket hold none.
- pnpm 12 checks `pnpm-lock.yaml` against its supply-chain policies with
  registry metadata and attestations, which change over time. The lock run
  makes that check online, and the offline modes run pnpm with
  `trust-lockfile`.
- The Nix build fetches with Nix, which does not read `.npmrc`. A private
  registry needs a `fetchers.fetchurl` that supplies credentials, such as
  nixpkgs' `fetchurl` with `netrcPhase`. The lock run forwards the
  credentials of `.npmrc`.

## Examples

[giget](https://github.com/unjs/giget) is a command-line tool that
downloads templates from git repositories. It is a pnpm project with a
`build` script, so the quickstart applies to it as it stands. In a
checkout of giget:

```zsh
nix run github:nix-purifiers/pnpm-purifier -- lock
```

The lock run says that giget needs no `pnpm-purifier.lock.json`, because
every package in its `pnpm-lock.yaml` comes from the npm registry with an
integrity hash. The everyday loop then runs through pnpm-purifier:

```zsh
alias pnpm='nix run github:nix-purifiers/pnpm-purifier --'
pnpm install
pnpm run build
pnpm exec vitest run
pnpm add kleur
```

`pnpm install` installs from the locked files, offline. `pnpm add kleur`
resolves online and locks again. A `flake.nix` beside `package.json`
builds giget in the Nix sandbox:

```nix
{
  inputs.pnpm-purifier.url = "github:nix-purifiers/pnpm-purifier";
  inputs.nixpkgs.follows = "pnpm-purifier/nixpkgs";

  outputs = { nixpkgs, pnpm-purifier, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ pnpm-purifier.overlays.default ];
      };
    in
    {
      packages.${system}.default = (pkgs.buildPnpmProject { src = ./.; }).packages.giget;
    };
}
```

`nix build` then builds giget, and `./result/bin/giget --help` runs it.

## Credits

pnpm-purifier follows the design of sbt-nix-backend
([nix-purifiers/sbt-purifier](https://github.com/nix-purifiers/sbt-purifier)):
the tool still plans the build, a lock run records every download by URL
and hash, and Nix fetches those files and runs the tool in its sandbox,
offline. sbt-nix-backend in turn takes its model from nixcloud's
[cargo (libnix)](https://github.com/nixcloud/cargo). The fetching of
download entries and npm's platform filters come from the shared
[purifier](https://github.com/nix-purifiers/purifier) library.
