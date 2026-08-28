export function outlookMessageIdFromHeaders(rawHeaders) {
  if (!rawHeaders) return null;
  try {
    const headers = typeof rawHeaders === 'string' ? JSON.parse(rawHeaders) : rawHeaders;
    return String(headers?.messageId || headers?.message_id || headers?.['internet-message-id'] || '').trim() || null;
  } catch {
    return null;
  }
}

export function findEmailByOutlookMessageId(emails, outlookMessageId) {
  const expected = String(outlookMessageId || '').trim();
  if (!expected) return null;
  return (Array.isArray(emails) ? emails : []).find(email => (
    outlookMessageIdFromHeaders(email?.properties?.hs_email_headers) === expected
  )) || null;
}
