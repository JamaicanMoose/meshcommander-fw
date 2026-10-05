#!/usr/bin/env node
/**
 * Modern Firmware Web Application Compiler for MeshCommander / Intel AMT
 * Reconstructs and modernizes the build pipeline previously implemented in WebSiteCompiler.exe
 *
 * Targets: Large, Medium, Small
 * Compiles index.html + linked CSS/JS/images into a single self-contained, minified,
 * GZIP-compressed web application suitable for embedding into Intel AMT firmware flash storage.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');

let CleanCSS, htmlMinifier, Terser;
try {
  CleanCSS = require('clean-css');
  htmlMinifier = require('html-minifier');
  Terser = require('terser');
} catch (e) {
  CleanCSS = require('./commander/node_modules/clean-css');
  htmlMinifier = require('./commander/node_modules/html-minifier');
  Terser = require('./commander/node_modules/terser');
}

const SOURCE_DIR = process.env.SOURCE_DIR || path.resolve(__dirname, 'commander');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, 'output');

if (!fs.existsSync(SOURCE_DIR)) {
  console.log(`MeshCommander source not found at: ${SOURCE_DIR}`);
  console.log(`Cloning MeshCommander from upstream (https://github.com/Ylianst/MeshCommander.git)...`);
  execSync(`git clone --depth 1 https://github.com/Ylianst/MeshCommander.git "${SOURCE_DIR}"`, { stdio: 'inherit' });
}

// Feature definitions extracted from Firmware-MeshCommander.wcc
const TARGET_DEFINITIONS = {
  Large: [
    'AgentPresence', 'Alarms', 'AuditLog', 'ContextMenus', 'Desktop', 'DesktopFocus',
    'Desktop-Multi', 'DesktopRotation', 'Desktop-Settings', 'DesktopType', 'EventLog',
    'EventSubscriptions', 'FileSaver', 'HardwareInfo', 'IDER', 'IDERStats',
    'Look-Commander', 'Mode-Firmware', 'NetworkSettings', 'PowerControl',
    'PowerControl-Advanced', 'RemoteAccess', 'Scripting', 'Scripting-Editor',
    'Storage', 'SystemDefense', 'Terminal', 'Terminal-Enumation-All',
    'Terminal-FxEnumation-All', 'TerminalSize', 'VersionWarning', 'Wireless'
  ],
  Medium: [
    'AuditLog', 'Desktop', 'Desktop-Multi', 'DesktopRotation', 'Desktop-Settings',
    'DesktopType', 'EventLog', 'FileSaver', 'HardwareInfo', 'IDER',
    'Look-Commander', 'Mode-Firmware', 'NetworkSettings', 'PowerControl',
    'PowerControl-Advanced', 'RemoteAccess', 'Storage', 'SystemDefense',
    'Terminal', 'Terminal-Enumation-All', 'Terminal-FxEnumation-All',
    'TerminalSize', 'VersionWarning', 'Wireless'
  ],
  Small: [
    'Desktop', 'Desktop-Multi', 'DesktopRotation', 'Desktop-Settings',
    'DesktopType', 'EventLog', 'HardwareInfo', 'Look-Commander',
    'Mode-Firmware', 'NetworkSettings', 'PowerControl', 'PowerControl-Advanced',
    'Storage', 'VersionWarning', 'Wireless'
  ]
};

// String twizzling / token removal: removes all content between beginToken and endToken
function twizzle(text, beginToken, endToken) {
  const parts = text.split(beginToken);
  if (parts.length === 1) return text;
  let res = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const subparts = parts[i].split(endToken);
    if (subparts.length >= 2) {
      res += subparts.slice(1).join(endToken);
    } else {
      console.warn(`[Warning] Preprocessor token mismatch: "${beginToken}" without matching "${endToken}"`);
    }
  }
  return res;
}

// Discover all features dynamically across all source files
function discoverAllFeatures(sourceDir) {
  const features = new Set();
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.css'));
  for (const f of files) {
    const full = path.join(sourceDir, f);
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const m of content.matchAll(/###(?:BEGIN|END)###\{!?([a-zA-Z0-9_\-\*\+]+)\}/g)) {
      features.add(m[1]);
    }
  }
  return Array.from(features);
}

// Apply preprocessor directives (###BEGIN### and ###END###) for given target features
function preprocess(content, keepSet, allFeatures) {
  let text = content.replace(/\r\n/g, '\n');
  const removeFeatures = allFeatures.filter(f => !keepSet.has(f));

  // 1. HTML style comments: <!-- ###BEGIN###{feat} --> ... <!-- ###END###{feat} -->
  for (const f of removeFeatures) {
    // Strip {!f} tags (keeping inner content)
    text = text.split(`<!-- ###BEGIN###{!${f}} -->\n`).join('');
    text = text.split(`<!-- ###BEGIN###{!${f}} -->`).join('');
    text = text.split(`<!-- ###END###{!${f}} -->\n`).join('');
    text = text.split(`<!-- ###END###{!${f}} -->`).join('');
    // Remove {f} blocks entirely
    text = twizzle(text, `<!-- ###BEGIN###{${f}} -->`, `<!-- ###END###{${f}} -->`);
  }
  for (const f of keepSet) {
    // Strip {f} tags (keeping inner content)
    text = text.split(`<!-- ###BEGIN###{${f}} -->\n`).join('');
    text = text.split(`<!-- ###BEGIN###{${f}} -->`).join('');
    text = text.split(`<!-- ###END###{${f}} -->\n`).join('');
    text = text.split(`<!-- ###END###{${f}} -->`).join('');
    // Remove {!f} blocks entirely
    text = twizzle(text, `<!-- ###BEGIN###{!${f}} -->`, `<!-- ###END###{!${f}} -->`);
  }

  // 2. JS / inline style comments: // ###BEGIN###{feat} ... // ###END###{feat}
  for (const f of removeFeatures) {
    // Strip {!f} tags
    text = text.split(`// ###BEGIN###{!${f}}\n`).join('');
    text = text.split(`// ###BEGIN###{!${f}}`).join('');
    text = text.split(`// ###END###{!${f}}\n`).join('');
    text = text.split(`// ###END###{!${f}}`).join('');
    // Remove {f} blocks entirely
    text = twizzle(text, `// ###BEGIN###{${f}}`, `// ###END###{${f}}\n`);
    text = twizzle(text, `// ###BEGIN###{${f}}`, `// ###END###{${f}}`);
  }
  for (const f of keepSet) {
    // Strip {f} tags
    text = text.split(`// ###BEGIN###{${f}}\n`).join('');
    text = text.split(`// ###BEGIN###{${f}}`).join('');
    text = text.split(`// ###END###{${f}}\n`).join('');
    text = text.split(`// ###END###{${f}}`).join('');
    // Remove {!f} blocks entirely
    text = twizzle(text, `// ###BEGIN###{!${f}}`, `// ###END###{!${f}}\n`);
    text = twizzle(text, `// ###BEGIN###{!${f}}`, `// ###END###{!${f}}`);
  }

  return text;
}

// Convert a local file to a base64 data URI
function getFileDataUri(sourceDir, relativePath) {
  const fullPath = path.resolve(sourceDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[Warning] Image file not found: ${fullPath}`);
    return relativePath;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const data = fs.readFileSync(fullPath).toString('base64');
  return `data:${mime};base64,${data}`;
}

// Inline images referenced in CSS (url(...))
function inlineCssImages(sourceDir, cssContent) {
  return cssContent.replace(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, urlPath) => {
    if (urlPath.startsWith('data:') || urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
      return match;
    }
    const cleanPath = urlPath.trim();
    const dataUri = getFileDataUri(sourceDir, cleanPath);
    return `url("${dataUri}")`;
  });
}

// Inline images referenced in HTML (img src=...)
function inlineHtmlImages(sourceDir, htmlContent) {
  return htmlContent.replace(/<img\b([^>]*src=["']?([^"' >]+)["']?[^>]*)>/gi, (match, prefix, src) => {
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
      return match;
    }
    const dataUri = getFileDataUri(sourceDir, src.trim());
    return match.replace(src, dataUri);
  });
}


// Compile JavaScript using Terser (modern JS minifier)
async function compileJsTerser(jsCode) {
  const result = await Terser.minify(jsCode, {
    compress: {
      passes: 2,
      dead_code: true,
      drop_debugger: true
    },
    mangle: {
      toplevel: false
    }
  });
  return result.code;
}

// Perform legacy variable post-processing to strip redundant 'window.' prefixes
function postProcessJs(js) {
  return js
    .replace(/\(window\./g, '(')
    .replace(/;window\./g, ';')
    .replace(/=window\./g, '=')
    .replace(/\}window\./g, '}')
    .replace(/\?window\./g, '?')
    .replace(/\+window\./g, '+')
    .replace(/,window\./g, ',');
}

// Create ETag string (20 alphanumeric chars)
function createETag(buffer) {
  const hash = crypto.createHash('sha1').update(buffer).digest('base64');
  return hash.substring(0, 20);
}

// Main compilation function for a single target
async function compileTarget(targetName, featureList, allFeatures) {
  console.log(`\n========================================`);
  console.log(`Compiling Target: ${targetName}`);
  console.log(`========================================`);

  const keepSet = new Set(featureList);
  const cleanCss = new CleanCSS({ level: 2 });

  // 1. Read and preprocess index.html
  const rawHtml = fs.readFileSync(path.join(SOURCE_DIR, 'index.html'), 'utf8');
  let preHtml = preprocess(rawHtml, keepSet, allFeatures);

  // 2. Process and inline CSS stylesheets
  const linkCssRegex = /<link\b([^>]*href=["']?([^"' >]+)["']?[^>]*)>/gi;
  const inlinedStyles = [];
  preHtml = preHtml.replace(linkCssRegex, (match, attrs, href) => {
    const isCss = attrs.includes('text/css') || href.endsWith('.css');
    if (!isCss) return match; // keep favicon etc.
    const cssFile = path.resolve(SOURCE_DIR, href.trim());
    if (!fs.existsSync(cssFile)) {
      console.warn(`[Warning] Missing CSS file: ${href}`);
      return '';
    }
    let cssText = fs.readFileSync(cssFile, 'utf8');
    cssText = preprocess(cssText, keepSet, allFeatures);
    cssText = inlineCssImages(SOURCE_DIR, cssText);
    const minified = cleanCss.minify(cssText).styles;
    inlinedStyles.push(minified);
    return ''; // remove link tag from HTML
  });

  // Also collect and minify any existing inline <style> tags
  const styleTagRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  preHtml = preHtml.replace(styleTagRegex, (match, content) => {
    let preStyle = preprocess(content, keepSet, allFeatures);
    preStyle = inlineCssImages(SOURCE_DIR, preStyle);
    const minified = cleanCss.minify(preStyle).styles;
    if (minified.trim()) inlinedStyles.push(minified);
    return ''; // remove from body/head; will be bundled together
  });

  // Combine all CSS into a single style block in <head>
  const combinedCss = inlinedStyles.join('');
  const styleBlock = `<style>${combinedCss}</style>`;
  if (preHtml.includes('</head>')) {
    preHtml = preHtml.replace('</head>', `${styleBlock}</head>`);
  } else {
    preHtml = `${styleBlock}${preHtml}`;
  }

  // 3. Process and bundle JavaScript files
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const scriptMatches = [...preHtml.matchAll(scriptRegex)];
  let combinedJsParts = [];

  for (const m of scriptMatches) {
    const attrs = m[1];
    const inlineContent = m[2];
    const srcMatch = attrs.match(/src=["']?([^"' >]+)["']?/i);
    if (srcMatch) {
      const srcFile = path.resolve(SOURCE_DIR, srcMatch[1].trim());
      if (fs.existsSync(srcFile)) {
        let jsText = fs.readFileSync(srcFile, 'utf8');
        jsText = preprocess(jsText, keepSet, allFeatures);
        combinedJsParts.push(jsText);
      } else {
        console.warn(`[Warning] Missing script file: ${srcMatch[1]}`);
      }
    } else if (inlineContent.trim()) {
      let jsText = preprocess(inlineContent, keepSet, allFeatures);
      combinedJsParts.push(jsText);
    }
  }

  // Remove all original <script> tags from HTML
  preHtml = preHtml.replace(scriptRegex, '');

  // Inject webcompilerfeatures array
  let combinedJs = combinedJsParts.join('\n;\n');
  const featureArrayString = Array.from(keepSet).map(f => `'${f}'`).join(',');
  combinedJs = combinedJs.replace('/*###WEBCOMPILERFEATURES###*/', featureArrayString);

  console.log(`- Bundled JavaScript source size: ${(combinedJs.length / 1024).toFixed(1)} KB`);

  // 4. Minify JavaScript
  console.log(`- Minifying JavaScript using Terser...`);
  let minifiedJs = await compileJsTerser(combinedJs);

  minifiedJs = postProcessJs(minifiedJs);
  console.log(`- Minified JavaScript size: ${(minifiedJs.length / 1024).toFixed(1)} KB`);

  // 5. Inline images in HTML
  preHtml = inlineHtmlImages(SOURCE_DIR, preHtml);

  // 6. Append single script block before </body></html>
  const scriptTag = `<script>${minifiedJs}</script>`;
  if (preHtml.includes('</body></html>')) {
    preHtml = preHtml.replace('</body></html>', `${scriptTag}</body></html>`);
  } else if (preHtml.includes('</body>')) {
    preHtml = preHtml.replace('</body>', `${scriptTag}</body>`);
  } else {
    preHtml += scriptTag;
  }

  // 7. Minify final HTML
  console.log(`- Minifying combined HTML document...`);
  const minifiedHtml = htmlMinifier.minify(preHtml, {
    collapseWhitespace: true,
    removeComments: true,
    removeAttributeQuotes: true,
    minifyCSS: false, // CSS already minified
    minifyJS: false,  // JS already minified
    removeRedundantAttributes: true,
    useShortDoctype: true,
    removeEmptyAttributes: true
  });

  const htmlBuffer = Buffer.from(minifiedHtml, 'utf8');
  console.log(`- Final uncompressed HTML size: ${(htmlBuffer.length / 1024).toFixed(1)} KB (${htmlBuffer.length} bytes)`);

  // 8. Compress using GZIP (level 9)
  let gzBuffer = zlib.gzipSync(htmlBuffer, { level: 9 });
  console.log(`- GZIP compressed size: ${(gzBuffer.length / 1024).toFixed(1)} KB (${gzBuffer.length} bytes)`);

  // Write uncompressed and initial GZ files
  const outHtm = path.join(OUTPUT_DIR, `Firmware-${targetName}.htm`);
  const outGz = path.join(OUTPUT_DIR, `Firmware-${targetName}.gz`);
  fs.writeFileSync(outHtm, htmlBuffer);
  fs.writeFileSync(outGz, gzBuffer);

  // 9. Optimize GZIP with AdvanceCOMP (advdef) if available
  try {
    execSync(`advdef -z -4 -i 100 "${outGz}"`, { stdio: 'pipe' });
    gzBuffer = fs.readFileSync(outGz);
    console.log(`- AdvanceCOMP (advdef) optimized GZIP size: ${(gzBuffer.length / 1024).toFixed(1)} KB (${gzBuffer.length} bytes)`);
  } catch (e) {
    // advdef not mandatory
  }

  const etag = createETag(gzBuffer);
  const base64Payload = gzBuffer.toString('base64');

  return {
    target: targetName,
    uncompressedSize: htmlBuffer.length,
    compressedSize: gzBuffer.length,
    etag: etag,
    base64Payload: base64Payload,
    htmFile: outHtm,
    gzFile: outGz
  };
}

async function main() {
  console.log('Intel AMT Firmware Web Application Compiler (Modern Build Pipeline)');
  console.log(`MeshCommander HEAD: ${SOURCE_DIR}`);
  console.log(`Output Directory:   ${OUTPUT_DIR}`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allFeatures = discoverAllFeatures(SOURCE_DIR);
  console.log(`Discovered ${allFeatures.length} feature directives across codebase.`);

  const args = process.argv.slice(2);
  const targetArg = args.find(a => ['large', 'medium', 'small'].includes(a.toLowerCase()));

  const targetsToBuild = targetArg 
    ? [targetArg.charAt(0).toUpperCase() + targetArg.slice(1).toLowerCase()]
    : ['Small', 'Medium', 'Large'];

  const results = {};
  for (const t of targetsToBuild) {
    const res = await compileTarget(t, TARGET_DEFINITIONS[t], allFeatures);
    results[t] = res;
  }

  // Generate JavaScript module containing the embedded payloads for MeshCmd / MeshCentral
  const payloadsJsPath = path.join(OUTPUT_DIR, 'firmware-payloads.js');
  let jsModule = `/**
 * Compiled Intel AMT Firmware Web Applications for MeshCommander
 * Generated automatically from MeshCommander HEAD.
 * Suitable for embedding directly into meshcmd or loading into Intel AMT firmware flash storage.
 */

`;

  for (const [t, data] of Object.entries(results)) {
    jsModule += `// MeshCommander ${t} Firmware Web Application (GZIP'ed, Base64)\n`;
    jsModule += `exports.${t}_IntelAmtWebApp_etag = "${data.etag}";\n`;
    jsModule += `exports.${t}_IntelAmtWebApp = "${data.base64Payload}";\n\n`;
  }

  fs.writeFileSync(payloadsJsPath, jsModule);

  console.log('\n========================================');
  console.log('BUILD COMPLETE SUMMARY:');
  console.log('========================================');
  for (const [t, data] of Object.entries(results)) {
    console.log(`Target ${t.padEnd(8)}: HTML ${(data.uncompressedSize / 1024).toFixed(1)} KB -> GZIP ${(data.compressedSize / 1024).toFixed(1)} KB (ETag: ${data.etag})`);
    console.log(`  -> HTM: ${data.htmFile}`);
    console.log(`  -> GZ:  ${data.gzFile}`);
  }
  console.log(`\nGenerated MeshCentral/MeshCmd embeddable module:`);
  console.log(`  -> ${payloadsJsPath}`);
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
