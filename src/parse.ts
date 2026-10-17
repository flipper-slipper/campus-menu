// Claude vision call: post image(s) + caption -> structured events.

export interface ParsedEvent {
  title: string;
  date: string;            // YYYY-MM-DD
  date_basis: 'explicit_date' | 'relative_day' | 'weekday_only' | 'recurring_schedule' | 'inferred';
  date_evidence: string;   // verbatim text that states the date
  evidence_source: 'caption' | 'image';
  start_time: string | null; // HH:MM 24h, null if not stated
  end_time: string | null;
  location: string | null; // as written ("Olin 101", "Foundry Workroom")
  room: string | null;
  food: string | null;     // what food/drink is offered, null if none mentioned
  food_is_free: boolean;
  price: string | null;    // ticket/entry price if any
  category: 'social' | 'culture' | 'career' | 'talk' | 'arts' | 'sports' | 'tech' | 'entrepreneurship' | 'wellness' | 'dining' | 'other';
  description: string;     // <= 140 chars
  relation: 'new' | 'update' | 'cancel' | 'postpone';
  open_to: 'all' | 'undergrad' | 'grad' | 'members' | 'unknown';
  confidence: number;      // 0..1
}

export interface ParseResult { is_event_post: boolean; events: ParsedEvent[] }

const TOOL = {
  name: 'record_events',
  description: 'Record every upcoming event announced in this Instagram post.',
  input_schema: {
    type: 'object',
    required: ['is_event_post', 'events'],
    properties: {
      is_event_post: { type: 'boolean', description: 'False for recaps, e-board intros, fundraising, memes, applications.' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'date', 'date_basis', 'date_evidence', 'evidence_source', 'start_time', 'end_time', 'location', 'room', 'food', 'food_is_free', 'price', 'category', 'description', 'relation', 'open_to', 'confidence'],
          properties: {
            title: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD. Resolve relative dates ("this Friday", "tmrw") against the POST date.' },
            date_basis: { type: 'string', enum: ['explicit_date', 'relative_day', 'weekday_only', 'recurring_schedule', 'inferred'],
              description: 'explicit_date: a calendar date is written ("Oct 21", "10/14"). relative_day: "today", "tomorrow", "tonight". weekday_only: "this Friday", "Thursday". recurring_schedule: the post states a repeating schedule ("every Wednesday at 6"). inferred: anything else, including guessing from photos or from a past event.' },
            date_evidence: { type: 'string', description: 'The exact words from the caption or flyer that give the date or schedule, copied verbatim.' },
            evidence_source: { type: 'string', enum: ['caption', 'image'] },
            start_time: { type: ['string', 'null'], description: 'HH:MM 24h local, null if not stated. Never guess.' },
            end_time: { type: ['string', 'null'] },
            location: { type: ['string', 'null'], description: 'Building/venue exactly as written. null if not stated.' },
            room: { type: ['string', 'null'] },
            food: { type: ['string', 'null'], description: 'Food or drink offered, e.g. "pizza", "Chick-fil-A", "boba". null if none mentioned.' },
            food_is_free: { type: 'boolean' },
            price: { type: ['string', 'null'] },
            category: { type: 'string', enum: ['social', 'culture', 'career', 'talk', 'arts', 'sports', 'tech', 'entrepreneurship', 'wellness', 'dining', 'other'] },
            description: { type: 'string', description: 'One sentence, <=140 chars, no emojis.' },
            relation: { type: 'string', enum: ['new', 'update', 'cancel', 'postpone'], description: 'cancel/postpone/update when the post changes a previously announced event.' },
            open_to: { type: 'string', enum: ['all', 'undergrad', 'grad', 'members', 'unknown'] },
            confidence: { type: 'number' },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You extract campus events from college club Instagram posts for a student events site.
Rules:
- One post can announce several events (weekly calendars, multi-night shows): return one entry per occurrence.
- Only include events on or after TODAY.
- Recaps are NOT events. If the post describes something that already happened ("last week", "yesterday", "thank you to everyone who came", photo dumps, "more than 50 of you came"), return is_event_post=false and events=[], even if the event sounds like it repeats.
- Never create a recurring event unless the post itself states the schedule in words ("every Thursday", "Mondays 9-10am"). Do not infer recurrence from "the week before", "back again", or photos.
- Resolve "this Friday" / "tomorrow" against the POSTED date, not TODAY.
- For every event, copy the exact date words into date_evidence. If you cannot point to words that state the date, do not include the event.
- Read text inside the images; flyers usually hold the date, time and room.
- Never invent a time or location. Use null when the post does not say it.
- "food" is any food/drink offered to attendees ("snacks provided", "free boba", catering brand). Paid dining specials: food set, food_is_free=false.
- Off-campus or online events are fine; put the venue in location.`;

export async function parsePost(
  env: { ANTHROPIC_API_KEY: string; CLAUDE_MODEL: string },
  post: { account: string; club?: string | null; postedAt: string; caption: string; images: { mediaType: string; data: string }[] },
  todayLocal: string,
): Promise<{ result: ParseResult; raw: unknown }> {
  const content: unknown[] = post.images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  content.push({
    type: 'text',
    text: `TODAY: ${todayLocal}\nPOSTED: ${post.postedAt} (UTC)\nACCOUNT: @${post.account}${post.club ? ` (${post.club})` : ''}\nCAPTION:\n${post.caption || '(no caption)'}`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' }, // extraction task; forced tool_choice skips thinking anyway
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content: { type: string; name?: string; input?: ParseResult }[] };
  const call = body.content.find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  if (!call?.input) throw new Error('no tool_use in response');
  return { result: call.input, raw: call.input };
}
