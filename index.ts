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

import type {
  BenchmarkConfig,
  ConvertOptions,
  EncoderChoice,
} from "./src/config";
import { DEFAULT_CONFIG, resolvePath, getDefaultConfigPath } from "./src/config";
import { ensureFfmpegTools } from "./src/ffmpeg-bootstrap";
import {
  getEncoders,
  supportsQsv,
  supportsNvenc,
  supportsAmf,
  benchmarkCpu,
  benchmarkQsv,
  benchmarkNvenc,
  benchmarkAmf,
  determineCpuConcurrencyViaScaling,
  writeConfig,
  readConfig,
} from "./src/encoders";
import {
  isVideoFile,
  listFilesRecursive,
  buildConversionJobs,
  type ConversionJob,
} from "./src/scan";

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
    if (!job) return null;
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
