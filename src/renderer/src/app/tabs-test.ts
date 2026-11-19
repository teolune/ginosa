import { addTrack } from '@engine/project/commands'
import { secondsToTicks } from '@engine/time'
import { projectController, type ProjectTab } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { setFullScreenLook } from './TitleBar'

/**
 * Decision 128's "done when", run by `npm run snapshot -- --scenario tabs`: projects open as tabs,
 * each keeps its own edits, undo, playhead and crash journal; the clef shows the home page with
 * the tabs still open; a tab's × closes it; Control-Tab moves along. Starts with one project open.
 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const s = secondsToTicks

export async function tabsTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) reasons.push(what)
  }
  const first = projectController.active as ProjectTab
  const firstPath = first.path

  // A second project opens in its own tab and is shown; an edit marks only it unsaved.
  const secondPath = (await window.ginosa.snapshot.tempProjectPath())!
  await projectController.createAt(secondPath, 'Second Project')
  const second = projectController.active as ProjectTab
  check(projectController.tabs.length === 2 && second !== first && second.project.name === 'Second Project', 'a new project opens in a second tab')
  projectController.dispatch(addTrack('audio'))
  check(second.isDirty && !first.isDirty, 'an edit marks only the shown tab unsaved')
  check(second.project.sequence.tracks.length === first.project.sequence.tracks.length + 1, 'the edit went to the shown tab’s project')

  // Each tab keeps its playhead and its undo.
  timelineController.setPlayhead(s(5))
  projectController.switchTo(first)
  check(projectController.project === first.project, 'clicking a tab shows its project')
  check(timelineController.playhead === 0, 'the first tab has its own playhead')
  check(projectController.historyView?.undoLabel === null, 'the first tab has its own undo (nothing to undo)')
  timelineController.setPlayhead(s(3))
  projectController.switchTo(second)
  check(timelineController.playhead === s(5), 'the second tab gets its playhead back')
  check(projectController.historyView?.undoLabel !== null, 'the second tab gets its undo back')

  // The clef: the home page, with both tabs still open; a tab brings its project back as it was.
  document.querySelector<HTMLButtonElement>('.home-button')?.click()
  await wait(300)
  check(projectController.project === null && projectController.tabs.length === 2, 'the clef shows the home page with both tabs still open')
  check(document.querySelector('.start-screen') !== null && document.querySelector('.home-button.active') !== null, 'the home page shows, the clef lit')
  document.querySelectorAll<HTMLElement>('.project-tab')[0]?.click()
  await wait(300)
  check(projectController.active === first && timelineController.playhead === s(3), 'clicking a tab from home brings its project back as it was')

  // Opening a project that is open already shows its tab instead of a second copy.
  await projectController.open(secondPath)
  check(projectController.active === second && projectController.tabs.length === 2, 'opening an open project shows its tab')
  const again = await window.ginosa.project.open(firstPath)
  check(again?.alreadyOpen === true, 'the main process keeps each tab’s project open')

  // Control-Tab and the menu's Next Tab, round the end.
  projectController.cycle(1)
  check(projectController.active === first, 'Next Tab goes round from the last tab to the first')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }))
  check(projectController.active === second, 'Control-Tab shows the next tab')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true }))
  check(projectController.active === first, 'Control-Shift-Tab shows the previous tab')

  // A tab's ×: the shown tab closes and the one beside it shows; its project opens again cleanly.
  const thirdPath = (await window.ginosa.snapshot.tempProjectPath())!
  await projectController.createAt(thirdPath, 'Third Project')
  check(projectController.tabs.length === 3 && projectController.tabs[2] === projectController.active, 'a third project opens at the end')
  await wait(200)
  document.querySelectorAll<HTMLButtonElement>('.project-tab-close')[2]?.click()
  await wait(500)
  check(projectController.tabs.length === 2 && projectController.active === second, 'closing the shown last tab shows the one to its left')
  await projectController.open(thirdPath)
  check(projectController.path === thirdPath && projectController.recovery === null, 'a closed tab’s project opens again with nothing to recover')
  await projectController.closeTab()
  check(projectController.tabs.length === 2, 'closing it again leaves two tabs')

  // Crash journals: each tab's changes went to its own folder, so each offers back its own.
  projectController.switchTo(first)
  projectController.dispatch(addTrack('video'))
  projectController.dispatch(addTrack('video'))
  await wait(400)
  await window.ginosa.snapshot.simulateCrash()
  projectController.forgetAfterSimulatedCrash()
  check(projectController.tabs.length === 0, 'the crash leaves no tabs')
  await projectController.open(firstPath)
  const reopenedFirst = projectController.active
  await projectController.open(secondPath)
  const reopenedSecond = projectController.active
  const counts = [reopenedFirst?.recovery?.changeCount ?? 0, reopenedSecond?.recovery?.changeCount ?? 0]
  check(counts[0] === 2 && counts[1] === 1, `after a crash each tab offers back its own changes (2 and 1, got ${counts.join(' and ')})`)
  await projectController.resolveRecovery(true)
  if (reopenedFirst) projectController.switchTo(reopenedFirst)
  await projectController.resolveRecovery(true)
  await wait(300)

  // The clef in the title bar: on its side, 114 × 40 points (filling the 44-point bar), its left edge
  // at 84 past the window buttons, or at 14 in full screen, where they're hidden; on whole screen pixels.
  const dpr = window.devicePixelRatio || 1
  const onPixels = (box: DOMRect) => [box.left, box.top, box.width, box.height].every((v) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.01)
  setFullScreenLook(true)
  const full = document.querySelector('.clef-bar-mark')?.getBoundingClientRect()
  setFullScreenLook(false)
  const clef = document.querySelector('.clef-bar-mark')?.getBoundingClientRect()
  check(!!clef && Math.abs(clef.width - 114) < 0.01 && Math.abs(clef.height - 40) < 0.01, 'the clef lies on its side at 114 × 40 points')
  check(!!clef && Math.abs(clef.left - 84) < 0.01, 'the clef starts past the window buttons, at 84 points')
  check(!!full && Math.abs(full.left - 14) < 0.01, 'in full screen the clef moves into the window buttons’ space, at 14 points')
  check(!!clef && !!full && onPixels(clef) && onPixels(full), 'the clef’s edges are on whole screen pixels')

  return {
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    tabs: projectController.tabs.map((tab) => ({ name: tab.project.name, dirty: tab.isDirty, shown: tab === projectController.active })),
    clef: clef ? { left: clef.left, top: clef.top, width: clef.width, height: clef.height, fullScreenLeft: full?.left ?? null, devicePixelRatio: dpr } : null,
    recovered: counts
  }
}
