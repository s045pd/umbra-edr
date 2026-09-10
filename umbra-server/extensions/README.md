# Extension sources

This directory is a packaging input, not a second copy of the Sensor.

- Local `make run` synthesizes `.extensions-dev/` from the repo-root
  `extension/` and `cookie-sync-extension/` trees (see `internal/api/extension.go`).
- Docker Compose bind-mounts those trees into `/work/extensions/{main,cookie-sync}`.
- Host extensions for embed packaging are fetched with
  `./scripts/embed-targets/fetch.sh` into repo-root `/embed-targets/`
  (gitignored). Point `EXTENSION_SRC_PATH` at that directory when you
  need them.

Do not commit machine-local symlinks here.
