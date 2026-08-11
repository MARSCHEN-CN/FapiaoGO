/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  OsLauncherBridge — JS ↔ SumatraPDF Print Bridge                ║
 * ║                                                                  ║
 * ║  Bridge layer between PrintService (JS domain) and               ║
 * ║  SumatraPDF.exe (OS execution domain).                           ║
 * ║                                                                  ║
 * ║  Contract:                                                        ║
 * ║  - Receives PrintJob from PrintService                           ║
 * ║  - Constructs SumatraPDF command line                            ║
 * ║  - Calls execFile(SumatraPDF, args)                              ║
 * ║  - Captures stdout, stderr, exit code                           ║
 * ║  - Returns OsPrintResult                                         ║
 * ║                                                                  ║
 * ║  Paper strategy:                                                  ║
 * ║  - Standard sizes (A4/A3/Letter): use -print-settings "paper=X"  ║
 * ║  - Custom/Voucher: PDF already has correct MediaBox from          ║
 * ║    pngToPdf(), use -print-settings "noscale" to preserve it      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { app } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { PrintJob, PrintJobEmitter, OsPrintResult } from '../print-service/os-boundary-contract';

// ─── SumatraPDF Path ──────────────────────────────────────────────

function getSumatraPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sumatra', 'SumatraPDF.exe');
  }
  return path.join(__dirname, '../../resources/sumatra/SumatraPDF.exe');
}

// ─── Paper Size Mapping ──────────────────────────────────────────

/**
 * Map paper sizes SumatraPDF understands via -print-settings "paper=X".
 * For unknown/custom sizes, we use "noscale" and let the PDF's MediaBox
 * define the page dimensions.
 */
const SUMATRA_PAPER_SIZES: Readonly<Record<string, string>> = {
  A4: 'A4',
  A5: 'A5',
  A3: 'A3',
  Letter: 'letter',
  Legal: 'legal',
  PostScript: 'PostScript',
};

function buildPrintSettings(job: PrintJob): string {
  const orientation = job.orientation === 'landscape' ? 'landscape' : 'portrait';
  const paperName = SUMATRA_PAPER_SIZES[job.paperSize];

  if (paperName) {
    // Standard paper: use SumatraPDF's built-in size
    return `paper=${paperName},${orientation},noscale`;
  }

  // Custom/Voucher paper: PDF already has correct MediaBox, don't scale
  return `${orientation},noscale`;
}

// ─── OsLauncherBridge ───────────────────────────────────────────

export class OsLauncherBridge implements PrintJobEmitter {
  private readonly sumatraPath: string;

  constructor() {
    this.sumatraPath = getSumatraPath();

    if (!fs.existsSync(this.sumatraPath)) {
      throw new Error(`[OsLauncherBridge] SumatraPDF not found at: ${this.sumatraPath}`);
    }
  }

  /**
   * Send a PrintJob to SumatraPDF for execution.
   *
   * @param job PrintJob from PrintService
   * @returns OsPrintResult with execution result
   */
  async emit(job: PrintJob): Promise<OsPrintResult> {
    const printSettings = buildPrintSettings(job);

    // ── Build SumatraPDF arguments ──
    // Order: file → print-to → print-settings → silent → exit-when-done
    const args: string[] = [job.pdfPath]; // file first

    if (job.printerName && job.printerName.trim()) {
      args.push('-print-to', job.printerName.trim());
    } else {
      args.push('-print-to', 'default');
    }

    args.push('-print-settings', printSettings);
    args.push('-silent');
    args.push('-exit-when-done');

    console.log('[OsLauncherBridge] Executing:');
    console.log(`  Binary: ${this.sumatraPath}`);
    console.log(`  Args:   ${args.join(' ')}`);
    console.log(`  PDF:    ${job.pdfPath}`);
    console.log(`  Paper:  ${job.paperSize} / ${job.orientation}`);
    console.log(`  Printer: ${job.printerName || '(default)'}`);

    // ── Execute ──
    return new Promise((resolve) => {
      const child = execFile(
        this.sumatraPath,
        args,
        { timeout: 120000 }, // 2 min timeout
        (error, stdout, stderr) => {
          const exitCode = error?.code ?? 0;
          const isTimeout = error?.killed === true;

          console.log('[OsLauncherBridge] Result:');
          console.log(`  exitCode: ${exitCode}`);
          if (stdout) console.log(`  stdout:   ${stdout.trim().slice(0, 500)}`);
          if (stderr) console.log(`  stderr:   ${stderr.trim().slice(0, 500)}`);
          if (isTimeout) console.log(`  timeout:  true`);

          if (exitCode === 0 && !error) {
            resolve({
              jobId: null, // SumatraPDF doesn't expose jobId
              status: 'submitted',
            });
          } else {
            const errMsg = isTimeout
              ? 'SumatraPDF timed out (120s)'
              : stderr?.trim() || error?.message || `exit code ${exitCode}`;
            console.error(`[OsLauncherBridge] FAILED: ${errMsg}`);
            resolve({
              jobId: null,
              status: 'failed',
              error: errMsg,
            });
          }
        }
      );

      // Log child process info
      if (child.pid) {
        console.log(`[OsLauncherBridge] Process started, PID: ${child.pid}`);
      }
    });
  }

  /**
   * Verify SumatraPDF binary exists.
   */
  verifyBinary(): boolean {
    return fs.existsSync(this.sumatraPath);
  }

  /**
   * Get the full path to SumatraPDF.
   */
  getBinaryPath(): string {
    return this.sumatraPath;
  }
}

export default OsLauncherBridge;
