# pnpm-purifier

pnpm-purifier keeps pnpm's development workflow on locked,
Nix-resolved dependencies. Use the normal build and test commands in your
working tree; building the project itself in the Nix sandbox is an
optional next step.

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

From the project root:

```zsh
nix shell 'github:nix-purifiers/pnpm-purifier'
alias pnpm=pnpm-purifier
pnpm-purifier lock
pnpm install
pnpm run build
pnpm test
```

Commit the lockfiles that the lock command writes, including the build
tool's own lockfile when it has one. Keep using the project's usual build,
test and editor commands with this setup. Nix provides the locked
dependencies; the development commands above run outside the Nix sandbox.
No project Nix files are needed for this workflow.

Sandboxed builds of the whole project are an optional
[next step](#building-the-project-with-nix).

The required wrapper is `pnpm-purifier`; pass your usual tool
arguments after it. With neither pnpm-lock.yaml nor a purifier lockfile, it warns on standard error
and runs the ordinary tool with impure resolution.

You can keep the usual command spelling with `alias pnpm=pnpm-purifier`
in your shell configuration.

For persistent use, add these packages through your usual Nix configuration.


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

## Dependencies from another purified project

```sh
pnpm-purifier lock \
  --input 'github:example/library#library'
pnpm-purifier install --frozen-lockfile
```

The input can export an npm repository from pnpm or another JavaScript
purifier. Its Nix source identity is pinned; supplied packages have no
duplicate download entries. The purifier binds those packages automatically,
leaving your `package.json` unchanged. `pnpm-purifier update` refreshes the
inputs.

Nix builds accept producer packages through `dependencies`. Project and
package outputs expose `projections.npm`; a package's projection includes
its runtime dependencies. The exported metadata uses immutable Nix identities
that ordinary npm consumers can resolve. With composed inputs,
`pnpm-purifier publish` uploads those exact archives using pnpm's
credentials and options, under the `nix` tag unless you choose another tag.

## Building the project with Nix

Once the native development workflow is working, you can also build and
test the whole project in the Nix sandbox. For this step, keep a flake or
another Nix build definition in the project's repository, or maintain an
external packaging repository that points at its sources and lockfiles.
The builder consumes the same lockfiles as the development workflow.

The flake's `overlays.default` adds one attribute to a package set: the
scope `pnpm-purifier`, which holds the builder `buildPnpmProject` and the
`cli` command. A project whose authors want a flake can have one that
packages the project. It calls the builder directly, and it can live in the
repository of the project or in another one:

```nix
{
  inputs.pnpm-purifier.url =
    "github:nix-purifiers/pnpm-purifier";
  inputs.nixpkgs.follows = "pnpm-purifier/nixpkgs";

  outputs =
    { nixpkgs, pnpm-purifier, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ pnpm-purifier.overlays.default ];
      };
      project = pkgs.pnpm-purifier.buildPnpmProject {
        src = ./.;
      };
    in
    {
      packages.${system}.example-app =
        project.packages."@example/app";
      checks.${system}.tests = project.tests;
    };
}
```

The builder takes the packages it needs from the scope by name, so
`pnpm-purifier.buildPnpmProject.override` replaces any of them, and
`pnpm-purifier.overrideScope` replaces what the whole scope shares. Its own
arguments are `src`, `lockFile`, `pnpmLock` and `fetchers`. Both lockfiles
default to the copies in `src`, which is the recommended setup, and
`fetchers` go to the purifier library's `fetchEntry`; a `fetchurl` there
serves a company mirror or credentials. Its result has:

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

### One-off builds without a project Nix file

For an ad hoc build, the builder can also be evaluated directly from the
project root. Replace the example package name with one from your project:

```zsh
nix build --impure --expr 'let
  purifier = builtins.getFlake "github:nix-purifiers/pnpm-purifier";
  pkgs = import purifier.inputs.nixpkgs {
    system = builtins.currentSystem;
    overlays = [ purifier.overlays.default ];
  };
in
(pkgs.pnpm-purifier.buildPnpmProject { src = ./.; })
.packages."@example/app"'
```

This uses the purifier's pinned nixpkgs, matching the lock command above.
To build with ambient `<nixpkgs>` from your Nix search path instead,
replace `import purifier.inputs.nixpkgs` with `import <nixpkgs>`.
Both forms need no Nix files in your project. The build tool and language
versions must match the lockfile; with ambient nixpkgs, lock with the
purifier from that package set or pass a compatible toolchain to the builder.

## Working offline

`pnpm-purifier prefetch` realizes in the Nix store the locked files for the
current system and the tools that day-to-day work runs: the
`pnpm-purifier` command itself, Node.js, pnpm 10, 11 and 12, the nixpkgs
they come from, and the purifier library with its flake inputs. It keeps
each one alive with a garbage-collector root in `.pnpm-purifier/`. After a
prefetch, `.pnpm-purifier/command/bin/pnpm-purifier install`, the build and
test scripts and the editor work with no network, and so does the Nix
build of the project.

We recommend committing both lockfiles to the repository of the project,
and the builder and the commands look for them there. A flake can instead
keep the build of a project external, with both lockfiles beside its own
Nix files. Every command takes `--lockfile <path>` for the purifier
lockfile, such as `pnpm-purifier lock --lockfile ../packaging/app.lock.json`,
or the environment variable `PNPM_PURIFIER_LOCKFILE`. For `pnpm-lock.yaml`
it takes `--tool-lockfile <path>` or `PNPM_PURIFIER_TOOL_LOCKFILE`. With
either, `lock` and `update` write `pnpm-lock.yaml` at that path and leave
the copy in the tree as it is, and `lock` starts from the copy in the tree
when the file at that path does not exist yet. `pnpm update` also rewrites
the ranges in `package.json`, and that change goes into the tree. A flag
wins over its variable, and the dev shell of the packaging flake can set
both variables. The builder takes the paths as `lockFile` and `pnpmLock`.

## Editor

An editor's language server, such as the TypeScript server, reads
`node_modules`. An offline install writes the same `node_modules` an online
one does, so the editor works as it does with pnpm alone, with the network
cut off after a prefetch.

## Troubleshooting

Each common mistake stops with what went wrong and the command to run.

| Mistake | What happens |
|---|---|
| `pnpm-lock.yaml` changed after `pnpm-purifier lock` | the command stops, names `pnpm-purifier lock` and offers an explicit `--online` opt-out; the Nix build fails during evaluation with the same command |
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

For day-to-day work on these projects, use the native-tool setup and
commands in [Quickstart](#quickstart) and [Development loop](#development-loop).
The Nix expressions below show optional sandboxed packaging of those
projects.

[giget](https://github.com/unjs/giget) is a command-line tool that
downloads templates from git repositories. It is a pnpm project with a
`build` script, so the Quickstart applies to it as it stands. In a
checkout of giget:

```zsh
nix shell 'github:nix-purifiers/pnpm-purifier'
pnpm-purifier lock
```

The lock run says that giget needs no `pnpm-purifier.lock.json`, because
every package in its `pnpm-lock.yaml` comes from the npm registry with an
integrity hash. The build from the directory of giget is the Quickstart
build with the name of the package:

```zsh
nix build --impure --expr 'let
  purifier = builtins.getFlake "github:nix-purifiers/pnpm-purifier";
  pkgs = import purifier.inputs.nixpkgs {
    system = builtins.currentSystem;
    overlays = [ purifier.overlays.default ];
  };
in
(pkgs.pnpm-purifier.buildPnpmProject { src = ./.; })
.packages.giget'
./result/bin/giget --help
```

The everyday loop runs through pnpm-purifier:

```zsh
nix shell 'github:nix-purifiers/pnpm-purifier'
alias pnpm=pnpm-purifier
pnpm install
pnpm run build
pnpm exec vitest run
pnpm add kleur
```

`pnpm install` installs from the locked files, offline. `pnpm add kleur`
resolves online and locks again.

## Credits

The purifier idea was inspired by nixcloud's
[cargo (libnix)](https://github.com/nixcloud/cargo).
