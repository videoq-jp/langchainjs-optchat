const { test } = require("node:test");
const assert = require("node:assert/strict");
const { requireCiSuccess } = require("./dependency-automation.cjs");
test("CI aggregate fails closed for missing, failed, skipped and additional jobs", () => {
  const jobs = [
    "test",
    "package",
    "workflow-security",
    "supply-chain",
  ];
  const good = Object.fromEntries(jobs.map((j) => [j, { result: "success" }]));
  assert.doesNotThrow(() => requireCiSuccess(good));
  for (const job of jobs) {
    for (const result of ["failure", "skipped", "cancelled"])
      assert.throws(() => requireCiSuccess({ ...good, [job]: { result } }));
    const missing = { ...good };
    delete missing[job];
    assert.throws(() => requireCiSuccess(missing));
  }
  assert.throws(() =>
    requireCiSuccess({ ...good, extra: { result: "success" } }),
  );
});

test("aggregate accepts exactly the real workflow dependencies", () => {
  const fs = require("node:fs"); const path = require("node:path");
  const workflow = fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8");
  const dependencies = /ci-success:[\s\S]*?needs: \[([^\]]+)\]/.exec(workflow)[1].split(",").map(x => x.trim());
  assert.doesNotThrow(() => requireCiSuccess(Object.fromEntries(dependencies.map(x => [x, {result: "success"}]))));
});
