# Contributing to Umbra

Thank you for your interest in contributing. This document explains the
development process and standards for the project.

---

## Code of Conduct

By participating you agree to act professionally and respectfully toward other
contributors. Harassment and abuse will not be tolerated.

---

## Authorized Use Reminder

Umbra is a dual-use security tool. All contributions must be made with the
understanding that the software is intended for **authorized monitoring
environments only**. See [SECURITY.md](SECURITY.md) for the full policy.

---

## Branch Model

- `master` is the stable branch. All pull requests target `master`.
- Create a feature branch from `master`:

  ```bash
  git checkout -b feat/your-feature-name
  ```

- Keep branches short-lived and focused on a single change.
- Rebase onto `master` before opening a PR if your branch has fallen behind.

---

## Development Setup

Run the one-shot bootstrap:

```bash
./setup.sh
```

This validates prerequisites (Go 1.25+, Node 20+, Docker), copies `.env.example`
to `.env` if absent, downloads Go modules, and installs Node dependencies.

### Go backend

```bash
cd umbra-server
make build        # compile binary to ./bin/umbra-server
make test         # run all tests (~3s)
make test-race    # run with race detector (~10s)
make vet          # go vet
make lint         # golangci-lint (if installed)
make fmt          # gofmt -l -w
make smoke        # start binary and hit /health
```

### Vue frontend

```bash
cd gui-next
npm run typecheck   # vue-tsc --noEmit
npm run build       # production build to ../gui/dist/
npm run lint        # eslint
npm run dev         # dev server at :5173 (proxied to :8118)
```

### Full stack

```bash
docker compose up --build
```

---

## Pull Request Process

1. **Fork** the repository and create a branch from `master`.
2. **Implement** your change with tests (see below).
3. **Verify** everything passes locally before pushing:
   - Go: `make vet test`
   - Frontend: `npm run typecheck && npm run build`
4. **Push** your branch and open a pull request against `master`.
5. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
6. Address review feedback. At least one maintainer approval is required before
   merging.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body explaining why, not what>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

Example:

```
feat: add configurable screenshot quality parameter

Allows operators to trade off storage size against image fidelity via
the SCREENSHOT_QUALITY env var (1-100, default 80).
```

---

## Testing Expectations

### Go

- All new packages must have unit tests.
- Use the in-memory SQLite driver (`gorm.io/driver/sqlite`) for database tests —
  no Docker required for unit tests.
- Integration tests live under `umbra-server/test/`.
- Do not reduce existing test coverage. Run `make test-race` before pushing.
- Minimum expectation: new exported functions and handlers have at least one
  happy-path and one error-path test.

### Vue frontend

- Type-check must pass: `npm run typecheck`
- Build must succeed: `npm run build`
- For new composables or utility functions, add unit tests.
- Visual changes should be manually verified in both light and dark themes.

---

## Code Style

### Go

- `gofmt` for formatting — run `make fmt` before committing.
- Follow standard Go idioms: short variable names in small scopes, early
  returns, explicit error handling.
- No `panic` in library code; return errors up the call stack.
- Keep functions under 50 lines; extract helpers for complex logic.
- Use `internal/` packages to enforce package boundaries.

### TypeScript / Vue

- Strict TypeScript (`vue-tsc --noEmit` must pass with zero errors).
- Composition API + `<script setup>` throughout — no Options API.
- All API response shapes are defined in `gui-next/src/types/api.ts`.
- CSS: use Tailwind utility classes; custom styles go in
  `gui-next/src/assets/styles.css` as `@theme` tokens — no hex literals in
  templates.
- Components: PascalCase filenames, one component per file.

---

## Reporting Issues

Use the GitHub issue templates:

- [Bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.md)

For security vulnerabilities, do **not** open a public issue. Follow the
[security reporting policy](SECURITY.md) instead.

---

## Developer Certificate of Origin

By submitting a pull request you certify that:

1. The contribution is your own original work, or you have the right to submit
   it under the MIT license.
2. You understand and agree that the contribution is public and may be
   redistributed under the MIT license.

If you agree, add a sign-off to your commits:

```
git commit -s -m "feat: your change"
```

This appends `Signed-off-by: Your Name <you@example.com>` to the commit
message, satisfying the [DCO](https://developercertificate.org/).
