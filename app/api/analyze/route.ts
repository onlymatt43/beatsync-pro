
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { cleanupStaleJobs, ensureJobDir, getJobDir } from "../../../lib/jobStore";

const execFileAsync = promisify(execFile);

function parseLimitMb(envValue: string | undefined, fallbackMb: number): number {
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb * 1024 * 1024;
  }
  return Math.floor(parsed * 1024 * 1024);
}

const MAX_AUDIO_BYTES = parseLimitMb(process.env.BEATSYNC_MAX_AUDIO_MB, 30);
const MAX_VIDEO_BYTES = parseLimitMb(process.env.BEATSYNC_MAX_VIDEO_MB, 250);
const MAX_TOTAL_VIDEO_BYTES = parseLimitMb(process.env.BEATSYNC_MAX_TOTAL_VIDEO_MB, 800);
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

      if (video.size > MAX_VIDEO_BYTES) {
        const maxMb = Math.floor(MAX_VIDEO_BYTES / (1024 * 1024));
        return Response.json({ error: `Video '${video.name}' exceeds limit (max ${maxMb}MB each).` }, { status: 413 });
      }
    }

    const totalVideoBytes = videos.reduce((sum, video) => sum + video.size, 0);
    if (totalVideoBytes > MAX_TOTAL_VIDEO_BYTES) {
      const maxMb = Math.floor(MAX_TOTAL_VIDEO_BYTES / (1024 * 1024));
      return Response.json({ error: `Total video upload exceeds limit (max ${maxMb}MB).` }, { status: 413 });
    }

    if (audio.size > MAX_AUDIO_BYTES) {
      const audioMb = Math.floor(MAX_AUDIO_BYTES / (1024 * 1024));
      return Response.json({ error: `Audio exceeds limit (max ${audioMb}MB).` }, { status: 413 });
    }

    const jobId = randomUUID();
    const jobDir = getJobDir(jobId);
    const audioInputPath = path.join(jobDir, safeAudioInputName(audio.name));
    const audioPath = path.join(jobDir, "audio.mp3");

    await ensureJobDir(jobId);
    await fs.promises.writeFile(audioInputPath, Buffer.from(await audio.arrayBuffer()));

    // Normalize to MP3 to avoid backend decoder issues with browser/container formats.
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        audioInputPath,
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        audioPath
      ],
      {
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    for (let i = 0; i < videos.length; i++) {
      const inputPath = path.join(jobDir, `input${i + 1}.mp4`);
      await fs.promises.writeFile(inputPath, Buffer.from(await videos[i].arrayBuffer()));
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
