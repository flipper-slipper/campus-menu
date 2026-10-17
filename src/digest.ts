// Daily email digest: today's and tomorrow's food first, then other events.

export interface DigestEvent {
  title: string; date: string; start_at: string | null; end_at: string | null;
  food: string | null; free_food: number | boolean; price: string | null;
  club: string; building: string | null; location_raw: string | null; room: string | null;
  shortcode: string; flags: string | null;
}

const TZ = 'America/New_York';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const clock = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).replace(':00', '') : null;
const day = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const where = (e: DigestEvent) => e.location_raw || e.building || 'Location TBA';
const when = (e: DigestEvent) => clock(e.start_at) ? clock(e.start_at) + (e.end_at ? '–' + clock(e.end_at) : '') : 'Time TBA';
const GENERIC_FOOD = /^(free\s+)?(food|food\s*(&|and)\s*drinks?|food provided|refreshments|snacks)(\s+provided)?$/i;

export function buildDigest(events: DigestEvent[], today: string, siteUrl: string) {
  const food = events.filter((e) => e.food);
  const other = events.filter((e) => !e.food);
  const todayCount = events.filter((e) => e.date === today).length;
  const shortDay = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const subject = events.length
    ? `Menu · ${shortDay}: ${food.length} with food, ${other.length} more event${other.length === 1 ? '' : 's'}`
    : `Menu · ${shortDay}: nothing posted yet`;

  const row = (e: DigestEvent) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #e4dcc6">
      <div style="font:13px Georgia,serif;color:#9a7426">${esc(when(e))}${e.food ? ' · food' : ''}</div>
      <div style="font:italic 19px Georgia,serif;color:#1c2a23">${esc(e.food ? (GENERIC_FOOD.test(e.food.trim()) ? "Chef's Selection" : e.food) : e.title)}</div>
      <div style="font:15px Georgia,serif;color:#1c2a23;margin-top:2px">${e.food ? `<b>${esc(e.title)}</b> · ` : ''}${esc(e.club)}</div>
      <div style="font:13px Georgia,serif;color:#5d6b62;margin-top:2px">${esc(where(e))}${e.food && !e.free_food ? ` · ${esc(e.price || 'not free')}` : ''}
        · <a href="https://www.instagram.com/p/${esc(e.shortcode)}/" style="color:#9a7426">post</a></div>
    </td></tr>`;
  const section = (title: string, list: DigestEvent[]) => list.length ? `
    <tr><td style="padding:22px 0 4px;font:13px Georgia,serif;letter-spacing:.24em;color:#9a7426;text-transform:uppercase;text-align:center">${title}</td></tr>
    ${list.map(row).join('')}` : '';

  const html = `<!doctype html><html><body style="margin:0;background:#1f3a2e;padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fbf8f0;border:1px solid #9a7426">
  <tr><td style="padding:28px 28px 8px;text-align:center">
    <div style="font:12px Georgia,serif;letter-spacing:.3em;color:#9a7426">BABSON COLLEGE</div>
    <div style="font:500 44px Didot,'Bodoni 72',Georgia,serif;letter-spacing:.08em;color:#1c2a23">MENU</div>
    <div style="font:italic 15px Georgia,serif;color:#5d6b62">${esc(day(today))}</div>
  </td></tr>
  <tr><td style="padding:0 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${events.length ? [...new Set(events.map((e) => e.date))].map((d) =>
        section(d === today ? 'Today' : 'Tomorrow · ' + day(d).split(',')[0], [...food, ...other].filter((e) => e.date === d))).join('')
      : '<tr><td style="padding:24px 0;font:italic 16px Georgia,serif;color:#5d6b62;text-align:center">No events posted for today or tomorrow yet.</td></tr>'}
  </table>
  <p style="font:13px Georgia,serif;color:#5d6b62;text-align:center;margin:20px 0 0">Times come from club posts. Check the post before you go.<br><a href="${esc(siteUrl)}" style="color:#9a7426">Open the full menu</a></p>
  </td></tr></table></body></html>`;

  const text = [subject, '', ...events.map((e) => `${e.date === today ? 'Today' : day(e.date)} ${when(e)} · ${e.food ? `[${e.food}] ` : ''}${e.title} · ${e.club} · ${where(e)}`), '', siteUrl].join('\n');
  return { subject, html, text, count: events.length, today: todayCount };
}

export async function sendDigest(apiKey: string, from: string, to: string, d: { subject: string; html: string; text: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: to.split(',').map((s) => s.trim()), subject: d.subject, html: d.html, text: d.text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
