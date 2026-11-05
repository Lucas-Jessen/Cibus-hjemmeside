const { ClientSecretCredential } = require('@azure/identity');

// Sends mail through Microsoft Graph as a shared sender mailbox. Requires an Entra app with the application
// permission Mail.Send (admin consent), ideally limited to the sender mailbox with an application access policy.
function createGraphMailer({ tenantId, clientId, clientSecret, sender, fetchImpl = fetch, credential = null } = {}) {
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  const tokenSource = credential || new ClientSecretCredential(tenantId, clientId, clientSecret);
  return {
    sender,
    async send({ to, subject, text, html }) {
      const token = await tokenSource.getToken('https://graph.microsoft.com/.default');
      const response = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(30 * 1000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Graph sendMail svarede ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    },
  };
}

module.exports = { createGraphMailer };
