# AGENTS.md

## Purpose
A Lua library implementing behavior trees for game AI / robotics, designed to load projects exported from the Behavior3+ visual editor.

## Repository layout
- `lib/behaviour_tree.lua` — core `BehaviourTree` class and public API (`LoadBehavior3Project`, `:run`, status enum).
- `lib/node_types/` — one file per node type: base `node.lua`, `branch_node.lua`, composites (`sequence`, `parallel`, `run_random`), decorators, and `interrupt_decorator.lua`.
- `lib/nodes/nodes.lua` — registers the editor's premade node types into the registry.
- `lib/registry.lua` — name→class lookup used to resolve nodes referenced by string.
- `lib/behavior3_parser.lua` — converts a Behavior3+ editor JSON table into tree node graphs.
- `lib/middleclass.lua` — vendored OOP library; all classes derive from it.
- `lib/init.lua` — Love2D folder-require shim; `imgs/`, `.github/`, `README.md` hold docs and templates.

## Build / test / lint
Pure-Lua interpreted library — no build step, no test suite, no CI.
- Smoke / load check: `lua -e "require('lib.behaviour_tree')"`
- Lua version in use: `lua -v` (Lua 5.4; code falls back across `load`/`loadstring`/`setfenv`)
- Lint (optional, no config committed): `luacheck lib/`
- Format (optional, no config committed): `stylua lib/`

## Key conventions
- Written against lua-language-server; `---@` annotations are used and should be kept accurate.
- OOP via vendored `middleclass` (`class('Name', Parent)`); define methods as `function ClassName:method(...)`.
- Modules locate siblings through `...`, never hardcoded paths: `local _PACKAGE = (...):match("^(.+)[%./][^%./]+")`.
- Adding a node type: create `lib/node_types/<name>.lua`, then expose (`BehaviourTree.Xxx = require(...)`) and `Registry.register(...)` it in `lib/behaviour_tree.lua`.
- `_BehaviourTreeGlobals` / `_BehaviourTreeImports` are intentional global channels for environment overrides (clock, code loader) — do not localize them.
