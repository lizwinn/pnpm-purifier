# pnpm-purifier

A command-line program and Nix library that let Nix build a pnpm project in
its sandbox. pnpm-purifier records the files pnpm downloads for a project
in a lockfile, `pnpm-purifier.lock.json`, beside `pnpm-lock.yaml`. Nix
builds the project from that lockfile, so the project needs no generated
Nix files. It is one of the [nix-purifiers](https://nix-purifiers.github.io).

pnpm-purifier follows the design of sbt-nix-backend
([nix-purifiers/sbt-purifier](https://github.com/nix-purifiers/sbt-purifier)):
the tool still plans the build, a lock run records every download by URL
and hash, and Nix fetches those files and runs the tool in its sandbox,
offline. sbt-nix-backend in turn takes its model from nixcloud's
[cargo (libnix)](https://github.com/nixcloud/cargo).

- **A lockfile.** `pnpm-purifier lock` installs the project from
  `pnpm-lock.yaml` with an empty store and records every file pnpm
  downloads. It also installs the platform-specific packages of Linux and
  macOS on x86-64 and ARM64, so one lockfile serves each of those systems.
  A second install then runs from the recorded files alone, which shows
  that the lockfile holds everything the install needs.
- **Sandboxed builds.** `buildPnpmProject`, which the flake's overlay adds
  to a package set, builds each workspace project in the Nix sandbox: it
  installs from the locked files, runs the project's `build` script, and
  copies the project with its production dependencies. Each `bin` entry
  gets a wrapper, and a project that is not private also gets the tarball
  that `pnpm pack` makes.
- **Interactive pnpm on the locked files.** `pnpm-purifier <pnpm
  arguments>` runs pnpm with the locked files, which Nix fetches, and no
  network.
- **Publishing what Nix built.** `pnpm-purifier publish <project>` builds
  the project's tarball in the Nix sandbox and runs `pnpm publish` on that
  file, so nothing that is published was packed outside the sandbox.

## How it works

pnpm reads every package through a registry on the loopback interface that
pnpm-purifier runs. During the lock run the registry forwards each request
upstream, with the credentials the project's `.npmrc` sets for that
registry, and records what comes back. In the Nix build and in interactive
mode it serves the locked files from the Nix store, and nothing else. The
registry mirrors upstream URLs, so
`https://registry.npmjs.org/ms/-/ms-2.1.3.tgz` is
`https/registry.npmjs.org/ms/-/ms-2.1.3.tgz` on it, which is also the
file's `path` in the lockfile.

pnpm fetches some dependencies from the absolute URL in `pnpm-lock.yaml`
rather than from its registry, and clones others with git. While pnpm runs,
pnpm-purifier rewrites those entries of `pnpm-lock.yaml` to name its
registry. It rewrites a copy in the lock run and the Nix build. In
interactive mode it rewrites the project's own file for the length of the
command and puts it back afterwards, also after an interrupt.

Each source that `pnpm-lock.yaml` can express is locked as follows.

| Source in `package.json` | Entry in `pnpm-lock.yaml` | Lockfile entry |
|---|---|---|
| A registry version, any registry or scope | `{integrity}` | file: the tarball |
| A tarball URL | `{integrity, tarball: https://…}` | file: the tarball |
| GitHub, GitLab or Bitbucket (`github:` or `git+https://github.com/…`) | `{gitHosted: true, integrity, tarball: https://codeload…}` | file: the host's archive, which `integrity` already pins |
| Any other git repository | `{commit, repo, type: git}` | git: the checkout of the commit, which Nix packs as a tarball that the registry serves |
| A local directory or tarball (`file:`, `link:`, `workspace:`) | `{directory}` or `{tarball: file:…}` | none: it is part of the project source |

A git entry is `{ path, git = { url, rev, submodules = false, leaveDotGit = false, commitObject = null }, hash }`,
where `hash` is what `nix-prefetch-git` reports. pnpm requires an
integrity for each tarball, and the rewritten entry carries the integrity
of the tarball served in that run.

A git dependency with a `prepare` script, which pnpm 12 runs when the
project's `allowBuilds` setting allows it, is prepared with that
repository's package manager (npm when it names none). Before the script
runs, the package manager installs the repository's devDependencies,
which the project's `pnpm-lock.yaml` does not list, so it resolves them
from registry metadata. The lock run's second install, from the recorded
files alone, finds these metadata requests. The lock run then records each
response as an inline entry `{ path, contents }`, cut down to the versions
whose tarballs it recorded, and installs again. Offline, the local
registry serves that metadata, so the dependency resolves to the same
versions and its `prepare` script runs without the network.

The lockfile records the hash of `pnpm-lock.yaml`. The Nix build fails
during evaluation when `pnpm-lock.yaml` no longer matches, and interactive
mode then runs pnpm online until the next `pnpm-purifier lock`.

pnpm 12 checks `pnpm-lock.yaml` against its supply-chain policies with
registry metadata and attestations, which change over time and cannot be
locked by hash. The lock run makes that check online, and the offline
modes run pnpm with `trust-lockfile`.

## Use

In the project root, after `pnpm install` has written `pnpm-lock.yaml`:

```zsh
nix run github:nix-purifiers/pnpm-purifier -- lock
```

Commit `pnpm-purifier.lock.json`. The flake's `overlays.default` adds
`buildPnpmProject` to a package set:

```nix
# package.nix
{ buildPnpmProject }:
(buildPnpmProject { src = ./.; }).packages."@example/app"
```

```nix
{
  inputs.pnpm-purifier.url = "github:nix-purifiers/pnpm-purifier";
  inputs.nixpkgs.follows = "pnpm-purifier/nixpkgs";

  outputs = { nixpkgs, pnpm-purifier, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [
          pnpm-purifier.overlays.default
          (final: prev: { example-app = final.callPackage ./package.nix { }; })
        ];
      };
    in
    {
      packages.${system}.example-app = pkgs.example-app;
    };
}
```

The builder knows each project and its outputs during evaluation, with no
generated Nix files and no import from derivation. The projects are the
importers of `pnpm-lock.yaml`, which the lockfile lists by name, and their
outputs come from each project's `package.json`, which Nix reads as JSON.
`packages.<name>.artifacts.bin.<bin>` is the wrapper of each `bin` entry,
and `packages.<name>.artifacts.tarball` is the file that `pnpm pack`
makes of a project that is not private.

`nix/lib/build-pnpm-project.nix` documents the builder's arguments:
`pnpm` (the default is nixpkgs' pnpm of the major version the lock was
made with), `fetchurl` (for credentials or mirrors), `buildScript`,
`doCheck` (runs the `test` script), `nativeBuildInputs` (for native
addons) and `srcFilter`. Native addons build against the headers of the
build's Node.js, which pnpm-purifier names in `npm_config_nodedir`.

To publish a workspace project, with any `pnpm publish` arguments after
its name:

```zsh
nix run github:nix-purifiers/pnpm-purifier -- publish @example/greet --access public
```

The `pnpm-purifier` command runs the pnpm of the major version that the
project's `packageManager` field names, from the flake's nixpkgs (pnpm 10,
11 or 12). `PNPM_PURIFIER_PNPM` names another pnpm, and `PNPM_PURIFIER=0`
turns interactive mode off.

### Day to day

`pnpm-purifier` takes pnpm's arguments, so it can stand in for `pnpm`, for
example through `alias pnpm=pnpm-purifier`.

| Command | What runs |
|---|---|
| `pnpm-purifier install` | pnpm installs offline, from the locked files, which Nix fetches once and keeps under a GC root in `.pnpm-purifier/` |
| `pnpm-purifier run build`, `test`, `exec tsc`, a script name | pnpm itself, since these download nothing |
| `pnpm-purifier add ms`, `update`, `remove ms`, `install ms` | pnpm online, since resolving versions reads registry metadata, then `pnpm-purifier lock` when `pnpm-lock.yaml` changed |
| `pnpm-purifier --online <arguments>` | pnpm online, then `pnpm-purifier lock` when `pnpm-lock.yaml` changed |

An editor's language server, such as the TypeScript server, reads
`node_modules`. An offline install writes the same `node_modules` an online
one does, so the editor works as it does with pnpm alone.

Each common mistake stops with what went wrong and the command to run.

| Mistake | Message |
|---|---|
| `pnpm-lock.yaml` changed after `pnpm-purifier lock` | interactive mode says the lock is stale, runs pnpm online and names `pnpm-purifier lock`; the Nix build fails during evaluation with the same command |
| `package.json` changed, and an offline install needs to resolve | pnpm-purifier names the `pnpm-purifier --online` command to run |
| A file is missing from the lock | the offline install and the Nix build name the file and `pnpm-purifier lock` |
| `pnpm-purifier.lock.json` was edited by hand | interactive mode and the Nix build name what is wrong and `pnpm-purifier lock`; a wrong hash makes Nix's fetch fail with the URL and both hashes |
| A locked file does not match `pnpm-lock.yaml` | pnpm refuses it with `ERR_PNPM_TARBALL_INTEGRITY` |

A lock run installs twice: once online, recording, and once offline from
what it recorded. On the fixtures it takes a few seconds; most of the time
of a larger project goes to the first, online install.

### Projects tried

[unjs/giget](https://github.com/unjs/giget) at commit
`f1dad453055b97a81d5227edce7262c8dcaf53d2`, a command-line tool on pnpm 11
whose lock holds 324 files. Following the quickstart above word for word,
`pnpm-purifier lock` took 6 seconds. With the lock, `pnpm-purifier install`
installed offline, `pnpm-purifier run build` built it with obuild,
`pnpm-purifier run test:types` type-checked it with `tsc`, as the editor's
TypeScript server does, and `pnpm-purifier exec vitest run` passed its 58
tests. `pnpm-purifier add kleur@4.1.5` ran online and relocked in 8
seconds. The flake's `real-world` check builds giget at that commit in the
sandbox from `tests/real-world/giget.lock.json`, and CI relocks it and
compares the result byte for byte.

Trying giget changed two things. The project pins pnpm 11.15.1 and the
flake's pnpm 11 is 11.27.0, so pnpm tried to download 11.15.1 before the
lock run; every pnpm that pnpm-purifier starts now stays on the version
that runs. And pnpm-purifier's own `exec` subcommand hid `pnpm exec`; it is
now `registry-exec`.

## Limitations

- Registry metadata is never locked, because a registry changes it each
  time a package publishes, and interactive mode does not serve it. A
  command that resolves versions, such as `pnpm add` or `pnpm update`,
  reads registry metadata, so it runs with `PNPM_PURIFIER=0`, followed by
  `pnpm-purifier lock`.
- A git dependency installs without its submodules. pnpm clones git
  dependencies without them, and the archives of GitHub, GitLab and
  Bitbucket hold none, so the lock records `submodules = false`.
- The Nix build fetches with Nix, which does not read `.npmrc`. A private
  registry needs a `fetchurl` that supplies credentials, such as nixpkgs'
  `fetchurl` with `netrcPhase`.
- The flake's checks build on x86_64-linux and evaluate on aarch64-linux.
