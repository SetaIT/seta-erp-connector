import test from 'node:test';
import assert from 'node:assert/strict';
import { findEmailByOutlookMessageId, outlookMessageIdFromHeaders } from '../commercial-email-idempotency.js';

test('extracts Outlook message ID from HubSpot email headers', () => {
  assert.equal(outlookMessageIdFromHeaders('{"messageId":"outlook-123"}'), 'outlook-123');
  assert.equal(outlookMessageIdFromHeaders('invalid-json'), null);
});

test('finds an email already registered from the same Outlook send', () => {
  const emails = [
    { id: 'email-1', properties: { hs_email_headers: '{"messageId":"outlook-123"}' } },
    { id: 'email-2', properties: { hs_email_headers: '{"messageId":"outlook-456"}' } }
  ];
  assert.equal(findEmailByOutlookMessageId(emails, 'outlook-456')?.id, 'email-2');
  assert.equal(findEmailByOutlookMessageId(emails, 'outlook-missing'), null);
});
