// Port of GVS5H v2-current/escalation/multiagent.py (MIT).
// Original: https://github.com/slee-persis/GVS5H
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_TASKS = 12;
const MAX_PLAN = 4000;
const MAX_NOTES = 8000;
const MAX_ANSWER = 20000;

export function stripThink(s) { return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); }
export function stripCode(s) { return s.replace(/```[\s\S]*?```/g, "[code omitted -- approach only]").trim(); }
export function sections(s) {
  const out = {}; let key = null; let lines = [];
  for (const line of stripThink(s).split(/\r?\n/)) {
    const m = line.trim().match(/^#{1,3}\s*([A-Za-z_]+)\s*$/)
      || line.trim().match(/^\*\*([A-Za-z_]+)\*\*\s*:?\s*$/)
      || line.trim().match(/^([A-Z_]{3,})\s*:\s*$/);
    if (m) { if (key) out[key] = lines.join("\n").trim(); key = m[1].toUpperCase(); lines = []; }
    else lines.push(line);
  }
  if (key) out[key] = lines.join("\n").trim();
  return out;
}
export function bullets(s) { return [...s.matchAll(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/gm)].map(x => x[1].trim()); }
export function extractPython(s) { return stripThink(s).match(/```(?:python)?\s*\n([\s\S]*?)```/)?.[1]?.trim() || ""; }
export function parseTasks(s) {
  return bullets(s).slice(0, MAX_TASKS).map((b, i) => {
    const m = b.match(/^\[\s*([a-z_ ]+?)\s*\]\s*(.*)$/i);
    const raw = m?.[1]?.toLowerCase().replace(/[ _]/g, "");
    return { id: i + 1, desc: (m ? m[2] : b).trim(), status: raw === "done" ? "done" : raw === "wip" || raw === "inprogress" ? "in_progress" : "pending", result: "" };
  }).filter(x => x.desc);
}
function addTasks(tasks, descs) {
  const have = new Set(tasks.map(x => x.desc.toLowerCase()));
  for (const desc0 of descs) {
    const desc = desc0.trim();
    if (desc && !have.has(desc.toLowerCase()) && tasks.length < MAX_TASKS) {
      tasks.push({ id: Math.max(0, ...tasks.map(x => x.id)) + 1, desc, status: "pending", result: "" });
      have.add(desc.toLowerCase());
    }
  }
}
async function runOne(codePath, input, timeoutMs) {
  return new Promise(resolve => {
    const proc = spawn("python3", [codePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { proc.kill("SIGKILL"); finish({ got: "<timed out (>10s)>", exit: null }); }, timeoutMs);
    proc.on("error", e => finish({ got: `<error: ${e.message}>`, exit: null }));
    proc.stdout.on("data", d => { stdout += d.toString().slice(0, 100000); if (stdout.length > 100000) proc.kill("SIGKILL"); });
    proc.stderr.on("data", d => { stderr += d.toString().slice(0, 2000); });
    proc.on("close", code => finish({ got: code && !stdout ? `<runtime error: ${stderr.slice(0, 200)}>` : stdout.trim(), exit: code }));
    proc.stdin.end(input);
  });
}
export async function runSamples(codePath, tests, timeoutMs = 10000) {
  if (!tests?.length) return { ran: false };
  let passed = 0, fail = null;
  for (const t of tests) {
    const r = await runOne(codePath, t.input || "", timeoutMs);
    if (r.got.trim() === (t.output || "").trim()) passed++;
    else if (!fail) fail = { input: (t.input || "").slice(0, 600), expected: (t.output || "").trim().slice(0, 400), got: r.got.slice(0, 400) };
  }
  return { ran: true, passed, total: tests.length, fail };
}
function sampleFeedback(r) {
  if (!r?.ran) return "";
  if (r.passed === r.total) return `[SAMPLE TESTS: PASSED all ${r.total} public samples -- the solution looks correct.] `;
  return `[SAMPLE TESTS: FAILED -- passed ${r.passed}/${r.total}. The current solution is WRONG. First failing case: input=${JSON.stringify(r.fail.input)} expected=${JSON.stringify(r.fail.expected)} got=${JSON.stringify(r.fail.got)}. Fix the bug or, if this approach keeps failing, switch to a DIFFERENT approach.] `;
}

export async function solve({ problem, tests = [], chat, workspaceRoot, maxIters = 10, signal, onProgress = () => {} }) {
  if (!problem?.trim()) throw new Error("problem is required");
  if (typeof chat !== "function") throw new Error("chat callback is required");
  const ws = join(workspaceRoot, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(ws, { recursive: true, mode: 0o700 });
  const read = async n => readFile(join(ws, n), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  const write = async (n, s) => writeFile(join(ws, n), s, { mode: 0o600 });
  const record = async r => appendFile(join(ws, "transcript.jsonl"), JSON.stringify({ t: Date.now(), ...r }) + "\n", { mode: 0o600 });
  for (const n of ["task.md", "notes.md", "transcript.jsonl", "plan.md", "solution.py", "tasks.json"]) await write(n, "");
  await write("task.md", problem);
  await record({ meta: true, kind: "code", maxIters });
  const call = async (role, system, user, temperature) => {
    if (signal?.aborted) throw new Error("GVS5H aborted");
    const result = await chat({ role, system, user, temperature, signal });
    await record({ role, response: result.text, finishReason: result.finishReason });
    onProgress(role);
    return result;
  };
  const planPrompt = "You are the PRIMARY orchestrator (manager) of a small team of workers, all expert at competitive programming. Given a problem, produce a short overarching plan to solve it, then a task list the workers can pick up. Respond with EXACTLY these sections:\n### PLAN\n<3-6 sentence strategy>\n### TASKS\n<3-6 bullet tasks, each a concrete unit of work>";
  const planReply = (await call("primary_plan", planPrompt, problem, 0.3)).text;
  const planSec = sections(planReply);
  await write("plan.md", (planSec.PLAN || planReply.trim()).slice(0, MAX_PLAN));
  let tasks = []; addTasks(tasks, bullets(planSec.TASKS || ""));

  const ideatePrompt = "You are the FIRST WORKER. Do NOT solve the problem and do NOT write any code. Just think about it: identify the core difficulty, then list SEVERAL DISTINCT candidate approaches (genuinely different algorithms / data structures / problem reductions, not variations of one idea), and note pitfalls for each. Describe each approach in prose only -- absolutely no code blocks. Respond with EXACTLY:\n### NOTES\n<your analysis>\n### NEXT\n<bullet list of distinct approaches to try next>";
  const ideateReply = (await call("ideation", ideatePrompt, `PROBLEM:\n${problem}\n\nPLAN:\n${await read("plan.md")}`, 0.4)).text;
  const ideateSec = sections(ideateReply);
  await write("notes.md", `\n## ideation\n${stripCode(ideateSec.NOTES || ideateReply).slice(0, MAX_NOTES)}\n`);
  let proposals = bullets(ideateSec.NEXT || "").map(stripCode);

  async function manage(lastSummary) {
    const cur = (await read("solution.py")).trim();
    const taskLines = tasks.map(t => `- [${t.status === "done" ? "done" : "todo"}] ${t.desc}`).join("\n") || "(none)";
    const sys = "You are the PRIMARY orchestrator and manager. You OWN the task list and decide when the problem is solved. Review the current progress and the latest worker's result, then:\n"
      + "- The LATEST WORKER RESULT may include a SAMPLE TESTS verdict from actually running the code. Treat it as ground truth: only set STATUS 'done' if the solution PASSED the sample tests; if it FAILED, you MUST set STATUS 'continue' and choose a task that fixes the failing case or switches to a different approach.\n"
      + "- If the current solution is complete and correct, set STATUS to 'done'.\n"
      + "- Otherwise CURATE the task list: merge duplicates, drop finished or irrelevant items, mark completed ones [done], and fold in ONLY genuinely new sub-tasks from the proposals. Then choose the single most valuable next task.\n"
      + "- IMPORTANT: if the current solution keeps failing, or the last worker made no real progress, do NOT keep refining the same idea. Switch to a DIFFERENT approach (a different algorithm / data structure / reduction) from the notes, or ask for a new one. You have many rounds -- use them to try distinct approaches, not to polish a stuck one.\n"
      + "Respond with EXACTLY these sections:\n### STATUS\n<done|continue>\n### NEXT\n<exact text of the ONE task to do next; omit if done>\n### TASKS\n<curated list, one per line, each '- [done] ...' or '- [todo] ...'>";
    const usr = `PROBLEM:\n${problem}\n\nCURRENT SOLUTION:\n${cur || "(none yet)"}\n\nNOTES:\n${await read("notes.md")}\n\nCURRENT TASK LIST:\n${taskLines}\n\nLATEST WORKER RESULT: ${lastSummary}\n\nPROPOSED NEW STEPS:\n${proposals.map(p => `- ${p}`).join("\n") || "(none)"}`;
    const sec = sections((await call("primary_manage", sys, usr, 0.2)).text);
    tasks = parseTasks(sec.TASKS || "") .length ? parseTasks(sec.TASKS) : tasks;
    let status = sec.STATUS?.trim().toLowerCase().startsWith("done") ? "done" : "continue";
    if (status === "done" && !cur) status = "continue";
    let next = (bullets(sec.NEXT || "")[0] || sec.NEXT || "").replace(/^[-*]\s*/, "").trim();
    if (status === "continue" && !next) next = tasks.find(t => t.status !== "done")?.desc || "";
    if (!cur && !next) { status = "continue"; next = "Implement the full working solution for the most promising approach in the notes."; }
    await write("tasks.json", JSON.stringify(tasks, null, 2));
    return { status, next };
  }

  async function worker(task, finalize = false) {
    const cur = await read("solution.py");
    const notesFmt = "### NOTES\n<the COMPLETE notes file, rewritten. Keep what matters and DELETE what is superseded, disproven, or obvious. Use bullets without headings and stay under ~800 words.>\n";
    const sys = `You are a WORKER subagent, an expert competitive programmer. You share a workspace with the team. Build on current work and notes where useful -- but if your task is to try a different approach, write a FRESH solution for that approach instead of patching the stuck one. Respond with EXACTLY these sections:\n### CODE\n\`\`\`python\n<the FULL updated self-contained program>\n\`\`\`\n${notesFmt}### NEXT\n<bullet list of remaining steps, or 'none'>\n### STATUS\n<solved|continue>`;
    const goal = finalize ? "Produce the DEFINITIVE final solution now, using all notes and current work." : `Complete this task: ${task}`;
    const usr = `PROBLEM:\n${problem}\n\nPLAN:\n${await read("plan.md")}\n\nNOTES:\n${await read("notes.md")}\n\nCURRENT WORK:\n${cur || "(none yet)"}\n\nYOUR TASK: ${goal}`;
    const reply = await call(finalize ? "finalize" : "worker", sys, usr, 0.2);
    const sec = sections(reply.text);
    const code = extractPython(sec.CODE || "") || extractPython(reply.text);
    if (code) await write("solution.py", code + "\n");
    if (sec.NOTES && reply.finishReason !== "length") await write("notes.md", sec.NOTES.trim().slice(0, MAX_NOTES) + "\n");
    proposals = bullets(sec.NEXT || "").filter(x => x.toLowerCase() !== "none");
    let summary = `worker reported '${(sec.STATUS || "continue").trim().toLowerCase()}' on: ${task.slice(0, 80)}. ${(sec.NOTES || "").slice(0, 200)}`;
    if (reply.finishReason === "length" && !finalize) {
      const partial = stripThink(reply.text); const snippet = partial.length <= 9000 ? partial : partial.slice(0, 3500) + "\n...[middle omitted]...\n" + partial.slice(-5500);
      const cut = await call("cutoff_summary", "A worker's solution attempt was CUT OFF at the token limit. Summarize its partial attempt in 3-5 sentences: approach, what was established, how far it got, and what remains. Do not solve it.", `TASK: ${task}\n\nCUT-OFF ATTEMPT:\n${snippet}`, 0.2);
      summary = `worker EXCEEDED THE TOKEN LIMIT on: ${task.slice(0, 80)}. Prefer a simpler or different approach. ${stripThink(cut.text).slice(0, 500)}`;
    }
    return { wrote: Boolean(code), summary };
  }

  let { status, next } = await manage("ideation complete");
  let rounds = 0, previous = null, lastSamples = { ran: false }, stopReason = null;
  while (status === "continue" && next && rounds < maxIters) {
    if (previous !== null && next.trim().toLowerCase() === previous.trim().toLowerCase()) { stopReason = "repeated task"; break; }
    previous = next; rounds++;
    const result = await worker(next);
    if (tests.length && result.wrote) lastSamples = await runSamples(join(ws, "solution.py"), tests);
    const managed = await manage(sampleFeedback(lastSamples) + result.summary);
    status = managed.status; next = managed.next;
    if (lastSamples.ran && lastSamples.passed < lastSamples.total && status === "done") {
      status = "continue"; next ||= "The solution fails public samples; fix it or try a different approach.";
    }
  }
  if (rounds >= maxIters && status !== "done") stopReason = "iteration cap";
  if (status !== "done" || !(await read("solution.py")).trim()) await worker("finalize", true);
  const code = await read("solution.py");
  if (tests.length && code.trim()) lastSamples = await runSamples(join(ws, "solution.py"), tests);
  await record({ final: true, status, rounds, stopReason, samples: lastSamples });
  return { workspace: ws, code, status, rounds, stopReason, samples: lastSamples, answer: code.trim() ? `\`\`\`python\n${code.trim()}\n\`\`\`` : "", complete: Boolean(code.trim()) && status === "done" && lastSamples.ran && lastSamples.passed === lastSamples.total };
}
