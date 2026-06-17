Callers of this cache library want to observe when entries are evicted for capacity, e.g. to log or invalidate downstream state.

Add an opt-in eviction notification: when constructing a cache, a user may supply a `on_evict` keyword argument whose value is a callback receiving `(key, value)` for each entry removed because the cache is over capacity. The notification must fire only for capacity-driven eviction, not for explicit `del cache[key]`. The feature must be opt-in and must not change current behaviour when the callback is omitted; the existing test suite under `tests/` must still pass.

Study the `Cache` base class and its concrete subclasses in `src/cachetools/__init__.py` to find where capacity-driven eviction happens and thread the option through consistently. Follow the existing constructor signatures and style; do not introduce type annotations beyond what the file already uses.

A grader pytest constructs `LRUCache` and `FIFOCache` with the callback and asserts it receives the evicted `(key, value)` pairs in eviction order when more items are inserted than `maxsize`; omitting the callback must not raise. `ruff check src/` must be clean.
