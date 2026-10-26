import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Item icons come from the textures in the `minecraft-assets` package, newest version it has.

const DATA = join(dirname(createRequire(import.meta.url).resolve('minecraft-assets/package.json')), 'minecraft-assets', 'data')

function newestVersion(): string {
  const parts = (v: string): number[] => v.split('.').map(Number)
  const versions = readdirSync(DATA).filter((v) => /^\d+(\.\d+)*$/.test(v) && existsSync(join(DATA, v, 'items_textures.json')))
  return versions.sort((a, b) => {
    const [pa, pb] = [parts(a), parts(b)]
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }).at(-1)!
}

let root: string | undefined
let textures: Map<string, string> | undefined
const cache = new Map<string, Buffer | null>()

/** `minecraft:block/oak_planks` → `blocks/oak_planks.png`, `minecraft:items/stick` → `items/stick.png`. */
function texturePath(texture: string): string | null {
  const match = /^(?:minecraft:)?(block|blocks|item|items)\/([a-z0-9_]+)$/.exec(texture)
  if (!match) return null
  return `${match[1]!.startsWith('block') ? 'blocks' : 'items'}/${match[2]}.png`
}

function load(name: string): Buffer | null {
  root ??= join(DATA, newestVersion())
  textures ??= new Map(
    (JSON.parse(readFileSync(join(root, 'items_textures.json'), 'utf8')) as { name: string; texture: string }[])
      .map((t) => [t.name, t.texture]),
  )
  const mapped = textures.get(name)
  const candidates = [
    `items/${name}.png`,
    `blocks/${name}.png`,
    `blocks/${name}_front.png`,
    `blocks/${name}_side.png`,
    mapped ? texturePath(mapped) : null,
  ]
  for (const file of candidates) {
    const path = file && join(root, file)
    if (path && existsSync(path)) return readFileSync(path)
  }
  return null
}

/** The PNG for an item id like `iron_pickaxe`, or null when there is none. */
export function itemIcon(name: string): Buffer | null {
  if (!/^[a-z0-9_]+$/.test(name)) return null
  if (!cache.has(name)) cache.set(name, load(name))
  return cache.get(name)!
}
