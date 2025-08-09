# tv-media-conv

Bun + ffmpeg batch converter for TV-friendly MP4 (H.264 + AAC) with simple zero-padded filenames.

## Prerequisites

- Bun installed
- ffmpeg and ffprobe available on PATH

## Install

```bash
bun install
```

## Usage

### 1) Benchmark the machine

Detects Intel QSV and measures CPU scaling, then writes `tv-media-conv.config.json`.

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

Notes:

- If Intel QSV is available, one QSV job runs alongside CPU jobs for maximum throughput.
- Episode numbers are extracted heuristically from filenames (e.g. `S01E03`, `Ep 3`, `03 - title`, etc.).
