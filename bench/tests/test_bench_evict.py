"""Bench grade spec for the eviction-callback task.

Run with: PYTHONPATH=src python3 -m pytest tests/test_bench_evict.py -q
"""
from cachetools import FIFOCache, LRUCache


def test_fifo_evicts_oldest_with_callback():
    seen = []
    cache = FIFOCache(maxsize=2, on_evict=lambda k, v: seen.append((k, v)))
    cache["a"] = 1
    cache["b"] = 2
    cache["c"] = 3
    assert seen == [("a", 1)]


def test_lru_evicts_least_recently_used():
    seen = []
    cache = LRUCache(maxsize=2, on_evict=lambda k, v: seen.append((k, v)))
    cache["a"] = 1
    cache["b"] = 2
    _ = cache["a"]  # touch "a"; "b" is now least-recently-used
    cache["c"] = 3
    assert seen == [("b", 2)]


def test_omitting_callback_does_not_raise():
    cache = LRUCache(maxsize=2)  # no on_evict
    cache["a"] = 1
    cache["b"] = 2
    cache["c"] = 3  # would evict; must not raise
    assert "a" not in cache
    assert cache["b"] == 2


def test_callback_not_invoked_on_explicit_delete():
    seen = []
    cache = LRUCache(maxsize=4, on_evict=lambda k, v: seen.append((k, v)))
    cache["a"] = 1
    del cache["a"]  # explicit delete — not capacity-driven eviction
    assert seen == []


def test_callback_receives_value_not_none():
    seen = []
    cache = FIFOCache(maxsize=1, on_evict=lambda k, v: seen.append((k, v)))
    cache["k"] = {"nested": "object"}
    cache["k2"] = 42
    assert seen == [("k", {"nested": "object"})]
