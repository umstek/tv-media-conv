# tv-media-conv – Agent Playbook

## Core Facts

- **Runtime**: Bun + TypeScript single entry (`index.ts`). No build step; execute with `bun index.ts <cmd>`.
- **Primary commands**:
  - `benchmark --input <file/dir> [--config <path>]`
  - `convert --input <dir> --output <dir> [--force] [--dry-run] [--config <path>]`
- **Config**: JSON saved to `tv-media-conv.config.json` (or `--config` path) containing encoder availability, concurrency, and quality knobs.

## Editing Guidelines

- Keep CLI ergonomics consistent; add flag aliases only when updating help text and validation together.
- Maintain Windows-friendly path handling—use `path.resolve`, avoid hard-coded separators, and respect absolute vs. relative paths.
- Encoder detection relies on ffmpeg probes; ensure new logic degrades to CPU safely when hardware checks fail.
- Preserve zero-padded episode naming (`padNumber`, `chooseWidth`) and folder traversal heuristics when touching conversion flows.
- Avoid introducing new dependencies; prefer Node/Bun stdlib and existing helpers.

## Validation Checklist

- After CLI changes, run `bun index.ts --help` to verify usage text, and execute representative dry runs when feasible (e.g., `bun index.ts convert --input <tmp> --output <tmp> --dry-run`).
- When benchmarks/config logic changes, confirm config persistence by inspecting the generated JSON.

## Collaboration Notes

- Document outstanding limitations or follow-ups in task responses instead of modifying README unless the user asks.
- Do not touch `.factory` outputs or git history without explicit instruction; keep edits localized and atomic.
