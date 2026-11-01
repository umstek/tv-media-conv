import os from "node:os";
import type { BenchmarkConfig } from "./config";

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

export async function benchmarkCpu(
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

export async function benchmarkQsv(
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

export async function benchmarkNvenc(
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

export async function benchmarkAmf(
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

export async function determineCpuConcurrencyViaScaling(
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

export async function writeConfig(
  pathStr: string,
  cfg: BenchmarkConfig
): Promise<void> {
  await Bun.write(pathStr, JSON.stringify(cfg, null, 2));
}

export async function readConfig(pathStr: string): Promise<BenchmarkConfig | null> {
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

export {
  getEncoders,
  supportsQsv,
  supportsNvenc,
  supportsAmf,
};
