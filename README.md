# tv-media-conv

Bun + ffmpeg batch converter for TV-friendly MP4 (H.264 + AAC) with simple zero-padded filenames.

## Prerequisites

- Bun installed
- ffmpeg and ffprobe available on PATH (automatically downloaded if not found on Windows x64 or Linux x64/ARM64)
- Linux auto-download requires `tar` and `xz` for extraction
- macOS requires ffmpeg to be installed manually

## Install

```bash
bun install
```

## Usage

### 1) Benchmark the machine

Detects hardware acceleration (Intel QSV, NVIDIA NVENC, AMD AMF) and measures CPU scaling, then writes `tv-media-conv.config.json`.

```bash
bun run index.ts benchmark --input <file-or-dir>
```

Optional: custom config path

```bash
bun run index.ts benchmark --input <file-or-dir> --config ./my.config.json
```

### 2) Convert a folder

Converts all videos under the input folder to MP4 (H.264 + AAC), output filenames `NNN.mp4` for proper TV sorting.

```bash
bun run index.ts convert --in "D:/Videos/My Show" --out "D:/Videos/My Show/TV"
```

Options:

- `--force`: overwrite existing outputs
- `--dry-run`: print planned actions without converting
- `--config <path>`: use a specific config file

## Hardware Acceleration

The tool automatically detects and benchmarks available hardware acceleration:

- **Intel QSV** (Quick Sync Video): Uses `h264_qsv` encoder on Intel CPUs with integrated graphics
- **NVIDIA NVENC**: Uses `h264_nvenc` encoder on NVIDIA GPUs
- **AMD AMF** (Advanced Media Framework): Uses `h264_amf` encoder on AMD GPUs

Each hardware acceleration type runs one worker alongside CPU workers for maximum throughput. If hardware encoding fails for any file, it automatically falls back to CPU encoding.

Notes:

- Hardware acceleration significantly improves encoding speed (3-10x faster than CPU-only)
- Multiple hardware acceleration types can be active simultaneously if available
- Episode numbers are extracted heuristically from filenames (e.g. `S01E03`, `Ep 3`, `03 - title`, etc.).

## Build Standalone Executable

To create a standalone Windows executable:

```bash
bun run build
```

This creates `tv-media-conv.exe` which includes the entire Bun runtime. The executable can be distributed without requiring Bun to be installed. ffmpeg and ffprobe are downloaded automatically on Windows x64 and Linux x64/ARM64 if not found on PATH; macOS requires a manual install.

### CI/CD Builds

GitHub Actions automatically builds binaries for all platforms when a release is created:

- **Windows**: `tv-media-conv.exe` (x64)
- **macOS**: `tv-media-conv` (Intel), `tv-media-conv-arm64` (Apple Silicon)
- **Linux**: `tv-media-conv` (x64), `tv-media-conv-arm64` (ARM64)

To trigger a build with all binaries, create a GitHub release. The binaries are automatically attached to the release as downloadable assets.
