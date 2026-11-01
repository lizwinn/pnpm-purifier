# A store path name from a file name. Store path names allow
# [A-Za-z0-9+._?=-], must not start with a dot, and are at most 211
# characters; every other character becomes "_". The interactive mode, the
# lock run and the sandboxed build all name their files with this
# function, so they share store paths.
fileName:
let
  # builtins.split alternates the text between matches with a list per
  # match.
  replaced = builtins.concatStringsSep "" (
    map (part: if builtins.isList part then "_" else part) (
      builtins.split "[^A-Za-z0-9+._?=-]" fileName
    )
  );
  undotted = builtins.head (builtins.match "\\.*(.*)" replaced);
  nonEmpty = if undotted == "" then "file" else undotted;
in
builtins.substring 0 200 nonEmpty
