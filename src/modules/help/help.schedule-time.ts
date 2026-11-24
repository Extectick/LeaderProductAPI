import {z} from 'zod';

const clock = (zone: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});

export const scheduleDraft = z.object({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(100).refine(zone => {
    try { clock(zone); return true; } catch { return false; }
  }, 'Проверьте часовой пояс'),
  warehouse: z.string().trim().min(1).max(200),
  metric: z.enum(['inStock','available']),
}).strict();
export type ScheduleDraft = z.infer<typeof scheduleDraft>;

export function nextHelpScheduleTime(time: string, timeZone: string, after: Date): Date {
  const format = clock(timeZone);
  function wallTime(instant: number) {
    const parts = format.formatToParts(instant);
    const part = (kind: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === kind)?.value);
    return Date.UTC(part('year'),part('month') - 1,part('day'),part('hour'),part('minute'));
  }
  const day = 86400000;
  const today = Math.floor(wallTime(after.getTime()) / day) * day;
  const [hours, minutes] = time.split(':').map(Number);
  for (let n=0; n<4; n++) {
    const wall = today + n*day + (hours*60 + minutes)*60000;
    // Skip nonexistent local times. A repeated local time has only one scheduled occurrence.
    const instants = [-day,0,day].map(shift => wall - (wallTime(wall + shift) - (wall + shift)));
    const first = Math.min(...instants.filter(instant => wallTime(instant) === wall));
    if (Number.isFinite(first) && first > after.getTime()) return new Date(first);
  }
  throw new Error('Не удалось рассчитать время проверки');
}
