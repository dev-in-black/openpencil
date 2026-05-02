/**
 * Headless page export — renders a PenDocument page to image bytes using
 * CanvasKit WASM with no browser/DOM dependencies.
 *
 * Works in Node.js, Bun, Deno, and any environment where CanvasKit can run.
 * Text heights fall back to estimates (premeasureTextHeights is skipped when
 * document.createElement is unavailable). Images inside designs are skipped
 * unless a custom image resolver is provided.
 */

import type { PenDocument, PenNode } from '@zseven-w/pen-types';
import { resolveNodeForCanvas, getDefaultTheme } from '@zseven-w/pen-core';
import { loadCanvasKit } from './init.js';
import type { LoadCanvasKitOptions } from './init.js';
import { SkiaNodeRenderer } from './node-renderer.js';
import type { SkiaFontManager, FontManagerOptions } from './font-manager.js';
import { flattenToRenderNodes, resolveRefs, premeasureTextHeights } from './document-flattener.js';
import type { RenderNode } from './types.js';

export type HeadlessExportFormat = 'png' | 'jpeg' | 'webp';

export interface HeadlessExportOptions {
  /** Page ID to render. Defaults to the first page. */
  pageId?: string | null;
  /** Output format. Default: 'png' */
  format?: HeadlessExportFormat;
  /** Pixel density multiplier. Default: 1 */
  multiplier?: number;
  /**
   * Options forwarded to loadCanvasKit — use `locateFile` to point at the
   * canvaskit.wasm file when running outside a browser.
   *
   * @example
   * // Node.js / esbuild CJS bundle
   * import { createRequire } from 'module';
   * import { dirname, join } from 'path';
   * const r = createRequire(__filename);
   * const wasmDir = dirname(r.resolve('canvaskit-wasm'));
   * // { locateFile: (f) => join(wasmDir, f) }
   */
  canvasKitOptions?: LoadCanvasKitOptions;
  /**
   * Font manager options forwarded to SkiaNodeRenderer.
   * Set `fontBasePath` to a `file://` URL pointing at a directory containing
   * the bundled `.woff2` files (e.g. `apps/web/public/fonts/`) so fonts can
   * be loaded from disk in a Node.js / CLI context.
   *
   * @example
   * // Point at the web app's public fonts dir (monorepo dev)
   * { fontBasePath: 'file:///path/to/apps/web/public/fonts/' }
   */
  fontOptions?: FontManagerOptions;
}

export interface HeadlessExportResult {
  /** Encoded image bytes (PNG / JPEG / WEBP). */
  bytes: Uint8Array;
  /** Pixel width of the output image. */
  width: number;
  /** Pixel height of the output image. */
  height: number;
  /** Page name (sanitised). */
  name: string;
  /** File extension matching the format ('png', 'jpg', 'webp'). */
  ext: string;
}

/**
 * Maps woff2 filename stems (without weight suffix) to canonical family names.
 * Mirrors the BUNDLED_FONTS keys in font-manager.ts.
 */
const FILENAME_STEM_TO_FAMILY: Record<string, string> = {
  inter: 'Inter',
  'inter-ext': 'Inter Ext',
  poppins: 'Poppins',
  roboto: 'Roboto',
  montserrat: 'Montserrat',
  'open-sans': 'Open Sans',
  lato: 'Lato',
  raleway: 'Raleway',
  'dm-sans': 'DM Sans',
  'playfair-display': 'Playfair Display',
  nunito: 'Nunito',
  'source-sans-3': 'Source Sans 3',
  'noto-sans-sc': 'Noto Sans SC',
  'noto-sans-sc-latin': 'Noto Sans SC',
};

function fileToFamily(filename: string): string | null {
  // 'inter-400.woff2' → stem 'inter', 'inter-ext-400.woff2' → stem 'inter-ext'
  const base = filename.replace(/\.woff2$/, '');
  const stem = base.replace(/-\d+$/, '');
  return FILENAME_STEM_TO_FAMILY[stem] ?? null;
}

/**
 * Load fonts from a local directory directly via fs.readFile, then register
 * them with the font manager. This is more reliable than fetch('file://...')
 * in Node.js / Bun headless contexts where the file: protocol may throw.
 */
async function loadFontsFromDir(
  fontManager: SkiaFontManager,
  fontsDir: string,
  neededFamilies: Set<string>,
): Promise<void> {
  // Dynamic import keeps this module browser-safe (no top-level fs import)
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  let files: string[];
  try {
    files = await readdir(fontsDir);
  } catch {
    return; // directory not accessible
  }

  await Promise.all(
    files
      .filter((f) => f.endsWith('.woff2'))
      .map(async (file) => {
        const family = fileToFamily(file);
        if (!family) return;
        // Always load Inter (default fallback). Load others only if needed.
        const familyLower = family.replace(' Ext', '').toLowerCase();
        if (familyLower !== 'inter' && !neededFamilies.has(familyLower)) return;
        try {
          const buf = await readFile(join(fontsDir, file));
          // buf is a Node.js Buffer — convert to ArrayBuffer for CanvasKit
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          fontManager.registerFont(ab as ArrayBuffer, family);
        } catch {
          // skip individual file errors silently
        }
      }),
  );
}

/** Collect unique font families referenced by text nodes in the render list. */
function collectFontFamilies(renderNodes: RenderNode[]): string[] {
  const families = new Set<string>();
  const visit = (node: PenNode) => {
    if (node.type === 'text') {
      const family = (node as PenNode & { fontFamily?: string }).fontFamily;
      // fontFamily may be a comma-separated fallback list — take the first token
      const primary = family
        ? family.split(',')[0].trim().replace(/^["']|["']$/g, '')
        : 'Inter';
      families.add(primary || 'Inter');
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child as PenNode);
    }
  };
  for (const rn of renderNodes) visit(rn.node);
  return [...families];
}

function listPages(doc: PenDocument) {
  if (doc.pages && doc.pages.length > 0) {
    return doc.pages.map((p) => ({ id: p.id, name: p.name || 'Page', children: p.children }));
  }
  return [{ id: '__legacy__', name: 'Page 1', children: doc.children }];
}

/**
 * Render a single page of a PenDocument to encoded image bytes.
 *
 * This function is safe to call in Node.js / Bun without a DOM.
 * CanvasKit WASM must be findable — pass `canvasKitOptions.locateFile`
 * to point at the .wasm file when running in a bundled CLI context.
 */
export async function renderDocumentPage(
  doc: PenDocument,
  options: HeadlessExportOptions = {},
): Promise<HeadlessExportResult> {
  const { pageId, format = 'png', multiplier = 1, canvasKitOptions, fontOptions } = options;

  const ck = await loadCanvasKit(canvasKitOptions);

  const pages = listPages(doc);
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  if (!page) throw new Error('No page found in document');

  const allNodes = doc.pages?.length ? doc.pages.flatMap((p) => p.children) : doc.children;
  const resolved = resolveRefs(page.children, allNodes);
  const variables = doc.variables ?? {};
  const theme = getDefaultTheme(doc.themes);
  const varResolved = resolved.map((n) => resolveNodeForCanvas(n, variables, theme));
  // premeasureTextHeights is a no-op when document is undefined (Node.js safe)
  const measured = premeasureTextHeights(varResolved);
  const renderNodes = flattenToRenderNodes(measured);

  if (renderNodes.length === 0) throw new Error('Page has no visible nodes');

  // Compute bounding box from root-level (non-clipped) nodes
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const rn of renderNodes) {
    if (rn.clipRect) continue;
    if (rn.absX < minX) minX = rn.absX;
    if (rn.absY < minY) minY = rn.absY;
    if (rn.absX + rn.absW > maxX) maxX = rn.absX + rn.absW;
    if (rn.absY + rn.absH > maxY) maxY = rn.absY + rn.absH;
  }
  if (!isFinite(minX)) throw new Error('Could not compute page bounding box');

  const logicalW = Math.max(1, Math.ceil(maxX - minX));
  const logicalH = Math.max(1, Math.ceil(maxY - minY));
  const outW = Math.max(1, Math.ceil(logicalW * multiplier));
  const outH = Math.max(1, Math.ceil(logicalH * multiplier));

  // MakeSurface creates an offscreen surface — no HTML canvas element required
  const surface = ck.MakeSurface(outW, outH);
  if (!surface) throw new Error('CanvasKit MakeSurface failed');

  const nodeRenderer = new SkiaNodeRenderer(ck, fontOptions);

  // Pre-load all font families referenced by text nodes before drawing.
  // Without this, drawTextVector triggers async loads but drawing is synchronous,
  // so fonts are never ready in time and text nodes silently skip rendering.
  const rawFamilies = collectFontFamilies(renderNodes);
  const neededFamilies = new Set(rawFamilies.map((f) => f.toLowerCase()));

  const fontBasePath = fontOptions?.fontBasePath;
  if (fontBasePath?.startsWith('file://')) {
    // Fast path: read .woff2 files directly from disk via fs.readFile.
    // This is more reliable than fetch('file://...') in Bun/Node.js.
    const { fileURLToPath } = await import('node:url');
    const fontsDir = fileURLToPath(fontBasePath.replace(/\/$/, ''));
    await loadFontsFromDir(nodeRenderer.fontManager, fontsDir, neededFamilies);
  } else {
    // Network / CDN path: use ensureFonts which falls back to Google Fonts.
    const families = ['Inter', ...rawFamilies.filter((f) => f !== 'Inter')];
    await nodeRenderer.fontManager.ensureFonts(families);
    await nodeRenderer.fontManager.flushPending();
  }

  try {
    const canvas = surface.getCanvas();
    canvas.clear(format === 'jpeg' ? ck.WHITE : ck.TRANSPARENT);
    canvas.save();
    canvas.scale(multiplier, multiplier);
    canvas.translate(-minX, -minY);
    for (const rn of renderNodes) {
      nodeRenderer.drawNode(canvas, rn);
    }
    canvas.restore();
    surface.flush();

    const img = surface.makeImageSnapshot();
    const ckFormat =
      format === 'jpeg'
        ? ck.ImageFormat.JPEG
        : format === 'webp'
          ? ck.ImageFormat.WEBP
          : ck.ImageFormat.PNG;
    const quality = format === 'png' ? 100 : 92;
    const encoded = img.encodeToBytes(ckFormat, quality);
    if (!encoded) throw new Error('CanvasKit image encoding failed');

    const ext = format === 'jpeg' ? 'jpg' : format;
    const name = (page.name || 'page').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'page';
    return { bytes: encoded, width: outW, height: outH, name, ext };
  } finally {
    surface.delete();
  }
}
