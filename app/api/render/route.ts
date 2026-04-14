
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { cleanupStaleJobs, getJobDir, isValidJobId } from "../../../lib/jobStore";

const execFileAsync = promisify(execFile);

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

    const { notes, jobId, minSeg, preview } = await req.json();

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

    return Response.json({
      video: `/api/video?jobId=${jobId}`,
      alternateVideo: result.alternateVideo
        ? `/api/video?jobId=${jobId}&file=${encodeURIComponent(result.alternateVideo)}`
        : "",
      segments: Array.isArray(result.segments) ? result.segments : [],
      alternateSegments: Array.isArray(result.alternateSegments) ? result.alternateSegments : [],
      output: result.video || "output.mp4"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Render failed: ${message}` }, { status: 500 });
  }
}

