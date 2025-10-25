#!/usr/bin/env bun

/*
  tv-media-conv CLI (Bun + ffmpeg)

  Commands:
    - benchmark: Detect capabilities and choose optimal CPU/QSV concurrency
    - convert:   Convert a folder of videos to H.264 (x264 or QSV) + AAC in MP4 and
                 rename outputs to zero-padded numeric filenames so TVs sort correctly

  Requirements:
    - ffmpeg and ffprobe must be available on PATH
    - On Intel machines, QSV is optionally used if available
*/

import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";

type EncoderChoice = "cpu" | "qsv" | "nvenc" | "amf";

interface BenchmarkConfig {
  // Hardware acceleration availability
  hasQsv: boolean;
  hasNvenc: boolean;
  hasAmf: boolean;

  // Concurrency settings
  chosenCpuConcurrency: number; // how many CPU encodes in parallel
  chosenQsvConcurrency: number; // 0 or 1
  chosenNvencConcurrency: number; // 0 or 1
  chosenAmfConcurrency: number; // 0 or 1

  // CPU encoding settings
  cpuPreset: string; // libx264 preset
  cpuCrf: number; // libx264 CRF
  cpuVideoEncoder: string; // selected CPU encoder (libx264, h264_mf, libopenh264)
  fallbackBitrate: string; // used if encoder doesn't support CRF (e.g. h264_mf, libopenh264)

  // Audio settings
  aacBitrate: string; // e.g. "160k"

  // Hardware acceleration usage flags
  useQsv: boolean; // whether to schedule QSV encodes
  useNvenc: boolean; // whether to schedule NVENC encodes
  useAmf: boolean; // whether to schedule AMF encodes

  // Hardware-specific quality settings
  qsvGlobalQuality: number; // h264_qsv global_quality (roughly like CRF)
  nvencCq: number; // h264_nvenc constant quality
  amfQpI: number; // h264_amf quantization parameter for I frames
}

interface ConvertOptions {
  inputDir: string;
  outputDir: string;
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  // Hardware acceleration availability
  hasQsv: false,
  hasNvenc: false,
  hasAmf: false,

  // Concurrency settings
  chosenCpuConcurrency: Math.max(
    1,
    Math.min(4, Math.floor((os.cpus()?.length ?? 4) / 3))
  ),
  chosenQsvConcurrency: 0,
  chosenNvencConcurrency: 0,
  chosenAmfConcurrency: 0,

  // CPU encoding settings
  cpuPreset: "veryfast",
  cpuCrf: 20,
  cpuVideoEncoder: "libx264",
  fallbackBitrate: "3000k",

  // Audio settings
  aacBitrate: "160k",

  // Hardware acceleration usage flags
  useQsv: false,
  useNvenc: false,
  useAmf: false,

  // Hardware-specific quality settings
  qsvGlobalQuality: 23,
  nvencCq: 20,
  amfQpI: 20,
};

function getDefaultConfigPath(): string {
  return resolvePath("tv-media-conv.config.json");
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function which(cmd: string): Promise<string | null> {
  const test = Bun.spawn({
    cmd: [cmd, "-version"],
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await test.exited;
  if (code === 0) return cmd;
  // Try Windows .exe variant
  const exe = `${cmd}.exe`;
  const testExe = Bun.spawn({
    cmd: [exe, "-version"],
    stdout: "ignore",
    stderr: "ignore",
  });
  const codeExe = await testExe.exited;
  return codeExe === 0 ? exe : null;
}

async function ensureFfmpegTools(): Promise<{
  ffmpeg: string;
  ffprobe: string;
}> {
  const [ffmpeg, ffprobe] = await Promise.all([
    which("ffmpeg"),
    which("ffprobe"),
  ]);
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg not found on PATH. Please install ffmpeg and ensure it is available."
    );
  }
  if (!ffprobe) {
    throw new Error(
      "ffprobe not found on PATH. Please install ffmpeg (ffprobe) and ensure it is available."
    );
  }
  return { ffmpeg, ffprobe };
}

async function getEncoders(ffmpegCmd: string): Promise<Set<string>> {
  const proc = Bun.spawn({
    cmd: [ffmpegCmd, "-hide_banner", "-encoders"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    proc.stdout?.text(),
    proc.stderr?.text(),
  ]);
  const text = `${out ?? ""}\n${err ?? ""}`;
  if (code !== 0) throw new Error("Failed to query encoders from ffmpeg");
  const set = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(
      /\s([a-z0-9_]+)\s+\S+\s+H\.264/i
    ) as RegExpMatchArray | null;
    if (m && m[1]) set.add(m[1]);
    const m2 = line.match(
      /\s([a-z0-9_]+)\s+.*?AAC/i
    ) as RegExpMatchArray | null;
    if (m2 && m2[1]) set.add(m2[1]);
  }
  return set;
}

async function supportsQsv(ffmpegCmd: string): Promise<boolean> {
  // Prefer direct encoder help query; ffmpeg returns error if encoder doesn't exist
  try {
    const helpProc = Bun.spawn({
      cmd: [ffmpegCmd, "-hide_banner", "-v", "error", "-h", "encoder=h264_qsv"],
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      helpProc.exited,
      helpProc.stderr?.text(),
    ]);
    if (code === 0) return true;
    const text = (err ?? "").toLowerCase();
    if (text.includes("unknown encoder") || text.includes("not found"))
      return false;
  } catch {
    // ignore and try fallback
  }
  // Fallback: scan encoders list
  try {
    const proc = Bun.spawn({
      cmd: [ffmpegCmd, "-hide_banner", "-encoders"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_, out, err] = await Promise.all([
      proc.exited,
      proc.stdout?.text(),
      proc.stderr?.text(),
    ]);
    const text = `${out ?? ""}\n${err ?? ""}`.toLowerCase();
    return text.includes("h264_qsv");
  } catch {
    return false;
  }
}

async function supportsNvenc(ffmpegCmd: string): Promise<boolean> {
  // Prefer direct encoder help query; ffmpeg returns error if encoder doesn't exist
  try {
    const helpProc = Bun.spawn({
      cmd: [
        ffmpegCmd,
        "-hide_banner",
        "-v",
        "error",
        "-h",
        "encoder=h264_nvenc",
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      helpProc.exited,
      helpProc.stderr?.text(),
    ]);
    if (code === 0) return true;
    const text = (err ?? "").toLowerCase();
    if (text.includes("unknown encoder") || text.includes("not found"))
      return false;
  } catch {
    // ignore and try fallback
  }
  // Fallback: scan encoders list
  try {
    const proc = Bun.spawn({
      cmd: [ffmpegCmd, "-hide_banner", "-encoders"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_, out, err] = await Promise.all([
      proc.exited,
      proc.stdout?.text(),
      proc.stderr?.text(),
    ]);
    const text = `${out ?? ""}
${err ?? ""}`.toLowerCase();
    return text.includes("h264_nvenc");
  } catch {
    return false;
  }
}

async function supportsAmf(ffmpegCmd: string): Promise<boolean> {
  // Prefer direct encoder help query; ffmpeg returns error if encoder doesn't exist
  try {
    const helpProc = Bun.spawn({
      cmd: [ffmpegCmd, "-hide_banner", "-v", "error", "-h", "encoder=h264_amf"],
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      helpProc.exited,
      helpProc.stderr?.text(),
    ]);
    if (code === 0) return true;
    const text = (err ?? "").toLowerCase();
    if (text.includes("unknown encoder") || text.includes("not found"))
      return false;
  } catch {
    // ignore and try fallback
  }
  // Fallback: scan encoders list
  try {
    const proc = Bun.spawn({
      cmd: [ffmpegCmd, "-hide_banner", "-encoders"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_, out, err] = await Promise.all([
      proc.exited,
      proc.stdout?.text(),
      proc.stderr?.text(),
    ]);
    const text = `${out ?? ""}
${err ?? ""}`.toLowerCase();
    return text.includes("h264_amf");
  } catch {
    return false;
  }
}

function parseSpeedFromFfmpegLog(stderrText: string): number | null {
  // Look for the last occurrence of speed=1.23x
  const matches = Array.from(
    stderrText.matchAll(/speed\s*=\s*([0-9]+(?:\.[0-9]+)?)x/gi)
  );
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1] as RegExpMatchArray | undefined;
  const num = last?.[1];
  return num ? parseFloat(num) : null;
}

function summarizeFfmpegError(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : "unknown error";
}

async function runFfmpegToNull(
  ffmpegCmd: string,
  args: string[]
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [ffmpegCmd, ...args],
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, proc.stderr?.text()]);
  return { code, stderr: stderr ?? "" };
}

async function benchmarkCpu(
  ffmpegCmd: string,
  sampleInput: string,
  durationSec: number,
  cpuPreset: string,
  crf: number,
  encoder: string,
  fallbackBitrate: string
): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    sampleInput,
    "-t",
    String(durationSec),
    "-map",
    "0:v:0",
    "-c:v",
    encoder,
    ...(encoder === "libx264"
      ? ["-preset", cpuPreset, "-crf", String(crf)]
      : ["-b:v", fallbackBitrate]),
    "-pix_fmt",
    "yuv420p",
    "-f",
    "null",
    "-",
  ];
  const res = await runFfmpegToNull(ffmpegCmd, args);
  if (res.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res.code}: ${summarizeFfmpegError(res.stderr)}`
    );
  }
  const speed = parseSpeedFromFfmpegLog(res.stderr);
  if (speed != null) return speed;
  // Retry with default verbosity if not found
  const args2 = [
    "-hide_banner",
    "-y",
    "-i",
    sampleInput,
    "-t",
    String(durationSec),
    "-map",
    "0:v:0",
    "-c:v",
    encoder,
    ...(encoder === "libx264"
      ? ["-preset", cpuPreset, "-crf", String(crf)]
      : ["-b:v", fallbackBitrate]),
    "-pix_fmt",
    "yuv420p",
    "-f",
    "null",
    "-",
  ];
  const res2 = await runFfmpegToNull(ffmpegCmd, args2);
  if (res2.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res2.code}: ${summarizeFfmpegError(
        res2.stderr
      )}`
    );
  }
  return parseSpeedFromFfmpegLog(res2.stderr) ?? 1.0;
}

async function benchmarkQsv(
  ffmpegCmd: string,
  sampleInput: string,
  durationSec: number,
  globalQuality: number
): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-hwaccel",
    "qsv",
    "-hwaccel_output_format",
    "qsv",
    "-i",
    sampleInput,
    "-t",
    String(durationSec),
    "-map",
    "0:v:0",
    "-vf",
    "scale_qsv=format=nv12",
    "-c:v",
    "h264_qsv",
    "-preset",
    "medium",
    "-global_quality",
    String(globalQuality),
    "-look_ahead",
    "1",
    "-f",
    "null",
    "-",
  ];
  const res = await runFfmpegToNull(ffmpegCmd, args);
  if (res.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res.code}: ${summarizeFfmpegError(res.stderr)}`
    );
  }
  const speed = parseSpeedFromFfmpegLog(res.stderr);
  if (speed == null) {
    throw new Error("Failed to parse QSV benchmark speed");
  }
  return speed;
}

async function benchmarkNvenc(
  ffmpegCmd: string,
  sampleInput: string,
  durationSec: number,
  cq: number
): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-hwaccel",
    "cuda",
    "-hwaccel_output_format",
    "cuda",
    "-i",
    sampleInput,
    "-t",
    String(durationSec),
    "-map",
    "0:v:0",
    "-vf",
    "scale_cuda=format=yuv420p",
    "-c:v",
    "h264_nvenc",
    "-preset",
    "medium",
    "-cq",
    String(cq),
    "-f",
    "null",
    "-",
  ];
  const res = await runFfmpegToNull(ffmpegCmd, args);
  if (res.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res.code}: ${summarizeFfmpegError(res.stderr)}`
    );
  }
  const speed = parseSpeedFromFfmpegLog(res.stderr);
  if (speed == null) {
    throw new Error("Failed to parse NVENC benchmark speed");
  }
  return speed;
}

async function benchmarkAmf(
  ffmpegCmd: string,
  sampleInput: string,
  durationSec: number,
  qpI: number
): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    sampleInput,
    "-t",
    String(durationSec),
    "-map",
    "0:v:0",
    "-c:v",
    "h264_amf",
    "-quality",
    "balanced",
    "-rc",
    "cqp",
    "-qp_i",
    String(qpI),
    "-qp_p",
    String(qpI + 2),
    "-qp_b",
    String(qpI + 4),
    "-f",
    "null",
    "-",
  ];
  const res = await runFfmpegToNull(ffmpegCmd, args);
  if (res.code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${res.code}: ${summarizeFfmpegError(res.stderr)}`
    );
  }
  const speed = parseSpeedFromFfmpegLog(res.stderr);
  if (speed == null) {
    throw new Error("Failed to parse AMF benchmark speed");
  }
  return speed;
}

async function determineCpuConcurrencyViaScaling(
  ffmpegCmd: string,
  sampleInput: string,
  durationSec: number,
  preset: string,
  crf: number,
  encoder: string,
  fallbackBitrate: string
): Promise<number> {
  const maxToTry = Math.max(
    1,
    Math.min(6, Math.floor((os.cpus()?.length ?? 8) / 2))
  );
  let bestC = 1;
  let bestThroughput = 0;
  for (let c = 1; c <= maxToTry; c++) {
    const procs: Promise<{ code: number; stderr: string }>[] = [];
    for (let i = 0; i < c; i++) {
      procs.push(
        runFfmpegToNull(ffmpegCmd, [
          "-hide_banner",
          "-y",
          "-i",
          sampleInput,
          "-t",
          String(durationSec),
          "-map",
          "0:v:0",
          "-c:v",
          encoder,
          ...(encoder === "libx264"
            ? ["-preset", preset, "-crf", String(crf)]
            : ["-b:v", fallbackBitrate]),
          "-pix_fmt",
          "yuv420p",
          "-f",
          "null",
          "-",
        ])
      );
    }
    const start = performance.now();
    const results = await Promise.all(procs);
    for (const res of results) {
      if (res.code !== 0) {
        throw new Error(
          `ffmpeg exited with code ${res.code}: ${summarizeFfmpegError(
            res.stderr
          )}`
        );
      }
    }
    const elapsedSec = (performance.now() - start) / 1000;
    const totalProcessed = c * durationSec;
    const throughput = totalProcessed / Math.max(0.001, elapsedSec);
    if (throughput > bestThroughput) {
      bestThroughput = throughput;
      bestC = c;
    } else if (c > 2) {
      // Diminishing returns, break early
      break;
    }
  }
  return Math.max(1, bestC);
}

async function writeConfig(
  pathStr: string,
  cfg: BenchmarkConfig
): Promise<void> {
  await Bun.write(pathStr, JSON.stringify(cfg, null, 2));
}

async function readConfig(pathStr: string): Promise<BenchmarkConfig | null> {
  try {
    const file = Bun.file(pathStr);
    const exists = await file.exists();
    if (!exists) {
      return null;
    }
    const text = await file.text();
    const parsed = JSON.parse(text) as BenchmarkConfig;
    return parsed;
  } catch {
    return null;
  }
}

function padNumber(num: number, width = 3): string {
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

function isVideoFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

interface EpisodeCandidate {
  inputPath: string;
  baseName: string;
  episode: number;
  relativeDir: string;
}

interface FolderBatch {
  relativeDir: string;
  episodes: EpisodeCandidate[];
  width: number;
}

interface ConversionJob {
  candidate: EpisodeCandidate;
  outputPath: string;
  outputRelativePath: string;
  inputRelativePath: string;
  outputFileName: string;
}

function extractEpisodeNumberFromName(name: string): number | null {
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

async function listFilesRecursive(dir: string): Promise<string[]> {
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

async function buildConversionJobs(
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

function chooseWidth(maxEpisode: number): number {
  if (maxEpisode >= 1000) return 4;
  return 3;
}

async function convertOne(
  ffmpegCmd: string,
  encoder: EncoderChoice,
  inputPath: string,
  outputPath: string,
  cfg: BenchmarkConfig
): Promise<void> {
  const args: string[] = ["-hide_banner", "-y", "-fflags", "+genpts"];

  // Hardware acceleration input options must come before -i
  if (encoder === "qsv") {
    args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
  } else if (encoder === "nvenc") {
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
  }
  // AMF doesn't need explicit hwaccel flags

  args.push("-i", inputPath);
  // Mapping and common options
  args.push(
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-movflags",
    "+faststart",
    "-avoid_negative_ts",
    "make_zero",
    "-reset_timestamps",
    "1"
  );

  // Video encoding options based on encoder type
  if (encoder === "qsv") {
    // Ensure HW-friendly format conversion for 10-bit sources (HEVC 10-bit -> NV12)
    args.push(
      "-vf",
      "scale_qsv=format=nv12",
      "-c:v",
      "h264_qsv",
      "-preset",
      "medium",
      "-global_quality",
      String(cfg.qsvGlobalQuality),
      "-look_ahead",
      "1"
    );
  } else if (encoder === "nvenc") {
    args.push(
      "-vf",
      "scale_cuda=format=yuv420p",
      "-c:v",
      "h264_nvenc",
      "-preset",
      "medium",
      "-cq",
      String(cfg.nvencCq)
    );
  } else if (encoder === "amf") {
    args.push(
      "-c:v",
      "h264_amf",
      "-quality",
      "balanced",
      "-rc",
      "cqp",
      "-qp_i",
      String(cfg.amfQpI),
      "-qp_p",
      String(cfg.amfQpI + 2),
      "-qp_b",
      String(cfg.amfQpI + 4),
      "-pix_fmt",
      "yuv420p"
    );
  } else {
    // CPU encoding
    const cpuEnc = cfg.cpuVideoEncoder || "libx264";
    args.push("-c:v", cpuEnc);
    if (cpuEnc === "libx264") {
      args.push("-preset", cfg.cpuPreset, "-crf", String(cfg.cpuCrf));
    } else {
      args.push("-b:v", cfg.fallbackBitrate || "3000k");
    }
    args.push("-pix_fmt", "yuv420p");
  }

  // Audio
  args.push("-c:a", "aac", "-b:a", cfg.aacBitrate, "-ac", "2");

  // Output
  args.push(outputPath);

  const proc = Bun.spawn({
    cmd: [ffmpegCmd, ...args],
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    try {
      await fs.unlink(outputPath);
    } catch {}
    throw new Error(`ffmpeg failed for ${inputPath}`);
  }
}

class Semaphore {
  private slots: number;
  private waiters: Array<() => void> = [];
  constructor(initial: number) {
    this.slots = initial;
  }
  tryAcquire(): boolean {
    if (this.slots > 0) {
      this.slots--;
      return true;
    }
    return false;
  }
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    if (this.waiters.length > 0) {
      const fn = this.waiters.shift()!;
      fn();
    } else {
      this.slots++;
    }
  }
}

async function runConvert(
  opts: ConvertOptions,
  cfg: BenchmarkConfig
): Promise<void> {
  const { ffmpeg } = await ensureFfmpegTools();
  await fs.mkdir(opts.outputDir, { recursive: true });

  const jobs = await buildConversionJobs(opts.inputDir, opts.outputDir);

  if (jobs.length === 0) {
    throw new Error("No episode-like video files found in input directory.");
  }

  if (!opts.dryRun) {
    const dirs = new Set<string>();
    for (const job of jobs) {
      dirs.add(path.dirname(job.outputPath));
    }
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // Shared index for work queue
  let nextIndex = 0;
  const takeNext = (): ConversionJob | null => {
    if (nextIndex >= jobs.length) return null;
    const job = jobs[nextIndex];
    nextIndex += 1;
    return job;
  };

  async function nextJob(): Promise<ConversionJob | null> {
    while (true) {
      const job = takeNext();
      if (!job) return null;
      if (opts.dryRun) {
        console.log(
          `[dry-run] ${job.inputRelativePath} -> ${job.outputRelativePath}`
        );
        continue;
      }
      if (!opts.force) {
        try {
          if (await Bun.file(job.outputPath).exists()) {
            console.log(`Skipping existing ${job.outputRelativePath}`);
            continue;
          }
        } catch {}
      }
      return job;
    }
  }

  const workers: Promise<void>[] = [];

  // QSV workers
  const qsvWorkers =
    cfg.useQsv && cfg.hasQsv ? Math.max(0, cfg.chosenQsvConcurrency) : 0;
  for (let i = 0; i < qsvWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const job = await nextJob();
          if (!job) break;
          try {
            console.log(
              `QSV: ${job.inputRelativePath} -> ${job.outputRelativePath}`
            );
            await convertOne(
              ffmpeg,
              "qsv",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          } catch (e) {
            console.warn(
              `QSV failed, retry on CPU: ${job.inputRelativePath} -> ${
                job.outputRelativePath
              }: ${String(e)}`
            );
            // Fall back to CPU for this job
            await convertOne(
              ffmpeg,
              "cpu",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          }
        }
      })()
    );
  }

  // NVENC workers
  const nvencWorkers =
    cfg.useNvenc && cfg.hasNvenc ? Math.max(0, cfg.chosenNvencConcurrency) : 0;
  for (let i = 0; i < nvencWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const job = await nextJob();
          if (!job) break;
          try {
            console.log(
              `NVENC: ${job.inputRelativePath} -> ${job.outputRelativePath}`
            );
            await convertOne(
              ffmpeg,
              "nvenc",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          } catch (e) {
            console.warn(
              `NVENC failed, retry on CPU: ${job.inputRelativePath} -> ${
                job.outputRelativePath
              }: ${String(e)}`
            );
            // Fall back to CPU for this job
            await convertOne(
              ffmpeg,
              "cpu",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          }
        }
      })()
    );
  }

  // AMF workers
  const amfWorkers =
    cfg.useAmf && cfg.hasAmf ? Math.max(0, cfg.chosenAmfConcurrency) : 0;
  for (let i = 0; i < amfWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const job = await nextJob();
          if (!job) break;
          try {
            console.log(
              `AMF: ${job.inputRelativePath} -> ${job.outputRelativePath}`
            );
            await convertOne(
              ffmpeg,
              "amf",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          } catch (e) {
            console.warn(
              `AMF failed, retry on CPU: ${job.inputRelativePath} -> ${
                job.outputRelativePath
              }: ${String(e)}`
            );
            // Fall back to CPU for this job
            await convertOne(
              ffmpeg,
              "cpu",
              job.candidate.inputPath,
              job.outputPath,
              cfg
            );
          }
        }
      })()
    );
  }

  // CPU workers
  const cpuWorkers = Math.max(1, cfg.chosenCpuConcurrency);
  for (let i = 0; i < cpuWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const job = await nextJob();
          if (!job) break;
          console.log(
            `CPU: ${job.inputRelativePath} -> ${job.outputRelativePath}`
          );
          await convertOne(
            ffmpeg,
            "cpu",
            job.candidate.inputPath,
            job.outputPath,
            cfg
          );
        }
      })()
    );
  }

  await Promise.all(workers);
  console.log("All conversions complete.");
}

async function runBenchmark(
  samplePathOrDir: string,
  configPath: string | undefined
): Promise<void> {
  const { ffmpeg } = await ensureFfmpegTools();
  const config: BenchmarkConfig = { ...DEFAULT_CONFIG };
  // Detect available CPU-side H.264 encoder
  const encoders = await getEncoders(ffmpeg);
  if (encoders.has("libx264")) config.cpuVideoEncoder = "libx264";
  else if (encoders.has("h264_mf")) config.cpuVideoEncoder = "h264_mf";
  else if (encoders.has("libopenh264")) config.cpuVideoEncoder = "libopenh264";
  else if (encoders.has("h264")) config.cpuVideoEncoder = "h264";

  // Choose a sample input file
  let sampleInput = samplePathOrDir;
  // If directory, pick first video file
  try {
    const stat = await fs.stat(samplePathOrDir);
    if (stat.isDirectory()) {
      const files = await listFilesRecursive(samplePathOrDir);
      const firstVideo = files.find(isVideoFile);
      if (!firstVideo) throw new Error("No video files found for benchmarking");
      sampleInput = firstVideo;
    }
  } catch (err) {
    // Path may not exist or not accessible, or may be a missing file
    // If it exists and is a file, fine; otherwise error
    try {
      const stat2 = await fs.stat(samplePathOrDir);
      if (!stat2.isFile())
        throw new Error("--input must be an existing file or directory");
    } catch {
      throw new Error("--input must be an existing file or directory");
    }
  }

  // Detect available hardware acceleration
  const hasQsv = await supportsQsv(ffmpeg);
  const hasNvenc = await supportsNvenc(ffmpeg);
  const hasAmf = await supportsAmf(ffmpeg);

  config.hasQsv = hasQsv;
  config.hasNvenc = hasNvenc;
  config.hasAmf = hasAmf;

  console.log(
    `Benchmarking CPU (${config.cpuVideoEncoder} ${
      config.cpuVideoEncoder === "libx264"
        ? `preset ${config.cpuPreset}, CRF ${config.cpuCrf}`
        : `bitrate ${config.fallbackBitrate}`
    })...`
  );
  // First, a single-stream speed estimate
  const singleSpeed = await benchmarkCpu(
    ffmpeg,
    sampleInput,
    20,
    config.cpuPreset,
    config.cpuCrf,
    config.cpuVideoEncoder,
    config.fallbackBitrate
  );
  console.log(`  Single-stream speed ~ ${singleSpeed.toFixed(2)}x`);
  // Then, scaling test to choose concurrency
  console.log("Benchmarking CPU scaling (concurrency sweep)...");
  const bestC = await determineCpuConcurrencyViaScaling(
    ffmpeg,
    sampleInput,
    12,
    config.cpuPreset,
    config.cpuCrf,
    config.cpuVideoEncoder,
    config.fallbackBitrate
  );
  config.chosenCpuConcurrency = Math.max(1, bestC);
  console.log(`  Chosen CPU concurrency: ${config.chosenCpuConcurrency}`);

  // Benchmark QSV if available
  if (hasQsv) {
    console.log("Benchmarking QSV (h264_qsv)...");
    try {
      const qsvSpeed = await benchmarkQsv(
        ffmpeg,
        sampleInput,
        20,
        config.qsvGlobalQuality
      );
      console.log(`  QSV speed ~ ${qsvSpeed.toFixed(2)}x`);
      config.chosenQsvConcurrency = 1;
      config.useQsv = true;
    } catch (e) {
      console.warn(`QSV benchmark failed: ${String(e)}`);
      config.chosenQsvConcurrency = 0;
      config.useQsv = false;
    }
  } else {
    console.log("QSV not detected.");
    config.chosenQsvConcurrency = 0;
    config.useQsv = false;
  }

  // Benchmark NVENC if available
  if (hasNvenc) {
    console.log("Benchmarking NVENC (h264_nvenc)...");
    try {
      const nvencSpeed = await benchmarkNvenc(
        ffmpeg,
        sampleInput,
        20,
        config.nvencCq
      );
      console.log(`  NVENC speed ~ ${nvencSpeed.toFixed(2)}x`);
      config.chosenNvencConcurrency = 1;
      config.useNvenc = true;
    } catch (e) {
      console.warn(`NVENC benchmark failed: ${String(e)}`);
      config.chosenNvencConcurrency = 0;
      config.useNvenc = false;
    }
  } else {
    console.log("NVENC not detected.");
    config.chosenNvencConcurrency = 0;
    config.useNvenc = false;
  }

  // Benchmark AMF if available
  if (hasAmf) {
    console.log("Benchmarking AMF (h264_amf)...");
    try {
      const amfSpeed = await benchmarkAmf(
        ffmpeg,
        sampleInput,
        20,
        config.amfQpI
      );
      console.log(`  AMF speed ~ ${amfSpeed.toFixed(2)}x`);
      config.chosenAmfConcurrency = 1;
      config.useAmf = true;
    } catch (e) {
      console.warn(`AMF benchmark failed: ${String(e)}`);
      config.chosenAmfConcurrency = 0;
      config.useAmf = false;
    }
  } else {
    console.log("AMF not detected.");
    config.chosenAmfConcurrency = 0;
    config.useAmf = false;
  }

  // Summary
  const hwTypes: string[] = [];
  if (config.useQsv) hwTypes.push("QSV");
  if (config.useNvenc) hwTypes.push("NVENC");
  if (config.useAmf) hwTypes.push("AMF");

  if (hwTypes.length > 0) {
    console.log(`Hardware acceleration enabled: ${hwTypes.join(", ")}`);
  } else {
    console.log(
      "No hardware acceleration available; CPU-only configuration will be used."
    );
  }

  const outPath = configPath ? resolvePath(configPath) : getDefaultConfigPath();
  await writeConfig(outPath, config);
  console.log(`Saved configuration to ${outPath}`);
}

function printHelp(): void {
  console.log(`tv-media-conv (Bun + ffmpeg)

Usage:
  bun run index.ts benchmark --input <file-or-dir> [--config <path>]
  bun run index.ts convert --input <inputDir> --output <outputDir> [--force] [--dry-run] [--config <path>]

Notes:
  - Output files are named NNN.mp4 (zero-padded) to sort correctly on TVs
  - Benchmarks choose CPU concurrency and enable hardware acceleration if available
  - Hardware acceleration support:
    • Intel QSV (Quick Sync Video) - h264_qsv encoder
    • NVIDIA NVENC - h264_nvenc encoder
    • AMD AMF - h264_amf encoder
  - Falls back to CPU encoding if hardware acceleration fails
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }
  if (cmd === "benchmark") {
    let input: string | undefined;
    let configPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--input" && i + 1 < argv.length) {
        input = argv[++i];
        continue;
      }
      if (a === "--config" && i + 1 < argv.length) {
        configPath = argv[++i];
        continue;
      }
    }
    if (!input) {
      console.error("--input <file-or-dir> is required");
      process.exit(2);
    }
    await runBenchmark(resolvePath(input), configPath);
    return;
  }
  if (cmd === "convert") {
    try {
      let inputDir: string | undefined;
      let outputDir: string | undefined;
      let force = false;
      let dryRun = false;
      let configPath: string | undefined;
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if ((a === "--in" || a === "--input") && i + 1 < argv.length) {
          inputDir = argv[++i];
          continue;
        }
        if ((a === "--out" || a === "--output") && i + 1 < argv.length) {
          outputDir = argv[++i];
          continue;
        }
        if (a === "--force") {
          force = true;
          continue;
        }
        if (a === "--dry-run") {
          dryRun = true;
          continue;
        }
        if (a === "--config" && i + 1 < argv.length) {
          configPath = argv[++i];
          continue;
        }
      }
      if (!inputDir || !outputDir) {
        console.error(
          "--input and --output are required (aliases: --in, --out)"
        );
        process.exit(2);
      }
      const cfgPath = configPath
        ? resolvePath(configPath)
        : getDefaultConfigPath();
      let cfg = await readConfig(cfgPath);

      if (!cfg) {
        console.log(
          `No config found at ${cfgPath}. Running benchmark first to generate optimal configuration...`
        );
        // Run benchmark using the input directory to generate config
        await runBenchmark(inputDir, configPath);
        // Now read the generated config
        cfg = (await readConfig(cfgPath)) ?? DEFAULT_CONFIG;
        console.log(
          `Benchmark complete. Starting conversion with optimized settings.`
        );
      }
      await runConvert(
        {
          inputDir: resolvePath(inputDir),
          outputDir: resolvePath(outputDir),
          force,
          dryRun,
          configPath,
        },
        cfg
      );
    } catch (error) {
      console.error(
        `Convert command failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
    return;
  }
  printHelp();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
