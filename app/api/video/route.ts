
import fs from "fs";
import path from "path";
import { getJobDir, isValidJobId } from "../../../lib/jobStore";

export const runtime = "nodejs";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId") || "";

  if (!isValidJobId(jobId)) {
    return Response.json({ error: "Invalid job id." }, { status: 400 });
  }

  const fileParam = searchParams.get("file") || "";
  // Only allow known safe file name patterns to prevent path traversal
  if (fileParam && !/^(output|output_alt|drop_\d+|buildup_\d+|preview_\d+)\.mp4$/.test(fileParam)) {
    return Response.json({ error: "Invalid file name." }, { status: 400 });
  }

  const targetFile = fileParam || "output.mp4";
  const outputPath = path.join(getJobDir(jobId), targetFile);
  if (!fs.existsSync(outputPath)) {
    return Response.json({ error: "Rendered video not found for this job." }, { status: 404 });
  }

  try {
    const stat = await fs.promises.stat(outputPath);
    const fileSize = stat.size;

    if (fileSize === 0) {
      return Response.json({ error: "Video file is empty." }, { status: 404 });
    }
    const range = req.headers.get("range");

    if (!range) {
      const stream = fs.createReadStream(outputPath);
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store"
        }
      });
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      return new Response(null, { status: 416 });
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileSize - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
      return new Response(null, { status: 416 });
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(outputPath, { start, end });

    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Video read failed: ${message}` }, { status: 500 });
  }
}
