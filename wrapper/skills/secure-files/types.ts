/**
 * Types for the secure-files skill.
 */

export type SecureFilesAction =
  | "read"
  | "write"
  | "move"
  | "delete"
  | "summarise"
  | "watch"
  | "unwatch";

export interface SecureFilesInput {
  action: SecureFilesAction;
  /** File or directory path — relative to sandbox root or absolute within it. */
  path?: string;
  /** Destination path for 'move'. */
  destPath?: string;
  /** UTF-8 file content for 'write'. */
  content?: string;
  /** Must be explicitly true to execute a 'delete'. */
  confirmed?: boolean;
  /** Watcher id returned by 'watch' — required for 'unwatch'. */
  watcherId?: string;
}

export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

export interface SecureFilesOutput {
  success: boolean;
  message: string;
  data?: {
    content?: string;
    summary?: string;
    fileInfo?: FileInfo;
    watcherId?: string;
    /** Present on unconfirmed delete — instructs the caller to re-submit with confirmed:true. */
    requiresConfirmation?: boolean;
    filePath?: string;
    fileSize?: number;
  };
}

/** Pre-write snapshot used by the undo system. */
export interface FileSnapshot {
  /** Resolved absolute path. */
  path: string;
  /** Content before the write. null if the file did not previously exist. */
  content: Buffer | null;
  existed: boolean;
}

/** Pre-move snapshot used by the undo system. */
export interface MoveSnapshot {
  srcPath: string;
  destPath: string;
}

/**
 * Filesystem adapter — injectable for testing.
 * All paths passed in are already resolved and sandbox-validated.
 */
export interface IFileSystemAdapter {
  readFile(filePath: string): Promise<Buffer>;
  writeFile(filePath: string, content: Buffer): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  lstat(filePath: string): Promise<{ isSymbolicLink(): boolean; size: number }>;
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ size: number; isDirectory(): boolean; mtimeMs: number }>;
  watch(
    dirPath: string,
    callback: (event: string, filename: string | null) => void,
  ): { close(): void };
}
