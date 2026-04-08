import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

function resolveHostPackageRoot() {
  const configuredRoot = process.env.OPENCLAW_HOST_ROOT?.trim();
  if (configuredRoot) {
    const packageJsonPath = path.join(configuredRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `OPENCLAW_HOST_ROOT does not contain package.json: ${configuredRoot}`,
      );
    }
    return configuredRoot;
  }

  const openClawBin = execFileSync("bash", ["-lc", "command -v openclaw"], {
    encoding: "utf8",
  }).trim();
  if (!openClawBin) {
    throw new Error("Could not find `openclaw` on PATH.");
  }
  const realBinPath = realpathSync(openClawBin);
  const packageRoot = path.dirname(realBinPath);
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Resolved OpenClaw package root is missing package.json: ${packageRoot}`);
  }
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (pkg?.name !== "openclaw") {
    throw new Error(
      `Resolved host package is not OpenClaw: ${packageRoot} (${String(pkg?.name ?? "<unknown>")})`,
    );
  }
  return packageRoot;
}

function replaceWithSymlink(targetPath, sourcePath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (existsSync(targetPath) || lstatSafe(targetPath)) {
    rmSync(targetPath, { force: true, recursive: true });
  }
  const relativeSource = path.relative(path.dirname(targetPath), sourcePath) || ".";
  symlinkSync(relativeSource, targetPath, "dir");
}

function lstatSafe(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch {
    return null;
  }
}

const repoRoot = process.cwd();
const hostRoot = resolveHostPackageRoot();
const targetPath = path.join(repoRoot, "node_modules", "openclaw");
replaceWithSymlink(targetPath, hostRoot);

const version = JSON.parse(readFileSync(path.join(hostRoot, "package.json"), "utf8")).version;
console.log(`Linked node_modules/openclaw -> ${hostRoot}`);
console.log(`Host OpenClaw version: ${version}`);
