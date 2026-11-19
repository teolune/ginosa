import { placeSections, sectionSteps } from '@engine/timeline/rack'
import { channelEffects } from '@engine/timeline/rack-links'
import { setCubeAmount } from '@engine/timeline/rack-edits'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { rackUi } from './rack-ui'

/**
 * Decisions 129 and 130 through the interface (`npm run snapshot -- --scenario rackchannel`,
 * after the rackui scene): the section shows all its bars, 16 cubes each, with bar numbers;
 * double-clicking Kick opens its window, which lists Kick Flash's Exposure, links a value
 * already there, unlinks it, adds Mosaic on a new adjustment layer, and renames the channel;
 * right-clicking a cube gives the cubes after it its amounts.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function button(root: ParentNode | null | undefined, text: string): HTMLButtonElement | undefined {
  return [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim().startsWith(text))
}

export async function channelWindowTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) reasons.push(what)
  }
  const sequence = () => projectController.project!.sequence
  if (rackUi.linking) rackUi.toggleLinking()
  rackUi.openCubeWindow(false)
  rackUi.setFollow(false)
  rackUi.showSection(sequence().rack.sections[0]!.id)
  await pause(300)
  const kick = sequence().rack.rows[0]!
  const grid = sequence().beatGrid!
  const placedA = placeSections(sequence().rack, grid)[0]!
  const kickRow = () => document.querySelectorAll('.rack-row')[0]

  // Decision 130: the whole section, 16 cubes a bar, bar numbers above, nothing repeated.
  const cubes = kickRow()?.querySelectorAll('.rack-cube').length ?? 0
  const barNumbers = [...document.querySelectorAll('.rack-bar-number')].map((b) => b.textContent)
  check(cubes === sectionSteps(placedA.section, grid), `section A shows ${cubes} cubes, not its ${sectionSteps(placedA.section, grid)} 16ths`)
  check(barNumbers.length === placedA.section.bars && barNumbers[0] === '1', `bar numbers ${barNumbers.join(' ')}`)
  const kickSteps = (placedA.section.cubes[kick.id] ?? []).map((c) => c.step)
  check(kickSteps.some((s) => s >= 32), `section A's kicks stop at the first two bars: ${kickSteps.join(' ')}`)
  check(document.querySelector('.rack-where')?.textContent?.includes('loop') === false, 'the section still says it loops')

  // Decision 129: double-click Kick's name.
  const name = kickRow()?.querySelector<HTMLElement>('.rack-name')
  name?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await pause(250)
  const win = () => document.querySelector<HTMLElement>('.channel-window')
  check(win() !== null, 'double-clicking Kick opened no window')
  const listed = () => [...(win()?.querySelectorAll('.channel-effect') ?? [])].map((e) => [e.querySelector('.channel-effect-name')?.textContent, [...e.querySelectorAll('.channel-value > span:first-child')].map((v) => v.textContent)])
  const first = listed()
  check(JSON.stringify(first).includes('Basic Correction') && JSON.stringify(first).includes('Exposure'), `the window lists ${JSON.stringify(first)}, not Kick Flash's Exposure`)

  // Link a value already there: Basic Correction's Highlights on the test card.
  button(win(), '+ Link a value')?.click()
  await pause(200)
  const search = win()?.querySelector<HTMLInputElement>('input[aria-label="Search"]')
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(search, 'Basic')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await pause(200)
  button(win()?.querySelector('.channel-pick'), 'Basic Correction')?.click()
  await pause(150)
  button(win()?.querySelector('.channel-pick-values'), 'Highlights')?.click()
  await pause(250)
  const afterLink = channelEffects(sequence(), kick.id).flatMap((g) => g.values.map((v) => v.label))
  check(afterLink.includes('Highlights'), `linking from the window: ${afterLink.join(', ')}`)
  // Unlink it with its ×.
  win()?.querySelector<HTMLButtonElement>('button[aria-label="Unlink Highlights"]')?.click()
  await pause(250)
  check(!channelEffects(sequence(), kick.id).some((g) => g.values.some((v) => v.label === 'Highlights')), 'Highlights’s × left it linked')

  // A new effect with nothing selected: Mosaic on a new adjustment layer over the song, Cell Size linked.
  timelineController.select([], 'replace')
  const before = sequence().clips.length
  button(win(), '+ New effect')?.click()
  await pause(200)
  button(win(), 'Mosaic')?.click()
  await pause(200)
  const chosen = win()?.querySelector<HTMLInputElement>('.channel-param input:checked')?.parentElement?.textContent?.trim()
  check(chosen === 'Cell Size', `Mosaic's value chosen by default: ${chosen}`)
  button(win(), 'Add Mosaic')?.click()
  await pause(300)
  const layer = sequence().clips.find((c) => c.name === `${kick.name}: Mosaic`)
  check(sequence().clips.length === before + 1 && !!layer?.adjustment && layer.start === 0, 'Mosaic didn’t arrive on a new adjustment layer from the start')
  check(channelEffects(sequence(), kick.id).some((g) => g.name === 'Mosaic' && g.values[0]?.ref.param === 'cellSize'), 'Mosaic’s Cell Size isn’t linked to Kick')

  // Rename in the window.
  const field = win()?.querySelector<HTMLInputElement>('.channel-window-name')
  if (field) {
    // The snapshot window isn't focused, so its blur is sent by hand (React's onBlur listens to focusout).
    field.value = 'Kick 2'
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  }
  await pause(200)
  check(sequence().rack.rows[0]!.name === 'Kick 2', `renamed to ${sequence().rack.rows[0]!.name}`)

  // Right-click a cube › Same Amounts to the End of the Section: the later kicks of section A take its amounts.
  const link = channelEffects(sequence(), kick.id).flatMap((g) => g.values).find((v) => v.ref.param === 'exposure')!.link
  const steps = (placeSections(sequence().rack, grid)[0]!.section.cubes[kick.id] ?? []).map((c) => c.step)
  const at = steps[2]!
  projectController.dispatch(setCubeAmount([{ sectionId: placedA.section.id, rowId: kick.id, step: at }], link.id, -40))
  rackUi.openChannelWindow(null)
  await pause(200)
  kickRow()?.querySelectorAll<HTMLElement>('.rack-cube')[at]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
  await pause(200)
  button(document.querySelector('.context-menu'), 'Same Amounts to the End of the Section')?.click()
  await pause(250)
  const amounts = (placeSections(sequence().rack, grid)[0]!.section.cubes[kick.id] ?? []).map((c) => c.amounts[link.id] ?? 100)
  check(amounts.slice(0, 2).every((a) => a !== -40) && amounts.slice(2).every((a) => a === -40), `amounts after the menu: ${amounts.join(' ')}`)

  // For the screenshot: Kick's window open.
  rackUi.openChannelWindow(kick.id)
  await pause(300)
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons, cubes, barNumbers, kickSteps, listed: listed(), amounts }
}
