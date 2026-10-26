import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncReleaseNotes } from "../../../../website/scripts/sync-releases.mjs";

const repository = "that-yolanda/voicepaste";
const releaseBase = `https://github.com/${repository}/releases`;

interface ReleaseRecord {
  version: string;
  date: string;
  releaseUrl: string;
  files: { platform: string; url: string; filename: string; size: number }[];
  notes: { en: string; zh: string };
}
interface ReleaseConfig {
  latest: string;
  githubReleases: string;
  releases: ReleaseRecord[];
}
export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  assets: {
    name: string;
    size: number;
    state: string;
    browser_download_url: string;
  }[];
}

function normalize(version: string) {
  const value = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))
    throw new Error(`Invalid release version: ${version}`);
  return value;
}

function installerNames(version: string) {
  return {
    "macos-arm64": `VoicePaste_${version}_aarch64.dmg`,
    "macos-x64": `VoicePaste_${version}_x64.dmg`,
    "windows-x64": `VoicePaste_${version}_x64-setup.exe`,
    "windows-msi": `VoicePaste_${version}_x64_en-US.msi`,
  };
}

export function checkWebsiteRelease(
  config: ReleaseConfig,
  version: string,
  english: string,
  chinese: string,
) {
  const target = normalize(version);
  const record = config.releases.find((item) => normalize(item.version) === target);
  if (!record) throw new Error(`Website release is missing: v${target}`);
  const synced = syncReleaseNotes(config.releases, english, chinese);
  if (JSON.stringify(synced) !== JSON.stringify(config.releases))
    throw new Error("Website notes are out of sync with the source changelogs");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !Number.isFinite(Date.parse(record.date)))
    throw new Error("Invalid release date");
  if (record.releaseUrl !== `${releaseBase}/tag/v${target}`)
    throw new Error("Release URL does not match the target version");
  const names = Object.entries(installerNames(target));
  if (record.files.length !== names.length) throw new Error("Expected four installers");
  for (const [platform, filename] of names) {
    const matches = record.files.filter((file) => file.platform === platform);
    const file = matches[0];
    if (
      matches.length !== 1 ||
      file.filename !== filename ||
      file.url !== `${releaseBase}/download/v${target}/${filename}` ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    )
      throw new Error(`Invalid or missing installer: ${platform}`);
  }
  const latest = config.releases.find((item) => item.version === config.latest);
  if (!latest || normalize(latest.version).includes("-"))
    throw new Error("Website latest must point to an existing stable release");
  if (!target.includes("-") && normalize(config.latest) !== target)
    throw new Error("Website latest does not match the stable release being published");
}

export function syncWebsiteRelease(
  config: ReleaseConfig,
  release: GitHubRelease,
  version: string,
  english: string,
  chinese: string,
): ReleaseConfig {
  const target = normalize(version);
  if (release.tag_name !== `v${target}` || release.draft || !release.published_at)
    throw new Error("Expected the published GitHub Release for the target tag");
  const prerelease = target.includes("-");
  if (!prerelease) {
    const current = normalize(config.latest).split(".").map(Number);
    const next = target.split(".").map(Number);
    const difference = next.findIndex((part, index) => part !== current[index]);
    if (difference !== -1 && next[difference] < current[difference])
      throw new Error("Cannot replace website latest with an older stable release");
  }
  if (release.prerelease !== prerelease)
    throw new Error("GitHub prerelease flag does not match the version suffix");
  if (!Number.isFinite(Date.parse(release.published_at)))
    throw new Error("Invalid GitHub publication date");
  const files = Object.entries(installerNames(target)).map(([platform, filename]) => {
    const matches = release.assets.filter((asset) => asset.name === filename);
    if (matches.length !== 1 || matches[0].state !== "uploaded")
      throw new Error(`Missing or duplicate uploaded installer: ${filename}`);
    const asset = matches[0];
    return {
      platform,
      filename,
      url: asset.browser_download_url,
      size: asset.size,
    };
  });
  const record = {
    version: `v${target}`,
    date: new Date(release.published_at).toISOString().slice(0, 10),
    releaseUrl: release.html_url,
    files,
  };
  const latest = prerelease ? config.latest : record.version;
  const records = [record, ...config.releases.filter((item) => normalize(item.version) !== target)];
  // Keep the stable download and its notes first, even after publishing a beta.
  const ordered = [
    ...records.filter((item) => item.version === latest),
    ...records.filter((item) => item.version !== latest),
  ];
  const output = {
    ...config,
    latest,
    releases: syncReleaseNotes(ordered, english, chinese),
  };
  checkWebsiteRelease(output, target, english, chinese);
  return output;
}

function main() {
  const [version, ...flags] = process.argv.slice(2);
  if (
    !version ||
    flags.some((flag) => !["--check", "--dry-run"].includes(flag)) ||
    flags.length > 1
  )
    throw new Error("Usage: sync-website-release.mts <version> [--check | --dry-run]");
  const target = normalize(version);
  const root = new URL("../../../../", import.meta.url);
  const configUrl = new URL("website/config/releases.json", root);
  const config: ReleaseConfig = JSON.parse(readFileSync(configUrl, "utf8"));
  const english = readFileSync(new URL("CHANGELOG.md", root), "utf8");
  const chinese = readFileSync(new URL("CHANGELOG.zh.md", root), "utf8");
  if (flags.includes("--check")) {
    checkWebsiteRelease(config, target, english, chinese);
    console.log(`Website release v${target} is complete and in sync.`);
    return;
  }
  const release: GitHubRelease = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/releases/tags/v${target}`], {
      encoding: "utf8",
    }),
  );
  const output = `${JSON.stringify(syncWebsiteRelease(config, release, target, english, chinese), null, 2)}\n`;
  if (flags.includes("--dry-run")) process.stdout.write(output);
  else {
    writeFileSync(configUrl, output);
    console.log(`Synced website release v${target}. Review the diff before committing.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
