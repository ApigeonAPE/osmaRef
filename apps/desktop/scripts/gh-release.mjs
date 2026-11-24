import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
const tag = `v${version}`;

const config = await readFile(path.join(desktopDir, "electron-builder.yml"), "utf8");
const owner = (config.match(/^\s*owner:\s*(\S+)/m) ?? [])[1];
const repo = (config.match(/^\s*repo:\s*(\S+)/m) ?? [])[1];
if (!owner || !repo) {
  throw new Error("cannot read publish owner/repo from electron-builder.yml");
}

const token = process.env.GITHUB_RELEASE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error("no GitHub token in GITHUB_RELEASE_TOKEN, GH_TOKEN or GITHUB_TOKEN");
}

const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
};

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}\n${text}`);
  }
  return text.length === 0 ? null : JSON.parse(text);
}

async function findRelease() {
  const releases = await request("GET", `${api}/releases?per_page=100`);
  return releases.find(release => release.tag_name === tag) ?? null;
}

const mode = process.argv[2];

if (mode === "ensure") {
  const existing = await findRelease();
  if (existing) {
    console.log(`release ${tag} already exists (${existing.draft ? "draft" : "published"})`);
  } else {
    await request("POST", `${api}/releases`, {
      tag_name: tag,
      name: version,
      draft: true,
      prerelease: version.includes("-"),
      generate_release_notes: true,
    });
    console.log(`created draft release ${tag}`);
  }
} else if (mode === "publish") {
  const release = await findRelease();
  if (!release) {
    throw new Error(`release ${tag} not found`);
  }
  if (!release.draft) {
    console.log(`release ${tag} is already published`);
  } else {
    const full = await request("GET", `${api}/releases/${release.id}`);
    const hasExe = (full.assets ?? []).some(asset => asset.name.endsWith(".exe"));
    if (!hasExe) {
      throw new Error(`draft release ${tag} has no .exe asset; refusing to publish`);
    }
    await request("PATCH", `${api}/releases/${release.id}`, { draft: false });
    console.log(`published release ${tag}`);
  }
} else {
  throw new Error(`unknown mode: ${mode} (expected "ensure" or "publish")`);
}
