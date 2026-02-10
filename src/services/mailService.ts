import nodemailer from 'nodemailer';

type AuthEmailPurpose = 'verification' | 'passwordReset' | 'emailChange';

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const smtpSecure =
  typeof process.env.SMTP_SECURE === 'string'
    ? ['1', 'true', 'yes'].includes(process.env.SMTP_SECURE.toLowerCase())
    : smtpPort === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendVerificationEmail(
  to: string,
  code: string,
  purpose: AuthEmailPurpose = 'verification'
) {
  const isReset = purpose === 'passwordReset';
  const isEmailChange = purpose === 'emailChange';
  const subject = isReset
    ? 'Password Reset Code'
    : isEmailChange
    ? 'Email Change Verification Code'
    : 'Email Verification Code';
  const text = isReset
    ? `Your password reset code is: ${code}`
    : isEmailChange
    ? `Your email change verification code is: ${code}`
    : `Your verification code is: ${code}`;
  const html = isReset
    ? `<p>Your password reset code is: <b>${code}</b></p>`
    : isEmailChange
    ? `<p>Your email change verification code is: <b>${code}</b></p>`
    : `<p>Your verification code is: <b>${code}</b></p>`;

  const mailOptions = {
    from: process.env.SMTP_FROM || '"No Reply" <no-reply@example.com>',
    to,
    subject,
    text,
    html,
  };
  try {
    await transporter.sendMail(mailOptions);
    const type = isReset ? 'Password reset' : isEmailChange ? 'Email change' : 'Verification';
    console.log(`${type} email sent to ${to}`);
  } catch (error) {
    console.error('Error sending verification email:', error);
  }
}
