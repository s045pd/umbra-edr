# Third-party notices

## RFC 8785 JSON canonicalization

The following local files are adapted from `canonicalize` 4.0.0:

- `extension/src/bg/snapshot/canonicalize.js`
- `cookie-sync-extension/src/lib/canonicalize.js`

Upstream: <https://github.com/erdtman/canonicalize/tree/v4.0.0>  
License: Apache License 2.0; see `third_party/canonicalize/LICENSE`.

The Go server uses the RFC 8785 reference implementation at commit
`19d51d7fe467d4706a3ff08adf8a748f29fc21e0`:

- Module: `github.com/cyberphone/json-canonicalization`
- Package: `go/src/webpki.org/jsoncanonicalizer`
- Upstream: <https://github.com/cyberphone/json-canonicalization>
- License: Apache License 2.0 (included in the downloaded Go module).
