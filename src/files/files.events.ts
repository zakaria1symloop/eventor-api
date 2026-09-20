export const FILE_EVENTS = {
  /** Image compression failed; notify the uploader (status-rules §11). */
  processingFailed: 'file.processing_failed',
  processed: 'file.processed',
} as const;

export interface FileProcessingEvent {
  fileId: string;
  ownerId: string | null;
  error?: string;
}
