# OpenCode GVS5H

A JavaScript port of the **code-solving branch** of the [GVS5H v2 multiagent solver](https://github.com/slee-persis/GVS5H/blob/master/codebase/v2-current/escalation/multiagent.py), packaged as an OpenCode plugin. The original is MIT licensed; see [LICENSE](LICENSE).

This is a real OpenCode plugin with a `gvs5h_solve` tool. It runs the algorithm in code rather than asking the current agent to imitate it:

1. A manager creates a plan and task list.
2. A fresh, same-model worker proposes distinct approaches without writing code.
3. A fresh manager call chooses one task.
4. A fresh worker returns a complete Python solution and curated notes.
5. The plugin runs supplied stdin/stdout samples and feeds the verdict to the next manager call.
6. The manager either finishes or assigns another worker. The plugin enforces the upstream 10-round ceiling and repeated-task stop, then invokes a finalization worker if needed.

Each model call has its own child OpenCode session and no tool access. A private ledger stores `task.md`, `plan.md`, `notes.md`, `solution.py`, `tasks.json`, and a transcript under `~/.local/state/opencode-gvs5h/runs/` (or `$XDG_STATE_HOME/opencode-gvs5h/runs/`). The manager, ideation worker, and implementation workers use the **same model selected in the parent OpenCode session**. The parent agent receives the code, sample result, round count, and ledger path and remains responsible for the user-facing answer.

## Install

Clone this repository, then run:

```sh
./install.sh
```

The installer copies the plugin into OpenCode's global `plugins/` directory. Restart OpenCode. Your OpenCode config must have `@opencode-ai/plugin` available (OpenCode commonly installs it in its config directory for custom tools). Local plugin loading is documented in the [OpenCode plugin guide](https://docs.opencode.ai/docs/plugins/).

## Use

Ask OpenCode to use `gvs5h_solve` on a complete Python stdin/stdout problem and provide public samples. The tool accepts:

```json
{
  "problem": "Read two integers and print their sum.",
  "samples": [{ "input": "2 3\n", "output": "5" }],
  "maxIters": 10
}
```

Samples are optional, but without them the plugin has no independent correctness check and reports the result as unverified. A passing sample is evidence only for that sample. The generated program is run with `python3` on the machine hosting OpenCode, matching the upstream verifier's execution model; use this on trusted problems.

The upstream algorithm is designed for self-contained competitive-programming problems and produces a complete `solution.py`. It does **not** define a general repository-editing or homelab-administration mode. This port deliberately keeps that boundary. For such tasks, use OpenCode's ordinary tools and independent review; do not claim that work was run through the published GVS5H solver.

## Verification

Run `npm test` for parser, sample verifier, manager/worker loop, and repeated-task checks. The plugin was also loaded in OpenCode 1.19.3 with a local Qwen3.8 Flash Next model: a live addition problem completed in one worker round, five model calls, and passed its supplied sample.

## Port notes

The control flow and ledger limits follow `codebase/v2-current/escalation/multiagent.py` at upstream commit `707e21296bfa032250f10bdde4afaff7ec998f71`. OpenCode child sessions replace the original provider's `chat()` calls. The plugin gives each run a unique workspace rather than resetting a problem-hash directory. It does not include the upstream mathematical-answer branch, benchmark runner, or model-provider adapters. These integration differences mean this is a port of the published **Python code-solving algorithm**, not a byte-for-byte copy of every GVS5H repository component.
