import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const required = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "BENCHMARK_EMAIL", "BENCHMARK_PASSWORD", "BENCHMARK_FILES_DIR"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Variable requise absente: ${name}`);
}

const baseUrl = process.env.BENCHMARK_BASE_URL ?? "http://localhost:3000";
const cliArguments = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [name, ...valueParts] = argument.replace(/^--/, "").split("=");
  return [name, valueParts.join("=")];
}));
const requestedModes = (cliArguments.mode ?? "direct,batch").split(",").filter(Boolean);
const requestedSizes = cliArguments.sizes
  ? cliArguments.sizes.split(",").map(Number)
  : null;
const repetitions = Number(cliArguments.repetitions ?? process.env.BENCHMARK_REPETITIONS ?? "3");

if (!requestedModes.length || requestedModes.some((mode) => !["direct", "batch"].includes(mode))) {
  throw new Error("--mode doit contenir direct, batch ou les deux séparés par une virgule.");
}
if (requestedSizes && (!requestedSizes.length || requestedSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 200))) {
  throw new Error("--sizes doit contenir des entiers compris entre 1 et 200.");
}
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error("--repetitions doit être un entier compris entre 1 et 20.");
}

const defaultSizes = { direct: [3, 5, 10], batch: [3, 5, 10, 20] };
const plan = requestedModes.map((mode) => ({
  mode,
  sizes: requestedSizes ?? defaultSizes[mode],
}));
const supported = new Map([[".pdf", "application/pdf"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);

process.stderr.write(`Plan benchmark: ${plan.map((entry) => `${entry.mode} [${entry.sizes.join(", ")}]`).join(" ; ")} × ${repetitions} répétition(s)\n`);
if ("dry-run" in cliArguments) process.exit(0);

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
  email: process.env.BENCHMARK_EMAIL,
  password: process.env.BENCHMARK_PASSWORD,
});
if (signInError || !signIn.session) throw new Error(`Connexion benchmark impossible: ${signInError?.message}`);
const accessToken = signIn.session.access_token;

const directory = resolve(process.env.BENCHMARK_FILES_DIR);
const candidates = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort();
if (!candidates.length) throw new Error("Le dossier benchmark ne contient aucun document pris en charge.");

async function submitRun(mode, size) {
  const runId = crypto.randomUUID();
  const jobIds = [];
  const submittedAt = Date.now();
  for (let offset = 0; offset < size; offset += 5) {
    const form = new FormData();
    form.append("processing_mode", mode);
    form.append("benchmark_run_id", runId);
    for (let index = offset; index < Math.min(size, offset + 5); index++) {
      const name = candidates[index % candidates.length];
      const extension = extname(name).toLowerCase();
      const bytes = await readFile(join(directory, name));
      form.append("files", new File([bytes], `benchmark-${runId.slice(0, 8)}-${index}-${name}`, { type: supported.get(extension) }));
    }
    const response = await fetch(`${baseUrl}/api/document-jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Création run ${runId}: ${payload.error ?? response.status}`);
    jobIds.push(...payload.jobs.map((job) => job.id));
  }

  const functionName = mode === "direct" ? "process-direct-documents" : "process-document-queue";
  const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(functionName, {
    body: mode === "direct" ? { job_ids: jobIds } : {},
  });
  if (invokeError) throw new Error(`Invocation ${functionName}: ${invokeError.message}`);
  if (invokeResult?.error || invokeResult?.failed > 0) {
    throw new Error(`Traitement ${functionName} interrompu: ${invokeResult.error ?? `${invokeResult.failed} job(s) en erreur`}`);
  }

  let firstResultAt = null;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const { data: jobs, error } = await supabase.from("document_jobs")
      .select("id,status,attempt_count,result_available_at")
      .in("id", jobIds);
    if (error) throw new Error(`Polling ${runId}: ${error.message}`);
    const completed = jobs.filter((job) => ["needs_review", "completed", "failed"].includes(job.status));
    if (!firstResultAt && completed.length) firstResultAt = Date.now();
    if (completed.length === jobIds.length) {
      return {
        run_id: runId,
        mode,
        size,
        first_result_seconds: firstResultAt ? (firstResultAt - submittedAt) / 1000 : null,
        total_seconds: (Date.now() - submittedAt) / 1000,
        retries: jobs.reduce((sum, job) => sum + Math.max(0, job.attempt_count - 1), 0),
        failures: jobs.filter((job) => job.status === "failed").length,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  throw new Error(`Timeout de 30 minutes pour le run ${runId}`);
}

const results = [];
for (const entry of plan) {
  for (const size of entry.sizes) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      process.stderr.write(`Benchmark ${entry.mode} n=${size}, répétition ${repetition}/${repetitions}\n`);
      const result = await submitRun(entry.mode, size);
      results.push({ ...result, repetition });
      process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
    }
  }
}

await supabase.auth.signOut();
