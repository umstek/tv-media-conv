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

type EncoderChoice = "cpu" | "qsv";

interface BenchmarkConfig {
  hasQsv: boolean;
  chosenCpuConcurrency: number; // how many CPU encodes in parallel
  chosenQsvConcurrency: number; // 0 or 1
  cpuPreset: string; // libx264 preset
  cpuCrf: number; // libx264 CRF
  aacBitrate: string; // e.g. "160k"
  useQsv: boolean; // whether to schedule QSV encodes
  qsvGlobalQuality: number; // h264_qsv global_quality (roughly like CRF)
  cpuVideoEncoder: string; // selected CPU encoder (libx264, h264_mf, libopenh264)
  fallbackBitrate: string; // used if encoder doesn't support CRF (e.g. h264_mf, libopenh264)
}

interface ConvertOptions {
  inputDir: string;
  outputDir: string;
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  hasQsv: false,
  chosenCpuConcurrency: Math.max(
    1,
    Math.min(4, Math.floor((os.cpus()?.length ?? 4) / 3))
  ),
  chosenQsvConcurrency: 0,
  cpuPreset: "veryfast",
  cpuCrf: 20,
  aacBitrate: "160k",
  useQsv: false,
  qsvGlobalQuality: 23,
  cpuVideoEncoder: "libx264",
  fallbackBitrate: "3000k",
};

const DEFAULT_CONFIG_PATH = resolvePath("tv-media-conv.config.json");

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
  return parseSpeedFromFfmpegLog(res.stderr) ?? 1.0;
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
    await Promise.all(procs);
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
    const text = await Bun.file(pathStr).text();
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
}

function extractEpisodeNumberFromName(name: string): number | null {
  const lower = name.toLowerCase();
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
  for await (const entry of new Bun.Glob("**/*").scan({ cwd: dir })) {
    out.push(path.resolve(dir, entry));
  }
  return out;
}

async function collectEpisodes(inputDir: string): Promise<EpisodeCandidate[]> {
  const files = await listFilesRecursive(inputDir);
  const candidates: EpisodeCandidate[] = [];
  for (const f of files) {
    if (!isVideoFile(f)) continue;
    const base = path.basename(f);
    const epi = extractEpisodeNumberFromName(base);
    if (epi != null)
      candidates.push({ inputPath: f, baseName: base, episode: epi });
  }
  if (candidates.length === 0)
    throw new Error("No episode-like video files found in input directory.");
  candidates.sort((a, b) => a.episode - b.episode);
  return candidates;
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
  const args: string[] = ["-hide_banner", "-y"];
  if (encoder === "qsv") {
    // Input options must come before -i
    args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
  }
  args.push("-i", inputPath);
  // Mapping and common options
  args.push("-map", "0:v:0", "-map", "0:a:0?", "-movflags", "+faststart");

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
  } else {
    const cpuEnc = (cfg as any).cpuVideoEncoder || "libx264";
    args.push("-c:v", cpuEnc);
    if (cpuEnc === "libx264") {
      args.push("-preset", cfg.cpuPreset, "-crf", String(cfg.cpuCrf));
    } else {
      args.push("-b:v", (cfg as any).fallbackBitrate || "3000k");
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
    } catch { }
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
  const episodes = await collectEpisodes(opts.inputDir);
  const lastEpisode = episodes[episodes.length - 1];
  const width = chooseWidth(lastEpisode ? lastEpisode.episode : 999);
  await fs.mkdir(opts.outputDir, { recursive: true });

  // Shared index for work queue
  let nextIndex = 0;
  const getNext = (): {
    ep: EpisodeCandidate;
    outPath: string;
    outName: string;
  } | null => {
    while (nextIndex < episodes.length) {
      const ep: EpisodeCandidate = episodes[nextIndex++]!;
      const outName = `${padNumber(ep.episode, width)}.mp4`;
      const outPath = resolvePath(path.join(opts.outputDir, outName));
      if (!opts.force) {
        try {
          if (Bun.file(outPath)) {
            // Bun.file(outPath).exists() is async; avoid await inside crit section
          }
        } catch { }
      }
      return { ep, outPath, outName };
    }
    return null;
  };

  // Skip/existence check wrapper outside the crit section
  async function nextJob(): Promise<{
    ep: EpisodeCandidate;
    outPath: string;
    outName: string;
  } | null> {
    while (true) {
      const job = getNext();
      if (!job) return null;
      if (opts.dryRun) {
        console.log(`[dry-run] ${job.ep.baseName} -> ${job.outName}`);
        continue;
      }
      if (!opts.force) {
        try {
          if (await Bun.file(job.outPath).exists()) {
            console.log(`Skipping existing ${job.outName}`);
            continue;
          }
        } catch { }
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
            console.log(`QSV: ${job.ep.baseName} -> ${job.outName}`);
            await convertOne(ffmpeg, "qsv", job.ep.inputPath, job.outPath, cfg);
          } catch (e) {
            console.warn(
              `QSV failed, retry on CPU: ${job.ep.baseName} -> ${job.outName
              }: ${String(e)}`
            );
            // Fall back to CPU for this job
            await convertOne(ffmpeg, "cpu", job.ep.inputPath, job.outPath, cfg);
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
          console.log(`CPU: ${job.ep.baseName} -> ${job.outName}`);
          await convertOne(ffmpeg, "cpu", job.ep.inputPath, job.outPath, cfg);
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

  const hasQsv = await supportsQsv(ffmpeg);
  config.hasQsv = hasQsv;

  console.log(
    `Benchmarking CPU (${config.cpuVideoEncoder} ${config.cpuVideoEncoder === "libx264"
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

  if (hasQsv) {
    console.log("Benchmarking QSV (h264_qsv)...");
    const qsvSpeed = await benchmarkQsv(
      ffmpeg,
      sampleInput,
      20,
      config.qsvGlobalQuality
    );
    console.log(`  QSV speed ~ ${qsvSpeed.toFixed(2)}x`);
    config.chosenQsvConcurrency = 1;
    config.useQsv = true;
  } else {
    console.log("QSV not detected; CPU-only configuration will be used.");
    config.chosenQsvConcurrency = 0;
    config.useQsv = false;
  }

  const outPath = configPath ? resolvePath(configPath) : DEFAULT_CONFIG_PATH;
  await writeConfig(outPath, config);
  console.log(`Saved configuration to ${outPath}`);
}

function printHelp(): void {
  console.log(`tv-media-conv (Bun + ffmpeg)

Usage:
  bun run index.ts benchmark --input <file-or-dir> [--config <path>]
  bun run index.ts convert --in <inputDir> --out <outputDir> [--force] [--dry-run] [--config <path>]

Notes:
  - Output files are named NNN.mp4 (zero-padded) to sort correctly on TVs
  - Benchmarks choose CPU concurrency and enable QSV if available
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
    let inputDir: string | undefined;
    let outputDir: string | undefined;
    let force = false;
    let dryRun = false;
    let configPath: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--in" && i + 1 < argv.length) {
        inputDir = argv[++i];
        continue;
      }
      if (a === "--out" && i + 1 < argv.length) {
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
      console.error("--in and --out are required");
      process.exit(2);
    }
    const cfgPath = configPath ? resolvePath(configPath) : DEFAULT_CONFIG_PATH;
    const cfg = (await readConfig(cfgPath)) ?? DEFAULT_CONFIG;
    try {
      await fs.access(cfgPath);
    } catch {
      console.log(
        `No config at ${cfgPath}; using defaults. You can run 'bun run index.ts benchmark --input <dir>' to generate one.`
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
    return;
  }
  printHelp();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
