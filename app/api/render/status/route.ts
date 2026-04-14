import fs from "fs";
import path from "path";
import { getJobDir, isValidJobId } from "../../../../lib/jobStore";

const STATUS_FILE = "render-status.json";
const RESULT_FILE = "render-result.json";
const ERROR_FILE = "render-error.log";

export const runtime = "nodejs";

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

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId") || "";

  if (!isValidJobId(jobId)) {
    return Response.json({ error: "Invalid job id." }, { status: 400 });
  }

  const jobDir = getJobDir(jobId);
  const statusFile = path.join(jobDir, STATUS_FILE);
  const resultFile = path.join(jobDir, RESULT_FILE);
  const errorFile = path.join(jobDir, ERROR_FILE);

  try {
    if (fs.existsSync(statusFile)) {
      const statusRaw = await fs.promises.readFile(statusFile, "utf8");
      const statusParsed = JSON.parse(statusRaw);
      const status = typeof statusParsed?.status === "string" ? statusParsed.status : "";

      if (status === "processing") {
        return Response.json({ status: "processing" }, { status: 202 });
      }

      if (status === "failed") {
        const err = fs.existsSync(errorFile)
          ? (await fs.promises.readFile(errorFile, "utf8")).trim()
          : "Render process failed.";
        return Response.json({ error: err }, { status: 500 });
      }

      if (status === "done" && fs.existsSync(resultFile)) {
        const resultRaw = await fs.promises.readFile(resultFile, "utf8");
        const result = JSON.parse(resultRaw);
        return Response.json(buildRenderResponse(jobId, result));
      }
    }

    if (fs.existsSync(path.join(jobDir, "output.mp4"))) {
      return Response.json(buildRenderResponse(jobId, { video: "output.mp4" }));
    }

    return Response.json({ status: "not_started" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: `Render status failed: ${message}` }, { status: 500 });
  }
}
