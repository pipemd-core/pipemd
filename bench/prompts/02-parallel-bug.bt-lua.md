Users report that `Parallel` behaviour-tree nodes crash at runtime in trees whose `waitForAll` property evaluates to `true` and whose children report success.

Reproduce the crash, locate the defective code, and fix it. You will need to understand how the other node types (e.g. `Sequence`, decorators) signal success/failure upward, and how `Parallel` is meant to aggregate its children — read the node implementations under `lib/node_types/` and the entry point in `lib/` to find the signalling convention and where `Parallel` deviates from it. The fix should not change the public API of `Parallel`.

A grader script builds a tree with a `Parallel` node (`waitForAll` returning `true`) over two children that each call their success callback, then runs the tree. The tree must run to completion with no error and the parallel node must report finished.
