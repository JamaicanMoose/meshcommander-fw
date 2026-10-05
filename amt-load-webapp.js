#!/usr/bin/env node
/**
 * amt-load-webapp.js
 * Standalone Intel AMT Firmware Web Application Loader
 * 
 * Re-implements the removed 'meshcmd amtloadwebapp' / 'amtclearwebapp' functionality
 * for Intel AMT 11.6+ using Node.js and HTTP Digest Authentication.
 *
 * Automatically pulls compiled firmware packages from GitHub releases
 * (default: https://github.com/JamaicanMoose/meshcommander-fw) or uses local files.
 *
 * Usage:
 *   node amt-load-webapp.js --host [IP] --user [admin] --pass [PASSWORD] [--target Small|Medium|Large] [--release latest]
 *   node amt-load-webapp.js --host [IP] --user [admin] --pass [PASSWORD] --file ./output/Firmware-Medium.gz
 *   node amt-load-webapp.js --host [IP] --user [admin] --pass [PASSWORD] --clear
 *   node amt-load-webapp.js --host [IP] --user [admin] --pass [PASSWORD] --state
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

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

if (args.help || (!args.host && !args.state && !args.clear && !args.target && !args.file && !args.release)) {
  console.log(`
Intel AMT Firmware Web Application Loader
Usage:
  node amt-load-webapp.js --host <amt-host> --pass <password> [options]

Options:
  --host <ip/hostname>   Intel AMT address (default: 127.0.0.1)
  --port <port>          Intel AMT port (default: 16992 for HTTP, 16993 for HTTPS)
  --user <username>      AMT username (default: admin)
  --pass <password>      AMT admin password (required)
  --tls                  Use HTTPS/TLS (default: false)
  --target <target>      Target to upload: Small, Medium, or Large (default: Medium)
  --release <tag>        GitHub release tag to pull from (default: latest)
  --repo <owner/repo>    GitHub repository (default: JamaicanMoose/meshcommander-fw)
  --file <path>          Custom local .gz file to upload (overrides GitHub download)
  --local                Use locally compiled ./output/Firmware-<target>.gz
  --clear                Clear existing custom web application from AMT storage
  --state                Query AMT storage status and list installed files
  --debug                Enable verbose HTTP request/response debugging
`);
  process.exit(0);
}

const host = args.host || '127.0.0.1';
const user = args.user || 'admin';
const pass = args.pass;
const useTls = !!args.tls;
const port = args.port ? parseInt(args.port, 10) : (useTls ? 16993 : 16992);
const protocol = useTls ? https : http;
const isDebug = !!args.debug || !!args.verbose;

if (!pass && !args.help) {
  console.error('Error: --pass <password> is required.');
  process.exit(1);
}

/**
 * Robust RFC 2617 / RFC 7616 HTTP Digest Authenticator for Intel AMT
 */
class DigestClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.challenge = null;
    this.nc = 0;
  }

  // Parse WWW-Authenticate header values
  parseChallenge(header) {
    if (!header) return null;
    const challengeStr = header.replace(/^Digest\s+/i, '');
    const params = {};
    const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,]+))/g;
    let m;
    while ((m = regex.exec(challengeStr)) !== null) {
      params[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
    }
    return params;
  }

  // Build Authorization header dynamically for a given method, uri, and optional data
  buildAuthHeader(method, uri, data) {
    if (!this.challenge) return null;
    const { realm = '', nonce = '', opaque } = this.challenge;
    let { qop = '' } = this.challenge;

    // If server offers both 'auth' and 'auth-int', default to 'auth'
    if (qop) {
      const qops = qop.split(',').map(s => s.trim().replace(/"/g, ''));
      qop = qops.includes('auth') ? 'auth' : qops[0];
    }

    this.nc++;
    const ncStr = ('00000000' + this.nc.toString(16)).slice(-8);
    const cnonce = crypto.randomBytes(8).toString('hex');

    const ha1 = crypto.createHash('md5').update(`${this.username}:${realm}:${this.password}`).digest('hex');
    
    let ha2;
    if (qop === 'auth-int') {
      const entityMd5 = crypto.createHash('md5').update(data || '').digest('hex');
      ha2 = crypto.createHash('md5').update(`${method}:${uri}:${entityMd5}`).digest('hex');
    } else {
      ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    }

    let response;
    if (qop === 'auth' || qop === 'auth-int') {
      response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`).digest('hex');
    } else {
      response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    }

    let header = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (qop) {
      header += `, qop=${qop}, nc=${ncStr}, cnonce="${cnonce}"`;
    }
    if (opaque) {
      header += `, opaque="${opaque}"`;
    }
    return header;
  }

  request(options, data, callback) {
    const maxRetries = 3;

    const execute = (retryCount) => {
      const reqHeaders = Object.assign({}, options.headers || {});
      
      // Compute Authorization header dynamically for THIS method and URI
      if (this.challenge) {
        reqHeaders['Authorization'] = this.buildAuthHeader(options.method, options.path, data);
      }

      // Explicit Content-Length is essential for Intel AMT (Transfer-Encoding: chunked is unsupported)
      if (data) {
        reqHeaders['Content-Length'] = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      } else if (options.method === 'PUT' || options.method === 'POST') {
        reqHeaders['Content-Length'] = 0;
      }

      const reqOpts = {
        hostname: options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        rejectUnauthorized: false,
        headers: reqHeaders
      };

      if (isDebug) {
        console.log(`[DEBUG] > ${reqOpts.method} ${reqOpts.path} (Length: ${reqHeaders['Content-Length'] || 0})`);
        if (reqHeaders['Authorization']) {
          console.log(`[DEBUG] > Authorization: ${reqHeaders['Authorization']}`);
        }
      }

      const req = protocol.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (isDebug) {
            console.log(`[DEBUG] < HTTP ${res.statusCode} ${res.statusMessage}`);
            if (res.headers['www-authenticate']) {
              console.log(`[DEBUG] < WWW-Authenticate: ${res.headers['www-authenticate']}`);
            }
          }

          // Handle 401 challenge (or stale nonce re-authentication)
          if (res.statusCode === 401 && res.headers['www-authenticate'] && retryCount < maxRetries) {
            const challenge = this.parseChallenge(res.headers['www-authenticate']);
            if (challenge) {
              if (isDebug) console.log(`[DEBUG] Handling 401 challenge, retrying request (attempt ${retryCount + 1})...`);
              this.challenge = challenge;
              this.nc = 0; // Reset nonce counter for new nonce
              return execute(retryCount + 1);
            }
          }

          callback(null, res.statusCode, res.headers, body);
        });
      });

      req.on('error', err => callback(err));

      if (data) {
        req.write(data);
      }
      req.end();
    };

    execute(0);
  }
}

const client = new DigestClient(user, pass);

function downloadBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectsLeft) {
      if (redirectsLeft <= 0) return reject(new Error('Too many HTTP redirects'));
      const isHttps = currentUrl.startsWith('https:');
      const reqModule = isHttps ? https : http;
      const req = reqModule.get(currentUrl, {
        headers: {
          'User-Agent': 'meshcommander-fw-loader',
          'Accept': 'application/octet-stream, application/json, */*'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          return get(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
    }
    get(url, maxRedirects);
  });
}

/**
 * Downloads a compiled firmware package directly from GitHub Releases.
 */
async function fetchFirmwareFromGitHub(repo, releaseTag, target) {
  const assetName = `Firmware-${target}.gz`;
  console.log(`Fetching ${assetName} from GitHub release (${repo} @ ${releaseTag})...`);

  let downloadUrl = null;

  // 1. Try querying GitHub Releases API to get direct asset URL and release metadata
  const apiPath = releaseTag === 'latest' ? 'releases/latest' : `releases/tags/${releaseTag}`;
  const apiUrl = `https://api.github.com/repos/${repo}/${apiPath}`;

  try {
    const jsonBuf = await downloadBuffer(apiUrl);
    const releaseData = JSON.parse(jsonBuf.toString('utf8'));
    if (releaseData && Array.isArray(releaseData.assets)) {
      const asset = releaseData.assets.find(a => a.name === assetName);
      if (asset && asset.browser_download_url) {
        downloadUrl = asset.browser_download_url;
        console.log(`Found asset in release "${releaseData.name || releaseData.tag_name}": ${asset.name}`);
      }
    }
  } catch (err) {
    if (isDebug) console.log(`[DEBUG] GitHub API lookup note: ${err.message}. Trying direct release download URL...`);
  }

  // 2. Fallback to direct release download URL
  if (!downloadUrl) {
    const tagPath = releaseTag === 'latest' ? 'latest/download' : `download/${releaseTag}`;
    downloadUrl = `https://github.com/${repo}/releases/${tagPath}/${assetName}`;
  }

  try {
    const buffer = await downloadBuffer(downloadUrl);
    // Validate GZIP magic header (0x1f, 0x8b)
    if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
      throw new Error(`Downloaded payload is not a valid GZIP archive (received ${buffer.length} bytes)`);
    }
    console.log(`Successfully downloaded ${assetName} (${buffer.length} bytes).`);
    return buffer;
  } catch (err) {
    throw new Error(
      `Failed to download ${assetName} from GitHub (${downloadUrl}): ${err.message}\n` +
      `Tip: Ensure a release exists on https://github.com/${repo}/releases, or specify a local file with --file <path> or --local.`
    );
  }
}

function getStorageState(cb) {
  client.request({ host, port, path: '/amt-storage/', method: 'GET' }, null, (err, status, headers, body) => {
    if (err) return cb(err);
    if (status !== 200) return cb(new Error(`HTTP Status ${status}: Unable to read AMT storage`));
    try {
      let str = body.toString();
      str = str.replace(/":\s+/g, '":').replace(/\x00/g, '').replace(/"\x01"/g, '""');
      const json = JSON.parse(str);
      cb(null, json);
    } catch (e) {
      cb(new Error(`Failed to parse AMT storage response: ${body.toString()}`));
    }
  });
}

function deleteStorageFile(fileName, cb) {
  console.log(`Deleting ${fileName} from Intel AMT storage...`);
  client.request({ host, port, path: `/amt-storage/${fileName}`, method: 'DELETE' }, null, (err, status) => {
    if (err) return cb(err);
    if (status === 200) cb(null);
    else cb(new Error(`Failed to delete ${fileName}, HTTP status ${status}`));
  });
}

/**
 * Upload a binary payload into Intel AMT storage in 7KB chunks
 * The <metadata> header is placed ONLY at the start of the entire stream.
 */
function uploadStorageFile(uploadPath, buffer, linkName, cb) {
  const metadata = `<metadata><headers><h>Content-Encoding:gzip</h><h>Content-Type:text/html</h></headers>${linkName ? `<link>${linkName}</link>` : ''}</metadata>`;
  const fullStream = Buffer.concat([Buffer.from(metadata, 'utf8'), buffer]);
  const totalLength = fullStream.length;
  const chunkSize = 7000;

  function sendChunk(offset) {
    const isFirst = (offset === 0);
    const sliceLen = Math.min(totalLength - offset, chunkSize);
    const chunkData = fullStream.slice(offset, offset + sliceLen);
    const reqPath = `/amt-storage/${uploadPath}${isFirst ? '' : '?append='}`;

    client.request({ host, port, path: reqPath, method: 'PUT' }, chunkData, (err, status, headers, body) => {
      if (err) return cb(err);
      if (status !== 200) {
        return cb(new Error(`Chunk upload failed with HTTP status ${status}${body && body.length ? ': ' + body.toString() : ''}`));
      }
      const newOffset = offset + sliceLen;
      const percent = Math.round((newOffset / totalLength) * 100);
      process.stdout.write(`\rUploading MeshCommander: ${percent}% (${newOffset}/${totalLength} bytes)`);
      if (newOffset < totalLength) {
        sendChunk(newOffset);
      } else {
        process.stdout.write('\n');
        cb(null);
      }
    });
  }

  sendChunk(0);
}

// Main logic
async function run() {
  if (args.state) {
    console.log(`Querying Intel AMT storage at ${host}:${port}...`);
    getStorageState((err, data) => {
      if (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
      console.log('Intel AMT Storage State:');
      console.log(JSON.stringify(data, null, 2));
    });
  } else if (args.clear) {
    console.log(`Clearing Intel AMT web application storage...`);
    getStorageState((err, data) => {
      if (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
      const files = data.content ? Object.keys(data.content) : [];
      if (files.length === 0) {
        console.log('No custom web application files found in storage.');
        return;
      }
      let idx = 0;
      const nextDelete = () => {
        if (idx >= files.length) {
          console.log('All files cleared successfully.');
          return;
        }
        deleteStorageFile(files[idx++], (err) => {
          if (err) console.error('Error:', err.message);
          nextDelete();
        });
      };
      nextDelete();
    });
  } else {
    // Upload WebApp
    const rawTarget = args.target || 'Medium';
    const target = rawTarget.charAt(0).toUpperCase() + rawTarget.slice(1).toLowerCase();
    const repo = args.repo || 'JamaicanMoose/meshcommander-fw';
    const releaseTag = args.release || args.tag || args.version || 'latest';

    let payload;
    if (args.file) {
      if (!fs.existsSync(args.file)) {
        console.error(`Error: File not found: ${args.file}`);
        process.exit(1);
      }
      payload = fs.readFileSync(args.file);
      console.log(`Loaded local firmware file: ${args.file} (${payload.length} bytes)`);
    } else if (args.local) {
      const localPath = path.join(__dirname, 'output', `Firmware-${target}.gz`);
      if (!fs.existsSync(localPath)) {
        console.error(`Error: Local build file not found: ${localPath}`);
        console.error(`Please run: pnpm run build`);
        process.exit(1);
      }
      payload = fs.readFileSync(localPath);
      console.log(`Loaded local build: ${localPath} (${payload.length} bytes)`);
    } else {
      try {
        payload = await fetchFirmwareFromGitHub(repo, releaseTag, target);
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
    }

    console.log(`Preparing to load MeshCommander (${target}, ${payload.length} bytes) into Intel AMT at ${host}:${port}...`);

    getStorageState((err, state) => {
      if (err) {
        console.warn(`[Warning] Could not fetch initial state: ${err.message}. Proceeding with upload...`);
      }

      const uploadName = 'index.htm';
      uploadStorageFile(uploadName, payload, null, (err) => {
        if (err) {
          console.error('\nUpload failed:', err.message);
          process.exit(1);
        }
        console.log(`Successfully loaded MeshCommander into Intel AMT firmware!`);
        console.log(`You can now open http://${host}:${port}/ (or https) directly in your browser to access MeshCommander.`);
      });
    });
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
