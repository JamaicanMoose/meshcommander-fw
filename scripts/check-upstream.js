#!/usr/bin/env node
/**
 * check-upstream.js
 * Compares upstream MeshCommander releases/versions with our repository releases.
 * Sets GitHub Actions outputs for automated compilation and release publishing.
 */

const https = require('https');
const fs = require('fs');

const UPSTREAM_REPO = process.env.UPSTREAM_REPO || 'Ylianst/MeshCommander';
const OUR_REPO = process.env.OUR_REPO || 'JamaicanMoose/meshcommander-fw';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).toLowerCase();
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const isForce = !!args.force || process.env.FORCE_RELEASE === 'true';
const overrideVersion = args['target-version'] || args.version || process.env.TARGET_VERSION;

function fetchJson(url) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'MeshCommander-Release-Checker' };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function parseSemver(v) {
  if (!v) return [0, 0, 0];
  const clean = v.replace(/^v/i, '').trim();
  const main = clean.split('-')[0];
  const parts = main.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isNewer(remoteVer, localVer) {
  if (!localVer) return true;
  const [rMaj, rMin, rPat] = parseSemver(remoteVer);
  const [lMaj, lMin, lPat] = parseSemver(localVer);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

async function getUpstreamVersion() {
  if (overrideVersion) {
    return { version: overrideVersion.replace(/^v/i, ''), ref: overrideVersion };
  }

  // 1. Check upstream GitHub releases
  const release = await fetchJson(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`);
  if (release && release.tag_name) {
    const ver = release.tag_name.replace(/^v/i, '');
    return { version: ver, ref: release.tag_name, name: release.name || release.tag_name };
  }

  // 2. Check upstream GitHub tags
  const tags = await fetchJson(`https://api.github.com/repos/${UPSTREAM_REPO}/tags`);
  if (Array.isArray(tags) && tags.length > 0) {
    const latestTag = tags[0].name;
    return { version: latestTag.replace(/^v/i, ''), ref: latestTag };
  }

  // 3. Fallback: check package.json on master branch
  const pkg = await fetchJson(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/master/package.json`);
  if (pkg && pkg.version) {
    return { version: pkg.version.replace(/^v/i, ''), ref: 'master' };
  }

  return null;
}

async function getOurLatestRelease() {
  const release = await fetchJson(`https://api.github.com/repos/${OUR_REPO}/releases/latest`);
  if (release && release.tag_name) {
    return release.tag_name.replace(/^v/i, '');
  }

  const releases = await fetchJson(`https://api.github.com/repos/${OUR_REPO}/releases`);
  if (Array.isArray(releases) && releases.length > 0) {
    return releases[0].tag_name.replace(/^v/i, '');
  }

  return null;
}

async function main() {
  console.log('Checking upstream MeshCommander repository for new releases...');
  console.log(`- Upstream Repository: ${UPSTREAM_REPO}`);
  console.log(`- Target Repository:   ${OUR_REPO}`);

  const upstreamInfo = await getUpstreamVersion();
  if (!upstreamInfo || !upstreamInfo.version) {
    console.error('Error: Unable to determine upstream MeshCommander version.');
    process.exit(1);
  }

  const ourVersion = await getOurLatestRelease();

  console.log(`- Upstream version:    ${upstreamInfo.version} (ref: ${upstreamInfo.ref})`);
  console.log(`- Our latest release:  ${ourVersion || 'None (no releases yet)'}`);

  let shouldBuild = false;
  if (isForce) {
    console.log('Force build requested.');
    shouldBuild = true;
  } else if (!ourVersion) {
    console.log('Our repository has no existing releases; initial release required.');
    shouldBuild = true;
  } else if (isNewer(upstreamInfo.version, ourVersion)) {
    console.log(`Newer version detected: upstream ${upstreamInfo.version} > our ${ourVersion}`);
    shouldBuild = true;
  } else {
    console.log(`Upstream (${upstreamInfo.version}) is not newer than our latest release (${ourVersion}). No build needed.`);
  }

  const tag = `v${upstreamInfo.version}`;

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_build=${shouldBuild}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${upstreamInfo.version}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ref=${upstreamInfo.ref}\n`);
  }

  console.log(`Result: should_build=${shouldBuild}, target_tag=${tag}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
