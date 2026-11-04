import { useEffect, useState } from 'react'
import { addTrack, renameTrack, setSequenceSettings, setTrackFlag } from '@engine/project/commands'
import { createBin, moveToBin, setMarks } from '@engine/project/media-commands'
import { secondsToTicks } from '@engine/time'
import { addCrossDissolveAt, addFrameHold, addMarker, placeMedia, setClipProperties, setClipSpeed, splitClips } from '@engine/timeline/edits'
import { player } from '../playback/player'
import { runSyncTest } from '../playback/sync-test'
import { buildSpeedTimeline, runSpeedTest } from '../playback/speed-test'
import { exportColourTest, exportEffectsTest, exportSpeedTest, exportSyncTest } from '../playback/export-test'
import { exporter } from '../playback/exporter'
import { buildKeyframeTimeline, exportKeyframesTest, exportRampSyncTest } from '../playback/keyframe-test'
import { analysisTest } from '../audio/analysis-test'
import { modulationTest } from '../audio/modulation-test'
import { analysisController } from '../audio/analysis-controller'
import { modulationUi } from '../audio/modulation-ui'
import { keyframeController } from '../keyframes/keyframe-controller'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { runEffectGpuTest } from '../playback/effect-gpu-test'
import { runMaskGpuTest } from '../playback/mask-gpu-test'
import { runColourLightGpuTest } from '../playback/colour-light-gpu-test'
import { runGrainGpuTest } from '../playback/grain-gpu-test'
import { grainExportTest } from '../playback/grain-export-test'
import { posterizeTest } from '../playback/posterize-test'
import { buildRackUi } from '../rack/rack-demo'
import { colourLightExportTest } from '../playback/colour-light-export-test'
import { buildColourLightUi } from '../effects/colour-light-demo'
import { buildGrainUi } from '../effects/grain-demo'
import { runFeedbackGpuTest } from '../playback/feedback-gpu-test'
import { feedbackTest } from '../playback/feedback-test'
import { renderCacheDemo } from '../render-cache/render-cache-demo'
import { renderCache } from '../render-cache/render-cache'
import { maskTest } from '../masks/mask-test'
import { buildFollowUi, buildMaskUiTimeline } from '../masks/mask-ui-demo'
import { sourcePlayer } from '../playback/source-player'
import { openMedia } from '../playback/sources'
import { probePatches, readPixels } from '../playback/colour-probe'
import { appleLogToRec709 } from '@engine/colour/colour'
import { hdrToSdr } from '@shared/colour/hdr-to-sdr'
import { effectiveColour } from '@engine/project/media'
import { RULER_HEIGHT, layoutRows, timeToX } from '../timeline/geometry'
import { TimelineInteraction } from '../timeline/interaction'
import type { MenuCommand, MenuState } from '@shared/ipc'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { Workspace } from '../workspace/Workspace'
import { ErrorToast, PromptDialog, RecoveryDialog, WarningDialog, type PromptRequest } from './Dialogs'
import { confirmKeyframeRemoval, warnings } from './warnings'
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

/** A small edit for the timeline snapshot: linked clips, a still on V2, a song, a cut, markers. */
async function buildSnapshotTimeline(): Promise<void> {
  const project = projectController.project
  if (!project) return
  const byName = (name: string) => project.media.find((m) => m.name === name)
  const tracks = project.sequence.tracks
  const [v1, v2] = tracks.filter((t) => t.kind === 'video')
  const [a1, a2] = tracks.filter((t) => t.kind === 'audio')
  const s = secondsToTicks
  const place = (name: string, at: number, video: string | null, audio: string | null, inS = 0, outS: number | null = null) => {
    const item = byName(name)
    if (item) projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: s(inS), sourceOut: outS === null ? null : s(outS), at: s(at), videoTrackId: video, audioTrackId: audio, mode: 'overwrite' }))
  }
  place('testsrc_1080p24_h264', 0, v1!.id, a1!.id, 2, 6)
  place('testsrc_1080p24_prores', 4, v1!.id, a1!.id, 0, 6)
  place('still_4k', 2.5, v2!.id, null)
  place('song_120bpm', 0, null, a2!.id)
  const prores = projectController.project!.sequence.clips.filter((c) => c.name === 'testsrc_1080p24_prores').map((c) => c.id)
  projectController.dispatch(splitClips(prores, s(7)))
  projectController.dispatch(addMarker(s(4)))
  projectController.dispatch(addMarker(s(8)))
  timelineController.zoomToFit()
  timelineController.setPlayhead(s(3))
  const selected = projectController.project!.sequence.clips.filter((c) => c.name === 'testsrc_1080p24_h264').map((c) => c.id)
  timelineController.select(selected, 'replace')
  await wait(2500)
}

/** The speed/reverse/hold/dissolve timeline from speed-test.ts, played and checked frame by frame. */
async function runSpeedScenario(dialog: boolean): Promise<void> {
  if (!buildSpeedTimeline()) return
  const s = secondsToTicks
  timelineController.zoomToFit()
  workspaceController.focus('program-monitor')
  await wait(1500)
  if (dialog) {
    // The 200% clip, selected, with Speed/Duration open.
    const fast = projectController.project!.sequence.clips.find((c) => c.speed === 2 && !c.reverse)!
    timelineController.select([fast.id], 'replace')
    timelineController.setPlayhead(s(5))
    timelineController.openSpeedDialog()
    await wait(800)
    return
  }
  player.toggleStats()
  const report = await runSpeedTest(projectController.project!.sequence.settings.width)
  await window.ginosa.snapshot.report(report)
  timelineController.setPlayhead(s(9))
  await wait(1200)
}

/** Automated UI screenshots (npm run snapshot): set up a scene, then ask the main process to capture. */
async function runSnapshotScenario(scenario: string): Promise<void> {
  if (scenario !== 'start') {
    const path = await window.ginosa.snapshot.tempProjectPath()
    await projectController.createAt(path, 'Snapshot Project')
  }
  switch (scenario) {
    case 'analysis': {
      // M8 part 1: tempo detection on the 128 BPM drums, on a muted track, and the Audio Analysis window.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /beat_128bpm\.wav$/.test(f)), null)
      await wait(1500)
      try {
        await window.ginosa.snapshot.report(await analysisTest())
      } catch (error) {
        await window.ginosa.snapshot.report({ verdict: 'fail', reasons: [(error as Error).message] })
      }
      workspaceController.open('audio-analysis')
      workspaceController.focus('audio-analysis')
      timelineController.zoomToFit()
      timelineController.setPlayhead(secondsToTicks(5))
      await wait(1500)
      break
    }
    case 'modulation':
    case 'modulationui': {
      // M8 "done when": one source drives three values; export matches playback frame for frame.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /beat_128bpm\.wav$|square_1080\.png$/.test(f)), null)
      await wait(1500)
      try {
        const report = await modulationTest()
        if (scenario === 'modulation') await window.ginosa.snapshot.report(report)
      } catch (error) {
        await window.ginosa.snapshot.report({ verdict: 'fail', reasons: [(error as Error).message] })
      }
      if (scenario === 'modulationui') {
        const sequence = projectController.project!.sequence
        timelineController.select([sequence.clips.find((c) => c.kind === 'video')!.id], 'replace')
        modulationUi.select(sequence.modulators[0]?.id ?? null)
        workspaceController.open('modulation')
        workspaceController.focus('effect-controls')
      }
      timelineController.zoomToFit()
      timelineController.setPlayhead(secondsToTicks(2.35))
      await wait(1500)
      break
    }
    case 'exportkeyframes':
    case 'exportrampsync':
    case 'keyframeswarning':
    case 'keyframesui':
    case 'keyframesgraph': {
      // M7: the keyframe test timeline; exported and checked, or shown in the editors.
      const wanted = scenario === 'exportrampsync' ? /sync_flash_beep\.mp4$/ : /square_1080\.png$|framecode_h264\.mp4$|patches_rec709\.mov$|tone_1khz\.wav$/
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => wanted.test(f)), null)
      await wait(1500)
      try {
        if (scenario === 'exportkeyframes') {
          await window.ginosa.snapshot.report(await exportKeyframesTest())
        } else if (scenario === 'exportrampsync') {
          await window.ginosa.snapshot.report(await exportRampSyncTest())
        } else {
          const built = buildKeyframeTimeline()
          const graph = scenario === 'keyframesgraph'
          timelineController.select(graph ? [built.square] : [built.patches, built.layer, built.tone, built.ramp], 'replace')
          timelineController.setPlayhead(secondsToTicks(graph ? 1.2 : 8.8))
          workspaceController.open('keyframe-editor')
          if (graph) {
            keyframeController.setMode('graph')
            keyframeController.focus({ clipId: built.square, effectId: null, param: 'position' })
            const k = projectController.project!.sequence.clips.find((c) => c.id === built.square)!.keyframes['position']!
            keyframeController.select(k.map((x) => ({ clipId: built.square, effectId: null, param: 'position', keyframeId: x.id })), 'replace')
          }
          workspaceController.focus('effect-controls')
          timelineController.zoomToFit()
          // Decision 42: the warning before keyframes are removed.
          if (scenario === 'keyframeswarning') void confirmKeyframeRemoval(3, 'Position')
          await wait(1800)
        }
      } catch (error) {
        await window.ginosa.snapshot.report({ verdict: 'fail', reasons: [(error as Error).message] })
      }
      break
    }
    case 'exportsync':
    case 'exportcolour':
    case 'exportspeed':
    case 'exporteffects': {
      const pattern =
        scenario === 'exportsync'
          ? /sync_flash_beep\.mp4$/
          : scenario === 'exportcolour'
            ? /patches_(rec709|applelog)\.mov$/
            : scenario === 'exportspeed'
              ? /framecode_h264\.mp4$/
              : /patches_(rec709|applelog|applelog2)\.mov$|sync_flash_beep\.mp4$|framecode_h264\.mp4$/
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => pattern.test(f)), null)
      await wait(1500)
      try {
        const report =
          scenario === 'exportsync'
            ? await exportSyncTest()
            : scenario === 'exportcolour'
              ? await exportColourTest()
              : scenario === 'exportspeed'
                ? await exportSpeedTest(buildSpeedTimeline)
                : await exportEffectsTest()
        if (scenario === 'exporteffects') {
          workspaceController.open('effects-library')
          workspaceController.focus('effects-library')
          timelineController.zoomToFit()
          await wait(800)
        }
        await window.ginosa.snapshot.report(report)
      } catch (error) {
        await window.ginosa.snapshot.report({ verdict: 'fail', reasons: [(error as Error).message] })
      }
      break
    }
    case 'footage':
    case 'footage2': {
      // Your Apple Log clips through ginosa: probe, detection, decoding, conversion, playback speed.
      const files = await window.ginosa.snapshot.referenceClips()
      await mediaController.importPaths(files, null)
      for (let i = 0; i < 40; i++) {
        await wait(500)
        if ((projectController.project?.media ?? []).every((m) => mediaController.get(m.id).status !== 'checking' && mediaController.get(m.id).thumbnailUrl)) break
      }
      const project = projectController.project!
      const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!
      const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!
      const report: Record<string, unknown> = {}
      let at = 0
      for (const item of project.media) {
        const runtime = mediaController.get(item.id)
        const path = mediaController.playablePath(item)
        const opened = path ? await openMedia(path).catch((error: Error) => error.message) : 'no playable path'
        report[item.name] = {
          video: item.info.video,
          detected: effectiveColour(item),
          status: runtime.status,
          decodable: runtime.decodable,
          optimiseRequired: runtime.required,
          optimiseSuggested: runtime.suggested,
          decoderOpened: typeof opened === 'string' ? opened : opened.videoSink !== null,
          codec: typeof opened === 'string' ? null : await opened.video?.getCodecParameterString()
        }
        projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: secondsToTicks(4), at: secondsToTicks(at), videoTrackId: v1.id, audioTrackId: a1.id, mode: 'overwrite' }))
        at += 4
      }
      // Playback speed: 8 s across both clips, 4K HEVC 4:2:2 10-bit into a 1080p timeline.
      player.toggleStats()
      await player.play(1, 0)
      await wait(7500)
      report.playback = { stats: player.stats, debug: player.debug }
      player.stop()
      // Export speed on your footage: 8 s of 4K Apple Log → 1080p, H.264 and ProRes 422 HQ.
      for (const format of ['h264', 'prores-422hq'] as const) {
        const path = (await window.ginosa.snapshot.exportPath(`footage-${format}.${format === 'h264' ? 'mp4' : 'mov'}`))!
        await exporter.run(projectController.project!, { format, container: format === 'h264' ? 'mp4' : 'mov', bitrateMbps: 40, keyframeSeconds: 1 }, path)
        const done = exporter.state
        report[`export-${format}`] = done.kind === 'done' ? { fps: Math.round(done.fps * 10) / 10, seconds: Math.round(done.seconds * 10) / 10, size: done.result.size, tags: done.result.info?.video?.colour } : done
      }
      // A converted frame in the Source Monitor: Apple Log 1, or Apple Log 2 with --scenario footage2.
      const shown = projectController.project!.media[scenario === 'footage2' ? 1 : 0]
      timelineController.setPlayhead(secondsToTicks(6))
      if (shown) {
        workspaceController.open('source-monitor')
        mediaController.openInSource(shown.id, secondsToTicks(2))
      }
      await wait(2500)
      await window.ginosa.snapshot.report(report)
      break
    }
    case 'effectsgpu': {
      await window.ginosa.snapshot.report(await runEffectGpuTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'followui': {
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /patches_rec709\.mov$/.test(f)), null)
      await wait(1500)
      await buildFollowUi()
      await wait(1500)
      break
    }
    case 'exportmasks':
    case 'masksui': {
      // M9 masks: exported and checked against their keyframes, or shown being edited.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /square_1080\.png$|patches_rec709\.mov$/.test(f)), null)
      await wait(1500)
      if (scenario === 'exportmasks') {
        await window.ginosa.snapshot.report(await maskTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
        break
      }
      await buildMaskUiTimeline()
      await wait(1500)
      break
    }
    case 'feedback': {
      // M9 "done when": a Feedback effect exports, plays and scrubs exactly.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /square_1080\.png$/.test(f)), null)
      await wait(1500)
      await window.ginosa.snapshot.report(await feedbackTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      timelineController.zoomToFit()
      break
    }
    case 'cacheui': {
      // M9: the render bar, half rendered, over footage with a Feedback tunnel.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$/.test(f)), null)
      await wait(2500)
      await window.ginosa.snapshot.report(await renderCacheDemo().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      await wait(1000)
      break
    }
    case 'feedbackgpu': {
      await window.ginosa.snapshot.report(await runFeedbackGpuTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'exportcolourlight': {
      // M10 end to end: Kick Flash on real drums, a grade and Mosaic, preview and export against the CPU maths.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /patches_rec709\.mov$|beat_128bpm\.wav$/.test(f)), null)
      await wait(1500)
      await window.ginosa.snapshot.report(await colourLightExportTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      workspaceController.open('effect-controls')
      timelineController.zoomToFit()
      await wait(800)
      break
    }
    case 'colourlightui': {
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$/.test(f)), null)
      await wait(2500)
      await buildColourLightUi()
      await wait(2500)
      break
    }
    case 'exportgrain': {
      // M11 end to end: Grain exported (ProRes 4444) and played, against the CPU maths frame by frame.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /patches_rec709\.mov$/.test(f)), null)
      await wait(1500)
      await window.ginosa.snapshot.report(await grainExportTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      workspaceController.open('effect-controls')
      await wait(800)
      break
    }
    case 'grainui': {
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$/.test(f)), null)
      await wait(2500)
      await buildGrainUi()
      await wait(2500)
      break
    }
    case 'rackui': {
      // M12: Auto-fill from the test drums, Kick Flash on the Kick row, Posterize Time, in the Channel Rack.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$|beat_128bpm\.wav$/.test(f)), null)
      await wait(2500)
      await window.ginosa.snapshot.report(await buildRackUi().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      await wait(2500)
      break
    }
    case 'posterize': {
      // M12 "done when": Posterize Time's holds match the beat grid in every exported frame; a Channel Rack row drives Kick Flash.
      await mediaController.importPaths((await window.ginosa.snapshot.testMedia()).filter((f) => /framecode_h264\.mp4$|patches_rec709\.mov$/.test(f)), null)
      await wait(1500)
      await window.ginosa.snapshot.report(await posterizeTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'graingpu': {
      // M11: Grain on the GPU against its CPU maths, pixel by pixel.
      await window.ginosa.snapshot.report(await runGrainGpuTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'colourlightgpu': {
      // M10: Basic Correction, Curves, Levels and Mosaic on the GPU against their CPU maths.
      await window.ginosa.snapshot.report(await runColourLightGpuTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'masksgpu': {
      await window.ginosa.snapshot.report(await runMaskGpuTest().catch((error: Error) => ({ verdict: 'fail', error: error.message, stack: error.stack })))
      break
    }
    case 'sourceplay': {
      // The Source Monitor on the new player: Apple Log converted, then picture/sound sync.
      const files = (await window.ginosa.snapshot.testMedia()).filter((f) => /patches_applelog\.mov$|sync_flash_beep\.mp4$/.test(f))
      await mediaController.importPaths(files, null)
      await wait(1500)
      const media = projectController.project!.media
      const log = media.find((m) => m.name === 'patches_applelog')!
      const sync = media.find((m) => m.name === 'sync_flash_beep')!
      workspaceController.open('source-monitor')
      mediaController.openInSource(log.id)
      await wait(1500)
      const patches: Array<[number, number, number]> = [[0.2, 0.2, 0.2], [0.502, 0.502, 0.502], [0.6, 0.251, 0.149], [0.149, 0.451, 0.702], [0.949, 0.949, 0.949]]
      const expected = patches.map((p) => appleLogToRec709(p, 'bt2020').map((v) => Math.round(v * 1000) / 1000))
      const got = sourcePlayer.lastStill ? await readPixels(sourcePlayer.lastStill, [128, 384, 640, 896, 1152].map((x) => [x, 360] as [number, number])) : []
      const colourError = got.length ? Math.max(...got.flatMap((g, i) => g.map((v, c) => Math.abs(v - expected[i]![c]!)))) : null
      mediaController.openInSource(sync.id)
      await wait(1500)
      const report = await runSyncTest(6, secondsToTicks(1), sourcePlayer)
      await window.ginosa.snapshot.report({ colour: { worstError: colourError, expected, got }, sync: report })
      mediaController.openInSource(sync.id, secondsToTicks(3))
      await wait(1000)
      break
    }
    case 'logview': {
      // Each patch clip through the real playback path: decoder request, detection, shader.
      const files = (await window.ginosa.snapshot.testMedia()).filter((f) => /patches_(applelog|applelog2|rec709|hlg|pq)\.mov$/.test(f))
      await mediaController.importPaths(files, null)
      await wait(1500)
      const patches: Array<[number, number, number]> = [[0.2, 0.2, 0.2], [0.502, 0.502, 0.502], [0.6, 0.251, 0.149], [0.149, 0.451, 0.702], [0.949, 0.949, 0.949]]
      const report: Record<string, unknown> = {}
      const v1 = projectController.project!.sequence.tracks.find((t) => t.kind === 'video')!
      for (const item of projectController.project!.media) {
        projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: null, at: 0, videoTrackId: v1.id, audioTrackId: null, mode: 'overwrite' }))
        timelineController.setPlayhead(secondsToTicks(0.5))
        await wait(1200)
        const got = player.lastStill ? await readPixels(player.lastStill, [192, 576, 960, 1344, 1728].map((x) => [x, 540] as [number, number])) : []
        const colour = effectiveColour(item)
        const convert = (p: [number, number, number]) =>
          colour === 'apple-log' ? appleLogToRec709(p, 'bt2020') : colour === 'apple-log-2' ? appleLogToRec709(p, 'apple-wide-gamut') : colour === 'hlg' || colour === 'pq' ? hdrToSdr(p, colour) : p
        const expected = patches.map((p) => convert(p).map((v) => Math.round(v * 1000) / 1000))
        const worst = Math.max(...got.flatMap((g, i) => g.map((v, c) => Math.abs(v - expected[i]![c]!))))
        report[item.name] = { detected: colour, worstError: Math.round(worst * 1000) / 1000, expected, got }
      }
      await window.ginosa.snapshot.report(report)
      break
    }
    case 'colour': {
      const files = (await window.ginosa.snapshot.testMedia()).filter((f) => f.includes('patches_'))
      const report: Record<string, unknown> = { expected: [[0.2, 0.2, 0.2], [0.502, 0.502, 0.502], [0.6, 0.251, 0.149], [0.149, 0.451, 0.702], [0.949, 0.949, 0.949]] }
      for (const file of files) {
        const name = file.split('/').pop()!
        try {
          report[name] = {
            asTagged: await probePatches(file, null),
            asSrgb: await probePatches(file, { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: (file.includes('rec709') ? 'bt709' : 'bt2020-ncl') as VideoMatrixCoefficients, fullRange: false })
          }
        } catch (error) {
          report[name] = (error as Error).message
        }
      }
      await window.ginosa.snapshot.report(report)
      break
    }
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
    case 'icons':
    case 'timeline':
    case 'drag':
    case 'composite':
    case 'playback':
    case 'exportui':
    case 'effectsui':
    case 'sync':
    case 'speed':
    case 'speeddialog': {
      const all = await window.ginosa.snapshot.testMedia()
      const special = (f: string) => /sync_flash_beep\.mp4$|framecode_h264\.mp4$|patches_[a-z0-9]+\.mov$|square_1080\.png$|tone_1khz\.wav$|beat_128bpm\.wav$/.test(f)
      const files =
        scenario === 'sync' ? all.filter((f) => f.endsWith('sync_flash_beep.mp4')) : scenario === 'speed' || scenario === 'speeddialog' ? all.filter((f) => f.endsWith('framecode_h264.mp4')) : all.filter((f) => !special(f))
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
      if (scenario === 'timeline' || scenario === 'drag' || scenario === 'composite' || scenario === 'playback' || scenario === 'exportui' || scenario === 'effectsui') await buildSnapshotTimeline()
      if (scenario === 'effectsui') {
        // An adjustment layer over V1 with Invert (luminance) and Transform; Invert on a clip too.
        const seq = projectController.project!.sequence
        const v1clip = seq.clips.find((c) => c.name === 'testsrc_1080p24_h264' && c.kind === 'video')!
        projectController.dispatch(addEffect([v1clip.id], 'invert'))
        timelineController.setPlayhead(secondsToTicks(5))
        timelineController.newAdjustmentLayer()
        const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!
        projectController.dispatch(addEffect([layer.id], 'invert'))
        projectController.dispatch(addEffect([layer.id], 'transform'))
        const [inv, tr] = projectController.project!.sequence.clips.find((c) => c.adjustment)!.effects
        projectController.dispatch(setEffectValues(layer.id, inv!.id, { params: { channel: 'luminance', amount: 80 } }))
        projectController.dispatch(setEffectValues(layer.id, tr!.id, { params: { scale: 70, rotation: 8, edges: 'mirror' } }))
        timelineController.select([layer.id], 'replace')
        workspaceController.open('effects-library')
        workspaceController.focus('effect-controls')
        await wait(1500)
      }
      if (scenario === 'exportui') {
        // The Export window after a real export of the snapshot timeline.
        workspaceController.open('export')
        await wait(500)
        const path = (await window.ginosa.snapshot.exportPath('ui.mp4'))!
        await exporter.run(projectController.project!, { format: 'h264', container: 'mp4', bitrateMbps: 40, keyframeSeconds: 1 }, path)
        await window.ginosa.snapshot.report(exporter.state)
        await wait(800)
      }
      if (scenario === 'composite') {
        // Motion, opacity and a blend mode on the still over V1.
        const still = projectController.project!.sequence.clips.find((c) => c.name === 'still_4k')!
        projectController.dispatch(setClipProperties([still.id], { motion: { scale: 22, scaleWidth: 160, rotation: 12, positionX: 1350, positionY: 380 }, opacity: 85, blendMode: 'difference' }))
        const linkedSound = projectController.project!.sequence.clips.find((c) => c.kind === 'audio' && c.name === 'song_120bpm')!
        projectController.dispatch(setClipProperties([linkedSound.id], { volume: -4.5 }))
        timelineController.select([still.id, linkedSound.id], 'replace')
        workspaceController.focus('effect-controls')
        await wait(1500)
      }
      if (scenario === 'playback') {
        player.toggleStats()
        await player.play(1, 0)
        await wait(4000)
        await window.ginosa.snapshot.report({ stats: player.stats, playing: player.playing, debug: player.debug })
      }
      if (scenario === 'sync') {
        const sync = projectController.project!.media[0]
        if (sync) {
          const tracks = projectController.project!.sequence.tracks
          projectController.dispatch(placeMedia({ mediaId: sync.id, sourceIn: 0, sourceOut: null, at: 0, videoTrackId: tracks.find((t) => t.kind === 'video')!.id, audioTrackId: tracks.find((t) => t.kind === 'audio')!.id, mode: 'overwrite' }))
          await wait(1000)
          player.toggleStats()
          const report = await runSyncTest(6, secondsToTicks(1))
          await window.ginosa.snapshot.report(report)
          await player.play(1, secondsToTicks(2))
          await wait(1500)
        }
      }
      if (scenario === 'speed' || scenario === 'speeddialog') await runSpeedScenario(scenario === 'speeddialog')
      if (scenario === 'drag') {
        // Grab the still on V2 and hold it 1.3 s later: the preview and the snap guide should show.
        const sequence = projectController.project!.sequence
        const still = sequence.clips.find((c) => c.name === 'still_4k')!
        const row = layoutRows(sequence).rows.find((r) => r.track.id === still.trackId)!
        const x = timeToX(still.start + still.duration / 2, timelineController.view)
        const y = RULER_HEIGHT + row.top + row.height / 2 - timelineController.scrollY
        const drag = new TimelineInteraction()
        timelineController.deselect()
        drag.down(new PointerEvent('pointerdown', { button: 0 }), x, y)
        const dx = timelineController.view.pps * 1.3
        drag.move(new PointerEvent('pointermove', { buttons: 1 }), x + dx / 2, y)
        drag.move(new PointerEvent('pointermove', { buttons: 1 }), x + dx, y)
        await wait(800)
      }
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

void analysisController

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

  // Premiere's timeline shortcuts. Panels that handle a key themselves (Media, Source
  // Monitor) mark it handled first; text fields are left alone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditingText() || !projectController.project || document.querySelector('.modal-backdrop')) return
      const active = document.activeElement
      const focus = active?.closest('.timeline-panel') ? 'timeline' : active?.closest('.source-monitor') ? 'source' : 'other'
      if (timelineController.handleKey(event, focus)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
        case 'export':
          return workspaceController.open('export')
        case 'new-adjustment-layer':
          return timelineController.newAdjustmentLayer()
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
        case 'render-previews':
          void renderCache.renderSection()
          return
        case 'delete-previews': {
          const project = projectController.project
          if (!project) return
          void warnings.confirm('Delete this project’s previews?', 'The rendered previews of this project are deleted. Frames with effects play live again until you render them (Enter).', 'Delete Previews').then(async (ok) => {
            if (!ok) return
            await window.ginosa.cache.clear(project.id, 'renders')
            renderCache.reload()
            projectController.showMessage('Previews deleted')
          })
          return
        }
        case 'clean-up-project': {
          const project = projectController.project
          if (!project) return
          const what = command.autosaves ? 'its cache and its autosave snapshots' : 'its cache'
          void warnings
            .confirm(
              `Clean up “${project.name}”?`,
              `For a finished project: ginosa saves it if needed, closes it, and deletes ${what}: thumbnails, waveforms, optimised copies, previews and analysis${command.autosaves ? ', plus the crash-recovery snapshots in the project folder' : ''}. Your project file, its LUTs and your media stay. Everything deleted is made again if you open it later (optimised copies take a while).`,
              'Clean Up'
            )
            .then(async (ok) => {
              if (!ok) return
              const done = await projectController.cleanUpFinished(command.autosaves)
              if (done) projectController.showMessage(`Cleaned up “${project.name}”${command.autosaves ? ` (${done.autosaves} autosave${done.autosaves === 1 ? '' : 's'} removed)` : ''}`)
            })
          return
        }
        case 'show-warnings': {
          const count = warnings.showAllAgain()
          projectController.showMessage(count > 0 ? `ginosa will ask again before the ${count} kind${count === 1 ? '' : 's'} of change you'd silenced` : 'No warnings were silenced')
          return
        }
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
      <WarningDialog />
      <ErrorToast />
    </div>
  )
}
