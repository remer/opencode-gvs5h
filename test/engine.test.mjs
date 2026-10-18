import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sections, parseTasks, runSamples, solve } from "../plugin/gvs5h/engine.mjs";

test("parses the upstream section and task protocol", () => {
  assert.deepEqual(sections("<think>ignore</think>\n### STATUS\ncontinue\n### NEXT\nUse DP\n### TASKS\n- [done] inspect\n- [todo] implement"), {
    STATUS: "continue", NEXT: "Use DP", TASKS: "- [done] inspect\n- [todo] implement",
  });
  assert.deepEqual(parseTasks("- [done] inspect\n- [todo] implement").map(x => x.status), ["done", "pending"]);
});

test("sample verifier reports a concrete first failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gvs5h-test-"));
  const path = join(root, "solution.py");
  await import("node:fs/promises").then(fs => fs.writeFile(path, "print(7)\n"));
  assert.deepEqual(await runSamples(path, [{ input: "", output: "8" }]), {
    ran: true, passed: 0, total: 1, fail: { input: "", expected: "8", got: "7" },
  });
});

test("manager, fresh worker, sample feedback, and final artifact run end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "gvs5h-test-"));
  const roles = [];
  const replies = {
    primary_plan: ["### PLAN\nRead two integers and sum them.\n### TASKS\n- Implement addition"],
    ideation: ["### NOTES\n- Addition is direct.\n### NEXT\n- Parse integers\n- Use map"],
    primary_manage: [
      "### STATUS\ncontinue\n### NEXT\nImplement addition\n### TASKS\n- [todo] Implement addition",
      "### STATUS\ndone\n### NEXT\n\n### TASKS\n- [done] Implement addition",
    ],
    worker: ["### CODE\n```python\nimport sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n```\n### NOTES\n- Addition implemented.\n### NEXT\nnone\n### STATUS\nsolved"],
  };
  const result = await solve({
    problem: "Add two integers.", tests: [{ input: "2 3\n", output: "5" }], workspaceRoot: root,
    chat: async ({ role, user }) => { roles.push(role); if (role === "primary_manage" && roles.filter(x => x === role).length === 2) assert.match(user, /SAMPLE TESTS: PASSED/); return { text: replies[role].shift(), finishReason: "stop" }; },
  });
  assert.deepEqual(roles, ["primary_plan", "ideation", "primary_manage", "worker", "primary_manage"]);
  assert.equal(result.status, "done");
  assert.equal(result.rounds, 1);
  assert.equal(result.samples.passed, 1);
  assert.match(await readFile(join(result.workspace, "solution.py"), "utf8"), /print\(a \+ b\)/);
});

test("repeated manager task stops the loop and invokes finalize", async () => {
  const root = await mkdtemp(join(tmpdir(), "gvs5h-test-"));
  let workers = 0;
  const result = await solve({
    problem: "Print 42.", workspaceRoot: root,
    chat: async ({ role }) => {
      if (role === "primary_plan") return { text: "### PLAN\nPrint literal.\n### TASKS\n- Write program" };
      if (role === "ideation") return { text: "### NOTES\nLiteral works.\n### NEXT\n- Print literal" };
      if (role === "primary_manage") return { text: "### STATUS\ncontinue\n### NEXT\nWrite program\n### TASKS\n- [todo] Write program" };
      if (role === "worker") { workers++; return { text: "### CODE\n```python\nprint(42)\n```\n### NOTES\n- Done\n### NEXT\nnone\n### STATUS\nsolved" }; }
      if (role === "finalize") return { text: "### CODE\n```python\nprint(42)\n```\n### NOTES\n- Done\n### NEXT\nnone\n### STATUS\nsolved" };
      throw new Error(role);
    },
  });
  assert.equal(workers, 1);
  assert.equal(result.stopReason, "repeated task");
});
