"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerificationEmail = sendVerificationEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: true, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});
async function sendVerificationEmail(to, code) {
    const mailOptions = {
        from: process.env.SMTP_FROM || '"No Reply" <no-reply@example.com>',
        to,
        subject: 'Email Verification Code',
        text: `Your verification code is: ${code}`,
        html: `<p>Your verification code is: <b>${code}</b></p>`,
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`Verification email sent to ${to}`);
    }
    catch (error) {
        console.error('Error sending verification email:', error);
    }
}
