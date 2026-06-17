Consumers of this UUID package need to order UUID values.

Provide (1) a method on the `UUID` type named `Compare` that reports this UUID's ordering relative to another as `-1`, `0`, or `+1`, and (2) a package-level function named `Sort` that sorts a slice of `UUID`s in place into ascending order using that ordering. Ordering follows the natural big-endian sequence of the 128 bits.

Match the conventions already used in `uuid.go` — receiver style for accessors, Godoc comments on every exported symbol, no new external dependencies. The method must not allocate.

A grader test exercises the ordering method on less-than, equal, and greater-than cases (including the zero-valued `UUID{}`) and sorts an unsorted slice into order; an empty slice must not panic. `go vet ./...` and `gofmt -l *.go` must be clean.
