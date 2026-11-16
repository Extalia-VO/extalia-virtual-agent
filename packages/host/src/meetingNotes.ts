import type { NativeMeetingMinutes } from '@extalia/runtime';
import { pinProfileNotes, type ProfileNoteContext, type ProfileNoteDestination, type ProfileNoteOptions, type ProfileNoteWriter } from './profileNotes.js';

export type MeetingNoteDestination = ProfileNoteDestination;
export type MeetingNoteContext = ProfileNoteContext;

/** Consent remains host-owned; Rust validates, renders and publishes actual meeting evidence. */
export function pinMeetingNotes(options: ProfileNoteOptions): Promise<ProfileNoteWriter<NativeMeetingMinutes>> {
  return pinProfileNotes(options, 'meeting', record => record.meetingId);
}
