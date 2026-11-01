import type { ReactNode } from 'react'
import { AudioAnalysisWindow } from '../windows/AudioAnalysisWindow'
import { CacheManagerWindow } from '../windows/CacheManagerWindow'
import { DiagnosticsWindow } from '../windows/DiagnosticsWindow'
import { EffectControlsWindow } from '../windows/EffectControlsWindow'
import { ExportWindow } from '../windows/ExportWindow'
import { EffectsLibraryWindow } from '../windows/EffectsLibraryWindow'
import { HistoryWindow } from '../windows/HistoryWindow'
import { KeyframeEditorWindow } from '../windows/KeyframeEditorWindow'
import { ModulationWindow } from '../windows/ModulationWindow'
import { PlaybackTestWindow } from '../windows/PlaybackTestWindow'
import { ProjectSettingsWindow } from '../windows/ProjectSettingsWindow'
import { SourceMonitorWindow } from '../windows/SourceMonitorWindow'

/** Window contents by id. New windows (Effects Library, Keyframe Editor…) register in specs.ts and here. */
export function renderWindow(id: string): ReactNode {
  switch (id) {
    case 'project-settings':
      return <ProjectSettingsWindow />
    case 'history':
      return <HistoryWindow />
    case 'diagnostics':
      return <DiagnosticsWindow />
    case 'effect-controls':
      return <EffectControlsWindow />
    case 'source-monitor':
      return <SourceMonitorWindow />
    case 'export':
      return <ExportWindow />
    case 'effects-library':
      return <EffectsLibraryWindow />
    case 'keyframe-editor':
      return <KeyframeEditorWindow />
    case 'audio-analysis':
      return <AudioAnalysisWindow />
    case 'modulation':
      return <ModulationWindow />
    case 'cache-manager':
      return <CacheManagerWindow />
    case 'playback-test':
      return <PlaybackTestWindow />
    default:
      return null
  }
}
