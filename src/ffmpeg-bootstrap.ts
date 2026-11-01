import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

function getCacheBaseDir(): string {
  if (process.platform === "win32") {
    return (
      process.env.LOCALAPPDATA ??
      path.join(os.homedir(), "AppData", "Local")
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function getFfmpegCacheDir(): string {
  return path.join(getCacheBaseDir(), "tv-media-conv", "ffmpeg");
}

async function resolveCommand(cmd: string): Promise<string | null> {
  const candidates = process.platform === "win32" ? [cmd, `${cmd}.exe`] : [cmd];
  for (const candidate of candidates) {
    const resolved = await resolveWithWhere(candidate);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveWithWhere(cmd: string): Promise<string | null> {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const proc = Bun.spawn({
      cmd: [tool, cmd],
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, out] = await Promise.all([proc.exited, proc.stdout?.text()]);
    if (code !== 0) return null;
    const first = (out ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function canExecute(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    const test = Bun.spawn({
      cmd: [p, "-version"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await test.exited;
    return code === 0;
  } catch {
    return false;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256Hex(buffer: ArrayBuffer): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(buffer))
    .digest("hex");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

async function extractZipWindows(archivePath: string, extractDir: string): Promise<void> {
  const escapedArchive = archivePath.replace(/'/g, "''");
  const escapedExtract = extractDir.replace(/'/g, "''");
  const command = `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedExtract}' -Force`;
  const proc = Bun.spawn({
    cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, proc.stderr?.text()]);
  if (code !== 0) {
    throw new Error(`Failed to extract ffmpeg zip: ${err ?? "unknown error"}`);
  }
}

async function extractTarXz(archivePath: string, extractDir: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xJf", archivePath, "-C", extractDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([proc.exited, proc.stderr?.text()]);
  if (code !== 0) {
    throw new Error(
      `Failed to extract ffmpeg archive. Ensure 'tar' and 'xz' are installed. ${err ?? ""}`
    );
  }
}

async function findExecutableInDir(
  rootDir: string,
  name: string
): Promise<string | null> {
  const exeName = process.platform === "win32" ? `${name}.exe` : name;
  const walk = async (dir: string): Promise<string | null> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (!isPathInside(rootDir, fullPath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const found = await walk(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name === exeName) {
        return fullPath;
      }
    }
    return null;
  };
  return walk(rootDir);
}

async function copyWindowsRuntimeFiles(fromDir: string, toDir: string): Promise<void> {
  const entries = await fs.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const srcPath = path.join(fromDir, entry.name);
    const destPath = path.join(toDir, entry.name);
    await fs.copyFile(srcPath, destPath);
  }
}

export async function ensureFfmpegTools(): Promise<{
  ffmpeg: string;
  ffprobe: string;
}> {
  const [ffmpegResolved, ffprobeResolved] = await Promise.all([
    resolveCommand("ffmpeg"),
    resolveCommand("ffprobe"),
  ]);
  if (
    ffmpegResolved &&
    ffprobeResolved &&
    (await canExecute(ffmpegResolved)) &&
    (await canExecute(ffprobeResolved))
  ) {
    return { ffmpeg: ffmpegResolved, ffprobe: ffprobeResolved };
  }

  const platform = process.platform;
  const arch = process.arch;

  const ffmpegDir = getFfmpegCacheDir();
  const ffmpegPath = path.join(
    ffmpegDir,
    platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );
  const ffprobePath = path.join(
    ffmpegDir,
    platform === "win32" ? "ffprobe.exe" : "ffprobe"
  );

  if (await canExecute(ffmpegPath) && await canExecute(ffprobePath)) {
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
  }

  console.log("ffmpeg not found on PATH, downloading from BtbN/FFmpeg-Builds...");

  let archiveName: string;
  let archiveExt: string;
  if (platform === "win32" && arch === "x64") {
    archiveName = "ffmpeg-n8.1-latest-win64-gpl-8.1.zip";
    archiveExt = ".zip";
  } else if (platform === "linux" && arch === "x64") {
    archiveName = "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz";
    archiveExt = ".tar.xz";
  } else if (platform === "linux" && arch === "arm64") {
    archiveName = "ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz";
    archiveExt = ".tar.xz";
  } else {
    throw new Error(
      `ffmpeg not found on PATH and auto-download is not supported for ${platform}-${arch}. ` +
        "Please install ffmpeg manually."
    );
  }

  const releaseBase = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
  const downloadUrl = `${releaseBase}/${archiveName}`;
  const checksumUrl = `${releaseBase}/checksums.sha256`;

  await fs.mkdir(ffmpegDir, { recursive: true });
  const tempDir = path.join(ffmpegDir, "tmp");
  const extractDir = path.join(tempDir, "extract");
  const archivePath = path.join(tempDir, `ffmpeg${archiveExt}`);

  let installed = false;
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });

    const checksumsText = await fetchText(checksumUrl);
    const checksumMatch = checksumsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
      .find((match) => match && match[2] === archiveName);
    if (!checksumMatch) {
      throw new Error(`Checksum not found for ${archiveName} in checksums.sha256`);
    }
    const expectedChecksum = checksumMatch[1]!.toLowerCase();

    console.log(`Downloading ffmpeg from ${downloadUrl}...`);
    const archiveBuffer = await fetchArrayBuffer(downloadUrl);
    const actualChecksum = sha256Hex(archiveBuffer);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch for ${archiveName}. Expected ${expectedChecksum}, got ${actualChecksum}.`
      );
    }
    await Bun.write(archivePath, archiveBuffer);

    console.log("Extracting ffmpeg...");
    if (archiveExt === ".zip") {
      if (platform !== "win32") {
        throw new Error("ZIP extraction is only supported on Windows for auto-download");
      }
      await extractZipWindows(archivePath, extractDir);
    } else if (archiveExt === ".tar.xz") {
      await extractTarXz(archivePath, extractDir);
    }

    const [foundFfmpeg, foundFfprobe] = await Promise.all([
      findExecutableInDir(extractDir, "ffmpeg"),
      findExecutableInDir(extractDir, "ffprobe"),
    ]);

    if (!foundFfmpeg || !foundFfprobe) {
      throw new Error("Failed to find ffmpeg or ffprobe in downloaded archive");
    }

    await fs.copyFile(foundFfmpeg, ffmpegPath);
    await fs.copyFile(foundFfprobe, ffprobePath);

    if (platform === "win32") {
      await copyWindowsRuntimeFiles(path.dirname(foundFfmpeg), ffmpegDir);
    } else {
      await fs.chmod(ffmpegPath, 0o755);
      await fs.chmod(ffprobePath, 0o755);
    }

    if (!(await canExecute(ffmpegPath)) || !(await canExecute(ffprobePath))) {
      throw new Error("Downloaded ffmpeg binaries failed to execute after install");
    }

    installed = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to install ffmpeg automatically: ${message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (!installed) {
      await fs.rm(ffmpegDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`ffmpeg downloaded and installed to ${ffmpegDir}`);
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
}
