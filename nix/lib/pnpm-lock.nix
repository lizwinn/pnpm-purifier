# Reads the facts of pnpm-lock.yaml that a build needs, in Nix, which reads
# JSON and TOML but not YAML. pnpm writes these facts in a narrow form,
# which this reads and nothing more:
#
#   importers:
#
#     packages/app:
#       dependencies: ...
#     .: {}
#
#   packages:
#
#     '@esbuild/linux-x64@0.25.12':
#       resolution: {integrity: sha512-...}
#       cpu: [x64]
#       os: [linux]
#
# Each key of a section is indented by two spaces, quoted when YAML needs it,
# and each field of a package by four. A resolution is a one-line flow
# mapping and a filter a one-line flow list. pnpm 12 writes a document for
# its own version before the document of the project, so the project
# document is the last one. src/lib.mjs reads the same facts the same way.
#
# Needs no nixpkgs.
text:
let
  inherit (builtins)
    filter
    head
    isString
    length
    elemAt
    match
    split
    listToAttrs
    ;

  documents = filter isString (split "\n---\n" text);
  document = elemAt documents (length documents - 1);

  # The document split at its top-level keys: the text before the first,
  # then for each key the list of its groups and the text up to the next.
  topLevel = split "\n([^ \n][^\n]*):( [^\n]*)?\n" ("\n" + document + "\n");

  # The text of a top-level section, or "" when the document has none.
  section =
    name:
    let
      go =
        i:
        if i + 1 >= length topLevel then
          ""
        else if head (elemAt topLevel i) == name then
          elemAt topLevel (i + 1)
        else
          go (i + 2);
    in
    go 1;

  unquote =
    s:
    let
      m = match "'(.*)'|\"(.*)\"" s;
    in
    if m == null then
      s
    else if elemAt m 0 != null then
      elemAt m 0
    else
      elemAt m 1;

  # The two-space keys of a section, each with the four-space lines that
  # follow it. builtins.split alternates the text between matches with the
  # list of a match's groups.
  entries =
    sectionText:
    let
      parts = split "\n  ([^ \n][^\n]*):( [{][}])?\n" ("\n" + sectionText + "\n");
      go =
        i:
        if i + 1 >= length parts then
          [ ]
        else
          [
            {
              key = unquote (head (elemAt parts i));
              body = elemAt parts (i + 1);
            }
          ]
          ++ go (i + 2);
    in
    if length parts < 2 then [ ] else go 1;

  # A field of a package body: the text after `    <name>: `.
  field =
    name: body:
    let
      m = match "(.*\n)?    ${name}: ([^\n]*)(\n.*)?" ("\n" + body);
    in
    if m == null then null else elemAt m 1;

  # A one-line flow mapping as an attribute set of strings.
  flowMap =
    s:
    let
      inner = match "[{](.*)[}]" s;
      items = if inner == null then [ ] else filter isString (split ", " (head inner));
      pairs = filter (p: p != null) (map (item: match "([A-Za-z]+): (.*)" item) items);
    in
    listToAttrs (
      map (p: {
        name = elemAt p 0;
        value = unquote (elemAt p 1);
      }) pairs
    );

  # A one-line flow list as a list of strings.
  flowList =
    s:
    let
      inner = match "[[](.*)[]]" s;
    in
    if inner == null || head inner == "" then
      [ ]
    else
      map unquote (filter isString (split ", " (head inner)));

  # A package key as its name and version: the version follows the first
  # "@" that does not start a scope.
  nameAndVersion =
    key:
    let
      m = match "(@?[^@]+)@(.*)" key;
    in
    if m == null then
      {
        name = key;
        version = null;
      }
    else
      {
        name = elemAt m 0;
        version = elemAt m 1;
      };

  package =
    { key, body }:
    let
      resolution = field "resolution" body;
      filters = listToAttrs (
        map
          (name: {
            inherit name;
            value = flowList (field name body);
          })
          (
            filter (name: field name body != null) [
              "os"
              "cpu"
              "libc"
            ]
          )
      );
    in
    nameAndVersion key
    // {
      inherit key filters;
      resolution = if resolution == null then { } else flowMap resolution;
    };
in
{
  # The project directories of the workspace, relative to the lockfile.
  importers =
    let
      found = map (e: e.key) (entries (section "importers"));
    in
    if found == [ ] then [ "." ] else found;

  # Each package: { key, name, version, resolution, filters }.
  packages = map package (entries (section "packages"));
}
