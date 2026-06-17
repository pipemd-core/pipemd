# AGENTS.md

Pure Go implementation of RFC-9562 UUIDs (versions 1, 3, 4, 5, 6, 7): generate, parse, and serialize.

## Repository layout
- `uuid.go` — core `UUID` type (`[16]byte`), version constants, `Nil`, `FromString`/`String`, equality.
- `generator.go` — `NewV1`…`NewV7` constructors and the pluggable `Generator`/`Gen` internals (epoch math, HW-addr lookup, randomness).
- `codec.go` — byte and text encode/decode: `MarshalText`/`UnmarshalText`, `MarshalBinary`/`UnmarshalBinary`, `FromBytes`.
- `sql.go` — `database/sql/driver` integration (`Scan`, `Value`) so `UUID` is a valid SQL column value.
- `error.go` — string-typed `Error` values (`ErrInvalidFormat`, `ErrIncorrectLength`, …) retained for back-compat string matching.
- `*_test.go` — table-driven tests, one per source file (`uuid_test.go`, `generator_test.go`, `codec_test.go`, `parse_test.go`, `sql_test.go`, `error_test.go`).
- `go.mod` — module `github.com/gofrs/uuid/v5`, `go 1.19`.
- `.github/workflows/` — CI (`go.yml`), CodeQL, dependency-review, OpenSSF scorecard; `.pre-commit-config.yaml` runs golangci-lint + gitleaks.

## Build / test / lint
- `go build ./...`
- `go test ./... -race -coverprofile=coverage.txt -covermode=atomic`
- `gofmt -l *.go`
- `golangci-lint run` (also enforced via pre-commit)

## Key conventions
- Single flat package `uuid`; no subpackages. Add new code to the relevant top-level `.go` file (or a new one) with a matching `*_test.go`.
- Minimum Go 1.19 per `go.mod`; CI matrix covers Go 1.21 and 1.22.
- Error messages must stay byte-for-byte stable — `Error` is a `string` type and downstream code matches the text.
- Public API is backwards compatible within the major version (v5): prefer adding functions over changing signatures.
- Keep the MIT copyright header on every source file; run code through `gofmt`/`golangci-lint` before committing.
