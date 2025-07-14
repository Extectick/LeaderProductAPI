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
        subject: 'Код подтверждения регистрации',
        text: `Ваш код подтверждения: ${code}`,
        html: `
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2 style="color: #333;">Код подтверждения регистрации</h2>
                <p style="font-size: 18px; color: #555;">Ваш код подтверждения:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background-color: #f0f0f0; border-radius: 8px; padding: 10px 20px; display: inline-block; user-select: all;">
                    ${code}
                </div>
                <p style="font-size: 14px; color: #999; margin-top: 20px;">Если вы не запрашивали этот код, просто проигнорируйте это письмо.</p>
            </div>
        `,
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`Verification email sent to ${to}`);
    }
    catch (error) {
        console.error('Error sending verification email:', error);
    }
}
