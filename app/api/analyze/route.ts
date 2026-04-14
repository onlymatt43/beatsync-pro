
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

function compareVideoNames(a: File, b: File): number {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function safeAudioInputName(originalName: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
    return `audio_input${ext}`;
  }
  return "audio_input.bin";
}

function safeVideoInputName(index: number, originalName: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) {
    return `video_input${index}${ext}`;
  }
  return `video_input${index}.bin`;
}

async function writeUploadedFile(file: File, destinationPath: string): Promise<void> {
  await pipeline(
    Readable.fromWeb(file.stream() as any),
    fs.createWriteStream(destinationPath)
  );
}

async function transcodeAudioForAnalysis(inputPath: string, outputPath: string): Promise<void> {
  // Mono + lower sample rate/bitrate is enough for beat detection and keeps files small.
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
      "libmp3lame",
      "-b:a",
      "64k",
      outputPath
    ],
    {
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024
    }
  );
}

async function transcodeVideoForAnalysis(inputPath: string, outputPath: string): Promise<void> {
  // Build lightweight visual proxies: fixed 640x360 canvas, lower FPS, no audio track.
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "32",
      "-an",
      "-movflags",
      "+faststart",
      outputPath
    ],
    {
      timeout: 600000,
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
    const videos = form.getAll("video").filter(isFile).sort(compareVideoNames);
    const mode = form.get("mode");

    if (!isFile(audio)) {
      return Response.json({ error: "Audio file is required." }, { status: 400 });
    }

    if (videos.length === 0) {
      return Response.json({ error: "At least one video file is required." }, { status: 400 });
    }

    if (!isValidAnalyzeMode(mode)) {
      return Response.json({ error: "Invalid analyze mode." }, { status: 400 });
    }

    if (!audio.type.startsWith("audio/")) {
      return Response.json({ error: "Invalid audio file type." }, { status: 400 });
    }

    for (const video of videos) {
      if (!video.type.startsWith("video/")) {
        return Response.json({ error: "All video files must be video/* type." }, { status: 400 });
      }
    }

    const jobId = randomUUID();
    const jobDir = getJobDir(jobId);
    const audioInputPath = path.join(jobDir, safeAudioInputName(audio.name));
    const audioPath = path.join(jobDir, "audio.mp3");

    await ensureJobDir(jobId);
    await writeUploadedFile(audio, audioInputPath);
    await transcodeAudioForAnalysis(audioInputPath, audioPath);

    await fs.promises.unlink(audioInputPath).catch(() => undefined);

    for (let i = 0; i < videos.length; i++) {
      const rawInputPath = path.join(jobDir, safeVideoInputName(i + 1, videos[i].name));
      const inputPath = path.join(jobDir, `input${i + 1}.mp4`);
      await writeUploadedFile(videos[i], rawInputPath);
      await transcodeVideoForAnalysis(rawInputPath, inputPath);
      await fs.promises.unlink(rawInputPath).catch(() => undefined);
    }

    const { stdout } = await execFileAsync("python3", ["python/analyze.py", audioPath], {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024
    });

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
      videoCount: videos.length,
      videoNames: videos.map((video) => video.name)
    });
  } catch (error) {
    console.error("[api/analyze] failure", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Analyze failed: ${message}` }, { status: 500 });
  }
}
