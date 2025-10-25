# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

A Bun + ffmpeg batch converter that transforms video files into TV-friendly MP4 format (H.264 + AAC) with zero-padded numeric filenames for proper TV sorting. The tool intelligently detects and utilizes hardware acceleration (Intel QSV, NVIDIA NVENC, AMD AMF) to maximize encoding performance.

## Common Commands

### Development

```powershell
bun install                                    # Install dependencies
```

### Benchmarking (Required First Step)

```powershell
bun run index.ts benchmark --input "D:/Videos/Sample"     # Benchmark with directory
bun run index.ts benchmark --input "video.mp4"           # Benchmark with single file
bun run index.ts benchmark --input <path> --config ./custom.config.json  # Custom config location
```

### Converting Videos

```powershell
bun run index.ts convert --in "D:/Videos/Source" --out "D:/Videos/TV"     # Basic conversion
bun run index.ts convert --in <input> --out <output> --force             # Overwrite existing files
bun run index.ts convert --in <input> --out <output> --dry-run           # Preview actions without converting
bun run index.ts convert --in <input> --out <output> --config <path>     # Use specific config
```

### Help

```powershell
bun run index.ts --help     # Show usage information
```

## Architecture

### Core Components

**BenchmarkConfig Interface**: Central configuration object that stores hardware capabilities, concurrency settings, and encoding parameters. Contains settings for CPU encoding (`cpuPreset`, `cpuCrf`, `cpuVideoEncoder`), hardware acceleration flags (`useQsv`, `useNvenc`, `useAmf`), and quality parameters for each encoder type.

**Hardware Acceleration Detection**: The tool probes ffmpeg for available encoders (`h264_qsv`, `h264_nvenc`, `h264_amf`) and runs performance benchmarks to determine optimal concurrency settings. Each hardware encoder runs one worker alongside CPU workers for maximum throughput.

**Episode Number Extraction**: Sophisticated pattern matching that extracts episode numbers from various filename formats (`SxxEyy`, `Ep 3`, `03 - title`, etc.) while filtering out common technical metadata like resolutions and codec identifiers.

**Parallel Processing Architecture**: Work queue system where multiple worker types (QSV, NVENC, AMF, CPU) pull from a shared episode list. Hardware encoding failures automatically fall back to CPU encoding for reliability.

### Key Files

- `index.ts`: Single-file CLI application containing all core functionality
- `tv-media-conv.config.json`: Generated benchmark configuration (created after first benchmark)
- `package.json`: Minimal Bun project configuration with TypeScript peer dependency

### Processing Flow

1. **Benchmark Phase**: Detects hardware capabilities, measures CPU scaling, and generates optimized configuration
2. **Collection Phase**: Recursively scans input directory for video files and extracts episode numbers
3. **Conversion Phase**: Distributes work across hardware and CPU workers with automatic fallback handling
4. **Output**: Zero-padded filenames (`001.mp4`, `002.mp4`) for proper TV device sorting

### Hardware Acceleration Support

- **Intel QSV**: Uses `h264_qsv` with `scale_qsv=format=nv12` filter and global quality settings
- **NVIDIA NVENC**: Uses `h264_nvenc` with `scale_cuda=format=yuv420p` filter and constant quality mode
- **AMD AMF**: Uses `h264_amf` with constant quantization parameter (CQP) rate control

### Dependencies

- **Runtime**: Bun (JavaScript runtime and bundler)
- **External**: ffmpeg and ffprobe must be available on PATH
- **Development**: TypeScript for type checking (peer dependency)

### Configuration System

The tool uses a two-phase approach: benchmark first to detect capabilities and generate optimal settings, then convert using those settings. Configuration includes concurrency limits, encoder preferences, quality settings, and hardware acceleration flags.

## Development Notes

- Use Bun instead of Node.js for all operations (see `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`)
- Single-file architecture keeps all functionality in `index.ts`
- No build step required - Bun runs TypeScript directly
- Episode number extraction handles YouTube ID removal while preserving other metadata
- Hardware encoding automatically falls back to CPU on failure for reliability
