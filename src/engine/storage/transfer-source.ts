import { constants, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZVecOpen, type ZVecCollection, type ZVecDoc } from "@zvec/zvec";
import { resolveWorkspaceIndexStoragePaths } from "./layout.js";

// Callers hold the source read lock across this read. Native readOnly opens
// can still change vector-index metadata. Open private copies, never the
// original files. Reflinks reduce copying where supported; no hard links.
export function readNativeTransferSource(sourceHome: string): {
  fileDocs: ZVecDoc[];
  entityDocs: ZVecDoc[];
} {
  const snapshot = mkdtempSync(join(tmpdir(), "zg-transfer-source-"));
  const handles: ZVecCollection[] = [];
  const errors: unknown[] = [];
  let result: { fileDocs: ZVecDoc[]; entityDocs: ZVecDoc[] } | undefined;
  try {
    const source = resolveWorkspaceIndexStoragePaths(sourceHome);
    const copy = resolveWorkspaceIndexStoragePaths(snapshot);
    for (const key of ["filesPath", "indexPath"] as const) {
      cpSync(source[key], copy[key], {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
        force: false,
        errorOnExist: true,
      });
    }
    const files = open(copy.filesPath);
    const entities = open(copy.indexPath);
    result = {
      fileDocs: [...files.iterDocsSync({ includeVector: false })],
      entityDocs: [...entities.iterDocsSync({ includeVector: true })],
    };
  } catch (error) {
    errors.push(error);
  } finally {
    for (const handle of handles.reverse()) {
      try {
        handle.closeSync();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      rmSync(snapshot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Transfer source read or cleanup failed: ${errors.map(String).join("; ")}`,
    );
  }
  return result!;

  function open(path: string): ZVecCollection {
    const handle = ZVecOpen(path, { readOnly: true, enableMMAP: false });
    handles.push(handle);
    return handle;
  }
}
