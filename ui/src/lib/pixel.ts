// Pixel art drawn at runtime, so the panel ships no image files.

/** Paints a pixel map ('.' = transparent) into a data URL. */
function pixelArt(rows: string[], palette: Record<string, string>): string {
  const canvas = document.createElement('canvas')
  canvas.width = rows[0]!.length
  canvas.height = rows.length
  const ctx = canvas.getContext('2d')!
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const color = palette[ch]
      if (!color) return
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }),
  )
  return canvas.toDataURL()
}

const HEART = ['.kk.kk.', 'kwrkrrk', 'krrrrrk', 'krrrrrk', '.krrrk.', '..krk..', '...k...']
const HALF_HEART = ['.kk.kk.', 'kwrkeek', 'krreeek', 'krreeek', '.kreek.', '..kek..', '...k...']
const FOOD = ['....kk.', '...kmmk', '..kmmmk', '.kmmmk.', 'kbkkk..', 'kbk....', '.k.....']
const HALF_FOOD = ['....kk.', '...keek', '..keeek', '.kmeek.', 'kbkkk..', 'kbk....', '.k.....']

export interface IconSet {
  full: string
  half: string
  empty: string
}

export const HEARTS: IconSet = {
  full: pixelArt(HEART, { k: '#1a0000', r: '#e3161b', w: '#ffb0b0' }),
  half: pixelArt(HALF_HEART, { k: '#1a0000', r: '#e3161b', w: '#ffb0b0', e: '#3c1a1a' }),
  empty: pixelArt(HEART, { k: '#1a0000', r: '#3c1a1a', w: '#3c1a1a' }),
}

export const DRUMSTICKS: IconSet = {
  full: pixelArt(FOOD, { k: '#2a1405', m: '#b8622b', b: '#e9e3d4' }),
  half: pixelArt(HALF_FOOD, { k: '#2a1405', m: '#b8622b', b: '#e9e3d4', e: '#3d2a1c' }),
  empty: pixelArt(FOOD, { k: '#2a1405', m: '#3d2a1c', b: '#3d2a1c' }),
}

/** A dark dirt texture as the page background. */
export function paintDirt(): void {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 16
  const ctx = canvas.getContext('2d')!
  const browns = ['#3b2a1d', '#4a3423', '#33241a', '#563d29', '#2c2017', '#45301f']
  let seed = 7
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      ctx.fillStyle = browns[Math.floor(rand() * browns.length)]!
      ctx.fillRect(x, y, 1, 1)
    }
  }
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = rand() > 0.5 ? '#6b6058' : '#5a4f47'
    ctx.fillRect(Math.floor(rand() * 16), Math.floor(rand() * 16), 1, 1)
  }
  document.body.style.backgroundImage = `url(${canvas.toDataURL()})`
}
