import { describe, expect, it } from 'vitest';
import { isRecap, rejectReason, worthParsing, type CandidateEvent } from '../src/lib';

const GSC = `Last week in one scroll: lattes at Olin and pints at Rogers Pub. Our Social Series is all about the in-between moments, the ones that happen outside of class and between meetings, where you actually get to know the people in your program.

On Wednesday, more than 50 of you came out to Roger's Pub for our GSC Social Series mixer. The Wednesday pub night is BACK.

On Thursday, more than 60 of you filled the Grad Student Lounge and Olin Cafe for our biggest GSC Coffee Social yet, up from about 40 the week before.`;
const TODAY = '2026-10-17';
const ev = (o: Partial<CandidateEvent>): CandidateEvent => ({ title: 'x', date: '2026-10-22', date_basis: 'explicit_date', date_evidence: '', evidence_source: 'caption', ...o });

describe('the GSC coffee recap (user-reported false positive)', () => {
  it('is detected as a recap and never sent to the model', () => {
    expect(isRecap(GSC)).toBe(true);
    expect(worthParsing(GSC)).toBe(false);
  });
  it('rejects a weekly event the model might infer from it', () => {
    expect(rejectReason(ev({ title: 'GSC Coffee Social', date_basis: 'recurring_schedule', date_evidence: 'On Thursday' }), GSC, '2026-10-14T02:31:00Z', TODAY)).toBe('recap_post');
  });
  it('rejects inferred recurrence even without recap wording', () => {
    const cap = 'Coffee social at Olin Cafe, up from about 40 the week before. Grab a latte!';
    expect(rejectReason(ev({ date_basis: 'recurring_schedule', date_evidence: 'the week before' }), cap, '2026-10-14T02:31:00Z', TODAY)).toBe('no_recurrence_statement');
    expect(rejectReason(ev({ date_basis: 'inferred', date_evidence: 'Olin Cafe' }), cap, '2026-10-14T02:31:00Z', TODAY)).toBe('inferred_date');
  });
  it('rejects "see you next Thursday" from a two-week-old post', () => {
    const cap = 'Free brews and casual networking at the GSC Weekly Coffee Social. Who else grabbed a cup yesterday? See you next Thursday';
    expect(isRecap(cap)).toBe(false); // has a forward-looking line, so it reaches the model...
    expect(rejectReason(ev({ date: '2026-10-08', date_basis: 'weekday_only', date_evidence: 'See you next Thursday' }), cap, '2026-10-03T12:00:00Z', TODAY)).toBe('past'); // ...but the date is caught
  });
});

describe('real event posts still pass', () => {
  it('explicit dates', () => {
    const cap = 'Join us for an interactive Healthcare Case Study Workshop 📅 October 23, 2026 ⏰ 1:00-2:30 PM 📍 Babson Commons 101 🍴 Food will be provided!';
    expect(rejectReason(ev({ date: '2026-10-23', date_evidence: 'October 23, 2026' }), cap, '2026-10-14T00:56:00Z', TODAY)).toBeNull();
  });
  it('weekday-only resolved against the post date', () => {
    const cap = 'Join us this Thursday! Bring your controversial takes. Van Winkle A1 @ 7:00 PM.';
    expect(rejectReason(ev({ date: '2026-10-22', date_basis: 'weekday_only', date_evidence: 'this Thursday' }), cap, '2026-10-19T13:38:00Z', TODAY)).toBeNull();
    expect(rejectReason(ev({ date: '2026-10-23', date_basis: 'weekday_only', date_evidence: 'this Thursday' }), cap, '2026-10-19T13:38:00Z', TODAY)).toBe('weekday_mismatch');
    expect(rejectReason(ev({ date: '2026-10-29', date_basis: 'weekday_only', date_evidence: 'this Thursday' }), cap, '2026-10-19T13:38:00Z', TODAY)).toBe('weekday_too_far');
  });
  it('stated recurring schedule, but only for 4 weeks after the post', () => {
    const cap = 'YOOOO SOCA Town Halls every Wednesday at 6PM in the Global Lounge 🔥';
    expect(rejectReason(ev({ date: '2026-10-21', date_basis: 'recurring_schedule', date_evidence: 'every Wednesday at 6PM' }), cap, '2026-10-12T12:00:00Z', TODAY)).toBeNull();
    expect(rejectReason(ev({ date: '2026-11-18', date_basis: 'recurring_schedule', date_evidence: 'every Wednesday at 6PM' }), cap, '2026-10-12T12:00:00Z', TODAY)).toBe('recurrence_too_old');
  });
  it('caption evidence must really be in the caption', () => {
    expect(rejectReason(ev({ date: '2026-10-23', date_evidence: 'October 23' }), 'Come hang out with us!', '2026-10-14T00:00:00Z', TODAY)).toBe('evidence_not_in_caption');
    expect(rejectReason(ev({ date: '2026-10-24', date_evidence: 'October 23' }), 'Workshop October 23', '2026-10-14T00:00:00Z', TODAY)).toBe('day_not_in_evidence');
  });
  it('cancellations are never blocked', () => {
    expect(rejectReason(ev({ relation: 'cancel', date_basis: 'inferred' }), 'THIS EVENT HAS BEEN CANCELLED', '2026-10-13T00:00:00Z', TODAY)).toBeNull();
  });
});
