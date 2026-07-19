export interface ImportPolicy {
  parseBatchSize: number

  splitFetchConcurrency: number

  maxMaterializedFiles: number

  batchDelayMs: number
}

export const DEFAULT_IMPORT_POLICY: ImportPolicy = {
  parseBatchSize: 50,
  splitFetchConcurrency: 4,
  maxMaterializedFiles: 100,
  batchDelayMs: 100,
}

export const LOW_END_IMPORT_POLICY: ImportPolicy = {
  parseBatchSize: 30,
  splitFetchConcurrency: 2,
  maxMaterializedFiles: 50,
  batchDelayMs: 150,
}

export const HIGH_END_IMPORT_POLICY: ImportPolicy = {
  parseBatchSize: 200,
  splitFetchConcurrency: 8,
  maxMaterializedFiles: 300,
  batchDelayMs: 50,
}