export function toFileCardViewModel(record) {
  return {
    key: record.id,
    id: record.id,
    name: record.name,
    status: record.status || 'pending',
    invoiceType: record.invoiceType,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    amount: record.amount,
    failedFields: record.failedFields || [],
    fileFormat: record.fileFormat,
    path: record.path,
    printPath: record.printPath,
    pageCount: record.pageCount,
    invoiceId: record.invoiceId,
    pageDescriptors: record.pageDescriptors || [],
  }
}

export function canMaterialize(record) {
  return record.status === 'parsed' && record.pageDescriptors && record.pageDescriptors.length > 0
}

export function getPrimaryDescriptor(record) {
  if (!record.pageDescriptors || record.pageDescriptors.length === 0) {
    return null
  }
  return record.pageDescriptors[0]
}

export function toLegacyFileObj(record) {
  const descriptor = getPrimaryDescriptor(record)
  return {
    key: record.id,
    id: record.id,
    name: record.name,
    status: record.status || 'pending',
    file: null,
    path: record.path,
    printPath: record.printPath,
    fileFormat: record.fileFormat,
    invoiceType: record.invoiceType,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    amount: record.amount,
    failedFields: record.failedFields || [],
    previewImage: descriptor?.previewUrl,
    _pageDescriptor: descriptor,
  }
}