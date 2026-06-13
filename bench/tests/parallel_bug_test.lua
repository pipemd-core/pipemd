-- parallel_bug_test.lua
-- Reproduces the BranchNode:success(self) colon bug in parallel.lua
-- Run from the repo root: lua bench/tests/parallel_bug_test.lua

package.path = "./?.lua;./?/init.lua;" .. package.path

_G._BehaviourTreeGlobals = {}
_G._BehaviourTreeImports = _G._BehaviourTreeImports or {}

local BehaviourTree = require("lib")
local Node = BehaviourTree.Node
local Parallel = BehaviourTree.Parallel

-- Two children that immediately report success
local child1 = Node:new({
  name = "child1",
  run = function(self, state)
    self.success()
  end,
})

local child2 = Node:new({
  name = "child2",
  run = function(self, state)
    self.success()
  end,
})

-- Parallel with waitForAll = true
local parallel = Parallel:new({
  name = "testParallel",
  childNodes = { child1, child2 },
  properties = {
    waitForAll = function()
      return true
    end,
  },
})

local tree = BehaviourTree:new({
  root = parallel,
  name = "testTree",
})
tree:setStateObject({})
tree:setDebugLevel(0)

-- Run the tree — this will crash if the colon bug is present
local ok, err = pcall(function()
  tree:run()
end)

if not ok then
  print("FAIL: " .. tostring(err))
  os.exit(1)
end

if not parallel.finished then
  print("FAIL: Parallel node did not finish")
  os.exit(1)
end

print("PASS")
os.exit(0)
