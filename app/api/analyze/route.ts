
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { cleanupStaleJobs, ensureJobDir, getJobDir } from "../../../lib/jobStore";

const execFileAsync = promisify(execFile);

function isFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File;
}

function safeAudioInputName(originalName: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
    return `audio_input${ext}`;
  }
  return "audio_input.bin";
}

async function writeUploadedFile(file: File, destinationPath: string): Promise<void> {
  await pipeline(
    Readable.fromWeb(file.stream() as any),
    fs.createWriteStream(destinationPath)
  );
}

async function transcodeAudioForAnalysis(inputPath: string, outputPath: string): Promise<void> {
  // WAV PCM is the most reliable format for librosa across container environments.
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "22050",
      "-c:a",
      "pcm_s16le",
      outputPath
    ],
    {
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
}

export const runtime = "nodejs";

function isValidAnalyzeMode(mode: unknown): mode is "onset" | "beat" {
  return mode === "onset" || mode === "beat";
}

export async function POST(req) {
  try {
    void cleanupStaleJobs();

    const form = await req.formData();

    const audio = form.get("audio");
    const mode = form.get("mode");

    if (!isFile(audio)) {
      return Response.json({ error: "Audio file is required." }, { status: 400 });
    }

    if (!isValidAnalyzeMode(mode)) {
      return Response.json({ error: "Invalid analyze mode." }, { status: 400 });
    }

    if (!audio.type.startsWith("audio/")) {
      return Response.json({ error: "Invalid audio file type." }, { status: 400 });
    }

    const jobId = randomUUID();
    const jobDir = getJobDir(jobId);
    const audioInputPath = path.join(jobDir, safeAudioInputName(audio.name));
    const audioPath = path.join(jobDir, "audio.wav");

    await ensureJobDir(jobId);
    await writeUploadedFile(audio, audioInputPath);
    await transcodeAudioForAnalysis(audioInputPath, audioPath);

    await fs.promises.unlink(audioInputPath).catch(() => undefined);

    let stdout = "";
    try {
      const result = await execFileAsync("python3", ["python/analyze.py", audioPath], {
        timeout: 240000,
        maxBuffer: 2 * 1024 * 1024
      });
      stdout = result.stdout;
    } catch (error: any) {
      const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(stderr ? `Python analyze failed: ${stderr}` : "Python analyze failed.");
    }

    const parsed = JSON.parse(stdout);

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.onsetNotes) || !Array.isArray(parsed.beatNotes)) {
      return Response.json({ error: "Analyze returned an invalid payload." }, { status: 500 });
    }

    const onsetNotes: number[] = parsed.onsetNotes
      .map(Number)
      .filter((v: number) => Number.isFinite(v) && v >= 0)
      .sort((a: number, b: number) => a - b);

    const beatNotes: number[] = parsed.beatNotes
      .map(Number)
      .filter((v: number) => Number.isFinite(v) && v >= 0)
      .sort((a: number, b: number) => a - b);

    const notes = mode === "beat" ? beatNotes : onsetNotes;

    if (notes.length < 2) {
      return Response.json(
        { error: "Not enough notes detected to build a video." },
        { status: 422 }
      );
    }

    return Response.json({
      jobId,
      notes,
      count: notes.length,
      onsetNotes,
      beatNotes,
      onsetCount: onsetNotes.length,
      beatCount: beatNotes.length,
      mode,
      durationSec: typeof parsed.durationSec === "number" ? parsed.durationSec : 0,
      waveform: Array.isArray(parsed.waveform) ? parsed.waveform : [],
      videoCount: 0,
      videoNames: []
    });
  } catch (error) {
    console.error("[api/analyze] failure", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Analyze failed: ${message}` }, { status: 500 });
  }
}
