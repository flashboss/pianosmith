import { HAND_OPEN, rgba } from './theory'

export interface Finger {
  x: number
  y: number
  pressed: number
  midi: number
}

export interface HandState {
  side: 'left' | 'right'
  home: number
  palmX: number
  /** 0 = white-key height, 1 = raised for black keys. */
  lift: number
  ready: boolean
  fingers: Finger[]
}

const SKIN_DARK: [number, number, number] = [168, 108, 78]
const SKIN_MID: [number, number, number] = [214, 158, 122]
const SKIN_LIGHT: [number, number, number] = [236, 196, 164]
const SKIN_NAIL: [number, number, number] = [244, 220, 204]
const GLOW: [number, number, number] = [255, 122, 50]

/** Dome / arch strength — tamburello curl; middle highest, thumb flatter. */
const FINGER_ARCH = [0.5, 1.35, 1.55, 1.28, 0.85] as const
/** Knuckle row offset in palm units (negative = knuckles closer to tips = taller arch). */
const FINGER_KNUCKLE_LIFT = [0.18, -0.28, -0.42, -0.26, 0] as const
/**
 * Hard max knuckle→tip length in palm `unit`s (thumb … pinky).
 * Rough adult proportions — fingers never rubber-band past this; the palm moves instead.
 */
const FINGER_MAX_LEN = [3.55, 4.55, 5.05, 4.8, 3.85] as const
/** Comfortable resting knuckle→tip length (middle reference) before any reach. */
const FINGER_REST_LEN = 4.35
/**
 * Extra vertical hand scale after the keyboard band was shortened (tips sit lower;
 * palms may hang below the canvas so fingers keep full length).
 */
const HAND_LEN_SCALE = 1.35

function fillCapsule(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  r0: number,
  x1: number,
  y1: number,
  r1: number,
) {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const px = -dy / len
  const py = dx / len
  const radius0 = Math.max(2, r0)
  const radius1 = Math.max(2, r1)
  ctx.beginPath()
  ctx.moveTo(x0 + px * radius0, y0 + py * radius0)
  ctx.lineTo(x1 + px * radius1, y1 + py * radius1)
  ctx.lineTo(x1 - px * radius1, y1 - py * radius1)
  ctx.lineTo(x0 - px * radius0, y0 - py * radius0)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x0, y0, radius0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x1, y1, radius1, 0, Math.PI * 2)
  ctx.fill()
}

/** MCP → PIP → DIP → tip along a tamburello (arched) finger. */
function fingerChain(
  baseX: number,
  baseY: number,
  tipX: number,
  tipY: number,
  side: number,
  fingerIndex: number,
  pressed: number,
  thickness: number,
): Array<{ x: number; y: number; r: number }> {
  const isThumb = fingerIndex === 0
  const isOuter = fingerIndex === 0 || fingerIndex === 4
  const arch = FINGER_ARCH[fingerIndex]
  const dx = tipX - baseX
  const dy = tipY - baseY
  const len = Math.hypot(dx, dy) || 1
  // Anatomical segment stations (proximal longer, distal shorter).
  const tPip = isThumb ? 0.4 : 0.46
  const tDip = isThumb ? 0.7 : 0.76
  // Press flattens the tip contact a bit but keeps a soft PIP dome.
  const pressFlat = 1 - pressed * 0.22
  const curl =
    Math.min(isThumb ? 18 : 58, len * (0.09 + 0.17 * arch)) * arch * pressFlat
  const peak = thickness * (1.05 + arch * 2.55) * pressFlat
  // Mild inward bias on index/ring; thumb/pinky stay on the base→tip line.
  const lateral = isOuter ? 0 : side * thickness * (0.04 + arch * 0.025)
  const unit = thickness * (0.92 + arch * 0.05)
  // PIP is the tamburello apex (dome toward the palm / down the screen).
  return [
    { x: baseX, y: baseY, r: unit * (isThumb ? 1.08 : 0.98) },
    {
      x: baseX + dx * tPip + lateral * 0.22,
      y: baseY + dy * tPip + curl * 1.2 + peak * 0.7,
      r: unit * (isThumb ? 0.96 : 0.86 + arch * 0.05),
    },
    {
      x: baseX + dx * tDip + lateral * 0.1,
      y: baseY + dy * tDip + curl * 0.48 + peak * 0.22,
      r: unit * (isThumb ? 0.8 : 0.7),
    },
    { x: tipX, y: tipY, r: unit * (isThumb ? 0.72 : 0.56) },
  ]
}

/** Diagonal palm pull toward a stretched thumb (x + y), in pixels. */
function thumbPalmPull(hand: HandState, whiteW: number): { x: number; y: number; lean: number } {
  const tips = hand.fingers
  const othersCenter = (tips[1].x + tips[2].x + tips[3].x + tips[4].x) / 4
  const sep = tips[0].x - othersCenter
  const comfort = whiteW * 2.15
  const excess = Math.max(0, Math.abs(sep) - comfort)
  const dir = Math.sign(sep || (hand.side === 'right' ? -1 : 1))
  return {
    x: dir * excess * 0.38,
    // Pull the palm up toward the thumb tip as the gap grows (diagonal).
    y: -excess * 0.42,
    lean: dir * Math.min(0.22, (excess / Math.max(whiteW, 1)) * 0.045),
  }
}

function drawFingerChain(
  ctx: CanvasRenderingContext2D,
  chain: Array<{ x: number; y: number; r: number }>,
  pressed: number,
  side: number,
  isThumb: boolean,
) {
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]
    const b = chain[i + 1]
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    fillCapsule(ctx, a.x + 1.2, a.y + 2.2, a.r * 1.02, b.x + 1.2, b.y + 2.2, b.r * 1.02)

    const skin = ctx.createLinearGradient(a.x - a.r, a.y, b.x + b.r, b.y)
    skin.addColorStop(0, rgba(SKIN_DARK, 1))
    skin.addColorStop(0.35, rgba(SKIN_MID, 1))
    skin.addColorStop(0.75, rgba(SKIN_LIGHT, 1))
    skin.addColorStop(1, rgba(SKIN_MID, 1))
    ctx.fillStyle = skin
    fillCapsule(ctx, a.x, a.y, a.r, b.x, b.y, b.r)

    // Soft side light along the shaft — keep it narrow so joints stay readable.
    ctx.fillStyle = rgba(SKIN_LIGHT, 0.22)
    fillCapsule(
      ctx,
      a.x - side * a.r * 0.22,
      a.y - a.r * 0.08,
      a.r * 0.28,
      b.x - side * b.r * 0.22,
      b.y - b.r * 0.08,
      b.r * 0.24,
    )
  }

  // Soft knuckle hint at PIP only — light crease, no heavy bulbs.
  {
    const pip = chain[1]
    const dip = chain[2] ?? pip
    const mcp = chain[0]
    const ang = Math.atan2(dip.y - mcp.y, dip.x - mcp.x)
    ctx.strokeStyle = rgba(SKIN_DARK, 0.18)
    ctx.lineWidth = Math.max(0.8, pip.r * 0.1)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.ellipse(
      pip.x,
      pip.y + pip.r * 0.2,
      pip.r * 0.38,
      pip.r * 0.12,
      ang + Math.PI / 2,
      Math.PI * 0.2,
      Math.PI * 0.8,
    )
    ctx.stroke()
  }

  const tip = chain[chain.length - 1]
  const joint = chain[chain.length - 2] ?? tip
  const jdx = tip.x - joint.x
  const jdy = tip.y - joint.y
  const jlen = Math.hypot(jdx, jdy) || 1
  const ux = jdx / jlen
  const uy = jdy / jlen
  // Nail on the dorsal side of the curled tip, not flat on the key.
  const nailX = tip.x - ux * tip.r * 0.5 + side * tip.r * 0.04
  const nailY = tip.y - uy * tip.r * 0.5 - tip.r * 0.08
  const nailAngle = Math.atan2(uy, ux) + Math.PI / 2

  const glow = Math.max(0.12, pressed * 0.55)
  const tipGlow = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, tip.r * 2.2)
  tipGlow.addColorStop(0, rgba(GLOW, glow))
  tipGlow.addColorStop(1, rgba(GLOW, 0))
  ctx.fillStyle = tipGlow
  ctx.beginPath()
  ctx.ellipse(tip.x, tip.y + tip.r * 0.15, tip.r * 1.8, tip.r * 1.1, 0, 0, Math.PI * 2)
  ctx.fill()

  // Soft fingertip pad (flesh), then nail above it.
  const pad = ctx.createRadialGradient(tip.x, tip.y, tip.r * 0.1, tip.x, tip.y, tip.r)
  pad.addColorStop(0, rgba(SKIN_LIGHT, 1))
  pad.addColorStop(0.65, rgba(SKIN_MID, 1))
  pad.addColorStop(1, rgba(SKIN_DARK, 0.9))
  ctx.fillStyle = pad
  ctx.beginPath()
  ctx.ellipse(tip.x, tip.y, tip.r * 0.95, tip.r * 0.82, nailAngle, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = rgba(SKIN_NAIL, 0.92)
  ctx.beginPath()
  ctx.ellipse(
    nailX,
    nailY,
    tip.r * (isThumb ? 0.4 : 0.34),
    tip.r * (isThumb ? 0.52 : 0.46),
    nailAngle + side * 0.08,
    0,
    Math.PI * 2,
  )
  ctx.fill()
  ctx.fillStyle = rgba(GLOW, 0.18 + pressed * 0.25)
  ctx.beginPath()
  ctx.ellipse(tip.x, tip.y + tip.r * 0.22, tip.r * 0.65, tip.r * 0.26, 0, 0, Math.PI * 2)
  ctx.fill()
}

export type DrawHandView = {
  whiteW: number
  w: number
  h: number
  keyboardTop: number
}

/** Draw one piano hand (dorsum + tamburello fingers) into the keyboard band. */
export function drawHand(ctx: CanvasRenderingContext2D, hand: HandState, view: DrawHandView) {
  if (!Number.isFinite(hand.palmX)) return
  const { whiteW, w, h, keyboardTop } = view
  // Open 9 notes with slender fingers — palm narrower than the tips.
  const openPx = whiteW * HAND_OPEN
  const unit = Math.max(10, Math.min(openPx / 11.5, whiteW * 0.92))
  const side = hand.side === 'right' ? 1 : -1
  const tips = hand.fingers.map((finger) => ({
    x: finger.x,
    y: finger.y,
    pressed: finger.pressed,
  }))
  const tipMin = Math.min(...tips.map((tip) => tip.x))
  const tipMax = Math.max(...tips.map((tip) => tip.x))
  const tipSpan = Math.min(openPx, Math.max(openPx * 0.55, tipMax - tipMin))
  const tipCenter = (tipMin + tipMax) / 2
  const tipY = tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length
  const thumbPull = thumbPalmPull(hand, whiteW)
  // Resting finger length — scaled so the shorter keyboard doesn't squash the hands.
  const restLen = unit * FINGER_REST_LEN * HAND_LEN_SCALE
  let palmY = tipY + restLen + thumbPull.y
  palmY = Math.min(palmY, h + unit * 3.2)
  let palmX = tipCenter * 0.55 + hand.palmX * 0.45 + side * unit * 0.04 + thumbPull.x
  const palmLean = side * 0.07 + thumbPull.lean
  const knuckleScale = 0.8

  const knuckleBases = (px: number, py: number) =>
    tips.map((tip, index) => {
      let x = px + (tip.x - tipCenter) * knuckleScale
      let y = py + FINGER_KNUCKLE_LIFT[index] * unit * 1.4
      if (index === 0) {
        x = tip.x * 0.35 + px * 0.65 - side * unit * 0.35
        y = py + unit * 0.55 + thumbPull.y * 0.15
      } else if (index === 1) {
        x = px + (tip.x - tipCenter) * (knuckleScale * 0.92)
      } else if (index === 4) {
        x = px + (tip.x - tipCenter) * knuckleScale
        y = py + unit * 0.18
      }
      return { x, y }
    })

  // If a tip is out of reach, slide the whole palm diagonally toward it (no finger stretch).
  for (let iter = 0; iter < 5; iter++) {
    const bases = knuckleBases(palmX, palmY)
    let shiftX = 0
    let shiftY = 0
    let count = 0
    for (let index = 0; index < 5; index++) {
      const maxLen = unit * FINGER_MAX_LEN[index] * HAND_LEN_SCALE
      const base = bases[index]
      const tip = tips[index]
      const dx = tip.x - base.x
      const dy = tip.y - base.y
      const dist = Math.hypot(dx, dy)
      if (dist <= maxLen + 0.01) continue
      const excess = dist - maxLen
      shiftX += (dx / dist) * excess
      shiftY += (dy / dist) * excess
      count += 1
    }
    if (!count) break
    palmX += shiftX / count
    palmY += shiftY / count
  }

  const bases = knuckleBases(palmX, palmY)
  // Hard clamp: draw tips only within max finger length (palm already moved to reach).
  for (let index = 0; index < 5; index++) {
    const maxLen = unit * FINGER_MAX_LEN[index] * HAND_LEN_SCALE
    const base = bases[index]
    const tip = tips[index]
    const dx = tip.x - base.x
    const dy = tip.y - base.y
    const dist = Math.hypot(dx, dy) || 1
    if (dist <= maxLen) continue
    tip.x = base.x + (dx / dist) * maxLen
    tip.y = base.y + (dy / dist) * maxLen
  }

  const knuckleSpan = Math.max(...bases.map((point) => point.x)) - Math.min(...bases.map((point) => point.x))
  const palmW = Math.max(tipSpan * 0.5, knuckleSpan * 0.72 + unit * 1.2)
  const chains = tips.map((tip, index) =>
    fingerChain(bases[index].x, bases[index].y, tip.x, tip.y, side, index, tip.pressed, unit),
  )

  ctx.save()
  ctx.beginPath()
  ctx.rect(-40, keyboardTop - 8, w + 80, h + 40)
  ctx.clip()

  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  for (const chain of chains) {
    const tip = chain[chain.length - 1]
    ctx.beginPath()
    ctx.ellipse(tip.x, tip.y + tip.r * 0.55, tip.r * 1.2, tip.r * 0.45, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // Soft contact shadow under the dorsum (flat, not a ball).
  ctx.beginPath()
  ctx.ellipse(palmX, palmY + unit * 0.55, palmW * 0.38, unit * 0.28, palmLean * 0.4, 0, Math.PI * 2)
  ctx.fill()

  // Back-of-hand plate: wide & flat from knuckles toward the wrist.
  const knuckleY = Math.min(...bases.map((point) => point.y))
  const dorsumTop = knuckleY + unit * 0.15
  const dorsumBottom = palmY + unit * 1.15
  const dorsumLeft = Math.min(...bases.map((point) => point.x)) - unit * 0.35
  const dorsumRight = Math.max(...bases.map((point) => point.x)) + unit * 0.35
  const midL = palmX - palmW * 0.28 + thumbPull.x * 0.15
  const midR = palmX + palmW * 0.28 + thumbPull.x * 0.15
  const dorsumGrad = ctx.createLinearGradient(dorsumLeft, dorsumTop, dorsumRight, dorsumBottom)
  dorsumGrad.addColorStop(0, rgba(SKIN_DARK, 1))
  dorsumGrad.addColorStop(0.35, rgba(SKIN_MID, 1))
  dorsumGrad.addColorStop(0.7, rgba(SKIN_LIGHT, 1))
  dorsumGrad.addColorStop(1, rgba(SKIN_MID, 1))
  ctx.fillStyle = dorsumGrad
  ctx.beginPath()
  ctx.moveTo(dorsumLeft, dorsumTop + unit * 0.35)
  ctx.quadraticCurveTo(dorsumLeft + unit * 0.1, dorsumTop, tipCenter - unit * 0.2, dorsumTop)
  ctx.lineTo(tipCenter + unit * 0.2, dorsumTop)
  ctx.quadraticCurveTo(dorsumRight - unit * 0.1, dorsumTop, dorsumRight, dorsumTop + unit * 0.35)
  ctx.quadraticCurveTo(midR + unit * 0.05, (dorsumTop + dorsumBottom) * 0.55, midR, dorsumBottom)
  ctx.lineTo(midL, dorsumBottom)
  ctx.quadraticCurveTo(midL - unit * 0.05, (dorsumTop + dorsumBottom) * 0.55, dorsumLeft, dorsumTop + unit * 0.35)
  ctx.closePath()
  ctx.fill()

  const wristTop = dorsumBottom - unit * 0.05
  const wristGrad = ctx.createLinearGradient(palmX, wristTop, palmX, h)
  wristGrad.addColorStop(0, rgba(SKIN_MID, 1))
  wristGrad.addColorStop(0.45, rgba(SKIN_DARK, 0.92))
  wristGrad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = wristGrad
  ctx.beginPath()
  ctx.moveTo(midL, wristTop)
  ctx.lineTo(midR, wristTop)
  ctx.lineTo(palmX + palmW * 0.14 + thumbPull.x * 0.25, h + 4)
  ctx.lineTo(palmX - palmW * 0.14 + thumbPull.x * 0.25, h + 4)
  ctx.closePath()
  ctx.fill()

  for (const index of [4, 3, 2, 1, 0]) {
    drawFingerChain(ctx, chains[index], tips[index].pressed, side, index === 0)
  }
  ctx.restore()
}
