// Bench grade spec for the Compare + Sort task.
// Run with: go test -run 'TestBench' ./...
package uuid

import (
	"slices"
	"testing"
)

func sign(n int) int {
	if n > 0 {
		return 1
	}
	if n < 0 {
		return -1
	}
	return 0
}

func TestBenchCompare(t *testing.T) {
	zero := UUID{}                                                // {0..0}
	lsb := UUID{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}   // smallest nonzero
	msb := UUID{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}   // MSB set → largest
	other := UUID{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1} // == lsb

	cases := []struct {
		name string
		a, b UUID
		want int // normalized sign
	}{
		{"equal-zero", zero, zero, 0},
		{"equal-nonzero", lsb, other, 0},
		{"zero-lt-lsb", zero, lsb, -1},
		{"lsb-gt-zero", lsb, zero, 1},
		{"lsb-lt-msb", lsb, msb, -1},
		{"msb-gt-lsb", msb, lsb, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sign(tc.a.Compare(tc.b))
			if got != tc.want {
				t.Fatalf("Compare(%v, %v) sign = %d, want %d", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestBenchSort(t *testing.T) {
	in := []UUID{
		{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		{},
		{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1},
	}
	Sort(in)
	less := func(a, b UUID) int { return a.Compare(b) }
	if !slices.IsSortedFunc(in, less) {
		t.Fatalf("slice not sorted ascending: %v", in)
	}

	// empty / nil must not panic
	Sort(nil)
	Sort([]UUID{})
}
