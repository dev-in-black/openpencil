import { writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { output, outputError } from '../output';

interface GlobalFlags {
  file?: string;
  page?: string;
}

/**
 * Locate the canvaskit.wasm file from the installed canvaskit-wasm package.
 * Works in both development (source) and compiled (esbuild CJS) contexts.
 */
function makeCanvasKitLocator(): (file: string) => string {
  try {
    const r = createRequire(__filename);
    const ckMain = r.resolve('canvaskit-wasm');
    const wasmDir = dirname(ckMain);
    return (file: string) => join(wasmDir, file);
  } catch {
    // Fallback: let CanvasKit try its default resolution
    return (file: string) => file;
  }
}

/**
 * Resolve a font base path for headless rendering.
 * Tries the user-supplied path first, then looks for the web app's public
 * fonts directory relative to common monorepo layouts, and finally falls
 * back to undefined (fonts will be fetched from Google Fonts CDN).
 */
async function resolveFontBasePath(fontPath?: string): Promise<string | undefined> {
  const candidates: string[] = [];

  if (fontPath) {
    candidates.push(resolve(fontPath));
  }

  // Monorepo dev: fonts live at <root>/apps/web/public/fonts/
  const cwd = process.cwd();
  candidates.push(join(cwd, 'apps', 'web', 'public', 'fonts'));
  // One level up (in case CWD is a sub-package)
  candidates.push(join(cwd, '..', 'apps', 'web', 'public', 'fonts'));
  candidates.push(join(cwd, '..', '..', 'apps', 'web', 'public', 'fonts'));

  for (const dir of candidates) {
    try {
      await access(join(dir, 'inter-400.woff2'));
      // Trailing slash required by SkiaFontManager
      return pathToFileURL(dir).href + '/';
    } catch {
      // Not found — try next
    }
  }

  return undefined; // fall back to Google Fonts CDN
}

async function exportHeadless(
  filePath: string,
  flags: GlobalFlags & { out?: string; format?: string; multiplier?: string; fontPath?: string },
  args: string[],
): Promise<void> {
  const { openDocument, resolveDocPath } = await import('@zseven-w/pen-mcp');
  const { renderDocumentPage } = await import('@zseven-w/pen-renderer');

  const doc = await openDocument(resolveDocPath(filePath));
  const format = (flags.format ?? 'png') as 'png' | 'jpeg' | 'webp';
  const multiplier = flags.multiplier ? parseFloat(flags.multiplier) : 1;
  const fontBasePath = await resolveFontBasePath(flags.fontPath);

  const result = await renderDocumentPage(doc, {
    pageId: flags.page ?? null,
    format,
    multiplier,
    canvasKitOptions: { locateFile: makeCanvasKitLocator() },
    fontOptions: fontBasePath ? { fontBasePath } : undefined,
  });

  const outPath = flags.out ?? args[0] ?? `${result.name}.${result.ext}`;
  await writeFile(outPath, result.bytes);
  output({ ok: true, filePath: outPath, format: result.ext, name: result.name });
}

async function exportViaServer(
  flags: GlobalFlags & { out?: string; format?: string; multiplier?: string },
  args: string[],
): Promise<void> {
  const { requireApp } = await import('../connection');
  const url = await requireApp();

  const body = {
    pageId: flags.page,
    format: flags.format ?? 'png',
    multiplier: flags.multiplier ? parseFloat(flags.multiplier) : 1,
    timeoutMs: 30000,
  };

  const res = await fetch(`${url}/api/mcp/export-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    outputError(`Export failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
    return;
  }

  const data = (await res.json()) as {
    success: boolean;
    imageBase64?: string;
    ext?: string;
    name?: string;
    error?: string;
  };

  if (!data.success || !data.imageBase64) {
    outputError(data.error ?? 'Export failed');
    return;
  }

  const outPath = flags.out ?? args[0] ?? `${data.name ?? 'page'}.${data.ext ?? 'png'}`;
  const bytes = Buffer.from(data.imageBase64, 'base64');
  await writeFile(outPath, bytes);
  output({ ok: true, filePath: outPath, format: data.ext, name: data.name });
}

export async function cmdExportPage(
  args: string[],
  flags: GlobalFlags & { out?: string; format?: string; multiplier?: string; fontPath?: string },
): Promise<void> {
  if (flags.file) {
    // Headless: render locally from .op file — no running server needed
    await exportHeadless(flags.file, flags, args);
  } else {
    // Server: delegate rendering to the active editor browser client
    await exportViaServer(flags, args);
  }
}
