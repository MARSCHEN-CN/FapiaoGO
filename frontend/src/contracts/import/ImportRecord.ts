import type { PageDescriptor } from './PageDescriptor'

export type ImportRecordStatus =
  | 'pending'
  | 'splitting'
  | 'ready'
  | 'parsing'
  | 'parsed'
  | 'error'

export interface ImportRecord {
  id: string
  name: string
  status: ImportRecordStatus
  pageCount: number
  invoiceId?: string
  pageDescriptors: PageDescriptor[]
  sessionId: string

  path?: string
  printPath?: string
  fileFormat?: string
  invoiceType?: string
  invoiceNumber?: string
  amount?: number
  invoiceDate?: string
}