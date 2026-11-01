import type { Sequence } from '../project/model'
import type { Ticks } from '../time'
import { timelineCommand, type TimelineCommand } from './edits'
import { frameTicks, sequenceEnd } from './timeline'

/**
 * The timeline's In and Out (decision 59), Premiere's way: I and O at the playhead (Out
 * includes the frame under it, so it's stored as that frame's end), and a new In after the
 * Out (or an Out before the In) clears the other mark. Undoable, saved with the sequence.
 */
export function setSequenceMarks(marks: { in?: Ticks | null; out?: Ticks | null }): TimelineCommand {
  const label = marks.in !== undefined && marks.out === undefined ? (marks.in === null ? 'Clear In' : 'Mark In') : marks.out !== undefined && marks.in === undefined ? (marks.out === null ? 'Clear Out' : 'Mark Out') : 'Clear In and Out'
  return timelineCommand(label, (draft) => {
    const sequence = draft.sequence
    const frame = frameTicks(sequence as Sequence)
    const onFrame = (t: Ticks) => Math.max(0, Math.round(t / frame) * frame)
    const next = {
      in: marks.in !== undefined ? (marks.in === null ? null : onFrame(marks.in)) : sequence.marks.in,
      out: marks.out !== undefined ? (marks.out === null ? null : Math.max(frame, onFrame(marks.out))) : sequence.marks.out
    }
    if (next.in !== null && next.out !== null && next.in >= next.out) {
      if (marks.in !== undefined) next.out = null
      else next.in = null
    }
    sequence.marks = next
  })
}

/** Where In and Out mark out, if either is set (a missing In is the start; a missing Out, the end). */
export function markedRange(sequence: Sequence): { from: Ticks; to: Ticks } | null {
  const { in: markIn, out: markOut } = sequence.marks
  if (markIn === null && markOut === null) return null
  return { from: markIn ?? 0, to: markOut ?? Math.max(sequenceEnd(sequence), (markIn ?? 0) + frameTicks(sequence)) }
}
