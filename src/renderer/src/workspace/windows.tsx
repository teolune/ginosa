import type { ReactNode } from 'react'
import { DiagnosticsWindow } from '../windows/DiagnosticsWindow'
import { HistoryWindow } from '../windows/HistoryWindow'
import { PlaybackTestWindow } from '../windows/PlaybackTestWindow'
import { ProjectSettingsWindow } from '../windows/ProjectSettingsWindow'

/** Window contents by id. New windows (Effects Library, Keyframe Editor…) register in specs.ts and here. */
export function renderWindow(id: string): ReactNode {
  switch (id) {
    case 'project-settings':
      return <ProjectSettingsWindow />
    case 'history':
      return <HistoryWindow />
    case 'diagnostics':
      return <DiagnosticsWindow />
    case 'playback-test':
      return <PlaybackTestWindow />
    default:
      return null
  }
}
