import type { SkillProposalResult } from './skillLearning.js';
import { pinProfileNotes, type ProfileNoteContext, type ProfileNoteDestination, type ProfileNoteOptions, type ProfileNoteWriter } from './profileNotes.js';

export type LearningNoteDestination = ProfileNoteDestination;
export type LearningNoteContext = ProfileNoteContext;
export interface LearningNoteRecord extends LearningNoteContext {
  runId: string;
  profileId: string;
  revision: string;
  promptSha256: string;
  title: string;
  lesson: string;
  evidence: { id: string; name: string; content: string }[];
  skill?: SkillProposalResult;
}

/** Rust validates and renders generated findings, stages bytes and publishes the immutable note. */
export function pinLearningNotes(options: ProfileNoteOptions): Promise<ProfileNoteWriter<LearningNoteRecord>> {
  return pinProfileNotes(options, 'learning', record => record.runId);
}
