import path from "node:path";
import { promises as fs } from "node:fs";

export function padNumber(num: number, width = 3): string {
  const s = String(Math.max(0, Math.floor(num)));
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".m4v",
  ".webm",
  ".ts",
  ".flv",
  ".m2ts",
  ".vob",
]);

export function isVideoFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export interface EpisodeCandidate {
  inputPath: string;
  baseName: string;
  episode: number;
  relativeDir: string;
}

export interface FolderBatch {
  relativeDir: string;
  episodes: EpisodeCandidate[];
  width: number;
}

export interface ConversionJob {
  candidate: EpisodeCandidate;
  outputPath: string;
  outputRelativePath: string;
  inputRelativePath: string;
  outputFileName: string;
}

export function extractEpisodeNumberFromName(name: string): number | null {
  // Remove file extension first
  const nameWithoutExt = name.replace(/\.[^.]+$/, "");

  // Remove only YouTube IDs added by yt-dlp (11-character alphanumeric strings in brackets)
  // This handles patterns like: [-ayFQnecY-4], [dQw4w9WgXcQ], etc.
  // But preserves other bracketed content like [1080p], [h264], [Season 1], etc.
  const cleaned = nameWithoutExt.replace(/\[([a-zA-Z0-9_-]{11})\]/g, "").trim();

  const lower = cleaned.toLowerCase();
  // 1) SxxEyy pattern
  const se = lower.match(
    /s(\d{1,2})\s*[^a-z0-9]?\s*e(\d{1,3})/i
  ) as RegExpMatchArray | null;
  if (se && se[2]) return parseInt(se[2], 10);
  // 2) Eyy pattern
  const eonly = lower.match(
    /e(?:p|pisode)?[\s_-]*(\d{1,3})/
  ) as RegExpMatchArray | null;
  if (eonly && eonly[1]) return parseInt(eonly[1], 10);
  // 3) Leading numbers
  const lead = lower.match(/^(\d{1,3})\D/) as RegExpMatchArray | null;
  if (lead && lead[1]) return parseInt(lead[1], 10);
  // 4) Any number groups; prefer 1-3 digits and avoid common resolution/codec numbers
  const forbidden = new Set([
    "1080",
    "720",
    "2160",
    "480",
    "360",
    "264",
    "265",
    "10",
  ]);
  const nums = Array.from(lower.matchAll(/\b(\d{1,3})\b/g))
    .map((m) => m[1] ?? "")
    .filter(Boolean) as string[];
  const filtered = nums.filter((n) => !forbidden.has(n));
  if (filtered.length > 0) {
    // Heuristic: take the last small number
    const lastNum = filtered[filtered.length - 1] as string;
    return parseInt(lastNum, 10);
  }
  return null;
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    // Check if directory exists first
    await fs.access(dir);
    for await (const entry of new Bun.Glob("**/*").scan({ cwd: dir })) {
      out.push(path.resolve(dir, entry));
    }
  } catch (error) {
    throw new Error(
      `Cannot access directory "${dir}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return out;
}

function chooseWidth(maxEpisode: number): number {
  if (maxEpisode >= 1000) return 4;
  return 3;
}

async function collectFolderBatches(inputDir: string): Promise<FolderBatch[]> {
  try {
    await fs.access(inputDir);
  } catch (error) {
    throw new Error(
      `Cannot access directory "${inputDir}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const batches: FolderBatch[] = [];

  const walk = async (
    currentDir: string,
    relativeDir: string
  ): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    const episodes: EpisodeCandidate[] = [];

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isFile()) {
        if (!isVideoFile(entry.name)) continue;
        const episode = extractEpisodeNumberFromName(entry.name);
        if (episode == null) continue;
        episodes.push({
          inputPath: entryPath,
          baseName: entry.name,
          episode,
          relativeDir,
        });
        continue;
      }
      if (entry.isDirectory()) {
        const nextRelative = relativeDir
          ? path.join(relativeDir, entry.name)
          : entry.name;
        await walk(entryPath, nextRelative);
      }
    }

    if (episodes.length > 0) {
      episodes.sort((a, b) => a.episode - b.episode);
      const maxEpisode = episodes[episodes.length - 1]!.episode;
      batches.push({
        relativeDir,
        episodes,
        width: chooseWidth(maxEpisode),
      });
    }
  };

  await walk(inputDir, "");
  return batches;
}

export async function buildConversionJobs(
  inputDir: string,
  outputDir: string
): Promise<ConversionJob[]> {
  const batches = await collectFolderBatches(inputDir);
  const jobs: ConversionJob[] = [];

  for (const batch of batches) {
    const targetDir = batch.relativeDir
      ? path.join(outputDir, batch.relativeDir)
      : outputDir;

    for (const candidate of batch.episodes) {
      const outputFileName = `${padNumber(candidate.episode, batch.width)}.mp4`;
      const outputPath = path.join(targetDir, outputFileName);
      const inputRelativePath = batch.relativeDir
        ? path.join(batch.relativeDir, candidate.baseName)
        : candidate.baseName;
      const outputRelativePath = batch.relativeDir
        ? path.join(batch.relativeDir, outputFileName)
        : outputFileName;

      jobs.push({
        candidate,
        outputPath,
        outputRelativePath,
        inputRelativePath,
        outputFileName,
      });
    }
  }

  return jobs;
}
