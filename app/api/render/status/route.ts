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

function buildPreviewResponse(jobId: string, result: any) {
  const previews = Array.isArray(result?.previews) ? result.previews : [];
  return {
    previews: previews.map((preview: any) => ({
      video: typeof preview?.video === "string"
        ? `/api/video?jobId=${jobId}&file=${encodeURIComponent(preview.video)}`
        : "",
      segments: Array.isArray(preview?.segments) ? preview.segments : [],
      duration: typeof preview?.duration === "number" ? preview.duration : 0,
      startTime: typeof preview?.startTime === "number" ? preview.startTime : 0
    })),
    segments: Array.isArray(result?.segments) ? result.segments : []
  };
}

function buildStatusResponse(jobId: string, result: any) {
  if (Array.isArray(result?.previews)) {
    return buildPreviewResponse(jobId, result);
  }
  return buildRenderResponse(jobId, result);
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
        return Response.json(buildStatusResponse(jobId, result));
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
