import {z} from 'zod';
export const mailProviders={mail:{label:'Mail.ru',host:'smtp.mail.ru',help:'https://help.mail.ru/mail/login/mailer/'},yandex:{label:'Яндекс',host:'smtp.yandex.ru',help:'https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others'}} as const;
export const providerSchema=z.enum(['mail','yandex']);
export type MailProvider=z.infer<typeof providerSchema>;
export const mailAddress=z.string().trim().email().max(254).refine(value=>!/[\r\n\0<>]/.test(value));
export const connectSchema=z.object({email:mailAddress,password:z.string().min(1).max(512).refine(value=>!/[\r\n\0]/.test(value))}).strict();
export const draftSchema=z.object({provider:providerSchema,to:z.array(mailAddress).min(1).max(20),subject:z.string().trim().min(1).max(300).refine(value=>!/[\r\n\0]/.test(value)),text:z.string().min(1).max(40000),attachmentIds:z.array(z.string().uuid()).max(3).default([])}).strict();
export type MailDraftInput=z.infer<typeof draftSchema>;
export class PersonalMailError extends Error{constructor(public code:string,public status=400){super(code);}}
export const mailMessages:Record<string,string>={MAIL_AUTH_FAILED:'Проверьте адрес и пароль приложения.',MAIL_UNAVAILABLE:'Не удалось подключиться к почтовому серверу.',MAIL_NOT_CONNECTED:'Подключите почту в профиле.',MAIL_CHANGED:'Подключение изменилось. Повторите действие.',MAIL_RATE_LIMIT:'Слишком много попыток. Повторите через 15 минут.',MAIL_FORBIDDEN:'Почта доступна сотрудникам с действующим профилем.',MAIL_DRAFT_NOT_FOUND:'Письмо не найдено.',MAIL_CONFIRMATION_REQUIRED:'Проверьте письмо перед отправкой.',MAIL_ATTACHMENT_UNAVAILABLE:'Вложение недоступно. Подготовьте письмо заново.',MAIL_VAULT_UNAVAILABLE:'Хранилище подключений временно недоступно.',MAIL_HTTPS_REQUIRED:'Для передачи пароля требуется HTTPS.',MAIL_NOT_SENT:'Почтовый сервер не принял письмо.'};
