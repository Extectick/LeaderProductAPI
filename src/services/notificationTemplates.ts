const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const TELEGRAM_BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@+/, '').trim();
const TELEGRAM_MINI_APP_SHORT_NAME = String(process.env.TELEGRAM_MINI_APP_SHORT_NAME || '')
  .replace(/^\/+|\/+$/g, '')
  .trim();

function miniAppLink(appealId: number): string {
  if (!TELEGRAM_BOT_USERNAME || !Number.isFinite(appealId) || appealId <= 0) return '';
  const startParam = encodeURIComponent(`appeal_${appealId}`);
  if (TELEGRAM_MINI_APP_SHORT_NAME) {
    return `https://t.me/${TELEGRAM_BOT_USERNAME}/${TELEGRAM_MINI_APP_SHORT_NAME}?startapp=${startParam}`;
  }
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?startapp=${startParam}`;
}

function appealLink(appealId: number, number: number): string {
  const tgMiniApp = miniAppLink(appealId);
  if (tgMiniApp) {
    return `<a href="${tgMiniApp}">обращение #${number}</a>`;
  }
  if (FRONTEND_URL) {
    return `<a href="${FRONTEND_URL}/services/appeals/${appealId}">обращение #${number}</a>`;
  }
  return `обращение #${number}`;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN:        'Открыто',
  IN_PROGRESS: 'В работе',
  COMPLETED:   'Выполнено',
  DECLINED:    'Отклонено',
  RESOLVED:    'Решено',
};

export function tplNewAppeal(opts: {
  appealId: number;
  number: number;
  title: string | null | undefined;
  fromDeptName: string | null | undefined;
  creatorName: string;
}): string {
  const subject = opts.title ? ` «${opts.title}»` : '';
  const from = opts.fromDeptName ? ` из отдела <b>${opts.fromDeptName}</b>` : '';
  return (
    `📋 <b>Новое ${appealLink(opts.appealId, opts.number)}${subject}</b>\n` +
    `От: <b>${opts.creatorName}</b>${from}`
  );
}

export function tplStatusChanged(opts: {
  appealId: number;
  number: number;
  oldStatus: string;
  newStatus: string;
  changedByName: string;
}): string {
  const oldLabel = STATUS_LABELS[opts.oldStatus] ?? opts.oldStatus;
  const newLabel = STATUS_LABELS[opts.newStatus] ?? opts.newStatus;
  return (
    `🔄 Статус ${appealLink(opts.appealId, opts.number)} изменён\n` +
    `<b>${oldLabel}</b> → <b>${newLabel}</b>\n` +
    `Изменил: ${opts.changedByName}`
  );
}

export function tplDeadlineChanged(opts: {
  appealId: number;
  number: number;
  deadline: Date | null | undefined;
  changedByName: string;
}): string {
  const dl = opts.deadline
    ? `до <b>${opts.deadline.toLocaleDateString('ru-RU')}</b>`
    : '<b>удалён</b>';
  return (
    `⏰ Дедлайн ${appealLink(opts.appealId, opts.number)} изменён ${dl}\n` +
    `Изменил: ${opts.changedByName}`
  );
}

export function tplNewMessage(opts: {
  appealId: number;
  number: number;
  senderName: string;
  snippet: string;
}): string {
  const snip = opts.snippet.length > 100
    ? opts.snippet.slice(0, 100) + '…'
    : opts.snippet;
  return (
    `💬 Новое сообщение в ${appealLink(opts.appealId, opts.number)}\n` +
    `<b>${opts.senderName}:</b> ${snip}`
  );
}

export function tplUnreadReminder(opts: {
  appealId: number;
  number: number;
  hoursUnread: number;
}): string {
  return (
    `⚠️ ${appealLink(opts.appealId, opts.number)} содержит непрочитанные сообщения\n` +
    `Никто не отвечал более <b>${opts.hoursUnread} ч</b>. Пожалуйста, проверьте.`
  );
}

export function tplClosureReminder(opts: {
  appealId: number;
  number: number;
  hoursWaiting: number;
}): string {
  return (
    `✅ ${appealLink(opts.appealId, opts.number)} ожидает вашего закрытия\n` +
    `Исполнитель завершил работу <b>${opts.hoursWaiting} ч</b> назад.\n` +
    `Подтвердите или отклоните обращение.`
  );
}
