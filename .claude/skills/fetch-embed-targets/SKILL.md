---
name: fetch-embed-targets
description: Pull host extensions from s045pd/umbra-embed-targets into a local embed-targets/ directory so the Umbra server's embed packaging feature has hosts to merge into. Use when EXTENSION_SRC_PATH would otherwise be empty or when developing the embed packaging code path.
---

# Fetch embed targets

## What this does

The Umbra server's embed-packaging feature (`umbra-server/internal/api/extension.go`)
takes one of the 12 host extensions in the companion repo
[`s045pd/umbra-embed-targets`](https://github.com/s045pd/umbra-embed-targets)
and injects the Umbra Sensor into its background service worker. The host
extensions are NOT bundled with this repo — they live separately because
they're independent Chrome extensions with their own release cadence.

## When to use

- First-time setup, before testing the "Embed download" web panel feature
- After a new embed target has been added to `s045pd/umbra-embed-targets`
- Whenever `embed-targets/` is empty / out of date
- CI / fresh clone scenarios

## Steps

```bash
./scripts/embed-targets/fetch.sh
```

This clones or fast-forwards updates `s045pd/umbra-embed-targets` into
`./embed-targets/`. The directory is gitignored — never committed.

To force re-clone (drops local changes):

```bash
./scripts/embed-targets/fetch.sh --force
```

## Bring-your-own-host

You can drop any MV3 extension under `embed-targets/<name>/` and the server's
packaging pipeline will pick it up automatically — the directory just needs a
`manifest.json` and an `icons/` folder with at least 16/48/128 PNG.

## Telling the server where to look

When running outside Docker:

```bash
export EXTENSION_SRC_PATH=$(pwd)/embed-targets
cd umbra-server && ./bin/umbra-server
```

Inside Docker the default is `/work/extensions` (set by the Dockerfile);
docker-compose.yaml mounts the local `embed-targets/` to that path.

## Don't

- Don't add new host extensions to this repo. PR them to
  `s045pd/umbra-embed-targets` instead so they stay reusable across forks.
- Don't commit the fetched `embed-targets/` directory. It's gitignored for a
  reason — it's a third-party-style dependency, not code we maintain here.
