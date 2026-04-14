import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const TMP_DIR = path.join(process.cwd(), "tmp");

export function getJobDir(jobId: string): string {
  return path.join(TMP_DIR, jobId);
}

export function ensureJobDir(jobId: string): string {
  const jobDir = getJobDir(jobId);
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }
  return jobDir;
}

export function isValidJobId(jobId: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId);
}

export function cleanupStaleJobs(): void {
  try {
    if (!fs.existsSync(TMP_DIR)) {
      return;
    }

    const entries = fs.readdirSync(TMP_DIR, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const jobDir = path.join(TMP_DIR, entry.name);
      try {
        const stat = fs.statSync(jobDir);
        const ageMs = now - stat.mtime.getTime();
        const maxAgeMs = 60 * 60 * 1000; // 1 hour

        if (ageMs > maxAgeMs) {
          fs.rmSync(jobDir, { recursive: true, force: true });
        }
      } catch (error) {
        // Ignore errors for individual job dirs
      }
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}