import path from "node:path";
import os from "node:os";

export type EncoderChoice = "cpu" | "qsv" | "nvenc" | "amf";

export interface BenchmarkConfig {
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

export interface ConvertOptions {
  inputDir: string;
  outputDir: string;
  force: boolean;
  dryRun: boolean;
  configPath?: string;
}

export const DEFAULT_CONFIG: BenchmarkConfig = {
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

export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export function getDefaultConfigPath(): string {
  return resolvePath("tv-media-conv.config.json");
}
