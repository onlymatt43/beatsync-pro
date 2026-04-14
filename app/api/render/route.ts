
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { cleanupStaleJobs, getJobDir, isValidJobId } from "../../../lib/jobStore";

const execFileAsync = promisify(execFile);
const STATUS_FILE = "render-status.json";
const RESULT_FILE = "render-result.json";
const ERROR_FILE = "render-error.log";

function isValidNotesArray(notes: unknown): notes is number[] {
  if (!Array.isArray(notes) || notes.length < 2 || notes.length > 10000) {
    return false;
  }
  let previous = -1;
  for (const value of notes) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return false;
    }
    if (value < previous) {
      return false;
    }
    previous = value;
  }
  return true;
}

export const runtime = "nodejs";

function statusPath(jobDir: string): string {
  return path.join(jobDir, STATUS_FILE);
}

function resultPath(jobDir: string): string {
  return path.join(jobDir, RESULT_FILE);
}

function errorPath(jobDir: string): string {
  return path.join(jobDir, ERROR_FILE);
}

async function writeStatus(jobDir: string, status: "processing" | "done" | "failed"): Promise<void> {
  await fs.promises.writeFile(
    statusPath(jobDir),
    JSON.stringify({ status, updatedAt: Date.now() })
  );
}

async function readStatus(jobDir: string): Promise<string> {
  try {
    const raw = await fs.promises.readFile(statusPath(jobDir), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.status === "string" ? parsed.status : "";
  } catch {
    return "";
  }
}

function buildRenderResponse(jobId: string, result: any) {
  return {
    video: `/api/video?jobId=${jobId}`,
    alternateVideo: result?.alternateVideo
      ? `/api/video?jobId=${jobId}&file=${encodeURIComponent(result.alternateVideo)}`
      : "",
    segments: Array.isArray(result?.segments) ? result.segments : [],
    alternateSegments: Array.isArray(result?.alternateSegments) ? result.alternateSegments : [],
    output: result?.video || "output.mp4"
  };
}

function startRenderProcess(jobDir: string, pythonArgs: string[]): void {
  const child = spawn("python3", pythonArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.on("close", async (code) => {
    try {
      if (code === 0) {
        await fs.promises.writeFile(resultPath(jobDir), stdout || "{}");
        await fs.promises.rm(errorPath(jobDir), { force: true });
        await writeStatus(jobDir, "done");
      } else {
        await fs.promises.writeFile(errorPath(jobDir), stderr || "Render process failed.");
        await fs.promises.rm(resultPath(jobDir), { force: true });
        await writeStatus(jobDir, "failed");
      }
    } catch {
      // Ignore status persistence errors to avoid process crash.
    }
  });

  child.unref();
}

function hasFirstInputVideo(jobDir: string): boolean {
  try {
    const entries = fs.readdirSync(jobDir);
    return entries.some((name) => /^input1\.[a-z0-9]{1,8}$/i.test(name));
  } catch {
    return false;
  }
}

export async function POST(req) {
  try {
    void cleanupStaleJobs();

    const { notes, jobId, minSeg, preview, async: asyncMode } = await req.json();

    if (typeof jobId !== "string" || !isValidJobId(jobId)) {
      return Response.json({ error: "Invalid job id." }, { status: 400 });
    }

    if (!isValidNotesArray(notes)) {
      return Response.json({ error: "Invalid notes payload." }, { status: 400 });
    }

    const jobDir = getJobDir(jobId);
    const audioWavPath = path.join(jobDir, "audio.wav");
    const audioMp3Path = path.join(jobDir, "audio.mp3");
    const audioPath = fs.existsSync(audioWavPath) ? audioWavPath : audioMp3Path;
    if (!hasFirstInputVideo(jobDir) || !fs.existsSync(audioPath)) {
      return Response.json({ error: "Analyze step missing for this job id." }, { status: 404 });
    }

    const notesPath = path.join(jobDir, "notes.json");
    await fs.promises.writeFile(
      notesPath,
      JSON.stringify({
        notes,
        minSeg: typeof minSeg === "number" && Number.isFinite(minSeg) && minSeg >= 0 ? minSeg : 0
      })
    );

    const pythonArgs = ["python/render.py", jobDir];
    if (typeof minSeg === "number" && Number.isFinite(minSeg) && minSeg > 0) {
      pythonArgs.push("--min-seg", String(minSeg));
    }
    if (preview === true) {
      pythonArgs.push("--preview");
    }

    const useAsyncRender = preview !== true && asyncMode === true;
    if (useAsyncRender) {
      const currentStatus = await readStatus(jobDir);
      if (currentStatus === "processing") {
        return Response.json({ status: "processing" }, { status: 202 });
      }

      if (currentStatus === "done" && fs.existsSync(resultPath(jobDir))) {
        const parsed = JSON.parse(await fs.promises.readFile(resultPath(jobDir), "utf8"));
        return Response.json(buildRenderResponse(jobId, parsed));
      }

      await writeStatus(jobDir, "processing");
      await fs.promises.rm(resultPath(jobDir), { force: true });
      await fs.promises.rm(errorPath(jobDir), { force: true });
      startRenderProcess(jobDir, pythonArgs);

      return Response.json({ status: "processing" }, { status: 202 });
    }

    const { stdout } = await execFileAsync("python3", pythonArgs, {
      timeout: preview ? 120000 : 600000, // Timeout plus court pour les previews
      maxBuffer: 10 * 1024 * 1024
    });

    const result = JSON.parse(stdout);

    if (preview) {
      // Pour les previews, retourner les chemins des fichiers preview
      return Response.json({
        previews: Array.isArray(result.previews) ? result.previews.map(preview => ({
          video: `/api/video?jobId=${jobId}&file=${encodeURIComponent(preview.video)}`,
          segments: preview.segments || [],
          duration: preview.duration || 0,
          startTime: preview.startTime || 0
        })) : [],
        segments: Array.isArray(result.segments) ? result.segments : []
      });
    }

    return Response.json(buildRenderResponse(jobId, result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Render failed: ${message}` }, { status: 500 });
  }
}

