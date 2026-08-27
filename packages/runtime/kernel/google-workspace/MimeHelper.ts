export class MimeHelper {

  public static createMimeMessage({
    to,
    subject,
    body,
    from,
    cc,
    bcc,
    replyTo,
    inReplyTo,
    references,
    isHtml = false,
  }: {
    to: string;
    subject: string;
    body: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
    isHtml?: boolean;
  }): string {

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    const messageParts: string[] = [];

    if (from) {
      messageParts.push(`From: ${from}`);
    }

    messageParts.push(`To: ${to}`);

    if (cc) {
      messageParts.push(`Cc: ${cc}`);
    }

    if (bcc) {
      messageParts.push(`Bcc: ${bcc}`);
    }

    if (replyTo) {
      messageParts.push(`Reply-To: ${replyTo}`);
    }

    if (inReplyTo) {
      messageParts.push(`In-Reply-To: ${inReplyTo}`);
    }

    if (references) {
      messageParts.push(`References: ${references}`);
    }

    messageParts.push(`Subject: ${utf8Subject}`);

    if (isHtml) {
      messageParts.push('Content-Type: text/html; charset=utf-8');
    } else {
      messageParts.push('Content-Type: text/plain; charset=utf-8');
    }

    messageParts.push('');
    messageParts.push(body);

    const message = messageParts.join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return encodedMessage;
  }

  public static createMimeMessageWithAttachments({
    to,
    subject,
    body,
    from,
    cc,
    bcc,
    attachments,
    isHtml = false,
  }: {
    to: string;
    subject: string;
    body: string;
    from?: string;
    cc?: string;
    bcc?: string;
    attachments?: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }>;
    isHtml?: boolean;
  }): string {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    const messageParts: string[] = [];

    if (from) {
      messageParts.push(`From: ${from}`);
    }
    messageParts.push(`To: ${to}`);
    if (cc) {
      messageParts.push(`Cc: ${cc}`);
    }
    if (bcc) {
      messageParts.push(`Bcc: ${bcc}`);
    }
    messageParts.push(`Subject: ${utf8Subject}`);
    messageParts.push('MIME-Version: 1.0');

    if (!attachments || attachments.length === 0) {

      return this.createMimeMessage({
        to,
        subject,
        body,
        from,
        cc,
        bcc,
        isHtml,
      });
    }

    messageParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    messageParts.push('');

    messageParts.push(`--${boundary}`);
    if (isHtml) {
      messageParts.push('Content-Type: text/html; charset=utf-8');
    } else {
      messageParts.push('Content-Type: text/plain; charset=utf-8');
    }
    messageParts.push('');
    messageParts.push(body);

    for (const attachment of attachments) {
      messageParts.push(`--${boundary}`);
      messageParts.push(
        `Content-Type: ${attachment.contentType || 'application/octet-stream'}`,
      );
      messageParts.push('Content-Transfer-Encoding: base64');
      messageParts.push(
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
      );
      messageParts.push('');

      const content =
        typeof attachment.content === 'string'
          ? attachment.content
          : attachment.content.toString('base64');

      const chunks = content.match(/.{1,76}/g) || [];
      messageParts.push(...chunks);
    }

    messageParts.push(`--${boundary}--`);

    const message = messageParts.join('\r\n');

    return Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  public static decodeBase64Url(encoded: string): string {

    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf-8');
  }
}
