# Intel AMT Firmware Web Application Compiler & Loader

Reconstructs the build pipeline for embedding [MeshCommander](https://github.com/Ylianst/MeshCommander) directly into Intel AMT (Active Management Technology 11.6+) firmware NVRAM storage.

---

## Targets

| Target     | Description                                              | Typical GZIP Size |
| :--------- | :------------------------------------------------------- | :---------------- |
| **Small**  | Core KVM/Desktop, Power, Network, Hardware Info, Storage | ~50 KB            |
| **Medium** | Small + IDER, Terminal/Serial-over-LAN, Event/Audit Logs | ~72 KB            |
| **Large**  | Medium + Scripting, Subscriptions, Alarms, Presence      | ~84 KB            |

---

## Flashing / Uploading to Intel AMT

The loader tool ([`amt-load-webapp.js`](file:///home/coder/git/meshcentral-firmware/amt-load-webapp.js)) **automatically downloads** the pre-compiled firmware package from [GitHub Releases](https://github.com/JamaicanMoose/meshcommander-fw/releases).

### 1. Flash Latest Release from GitHub:

```bash
# Uploads Medium payload from latest GitHub release by default:
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --target Medium
```

### 2. Flash a Specific Release Version:

```bash
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --target Medium --release v0.9.6
```

### 3. Flash a Local Build:

```bash
# Use locally compiled output:
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --target Medium --local

# Or specify a custom file path:
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --file ./output/Firmware-Medium.gz
```

### 4. Query Device Storage State:

```bash
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --state
```

### 5. Clear Custom Web Application:

```bash
node amt-load-webapp.js --host 192.168.1.50 --pass "MyAmtAdminPassword" --clear
```

### CLI Options:

- `--host <ip/hostname>`: AMT device IP or hostname (default: `127.0.0.1`)
- `--port <port>`: AMT HTTP/HTTPS port (default: 16992 for HTTP, 16993 for HTTPS)
- `--user <username>`: Admin username (default: `admin`)
- `--pass <password>`: Admin password (**required**)
- `--tls`: Connect using HTTPS (port 16993)
- `--target <target>`: Target package: `Small`, `Medium`, or `Large` (default: `Medium`)
- `--release <tag>`: GitHub release tag to pull from (default: `latest`)
- `--repo <owner/repo>`: GitHub repository (default: `JamaicanMoose/meshcommander-fw`)
- `--file <path>`: Custom local `.gz` file to upload (overrides GitHub download)
- `--local`: Use locally compiled `./output/Firmware-<target>.gz`
- `--state`: Check NVRAM storage status and list stored files
- `--clear`: Remove existing custom web application from AMT NVRAM
- `--debug`: Enable verbose HTTP request/response debugging

---

## Local Compilation

### Prerequisites:

- **Node.js** (v18+)
- **pnpm** or **npm**
- **AdvanceCOMP / `advdef`** (optional, for maximum GZIP compression: `sudo apt-get install advancecomp`)

### Build Commands:

```bash
# Install dependencies
pnpm install

# Build all firmware targets (auto-clones upstream MeshCommander if needed)
pnpm run build

# Build a single target:
pnpm run build:small
pnpm run build:medium
pnpm run build:large
```

The following get written to `output/`:

- `Firmware-{Small,Medium,Large}.htm` (uncompressed single-file HTML)
- `Firmware-{Small,Medium,Large}.gz` (GZIP compressed payload for AMT)
- `firmware-payloads.js` (Base64-encoded module exportable to MeshCentral / MeshCmd)
