# AGENTS.md

Orientation for AI coding agents working on the **cachetools** library.

## Purpose

Extensible memoizing collections (LRU, LFU, FIFO, RR, TTL, TLRU caches) plus the `cached`/`cachedmethod` decorators for Python — a richer alternative to `functools.lru_cache`.

## Repository layout

- `src/cachetools/__init__.py` — the public API: the `Cache` base class, six cache strategies, and the `cached`/`cachedmethod` decorators. Most code lives here.
- `src/cachetools/keys.py` — key functions (`hashkey`, `typedkey`, `methodkey`, `typedmethodkey`).
- `src/cachetools/_cached.py`, `_cachedmethod.py` — internal wrapper implementations (leading `_` = private).
- `src/cachetools/func.py` — `functools.lru_cache`-style convenience decorators (`fifo_cache`, `lru_cache`, etc.).
- `tests/` — `unittest`-based; shared behavior mixins are in `tests/__init__.py`, with one `test_<name>.py` per cache/decorator.
- `docs/` — Sphinx sources (`index.rst`, `conf.py`); built on ReadTheDocs.
- `setup.cfg` — package metadata, `python_requires = >=3.9`, and flake8 config (max-line-length 80).
- `tox.ini` — defines the test/lint/docs environments; CI simply runs `tox`.

## Build / test / lint commands

- Run tests: `pytest --cov=cachetools --cov-report=term-missing tests/`
- Run the whole CI matrix locally: `tox`
- Lint: `flake8` (config in `setup.cfg`; rules include `flake8-black` and `flake8-import-order`)
- Build docs: `sphinx-build -W -b html -d docs/_build/doctrees docs docs/_build/html`
- Typecheck: none — types ship separately as `types-cachetools`; the source itself is unannotated.

## Key conventions

- Target Python 3.9–3.13 (plus pypy3.9/3.10); never use syntax/stdlib newer than 3.9.
- `src/` layout: the importable package is `src/cachetools/`, not the repo root. Tests import it as bare `cachetools` (install editable or run from an env where it's on the path).
- Style is `black` (line length 80); flake8 import-order is enforced — run `flake8` before committing.
- New cache strategies subclass `Cache` (or `_TimedCache`) **inside `__init__.py`**, get added to `__all__`, and are paired with a `tests/test_<name>.py` built on the mixins in `tests/__init__.py`.
- Encapsulation via name-mangled double-underscore attributes (`__data`, `__order`, …) is pervasive — preserve it when touching internals.
