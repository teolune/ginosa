import { useEffect, useState } from 'react'
import { addTrack, renameTrack, setSequenceSettings, setTrackFlag } from '@engine/project/commands'
import { createBin, moveToBin, setMarks } from '@engine/project/media-commands'
import { secondsToTicks } from '@engine/time'
import type { MenuCommand, MenuState } from '@shared/ipc'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'
import { workspaceController } from '../state/workspace'
import { Workspace } from '../workspace/Workspace'
import { ErrorToast, PromptDialog, RecoveryDialog, type PromptRequest } from './Dialogs'
import { StartScreen } from './StartScreen'
import { TitleBar } from './TitleBar'

function isEditingText(): boolean {
  const element = document.activeElement
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)
}

function menuState(): MenuState {
  const history = projectController.historyView
  return {
    hasProject: projectController.project !== null,
    dirty: projectController.isDirty,
    undoLabel: history?.undoLabel ?? null,
    redoLabel: history?.redoLabel ?? null,
    windows: workspaceController.specs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      shortcut: spec.shortcut,
      open: workspaceController.isOpen(spec.id)
    })),
    workspaces: workspaceController.names,
    activeWorkspace: workspaceController.activeName,
    recent: projectController.recent
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Automated UI screenshots (npm run snapshot): set up a scene, then ask the main process to capture. */
async function runSnapshotScenario(scenario: string): Promise<void> {
  if (scenario !== 'start') {
    const path = await window.ginosa.snapshot.tempProjectPath()
    await projectController.createAt(path, 'Snapshot Project')
  }
  switch (scenario) {
    case 'windows':
      workspaceController.open('project-settings')
      workspaceController.open('diagnostics')
      workspaceController.open('playback-test')
      workspaceController.minimize('playback-test')
      break
    case 'settings': {
      workspaceController.open('project-settings')
      projectController.dispatch(setSequenceSettings({ width: 1080, height: 1920 }))
      projectController.dispatch(addTrack('video'))
      const first = projectController.project?.sequence.tracks[0]
      if (first) projectController.dispatch(renameTrack(first.id, 'Performance'))
      break
    }
    case 'docked':
      workspaceController.setDocked('project-settings', true)
      workspaceController.setDocked('diagnostics', true)
      break
    case 'media':
    case 'source':
    case 'cache':
    case 'waveform':
    case 'icons': {
      const files = await window.ginosa.snapshot.testMedia()
      await mediaController.importPaths(files, null)
      const bin = createBin('Selects', null)
      projectController.dispatch(bin)
      const media = projectController.project?.media ?? []
      const h264 = media.find((m) => m.name === 'testsrc_1080p24_h264')
      const hevc = media.find((m) => m.name === 'testsrc_1080p24_hevc')
      if (hevc) projectController.dispatch(moveToBin([hevc.id], [], bin.binId))
      // Let checks, thumbnails and the ProRes optimised copy finish.
      for (let i = 0; i < 60; i++) {
        await wait(500)
        const busy = (projectController.project?.media ?? []).some((m) => {
          const r = mediaController.get(m.id)
          return r.status === 'checking' || r.job?.status === 'running' || r.job?.status === 'queued' || (m.kind !== 'audio' && !r.thumbnailUrl && r.status === 'online')
        })
        if (!busy) break
      }
      if (scenario === 'source' && h264) {
        projectController.dispatch(setMarks(h264.id, { in: secondsToTicks(2), out: secondsToTicks(6) }))
        mediaController.openInSource(h264.id)
        workspaceController.open('source-monitor')
      }
      if (scenario === 'cache') workspaceController.open('cache-manager')
      if (scenario === 'icons') {
        // Every icon state at once: hidden, locked and muted tracks, window and dock buttons.
        const tracks = projectController.project?.sequence.tracks ?? []
        const [v1, v2] = tracks.filter((t) => t.kind === 'video')
        const [a1] = tracks.filter((t) => t.kind === 'audio')
        if (v2) projectController.dispatch(setTrackFlag(v2.id, 'visible', false))
        if (v1) projectController.dispatch(setTrackFlag(v1.id, 'locked', true))
        if (a1) projectController.dispatch(setTrackFlag(a1.id, 'muted', true))
        workspaceController.setDocked('project-settings', true)
        if (h264) mediaController.openInSource(h264.id)
        workspaceController.open('source-monitor')
      }
      const song = (projectController.project?.media ?? []).find((m) => m.kind === 'audio')
      if (scenario === 'waveform' && song) {
        projectController.dispatch(setMarks(song.id, { in: secondsToTicks(4), out: secondsToTicks(12) }))
        mediaController.openInSource(song.id)
        workspaceController.open('source-monitor')
        await wait(1500)
      }
      break
    }
    case 'recovery':
    case 'recovered': {
      // Edit, "crash", reopen: the recovery dialog must offer exactly these changes back.
      projectController.dispatch(setSequenceSettings({ width: 1080, height: 1920 }))
      projectController.dispatch(addTrack('audio'))
      const first = projectController.project?.sequence.tracks[0]
      if (first) projectController.dispatch(renameTrack(first.id, 'Recovered'))
      const path = projectController.path
      await wait(300)
      await window.ginosa.snapshot.simulateCrash()
      projectController.forgetAfterSimulatedCrash()
      if (path) await projectController.open(path)
      if (scenario === 'recovered') {
        await projectController.resolveRecovery(true)
        workspaceController.open('project-settings')
      }
      break
    }
  }
  await wait(1500)
  await window.ginosa.snapshot.ready()
}

export function App() {
  useObservable(projectController)
  useObservable(workspaceController)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const hasProject = projectController.project !== null

  // Start-up: layouts, recent projects, and reopening a project that was interrupted by a crash.
  useEffect(() => {
    const scenario = window.ginosa.snapshot.scenario
    void (async () => {
      await workspaceController.load()
      await projectController.refreshRecent()
      if (scenario) {
        await runSnapshotScenario(scenario)
        return
      }
      const interrupted = projectController.recent.find((item) => item.interrupted)
      if (interrupted) await projectController.open(interrupted.path)
    })()
  }, [])

  // Keep the native menu in step with the app.
  useEffect(() => {
    let frame = 0
    const push = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => window.ginosa.menu.setState(menuState()))
    }
    push()
    const offProject = projectController.subscribe(push)
    const offWorkspace = workspaceController.subscribe(push)
    return () => {
      offProject()
      offWorkspace()
      cancelAnimationFrame(frame)
    }
  }, [])

  // Menu commands.
  useEffect(() => {
    const askName = (title: string, label: string, initial: string, confirm: string) =>
      new Promise<string | null>((resolve) =>
        setPrompt({
          title,
          label,
          initial,
          confirm,
          resolve: (value) => {
            setPrompt(null)
            resolve(value)
          }
        })
      )

    return window.ginosa.menu.onCommand(async (command: MenuCommand) => {
      switch (command.type) {
        case 'new-project':
          return projectController.newProject()
        case 'import':
          return mediaController.chooseAndImport(mediaController.targetBinId)
        case 'new-bin':
          return mediaController.newBin()
        case 'open-project':
          return projectController.open()
        case 'open-recent':
          return projectController.open(command.path)
        case 'save':
          return void (await projectController.save())
        case 'save-as':
          return projectController.saveAs()
        case 'close-project':
          return projectController.close()
        case 'reveal-project':
          return projectController.reveal()
        case 'undo':
          if (isEditingText()) document.execCommand('undo')
          else projectController.undo()
          return
        case 'redo':
          if (isEditingText()) document.execCommand('redo')
          else projectController.redo()
          return
        case 'toggle-window':
          return workspaceController.toggle(command.id)
        case 'workspace-apply':
          return workspaceController.apply(command.name)
        case 'workspace-reset':
          return workspaceController.reset()
        case 'workspace-save-as': {
          const name = await askName('Save Workspace', 'Workspace name', `${workspaceController.activeName} copy`, 'Save')
          if (name) workspaceController.saveAs(name)
          return
        }
      }
    })
  }, [])

  // Window close and Cmd+Q: ask about unsaved changes first.
  useEffect(
    () =>
      window.ginosa.app.onCloseRequested(async () => {
        if (await projectController.prepareToQuit()) window.ginosa.app.closeNow()
        else window.ginosa.app.closeCancelled()
      }),
    []
  )

  return (
    <div className="app">
      <TitleBar />
      {hasProject ? <Workspace /> : <StartScreen />}
      <RecoveryDialog />
      <PromptDialog request={prompt} />
      <ErrorToast />
    </div>
  )
}
