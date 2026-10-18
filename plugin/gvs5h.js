import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { solve } from "./gvs5h/engine.mjs";

function unwrap(result, operation) {
  if (result.error) throw new Error(`${operation}: ${JSON.stringify(result.error)}`);
  if (!result.data) throw new Error(`${operation}: empty response`);
  return result.data;
}

export const GVS5H = async ({ client }) => {
  const temperatures = new Map();
  return {
  "chat.params": async (input, output) => {
    const temperature = temperatures.get(input.sessionID);
    if (temperature !== undefined) output.temperature = temperature;
  },
  tool: {
    gvs5h_solve: tool({
      description: "Run the actual GVS5H v2 manager/worker solver for a self-contained Python stdin/stdout programming problem. Uses fresh same-model OpenCode sessions, a shared ledger, sample-test feedback, at most 10 rounds, and a repeated-task guard. Returns the resulting Python program and verifier result. Do not use for ordinary chat or repository/homelab changes.",
      args: {
        problem: tool.schema.string().min(1).describe("Complete programming problem statement"),
        samples: tool.schema.array(tool.schema.object({ input: tool.schema.string(), output: tool.schema.string() })).default([]).describe("Public stdin/stdout examples for independent verification"),
        maxIters: tool.schema.number().int().min(1).max(10).default(10),
      },
      async execute(args, context) {
        const history = unwrap(await client.session.messages({ path: { id: context.sessionID }, query: { directory: context.directory, limit: 10 } }), "read parent messages");
        const model = [...history].reverse().find(m => m.info.role === "user" && m.info.model)?.info.model;
        if (!model) throw new Error("Cannot identify the parent model; GVS5H requires every role to use that same model");
        const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
        let calls = 0;
        const chat = async ({ role, system, user, temperature, signal }) => {
          const created = unwrap(await client.session.create({ body: { parentID: context.sessionID, title: `GVS5H ${role}` }, query: { directory: context.directory } }), `create ${role} session`);
          temperatures.set(created.id, temperature);
          let abort = () => { void client.session.abort({ path: { id: created.id }, query: { directory: context.directory } }); };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            const response = unwrap(await client.session.prompt({
              path: { id: created.id }, query: { directory: context.directory },
              body: {
                model, agent: "build", system,
                tools: { bash: false, read: false, glob: false, grep: false, edit: false, write: false, task: false, skill: false, gvs5h_solve: false, vpn_web_search: false, vpn_web_fetch: false },
                parts: [{ type: "text", text: user }],
              },
            }), `${role} prompt`);
            if (response.info.error) throw new Error(`${role}: ${JSON.stringify(response.info.error)}`);
            const text = response.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
            if (!text.trim()) throw new Error(`${role}: empty model response`);
            calls++;
            return { text, finishReason: response.info.finish };
          } finally {
            temperatures.delete(created.id);
            signal?.removeEventListener("abort", abort);
          }
        };
        const result = await solve({ problem: args.problem, tests: args.samples, chat, workspaceRoot: join(stateHome, "opencode-gvs5h", "runs"), maxIters: args.maxIters, signal: context.abort });
        return {
          title: `GVS5H: ${result.status}, ${result.rounds} rounds`,
          output: `${result.answer || "No solution was produced."}\n\nStatus: ${result.status}; rounds: ${result.rounds}; calls: ${calls}; samples: ${result.samples.ran ? `${result.samples.passed}/${result.samples.total}` : "not supplied"}; stop: ${result.stopReason || "none"}; workspace: ${result.workspace}. ${result.complete ? "Verifier conditions passed." : "Do not treat this as verified."}`,
          metadata: { status: result.status, rounds: result.rounds, calls, samples: result.samples, workspace: result.workspace, complete: result.complete },
        };
      },
    }),
  },
};
};
