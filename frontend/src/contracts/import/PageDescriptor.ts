export interface PageDescriptor {
  id: string

  sourceDocId: string

  pageIndex: number

  pageSize: {
    width: number
    height: number
  }

  previewUrl?: string

  status:
    | 'pending'
    | 'ready'
    | 'parsing'
    | 'done'
    | 'error'
}