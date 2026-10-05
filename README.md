# MeshCommander In Firmware

Intel AMT with [MeshCommander](https://github.com/Ylianst/MeshCommander) is a convenient OOB management solution for hobbyists.

The maintainer of MeshCommander [dropped support for the firmware build](https://github.com/Ylianst/MeshCentral/issues/3928) when the web interface was deprecated by Intel but many hobbyists still have machines that use AMT versions with the web interface.

This project packages [MeshCommander](https://github.com/Ylianst/MeshCommander) for uploading directly into Intel AMT (Active Management Technology 11.6+) firmware NVRAM storage and reconstructs some of the CLI needed to upload it.

<a href='https://ko-fi.com/Q0I2287UOI' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi4.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a>

---

## Targets

| Target     | Description                                              | Typical GZIP Size |
| :--------- | :------------------------------------------------------- | :---------------- |
| **Small**  | Core KVM/Desktop, Power, Network, Hardware Info, Storage | ~50 KB            |
| **Medium** | Small + IDER, Terminal/Serial-over-LAN, Event/Audit Logs | ~72 KB            |
| **Large**  | Medium + Scripting, Subscriptions, Alarms, Presence      | ~84 KB            |

---

## Flashing / Uploading to Intel AMT

The loader tool `amt-load-webapp.js` automatically downloads the pre-compiled firmware package from [GitHub Releases](https://github.com/JamaicanMoose/meshcommander-fw/releases). These releases should track the releases of MeshCommander upstream.

### 1. Flash Latest Release from GitHub:

```bash
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
